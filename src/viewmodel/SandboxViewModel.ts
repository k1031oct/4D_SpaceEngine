import { SimilarityAnalyzer } from '../core/SimilarityAnalyzer';
import { SpaceEngineCore } from '../core/SpaceEngineCore';
import type {
  DebugOverlayMode,
  InjectorBrushMode,
  MediumId,
  ObserverState,
  PresetId,
  SpaceEntity,
  Vec3,
} from '../core/types';
import { SpaceStateRepository } from '../data/SpaceStateRepository';
import type { EntityRenderSnapshot, SandboxUiState } from './SandboxUiState';

export interface CustomSpawnRequest {
  readonly materialId: string;
  readonly charge: number;
  readonly radius: number;
  readonly gravityStrength: number;
}

export type UiStateListener = (state: SandboxUiState) => void;

/**
 * サンドボックス ViewModel
 * シミュレーションループの進行制御、ユーザー操作の受け付け、SandboxUiStateの生成・通知を担う。
 * @see DATA_FLOW.md §1, §3
 */
export class SandboxViewModel {
  public readonly repository: SpaceStateRepository;
  public readonly core: SpaceEngineCore;
  private readonly similarityAnalyzer = new SimilarityAnalyzer();
  private spawnCounter = 0;

  private isRunning = true;
  private selectedEntityId: string | null = null;
  private debugOverlayMode: DebugOverlayMode = 'pressure';
  private observer: ObserverState = {
    position: [2.8, 2.5, 3.6],
    velocity: [0, 0, 0],
    focusPoint: [0, 1.5, 0],
    manualScaleLog10: null,
    tau: 0.1,
  };

  private lastMetrics = {
    activePacketCount: 0,
    sleepingPacketRatio: 0,
    totalEnergy: 0,
    dtEffective: 0,
    activeDischargeCount: 0,
    eventHorizonCount: 0,
    circuitCurrent: 0,
  };
  private listeners: UiStateListener[] = [];

  constructor(repository: SpaceStateRepository = new SpaceStateRepository()) {
    this.repository = repository;
    this.core = new SpaceEngineCore(repository.config);
  }

