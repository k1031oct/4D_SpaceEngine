import { SpacePacketGrid } from './SpacePacketGrid';
import type {
  AmbientMediumSpec,
  CoreStepMetrics,
  MaterialSpec,
  SpaceCoreConfig,
  SpaceEntity,
  Vec3,
} from './types';

/**
 * 空間場ソルバ（Space Field Solver）
 * 空間パケット間のポアソン圧力緩和・運動量フロー・渦度拡散・散逸（熱変換）を計算し、
 * CFL・拡散安定条件に基づくサブステップ実行と、ε-Cutoffによる計算省略を行う。
 */
export class FieldSolver {
  /**
   * 空間場およびエンティティへの遠隔力を1フレーム分更新する
   */
  public solve(
    grid: SpacePacketGrid,
    entities: SpaceEntity[],
    materials: ReadonlyMap<string, MaterialSpec>,
    backgroundField: Vec3,
    rawDt: number,
    config: SpaceCoreConfig,
    medium?: AmbientMediumSpec,
  ): CoreStepMetrics {
    // 1. スケール不変な無次元化係数（基準 L_ref = 0.25m に対する比率）
    const scaleRatio = Math.max(grid.cellSize / 0.25, 1e-6);
    const scaledWaveSpeed = config.waveSpeed * scaleRatio;
    const scaledDiffusion = config.diffusionRate * scaleRatio * scaleRatio;

    // 波動CFL条件と3D拡散安定条件 (D * dt / dx^2 <= 1/8 < 1/6) の両方から安全なサブステップ数を算出
    const maxWaveDt = config.cflFactor * (grid.cellSize / Math.max(scaledWaveSpeed, 1e-4));
    const maxDiffDt =
      (grid.cellSize * grid.cellSize) / (8.0 * Math.max(scaledDiffusion, 1e-4));
    const maxSafeDt = Math.min(maxWaveDt, maxDiffDt);
    const clampedRawDt = Math.min(Math.max(rawDt, 1e-5), 0.05);
    const substeps = Math.max(1, Math.min(32, Math.ceil(clampedRawDt / maxSafeDt)));
    const dtSub = clampedRawDt / substeps;

    // 2. Visible エンティティからのソース注入（電荷・磁気スピン）
    this.injectSources(grid, entities);

    // 3. サブステップでの空間場更新（緩和・フロー・渦度・散逸）
    const permittivity = Math.max(0.1, medium?.permittivity ?? 1.0);
    let activeCount = 0;
    let sleepingCount = 0;
    for (let s = 0; s < substeps; s++) {
      const stats = this.stepGrid(grid, dtSub, config, scaledDiffusion, permittivity);
      if (s === substeps - 1) {
        activeCount = stats.activeCount;
        sleepingCount = stats.sleepingCount;
      }
    }

    // 4. 空間場 → エンティティへの遠隔力積分（媒質の浮力・流体抗力含む）
    this.applyFieldForcesToEntities(
      grid,
      entities,
      materials,
      backgroundField,
      clampedRawDt,
      config,
      medium,
    );

    // 5. 空間媒質の絶縁破壊による空中プラズマ放電
    const activeDischargeCount = medium
      ? this.processAtmosphericBreakdown(grid, entities, medium, clampedRawDt)
      : 0;

    // 6. 総エネルギーの集計（監視用）
    const totalEnergy = this.computeTotalEnergy(grid, entities);
    const sleepingRatio = grid.count > 0 ? sleepingCount / grid.count : 0;

    return {
      activePacketCount: activeCount,
      sleepingPacketRatio: sleepingRatio,
      totalEnergy,
      dtEffective: dtSub,
      activeDischargeCount,
    };
  }

