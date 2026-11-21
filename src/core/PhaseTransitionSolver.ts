import type { SpacePacketGrid } from './SpacePacketGrid';
import type { AmbientMediumSpec, MaterialSpec, PhaseState, SpaceEntity } from './types';

/**
 * 相転移・燃焼・集合体分散ソルバ（Phase Transition & Combustion Solver）
 * 1. 内部熱エネルギー (internalHeat) と結合エネルギー (bindingEnergy) の比較から
 *    固体 ↔ 液体 ↔ 気体の状態変化を決定する。
 * 2. 気化時は知覚スケール一定のまま集合体を複数の低密度サブ粒子へ分裂・分散（Dispersion）させる。
 * 3. 酸化剤（酸素）を含む媒質中で発火点に達した可燃物は、電子移動（酸化還元）により燃焼し
 *    発熱・空間膨張圧・発光を創発する。
 * @see 4d_scale_space_engine.md §3
 */
export class PhaseTransitionSolver {
  private vaporCounter = 0;

  /**
   * 現在の内部熱エネルギーと結合エネルギーから実効結合度 (0..1) を返す
   * 0 = 結合完全崩壊（液体/気体：弾性復元力ゼロ）、1 = 完全結合（固体）
   */
  public static getEffectiveBondRatio(
    entity: Readonly<SpaceEntity>,
    material: MaterialSpec | undefined,
  ): number {
    const binding = material?.bindingEnergy ?? 20.0;
    if (binding <= 1e-6) return 0;
    return Math.max(0, Math.min(1, 1.0 - entity.internalHeat / binding));
  }

  /**
   * エンティティの現在の相状態・中空構造に応じた実効密度を返す
   */
  public static getEffectiveDensity(
    entity: Readonly<SpaceEntity>,
    material: MaterialSpec | undefined,
  ): number {
    const baseDensity = material?.density ?? 1.0;
    const phase = entity.phaseState ?? 'solid';
    if (phase === 'liquid') {
      return baseDensity * (material?.liquidDensityRatio ?? 0.9);
    }
    if (phase === 'gas') {
      return Math.max(1e-4, baseDensity * 0.0006);
    }
    if (material?.topology === 'hollow') {
      const shellRatio = Math.max(0.01, Math.min(1.0, material.shellThicknessRatio ?? 0.08));
      const shellVolumeRatio = 1.0 - Math.pow(1.0 - shellRatio, 3);
      const innerDensity = entity.enclosedMediumDensity ?? 0;
      const compositeDensity =
        baseDensity * shellVolumeRatio + innerDensity * (1.0 - shellVolumeRatio);
      const vol = (4.0 / 3.0) * Math.PI * entity.radius * entity.radius * entity.radius;
      const apparentDensity = vol > 1e-5 ? entity.mass / vol : compositeDensity;
      return Math.max(1e-4, Math.min(compositeDensity, apparentDensity));
    }
    return baseDensity;
  }

  /**
   * 素粒子密度と電荷結合力（bindingEnergy × bondRatio）から第一原理で剛性（弾性率）を算出する
   * 液体・気体 (bondRatio = 0) では剛性が 0 になる
   */
  public static getEffectiveRigidity(
    entity: Readonly<SpaceEntity>,
    material: MaterialSpec | undefined,
  ): number {
    const effDensity = PhaseTransitionSolver.getEffectiveDensity(entity, material);
    const binding = material?.bindingEnergy ?? 20.0;
    const bondRatio = PhaseTransitionSolver.getEffectiveBondRatio(entity, material);
    const cohesiveEnergyDensity = effDensity * binding * bondRatio;
    if (cohesiveEnergyDensity <= 0) return 0;
    return Math.min(4.0, 0.08 * Math.sqrt(cohesiveEnergyDensity));
  }

