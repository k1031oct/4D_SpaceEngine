import { PhaseTransitionSolver } from './PhaseTransitionSolver';
import type { MaterialSpec, SpaceCoreConfig, SpaceEntity } from './types';

/**
 * 不可侵バリア・定在波の檻・電池連結グループ回路ソルバ（Contact Solver）
 * 固定摩擦係数（μ_s, μ_d）や固定反発係数（restitution）、固定電池電圧を廃止し、
 * 1. 電子雲の指数関数的空間気圧スパイクによる非貫通反発
 * 2. 表面波紋共鳴による定在波の檻（エネルギー保存則を厳密に満たす摩擦熱変換）
 * 3. 床面の定在波の檻への統一
 * 4. 電子親和力差 Δχ に基づく電池回路電圧の自律創発
 * を実装する。
 */
export class ContactSolver {
  private static readonly FLOOR_WAVELENGTH = 0.35;
  private static readonly FLOOR_POTENTIAL_DEPTH = 0.65;

  public solve(
    entities: SpaceEntity[],
    materials: ReadonlyMap<string, MaterialSpec>,
    dt: number,
    config: SpaceCoreConfig,
  ): number {
    // 1. 位置積分と弾性圧縮ひずみの復元減衰
    for (const ent of entities) {
      if ((ent.compression ?? 0) > 0) {
        ent.compression = Math.max(0, (ent.compression ?? 0) - 2.5 * dt);
        ent.elasticEnergy = (ent.elasticEnergy ?? 0) * Math.max(0, 1.0 - 8.0 * dt);
      }
      if (ent.domainClass !== 'Visible' || ent.isGrabbed || ent.isSleeping) continue;
      ent.position[0] += ent.velocity[0] * dt;
      ent.position[1] += ent.velocity[1] * dt;
      ent.position[2] += ent.velocity[2] * dt;
    }

    // 2. エンティティ同士の指数関数的気圧スパイク反発・定在波の檻・帯電
    for (let i = 0; i < entities.length; i++) {
      const a = entities[i];
      if (a.domainClass !== 'Visible') continue;

      for (let j = i + 1; j < entities.length; j++) {
        const b = entities[j];
        if (b.domainClass !== 'Visible') continue;

        const { nx, ny, nz, overlap } = this.computeContactGeometry(a, b);
        if (overlap <= 0) continue;
        if (a.isSleeping && b.isSleeping && overlap <= 0.002) continue;

        const invMa = a.isGrabbed || a.isGrounded ? 0 : 1.0 / Math.max(a.mass, 1e-4);
        const invMb = b.isGrabbed || b.isGrounded ? 0 : 1.0 / Math.max(b.mass, 1e-4);
        const invMSum = invMa + invMb;

        const rvx = b.velocity[0] - a.velocity[0];
        const rvy = b.velocity[1] - a.velocity[1];
        const rvz = b.velocity[2] - a.velocity[2];
        const velAlongNormal = rvx * nx + rvy * ny + rvz * nz;

        const matA = materials.get(a.materialId);
        const matB = materials.get(b.materialId);

        // 法線押し付け気圧 ΔP_⊥ の算出（電子雲重なりによる定在波の檻の深化と、平衡超え時の反発スパイク）
        const r0Avg = ((matA?.equilibriumSpacing ?? 0.25) + (matB?.equilibriumSpacing ?? 0.25)) * 0.5;
        const overlapPressure = Math.exp(Math.min(3.5, overlap / Math.max(r0Avg * 0.25, 0.02))) - 1.0;
        const excessOverlap = Math.max(0, overlap - 0.002);
        const barrierSpike =
          excessOverlap > 0 ? Math.exp(Math.min(3.5, excessOverlap / Math.max(r0Avg * 0.25, 0.02))) - 1.0 : 0;
        const normalPressure = Math.max(0.2, overlapPressure + Math.max(0, -velAlongNormal));

        if (invMSum > 0) {
          // 指数関数的空間気圧スパイクによる速度場反発加速
          const spikeImpulse = barrierSpike * 0.35 * dt;
          if (!a.isGrabbed && !a.isGrounded) {
            a.velocity[0] -= nx * spikeImpulse * invMa;
            a.velocity[1] -= ny * spikeImpulse * invMa;
            a.velocity[2] -= nz * spikeImpulse * invMa;
          }
          if (!b.isGrabbed && !b.isGrounded) {
            b.velocity[0] += nx * spikeImpulse * invMb;
            b.velocity[1] += ny * spikeImpulse * invMb;
            b.velocity[2] += nz * spikeImpulse * invMb;
          }

          // PBD位置補正は貫通防止の最小限の安全ガードに留める
          const guardCorr = Math.max(0, overlap - 0.002) / invMSum;
          if (guardCorr > 0) {
            if (!a.isGrabbed && !a.isGrounded) {
              a.position[0] -= nx * guardCorr * invMa;
              a.position[1] -= ny * guardCorr * invMa;
              a.position[2] -= nz * guardCorr * invMa;
              if (overlap > 0.015) a.isSleeping = false;
            }
            if (!b.isGrabbed && !b.isGrounded) {
              b.position[0] += nx * guardCorr * invMb;
              b.position[1] += ny * guardCorr * invMb;
              b.position[2] += nz * guardCorr * invMb;
              if (overlap > 0.015) b.isSleeping = false;
            }
          }

          // 法線衝突時の塑性・弾性エネルギー分配（固定反発係数を廃止）
          if (velAlongNormal < 0) {
            const bondA = PhaseTransitionSolver.getEffectiveBondRatio(a, matA);
            const bondB = PhaseTransitionSolver.getEffectiveBondRatio(b, matB);
            const avgBond = (bondA + bondB) * 0.5;
            const avgPlasticity =
              1.0 - (1.0 - ((matA?.plasticity ?? 0.4) + (matB?.plasticity ?? 0.4)) * 0.5) * avgBond;
            const eEff = Math.sqrt(Math.max(0, 1.0 - avgPlasticity)) * 0.4;

            const jImp = (-(1 + eEff) * velAlongNormal) / invMSum;
            if (!a.isGrabbed && !a.isGrounded) {
              a.velocity[0] -= jImp * invMa * nx;
              a.velocity[1] -= jImp * invMa * ny;
              a.velocity[2] -= jImp * invMa * nz;
              if (Math.abs(jImp * invMa) > config.sleepVelocityThreshold) a.isSleeping = false;
            }
            if (!b.isGrabbed && !b.isGrounded) {
              b.velocity[0] += jImp * invMb * nx;
              b.velocity[1] += jImp * invMb * ny;
              b.velocity[2] += jImp * invMb * nz;
              if (Math.abs(jImp * invMb) > config.sleepVelocityThreshold) b.isSleeping = false;
            }
          }

          // 法線押し付け圧 ΔP_⊥ による定在波の檻の深化が、十分な減衰後に自然な静止ロックを創発する
          const relSpeedSq = rvx * rvx + rvy * rvy + rvz * rvz;
          const lockThresh = config.sleepVelocityThreshold * Math.min(2.5, 1.0 + normalPressure * 0.5);
          if (relSpeedSq < lockThresh * lockThresh) {
            if (!a.isGrabbed && !a.isGrounded) {
              a.velocity = [0, 0, 0];
              a.isSleeping = true;
            }
            if (!b.isGrabbed && !b.isGrounded) {
              b.velocity = [0, 0, 0];
              b.isSleeping = true;
            }
          }
        }

        // 定在波の檻（エネルギー保存則厳密適用）・摩擦帯電・導体分配・アース放電
        this.applyStandingWaveContact(
          a,
          b,
          matA,
          matB,
          rvx,
          rvy,
          rvz,
          velAlongNormal,
          normalPressure,
          nx,
          ny,
          nz,
          invMa,
          invMb,
          dt,
          config,
        );
      }
    }

    // 3. 床面（机）接触の定在波の檻への統一処理
    const floorY = config.floorY;
    for (const ent of entities) {
      if (ent.domainClass !== 'Visible' || ent.isGrabbed) continue;

      const mat = materials.get(ent.materialId);
      const halfH = ent.dimensions ? ent.dimensions[1] * 0.5 : ent.radius;
      if (Number.isFinite(floorY)) {
        const bottomY = ent.position[1] - halfH;

        if (bottomY <= floorY + 2e-3) {
          const floorOverlap = Math.max(0, floorY + halfH - ent.position[1]);
          ent.position[1] = floorY + halfH;

          // 垂直方向の弾性エネルギー蓄積・塑性熱散逸・復元反発
          if (ent.velocity[1] < 0) {
            const impactSpeed = Math.abs(ent.velocity[1]);
            const impactKE = 0.5 * ent.mass * impactSpeed * impactSpeed;
            const bondRatio = PhaseTransitionSolver.getEffectiveBondRatio(ent, mat);
            const objPlasticity = mat?.plasticity ?? 0.5;
            // 結合度低下による熱軟化 + 床面との結合エネルギー吸収
            const plasticity = 1.0 - (1.0 - Math.max(objPlasticity, 0.52)) * bondRatio;
            const rigidity = Math.max(0.05, PhaseTransitionSolver.getEffectiveRigidity(ent, mat));

            ent.internalHeat += impactKE * plasticity * 0.25;
            const storedElastic = impactKE * (1.0 - plasticity);
            ent.elasticEnergy = (ent.elasticEnergy ?? 0) + storedElastic;

            const strain = Math.min(
              0.32,
              Math.sqrt(storedElastic / Math.max(rigidity * ent.mass * 12.0, 0.1)),
            );
            ent.compression = Math.max(ent.compression ?? 0, strain);

            const reboundSpeed = Math.sqrt((2.0 * storedElastic) / Math.max(ent.mass, 1e-4));
            if (reboundSpeed < 0.35) {
              ent.velocity[1] = 0;
            } else {
              ent.velocity[1] = reboundSpeed;
              ent.isSleeping = false;
            }
          }

          // 水平方向は床面を「表面波紋を持つ空間境界」として定在波の檻モデルで摩擦・静止ロックを創発
          const vtx = ent.velocity[0];
          const vtz = ent.velocity[2];
          const vtMag = Math.sqrt(vtx * vtx + vtz * vtz);
          if (vtMag > 1e-6) {
            const lamObj = mat?.surfaceWavelength ?? 0.3;
            const u0Obj = mat?.surfacePotentialDepth ?? 0.5;
            const resonanceM =
              (u0Obj + ContactSolver.FLOOR_POTENTIAL_DEPTH) /
              (1.0 +
                Math.abs(lamObj - ContactSolver.FLOOR_WAVELENGTH) /
                  Math.max(lamObj, ContactSolver.FLOOR_WAVELENGTH, 0.05));
            const floorNormalP = Math.max(0.5, floorOverlap * 50.0 + 1.0);
            const trapMax = Math.max(0.01, floorNormalP * resonanceM - 0.1 * ent.internalHeat);
            const kinT = 0.5 * ent.mass * vtMag * vtMag;

            if (kinT <= trapMax) {
              // 定在波の檻へ捕獲して静止
              const captured = kinT * Math.min(1.0, 55.0 * dt);
              const newKE = Math.max(0, kinT - captured);
              const speedRatio = Math.sqrt(newKE / kinT);
              ent.velocity[0] *= speedRatio;
              ent.velocity[2] *= speedRatio;
              ent.trapEnergyStored = (ent.trapEnergyStored ?? 0) + captured;
            } else {
              // 限界突破：動摩擦として運動エネルギーを消費し、厳密に等量の摩擦熱を発生
              const dE = Math.min(kinT, trapMax * 10.0 * dt);
              const newKE = Math.max(0, kinT - dE);
              const speedRatio = Math.sqrt(newKE / kinT);
              ent.velocity[0] *= speedRatio;
              ent.velocity[2] *= speedRatio;
              ent.internalHeat += dE + (ent.trapEnergyStored ?? 0);
              ent.trapEnergyStored = 0;
            }
          }

          // 定在波の檻によるエネルギー減衰後に自然ロック判定
          const speedSq =
            ent.velocity[0] * ent.velocity[0] +
            ent.velocity[1] * ent.velocity[1] +
            ent.velocity[2] * ent.velocity[2];
          const thresh = config.sleepVelocityThreshold;
          if (speedSq < thresh * thresh) {
            ent.velocity[0] = 0;
            ent.velocity[1] = 0;
            ent.velocity[2] = 0;
            ent.isSleeping = true;
          }
        }

        // 計算窓の内側にソフトに留める
        const margin = ent.radius + 0.05;
        const minX = -((config.nx * config.cellSize) * 0.5) + config.center[0] + margin;
        const maxX = ((config.nx * config.cellSize) * 0.5) + config.center[0] - margin;
        const minZ = -((config.nz * config.cellSize) * 0.5) + config.center[2] + margin;
        const maxZ = ((config.nz * config.cellSize) * 0.5) + config.center[2] - margin;

        if (ent.position[0] < minX) {
          ent.position[0] = minX;
          ent.velocity[0] = Math.max(0, -ent.velocity[0] * 0.3);
        } else if (ent.position[0] > maxX) {
          ent.position[0] = maxX;
          ent.velocity[0] = Math.min(0, -ent.velocity[0] * 0.3);
        }
        if (ent.position[2] < minZ) {
          ent.position[2] = minZ;
          ent.velocity[2] = Math.max(0, -ent.velocity[2] * 0.3);
        } else if (ent.position[2] > maxZ) {
          ent.position[2] = maxZ;
          ent.velocity[2] = Math.min(0, -ent.velocity[2] * 0.3);
        }
      }
    }

    // 4. 連結グループ（電池回路）の駆動と電子親和力差電圧の創発
    return this.solveBatteryCircuits(entities, materials, dt);
  }

