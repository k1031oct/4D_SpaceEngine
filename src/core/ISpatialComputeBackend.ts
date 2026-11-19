import type { SpacePacketGrid } from './SpacePacketGrid';
import type {
  AmbientMediumSpec,
  CoreStepMetrics,
  InjectorBrushMode,
  MaterialSpec,
  SpaceCoreConfig,
  SpaceEntity,
  Vec3,
} from './types';

/**
 * 空間演算バックエンド抽象化インターフェース（ISpatialComputeBackend）
 * 将来的な WebGPU / Rust-WASM / 量子テンソルネットワーク（MERA）バックエンドへの
 * 差し替えを見据えて、空間場・媒質場・光学・トンネル演算をすべて抽象化する。
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
    mediaCatalog?: ReadonlyMap<string, AmbientMediumSpec>,
  ): CoreStepMetrics;

  /**
   * 任意地点へ気体・熱・光パルスを注入するインジェクターブラシ
   */
  injectBrush(
    grid: SpacePacketGrid,
    worldPos: Vec3,
    radius: number,
    mode: InjectorBrushMode,
    strength?: number,
    mediaCatalog?: ReadonlyMap<string, AmbientMediumSpec>,
  ): void;

  /**
   * 空間媒質のベースラインを同期する
   */
  syncMediumBaseline(grid: SpacePacketGrid, medium: AmbientMediumSpec): void;

  /**
   * 光波とマテリアルの連続相互作用（ローレンツ振動子複素屈折率モデル）を評価する
   */
  evaluateLightInteraction(
    material: MaterialSpec | undefined,
    lightFrequency: number,
  ): { transmittance: number; reflectance: number; absorption: number };

  /**
   * 中空構造の空間インピーダンス透過とサイズ選別浸透を評価する
   */
  evaluateHollowTransmissionAndPermeation(
    shellZ: number,
    innerZ: number,
    gapSpacing: number,
    particleHardRadius: number,
  ): { waveTransmittance: number; canPermeate: boolean };

  /**
   * 極小スケールでの量子トンネル波動透過率を評価する
   */
  evaluateQuantumTunneling(
    barrierHeight: number,
    particleEnergy: number,
    barrierWidth: number,
    scaleL: number,
  ): number;

  /**
   * バックエンド内部状態をリセットする
   */
  reset(): void;
}
