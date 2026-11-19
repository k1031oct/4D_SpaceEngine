import { PhaseTransitionSolver } from './PhaseTransitionSolver';
import type { MaterialSpec, SpaceCoreConfig, SpaceEntity } from './types';

/**
 * サブグリッド接触・摩擦ソルバ（Sub-grid Contact Solver）
 * 空間パケットの解像度以下の「剛体めり込み防止」「表面摩擦」「静止摩擦ロック」を担当し、
 * 微振動（ドリフト問題）を根本的に解消する。
 */
export class ContactSolver {
  /**
   * 床面（机）およびエンティティ同士の接触を解決する
   */
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

    // 2. エンティティ同士のめり込み解消・衝突減衰
    for (let i = 0; i < entities.length; i++) {
      const a = entities[i];
      if (a.domainClass !== 'Visible') continue;

      for (let j = i + 1; j < entities.length; j++) {
        const b = entities[j];
        if (b.domainClass !== 'Visible') continue;

        const { nx, ny, nz, overlap } = this.computeContactGeometry(a, b);
        if (overlap <= 0) continue;

        const invMa = a.isGrabbed || a.isGrounded ? 0 : 1.0 / Math.max(a.mass, 1e-4);
        const invMb = b.isGrabbed || b.isGrounded ? 0 : 1.0 / Math.max(b.mass, 1e-4);
        const invMSum = invMa + invMb;

        const rvx = b.velocity[0] - a.velocity[0];
        const rvy = b.velocity[1] - a.velocity[1];
        const rvz = b.velocity[2] - a.velocity[2];
        const velAlongNormal = rvx * nx + rvy * ny + rvz * nz;

        const matA = materials.get(a.materialId);
        const matB = materials.get(b.materialId);

        if (invMSum > 0) {
          // 位置補正（Position-Based）
          const corr = overlap / invMSum;
          const significantOverlap = overlap > 2e-3;
          if (!a.isGrabbed && !a.isGrounded) {
            a.position[0] -= nx * corr * invMa;
            a.position[1] -= ny * corr * invMa;
            a.position[2] -= nz * corr * invMa;
            if (significantOverlap) a.isSleeping = false;
          }
          if (!b.isGrabbed && !b.isGrounded) {
            b.position[0] += nx * corr * invMb;
            b.position[1] += ny * corr * invMb;
            b.position[2] += nz * corr * invMb;
            if (significantOverlap) b.isSleeping = false;
          }

          const isMagneticAdhesion =
            (matA?.magneticSusceptibility ?? 0) > 0.5 && (matB?.magneticSusceptibility ?? 0) > 0.5;
          const isElectrostaticAdhesion =
            (Math.abs(a.netCharge) > 0.5 && (matB?.polarizability ?? 0) > 0.7) ||
            (Math.abs(b.netCharge) > 0.5 && (matA?.polarizability ?? 0) > 0.7);

          if (velAlongNormal < 0) {
            const e =
              isMagneticAdhesion || isElectrostaticAdhesion || Math.abs(velAlongNormal) < 0.2
                ? 0.0
                : Math.min(matA?.restitution ?? 0.2, matB?.restitution ?? 0.2);

            const jImp = (-(1 + e) * velAlongNormal) / invMSum;
            if (!a.isGrabbed && !a.isGrounded) {
              a.velocity[0] -= jImp * invMa * nx;
              a.velocity[1] -= jImp * invMa * ny;
              a.velocity[2] -= jImp * invMa * nz;
            }
            if (!b.isGrabbed && !b.isGrounded) {
              b.velocity[0] += jImp * invMb * nx;
              b.velocity[1] += jImp * invMb * ny;
              b.velocity[2] += jImp * invMb * nz;
            }
          }

          // 磁気・静電吸着時は減衰を強め、低速になったら双方を吸着静止ロックする
          if (isMagneticAdhesion || isElectrostaticAdhesion) {
            const relSpeedSq = rvx * rvx + rvy * rvy + rvz * rvz;
            const lockThresh = config.sleepVelocityThreshold * 2.5;
            if (relSpeedSq < lockThresh * lockThresh) {
              if (!a.isGrabbed && !a.isGrounded) {
                a.velocity = [0, 0, 0];
                a.isSleeping = true;
              }
              if (!b.isGrabbed && !b.isGrounded) {
                b.velocity = [0, 0, 0];
                b.isSleeping = true;
              }
            } else {
              if (!a.isGrabbed && !a.isGrounded) {
                a.velocity[0] *= 0.65;
                a.velocity[2] *= 0.65;
              }
              if (!b.isGrabbed && !b.isGrounded) {
                b.velocity[0] *= 0.65;
                b.velocity[2] *= 0.65;
              }
            }
          }
        }

        // マテリアル物性に基づく接触相互作用（摩擦帯電・導体分配・アース放電）
        this.applyMaterialContactInteraction(
          a,
          b,
          matA,
          matB,
          rvx,
          rvy,
          rvz,
          velAlongNormal,
          nx,
          ny,
          nz,
          dt,
          config,
        );
      }
    }