  /**
   * 連結グループ（電池＋極・セパレータ・－極）と導線・電球回路の気圧落差電流を計算する
   * 固定電圧を廃止し、両電極の電子親和力差 Δχ から電圧を自律創発させる
   */
  private solveBatteryCircuits(
    entities: SpaceEntity[],
    materials: ReadonlyMap<string, MaterialSpec>,
    dt: number,
  ): number {
    const anodes = entities.filter((e) => e.groupRole === 'anode');
    const separators = entities.filter((e) => e.groupRole === 'separator');
    const cathodes = entities.filter((e) => e.groupRole === 'cathode');
    if (anodes.length === 0 || separators.length === 0 || cathodes.length === 0) {
      return 0;
    }

    let totalCurrent = 0;
    for (const sep of separators) {
      const chem = sep.chemicalEnergy ?? 0;
      if (chem <= 0) continue;

      const gid = sep.groupId;
      const anode = anodes.find((a) => a.groupId === gid) ?? anodes[0];
      const cathode = cathodes.find((c) => c.groupId === gid) ?? cathodes[0];

      // 電子親和力差 Δχ から維持電圧（気圧落差）を第一原理算出
      const matA = materials.get(anode.materialId);
      const matC = materials.get(cathode.materialId);
      const rawDeltaChi = Math.abs((matA?.electronAffinity ?? 0.5) - (matC?.electronAffinity ?? -0.5));
      // 同一マテリアルIDを仮に用いた場合でも極性のポテンシャル差（bondChargeDensity差等）を考慮
      const deltaChi = rawDeltaChi > 0.05 ? rawDeltaChi : Math.max(0.2, matA?.bondChargeDensity ?? 0.8);
      const emergentHalfV = deltaChi * 2.5;

      if (anode.netCharge < emergentHalfV) {
        anode.netCharge += (emergentHalfV - anode.netCharge) * Math.min(1, 10 * dt);
      }
      if (cathode.netCharge > -emergentHalfV) {
        cathode.netCharge += (-emergentHalfV - cathode.netCharge) * Math.min(1, 10 * dt);
      }

      const circuitNodes = entities.filter(
        (e) => e.groupRole === 'wire' || e.groupRole === 'bulb',
      );
      if (circuitNodes.length === 0) continue;

      const isNear = (p1: SpaceEntity, p2: SpaceEntity) => {
        const dx = p1.position[0] - p2.position[0];
        const dy = p1.position[1] - p2.position[1];
        const dz = p1.position[2] - p2.position[2];
        const reach = p1.radius + p2.radius + 0.15;
        return dx * dx + dy * dy + dz * dz <= reach * reach;
      };

      const touchesAnode = circuitNodes.some((n) => isNear(n, anode));
      const touchesCathode = circuitNodes.some((n) => isNear(n, cathode));

      if (touchesAnode && touchesCathode) {
        const voltage = anode.netCharge - cathode.netCharge;
        let minCond = 1.0;
        for (const n of circuitNodes) {
          const cond = materials.get(n.materialId)?.conductivity ?? 0.5;
          if (cond < minCond) minCond = cond;
        }
        const current = Math.max(0, voltage * minCond);
        totalCurrent += current;

        // 化学エネルギー消費量とジュール発熱量の厳密収支
        const chemBurn = Math.min(chem, current * 0.25 * dt);
        sep.chemicalEnergy = chem - chemBurn;
        const totalRes = circuitNodes.reduce(
          (sum, n) => sum + Math.max(0.05, 1.0 - (materials.get(n.materialId)?.conductivity ?? 0.5)),
          0,
        );
        for (const n of circuitNodes) {
          const cond = materials.get(n.materialId)?.conductivity ?? 0.5;
          const resistance = Math.max(0.05, 1.0 - cond);
          n.internalHeat += chemBurn * (resistance / Math.max(totalRes, 1e-4)) * 2.5;
        }
        if (sep.chemicalEnergy <= 0.001) {
          sep.chemicalEnergy = 0;
          anode.netCharge *= 0.5;
          cathode.netCharge *= 0.5;
        }
      }
    }
    return totalCurrent;
  }

