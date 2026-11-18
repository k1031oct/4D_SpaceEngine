import type { SpacePacketGrid } from './SpacePacketGrid';

export interface SimilarityInsight {
  readonly scaleRegimeLabel: string;
  readonly dominantPhenomenon: string;
  readonly microAnalogy: string;
  readonly macroAnalogy: string;
  readonly sharedEquation: string;
  readonly peakPhi: number;
  readonly peakVorticity: number;
}

/**
 * 相似性比較インスペクター解析器（Similarity Analyzer）
 * 現在の知覚スケール log10(L) と空間パケット網の活性状態から、
 * ミクロ現象とマクロ現象のフラクタル相似性を抽出する。
 * @see 4d_scale_space_engine.md §6 Phase 4
 */
export class SimilarityAnalyzer {
  public analyze(grid: SpacePacketGrid): SimilarityInsight {
    const log10L = Math.log10(Math.max(grid.cellSize, 1e-12));

    let peakPhi = 0;
    let peakVort = 0;
    for (let i = 0; i < grid.count; i++) {
      const ap = Math.abs(grid.phi[i]);
      if (ap > peakPhi) peakPhi = ap;
      const w = Math.sqrt(
        grid.wx[i] * grid.wx[i] + grid.wy[i] * grid.wy[i] + grid.wz[i] * grid.wz[i],
      );
      if (w > peakVort) peakVort = w;
    }

    let scaleRegimeLabel = '日常・実験室スケール (10⁻²〜10⁰ m)';
    if (log10L < -1.5) {
      scaleRegimeLabel = 'ミクロ・分子スケール (< 10⁻¹.⁵ m)';
    } else if (log10L > 0.5) {
      scaleRegimeLabel = 'マクロ・惑星/宇宙スケール (> 10⁰.⁵ m)';
    }

    let dominantPhenomenon = '静穏真空（ε-Cutoff 収束状態）';
    let microAnalogy = '基底真空のゼロ点揺らぎ';
    let macroAnalogy = '平穏な星間空間';
    let sharedEquation = '∇²Φ = 0,  ∂P/∂t = 0';

    if (peakVort > peakPhi * 0.6 && peakVort > 0.05) {
      dominantPhenomenon = '渦度循環支配（回転・磁気勾配）';
      microAnalogy = '電子スピン・ローレンツ力・磁気双極子';
      macroAnalogy = '惑星磁場・コリオリ力・銀河降着円盤の渦';
      sharedEquation = '∂ω/∂t = ∇×P + D∇²ω,  F ∝ ∇|ω|²';
    } else if (peakPhi > 0.05) {
      dominantPhenomenon = '気圧偏差支配（ポアソン勾配・引力/斥力）';
      microAnalogy = '静電クーロン場・摩擦帯電・誘電分極';
      macroAnalogy = '万有引力ポテンシャル・潮汐力・重力レンズ';
      sharedEquation = '∂Φ/∂t = D∇²Φ + S_Φ,  F ∝ -q∇Φ';
    }

    return {
      scaleRegimeLabel,
      dominantPhenomenon,
      microAnalogy,
      macroAnalogy,
      sharedEquation,
      peakPhi,
      peakVorticity: peakVort,
    };
  }
}
