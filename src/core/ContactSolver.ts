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
  ): void {
    // 1. 位置積分（スリープ中・操作中でない物体）
    for (const ent of entities) {
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

        const dx = b.position[0] - a.position[0];
        const dy = b.position[1] - a.position[1];
        const dz = b.position[2] - a.position[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        const minDist = a.radius + b.radius;

        if (distSq >= minDist * minDist) continue;

        const dist = Math.sqrt(Math.max(distSq, 1e-10));
        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;
        const overlap = minDist - dist;

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
          if (!a.isGrabbed && !a.isGrounded) {
            a.position[0] -= nx * corr * invMa;
            a.position[1] -= ny * corr * invMa;
            a.position[2] -= nz * corr * invMa;
            a.isSleeping = false;
          }
          if (!b.isGrabbed && !b.isGrounded) {
            b.position[0] += nx * corr * invMb;
            b.position[1] += ny * corr * invMb;
            b.position[2] += nz * corr * invMb;
            b.isSleeping = false;
          }

          if (velAlongNormal < 0) {
            const isElectrostaticAdhesion =
              (Math.abs(a.netCharge) > 0.5 && (matB?.polarizability ?? 0) > 0.7) ||
              (Math.abs(b.netCharge) > 0.5 && (matA?.polarizability ?? 0) > 0.7);
            const e =
              isElectrostaticAdhesion || Math.abs(velAlongNormal) < 0.2
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
      if (Number.isFinite(floorY)) {
        const bottomY = ent.position[1] - ent.radius;

        if (bottomY <= floorY + 1e-4) {
          ent.position[1] = floorY + ent.radius;

          // 垂直方向のマイクロバウンス抑制
          if (ent.velocity[1] < 0) {
            const e = Math.abs(ent.velocity[1]) < 0.25 ? 0.0 : (mat?.restitution ?? 0.15);
            ent.velocity[1] = Math.abs(ent.velocity[1]) * e;
            if (Math.abs(ent.velocity[1]) < 0.05) {
              ent.velocity[1] = 0;
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

    // 2. 摩擦帯電（少なくとも一方が絶縁性であり、接線滑りが生じている場合）
    const minCond = Math.min(matA.conductivity, matB.conductivity);
    if (tangentSpeed > 0.02) {
      const heat = 0.05 * tangentSpeed * dt;
      a.internalHeat += heat;
      b.internalHeat += heat;

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
}
