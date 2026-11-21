import { MediumFluxSolver } from './MediumFluxSolver';
import { SpacePacketGrid } from './SpacePacketGrid';
import type {
  AmbientMediumSpec,
  LayerId,
  LayerMetricsSnapshot,
  SpaceEntity,
  Vec3,
} from './types';

interface HandedOffRecord {
  entity: SpaceEntity;
  layerId: LayerId;
  elapsedOutside: number;
}

interface LayerState {
  readonly layerId: LayerId;
  readonly scaleExponent: number;
  readonly stride: number;
  readonly grid: SpacePacketGrid;
  readonly mediumSolver: MediumFluxSolver;
  lastUpdatedFrame: number;
  isDecoupled: boolean;
}

/**
 * 複数レイヤー入れ子知覚スタック（Nested Perceptual Stack）
 * - 観測者フォーカス基準の対数桁数スライド階層（Layer -1 〜 Layer +3）
 * - 時間階層間引き（1x / 4x / 16x / 60x）と 10^-6m デカップリング定理による高速化
 * - 上下双方向カスケード（窓外逃走ガスの還流・バタフライエフェクト）
 * - 階層跨ぎハンドオフ（Cross-Layer Handoff：窓外流出時の Co-Pack 追跡と再入時の Unpack）
 * @see DATA_FLOW.md §4.1
 */
export class NestedPerceptualStack {
  public static readonly DECOUPLING_SCALE_LIMIT = 1e-6;

  private readonly layers = new Map<LayerId, LayerState>();
  private readonly handedOffEntities = new Map<string, HandedOffRecord>();
  private frameCounter = 0;

  constructor(baseCellSize: number, center: Vec3) {
    this.initLayers(baseCellSize, center);
  }

  private initLayers(baseCellSize: number, center: Vec3): void {
    const specs: ReadonlyArray<{ id: LayerId; exp: number; stride: number; dim: number }> = [
      { id: -1, exp: -2.5, stride: 1, dim: 6 },
      { id: 1, exp: 2.5, stride: 4, dim: 8 },
      { id: 2, exp: 5.5, stride: 16, dim: 8 },
      { id: 3, exp: 9.0, stride: 60, dim: 6 },
    ];

    for (const s of specs) {
      const cellSize = baseCellSize * Math.pow(10, s.exp);
      const grid = new SpacePacketGrid(s.dim, s.dim, s.dim, cellSize, center);
      this.layers.set(s.id, {
        layerId: s.id,
        scaleExponent: s.exp,
        stride: s.stride,
        grid,
        mediumSolver: new MediumFluxSolver(),
        lastUpdatedFrame: 0,
        isDecoupled: s.id === -1 ? baseCellSize >= NestedPerceptualStack.DECOUPLING_SCALE_LIMIT : false,
      });
    }
  }

  public reset(baseCellSize: number, center: Vec3): void {
    this.frameCounter = 0;
    this.handedOffEntities.clear();
    this.layers.clear();
    this.initLayers(baseCellSize, center);
  }

  public getLayer(layerId: Exclude<LayerId, 0>): LayerState | undefined {
    return this.layers.get(layerId);
  }

  public getHandedOffCount(): number {
    return this.handedOffEntities.size;
  }

  public getHandedOffEntity(id: string): SpaceEntity | undefined {
    return this.handedOffEntities.get(id)?.entity;
  }

