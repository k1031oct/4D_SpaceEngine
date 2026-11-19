import { SpacePacketGrid } from './SpacePacketGrid';
import type { AmbientMediumSpec, InjectorBrushMode, Vec3 } from './types';

/**
 * 動的気体・流体媒質フラックスソルバ（Medium Channel Solver）
 * C_med > 0 の空間パケット間のみで駆動し、対流（暖気上昇・冷気下降）・
 * 熱伝導・圧力波拡散・真空断熱（C_med = 0 で自動遮断）を創発させる。
 * @see DATA_FLOW.md §3.1
 */
export class MediumFluxSolver {
  private initializedMediumId: string | null = null;

  /**
   * 空間媒質が切り替わった際にパケット網の媒質場を初期化する
   */
  public syncMediumBaseline(grid: SpacePacketGrid, medium: AmbientMediumSpec): void {
    if (this.initializedMediumId === medium.id) return;
    this.initializedMediumId = medium.id;

    const cMed = medium.density > 0 ? 1.0 : 0.0;
    for (let i = 0; i < grid.count; i++) {
      grid.mediumDensity[i] = medium.density;
      grid.mediumConcentration[i] = cMed;
      grid.reactivityPotential[i] = medium.oxidizerRatio;
      if (grid.vibrationEnergy[i] < medium.ambientHeat) {
        grid.vibrationEnergy[i] = medium.ambientHeat;
      }
    }
  }

  public reset(): void {
    this.initializedMediumId = null;
  }