  /**
   * エンティティの電荷・磁気モーメントを空間パケットのソース項へトリリニア分配する
   */
  private injectSources(grid: SpacePacketGrid, entities: readonly SpaceEntity[]): void {
    grid.clearSources();
    const invVol = 1.0 / grid.cellVolume;

    for (const ent of entities) {
      if (ent.domainClass !== 'Visible') continue;
      const hasCharge = Math.abs(ent.netCharge) > 1e-7;
      const hasMag =
        Math.abs(ent.magneticMoment[0]) +
          Math.abs(ent.magneticMoment[1]) +
          Math.abs(ent.magneticMoment[2]) >
        1e-7;

      if (!hasCharge && !hasMag) continue;

      const [gx, gy, gz] = grid.worldToGrid(ent.position);
      const x0 = Math.max(1, Math.min(grid.nx - 3, Math.floor(gx)));
      const y0 = Math.max(1, Math.min(grid.ny - 3, Math.floor(gy)));
      const z0 = Math.max(1, Math.min(grid.nz - 3, Math.floor(gz)));
      const tx = Math.max(0, Math.min(1, gx - x0));
      const ty = Math.max(0, Math.min(1, gy - y0));
      const tz = Math.max(0, Math.min(1, gz - z0));

      for (let dz = 0; dz <= 1; dz++) {
        const wz = dz === 0 ? 1 - tz : tz;
        for (let dy = 0; dy <= 1; dy++) {
          const wy = dy === 0 ? 1 - ty : ty;
          for (let dx = 0; dx <= 1; dx++) {
            const wx = dx === 0 ? 1 - tx : tx;
            const w = wx * wy * wz;
            const idx = grid.index(x0 + dx, y0 + dy, z0 + dz);

            if (hasCharge) {
              grid.sourcePhi[idx] += ent.netCharge * w * invVol;
            }
            if (hasMag) {
              grid.sourceWx[idx] += ent.magneticMoment[0] * w * invVol;
              grid.sourceWy[idx] += ent.magneticMoment[1] * w * invVol;
              grid.sourceWz[idx] += ent.magneticMoment[2] * w * invVol;
            }
            // ソースがあるセルはスリープ解除
            grid.isSleeping[idx] = 0;
          }
        }
      }
    }
  }

