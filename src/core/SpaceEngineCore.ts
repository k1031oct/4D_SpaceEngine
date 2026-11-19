import { BoundaryProjector } from './BoundaryProjector';
import { ContactSolver } from './ContactSolver';
import { CpuTypedArrayBackend } from './CpuTypedArrayBackend';
import { DualPacketizer } from './DualPacketizer';
import type { FieldSolver } from './FieldSolver';
import type { ISpatialComputeBackend } from './ISpatialComputeBackend';
import type { MediumFluxSolver } from './MediumFluxSolver';
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
 * プラットフォーム非依存のファサードとして、ISpatialComputeBackend 経由で1フレーム分の全演算ステップを統括する。
 * @see DATA_FLOW.md §3.1
 */
export class SpaceEngineCore {
  public readonly grid: SpacePacketGrid;
  public config: SpaceCoreConfig;

  private readonly backend: ISpatialComputeBackend;
  private readonly perceptualScaler = new PerceptualScaler();
  private readonly dualPacketizer = new DualPacketizer();
  private readonly boundaryProjector = new BoundaryProjector();
  private readonly contactSolver = new ContactSolver();
  private readonly phaseSolver = new PhaseTransitionSolver();
  private absorbedBackgroundEnergy = 0;

  constructor(config: SpaceCoreConfig, backend: ISpatialComputeBackend = new CpuTypedArrayBackend()) {
    this.config = config;
    this.backend = backend;
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
    this.backend.reset();
    this.absorbedBackgroundEnergy = 0;
  }

  public getBackend(): ISpatialComputeBackend {
    return this.backend;
  }

  public getMediumSolver(): MediumFluxSolver {
    if (this.backend instanceof CpuTypedArrayBackend) {
      return this.backend.mediumSolver;
    }
    throw new Error('Current backend does not expose CpuTypedArrayBackend mediumSolver');
  }

  public getFieldSolver(): FieldSolver {
    if (this.backend instanceof CpuTypedArrayBackend) {
      return this.backend.fieldSolver;
    }
    throw new Error('Current backend does not expose CpuTypedArrayBackend fieldSolver');
  }

  public getPhaseSolver(): PhaseTransitionSolver {
    return this.phaseSolver;
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
        this.config.gravitationalConstant,
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

    // 3. 空間場更新（ISpatialComputeBackend 経由で真空チャネル + 媒質チャネルを実行）
    const metrics = this.backend.executeFieldAndMediumStep(
      this.grid,
      activeEntities,
      materials,
      backgroundField,
      rawDt,
      this.config,
      medium,
    );
    const effectiveFrameDt = Math.min(Math.max(rawDt, 1e-5), 0.05);

    // 4. 不可侵バリア・定在波の檻摩擦・電池連結グループ回路解決
    const circuitCurrent = this.contactSolver.solve(
      activeEntities,
      materials,
      effectiveFrameDt,
      this.config,
    );

    // 5. 相転移（連続秩序度 Ψ ∈ [0, 1]）・燃焼・気化集合体分散と環境熱緩和
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
        circuitCurrent,
        totalEnergy: metrics.totalEnergy + this.absorbedBackgroundEnergy,
      },
      entities: activeEntities,
    };
  }
}
