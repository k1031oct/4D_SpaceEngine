import { SpacePacketGrid } from './SpacePacketGrid';
import type { ProjectedExternalSource, Vec3 } from './types';

/**
 * ホログラフィック境界シェル射影器（Boundary Projector）
 * 計算窓の外側（Projected領域）にある巨大・遠方オブジェクトの作用を、
 * 最外周の空間パケット（境界シェル6面）に境界勾配・フラックスとして焼き付ける。
 */
export class BoundaryProjector {
  /**
   * 外部ソース群を空間パケット網の境界シェルへ射影する
   * @param grid 空間パケット網
   * @param externalSources 視野外の外部ソース群（地球重力など）
   * @returns 空間全体に伝播する背景一様勾配ベクトル
   */
  public project(
    grid: SpacePacketGrid,
    externalSources: readonly ProjectedExternalSource[],
  ): Vec3 {
    let bgX = 0;
    let bgY = 0;
    let bgZ = 0;

    for (const src of externalSources) {
      if (src.uniformField) {
        bgX += src.uniformField[0];
        bgY += src.uniformField[1];
        bgZ += src.uniformField[2];
      }
    }

    // 最外周境界シェルパケットへ外部勾配を記録
    for (let z = 0; z < grid.nz; z++) {
      for (let y = 0; y < grid.ny; y++) {
        for (let x = 0; x < grid.nx; x++) {
          const idx = grid.index(x, y, z);
          if (grid.isBoundary[idx] === 0) continue;

          let gx = bgX;
          let gy = bgY;
          let gz = bgZ;

          // 遠方点ソースがある場合は、境界パケット中心での逆二乗勾配を加算
          for (const src of externalSources) {
            if (src.position && src.strength !== undefined && src.strength !== 0) {
              const p = grid.packetCenter(x, y, z);
              const dx = p[0] - src.position[0];
              const dy = p[1] - src.position[1];
              const dz = p[2] - src.position[2];
              const r2 = dx * dx + dy * dy + dz * dz + 1e-4;
              const r = Math.sqrt(r2);
              const invR3 = src.strength / (r2 * r);
              gx += dx * invR3;
              gy += dy * invR3;
              gz += dz * invR3;
            }
          }

          grid.boundaryGradX[idx] = gx;
          grid.boundaryGradY[idx] = gy;
          grid.boundaryGradZ[idx] = gz;
        }
      }
    }

    return [bgX, bgY, bgZ];
  }
}
