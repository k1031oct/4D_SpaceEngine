import type { SimilarityInsight } from '../core/SimilarityAnalyzer';
import type { DebugOverlayMode, MediumId, PresetId, Vec3 } from '../core/types';

/**
 * 描画層へ渡す軽量エンティティスナップショット
 */
export interface EntityRenderSnapshot {
  readonly id: string;
  readonly materialId: string;
  readonly position: Vec3;
  readonly radius: number;
  readonly colorHex: number;
  readonly netCharge: number;
  readonly isSleeping: boolean;
  readonly isGrabbed: boolean;
}

/**
 * Viewが購読するイミュータブルなUI状態
 * @see DATA_FLOW.md §2.3
 */
export interface SandboxUiState {
  readonly isRunning: boolean;
  readonly currentPreset: PresetId;
  readonly currentMediumId: MediumId;
  readonly activeDischargeCount: number;
  readonly perceptualScaleLog10: number;
  readonly manualScaleLog10: number | null;
  readonly activePacketCount: number;
  readonly sleepingPacketRatio: number;
  readonly totalEnergy: number;
  readonly dtEffective: number;
  readonly domainCounts: {
    readonly visible: number;
    readonly projected: number;
    readonly absorbed: number;
  };
  readonly selectedEntityId: string | null;
  readonly selectedEntityMetrics: {
    readonly name: string;
    readonly charge: number;
    readonly velocityMag: number;
    readonly heat: number;
    readonly isSleeping: boolean;
  } | null;
  readonly debugOverlayMode: DebugOverlayMode;
  readonly similarity: SimilarityInsight;
  readonly renderSnapshots: readonly EntityRenderSnapshot[];
}