  /**
   * 定在波の檻によるエネルギー保存型摩擦・冷間圧接・摩擦帯電・アース接地を処理する
   */
  private applyStandingWaveContact(
    a: SpaceEntity,
    b: SpaceEntity,
    matA: MaterialSpec | undefined,
    matB: MaterialSpec | undefined,
    rvx: number,
    rvy: number,
    rvz: number,
    velAlongNormal: number,
    normalPressure: number,
    nx: number,
    ny: number,
    nz: number,
    invMa: number,
    invMb: number,
    dt: number,
    config: SpaceCoreConfig,
  ): void {
    if (!matA || !matB) return;

    const tvx = rvx - velAlongNormal * nx;
    const tvy = rvy - velAlongNormal * ny;
    const tvz = rvz - velAlongNormal * nz;
    const tangentSpeed = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);

    const minCond = Math.min(matA.conductivity, matB.conductivity);
    const totalHeat = a.internalHeat + b.internalHeat;

    // 極低温・同種物質・高圧接触での境界融合（冷間圧接）
    if (a.materialId === b.materialId && totalHeat < 0.04 && Math.abs(velAlongNormal) < 0.5) {
      a.isColdWelded = true;
      b.isColdWelded = true;
      const avgVx = (a.velocity[0] + b.velocity[0]) * 0.5;
      const avgVy = (a.velocity[1] + b.velocity[1]) * 0.5;
      const avgVz = (a.velocity[2] + b.velocity[2]) * 0.5;
      a.velocity = [avgVx, avgVy, avgVz];
      b.velocity = [avgVx, avgVy, avgVz];
    }

