import type { SpacePacketGrid } from './SpacePacketGrid';
import type {
  AmbientMediumSpec,
  CoreStepMetrics,
  MaterialSpec,
  SpaceCoreConfig,
  SpaceEntity,
  Vec3,
} from './types';

/**
 * 空間演算バックエンド抽象化インターフェース（ISpatialComputeBackend）
 * 将来的な WebGPU / Rust-WASM / 量子テンソルネットワーク（MERA）バックエンドへの
 * 差し替えを見据えて、空間場・媒質場演算ステップを疎結合化する。
 * @see DATA_FLOW.md §1
 */
export interface ISpatialComputeBackend {
  readonly backendName: string;

  /**
   * 真空チャネルおよび媒質チャネルの 1 ステップを実行する
   */
  executeFieldAndMediumStep(
    grid: SpacePacketGrid,
    entities: SpaceEntity[],
    materials: ReadonlyMap<string, MaterialSpec>,
    backgroundField: Vec3,
    rawDt: number,
    config: SpaceCoreConfig,
    medium?: AmbientMediumSpec,
  ): CoreStepMetrics;

  /**
   * バックエンド内部状態をリセットする
   */
  reset(): void;
}