  /**
   * 観測者中心・スケールの変化に合わせて各レイヤーを同期し、
   * 階層跨ぎハンドオフ（窓外 Co-Pack / 窓内 Unpack）と上位レイヤー運動積分を実行する
   */
  public synchronizeHandoff(
    entities: SpaceEntity[],
    layer0Grid: SpacePacketGrid,
    backgroundField: Vec3,
    dt: number,
  ): SpaceEntity[] {
    const [cx, cy, cz] = layer0Grid.minBound;
    const spanX = layer0Grid.nx * layer0Grid.cellSize;
    const spanY = layer0Grid.ny * layer0Grid.cellSize;
    const spanZ = layer0Grid.nz * layer0Grid.cellSize;
    const center: Vec3 = [cx + spanX * 0.5, cy + spanY * 0.5, cz + spanZ * 0.5];
    const halfX = spanX * 0.5;
    const halfY = spanY * 0.5;
    const halfZ = spanZ * 0.5;

    // 1. すでにハンドオフ中のエンティティを上位レイヤーの背景場・気流で継続積分
    const l1 = this.layers.get(1);
    const restored: SpaceEntity[] = [];
    for (const [id, rec] of Array.from(this.handedOffEntities.entries())) {
      const ent = rec.entity;
      rec.elapsedOutside += dt;

      if (!ent.isGrabbed && !ent.isGrounded) {
        ent.velocity[0] += backgroundField[0] * dt;
        ent.velocity[1] += backgroundField[1] * dt;
        ent.velocity[2] += backgroundField[2] * dt;

        // Layer +1 の大域フローからのわずかな移流影響を加味
        if (l1) {
          const l1Idx = l1.grid.index(
            Math.floor(l1.grid.nx * 0.5),
            Math.floor(l1.grid.ny * 0.5),
            Math.floor(l1.grid.nz * 0.5),
          );
          ent.velocity[0] += l1.grid.px[l1Idx] * 0.02 * dt;
          ent.velocity[1] += l1.grid.py[l1Idx] * 0.02 * dt;
          ent.velocity[2] += l1.grid.pz[l1Idx] * 0.02 * dt;
        }

        ent.position[0] += ent.velocity[0] * dt;
        ent.position[1] += ent.velocity[1] * dt;
        ent.position[2] += ent.velocity[2] * dt;
      }

      // 窓内へ戻ってきたか判定（ヒステリシスを持たせて 0.96 * half で再展開）
      const inside =
        Math.abs(ent.position[0] - center[0]) <= halfX * 0.96 &&
        Math.abs(ent.position[1] - center[1]) <= halfY * 0.96 &&
        Math.abs(ent.position[2] - center[2]) <= halfZ * 0.96;

      if (inside) {
        ent.domainClass = 'Visible';
        ent.isSleeping = false;
        restored.push(ent);
        this.handedOffEntities.delete(id);
      }
    }

    // 2. Layer 0 計算窓から流出した自由エンティティを Layer +1 へハンドオフ（Co-Pack 退避）
    const remaining: SpaceEntity[] = [];
    for (const ent of entities) {
      if (
        ent.domainClass !== 'Absorbed' &&
        !ent.isGrabbed &&
        !ent.isGrounded &&
        !ent.packedIntoId &&
        ent.radius <= Math.min(halfX, halfY, halfZ) * 0.5
      ) {
        const outside =
          Math.abs(ent.position[0] - center[0]) > halfX * 1.04 ||
          Math.abs(ent.position[1] - center[1]) > halfY * 1.04 ||
          Math.abs(ent.position[2] - center[2]) > halfZ * 1.04;

        if (outside) {
          this.handedOffEntities.set(ent.id, {
            entity: ent,
            layerId: 1,
            elapsedOutside: 0,
          });
          continue;
        }
      }
      remaining.push(ent);
    }

    return [...remaining, ...restored];
  }