    if (tangentSpeed > 0.01) {
      const lamA = matA.surfaceWavelength ?? 0.3;
      const lamB = matB.surfaceWavelength ?? 0.3;
      const u0A = matA.surfacePotentialDepth ?? 0.5;
      const u0B = matB.surfacePotentialDepth ?? 0.5;
      const resonanceM = (u0A + u0B) / (1.0 + Math.abs(lamA - lamB) / Math.max(lamA, lamB, 0.05));
      const trapMax = Math.max(0.0005, normalPressure * resonanceM - 0.12 * totalHeat);

      // 相対運動の換算質量 μ_red と接線相対運動エネルギー
      const invMSum = invMa + invMb;
      const reducedMass = invMSum > 0 ? 1.0 / invMSum : Math.min(a.mass, b.mass);
      const kinTangent = 0.5 * reducedMass * tangentSpeed * tangentSpeed;

      if (kinTangent <= trapMax) {
        // 定在波の檻へエネルギーを捕獲し、厳密にその分だけ接線相対速度を減速
        const captured = kinTangent * Math.min(0.8, 8.0 * dt);
        if (invMSum > 0 && kinTangent > 1e-8) {
          const factor = 1.0 - Math.sqrt(Math.max(0, kinTangent - captured) / kinTangent);
          const dPx = factor * reducedMass * tvx;
          const dPy = factor * reducedMass * tvy;
          const dPz = factor * reducedMass * tvz;
          if (!a.isGrabbed && !a.isGrounded) {
            a.velocity[0] += dPx * invMa;
            a.velocity[1] += dPy * invMa;
            a.velocity[2] += dPz * invMa;
          }
          if (!b.isGrabbed && !b.isGrounded) {
            b.velocity[0] -= dPx * invMb;
            b.velocity[1] -= dPy * invMb;
            b.velocity[2] -= dPz * invMb;
          }
        }
        a.trapEnergyStored = (a.trapEnergyStored ?? 0) + captured * 0.35;
        b.trapEnergyStored = (b.trapEnergyStored ?? 0) + captured * 0.35;
        a.internalHeat += captured * 0.15;
        b.internalHeat += captured * 0.15;
      } else {
        // 限界突破（決壊）：運動エネルギーの一部を摩擦として奪い、蓄積分と合わせて熱 U_vib へ厳密変換
        const frictionLoss = Math.min(kinTangent, trapMax * Math.min(0.9, 6.0 * dt));
        if (invMSum > 0 && kinTangent > 1e-8) {
          const factor = 1.0 - Math.sqrt(Math.max(0, kinTangent - frictionLoss) / kinTangent);
          const dPx = factor * reducedMass * tvx;
          const dPy = factor * reducedMass * tvy;
          const dPz = factor * reducedMass * tvz;
          if (!a.isGrabbed && !a.isGrounded) {
            a.velocity[0] += dPx * invMa;
            a.velocity[1] += dPy * invMa;
            a.velocity[2] += dPz * invMa;
          }
          if (!b.isGrabbed && !b.isGrounded) {
            b.velocity[0] -= dPx * invMb;
            b.velocity[1] -= dPy * invMb;
            b.velocity[2] -= dPz * invMb;
          }
        }
        const releasedTrap = (a.trapEnergyStored ?? 0) + (b.trapEnergyStored ?? 0);
        a.trapEnergyStored = 0;
        b.trapEnergyStored = 0;
        const totalGeneratedHeat = frictionLoss + releasedTrap;
        a.internalHeat += totalGeneratedHeat * 0.5;
        b.internalHeat += totalGeneratedHeat * 0.5;
      }

      if (minCond < 0.35 && !a.isGrounded && !b.isGrounded) {
        const deltaAffinity = matA.electronAffinity - matB.electronAffinity;
        const dq = config.triboRate * deltaAffinity * tangentSpeed * dt;
        a.netCharge -= dq;
        b.netCharge += dq;
      }
    }

