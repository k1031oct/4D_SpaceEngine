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
   * エンティティの現在の相状態に応じた実効密度を返す
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
    return baseDensity;
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

      // 1. 酸化還元による燃焼反応（酸素あり・発火点超過・残燃料あり）
      const fuel = ent.fuelRemaining ?? 1.0;
      if (
        oxidizer > 0.05 &&
        mat.ignitionHeat !== undefined &&
        ent.internalHeat >= mat.ignitionHeat &&
        fuel > 0.01
      ) {
        ent.isBurning = true;
        const consumed = Math.min(fuel, 0.15 * dt);
        ent.fuelRemaining = fuel - consumed;
        const heatGain = (mat.combustionEnergy ?? 10.0) * oxidizer * dt * 2.5;
        ent.internalHeat += heatGain;
        ent.isSleeping = false;

        // 燃焼による空間膨張圧と熱振動を周囲パケットへ注入（上昇気流・光波の創発）
        if (grid) {
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

      // 3. 結合エネルギー閾値に基づく相状態判定
      const prevPhase: PhaseState = ent.phaseState ?? 'solid';
      let nextPhase: PhaseState = 'solid';
      if (ent.internalHeat >= mat.bindingEnergy * 2.5) {
        nextPhase = 'gas';
      } else if (ent.internalHeat >= mat.bindingEnergy) {
        nextPhase = 'liquid';
      }
      ent.phaseState = nextPhase;

      if (nextPhase !== prevPhase && (nextPhase === 'liquid' || nextPhase === 'gas')) {
        ent.isSleeping = false;
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

      // 5. 気化分散 または 弾性限界超過（elasticEnergy > bindingEnergy）による結合破断
      if (nextPhase === 'gas' && !ent.isVaporParticle && ent.radius > 0.08 && !ent.isGrabbed) {
        const dispersed = this.disperseIntoVaporCluster(ent);
        nextEntities.push(...dispersed);
      } else if (
        (ent.elasticEnergy ?? 0) > mat.bindingEnergy &&
        !ent.isVaporParticle &&
        ent.radius > 0.08 &&
        !ent.isGrabbed
      ) {
        // 弾性エネルギーが結合エネルギーを超過：結合破断し2つの破片へ分裂
        const fragments = this.fractureEntity(ent);
        nextEntities.push(...fragments);
      } else {
        nextEntities.push(ent);
      }
    }

    return nextEntities;
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
}