  /**
   * 相転移・燃焼反応・気化集合体分散を実行し、更新されたエンティティ配列を返す
   */
  public solve(
    entities: SpaceEntity[],
    materials: ReadonlyMap<string, MaterialSpec>,
    dt: number,
    medium?: AmbientMediumSpec,
    grid?: SpacePacketGrid,
  ): SpaceEntity[] {
    const ambientHeat = medium?.ambientHeat ?? 0.05;
    const oxidizer = medium?.oxidizerRatio ?? 0.0;
    const baseCooling = medium && medium.density === 0 ? 0.002 : 0.03;

    const nextEntities: SpaceEntity[] = [];

    for (const ent of entities) {
      if (ent.domainClass !== 'Visible') {
        nextEntities.push(ent);
        continue;
      }

      const mat = materials.get(ent.materialId);
      if (!mat) {
        nextEntities.push(ent);
        continue;
      }

      // 1. 酸化還元による燃焼反応（局所酸素ポテンシャル・活性化障壁超過・残燃料あり）
      const fuel = ent.fuelRemaining ?? 1.0;
      let localOxidizer = oxidizer;
      let gridIdx = -1;
      if (grid) {
        const [gx, gy, gz] = grid.worldToGrid(ent.position);
        gridIdx = grid.index(
          Math.max(1, Math.min(grid.nx - 2, Math.round(gx))),
          Math.max(1, Math.min(grid.ny - 2, Math.round(gy))),
          Math.max(1, Math.min(grid.nz - 2, Math.round(gz))),
        );
        localOxidizer = grid.reactivityPotential[gridIdx];
      }
      if (
        localOxidizer > 0.05 &&
        mat.activationBarrier !== undefined &&
        ent.internalHeat >= mat.activationBarrier &&
        fuel > 0.01
      ) {
        ent.isBurning = true;
        const consumed = Math.min(fuel, 0.15 * dt);
        ent.fuelRemaining = fuel - consumed;
        const wellDepth = mat.oxidizedWellDepth ?? 10.0;
        const heatGain = wellDepth * localOxidizer * dt * 2.5;
        ent.internalHeat += heatGain;
        ent.isSleeping = false;

        // 燃焼による空間膨張圧と熱振動を周囲パケットへ注入（上昇気流・光波の創発）
        if (grid) {
          if (gridIdx >= 0) {
            grid.reactivityPotential[gridIdx] = Math.max(
              0,
              grid.reactivityPotential[gridIdx] - consumed * 0.1,
            );
          }
          this.injectCombustionEnergy(grid, ent.position, heatGain);
        }
      } else {
        ent.isBurning = false;
      }

      // 2. 環境温度への緩やかな熱緩和
      if (!ent.isGrabbed && !ent.isBurning) {
        ent.internalHeat += (ambientHeat - ent.internalHeat) * Math.min(1.0, baseCooling * dt);
        if (ent.internalHeat < 0) ent.internalHeat = 0;
      }

      // 3. 連続秩序度 Ψ ∈ [0, 1] の更新と連続相状態の導出
      const psi = PhaseTransitionSolver.getEffectiveBondRatio(ent, mat);
      ent.orderParameter = psi;
      const prevPhase: PhaseState = ent.phaseState ?? 'solid';
      let nextPhase: PhaseState = 'solid';
      if (ent.internalHeat >= mat.bindingEnergy * 2.5) {
        nextPhase = 'gas';
      } else if (psi < 0.35) {
        nextPhase = 'liquid';
      }
      ent.phaseState = nextPhase;

      if (nextPhase !== prevPhase && (nextPhase === 'liquid' || nextPhase === 'gas')) {
        ent.isSleeping = false;
      }

      // 3.5. 準安定形状の加熱復元（U_vib > E_act で準安定ポケットの障壁を越えて元の記憶形状へ帰還：ID分岐なし）
      const eAct = mat.metastableWellBarrier ?? 2.5;
      if (
        ent.memorizedShapeScale &&
        ent.currentShapeScale &&
        ent.internalHeat >= eAct
      ) {
        const restoreRate = Math.min(1.0, 5.0 * dt);
        ent.currentShapeScale = [
          ent.currentShapeScale[0] + (ent.memorizedShapeScale[0] - ent.currentShapeScale[0]) * restoreRate,
          ent.currentShapeScale[1] + (ent.memorizedShapeScale[1] - ent.currentShapeScale[1]) * restoreRate,
          ent.currentShapeScale[2] + (ent.memorizedShapeScale[2] - ent.currentShapeScale[2]) * restoreRate,
        ];
        ent.residualStrain = Math.max(0, (ent.residualStrain ?? 0) * (1.0 - restoreRate));
      }

      // 3.6. 冷却固化時の自己組織化結晶ロック（∇U_vib と anisotropyAxis に沿った対称結晶配向）
      if (nextPhase === 'solid' && psi >= 0.85 && !ent.crystalOrientation && grid) {
        const [gx, gy, gz] = grid.worldToGrid(ent.position);
        const ix = Math.max(1, Math.min(grid.nx - 2, Math.round(gx)));
        const iy = Math.max(1, Math.min(grid.ny - 2, Math.round(gy)));
        const iz = Math.max(1, Math.min(grid.nz - 2, Math.round(gz)));
        const gradUx =
          grid.vibrationEnergy[grid.index(ix + 1, iy, iz)] -
          grid.vibrationEnergy[grid.index(ix - 1, iy, iz)];
        const gradUy =
          grid.vibrationEnergy[grid.index(ix, iy + 1, iz)] -
          grid.vibrationEnergy[grid.index(ix, iy - 1, iz)];
        const gradUz =
          grid.vibrationEnergy[grid.index(ix, iy, iz + 1)] -
          grid.vibrationEnergy[grid.index(ix, iy, iz - 1)];
        const ax = (ent.anisotropyAxis?.[0] ?? 0) + gradUx;
        const ay = (ent.anisotropyAxis?.[1] ?? 1) + gradUy;
        const az = (ent.anisotropyAxis?.[2] ?? 0) + gradUz;
        const mag = Math.sqrt(ax * ax + ay * ay + az * az) || 1.0;
        // 対称結晶格子（45度/90度量子化軸）へスナップして自己組織化
        ent.crystalOrientation = [
          Math.round((ax / mag) * 2) / 2,
          Math.round((ay / mag) * 2) / 2,
          Math.round((az / mag) * 2) / 2,
        ];
      }

      // 4. キュリー点効果（高温の液体・気体では磁気スピン秩序が崩壊）
      if (nextPhase !== 'solid') {
        const magSq =
          ent.magneticMoment[0] * ent.magneticMoment[0] +
          ent.magneticMoment[1] * ent.magneticMoment[1] +
          ent.magneticMoment[2] * ent.magneticMoment[2];
        if (magSq > 1e-6) {
          const decay = Math.max(0, 1.0 - 2.0 * dt);
          ent.magneticMoment[0] *= decay;
          ent.magneticMoment[1] *= decay;
          ent.magneticMoment[2] *= decay;
        }
      }

      // 5. 気化分散 または 弾性限界超過 / 金属疲労累積破断
      const fatigueLimit = mat.fatigueThreshold ?? 999.0;
      const isFatigueFractured = (ent.residualStrain ?? 0) >= fatigueLimit;

      if (nextPhase === 'gas' && !ent.isVaporParticle && ent.radius > 0.08 && !ent.isGrabbed) {
        const dispersed = this.disperseIntoVaporCluster(ent);
        nextEntities.push(...dispersed);
      } else if (
        nextPhase === 'gas' &&
        ent.isVaporParticle &&
        ent.internalHeat >= mat.bindingEnergy * 4.0 &&
        grid &&
        !ent.isGrabbed
      ) {
        // 極高温気化還元（Vaporization）：離散粒子を空間媒質場へ完全に溶かし込む（質量・電荷・熱保存）
        this.vaporizeToField(ent, grid);
      } else if (
        ((ent.elasticEnergy ?? 0) > mat.bindingEnergy || isFatigueFractured) &&
        !ent.isVaporParticle &&
        ent.radius > 0.08 &&
        !ent.isGrabbed
      ) {
        // 弾性エネルギー超過または金属疲労累積限界：結合破断し2つの破片へ分裂
        if (mat.topology === 'hollow' && grid) {
          this.injectBurstShockwave(
            grid,
            ent.position,
            ent.elasticEnergy ?? 5.0,
            ent.enclosedMediumDensity,
          );
        }
        const fragments = this.fractureEntity(ent);
        nextEntities.push(...fragments);
      } else {
        nextEntities.push(ent);
      }
    }

    return nextEntities;
  }

