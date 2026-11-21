import type { SpacePacketGrid } from './SpacePacketGrid';
import type { LogicalModuleSpec, SpaceEntity } from './types';

export interface ModuleStepResult {
  readonly conversions: number;
  readonly wasteHeatEmitted: number;
  readonly spawnedWasteTokens: SpaceEntity[];
  readonly recycledCount: number;
}

/**
 * エネルギー型変換モジュールソルバ（Energy Module Solver）
 * 空間パケットからエネルギーを吸収し、効率 η で出力型へ変換して空間へ再注入する。
 * ロス (1 - η) は廃熱 (vibrationEnergy) と排気 (reactivityPotential低下) として空間を書き換える。
 * @see DATA_FLOW.md §4.2
 */
export class EnergyModuleSolver {
  private wasteCounter = 0;

  public solve(
    modules: readonly LogicalModuleSpec[],
    entities: SpaceEntity[],
    grid: SpacePacketGrid,
    dt: number,
    rollFn: () => number = Math.random,
  ): ModuleStepResult {
    let conversions = 0;
    let wasteHeatEmitted = 0;
    const spawnedWasteTokens: SpaceEntity[] = [];
    let recycledCount = 0;

    for (const mod of modules) {
      const host = entities.find((e) => e.id === mod.entityId && e.domainClass === 'Visible');
      if (!host) continue;

      // リサイクルモジュールの場合は近接する破損トークンを回収・再資源化
      if (mod.isRecycler) {
        for (let i = entities.length - 1; i >= 0; i--) {
          const target = entities[i];
          if (!target.isWasteToken) continue;
          const dx = target.position[0] - host.position[0];
          const dy = target.position[1] - host.position[1];
          const dz = target.position[2] - host.position[2];
          const reach = host.radius + target.radius + grid.cellSize;
          if (dx * dx + dy * dy + dz * dz <= reach * reach) {
            entities.splice(i, 1);
            recycledCount++;
          }
        }
      }

      const [gx, gy, gz] = grid.worldToGrid(host.position);
      const ix = Math.max(1, Math.min(grid.nx - 2, Math.round(gx)));
      const iy = Math.max(1, Math.min(grid.ny - 2, Math.round(gy)));
      const iz = Math.max(1, Math.min(grid.nz - 2, Math.round(gz)));
      const idx = grid.index(ix, iy, iz);

      const maxCap = (mod.maxThroughput ?? 6.0) * dt;
      let absorbed = 0;

      // 1. 入力エネルギーの吸収
      switch (mod.inputEnergyType) {
        case 'kinetic': {
          const p2 =
            grid.px[idx] * grid.px[idx] +
            grid.py[idx] * grid.py[idx] +
            grid.pz[idx] * grid.pz[idx];
          const avail = 0.5 * p2;
          absorbed = Math.min(avail, maxCap);
          if (avail > 1e-6 && absorbed > 0) {
            const scale = Math.sqrt(Math.max(0, (avail - absorbed) / avail));
            grid.px[idx] *= scale;
            grid.py[idx] *= scale;
            grid.pz[idx] *= scale;
          }
          break;
        }
        case 'thermal': {
          const avail = Math.max(0, grid.vibrationEnergy[idx]);
          absorbed = Math.min(avail, maxCap);
          grid.vibrationEnergy[idx] -= absorbed;
          break;
        }
        case 'light':
        case 'electric': {
          const availPhi = Math.abs(grid.phi[idx]);
          absorbed = Math.min(availPhi * 0.5, maxCap);
          if (availPhi > 1e-6 && absorbed > 0) {
            const sign = grid.phi[idx] >= 0 ? 1 : -1;
            grid.phi[idx] = sign * Math.max(0, availPhi - absorbed * 2.0);
          }
          if (absorbed < 1e-4 && Math.abs(host.netCharge) > 1e-4) {
            const chargePull = Math.min(Math.abs(host.netCharge), maxCap);
            const sign = host.netCharge >= 0 ? 1 : -1;
            host.netCharge -= sign * chargePull;
            absorbed += chargePull;
          }
          break;
        }
      }

      if (absorbed <= 1e-6) continue;
      conversions++;

      // 2. 効率 η に応じた出力生成とロス（廃熱・排気）の空間放出
      const eta = Math.max(0.05, Math.min(1.0, mod.efficiency));
      const eOut = absorbed * eta;
      const eLoss = absorbed * (1.0 - eta);

      // ロスを廃熱 U_vib と排気（酸素減少）として占有パケットへ吐き出す
      grid.vibrationEnergy[idx] += eLoss;
      grid.reactivityPotential[idx] = Math.max(0, grid.reactivityPotential[idx] - eLoss * 0.05);
      grid.isSleeping[idx] = 0;
      wasteHeatEmitted += eLoss;

      // 出力を出力先セル（または方向ベクトル先）へ再注入
      const dir = mod.targetFlowDir ?? [1, 0, 0];
      const ox = Math.max(1, Math.min(grid.nx - 2, Math.round(ix + dir[0])));
      const oy = Math.max(1, Math.min(grid.ny - 2, Math.round(iy + dir[1])));
      const oz = Math.max(1, Math.min(grid.nz - 2, Math.round(iz + dir[2])));
      const outIdx = grid.index(ox, oy, oz);
      grid.isSleeping[outIdx] = 0;

      switch (mod.outputEnergyType) {
        case 'kinetic': {
          const dMag = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
          const speedGain = Math.sqrt(2.0 * eOut);
          grid.px[outIdx] += (dir[0] / dMag) * speedGain;
          grid.py[outIdx] += (dir[1] / dMag) * speedGain;
          grid.pz[outIdx] += (dir[2] / dMag) * speedGain;
          break;
        }
        case 'thermal': {
          grid.vibrationEnergy[outIdx] += eOut;
          break;
        }
        case 'light':
        case 'electric': {
          grid.phi[outIdx] += eOut * 2.0;
          grid.sourcePhi[outIdx] += eOut * 2.0;
          break;
        }
      }

      // 3. エラー発生（Fail Fast）：泥塊・破損トークンを物理空間へ排出
      if (mod.failRate > 0 && rollFn() < mod.failRate) {
        this.wasteCounter++;
        spawnedWasteTokens.push({
          id: `waste_${mod.id}_${this.wasteCounter}`,
          materialId: 'paper',
          position: [
            host.position[0] + dir[0] * (host.radius + 0.12),
            host.position[1] + 0.1,
            host.position[2] + dir[2] * (host.radius + 0.12),
          ],
          velocity: [dir[0] * 0.4, 0.3, dir[2] * 0.4],
          angularVelocity: [0, 0, 0],
          radius: 0.08,
          shape: 'box',
          dimensions: [0.14, 0.14, 0.14],
          mass: 0.1,
          netCharge: 0,
          dipoleMoment: [0, 0, 0],
          magneticMoment: [0, 0, 0],
          internalHeat: eLoss,
          isGrounded: false,
          isGrabbed: false,
          isSleeping: false,
          domainClass: 'Visible',
          isWasteToken: true,
        });
      }
    }

    return {
      conversions,
      wasteHeatEmitted,
      spawnedWasteTokens,
      recycledCount,
    };
  }
}
