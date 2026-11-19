import { FieldSolver } from './FieldSolver';
import type { ISpatialComputeBackend } from './ISpatialComputeBackend';
import { MediumFluxSolver } from './MediumFluxSolver';
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
    mediaCatalog?: ReadonlyMap<string, AmbientMediumSpec>,
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
      mediaCatalog,
    );

    const maxFrameDt = config.maxFrameDt ?? 0.05;
    const effectiveFrameDt = Math.min(Math.max(rawDt, 1e-5), maxFrameDt);
    if (medium) {
      this.mediumSolver.solve(grid, backgroundField, effectiveFrameDt, config.maxMediumSubDt ?? 0.02);
    }

    return metrics;
  }

  public injectBrush(
    grid: SpacePacketGrid,
    worldPos: Vec3,
    radius: number,
    mode: InjectorBrushMode,
    strength = 1.0,
    mediaCatalog?: ReadonlyMap<string, AmbientMediumSpec>,
  ): void {
    this.mediumSolver.injectBrush(grid, worldPos, radius, mode, strength, mediaCatalog);
  }

  public syncMediumBaseline(grid: SpacePacketGrid, medium: AmbientMediumSpec): void {
    this.mediumSolver.syncMediumBaseline(grid, medium);
  }

  public evaluateLightInteraction(
    material: MaterialSpec | undefined,
    lightFrequency: number,
  ): { transmittance: number; reflectance: number; absorption: number } {
    return this.fieldSolver.evaluateLightInteraction(material, lightFrequency);
  }

  public evaluateHollowTransmissionAndPermeation(
    shellZ: number,
    innerZ: number,
    gapSpacing: number,
    particleHardRadius: number,
  ): { waveTransmittance: number; canPermeate: boolean } {
    return this.fieldSolver.evaluateHollowTransmissionAndPermeation(
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
    return this.fieldSolver.evaluateQuantumTunneling(
      barrierHeight,
      particleEnergy,
      barrierWidth,
      scaleL,
    );
  }

  public reset(): void {
    this.mediumSolver.reset();
  }
}
