import type { OctreeCellInfo, Vec3 } from './types';

/**
 * 可変体積「空間パケット（Space Packet）」の集合体
 * 将来の Rust / Wasm / C++ 移植を見据え、TypedArray（SoA: Structure of Arrays）で保持する。
 * 知覚スケール L の変化に応じて保存則リメッシュおよび中心窩 Octree 抽出を行う。
 */
export class SpacePacketGrid {
  public readonly nx: number;
  public readonly ny: number;
  public readonly nz: number;
  public readonly count: number;
  public cellSize: number;
  public cellVolume: number;
  public minBound: Vec3;
  public maxBound: Vec3;

  /** 気圧偏差 ΔP / ポテンシャル Φ */
  public phi: Float32Array;
  public phiNext: Float32Array;

  /** 運動量フロー P = (px, py, pz) */
  public px: Float32Array;
  public py: Float32Array;
  public pz: Float32Array;
  public pxNext: Float32Array;
  public pyNext: Float32Array;
  public pzNext: Float32Array;

  /** 渦度 ω = (wx, wy, wz) */
  public wx: Float32Array;
  public wy: Float32Array;
  public wz: Float32Array;
  public wxNext: Float32Array;
  public wyNext: Float32Array;
  public wzNext: Float32Array;

  /** 内部振動エネルギー U_vib（熱・静止慣性） */
  public vibrationEnergy: Float32Array;

  /** 空間の弾性・誘電率 ε_eff */
  public stiffness: Float32Array;

  /** オブジェクト等から注入されるソース項 */
  public sourcePhi: Float32Array;
  public sourceWx: Float32Array;
  public sourceWy: Float32Array;
  public sourceWz: Float32Array;

  /** 最外周境界シェルフラグ (1 = 境界, 0 = 内部) */
  public readonly isBoundary: Uint8Array;

  /** ε-Cutoff スリープフラグ (1 = スリープ, 0 = アクティブ) */
  public readonly isSleeping: Uint8Array;

  /** 境界シェルへ射影された外部気圧勾配（重力・外部電場） */
  public readonly boundaryGradX: Float32Array;
  public readonly boundaryGradY: Float32Array;
  public readonly boundaryGradZ: Float32Array;