  /**
   * 任意地点へ気体・熱・光パルスを注入するインジェクターブラシ
   */
  public injectBrush(
    grid: SpacePacketGrid,
    worldPos: Vec3,
    radius: number,
    mode: InjectorBrushMode,
    strength = 1.0,
    mediaCatalog?: ReadonlyMap<string, AmbientMediumSpec>,
  ): void {
    const r2 = radius * radius;
    for (let z = 1; z < grid.nz - 1; z++) {
      for (let y = 1; y < grid.ny - 1; y++) {
        for (let x = 1; x < grid.nx - 1; x++) {
          const p = grid.packetCenter(x, y, z);
          const dx = p[0] - worldPos[0];
          const dy = p[1] - worldPos[1];
          const dz = p[2] - worldPos[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;

          const falloff = 1.0 - Math.sqrt(d2) / Math.max(radius, 1e-4);
          const idx = grid.index(x, y, z);
          grid.isSleeping[idx] = 0;

          switch (mode) {
            case 'hot_air':
              grid.vibrationEnergy[idx] += 2.5 * strength * falloff;
              grid.mediumConcentration[idx] = Math.max(grid.mediumConcentration[idx], 0.8 * falloff);
              grid.mediumDensity[idx] = Math.max(0.0002, grid.mediumDensity[idx] * (1 - 0.3 * falloff));
              break;
            case 'cold_air':
              grid.vibrationEnergy[idx] = Math.max(0, grid.vibrationEnergy[idx] - 1.5 * strength * falloff);
              grid.mediumConcentration[idx] = Math.max(grid.mediumConcentration[idx], 0.9 * falloff);
              grid.mediumDensity[idx] += 0.005 * strength * falloff;
              break;
            case 'helium': {
              const heDensity = mediaCatalog?.get('helium')?.density ?? 0.00018;
              const mixWeight = Math.max(0, Math.min(1, falloff * Math.min(1, strength)));
              grid.mediumConcentration[idx] = Math.max(grid.mediumConcentration[idx], mixWeight);
              grid.mediumDensity[idx] =
                grid.mediumDensity[idx] * (1.0 - mixWeight) + heDensity * mixWeight;
              grid.reactivityPotential[idx] *= 1.0 - mixWeight;
              grid.py[idx] += 1.5 * strength * falloff;
              break;
            }
            case 'oxygen':
              grid.mediumConcentration[idx] = Math.max(grid.mediumConcentration[idx], 1.0 * falloff);
              grid.reactivityPotential[idx] = Math.min(1.0, grid.reactivityPotential[idx] + 0.5 * strength * falloff);
              break;
            case 'vacuum':
              grid.mediumConcentration[idx] = 0;
              grid.mediumDensity[idx] = 0;
              grid.reactivityPotential[idx] = 0;
              grid.px[idx] *= 0.2;
              grid.py[idx] *= 0.2;
              grid.pz[idx] *= 0.2;
              break;
            case 'light_pulse':
              grid.phi[idx] += 4.5 * strength * falloff;
              grid.vibrationEnergy[idx] += 6.0 * strength * falloff;
              break;
          }
        }
      }
    }
  }

  /**
   * 媒質チャネルの 1 ステップ更新（熱伝導・浮力対流・媒質拡散・真空断熱）
   */
  public solve(
    grid: SpacePacketGrid,
    backgroundField: Vec3,
    dt: number,
    maxSubDt = 0.02,
  ): void {
    const { nx, ny, nz } = grid;
    const clampedDt = Math.min(dt, maxSubDt);
    const thermalExpansionAlpha = 0.25;

    // 1. 平均実効媒質密度を算出（密度差アルキメデス浮力対流の基準）
    let sumEffDensity = 0;
    let medCount = 0;
    for (let i = 0; i < grid.count; i++) {
      const c = grid.mediumConcentration[i];
      if (c > 0.01 && grid.isBoundary[i] === 0) {
        const rhoEff =
          (grid.mediumDensity[i] * c) / (1.0 + thermalExpansionAlpha * Math.max(0, grid.vibrationEnergy[i]));
        sumEffDensity += rhoEff;
        medCount++;
      }
    }
    if (medCount === 0) return; // 完全真空（全パケット C_med = 0）なら媒質チャネル計算を丸ごとスキップ

    const meanEffDensity = sumEffDensity / medCount;
    const condRate = 0.12; // 媒質間の熱伝導係数（最大安定範囲 < 1/6）
    const diffRate = 0.12; // 媒質濃度・反応ポテンシャルの拡散係数

    for (let z = 1; z < nz - 1; z++) {
      for (let y = 1; y < ny - 1; y++) {
        for (let x = 1; x < nx - 1; x++) {
          const idx = grid.index(x, y, z);
          const cHere = grid.mediumConcentration[idx];

          // 真空セル (C_med == 0) は媒質フラックス・熱伝導を受け取らない（真空断熱）
          if (cHere <= 1e-4) {
            grid.mediumConcentrationNext[idx] = 0;
            grid.mediumDensityNext[idx] = 0;
            grid.reactivityPotential[idx] = 0;
            continue;
          }

          const neighbors = [
            grid.index(x - 1, y, z),
            grid.index(x + 1, y, z),
            grid.index(x, y - 1, z),
            grid.index(x, y + 1, z),
            grid.index(x, y, z - 1),
            grid.index(x, y, z + 1),
          ];

          let heatFlux = 0;
          let concFlux = 0;
          let densFlux = 0;
          let oxFlux = 0;

          for (const nIdx of neighbors) {
            if (grid.isBoundary[nIdx] === 1) continue;
            const cOther = grid.mediumConcentration[nIdx];
            // 隣接が真空 (cOther == 0) の場合、熱伝導・物質拡散フラックスは 0（真空断熱の成立）
            const interfaceCond = Math.min(cHere, cOther);
            if (interfaceCond > 1e-4) {
              heatFlux += (grid.vibrationEnergy[nIdx] - grid.vibrationEnergy[idx]) * interfaceCond;
              densFlux += (grid.mediumDensity[nIdx] - grid.mediumDensity[idx]) * interfaceCond;
              oxFlux += (grid.reactivityPotential[nIdx] - grid.reactivityPotential[idx]) * interfaceCond;
            }
            concFlux += cOther - cHere;
          }

          // 熱伝導・拡散・酸化剤反応ポテンシャルの更新
          grid.vibrationEnergy[idx] = Math.max(
            0,
            grid.vibrationEnergy[idx] + heatFlux * condRate * clampedDt * 8.0,
          );
          grid.mediumConcentrationNext[idx] = Math.max(
            0,
            Math.min(1, cHere + concFlux * diffRate * clampedDt * 6.0),
          );
          grid.mediumDensityNext[idx] = Math.max(
            0,
            grid.mediumDensity[idx] + densFlux * diffRate * clampedDt * 6.0,
          );
          grid.reactivityPotential[idx] = Math.max(
            0,
            Math.min(1, grid.reactivityPotential[idx] + oxFlux * diffRate * clampedDt * 6.0),
          );

          // 密度差アルキメデス浮力対流：ρ_eff = ρ_med * C_med / (1 + α * U_vib)
          // 熱気やヘリウムのように周辺平均より低密度の媒質は重力と逆向きに上昇し、冷気は下降する
          const effDensity =
            (grid.mediumDensity[idx] * cHere) /
            (1.0 + thermalExpansionAlpha * Math.max(0, grid.vibrationEnergy[idx]));
          const densityDiff = meanEffDensity - effDensity;
          if (Math.abs(densityDiff) > 1e-7 && meanEffDensity > 1e-7) {
            const buoyAccelScale = (densityDiff / meanEffDensity) * 0.65 * cHere;
            grid.px[idx] -= backgroundField[0] * buoyAccelScale * clampedDt;
            grid.py[idx] -= backgroundField[1] * buoyAccelScale * clampedDt;
            grid.pz[idx] -= backgroundField[2] * buoyAccelScale * clampedDt;
            grid.isSleeping[idx] = 0;
          }

          // 3軸風上移流（px, py, pz に沿って熱エネルギー U_vib と酸化剤ポテンシャルを輸送）
          const vx = grid.px[idx];
          const vy = grid.py[idx];
          const vz = grid.pz[idx];

          if (Math.abs(vx) > 0.02) {
            const targetX = vx > 0 ? Math.min(nx - 2, x + 1) : Math.max(1, x - 1);
            const tIdx = grid.index(targetX, y, z);
            if (grid.mediumConcentration[tIdx] > 1e-4) {
              const frac = Math.min(0.12, Math.abs(vx) * clampedDt * 0.45);
              const heatMove = frac * grid.vibrationEnergy[idx];
              const oxMove = frac * grid.reactivityPotential[idx];
              grid.vibrationEnergy[idx] -= heatMove;
              grid.vibrationEnergy[tIdx] += heatMove;
              grid.reactivityPotential[idx] = Math.max(0, grid.reactivityPotential[idx] - oxMove);
              grid.reactivityPotential[tIdx] = Math.min(1, grid.reactivityPotential[tIdx] + oxMove);
              grid.isSleeping[tIdx] = 0;
            }
          }
          if (Math.abs(vy) > 0.02) {
            const targetY = vy > 0 ? Math.min(ny - 2, y + 1) : Math.max(1, y - 1);
            const tIdx = grid.index(x, targetY, z);
            if (grid.mediumConcentration[tIdx] > 1e-4) {
              const frac = Math.min(0.12, Math.abs(vy) * clampedDt * 0.45);
              const heatMove = frac * grid.vibrationEnergy[idx];
              const oxMove = frac * grid.reactivityPotential[idx];
              grid.vibrationEnergy[idx] -= heatMove;
              grid.vibrationEnergy[tIdx] += heatMove;
              grid.reactivityPotential[idx] = Math.max(0, grid.reactivityPotential[idx] - oxMove);
              grid.reactivityPotential[tIdx] = Math.min(1, grid.reactivityPotential[tIdx] + oxMove);
              grid.isSleeping[tIdx] = 0;
            }
          }
          if (Math.abs(vz) > 0.02) {
            const targetZ = vz > 0 ? Math.min(nz - 2, z + 1) : Math.max(1, z - 1);
            const tIdx = grid.index(x, y, targetZ);
            if (grid.mediumConcentration[tIdx] > 1e-4) {
              const frac = Math.min(0.12, Math.abs(vz) * clampedDt * 0.45);
              const heatMove = frac * grid.vibrationEnergy[idx];
              const oxMove = frac * grid.reactivityPotential[idx];
              grid.vibrationEnergy[idx] -= heatMove;
              grid.vibrationEnergy[tIdx] += heatMove;
              grid.reactivityPotential[idx] = Math.max(0, grid.reactivityPotential[idx] - oxMove);
              grid.reactivityPotential[tIdx] = Math.min(1, grid.reactivityPotential[tIdx] + oxMove);
              grid.isSleeping[tIdx] = 0;
            }
          }
        }
      }
    }

    // 媒質ダブルバッファのスワップ
    [grid.mediumConcentration, grid.mediumConcentrationNext] = [
      grid.mediumConcentrationNext,
      grid.mediumConcentration,
    ];
    [grid.mediumDensity, grid.mediumDensityNext] = [grid.mediumDensityNext, grid.mediumDensity];
  }
}
