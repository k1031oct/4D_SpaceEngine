import type { SpacePacketGrid } from './SpacePacketGrid';
import type { BioActionType, BioAgentState, SpaceEntity } from './types';

/**
 * 自律生物エージェントソルバ（Bio Agency Solver）
 * 座標の直接カンニングを禁止し、占有空間パケットと隣接6パケットの物理勾配
 * （光・熱振動 U_vib・有機ガス U_ox・急激な気圧波 ΔP）のみを知覚して行動を決定し、
 * 内部代謝エネルギーを消費して周囲パケットへの反作用（能動推力）を発生させる。
 * @see DATA_FLOW.md §4.2
 */
export class BioAgentSolver {
  public solve(
    agents: BioAgentState[],
    entities: readonly SpaceEntity[],
    grid: SpacePacketGrid,
    dt: number,
  ): number {
    let activeCount = 0;

    for (const agent of agents) {
      const body = entities.find((e) => e.id === agent.entityId && e.domainClass === 'Visible');
      if (!body || body.isGrabbed) continue;
      activeCount++;

      const [gx, gy, gz] = grid.worldToGrid(body.position);
      const ix = Math.max(1, Math.min(grid.nx - 2, Math.round(gx)));
      const iy = Math.max(1, Math.min(grid.ny - 2, Math.round(gy)));
      const iz = Math.max(1, Math.min(grid.nz - 2, Math.round(gz)));
      const idx = grid.index(ix, iy, iz);

      const idxXm = grid.index(ix - 1, iy, iz);
      const idxXp = grid.index(ix + 1, iy, iz);
      const idxYm = grid.index(ix, iy - 1, iz);
      const idxYp = grid.index(ix, iy + 1, iz);
      const idxZm = grid.index(ix, iy, iz - 1);
      const idxZp = grid.index(ix, iy, iz + 1);

      const inv2Dx = 0.5 / Math.max(grid.cellSize, 1e-4);

      // 1. 空間五感センサー：隣接パケットからの勾配サンプリング
      // (a) 温度 U_vib と快適レンジ比較
      const localHeat = grid.vibrationEnergy[idx];
      const gradHeatX = (grid.vibrationEnergy[idxXp] - grid.vibrationEnergy[idxXm]) * inv2Dx;
      const gradHeatZ = (grid.vibrationEnergy[idxZp] - grid.vibrationEnergy[idxZm]) * inv2Dx;

      // (b) 光・電界ポテンシャル強度 |Φ| の勾配（走光性）
      const gradLightX = (Math.abs(grid.phi[idxXp]) - Math.abs(grid.phi[idxXm])) * inv2Dx;
      const gradLightY = (Math.abs(grid.phi[idxYp]) - Math.abs(grid.phi[idxYm])) * inv2Dx;
      const gradLightZ = (Math.abs(grid.phi[idxZp]) - Math.abs(grid.phi[idxZm])) * inv2Dx;

      // (c) 有機・酸化ポテンシャル U_ox の勾配（採餌・分解者）
      const gradOxX =
        (grid.reactivityPotential[idxXp] - grid.reactivityPotential[idxXm]) * inv2Dx;
      const gradOxZ =
        (grid.reactivityPotential[idxZp] - grid.reactivityPotential[idxZm]) * inv2Dx;

      // (d) 局所気圧衝撃 |Φ| の急変（驚愕・逃避）
      const localPressure = Math.abs(grid.phi[idx]);

      // 2. 行動ベクトルの合成（優先度：驚愕逃避 > 過熱逃避 > 低温探索・採餌・走光性）
      let steerX = 0;
      let steerY = 0;
      let steerZ = 0;
      let action: BioActionType = 'idle';

      const [minT, maxT] = agent.comfortTempRange;
      const w = agent.sensoryWeights;

      if (localPressure > 2.5 && w.pressureShock > 0) {
        // 急激な気圧波からの逃避（高圧勾配の逆向き）
        steerX -= gradLightX * w.pressureShock;
        steerY -= gradLightY * w.pressureShock;
        steerZ -= gradLightZ * w.pressureShock;
        action = 'flee_shock';
      } else if (localHeat > maxT && w.heat > 0) {
        // 廃熱・高温からの逃避（-∇U_vib 方向）
        steerX -= gradHeatX * w.heat * 2.0;
        steerZ -= gradHeatZ * w.heat * 2.0;
        action = 'flee_heat';
      } else {
        // 快適・採餌・走光性探索
        if (localHeat < minT && w.heat > 0) {
          steerX += gradHeatX * w.heat;
          steerZ += gradHeatZ * w.heat;
          action = 'seek_warmth';
        }
        if (w.light > 0) {
          const lightMag = Math.abs(gradLightX) + Math.abs(gradLightZ);
          if (lightMag > 1e-4) {
            steerX += gradLightX * w.light;
            steerZ += gradLightZ * w.light;
            if (action === 'idle') action = 'seek_light';
          }
        }
        if (w.oxGradient > 0) {
          const oxMag = Math.abs(gradOxX) + Math.abs(gradOxZ);
          if (oxMag > 1e-4) {
            steerX += gradOxX * w.oxGradient;
            steerZ += gradOxZ * w.oxGradient;
            if (action === 'idle') action = 'forage';
          }
        }
      }

      agent.lastAction = action;

      // 採餌による代謝エネルギー回復（環境ベースラインを超える高濃度有機・酸化ポテンシャル域）
      if (grid.reactivityPotential[idx] > 0.35) {
        agent.metabolicEnergy = Math.min(
          agent.maxMetabolicEnergy,
          agent.metabolicEnergy + 0.1 * dt,
        );
      }

      // 3. 代謝エネルギー消費による能動推力と空間パケットへの反作用書き込み
      const steerMag = Math.sqrt(steerX * steerX + steerY * steerY + steerZ * steerZ);
      if (steerMag > 1e-5 && agent.metabolicEnergy > 1e-4) {
        const nx = steerX / steerMag;
        const ny = steerY / steerMag;
        const nz = steerZ / steerMag;

        const impulse = agent.thrustForce * dt;
        const invM = 1.0 / Math.max(body.mass, 1e-4);
        body.velocity[0] += nx * impulse * invM;
        body.velocity[1] += ny * impulse * invM;
        body.velocity[2] += nz * impulse * invM;
        body.isSleeping = false;

        // 作用・反作用：周囲空間パケットへ逆向きの運動量反作用を書き込む
        grid.px[idx] -= nx * impulse * 0.25;
        grid.py[idx] -= ny * impulse * 0.25;
        grid.pz[idx] -= nz * impulse * 0.25;
        grid.isSleeping[idx] = 0;

        agent.metabolicEnergy = Math.max(0, agent.metabolicEnergy - 0.05 * dt);
      }
    }

    return activeCount;
  }
}