  public subscribe(listener: UiStateListener): () => void {
    this.listeners.push(listener);
    listener(this.buildUiState());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * 1フレーム分のシミュレーションを進める
   */
  public step(rawDt: number): void {
    if (this.isRunning) {
      // multi_scale_solar / sandbox_lab の場合は観測者の知覚スケーリングを有効化
      const useObserver =
        this.repository.currentPreset === 'multi_scale_solar' ||
        this.repository.currentPreset === 'sandbox_lab' ||
        this.observer.manualScaleLog10 !== null;

      // マクロスケールでは机（floorY）拘束を外して自由宇宙空間へ
      if (useObserver && this.core.config.cellSize > 2.0) {
        this.core.config = { ...this.core.config, floorY: -Infinity };
      } else {
        this.core.config = { ...this.core.config, floorY: 0.0 };
      }

      const res = this.core.step(
        this.repository.entities,
        this.repository.materials,
        this.repository.externalSources,
        rawDt,
        useObserver ? this.observer : undefined,
        this.repository.getCurrentMedium(),
        this.repository.media,
      );
      this.lastMetrics = {
        ...res.metrics,
        eventHorizonCount: res.metrics.eventHorizonCount ?? 0,
        circuitCurrent: res.metrics.circuitCurrent ?? 0,
      };
      this.repository.entities = res.entities;
    }
    this.notify();
  }

  public togglePlay(): void {
    this.isRunning = !this.isRunning;
    this.notify();
  }

  public loadPreset(presetId: PresetId): void {
    this.repository.loadPreset(presetId);
    this.core.config = { ...this.repository.config };
    this.core.resetField();
    this.selectedEntityId = null;
    if (presetId === 'multi_scale_solar' || presetId === 'sandbox_lab') {
      this.observer.manualScaleLog10 = -0.6;
      this.observer.focusPoint = [0, 1.5, 0];
    } else {
      this.observer.manualScaleLog10 = null;
      this.observer.focusPoint = [...this.repository.config.center];
    }
    this.notify();
  }

  public setMedium(mediumId: MediumId): void {
    this.repository.currentMediumId = mediumId;
    this.notify();
  }

  /**
   * 空間内の指定座標へ気体・熱・光パルスを注入するインジェクターブラシ
   */
  public injectBrushAt(
    pos: Vec3,
    radius: number,
    mode: InjectorBrushMode,
    strength = 1.0,
  ): void {
    this.core.injectBrush(pos, radius, mode, strength, this.repository.media);
    this.notify();
  }

  /**
   * 選択中のオブジェクト（未選択時は先頭のVisibleオブジェクト）へ熱エネルギーを加減算する
   */
  public addHeatToSelected(deltaHeat: number): void {
    const target =
      (this.selectedEntityId
        ? this.repository.entities.find((e) => e.id === this.selectedEntityId)
        : undefined) ?? this.repository.entities.find((e) => e.domainClass === 'Visible');
    if (!target) return;
    target.internalHeat = Math.max(0, target.internalHeat + deltaHeat);
    target.isSleeping = false;
    this.selectedEntityId = target.id;
    this.notify();
  }

  public reset(): void {
    this.loadPreset(this.repository.currentPreset);
  }

  public setDebugOverlayMode(mode: DebugOverlayMode): void {
    this.debugOverlayMode = mode;
    this.notify();
  }

  /**
   * 知覚スケール (log10 L_base) を手動設定する（null で自動スケール）
   */
  public setManualScaleLog10(log10Scale: number | null): void {
    this.observer.manualScaleLog10 = log10Scale;
    if (log10Scale !== null && log10Scale > 0.5) {
      // マクロスケールへズームアウトした際は注視点を惑星中心寄りにシフト
      this.observer.focusPoint = [0, -20.0, 0];
    } else {
      this.observer.focusPoint = [0, 1.5, 0];
    }
    this.notify();
  }

  /**
   * カスタムマテリアル・天体を計算窓中心付近へスポーンする
   */
  public spawnCustomEntity(req: CustomSpawnRequest): SpaceEntity {
    const mat = this.repository.materials.get(req.materialId);
    const center = this.core.config.center;
    const cell = this.core.grid.cellSize;
    this.spawnCounter++;
    const offset = ((this.spawnCounter % 5) - 2) * cell * 0.6;

    const r = Math.max(0.05, req.radius);
    const density = mat?.density ?? 1.0;
    const mass = Math.max(0.05, density * Math.pow(r / 0.2, 3));
    const spin = mat?.spinMagnitude ?? 0;

    const shape =
      req.materialId === 'rubber_balloon'
        ? 'balloon'
        : req.materialId === 'paper'
          ? 'sheet'
          : req.materialId === 'aluminum_can' || req.materialId === 'neodymium_magnet'
            ? 'cylinder'
            : req.materialId === 'wool_cloth' || req.materialId === 'steel_ground' || req.materialId === 'ice'
              ? 'box'
              : 'sphere';

    const entity: SpaceEntity = {
      id: `custom_${this.spawnCounter}_${req.materialId}`,
      materialId: req.materialId,
      position: [center[0] + offset, center[1] + cell, center[2] - offset * 0.5],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: r,
      shape,
      dimensions:
        shape === 'sheet'
          ? [r * 2, 0.016, r * 1.5]
          : shape === 'cylinder'
            ? [r * 1.6, r * 2.2, r * 1.6]
            : [r * 2, r * 2, r * 2],
      mass,
      netCharge: req.charge,
      dipoleMoment: [0, 0, 0],
      magneticMoment: spin > 0 ? [0, spin * 12.0, 0] : [0, 0, 0],
      internalHeat: 0,
      isGrounded: req.materialId === 'steel_ground',
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
      gravityStrength: req.gravityStrength > 0 ? req.gravityStrength : undefined,
    };

    this.repository.entities = [...this.repository.entities, entity];
    this.notify();
    return entity;
  }

  /**
   * オブジェクトを掴む（ドラッグ開始）
   */
  public grabEntity(entityId: string): void {
    const ent = this.repository.entities.find((e) => e.id === entityId);
    if (!ent) return;
    ent.isGrabbed = true;
    ent.isSleeping = false;
    ent.velocity = [0, 0, 0];
    this.selectedEntityId = entityId;
    this.notify();
  }

  /**
   * 掴んでいるオブジェクトを目標座標へ移動する
   */
  public moveGrabbedEntity(entityId: string, targetPos: Vec3, dt: number): void {
    const ent = this.repository.entities.find((e) => e.id === entityId);
    if (!ent || !ent.isGrabbed) return;

    const halfH = ent.dimensions ? ent.dimensions[1] * 0.5 : ent.radius;
    const floorLimit = Number.isFinite(this.core.config.floorY)
      ? this.core.config.floorY + halfH
      : -Infinity;
    const safeY = Math.max(floorLimit, targetPos[1]);
    const invDt = 1.0 / Math.max(dt, 1 / 120);
    ent.velocity = [
      (targetPos[0] - ent.position[0]) * invDt * 0.5,
      (safeY - ent.position[1]) * invDt * 0.5,
      (targetPos[2] - ent.position[2]) * invDt * 0.5,
    ];
    ent.position = [targetPos[0], safeY, targetPos[2]];
    ent.isSleeping = false;
  }

  /**
   * 掴んでいるオブジェクトを離す
   */
  public releaseEntity(entityId: string): void {
    const ent = this.repository.entities.find((e) => e.id === entityId);
    if (!ent) return;
    ent.isGrabbed = false;
    this.notify();
  }

  public getUiState(): SandboxUiState {
    return this.buildUiState();
  }

  private notify(): void {
    const state = this.buildUiState();
    for (const l of this.listeners) {
      l(state);
    }
  }

  private buildUiState(): SandboxUiState {
    let visible = 0;
    let projected = 0;
    let absorbed = 0;

    const snapshots: EntityRenderSnapshot[] = [];
    for (const e of this.repository.entities) {
      if (e.domainClass === 'Visible') visible++;
      else if (e.domainClass === 'Projected') projected++;
      else absorbed++;

      if (e.domainClass !== 'Absorbed' && !e.packedIntoId) {
        const mat = this.repository.materials.get(e.materialId);
        snapshots.push({
          id: e.id,
          materialId: e.materialId,
          position: [...e.position],
          radius: e.radius,
          shape: e.shape ?? 'sphere',
          dimensions: e.dimensions ? [...e.dimensions] : [e.radius * 2, e.radius * 2, e.radius * 2],
          colorHex: mat?.colorHex ?? 0xffffff,
          netCharge: e.netCharge,
          compression: e.compression ?? 0,
          phaseState: e.phaseState ?? 'solid',
          isBurning: Boolean(e.isBurning),
          isSleeping: e.isSleeping,
          isGrabbed: e.isGrabbed,
        });
      }
    }

    let selectedEntityMetrics: SandboxUiState['selectedEntityMetrics'] = null;
    if (this.selectedEntityId) {
      const ent = this.repository.entities.find((e) => e.id === this.selectedEntityId);
      if (ent) {
        const mat = this.repository.materials.get(ent.materialId);
        const speed = Math.sqrt(
          ent.velocity[0] * ent.velocity[0] +
            ent.velocity[1] * ent.velocity[1] +
            ent.velocity[2] * ent.velocity[2],
        );
        selectedEntityMetrics = {
          name: mat?.name ?? ent.materialId,
          charge: ent.netCharge,
          velocityMag: speed,
          heat: ent.internalHeat,
          phaseState: ent.phaseState ?? 'solid',
          isBurning: Boolean(ent.isBurning),
          isSleeping: ent.isSleeping,
        };
      }
    }

    return {
      isRunning: this.isRunning,
      currentPreset: this.repository.currentPreset,
      currentMediumId: this.repository.currentMediumId,
      activeDischargeCount: this.lastMetrics.activeDischargeCount,
      eventHorizonCount: this.lastMetrics.eventHorizonCount,
      circuitCurrent: this.lastMetrics.circuitCurrent,
      perceptualScaleLog10: Math.log10(this.core.grid.cellSize),
      manualScaleLog10: this.observer.manualScaleLog10,
      activePacketCount: this.lastMetrics.activePacketCount,
      sleepingPacketRatio: this.lastMetrics.sleepingPacketRatio,
      totalEnergy: this.lastMetrics.totalEnergy,
      dtEffective: this.lastMetrics.dtEffective,
      domainCounts: { visible, projected, absorbed },
      selectedEntityId: this.selectedEntityId,
      selectedEntityMetrics,
      debugOverlayMode: this.debugOverlayMode,
      similarity: this.similarityAnalyzer.analyze(this.core.grid),
      renderSnapshots: snapshots,
    };
  }
}