  /**
   * オンデマンド・ミクロ展開（Lazy Micro-Unpack）による外圧・繰り返し曲げの3分岐エネルギー収支計算
   * ①弾性復元 ΔE_elastic / ②熱振動発散 ΔU_vib / ③残留空間歪み δE_jammed
   */
  public applyLazyMicroBending(
    entity: SpaceEntity,
    material: MaterialSpec | undefined,
    externalBendEnergy: number,
    grid?: SpacePacketGrid,
  ): { elasticRecovered: number; heatDissipated: number; jammedResidual: number } {
    const barrier = material?.metastableWellBarrier ?? 1.5;
    if (externalBendEnergy <= 0) {
      return { elasticRecovered: 0, heatDissipated: 0, jammedResidual: 0 };
    }

    // 一時的にミクロ4×4井戸へ展開して厳密エネルギー保存の3分岐収支を計算 (elasticFrac + heatFrac + jammedFrac === 1.0)
    const yieldFactor =
      externalBendEnergy > barrier * 0.2
        ? (externalBendEnergy - barrier * 0.2) / externalBendEnergy
        : 0;
    const elasticFrac = 1.0 - 0.65 * yieldFactor;
    const heatFrac = 0.3 * yieldFactor;
    const jammedFrac = 0.35 * yieldFactor;

    const elasticRecovered = externalBendEnergy * elasticFrac;
    const heatDissipated = externalBendEnergy * heatFrac;
    const jammedResidual = externalBendEnergy * jammedFrac;

    entity.elasticEnergy = (entity.elasticEnergy ?? 0) + elasticRecovered;
    entity.internalHeat += heatDissipated;
    entity.residualStrain = (entity.residualStrain ?? 0) + jammedResidual;

    if (entity.currentShapeScale) {
      entity.currentShapeScale = [
        entity.currentShapeScale[0] * 1.05,
        entity.currentShapeScale[1] * 0.92,
        entity.currentShapeScale[2],
      ];
    }

    // 親パケットへ残留歪みを書き戻して即座に再畳み込み (Re-pack)
    if (grid) {
      const [gx, gy, gz] = grid.worldToGrid(entity.position);
      const idx = grid.index(
        Math.max(1, Math.min(grid.nx - 2, Math.round(gx))),
        Math.max(1, Math.min(grid.ny - 2, Math.round(gy))),
        Math.max(1, Math.min(grid.nz - 2, Math.round(gz))),
      );
      grid.residualStrain[idx] += jammedResidual;
    }

    return { elasticRecovered, heatDissipated, jammedResidual };
  }