  /**
   * 全レイヤーのスケール同期、時間間引き更新、上下双方向カスケード（バタフライエフェクト）を実行する
   */
  public stepStack(
    layer0Grid: SpacePacketGrid,
    backgroundField: Vec3,
    dt: number,
    medium?: AmbientMediumSpec,
  ): LayerMetricsSnapshot[] {
    this.frameCounter++;
    const baseCellSize = layer0Grid.cellSize;
    const center: Vec3 = [
      layer0Grid.minBound[0] + layer0Grid.nx * baseCellSize * 0.5,
      layer0Grid.minBound[1] + layer0Grid.ny * baseCellSize * 0.5,
      layer0Grid.minBound[2] + layer0Grid.nz * baseCellSize * 0.5,
    ];

    // 1. Layer -1: 10^-6m デカップリング定理判定
    const lMinus1 = this.layers.get(-1);
    if (lMinus1) {
      lMinus1.isDecoupled = baseCellSize >= NestedPerceptualStack.DECOUPLING_SCALE_LIMIT;
      if (!lMinus1.isDecoupled) {
        lMinus1.grid.remesh(baseCellSize * Math.pow(10, lMinus1.scaleExponent), center);
        lMinus1.lastUpdatedFrame = this.frameCounter;
      }
    }

    // 2. Layer 0 境界流出エネルギーを Layer +1 中心近傍へ上向きカスケード投影
    const l1 = this.layers.get(1);
    if (l1) {
      if (medium) {
        l1.mediumSolver.syncMediumBaseline(l1.grid, medium);
      }
      this.cascadeLayer0ToLayer1(layer0Grid, l1.grid, dt);
    }

    // 3. 上位レイヤー (+1, +2, +3) を時間階層間引き（4x, 16x, 60x）に従って更新
    for (const id of [1, 2, 3] as const) {
      const layer = this.layers.get(id);
      if (!layer) continue;

      if (medium) {
        layer.mediumSolver.syncMediumBaseline(layer.grid, medium);
      }

      if (this.frameCounter % layer.stride === 0) {
        const effectiveLayerDt = Math.min(dt * layer.stride, 0.08);
        layer.mediumSolver.solve(layer.grid, backgroundField, effectiveLayerDt, 0.04);
        layer.lastUpdatedFrame = this.frameCounter;

        // 上位レイヤー間のカスケード（L+1 -> L+2 -> L+3）
        if (id === 1) {
          const l2 = this.layers.get(2);
          if (l2) this.cascadeBetweenUpperLayers(layer.grid, l2.grid, 0.15);
          // バタフライエフェクト：Layer +1 の環境流・気圧を Layer 0 境界近傍へ還流
          this.feedbackUpperToLayer0(layer.grid, layer0Grid, dt);
        } else if (id === 2) {
          const l3 = this.layers.get(3);
          if (l3) this.cascadeBetweenUpperLayers(layer.grid, l3.grid, 0.1);
          if (l1) this.feedbackUpperToUpper(layer.grid, l1.grid, 0.08);
        }
      }
    }

    return this.buildSnapshots(layer0Grid);
  }

  /**
   * Layer 0 の外周境界付近に蓄積した熱・運動量・媒質フラックスを Layer +1 へ上向き投影
   */
  private cascadeLayer0ToLayer1(
    l0: SpacePacketGrid,
    l1: SpacePacketGrid,
    dt: number,
  ): void {
    const cx1 = Math.floor(l1.nx * 0.5);
    const cy1 = Math.floor(l1.ny * 0.5);
    const cz1 = Math.floor(l1.nz * 0.5);
    const targetIdx = l1.index(cx1, cy1, cz1);

    let outHeat = 0;
    let outPy = 0;
    let outPx = 0;
    let outPz = 0;
    let edgeCount = 0;

    for (let z = 1; z < l0.nz - 1; z++) {
      for (let y = 1; y < l0.ny - 1; y++) {
        for (let x = 1; x < l0.nx - 1; x++) {
          const isEdge =
            x === 1 || x === l0.nx - 2 || y === 1 || y === l0.ny - 2 || z === 1 || z === l0.nz - 2;
          if (!isEdge) continue;
          const idx = l0.index(x, y, z);
          if (l0.vibrationEnergy[idx] > 0.2 || Math.abs(l0.py[idx]) > 0.05) {
            const transfer = Math.min(0.05, 0.5 * dt);
            const dh = l0.vibrationEnergy[idx] * transfer;
            l0.vibrationEnergy[idx] -= dh;
            outHeat += dh;
            outPx += l0.px[idx] * transfer;
            outPy += l0.py[idx] * transfer;
            outPz += l0.pz[idx] * transfer;
            edgeCount++;
          }
        }
      }
    }

    if (edgeCount > 0) {
      l1.vibrationEnergy[targetIdx] += outHeat;
      l1.px[targetIdx] += outPx / edgeCount;
      l1.py[targetIdx] += outPy / edgeCount;
      l1.pz[targetIdx] += outPz / edgeCount;
      l1.isSleeping[targetIdx] = 0;
    }
  }

  private cascadeBetweenUpperLayers(
    lower: SpacePacketGrid,
    upper: SpacePacketGrid,
    coupling: number,
  ): void {
    const lc = lower.index(
      Math.floor(lower.nx * 0.5),
      Math.floor(lower.ny * 0.5),
      Math.floor(lower.nz * 0.5),
    );
    const uc = upper.index(
      Math.floor(upper.nx * 0.5),
      Math.floor(upper.ny * 0.5),
      Math.floor(upper.nz * 0.5),
    );
    const dh = lower.vibrationEnergy[lc] * coupling;
    if (dh > 1e-6) {
      lower.vibrationEnergy[lc] -= dh;
      upper.vibrationEnergy[uc] += dh;
      upper.py[uc] += lower.py[lc] * coupling;
      upper.isSleeping[uc] = 0;
    }
  }

