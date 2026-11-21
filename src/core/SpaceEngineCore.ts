import { BoundaryProjector } from './BoundaryProjector';
import { ContactSolver } from './ContactSolver';
import { CpuTypedArrayBackend } from './CpuTypedArrayBackend';
import { DualPacketizer } from './DualPacketizer';
import type { ISpatialComputeBackend } from './ISpatialComputeBackend';
import { NestedPerceptualStack } from './NestedPerceptualStack';
import { PerceptualScaler } from './PerceptualScaler';
import { PhaseTransitionSolver } from './PhaseTransitionSolver';
import { SpacePacketGrid } from './SpacePacketGrid';
import type {
  AmbientMediumSpec,
  CoreStepMetrics,
  InjectorBrushMode,
  MaterialSpec,
  ObserverState,
  ProjectedExternalSource,
  SpaceCoreConfig,
  SpaceEntity,
  Vec3,
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
  private readonly nestedStack: NestedPerceptualStack;

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
    this.nestedStack = new NestedPerceptualStack(config.cellSize, config.center);
  }

  /**
   * 空間場を真空基準へリセットする
   */
  public resetField(): void {
    this.grid.reset();
    this.dualPacketizer.reset();
    this.nestedStack.reset(this.config.cellSize, this.config.center);
    this.backend.reset();
  }

  public getNestedStack(): NestedPerceptualStack {
    return this.nestedStack;
  }

  public getBackend(): ISpatialComputeBackend {
    return this.backend;
  }

  public injectBrush(
    worldPos: Vec3,
    radius: number,
    mode: InjectorBrushMode,
    strength = 1.0,
    mediaCatalog?: ReadonlyMap<string, AmbientMediumSpec>,
  ): void {
    this.backend.injectBrush(this.grid, worldPos, radius, mode, strength, mediaCatalog);
  }

  public evaluateLightInteraction(
    material: MaterialSpec | undefined,
    lightFrequency: number,
  ): { transmittance: number; reflectance: number; absorption: number } {
    return this.backend.evaluateLightInteraction(material, lightFrequency);
  }

  public evaluateHollowTransmissionAndPermeation(
    shellZ: number,
    innerZ: number,
    gapSpacing: number,
    particleHardRadius: number,
  ): { waveTransmittance: number; canPermeate: boolean } {
    return this.backend.evaluateHollowTransmissionAndPermeation(
      shellZ,
      innerZ,
      gapSpacing,
      particleHardRadius,
    );
  }

  public evaluateQuantumTunneling(
    barrierHeight: number,
    particleEnergy: number,
    barrierWidth: number,
    scaleL: number,
  ): number {
    return this.backend.evaluateQuantumTunneling(
      barrierHeight,
      particleEnergy,
      barrierWidth,
      scaleL,
    );
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
    mediaCatalog?: ReadonlyMap<string, AmbientMediumSpec>,
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

      // 吸収された背景エネルギーを空間パケットの内部振動エネルギー U_vib へ還元
      if (scaleRes.absorbedEnergyDelta > 0) {
        let interiorCount = 0;
        for (let i = 0; i < this.grid.count; i++) {
          if (this.grid.isBoundary[i] === 0) interiorCount++;
        }
        if (interiorCount > 0) {
          const perCell = scaleRes.absorbedEnergyDelta / interiorCount;
          for (let i = 0; i < this.grid.count; i++) {
            if (this.grid.isBoundary[i] === 0) {
              this.grid.vibrationEnergy[i] += perCell;
            }
          }
        }
      }

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
      activeEntities = this.dualPacketizer.synchronize(
        activeEntities,
        scaleRes.cellSize,
        materials,
      );
    }

    // 2. 境界シェル射影（Projected 領域からの重力・遠方ポテンシャル焼き付け）
    const backgroundField = this.boundaryProjector.project(this.grid, combinedExternalSources);
    const effectiveFrameDt = Math.min(Math.max(rawDt, 1e-5), this.config.maxFrameDt ?? 0.05);

    // 2.5 階層跨ぎハンドオフ（窓外流出 Co-Pack 追跡 ＆ 窓内復帰 Unpack）
    if (observer || this.nestedStack.getHandedOffCount() > 0) {
      activeEntities = this.nestedStack.synchronizeHandoff(
        activeEntities,
        this.grid,
        backgroundField,
        effectiveFrameDt,
      );
    }

    // 3. 空間場更新（ISpatialComputeBackend 経由で真空チャネル + 媒質チャネルを実行）
    const metrics = this.backend.executeFieldAndMediumStep(
      this.grid,
      activeEntities,
      materials,
      backgroundField,
      rawDt,
      this.config,
      medium,
      mediaCatalog,
    );

    // 3.5 複数レイヤー入れ子知覚スタック更新（時間間引き・10^-6mデカップリング・双方向カスケード）
    const layerSnapshots = this.nestedStack.stepStack(
      this.grid,
      backgroundField,
      effectiveFrameDt,
      medium,
    );

    // 4. 不可侵バリア・定在波の檻摩擦・電池連結グループ回路解決
    const circuitCurrent = this.contactSolver.solve(
      activeEntities,
      materials,
      effectiveFrameDt,
      this.config,
    );

    // 5. エンティティ ⇄ 空間パケット間の双方向熱交換フラックス（C_med == 0 の真空では断熱）
    this.exchangeThermalEnergyWithGrid(activeEntities, effectiveFrameDt);

    // 6. 相転移（連続秩序度 Ψ ∈ [0, 1]）・燃焼・気化集合体分散と場↔実体双方向変換
    activeEntities = this.phaseSolver.solve(
      activeEntities,
      materials,
      effectiveFrameDt,
      medium,
      this.grid,
    );
    const condensed = this.phaseSolver.condenseFromField(this.grid, materials, activeEntities);
    if (condensed.length > 0) {
      activeEntities = [...activeEntities, ...condensed];
    }

    return {
      metrics: {
        ...metrics,
        circuitCurrent,
        layerSnapshots,
        handedOffEntityCount: this.nestedStack.getHandedOffCount(),
        condensedEntityCount: condensed.length,
      },
      entities: activeEntities,
    };
  }

  /**
   * エンティティの内部熱エネルギーと周囲空間パケット U_vib との双方向熱交換（真空 C_med=0 では断熱）
   */
  private exchangeThermalEnergyWithGrid(entities: SpaceEntity[], dt: number): void {
    for (const ent of entities) {
      if (ent.domainClass !== 'Visible') continue;
      const [gx, gy, gz] = this.grid.worldToGrid(ent.position);
      const ix = Math.max(1, Math.min(this.grid.nx - 2, Math.round(gx)));
      const iy = Math.max(1, Math.min(this.grid.ny - 2, Math.round(gy)));
      const iz = Math.max(1, Math.min(this.grid.nz - 2, Math.round(gz)));
      const idx = this.grid.index(ix, iy, iz);

      const cMed = this.grid.mediumConcentration[idx];
      if (cMed <= 1e-4) continue; // 真空断熱

      const packetHeat = this.grid.vibrationEnergy[idx];
      const fluxCoeff = Math.min(0.4, 0.25 * cMed * dt);
      const deltaQ = (packetHeat - ent.internalHeat) * fluxCoeff;
      if (Math.abs(deltaQ) > 1e-7) {
        ent.internalHeat = Math.max(0, ent.internalHeat + deltaQ);
        this.grid.vibrationEnergy[idx] = Math.max(0, packetHeat - deltaQ);
        this.grid.isSleeping[idx] = 0;
      }
    }
  }
}
