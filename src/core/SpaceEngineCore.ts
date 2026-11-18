import { BoundaryProjector } from './BoundaryProjector';
import { ContactSolver } from './ContactSolver';
import { DualPacketizer } from './DualPacketizer';
import { FieldSolver } from './FieldSolver';
import { PerceptualScaler } from './PerceptualScaler';
import { PhaseTransitionSolver } from './PhaseTransitionSolver';
import { SpacePacketGrid } from './SpacePacketGrid';
import type {
  AmbientMediumSpec,
  CoreStepMetrics,
  MaterialSpec,
  ObserverState,
  ProjectedExternalSource,
  SpaceCoreConfig,
  SpaceEntity,
} from './types';

/**
 * 空間演算エンジンコア（SpaceEngineCore）
 * プラットフォーム非依存のファサードとして、1フレーム分の全演算ステップを統括する。
 * @see DATA_FLOW.md §3.1
 */
export class SpaceEngineCore {
  public readonly grid: SpacePacketGrid;
  public config: SpaceCoreConfig;

  private readonly perceptualScaler = new PerceptualScaler();
  private readonly dualPacketizer = new DualPacketizer();
  private readonly boundaryProjector = new BoundaryProjector();
  private readonly fieldSolver = new FieldSolver();
  private readonly contactSolver = new ContactSolver();
  private readonly phaseSolver = new PhaseTransitionSolver();
  private absorbedBackgroundEnergy = 0;

  constructor(config: SpaceCoreConfig) {
    this.config = config;
    this.grid = new SpacePacketGrid(
      config.nx,
      config.ny,
      config.nz,
      config.cellSize,
      config.center,
    );
  }

  /**
   * 空間場を真空基準へリセットする
   */
  public resetField(): void {
    this.grid.reset();
    this.dualPacketizer.reset();
    this.absorbedBackgroundEnergy = 0;
  }

  /**
   * 1ステップ演算を実行する
   * @param entities エンティティ配列（Pack/Unpack により更新される場合がある）
   * @param materials マテリアル辞書
   * @param externalSources 明示的な外部射影ソース
   * @param rawDt 経過時間
   * @param observer 観測者状態（指定時は知覚スケーリングと双対パケッティングを実行）
   */
  public step(
    entities: SpaceEntity[],
    materials: ReadonlyMap<string, MaterialSpec>,
    externalSources: readonly ProjectedExternalSource[],
    rawDt: number,
    observer?: ObserverState,
    medium?: AmbientMediumSpec,
  ): { metrics: CoreStepMetrics; entities: SpaceEntity[] } {
    let activeEntities = entities;
    let combinedExternalSources = [...externalSources];

    // 1. 知覚スケーリング & 3領域分類 & 双対パケッティング（Phase 3）
    if (observer) {
      const scaleRes = this.perceptualScaler.evaluate(
        observer,
        activeEntities,
        this.config.nx,
        this.config.cellSize,
      );
      this.absorbedBackgroundEnergy += scaleRes.absorbedEnergyDelta;

      // スケール変化時は保存則リメッシュ
      this.grid.remesh(scaleRes.cellSize, scaleRes.windowCenter);
      this.config = {
        ...this.config,
        cellSize: scaleRes.cellSize,
        center: scaleRes.windowCenter,
      };

      // Projected エンティティからの自動射影ソースを統合
      if (scaleRes.autoProjectedSources.length > 0) {
        combinedExternalSources = [...combinedExternalSources, ...scaleRes.autoProjectedSources];
      }

      // 空間パケットサイズとオブジェクトの Pack/Unpack 同期
      activeEntities = this.dualPacketizer.synchronize(activeEntities, scaleRes.cellSize);
    }

    // 2. 境界シェル射影（Projected 領域からの重力・遠方ポテンシャル焼き付け）
    const backgroundField = this.boundaryProjector.project(this.grid, combinedExternalSources);

    // 3. 空間場更新（ソース注入・ポアソン緩和・渦度・散逸・遠隔力積分・媒質効果）
    const metrics = this.fieldSolver.solve(
      this.grid,
      activeEntities,
      materials,
      backgroundField,
      rawDt,
      this.config,
      medium,
    );

    // 4. サブグリッド接触・静止摩擦ロック解決
    const effectiveFrameDt = Math.min(Math.max(rawDt, 1e-5), 0.05);
    this.contactSolver.solve(activeEntities, materials, effectiveFrameDt, this.config);

    // 5. 相転移（固体/液体/気体）・燃焼・気化集合体分散と環境熱緩和
    activeEntities = this.phaseSolver.solve(
      activeEntities,
      materials,
      effectiveFrameDt,
      medium,
      this.grid,
    );

    return {
      metrics: {
        ...metrics,
        totalEnergy: metrics.totalEnergy + this.absorbedBackgroundEnergy,
      },
      entities: activeEntities,
    };
  }
}
