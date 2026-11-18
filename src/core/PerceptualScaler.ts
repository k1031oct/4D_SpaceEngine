import type {
  ObserverState,
  ProjectedExternalSource,
  SpaceEntity,
  Vec3,
} from './types';

export interface PerceptualClassificationResult {
  readonly cellSize: number;
  readonly windowCenter: Vec3;
  readonly autoProjectedSources: ProjectedExternalSource[];
  readonly absorbedEnergyDelta: number;
}

/**
 * 知覚駆動型動的スケーリング器（Perceptual Scaler）
 * 第4の空間軸である「知覚スケール（log10 L）」を観測者の距離・速度・ズームから決定し、
 * 全エンティティを Visible / Projected / Absorbed の3領域へ自動分類する。
 * @see 4d_scale_space_engine.md §2.2, §2.4
 */
export class PerceptualScaler {
  /**
   * 知覚スケール L_base を算出し、全エンティティを3領域に分類する
   */
  public evaluate(
    observer: ObserverState,
    entities: SpaceEntity[],
    gridCellsPerAxis: number,
    baseCellSize: number,
  ): PerceptualClassificationResult {
    // 1. 基準パケットサイズ L_base の決定
    let cellSize = baseCellSize;

    if (observer.manualScaleLog10 !== null) {
      cellSize = Math.pow(10, observer.manualScaleLog10);
    } else {
      // 運動速度制約 L_vel = |v| * τ
      const speed = Math.sqrt(
        observer.velocity[0] * observer.velocity[0] +
          observer.velocity[1] * observer.velocity[1] +
          observer.velocity[2] * observer.velocity[2],
      );
      const lVel = speed * observer.tau;

      // 近接支配オブジェクト制約 L_obj
      let lObj = baseCellSize;
      let minScore = Infinity;
      for (const ent of entities) {
        const dx = ent.position[0] - observer.focusPoint[0];
        const dy = ent.position[1] - observer.focusPoint[1];
        const dz = ent.position[2] - observer.focusPoint[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const score = dist / Math.max(ent.radius, 1e-4);
        if (score < minScore) {
          minScore = score;
          lObj = Math.max(0.01, ent.radius * 1.2);
        }
      }
      cellSize = Math.max(lObj, lVel, 0.01);
    }

    const windowCenter: Vec3 = [...observer.focusPoint];
    const halfExtent = 0.5 * gridCellsPerAxis * cellSize;
    const autoProjectedSources: ProjectedExternalSource[] = [];
    let absorbedEnergyDelta = 0;

    // 2. 全エンティティの3領域分類（Visible / Projected / Absorbed）
    for (const ent of entities) {
      // クラスター化された子要素自体はパケッタイザが管理するためここではスキップ
      if (ent.packedIntoId) continue;

      const dx = ent.position[0] - windowCenter[0];
      const dy = ent.position[1] - windowCenter[1];
      const dz = ent.position[2] - windowCenter[2];
      const distFromCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // (a) Absorbed: 現在の空間パケットより極端に小さいミクロ要素
      if (ent.radius < cellSize * 0.06) {
        ent.domainClass = 'Absorbed';
        const v2 =
          ent.velocity[0] * ent.velocity[0] +
          ent.velocity[1] * ent.velocity[1] +
          ent.velocity[2] * ent.velocity[2];
        absorbedEnergyDelta += 0.5 * ent.mass * v2 + ent.internalHeat;
        continue;
      }

      // (b) Projected: 計算窓からはみ出る巨大オブジェクト、または窓外の遠方オブジェクト
      const isOutsideWindow =
        Math.abs(dx) > halfExtent * 1.1 ||
        Math.abs(dy) > halfExtent * 1.1 ||
        Math.abs(dz) > halfExtent * 1.1;
      const isTooHugeForWindow = ent.radius > halfExtent * 0.75;

      if (isOutsideWindow || isTooHugeForWindow) {
        ent.domainClass = 'Projected';

        // 巨大天体（地球など）が計算窓の外にある場合、境界シェルへ重力・電場勾配を射影
        if (ent.gravityStrength && ent.gravityStrength !== 0 && distFromCenter > 1e-4) {
          // 計算窓中心から天体方向 (dx, dy, dz) への重力加速度ベクトル g = G*M / r^3 * (ent - windowCenter)
          const invR3 = ent.gravityStrength / (distFromCenter * distFromCenter * distFromCenter);
          autoProjectedSources.push({
            id: `proj_grav_${ent.id}`,
            uniformField: [dx * invR3, dy * invR3, dz * invR3],
          });
        }
        if (Math.abs(ent.netCharge) > 1e-4) {
          autoProjectedSources.push({
            id: `proj_charge_${ent.id}`,
            position: [...ent.position],
            strength: ent.netCharge,
          });
        }
        continue;
      }

      // (c) Visible: 空間パケット内で直接相互作用を行う実体
      ent.domainClass = 'Visible';
    }

    return {
      cellSize,
      windowCenter,
      autoProjectedSources,
      absorbedEnergyDelta,
    };
  }
}