  /**
   * 気化した1つの塊を、総質量・総電荷・総熱を保存した4つの気体サブ粒子へ分裂・分散させる
   */
  private disperseIntoVaporCluster(parent: SpaceEntity): SpaceEntity[] {
    const count = 4;
    const subMass = parent.mass / count;
    const subCharge = parent.netCharge / count;
    const subRadius = Math.max(0.05, parent.radius * 0.45);
    const offsets: readonly [number, number, number][] = [
      [1, 0.3, 1],
      [-1, 0.3, 1],
      [1, 0.3, -1],
      [-1, 0.3, -1],
    ];

    const children: SpaceEntity[] = [];
    for (let i = 0; i < count; i++) {
      this.vaporCounter++;
      const [ox, oy, oz] = offsets[i];
      const spread = parent.radius * 0.6;
      children.push({
        id: `${parent.id}_vapor_${this.vaporCounter}`,
        materialId: parent.materialId,
        position: [
          parent.position[0] + ox * spread,
          parent.position[1] + oy * spread,
          parent.position[2] + oz * spread,
        ],
        velocity: [
          parent.velocity[0] + ox * 0.35,
          parent.velocity[1] + 0.4,
          parent.velocity[2] + oz * 0.35,
        ],
        angularVelocity: [0, 0, 0],
        radius: subRadius,
        shape: 'sphere',
        dimensions: [subRadius * 2, subRadius * 2, subRadius * 2],
        mass: subMass,
        netCharge: subCharge,
        dipoleMoment: [0, 0, 0],
        magneticMoment: [0, 0, 0],
        internalHeat: parent.internalHeat,
        phaseState: 'gas',
        isVaporParticle: true,
        isGrounded: false,
        isGrabbed: false,
        isSleeping: false,
        domainClass: 'Visible',
      });
    }
    return children;
  }

