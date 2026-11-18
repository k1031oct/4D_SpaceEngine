import type { AmbientMediumSpec, MaterialSpec, PhaseState, SpaceEntity } from './types';

/**
 * 相転移・熱緩和ソルバ（Phase Transition Solver）
 * 内部熱エネルギー (internalHeat) と結合エネルギー (bindingEnergy) の比較から
 * 固体 (solid) ↔ 液体 (liquid) ↔ 気体 (gas) の状態変化を決定し、
 * 相に応じた実効密度を算出して浮力・流動性・磁性の変化を創発させる。
 * @see 4d_scale_space_engine.md §3
 */
export class PhaseTransitionSolver {
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
      // 気化による体積膨張・低密度化（標準大気 0.0012 より軽くなり上昇対流を生む）
      return Math.max(1e-4, baseDensity * 0.0006);
    }
    return baseDensity;
  }

  /**
   * 全 Visible エンティティの相状態更新および環境温度への緩やかな放熱を行う
   */
  public solve(
    entities: SpaceEntity[],
    materials: ReadonlyMap<string, MaterialSpec>,
    dt: number,
    medium?: AmbientMediumSpec,
  ): void {
    const ambientHeat = medium?.ambientHeat ?? 0.05;
    // 液体/気体は媒質との熱交換が少し速く、真空中は断熱（放熱ほぼゼロ）
    const baseCooling = medium && medium.density === 0 ? 0.002 : 0.03;

    for (const ent of entities) {
      if (ent.domainClass !== 'Visible') continue;
      const mat = materials.get(ent.materialId);
      if (!mat) continue;

      // 1. 環境温度への緩やかな熱緩和
      if (!ent.isGrabbed) {
        ent.internalHeat += (ambientHeat - ent.internalHeat) * Math.min(1.0, baseCooling * dt);
        if (ent.internalHeat < 0) ent.internalHeat = 0;
      }

      // 2. 結合エネルギー閾値に基づく相状態判定
      const prevPhase: PhaseState = ent.phaseState ?? 'solid';
      let nextPhase: PhaseState = 'solid';
      if (ent.internalHeat >= mat.bindingEnergy * 2.5) {
        nextPhase = 'gas';
      } else if (ent.internalHeat >= mat.bindingEnergy) {
        nextPhase = 'liquid';
      }
      ent.phaseState = nextPhase;

      // 相変化が起きた場合（特に液化・気化）は静止摩擦ロックを解除して流動化
      if (nextPhase !== prevPhase && (nextPhase === 'liquid' || nextPhase === 'gas')) {
        ent.isSleeping = false;
      }

      // 3. 高温（液体・気体）では熱擾乱により強磁性スピン秩序が崩壊（キュリー点効果）
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
    }
  }
}
