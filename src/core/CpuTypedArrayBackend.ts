import { FieldSolver } from './FieldSolver';
import type { ISpatialComputeBackend } from './ISpatialComputeBackend';
import { MediumFluxSolver } from './MediumFluxSolver';
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
 * デフォルトの CPU TypedArray 計算バックエンド
 */
export class CpuTypedArrayBackend implements ISpatialComputeBackend {
  public readonly backendName = 'CpuTypedArrayBackend';
  public readonly fieldSolver = new FieldSolver();
  public readonly mediumSolver = new MediumFluxSolver();

  public executeFieldAndMediumStep(
    grid: SpacePacketGrid,
    entities: SpaceEntity[],
    materials: ReadonlyMap<string, MaterialSpec>,
    backgroundField: Vec3,
    rawDt: number,
    config: SpaceCoreConfig,
    medium?: AmbientMediumSpec,
  ): CoreStepMetrics {
    if (medium) {
      this.mediumSolver.syncMediumBaseline(grid, medium);
    }

    const metrics = this.fieldSolver.solve(
      grid,
      entities,
      materials,
      backgroundField,
      rawDt,
      config,
      medium,
    );

    const effectiveFrameDt = Math.min(Math.max(rawDt, 1e-5), 0.05);
    if (medium) {
      this.mediumSolver.solve(grid, backgroundField, effectiveFrameDt);
    }

    return metrics;
  }

  public reset(): void {
    this.mediumSolver.reset();
  }
}