  private feedbackUpperToUpper(
    upper: SpacePacketGrid,
    lower: SpacePacketGrid,
    coupling: number,
  ): void {
    const uc = upper.index(
      Math.floor(upper.nx * 0.5),
      Math.floor(upper.ny * 0.5),
      Math.floor(upper.nz * 0.5),
    );
    const lc = lower.index(
      Math.floor(lower.nx * 0.5),
      Math.floor(lower.ny * 0.5),
      Math.floor(lower.nz * 0.5),
    );
    lower.px[lc] += upper.px[uc] * coupling;
    lower.py[lc] += upper.py[uc] * coupling;
    lower.pz[lc] += upper.pz[uc] * coupling;
  }

  /**
   * 上位レイヤーの環境流（風・対流）を Layer 0 の境界付近へ帰還させる（バタフライエフェクト）
   */
  private feedbackUpperToLayer0(
    l1: SpacePacketGrid,
    l0: SpacePacketGrid,
    dt: number,
  ): void {
    const c1 = l1.index(
      Math.floor(l1.nx * 0.5),
      Math.floor(l1.ny * 0.5),
      Math.floor(l1.nz * 0.5),
    );
    const vx = l1.px[c1];
    const vy = l1.py[c1];
    const vz = l1.pz[c1];
    if (Math.abs(vx) + Math.abs(vy) + Math.abs(vz) < 1e-5) return;

    const gain = Math.min(0.1, 0.4 * dt);
    for (let z = 1; z < l0.nz - 1; z += 2) {
      for (let x = 1; x < l0.nx - 1; x += 2) {
        const idx = l0.index(x, 1, z);
        if (l0.mediumConcentration[idx] > 1e-4) {
          l0.px[idx] += vx * gain;
          l0.py[idx] += vy * gain;
          l0.pz[idx] += vz * gain;
          l0.isSleeping[idx] = 0;
        }
      }
    }
  }

  private buildSnapshots(layer0Grid: SpacePacketGrid): LayerMetricsSnapshot[] {
    const snapshots: LayerMetricsSnapshot[] = [];
    const sumGrid = (g: SpacePacketGrid): { heat: number; medMass: number } => {
      let heat = 0;
      let medMass = 0;
      for (let i = 0; i < g.count; i++) {
        if (g.isBoundary[i] === 1) continue;
        heat += g.vibrationEnergy[i];
        medMass += g.mediumDensity[i] * g.mediumConcentration[i] * g.cellVolume;
      }
      return { heat, medMass };
    };

    const lMinus1 = this.layers.get(-1);
    if (lMinus1) {
      const s = sumGrid(lMinus1.grid);
      snapshots.push({
        layerId: -1,
        cellSize: lMinus1.grid.cellSize,
        stride: lMinus1.stride,
        lastUpdatedFrame: lMinus1.lastUpdatedFrame,
        isDecoupled: lMinus1.isDecoupled,
        totalHeat: s.heat,
        totalMediumMass: s.medMass,
        handedOffCount: 0,
      });
    }

    const s0 = sumGrid(layer0Grid);
    snapshots.push({
      layerId: 0,
      cellSize: layer0Grid.cellSize,
      stride: 1,
      lastUpdatedFrame: this.frameCounter,
      isDecoupled: false,
      totalHeat: s0.heat,
      totalMediumMass: s0.medMass,
      handedOffCount: 0,
    });

    for (const id of [1, 2, 3] as const) {
      const l = this.layers.get(id);
      if (!l) continue;
      const s = sumGrid(l.grid);
      snapshots.push({
        layerId: id,
        cellSize: l.grid.cellSize,
        stride: l.stride,
        lastUpdatedFrame: l.lastUpdatedFrame,
        isDecoupled: l.isDecoupled,
        totalHeat: s.heat,
        totalMediumMass: s.medMass,
        handedOffCount: id === 1 ? this.handedOffEntities.size : 0,
      });
    }

    return snapshots;
  }
}
