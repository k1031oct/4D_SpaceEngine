import { describe, expect, it } from 'vitest';
import { BioAgentSolver } from '../src/core/BioAgentSolver';
import { EnergyModuleSolver } from '../src/core/EnergyModuleSolver';
import { SpaceEngineCore } from '../src/core/SpaceEngineCore';
import type { BioAgentState, LogicalModuleSpec, SpaceEntity } from '../src/core/types';
import { createDefaultCoreConfig, SpaceStateRepository } from '../src/data/SpaceStateRepository';

describe('Phase 11: 論理変換モジュール ＆ 自律生命エージェント層 (4項目)', () => {
  it('1. 論理エネルギー変換＆廃熱ロス放出テスト: 運動フローを電力へ変換しつつ効率ロスを廃熱U_vibとして空間へ放出すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const air = repo.media.get('air')!;
    core.getBackend().syncMediumBaseline(core.grid, air);

    const turbineEnt: SpaceEntity = {
      id: 'water_wheel_1',
      materialId: 'copper_wire',
      position: [0, 1.5, 0],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.2,
      shape: 'cylinder',
      mass: 2.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0,
      isGrounded: true,
      isGrabbed: false,
      isSleeping: true,
      domainClass: 'Visible',
    };

    const turbineMod: LogicalModuleSpec = {
      id: 'mod_turbine',
      entityId: 'water_wheel_1',
      inputEnergyType: 'kinetic',
      outputEnergyType: 'electric',
      efficiency: 0.4, // 60% が廃熱・排気ロスになる
      failRate: 0,
      targetFlowDir: [1, 0, 0],
      maxThroughput: 12.0,
    };

    const [gx, gy, gz] = core.grid.worldToGrid(turbineEnt.position);
    const idx = core.grid.index(Math.round(gx), Math.round(gy), Math.round(gz));
    const outIdx = core.grid.index(Math.round(gx) + 1, Math.round(gy), Math.round(gz));

    // 水流/風速フローを注入
    core.grid.px[idx] = 4.0;
    const heatBefore = core.grid.vibrationEnergy[idx];
    const phiBefore = core.grid.phi[outIdx];

    const res = core.step(
      [turbineEnt],
      repo.materials,
      [],
      1 / 60,
      undefined,
      air,
      repo.media,
      [turbineMod],
    );

    expect(res.metrics.moduleConversionCount).toBe(1);
    expect(res.metrics.emittedWasteHeat).toBeGreaterThan(0);
    expect(core.grid.vibrationEnergy[idx]).toBeGreaterThan(heatBefore);
    expect(core.grid.phi[outIdx]).toBeGreaterThan(phiBefore);
  });

  it('2. Fail Fast（破損トークン排出）＆ リサイクル回収テスト: エラー時に泥塊トークンが生成されリサイクラで回収されること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const solver = new EnergyModuleSolver();

    const producer: SpaceEntity = {
      id: 'factory_1',
      materialId: 'iron_ball',
      position: [0, 1.5, 0],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.2,
      shape: 'box',
      mass: 2.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0,
      isGrounded: true,
      isGrabbed: false,
      isSleeping: true,
      domainClass: 'Visible',
    };
    const recycler: SpaceEntity = {
      ...producer,
      id: 'recycler_1',
      position: [0.35, 1.5, 0],
    };

    const modFail: LogicalModuleSpec = {
      id: 'mod_fail',
      entityId: 'factory_1',
      inputEnergyType: 'thermal',
      outputEnergyType: 'kinetic',
      efficiency: 0.7,
      failRate: 1.0, // 確実にエラー発生
      targetFlowDir: [1, 0, 0],
    };
    const modRecycle: LogicalModuleSpec = {
      id: 'mod_recycle',
      entityId: 'recycler_1',
      inputEnergyType: 'kinetic',
      outputEnergyType: 'thermal',
      efficiency: 0.9,
      failRate: 0,
      isRecycler: true,
    };

    const [gx, gy, gz] = core.grid.worldToGrid(producer.position);
    core.grid.vibrationEnergy[core.grid.index(Math.round(gx), Math.round(gy), Math.round(gz))] = 5.0;

    const entities: SpaceEntity[] = [producer, recycler];
    const res1 = solver.solve([modFail], entities, core.grid, 1 / 60, () => 0.0);
    expect(res1.spawnedWasteTokens.length).toBe(1);
    expect(res1.spawnedWasteTokens[0].isWasteToken).toBe(true);

    entities.push(...res1.spawnedWasteTokens);
    const res2 = solver.solve([modRecycle], entities, core.grid, 1 / 60);
    expect(res2.recycledCount).toBe(1);
    expect(entities.some((e) => e.isWasteToken)).toBe(false);
  });

  it('3. 生物エージェントの空間五感センサー（走光性＆反作用推力）テスト: 光勾配へ向かって代謝を消費し能動推力で移動すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const air = repo.media.get('air')!;
    core.getBackend().syncMediumBaseline(core.grid, air);

    const mothEnt: SpaceEntity = {
      id: 'moth_body',
      materialId: 'paper',
      position: [0, 1.5, 0],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.12,
      shape: 'sphere',
      mass: 0.2,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0.05,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };

    const mothAgent: BioAgentState = {
      instanceId: 'moth_001',
      entityId: 'moth_body',
      speciesId: 'phototaxis_moth',
      metabolicEnergy: 5.0,
      maxMetabolicEnergy: 10.0,
      comfortTempRange: [0.0, 2.0],
      sensoryWeights: { light: 2.0, heat: 1.0, oxGradient: 0.5, pressureShock: 1.0 },
      thrustForce: 4.0,
      lastAction: 'idle',
    };

    // +x 方向の隣接セルに光源ポテンシャルを設定
    const [gx, gy, gz] = core.grid.worldToGrid(mothEnt.position);
    const ix = Math.round(gx);
    const iy = Math.round(gy);
    const iz = Math.round(gz);
    core.grid.phi[core.grid.index(ix + 1, iy, iz)] = 1.5;

    const solver = new BioAgentSolver();
    const count = solver.solve([mothAgent], [mothEnt], core.grid, 1 / 60);

    expect(count).toBe(1);
    expect(mothAgent.lastAction).toBe('seek_light');
    expect(mothEnt.velocity[0]).toBeGreaterThan(0); // 光源方向 (+x) へ加速
    expect(core.grid.px[core.grid.index(ix, iy, iz)]).toBeLessThan(0); // 反作用 (-x) 書き込み
    expect(mothAgent.metabolicEnergy).toBeLessThan(5.0);
  });

  it('4. 工場廃熱逃避 ＆ 川（冷却境界）ゾーニング創発テスト: 廃熱流入時は生物が逃避し、冷却帯で遮断すると留まれること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const air = repo.media.get('air')!;
    core.getBackend().syncMediumBaseline(core.grid, air);

    const critterEnt: SpaceEntity = {
      id: 'critter_1',
      materialId: 'paper',
      position: [0.25, 1.5, 0],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.12,
      shape: 'sphere',
      mass: 0.2,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0.05,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };
    const critterAgent: BioAgentState = {
      instanceId: 'mantis_001',
      entityId: 'critter_1',
      speciesId: 'garden_mantis',
      metabolicEnergy: 5.0,
      maxMetabolicEnergy: 10.0,
      comfortTempRange: [0.0, 1.2],
      sensoryWeights: { light: 0.1, heat: 2.5, oxGradient: 0.5, pressureShock: 1.0 },
      thrustForce: 5.0,
      lastAction: 'idle',
    };

    // 生物の左側 (-x) から工場廃熱が流入したケース
    const [gx, gy, gz] = core.grid.worldToGrid(critterEnt.position);
    const ix = Math.round(gx);
    const iy = Math.round(gy);
    const iz = Math.round(gz);
    core.grid.vibrationEnergy[core.grid.index(ix - 1, iy, iz)] = 8.0;
    core.grid.vibrationEnergy[core.grid.index(ix, iy, iz)] = 2.5; // comfort max (1.2) を超過

    const resHot = core.step(
      [critterEnt],
      repo.materials,
      [],
      1 / 60,
      undefined,
      air,
      repo.media,
      undefined,
      [critterAgent],
    );
    expect(resHot.metrics.activeBioAgentCount).toBe(1);
    expect(critterAgent.lastAction).toBe('flee_heat');
    expect(critterEnt.velocity[0]).toBeGreaterThan(0); // 熱源 (-x) から +x 方向へ逃避

    // 川（冷却境界：生物付近の温度を快適域に維持）によるゾーニング状態では逃避しないこと
    core.grid.vibrationEnergy[core.grid.index(ix - 1, iy, iz)] = 0.05;
    core.grid.vibrationEnergy[core.grid.index(ix, iy, iz)] = 0.05;
    critterEnt.velocity = [0, 0, 0];
    core.step(
      [critterEnt],
      repo.materials,
      [],
      1 / 60,
      undefined,
      air,
      repo.media,
      undefined,
      [critterAgent],
    );
    expect(critterAgent.lastAction).not.toBe('flee_heat');
  });
});