  private fractureEntity(parent: SpaceEntity): SpaceEntity[] {
    const halfMass = parent.mass * 0.5;
    const halfCharge = parent.netCharge * 0.5;
    const fragRadius = Math.max(0.05, parent.radius * 0.65);
    const releasedHeat = (parent.elasticEnergy ?? 0) * 0.5;
    const dirs: readonly [number, number, number][] = [
      [1, 0.2, 0],
      [-1, 0.2, 0],
    ];
    return dirs.map((d) => {
      this.vaporCounter++;
      return {
        id: `${parent.id}_frag_${this.vaporCounter}`,
        materialId: parent.materialId,
        position: [
          parent.position[0] + d[0] * fragRadius,
          parent.position[1] + d[1] * fragRadius,
          parent.position[2],
        ],
        velocity: [parent.velocity[0] + d[0] * 0.8, parent.velocity[1] + 0.5, parent.velocity[2]],
        angularVelocity: [0, 0, 0],
        radius: fragRadius,
        shape: parent.shape,
        dimensions: [fragRadius * 2, fragRadius * 2, fragRadius * 2],
        mass: halfMass,
        netCharge: halfCharge,
        dipoleMoment: [0, 0, 0],
        magneticMoment: [0, 0, 0],
        internalHeat: parent.internalHeat + releasedHeat * 0.5,
        elasticEnergy: 0,
        phaseState: parent.phaseState,
        isVaporParticle: true,
        isGrounded: false,
        isGrabbed: false,
        isSleeping: false,
        domainClass: 'Visible',
      };
    });
  }