    // 3. 床面（机）接触と静止摩擦ロック（floorYが有限値の場合のみ適用）
    const floorY = config.floorY;
    for (const ent of entities) {
      if (ent.domainClass !== 'Visible' || ent.isGrabbed) continue;

      const mat = materials.get(ent.materialId);
      const halfH = ent.dimensions ? ent.dimensions[1] * 0.5 : ent.radius;
      if (Number.isFinite(floorY)) {
        const bottomY = ent.position[1] - halfH;

        if (bottomY <= floorY + 2e-3) {
          ent.position[1] = floorY + halfH;

          // 垂直方向の弾性エネルギー蓄積・塑性熱散逸・復元反発
          if (ent.velocity[1] < 0) {
            const impactSpeed = Math.abs(ent.velocity[1]);
            if (impactSpeed < 0.35) {
              ent.velocity[1] = 0;
            } else {
              const impactKE = 0.5 * ent.mass * impactSpeed * impactSpeed;
              const bondRatio = PhaseTransitionSolver.getEffectiveBondRatio(ent, mat);
              const objPlasticity = mat?.plasticity ?? 0.5;
              // 結合度が低下（熱軟化）するほどエネルギーが熱へ散逸し、液体(bondRatio=0)では反発ゼロになる
              const thermalSoftenedPlasticity = 1.0 - (1.0 - objPlasticity) * bondRatio;
              const plasticity = Math.max(thermalSoftenedPlasticity, 0.52);
              // 剛性は実効密度と電荷結合力から導出
              const elasticity = Math.max(0.05, PhaseTransitionSolver.getEffectiveRigidity(ent, mat));

              // 塑性・粘弾性散逸分は内部熱エネルギーへ変換
              ent.internalHeat += impactKE * plasticity * 0.25;

              // 弾性ポテンシャルエネルギーとして蓄積し、復元反発へ変換
              const storedElastic = impactKE * (1.0 - plasticity);
              ent.elasticEnergy = (ent.elasticEnergy ?? 0) + storedElastic;

              // 弾性率に応じた圧縮ひずみ δ/r を算出（柔らかいゴムほど大きく凹む）
              const strain = Math.min(
                0.32,
                Math.sqrt(storedElastic / Math.max(elasticity * ent.mass * 12.0, 0.1)),
              );
              ent.compression = Math.max(ent.compression ?? 0, strain);

              const reboundSpeed = Math.sqrt((2.0 * storedElastic) / Math.max(ent.mass, 1e-4));
              ent.velocity[1] = reboundSpeed < 0.05 ? 0 : reboundSpeed;
            }
          }

          // 水平方向の動摩擦減衰（液体・気体は摩擦が極めて小さい）
          const isFluid = ent.phaseState === 'liquid' || ent.phaseState === 'gas';
          const muD = isFluid ? 0.02 : (mat?.dynamicFriction ?? 0.45);
          const damping = Math.max(0, 1.0 - muD * 8.0 * dt);
          ent.velocity[0] *= damping;
          ent.velocity[2] *= damping;

          // 静止摩擦ロック判定（液体・気体は静止ロックしない）
          if (!isFluid) {
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
        }

        // 計算窓（空間グリッド境界）の内側にソフトに留める
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

    // 4. 連結グループ（電池＋極/セパレータ/－極 ＋ 導線・電球回路）の駆動とジュール発熱
    return this.solveBatteryCircuits(entities, materials, dt);
  }

  /**
   * 連結グループ（電池＋極・セパレータ・－極）と導線・電球回路の気圧落差電流を計算する
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

      // 1. セパレータの一方向電荷ポンプ作用：＋極と－極の間に気圧落差（電圧 V = ΔP_+ - ΔP_-）を維持
      const targetVoltage = 2.5;
      if (anode.netCharge < targetVoltage) {
        anode.netCharge += (targetVoltage - anode.netCharge) * Math.min(1, 10 * dt);
      }
      if (cathode.netCharge > -targetVoltage) {
        cathode.netCharge += (-targetVoltage - cathode.netCharge) * Math.min(1, 10 * dt);
      }

      // 2. 導線・電球パケットが閉回路として接続されているか判定
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
        // 回路全体の有効導電率から電流フラックス I を算出
        let minCond = 1.0;
        for (const n of circuitNodes) {
          const cond = materials.get(n.materialId)?.conductivity ?? 0.5;
          if (cond < minCond) minCond = cond;
        }
        const current = Math.max(0, voltage * minCond);
        totalCurrent += current;

        // 抵抗部（電球や導電率の低い導線）でジュール発熱 (I² R Δt) を生じ、化学エネルギーを消費
        const chemBurn = Math.min(chem, current * 0.25 * dt);
        sep.chemicalEnergy = chem - chemBurn;
        for (const n of circuitNodes) {
          const cond = materials.get(n.materialId)?.conductivity ?? 0.5;
          const resistance = Math.max(0.05, 1.0 - cond);
          n.internalHeat += current * current * resistance * dt * 1.5;
        }
        // 化学エネルギーが枯渇したら電圧も自然減衰
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
   * 接触ペアにおける摩擦帯電・発熱・導体分配・アース接地を処理する
   */
  private applyMaterialContactInteraction(
    a: SpaceEntity,
    b: SpaceEntity,
    matA: MaterialSpec | undefined,
    matB: MaterialSpec | undefined,
    rvx: number,
    rvy: number,
    rvz: number,
    velAlongNormal: number,
    nx: number,
    ny: number,
    nz: number,
    dt: number,
    config: SpaceCoreConfig,
  ): void {
    if (!matA || !matB) return;

    // 1. 接線相対速度の算出
    const tvx = rvx - velAlongNormal * nx;
    const tvy = rvy - velAlongNormal * ny;
    const tvz = rvz - velAlongNormal * nz;
    const tangentSpeed = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);

    // 2. 定在波の檻 E_trap_max = ΔP_⊥ * M(λ_A, λ_B, U_0A, U_0B) - γ U_vib と冷間圧接・摩擦帯電
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
      const normalPressure = Math.max(0.2, Math.abs(velAlongNormal) + 0.5);
      const trapMax = Math.max(0.05, normalPressure * resonanceM - 0.12 * totalHeat);

      const kinTangent = 0.5 * Math.min(a.mass, b.mass) * tangentSpeed * tangentSpeed;
      if (kinTangent <= trapMax) {
        // 定在波の檻に捕獲：エネルギーを蓄積し、微量の散逸熱を発生
        a.trapEnergyStored = (a.trapEnergyStored ?? 0) + kinTangent * 0.2 * dt;
        b.trapEnergyStored = (b.trapEnergyStored ?? 0) + kinTangent * 0.2 * dt;
        a.internalHeat += 0.01 * tangentSpeed * dt;
        b.internalHeat += 0.01 * tangentSpeed * dt;
      } else {
        // 限界突破（決壊）：蓄積エネルギーを摩擦熱 U_vib へ一気に解放し動摩擦へ移行
        const releasedTrap = (a.trapEnergyStored ?? 0) + (b.trapEnergyStored ?? 0);
        a.trapEnergyStored = 0;
        b.trapEnergyStored = 0;
        const heat = (0.05 * tangentSpeed + releasedTrap * 0.5) * dt + releasedTrap * 0.25;
        a.internalHeat += heat;
        b.internalHeat += heat;
      }

      if (minCond < 0.35 && !a.isGrounded && !b.isGrounded) {
        const deltaAffinity = matA.electronAffinity - matB.electronAffinity;
        const dq = config.triboRate * deltaAffinity * tangentSpeed * dt;
        // 電子親和力が高い方が電子を奪って負に帯電する（総電荷保存則）
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

    // 4. 導体同士の接触による電荷分配（容量=半径比で同電位化）
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

  /**
   * 形状（box / sheet / sphere 等）に応じた接触法線とめり込み量を算出する
   */
  private computeContactGeometry(
    a: SpaceEntity,
    b: SpaceEntity,
  ): { nx: number; ny: number; nz: number; overlap: number } {
    const aIsBox = (a.shape === 'box' || a.shape === 'sheet') && a.dimensions;
    const bIsBox = (b.shape === 'box' || b.shape === 'sheet') && b.dimensions;

    // 片方が大型ボックス（冷蔵庫や板など）の場合は AABB 最近接点で判定
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