  constructor(nx: number, ny: number, nz: number, cellSize: number, center: Vec3) {
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.count = nx * ny * nz;
    this.cellSize = cellSize;
    this.cellVolume = cellSize * cellSize * cellSize;

    const halfX = (nx * cellSize) * 0.5;
    const halfY = (ny * cellSize) * 0.5;
    const halfZ = (nz * cellSize) * 0.5;
    this.minBound = [center[0] - halfX, center[1] - halfY, center[2] - halfZ];
    this.maxBound = [center[0] + halfX, center[1] + halfY, center[2] + halfZ];

    this.phi = new Float32Array(this.count);
    this.phiNext = new Float32Array(this.count);

    this.px = new Float32Array(this.count);
    this.py = new Float32Array(this.count);
    this.pz = new Float32Array(this.count);
    this.pxNext = new Float32Array(this.count);
    this.pyNext = new Float32Array(this.count);
    this.pzNext = new Float32Array(this.count);

    this.wx = new Float32Array(this.count);
    this.wy = new Float32Array(this.count);
    this.wz = new Float32Array(this.count);
    this.wxNext = new Float32Array(this.count);
    this.wyNext = new Float32Array(this.count);
    this.wzNext = new Float32Array(this.count);

    this.vibrationEnergy = new Float32Array(this.count);
    this.stiffness = new Float32Array(this.count);
    this.stiffness.fill(1.0);

    this.sourcePhi = new Float32Array(this.count);
    this.sourceWx = new Float32Array(this.count);
    this.sourceWy = new Float32Array(this.count);
    this.sourceWz = new Float32Array(this.count);

    this.isBoundary = new Uint8Array(this.count);
    this.isSleeping = new Uint8Array(this.count);
    this.isSleeping.fill(1);

    this.boundaryGradX = new Float32Array(this.count);
    this.boundaryGradY = new Float32Array(this.count);
    this.boundaryGradZ = new Float32Array(this.count);

    // 最外周6面を境界シェルとしてマーク
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || z === 0 || z === nz - 1) {
            this.isBoundary[this.index(x, y, z)] = 1;
          }
        }
      }
    }
  }

  /**
   * 3D格子インデックスを1次元配列インデックスへ変換する
   */
  public index(x: number, y: number, z: number): number {
    return x + this.nx * (y + this.ny * z);
  }

  /**
   * 空間場を真空基準状態へ初期化する
   */
  public reset(): void {
    this.phi.fill(0);
    this.phiNext.fill(0);
    this.px.fill(0);
    this.py.fill(0);
    this.pz.fill(0);
    this.pxNext.fill(0);
    this.pyNext.fill(0);
    this.pzNext.fill(0);
    this.wx.fill(0);
    this.wy.fill(0);
    this.wz.fill(0);
    this.wxNext.fill(0);
    this.wyNext.fill(0);
    this.wzNext.fill(0);
    this.vibrationEnergy.fill(0);
    this.stiffness.fill(1.0);
    this.sourcePhi.fill(0);
    this.sourceWx.fill(0);
    this.sourceWy.fill(0);
    this.sourceWz.fill(0);
    this.isSleeping.fill(1);
    this.boundaryGradX.fill(0);
    this.boundaryGradY.fill(0);
    this.boundaryGradZ.fill(0);
  }

  /**
   * ソース項のみをクリアする（毎ステップの注入前に呼ぶ）
   */
  public clearSources(): void {
    this.sourcePhi.fill(0);
    this.sourceWx.fill(0);
    this.sourceWy.fill(0);
    this.sourceWz.fill(0);
  }

  /**
   * ワールド座標から連続グリッド座標 (gx, gy, gz) を計算する
   */
  public worldToGrid(pos: Vec3): Vec3 {
    const gx = (pos[0] - this.minBound[0]) / this.cellSize - 0.5;
    const gy = (pos[1] - this.minBound[1]) / this.cellSize - 0.5;
    const gz = (pos[2] - this.minBound[2]) / this.cellSize - 0.5;
    return [gx, gy, gz];
  }

  /**
   * パケット中心のワールド座標を返す
   */
  public packetCenter(x: number, y: number, z: number): Vec3 {
    return [
      this.minBound[0] + (x + 0.5) * this.cellSize,
      this.minBound[1] + (y + 0.5) * this.cellSize,
      this.minBound[2] + (z + 0.5) * this.cellSize,
    ];
  }

  /**
   * 任意座標におけるスカラー場（phi 等）をトリリニア補間でサンプリングする
   */
  public sampleField(arr: Float32Array, pos: Vec3): number {
    const [gx, gy, gz] = this.worldToGrid(pos);
    const x0 = Math.max(0, Math.min(this.nx - 2, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(this.ny - 2, Math.floor(gy)));
    const z0 = Math.max(0, Math.min(this.nz - 2, Math.floor(gz)));
    const tx = Math.max(0, Math.min(1, gx - x0));
    const ty = Math.max(0, Math.min(1, gy - y0));
    const tz = Math.max(0, Math.min(1, gz - z0));

    const c000 = arr[this.index(x0, y0, z0)];
    const c100 = arr[this.index(x0 + 1, y0, z0)];
    const c010 = arr[this.index(x0, y0 + 1, z0)];
    const c110 = arr[this.index(x0 + 1, y0 + 1, z0)];
    const c001 = arr[this.index(x0, y0, z0 + 1)];
    const c101 = arr[this.index(x0 + 1, y0, z0 + 1)];
    const c011 = arr[this.index(x0, y0 + 1, z0 + 1)];
    const c111 = arr[this.index(x0 + 1, y0 + 1, z0 + 1)];

    const c00 = c000 * (1 - tx) + c100 * tx;
    const c10 = c010 * (1 - tx) + c110 * tx;
    const c01 = c001 * (1 - tx) + c101 * tx;
    const c11 = c011 * (1 - tx) + c111 * tx;

    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;

    return c0 * (1 - tz) + c1 * tz;
  }

  /**
   * 任意座標における気圧偏差 Φ の空間勾配 ∇Φ を中心差分でサンプリングする
   */
  public samplePhiGradient(pos: Vec3): Vec3 {
    const h = this.cellSize * 0.5;
    const inv2h = 1.0 / (2.0 * h);

    const dpx =
      this.sampleField(this.phi, [pos[0] + h, pos[1], pos[2]]) -
      this.sampleField(this.phi, [pos[0] - h, pos[1], pos[2]]);
    const dpy =
      this.sampleField(this.phi, [pos[0], pos[1] + h, pos[2]]) -
      this.sampleField(this.phi, [pos[0], pos[1] - h, pos[2]]);
    const dpz =
      this.sampleField(this.phi, [pos[0], pos[1], pos[2] + h]) -
      this.sampleField(this.phi, [pos[0], pos[1], pos[2] - h]);

    return [dpx * inv2h, dpy * inv2h, dpz * inv2h];
  }

  /**
   * 知覚スケール L および計算窓中心が変化した際、保存則（Φ・V, P, ω・L², U_vib）を維持してリメッシュする
   */
  public remesh(newCellSize: number, newCenter: Vec3): void {
    const sizeChanged = Math.abs(newCellSize - this.cellSize) / Math.max(this.cellSize, 1e-6) > 0.02;
    const oldCenter: Vec3 = [
      (this.minBound[0] + this.maxBound[0]) * 0.5,
      (this.minBound[1] + this.maxBound[1]) * 0.5,
      (this.minBound[2] + this.maxBound[2]) * 0.5,
    ];
    const centerMoved =
      Math.abs(newCenter[0] - oldCenter[0]) +
        Math.abs(newCenter[1] - oldCenter[1]) +
        Math.abs(newCenter[2] - oldCenter[2]) >
      this.cellSize * 0.25;

    if (!sizeChanged && !centerMoved) return;

    const oldCellSize = this.cellSize;
    const oldCellVol = this.cellVolume;
    const newCellVol = newCellSize * newCellSize * newCellSize;
    const volRatio = oldCellVol / Math.max(newCellVol, 1e-12);
    const areaRatio = (oldCellSize * oldCellSize) / Math.max(newCellSize * newCellSize, 1e-12);

    const halfX = (this.nx * newCellSize) * 0.5;
    const halfY = (this.ny * newCellSize) * 0.5;
    const halfZ = (this.nz * newCellSize) * 0.5;
    const newMin: Vec3 = [newCenter[0] - halfX, newCenter[1] - halfY, newCenter[2] - halfZ];

    const newPhi = new Float32Array(this.count);
    const newPx = new Float32Array(this.count);
    const newPy = new Float32Array(this.count);
    const newPz = new Float32Array(this.count);
    const newWx = new Float32Array(this.count);
    const newWy = new Float32Array(this.count);
    const newWz = new Float32Array(this.count);
    const newVib = new Float32Array(this.count);

    for (let z = 0; z < this.nz; z++) {
      for (let y = 0; y < this.ny; y++) {
        for (let x = 0; x < this.nx; x++) {
          const idx = this.index(x, y, z);
          if (this.isBoundary[idx] === 1) continue;

          const worldPos: Vec3 = [
            newMin[0] + (x + 0.5) * newCellSize,
            newMin[1] + (y + 0.5) * newCellSize,
            newMin[2] + (z + 0.5) * newCellSize,
          ];

          // 旧グリッドの範囲外なら真空基準 0 のまま
          if (
            worldPos[0] < this.minBound[0] ||
            worldPos[0] > this.maxBound[0] ||
            worldPos[1] < this.minBound[1] ||
            worldPos[1] > this.maxBound[1] ||
            worldPos[2] < this.minBound[2] ||
            worldPos[2] > this.maxBound[2]
          ) {
            continue;
          }

          // 保存則を保ったスケーリング補間
          newPhi[idx] = this.sampleField(this.phi, worldPos) * Math.min(volRatio, 4.0);
          newPx[idx] = this.sampleField(this.px, worldPos);
          newPy[idx] = this.sampleField(this.py, worldPos);
          newPz[idx] = this.sampleField(this.pz, worldPos);
          newWx[idx] = this.sampleField(this.wx, worldPos) * Math.min(areaRatio, 4.0);
          newWy[idx] = this.sampleField(this.wy, worldPos) * Math.min(areaRatio, 4.0);
          newWz[idx] = this.sampleField(this.wz, worldPos) * Math.min(areaRatio, 4.0);
          newVib[idx] = this.sampleField(this.vibrationEnergy, worldPos);

          if (Math.abs(newPhi[idx]) > 1e-4 || Math.abs(newWx[idx]) + Math.abs(newWy[idx]) > 1e-4) {
            this.isSleeping[idx] = 0;
          }
        }
      }
    }

    this.cellSize = newCellSize;
    this.cellVolume = newCellVol;
    this.minBound = newMin;
    this.maxBound = [newCenter[0] + halfX, newCenter[1] + halfY, newCenter[2] + halfZ];
    this.phi.set(newPhi);
    this.px.set(newPx);
    this.py.set(newPy);
    this.pz.set(newPz);
    this.wx.set(newWx);
    this.wy.set(newWy);
    this.wz.set(newWz);
    this.vibrationEnergy.set(newVib);
  }

  /**
   * 中心窩（Foveated）分割に基づく Octree 階層ノードを抽出する
   * 注視点付近は細解像度 (level 1, サイズ L)、周辺部は粗解像度 (level 0, サイズ 2L) に統合して返す
   */
  public extractFoveatedOctree(focusPoint: Vec3): OctreeCellInfo[] {
    const nodes: OctreeCellInfo[] = [];
    const foveaRadius = this.cellSize * (this.nx * 0.25);

    for (let z = 0; z < this.nz; z += 2) {
      for (let y = 0; y < this.ny; y += 2) {
        for (let x = 0; x < this.nx; x += 2) {
          const blockCenter: Vec3 = [
            this.minBound[0] + (x + 1) * this.cellSize,
            this.minBound[1] + (y + 1) * this.cellSize,
            this.minBound[2] + (z + 1) * this.cellSize,
          ];
          const dx = blockCenter[0] - focusPoint[0];
          const dy = blockCenter[1] - focusPoint[1];
          const dz = blockCenter[2] - focusPoint[2];
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

          if (dist < foveaRadius) {
            // 中心窩領域：細かい8つの子パケットとして展開
            for (let dz = 0; dz < 2; dz++) {
              for (let dy = 0; dy < 2; dy++) {
                for (let dx2 = 0; dx2 < 2; dx2++) {
                  const idx = this.index(x + dx2, y + dy, z + dz);
                  nodes.push({
                    center: this.packetCenter(x + dx2, y + dy, z + dz),
                    size: this.cellSize,
                    level: 1,
                    phi: this.phi[idx],
                  });
                }
              }
            }
          } else {
            // 周辺領域：2x2x2 を1つの粗パケット (2L) へ保存則統合
            let phiSum = 0;
            for (let dz = 0; dz < 2; dz++) {
              for (let dy = 0; dy < 2; dy++) {
                for (let dx2 = 0; dx2 < 2; dx2++) {
                  phiSum += this.phi[this.index(x + dx2, y + dy, z + dz)];
                }
              }
            }
            nodes.push({
              center: blockCenter,
              size: this.cellSize * 2,
              level: 0,
              phi: phiSum / 8.0,
            });
          }
        }
      }
    }

    return nodes;
  }
}