  private injectBurstShockwave(
    grid: SpacePacketGrid,
    pos: readonly [number, number, number],
    burstEnergy: number,
    enclosedMediumDensity?: number,
  ): void {
    const [gx, gy, gz] = grid.worldToGrid([pos[0], pos[1], pos[2]]);
    const cx = Math.max(1, Math.min(grid.nx - 2, Math.round(gx)));
    const cy = Math.max(1, Math.min(grid.ny - 2, Math.round(gy)));
    const cz = Math.max(1, Math.min(grid.nz - 2, Math.round(gz)));
    const cIdx = grid.index(cx, cy, cz);
    grid.phi[cIdx] += burstEnergy * 1.5;
    if (enclosedMediumDensity !== undefined) {
      grid.mediumDensity[cIdx] = enclosedMediumDensity;
      grid.mediumConcentration[cIdx] = 1.0;
    }
    grid.isSleeping[cIdx] = 0;

    // 周囲6近傍へ放射状の圧力波（破裂音・衝撃波）を駆動
    const dirs: readonly [number, number, number][] = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ];
    for (const [dx, dy, dz] of dirs) {
      const nIdx = grid.index(
        Math.max(1, Math.min(grid.nx - 2, cx + dx)),
        Math.max(1, Math.min(grid.ny - 2, cy + dy)),
        Math.max(1, Math.min(grid.nz - 2, cz + dz)),
      );
      grid.px[nIdx] += dx * burstEnergy * 0.8;
      grid.py[nIdx] += (dy + 0.5) * burstEnergy * 0.8;
      grid.pz[nIdx] += dz * burstEnergy * 0.8;
      grid.isSleeping[nIdx] = 0;
    }
  }

  private injectCombustionEnergy(
    grid: SpacePacketGrid,
    pos: readonly [number, number, number],
    energy: number,
  ): void {
    const [gx, gy, gz] = grid.worldToGrid([pos[0], pos[1], pos[2]]);
    const ix = Math.max(1, Math.min(grid.nx - 2, Math.round(gx)));
    const iy = Math.max(1, Math.min(grid.ny - 2, Math.round(gy)));
    const iz = Math.max(1, Math.min(grid.nz - 2, Math.round(gz)));
    const idx = grid.index(ix, iy, iz);
    grid.vibrationEnergy[idx] += energy;
    grid.py[idx] += energy * 0.4; // 上昇気流（熱対流）の駆動
    grid.isSleeping[idx] = 0;
  }

  /**
   * 凝縮昇格（Materialization: 場 → オブジェクト）
   * 過飽和・過冷却の空間パケットから媒質質量を消費して凝縮体（液滴・氷核）を生成する
   */
  public condenseFromField(
    grid: SpacePacketGrid,
    materials: ReadonlyMap<string, MaterialSpec>,
    existingEntities: readonly SpaceEntity[],
  ): SpaceEntity[] {
    if (existingEntities.length >= 80) return [];
    const targetMatId = materials.has('ice') ? 'ice' : materials.keys().next().value;
    if (!targetMatId) return [];

    const created: SpaceEntity[] = [];
    for (let z = 1; z < grid.nz - 1; z += 2) {
      for (let y = 1; y < grid.ny - 1; y += 2) {
        for (let x = 1; x < grid.nx - 1; x += 2) {
          if (created.length >= 4) return created;
          const idx = grid.index(x, y, z);
          const cMed = grid.mediumConcentration[idx];
          const rhoMed = grid.mediumDensity[idx];
          const uVib = grid.vibrationEnergy[idx];

          if (cMed < 0.85 || rhoMed < 0.05 || uVib > 0.02) continue;

          const psiField = Math.min(
            1.0,
            ((rhoMed * cMed) / 0.05) * (0.02 / Math.max(uVib, 0.005)),
          );
          if (psiField <= 0.75) continue;

          const consumedDensity = Math.min(rhoMed * 0.5, 0.04);
          const condensedMass = Math.max(1e-4, consumedDensity * cMed * grid.cellVolume);
          grid.mediumDensity[idx] = Math.max(0, rhoMed - consumedDensity);
          grid.mediumConcentration[idx] = Math.max(0, cMed * 0.5);
          grid.isSleeping[idx] = 0;

          const center = grid.packetCenter(x, y, z);
          this.vaporCounter++;
          created.push({
            id: `condensate_${this.vaporCounter}`,
            materialId: targetMatId,
            position: [center[0], center[1], center[2]],
            velocity: [grid.px[idx] * 0.2, grid.py[idx] * 0.2, grid.pz[idx] * 0.2],
            angularVelocity: [0, 0, 0],
            radius: Math.max(0.06, grid.cellSize * 0.3),
            shape: 'sphere',
            mass: condensedMass,
            netCharge: 0,
            dipoleMoment: [0, 0, 0],
            magneticMoment: [0, 0, 0],
            internalHeat: uVib * 0.25,
            phaseState: 'solid',
            orderParameter: Math.min(1, psiField),
            isGrounded: false,
            isGrabbed: false,
            isSleeping: false,
            domainClass: 'Visible',
          });
        }
      }
    }
    return created;
  }

  /**
   * 気化還元（Vaporization: オブジェクト → 場）
   * エンティティを削除し、質量・電荷・内部熱エネルギーを包含空間パケットへ厳密保存で溶かし込む
   */
  public vaporizeToField(entity: SpaceEntity, grid: SpacePacketGrid): void {
    const [gx, gy, gz] = grid.worldToGrid(entity.position);
    const ix = Math.max(1, Math.min(grid.nx - 2, Math.round(gx)));
    const iy = Math.max(1, Math.min(grid.ny - 2, Math.round(gy)));
    const iz = Math.max(1, Math.min(grid.nz - 2, Math.round(gz)));
    const idx = grid.index(ix, iy, iz);

    const invVol = 1.0 / Math.max(grid.cellVolume, 1e-6);
    grid.mediumDensity[idx] += entity.mass * invVol;
    grid.mediumConcentration[idx] = Math.min(1.0, Math.max(grid.mediumConcentration[idx], 0.5));
    grid.vibrationEnergy[idx] += entity.internalHeat;
    grid.phi[idx] += entity.netCharge * invVol;
    grid.sourcePhi[idx] += entity.netCharge * invVol;
    grid.isSleeping[idx] = 0;
  }
}