  /**
   * 空間パケット網を 1 サブステップ進める
   */
  private stepGrid(
    grid: SpacePacketGrid,
    dt: number,
    config: SpaceCoreConfig,
    scaledDiffusion: number,
    permittivity: number,
  ): { activeCount: number; sleepingCount: number } {
    const { nx, ny, nz } = grid;
    const invDx = 1.0 / grid.cellSize;
    const invDx2 = invDx * invDx;
    const diffFactor = scaledDiffusion * dt * invDx2;
    const phiDecay = Math.max(0, 1.0 - config.phiDamping * dt);
    const momDecay = Math.max(0, 1.0 - config.momentumDamping * dt);
    const vortDecay = Math.max(0, 1.0 - config.vorticityDamping * dt);
    const eps = config.epsilonCutoff;

    let activeCount = 0;
    let sleepingCount = 0;

    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const idx = grid.index(x, y, z);

          // 境界シェルは外周の固定基準 (Φ=0 開放端) として扱う
          if (grid.isBoundary[idx] === 1) {
            grid.phiNext[idx] = 0;
            grid.pxNext[idx] = 0;
            grid.pyNext[idx] = 0;
            grid.pzNext[idx] = 0;
            grid.wxNext[idx] = 0;
            grid.wyNext[idx] = 0;
            grid.wzNext[idx] = 0;
            sleepingCount++;
            continue;
          }

          const idxXm = grid.index(x - 1, y, z);
          const idxXp = grid.index(x + 1, y, z);
          const idxYm = grid.index(x, y - 1, z);
          const idxYp = grid.index(x, y + 1, z);
          const idxZm = grid.index(x, y, z - 1);
          const idxZp = grid.index(x, y, z + 1);

          // 近傍がすべてスリープかつ自身もソースなしならスキップ (ε-Cutoff)
          if (
            grid.isSleeping[idx] === 1 &&
            grid.sourcePhi[idx] === 0 &&
            grid.isSleeping[idxXm] === 1 &&
            grid.isSleeping[idxXp] === 1 &&
            grid.isSleeping[idxYm] === 1 &&
            grid.isSleeping[idxYp] === 1 &&
            grid.isSleeping[idxZm] === 1 &&
            grid.isSleeping[idxZp] === 1
          ) {
            grid.phiNext[idx] = grid.phi[idx];
            grid.pxNext[idx] = grid.px[idx];
            grid.pyNext[idx] = grid.py[idx];
            grid.pzNext[idx] = grid.pz[idx];
            grid.wxNext[idx] = grid.wx[idx];
            grid.wyNext[idx] = grid.wy[idx];
            grid.wzNext[idx] = grid.wz[idx];
            sleepingCount++;
            continue;
          }

          activeCount++;

          const phiC = grid.phi[idx];
          const stiff = Math.max(0.1, grid.stiffness[idx] * permittivity);

          // ポアソン緩和（ラプラシアンによる歪みの均質化）
          const lapPhi =
            grid.phi[idxXm] +
            grid.phi[idxXp] +
            grid.phi[idxYm] +
            grid.phi[idxYp] +
            grid.phi[idxZm] +
            grid.phi[idxZp] -
            6.0 * phiC;

          const newPhi =
            (phiC + (diffFactor / stiff) * lapPhi + grid.sourcePhi[idx] * dt) * phiDecay;
          grid.phiNext[idx] = newPhi;

          // 気圧勾配 ∇Φ による運動量フロー駆動
          const gradPhiX = (grid.phi[idxXp] - grid.phi[idxXm]) * (0.5 * invDx);
          const gradPhiY = (grid.phi[idxYp] - grid.phi[idxYm]) * (0.5 * invDx);
          const gradPhiZ = (grid.phi[idxZp] - grid.phi[idxZm]) * (0.5 * invDx);

          const rawPx = grid.px[idx] - gradPhiX * dt;
          const rawPy = grid.py[idx] - gradPhiY * dt;
          const rawPz = grid.pz[idx] - gradPhiZ * dt;

          const newPx = rawPx * momDecay;
          const newPy = rawPy * momDecay;
          const newPz = rawPz * momDecay;

          grid.pxNext[idx] = newPx;
          grid.pyNext[idx] = newPy;
          grid.pzNext[idx] = newPz;

          // 粘性散逸エネルギーを内部振動エネルギー U_vib（熱）へ変換
          const dissipatedMom =
            (rawPx * rawPx + rawPy * rawPy + rawPz * rawPz) * (1.0 - momDecay * momDecay);
          grid.vibrationEnergy[idx] += 0.5 * dissipatedMom;

          // 運動量フローの回転 ∇×P ＋ 渦度拡散 による渦度 ω の更新
          const curlX =
            (grid.pz[idxYp] - grid.pz[idxYm]) * (0.5 * invDx) -
            (grid.py[idxZp] - grid.py[idxZm]) * (0.5 * invDx);
          const curlY =
            (grid.px[idxZp] - grid.px[idxZm]) * (0.5 * invDx) -
            (grid.pz[idxXp] - grid.pz[idxXm]) * (0.5 * invDx);
          const curlZ =
            (grid.py[idxXp] - grid.py[idxXm]) * (0.5 * invDx) -
            (grid.px[idxYp] - grid.px[idxYm]) * (0.5 * invDx);

          const lapWx =
            grid.wx[idxXm] + grid.wx[idxXp] + grid.wx[idxYm] + grid.wx[idxYp] + grid.wx[idxZm] + grid.wx[idxZp] -
            6.0 * grid.wx[idx];
          const lapWy =
            grid.wy[idxXm] + grid.wy[idxXp] + grid.wy[idxYm] + grid.wy[idxYp] + grid.wy[idxZm] + grid.wy[idxZp] -
            6.0 * grid.wy[idx];
          const lapWz =
            grid.wz[idxXm] + grid.wz[idxXp] + grid.wz[idxYm] + grid.wz[idxYp] + grid.wz[idxZm] + grid.wz[idxZp] -
            6.0 * grid.wz[idx];

          grid.wxNext[idx] =
            (grid.wx[idx] + diffFactor * lapWx + (curlX + grid.sourceWx[idx]) * dt) * vortDecay;
          grid.wyNext[idx] =
            (grid.wy[idx] + diffFactor * lapWy + (curlY + grid.sourceWy[idx]) * dt) * vortDecay;
          grid.wzNext[idx] =
            (grid.wz[idx] + diffFactor * lapWz + (curlZ + grid.sourceWz[idx]) * dt) * vortDecay;

          // 静穏判定（ε-Cutoff）
          const sourceMag =
            Math.abs(grid.sourcePhi[idx]) +
            Math.abs(grid.sourceWx[idx]) +
            Math.abs(grid.sourceWy[idx]) +
            Math.abs(grid.sourceWz[idx]);
          const energyMag =
            Math.abs(newPhi) +
            Math.abs(newPx) +
            Math.abs(newPy) +
            Math.abs(newPz) +
            Math.abs(grid.wxNext[idx]) +
            Math.abs(grid.wyNext[idx]) +
            Math.abs(grid.wzNext[idx]);

          grid.isSleeping[idx] = energyMag < eps && sourceMag < eps ? 1 : 0;
        }
      }
    }

    // ダブルバッファのスワップ
    [grid.phi, grid.phiNext] = [grid.phiNext, grid.phi];
    [grid.px, grid.pxNext] = [grid.pxNext, grid.px];
    [grid.py, grid.pyNext] = [grid.pyNext, grid.py];
    [grid.pz, grid.pzNext] = [grid.pzNext, grid.pz];
    [grid.wx, grid.wxNext] = [grid.wxNext, grid.wx];
    [grid.wy, grid.wyNext] = [grid.wyNext, grid.wy];
    [grid.wz, grid.wzNext] = [grid.wzNext, grid.wz];

    return { activeCount, sleepingCount };
  }

  /**
   * 空間場の勾配および境界射影場をサンプリングし、エンティティの速度を更新する
   */
  private applyFieldForcesToEntities(
    grid: SpacePacketGrid,
    entities: SpaceEntity[],
    materials: ReadonlyMap<string, MaterialSpec>,
    backgroundField: Vec3,
    dt: number,
    config: SpaceCoreConfig,
    medium?: AmbientMediumSpec,
  ): void {
    for (const ent of entities) {
      if (ent.domainClass !== 'Visible' || ent.isGrabbed) continue;

      const mat = materials.get(ent.materialId);
      const invMass = 1.0 / Math.max(ent.mass, 1e-4);

      // 境界シェル射影された背景勾配（重力など）による加速度
      let ax = backgroundField[0];
      let ay = backgroundField[1];
      let az = backgroundField[2];

      // 空間媒質によるアルキメデスの浮力と流体抗力
      if (medium && (medium.density > 0 || medium.viscosity > 0)) {
        const objDensity = Math.max(mat?.density ?? 1.0, 1e-3);
        const buoyRatio = medium.density / objDensity;
        ax -= backgroundField[0] * buoyRatio;
        ay -= backgroundField[1] * buoyRatio;
        az -= backgroundField[2] * buoyRatio;

        const speed = Math.sqrt(
          ent.velocity[0] * ent.velocity[0] +
            ent.velocity[1] * ent.velocity[1] +
            ent.velocity[2] * ent.velocity[2],
        );
        if (speed > 1e-5) {
          const area = Math.PI * ent.radius * ent.radius;
          const dragCoeff = (medium.density * 2.5 + medium.viscosity * 8.0) * (area * invMass);
          ax -= ent.velocity[0] * speed * dragCoeff;
          ay -= ent.velocity[1] * speed * dragCoeff;
          az -= ent.velocity[2] * speed * dragCoeff;
        }
      }

      // 1. 空間場の気圧勾配 ∇Φ による静電力 F = -q * k * ∇Φ
      if (Math.abs(ent.netCharge) > 1e-7) {
        const gradPhi = this.sampleSymmetricGradPhi(grid, ent.position);
        const factor = -ent.netCharge * config.chargeCoupling * invMass;
        ax += gradPhi[0] * factor;
        ay += gradPhi[1] * factor;
        az += gradPhi[2] * factor;
      }

      // 2. 誘電分極による静電誘導引力 F_pol = α_pol * k_pol * ∇|∇Φ|²
      const pol = mat?.polarizability ?? 0;
      if (pol > 0.01) {
        const gradPhiCenter = this.sampleSymmetricGradPhi(grid, ent.position);
        ent.dipoleMoment = [
          -pol * gradPhiCenter[0],
          -pol * gradPhiCenter[1],
          -pol * gradPhiCenter[2],
        ];
        const gradE2 = this.sampleSymmetricGradPhiSq(grid, ent.position);
        const polFactor = pol * config.polarizationCoupling * invMass;
        ax += gradE2[0] * polFactor;
        ay += gradE2[1] * polFactor;
        az += gradE2[2] * polFactor;
      }

      // 3. 空間渦度エネルギー勾配によるケルビン磁力 F_mag = χ_mag * k_mag * ∇|ω|²
      const chiMag = mat?.magneticSusceptibility ?? 0;
      if (chiMag > 0.01) {
        const gradW2 = this.sampleSymmetricGradVorticitySq(grid, ent.position);
        const magFactor = chiMag * config.magneticCoupling * invMass;
        ax += gradW2[0] * magFactor;
        ay += gradW2[1] * magFactor;
        az += gradW2[2] * magFactor;
      }

      // 4. 計算窓内の Visible 天体（gravityStrength > 0）による空間密度勾配重力
      for (const other of entities) {
        if (other === ent || other.domainClass !== 'Visible' || !other.gravityStrength) continue;
        const dx = other.position[0] - ent.position[0];
        const dy = other.position[1] - ent.position[1];
        const dz = other.position[2] - ent.position[2];
        const minR = Math.max(other.radius + ent.radius, grid.cellSize * 0.5);
        const r2 = Math.max(dx * dx + dy * dy + dz * dz, minR * minR);
        const r = Math.sqrt(r2);
        const gAcc = other.gravityStrength / r2;
        ax += (dx / r) * gAcc;
        ay += (dy / r) * gAcc;
        az += (dz / r) * gAcc;
      }

      // 数値暴走を防ぐための加速度クランプ
      const maxAccel = 80.0;
      const aMag = Math.sqrt(ax * ax + ay * ay + az * az);
      if (aMag > maxAccel) {
        const s = maxAccel / aMag;
        ax *= s;
        ay *= s;
        az *= s;
      }

      // 静止摩擦ロック中のオブジェクトの起床判定
      if (ent.isSleeping) {
        const netHorizontalAccel = Math.sqrt((ax - backgroundField[0]) ** 2 + (az - backgroundField[2]) ** 2);
        const upwardForceOvercomesGravity = ay > 0.2; // 重力に打ち勝って浮上する力がある
        const muS = mat?.staticFriction ?? 0.5;
        const normalAccel = Math.max(0, -backgroundField[1]);
        const horizontalOvercomesFriction = netHorizontalAccel > muS * normalAccel + 0.5;

        if (
          ent.position[1] - ent.radius > config.floorY + 0.02 ||
          upwardForceOvercomesGravity ||
          horizontalOvercomesFriction
        ) {
          ent.isSleeping = false;
        } else {
          continue;
        }
      }

      ent.velocity[0] += ax * dt;
      ent.velocity[1] += ay * dt;
      ent.velocity[2] += az * dt;
    }
  }

  /**
   * 自己力を抑止するため、エンティティ位置から ±1.5 * cellSize の対称点で ∇|∇Φ|² を評価する
   */
  private sampleSymmetricGradPhiSq(grid: SpacePacketGrid, pos: Vec3): Vec3 {
    const h = grid.cellSize * 1.5;
    const inv2h = 1.0 / (2.0 * h);

    const e2 = (p: Vec3): number => {
      const g = grid.samplePhiGradient(p);
      return g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
    };

    return [
      (e2([pos[0] + h, pos[1], pos[2]]) - e2([pos[0] - h, pos[1], pos[2]])) * inv2h,
      (e2([pos[0], pos[1] + h, pos[2]]) - e2([pos[0], pos[1] - h, pos[2]])) * inv2h,
      (e2([pos[0], pos[1], pos[2] + h]) - e2([pos[0], pos[1], pos[2] - h])) * inv2h,
    ];
  }

  /**
   * 自己力を抑止するため、エンティティ位置から ±1.5 * cellSize の対称点で ∇|ω|² を評価する
   */
  private sampleSymmetricGradVorticitySq(grid: SpacePacketGrid, pos: Vec3): Vec3 {
    const h = grid.cellSize * 1.5;
    const inv2h = 1.0 / (2.0 * h);

    const w2 = (p: Vec3): number => {
      const wx = grid.sampleField(grid.wx, p);
      const wy = grid.sampleField(grid.wy, p);
      const wz = grid.sampleField(grid.wz, p);
      return wx * wx + wy * wy + wz * wz;
    };

    return [
      (w2([pos[0] + h, pos[1], pos[2]]) - w2([pos[0] - h, pos[1], pos[2]])) * inv2h,
      (w2([pos[0], pos[1] + h, pos[2]]) - w2([pos[0], pos[1] - h, pos[2]])) * inv2h,
      (w2([pos[0], pos[1], pos[2] + h]) - w2([pos[0], pos[1], pos[2] - h])) * inv2h,
    ];
  }

  /**
   * 空間媒質の絶縁破壊閾値を超えた高勾配領域で非接触の空中プラズマ放電を発生させる
   */
  private processAtmosphericBreakdown(
    grid: SpacePacketGrid,
    entities: SpaceEntity[],
    medium: AmbientMediumSpec,
    dt: number,
  ): number {
    let dischargeCount = 0;
    const threshold = medium.breakdownThreshold;
    if (threshold >= 1e5) return 0;

    for (let i = 0; i < entities.length; i++) {
      const a = entities[i];
      if (a.domainClass !== 'Visible') continue;

      for (let j = i + 1; j < entities.length; j++) {
        const b = entities[j];
        if (b.domainClass !== 'Visible') continue;

        const dx = b.position[0] - a.position[0];
        const dy = b.position[1] - a.position[1];
        const dz = b.position[2] - a.position[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const gap = dist - (a.radius + b.radius);

        // 近接（非接触ギャップ < 0.75m）かつ電位差がある場合のみ判定
        if (gap <= 0 || gap > 0.75) continue;

        const mid: Vec3 = [
          (a.position[0] + b.position[0]) * 0.5,
          (a.position[1] + b.position[1]) * 0.5,
          (a.position[2] + b.position[2]) * 0.5,
        ];
        const gMid = grid.samplePhiGradient(mid);
        const fieldMag = Math.sqrt(gMid[0] * gMid[0] + gMid[1] * gMid[1] + gMid[2] * gMid[2]);

        // 空間場勾配または相対電荷差による局所電界が絶縁破壊閾値を超えたらプラズマ放電
        const localE = Math.max(fieldMag, Math.abs(a.netCharge - b.netCharge) / Math.max(gap, 0.05));
        if (localE > threshold) {
          dischargeCount++;
          const rate = Math.min(1.0, 8.0 * dt);
          if (a.isGrounded && !b.isGrounded) {
            b.netCharge *= 1.0 - rate;
            b.internalHeat += 0.2 * dt;
          } else if (b.isGrounded && !a.isGrounded) {
            a.netCharge *= 1.0 - rate;
            a.internalHeat += 0.2 * dt;
          } else {
            const avgQ = (a.netCharge + b.netCharge) * 0.5;
            a.netCharge += (avgQ - a.netCharge) * rate;
            b.netCharge += (avgQ - b.netCharge) * rate;
            a.internalHeat += 0.15 * dt;
            b.internalHeat += 0.15 * dt;
          }
        }
      }
    }

    return dischargeCount;
  }

  /**
   * 自己力を抑止するため、エンティティ位置から ±1.5 * cellSize の対称点で ∇Φ を評価する
   */
  private sampleSymmetricGradPhi(grid: SpacePacketGrid, pos: Vec3): Vec3 {
    const h = grid.cellSize * 1.5;
    const inv2h = 1.0 / (2.0 * h);

    const dpx =
      grid.sampleField(grid.phi, [pos[0] + h, pos[1], pos[2]]) -
      grid.sampleField(grid.phi, [pos[0] - h, pos[1], pos[2]]);
    const dpy =
      grid.sampleField(grid.phi, [pos[0], pos[1] + h, pos[2]]) -
      grid.sampleField(grid.phi, [pos[0], pos[1] - h, pos[2]]);
    const dpz =
      grid.sampleField(grid.phi, [pos[0], pos[1], pos[2] + h]) -
      grid.sampleField(grid.phi, [pos[0], pos[1], pos[2] - h]);

    return [dpx * inv2h, dpy * inv2h, dpz * inv2h];
  }

  /**
   * 空間場＋実体オブジェクトの総エネルギーを算出する
   */
  private computeTotalEnergy(grid: SpacePacketGrid, entities: readonly SpaceEntity[]): number {
    let total = 0;
    for (let i = 0; i < grid.count; i++) {
      const p = grid.phi[i];
      const m2 = grid.px[i] * grid.px[i] + grid.py[i] * grid.py[i] + grid.pz[i] * grid.pz[i];
      total += 0.5 * (p * p + m2) * grid.cellVolume + grid.vibrationEnergy[i];
    }
    for (const ent of entities) {
      if (ent.domainClass !== 'Visible') continue;
      const v2 =
        ent.velocity[0] * ent.velocity[0] +
        ent.velocity[1] * ent.velocity[1] +
        ent.velocity[2] * ent.velocity[2];
      total += 0.5 * ent.mass * v2 + ent.internalHeat;
    }
    return total;
  }
}