    // 3. アース接地による放電
    if (a.isGrounded && !b.isGrounded) {
      const drain = Math.min(1.0, Math.max(0.25, matB.conductivity) * 18.0 * dt);
      b.netCharge *= 1.0 - drain;
      if (Math.abs(b.netCharge) < 1e-3) b.netCharge = 0;
      return;
    }
    if (b.isGrounded && !a.isGrounded) {
      const drain = Math.min(1.0, Math.max(0.25, matA.conductivity) * 18.0 * dt);
      a.netCharge *= 1.0 - drain;
      if (Math.abs(a.netCharge) < 1e-3) a.netCharge = 0;
      return;
    }

    // 4. 導体同士の接触による電荷分配
    if (minCond > 0.35) {
      const totalQ = a.netCharge + b.netCharge;
      const rSum = Math.max(a.radius + b.radius, 1e-4);
      const targetA = totalQ * (a.radius / rSum);
      const targetB = totalQ * (b.radius / rSum);
      const rate = Math.min(1.0, minCond * 20.0 * dt);
      a.netCharge += (targetA - a.netCharge) * rate;
      b.netCharge += (targetB - b.netCharge) * rate;
    }
  }

  private computeContactGeometry(
    a: SpaceEntity,
    b: SpaceEntity,
  ): { nx: number; ny: number; nz: number; overlap: number } {
    const aIsBox = (a.shape === 'box' || a.shape === 'sheet') && a.dimensions;
    const bIsBox = (b.shape === 'box' || b.shape === 'sheet') && b.dimensions;

    if (bIsBox && !aIsBox && b.dimensions) {
      return this.sphereVsBox(a.position, a.radius, b.position, b.dimensions, false);
    }
    if (aIsBox && !bIsBox && a.dimensions) {
      return this.sphereVsBox(b.position, b.radius, a.position, a.dimensions, true);
    }

    const dx = b.position[0] - a.position[0];
    const dy = b.position[1] - a.position[1];
    const dz = b.position[2] - a.position[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    const ra = a.dimensions ? Math.min(a.dimensions[0], a.dimensions[2]) * 0.5 : a.radius;
    const rb = b.dimensions ? Math.min(b.dimensions[0], b.dimensions[2]) * 0.5 : b.radius;
    const minDist = Math.max(ra, a.radius * 0.6) + Math.max(rb, b.radius * 0.6);

    if (distSq >= minDist * minDist) {
      return { nx: 0, ny: 1, nz: 0, overlap: 0 };
    }
    const dist = Math.sqrt(Math.max(distSq, 1e-10));
    return {
      nx: dx / dist,
      ny: dy / dist,
      nz: dz / dist,
      overlap: minDist - dist,
    };
  }

  private sphereVsBox(
    spherePos: readonly [number, number, number],
    radius: number,
    boxPos: readonly [number, number, number],
    dims: readonly [number, number, number],
    invertNormal: boolean,
  ): { nx: number; ny: number; nz: number; overlap: number } {
    const hx = dims[0] * 0.5;
    const hy = dims[1] * 0.5;
    const hz = dims[2] * 0.5;

    const cx = Math.max(boxPos[0] - hx, Math.min(boxPos[0] + hx, spherePos[0]));
    const cy = Math.max(boxPos[1] - hy, Math.min(boxPos[1] + hy, spherePos[1]));
    const cz = Math.max(boxPos[2] - hz, Math.min(boxPos[2] + hz, spherePos[2]));

    const dx = cx - spherePos[0];
    const dy = cy - spherePos[1];
    const dz = cz - spherePos[2];
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq >= radius * radius) {
      return { nx: 0, ny: 1, nz: 0, overlap: 0 };
    }
    const dist = Math.sqrt(Math.max(distSq, 1e-10));
    const sign = invertNormal ? -1 : 1;
    return {
      nx: (dx / dist) * sign,
      ny: (dy / dist) * sign,
      nz: (dz / dist) * sign,
      overlap: radius - dist,
    };
  }
}
