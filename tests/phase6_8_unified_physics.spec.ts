import { describe, expect, it } from 'vitest';
import { DualPacketizer } from '../src/core/DualPacketizer';
import { SpaceEngineCore } from '../src/core/SpaceEngineCore';
import type { SpaceEntity } from '../src/core/types';
import { createDefaultCoreConfig, SpaceStateRepository } from '../src/data/SpaceStateRepository';
import { SandboxViewModel } from '../src/viewmodel/SandboxViewModel';

describe('Phase 6-8: 統合空間演算アーキテクチャ v2.0 検証スイート (11項目)', () => {
  it('1. 定在波の檻による摩擦と動摩擦低下テスト: 限界突破時の熱放出により動摩擦へ移行すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.externalSources = [];
    const a: SpaceEntity = {
      id: 'plate',
      materialId: 'wool_cloth',
      position: [0, 0.2, 0],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.25,
      mass: 5.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0,
      isGrounded: true,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };
    const b: SpaceEntity = {
      id: 'slider',
      materialId: 'rubber_balloon',
      position: [0, 0.55, 0],
      velocity: [3.5, -0.5, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.2,
      mass: 1.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0,
      trapEnergyStored: 1.2,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };
    repo.entities = [a, b];
    const core = new SpaceEngineCore(repo.config);

    core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    expect(b.internalHeat).toBeGreaterThan(0.1);
    expect(b.trapEnergyStored).toBe(0);
  });

  it('2. 電池グループオブジェクトの回路駆動テスト: 電圧落差で電流が流れ発熱し、化学エネルギー枯渇で停止すること', () => {
    const vm = new SandboxViewModel();
    vm.loadPreset('battery_circuit');

    const sep = vm.repository.entities.find((e) => e.groupRole === 'separator')!;
    const bulb = vm.repository.entities.find((e) => e.groupRole === 'bulb')!;
    const initChem = sep.chemicalEnergy!;

    for (let i = 0; i < 30; i++) {
      vm.step(1 / 60);
    }
    const stateMid = vm.getUiState();
    expect(stateMid.circuitCurrent).toBeGreaterThan(0.1);
    expect(bulb.internalHeat).toBeGreaterThan(0.05);
    expect(sep.chemicalEnergy!).toBeLessThan(initChem);

    sep.chemicalEnergy = 0;
    vm.step(1 / 60);
    expect(vm.getUiState().circuitCurrent).toBe(0);
  });

  it('3. 粗視化時のサブグリッド偏差保持テスト: 2次分散・極値 δE_max を保持し臨界ホットスポットで優先展開すること', () => {
    const packetizer = new DualPacketizer();
    const coldPart: SpaceEntity = {
      id: 'cold_p',
      materialId: 'iron_ball',
      position: [0.1, 0.2, 0.2],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.12,
      mass: 1.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0.5,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };
    const hotSpot: SpaceEntity = {
      id: 'hot_p',
      materialId: 'iron_ball',
      position: [0.6, 0.2, 0.2],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.12,
      mass: 1.0,
      netCharge: 1.0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 16.0,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };

    const packed = packetizer.synchronize([coldPart, hotSpot], 2.0);
    const cluster = packed.find((e) => e.id.startsWith('cluster_'))!;
    expect(cluster).toBeDefined();
    expect(cluster.deviationVariance).toBeGreaterThan(10.0);
    expect(cluster.peakDeviation).toBeGreaterThan(5.0);
    expect(Math.abs(cluster.anisotropyAxis![0])).toBeGreaterThan(0.1);
    expect(cluster.isCriticalSubgrid).toBe(true);

    const unpacked = packetizer.synchronize(packed, 2.0);
    expect(unpacked.some((e) => e.id.startsWith('cluster_'))).toBe(false);
  });

  it('4. 動的気体媒質場の対流＆真空断熱テスト: 下部加熱で上昇対流が起き、真空層(C_med=0)で熱伝導が遮断されること', () => {
    const vm = new SandboxViewModel();
    vm.loadPreset('thermal_convection');
    vm.setMedium('air');

    const grid = vm.core.grid;
    const medSolver = vm.core.getMediumSolver();
    medSolver.syncMediumBaseline(grid, vm.repository.getCurrentMedium());

    const lowerPos = grid.packetCenter(8, 3, 8);
    medSolver.injectBrush(grid, lowerPos, 0.5, 'hot_air', 2.0);
    for (let i = 0; i < 10; i++) {
      vm.step(1 / 60);
    }
    const idxLower = grid.index(8, 3, 8);
    expect(grid.py[idxLower]).toBeGreaterThan(0);

    const vacCenter = grid.packetCenter(8, 7, 8);
    medSolver.injectBrush(grid, vacCenter, 2.0, 'vacuum', 1.0);
    const idxHot = grid.index(8, 4, 8);
    const idxColdAcrossVac = grid.index(8, 11, 8);
    grid.vibrationEnergy[idxHot] = 20.0;
    const coldBefore = grid.vibrationEnergy[idxColdAcrossVac];
    for (let i = 0; i < 10; i++) {
      vm.step(1 / 60);
    }
    expect(grid.vibrationEnergy[idxColdAcrossVac] - coldBefore).toBeLessThan(0.05);
  });

  it('5. ヘリウム風船の浮上と破裂発散テスト: 浮上後に外殻破断すると放射衝撃波とヘリウム拡散が起きること', () => {
    const vm = new SandboxViewModel();
    vm.loadPreset('helium_balloon_burst');
    const balloon = vm.repository.entities.find((e) => e.id === 'he_balloon')!;
    const initY = balloon.position[1];

    for (let i = 0; i < 45; i++) {
      vm.step(1 / 60);
    }
    expect(balloon.position[1]).toBeGreaterThan(initY + 0.05);

    balloon.elasticEnergy = 25.0;
    vm.step(1 / 60);
    const frags = vm.repository.entities.filter((e) => e.id.includes('_frag_'));
    expect(frags.length).toBe(2);
    const [gx, gy, gz] = vm.core.grid.worldToGrid(balloon.position);
    const cIdx = vm.core.grid.index(Math.round(gx), Math.round(gy), Math.round(gz));
    expect(vm.core.grid.phi[cIdx]).toBeGreaterThan(1.0);
  });

  it('6. 中空構造の空間的透過・浸透テスト: インピーダンス連続性による波動透過とすき間サイズ選別浸透が成立すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const fieldSolver = core.getFieldSolver();

    const matched = fieldSolver.evaluateHollowTransmissionAndPermeation(1.5, 1.5, 0.1, 0.03);
    const mismatched = fieldSolver.evaluateHollowTransmissionAndPermeation(1.5, 8.0, 0.1, 0.03);
    expect(matched.waveTransmittance).toBeCloseTo(1.0, 4);
    expect(mismatched.waveTransmittance).toBeLessThan(0.6);

    expect(matched.canPermeate).toBe(true);
    const blocked = fieldSolver.evaluateHollowTransmissionAndPermeation(1.5, 1.5, 0.1, 0.08);
    expect(blocked.canPermeate).toBe(false);
  });

  it('7. 光相互作用テスト: 固有共鳴周波数と導電率に応じて透過・鏡面反射・共鳴吸収発熱が分岐すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const fieldSolver = core.getFieldSolver();

    const glassRes = fieldSolver.evaluateLightInteraction(repo.materials.get('glass_prism'), 8.0);
    expect(glassRes.transmittance).toBeGreaterThan(0.85);

    const metalRes = fieldSolver.evaluateLightInteraction(repo.materials.get('copper_wire'), 8.0);
    expect(metalRes.reflectance).toBeGreaterThan(0.85);

    const resAbs = fieldSolver.evaluateLightInteraction(repo.materials.get('tungsten_bulb'), 6.0);
    expect(resAbs.absorption).toBeGreaterThan(0.7);
  });

  it('8. 着磁・強誘電ヒステリシステスト: 外部渦度による永久磁石化(着磁)と加熱による消磁が再現されること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.externalSources = [];
    const iron: SpaceEntity = {
      id: 'soft_iron',
      materialId: 'iron_ball',
      position: [0, 1.5, 0],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.18,
      mass: 1.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };
    repo.entities = [iron];
    const core = new SpaceEngineCore(repo.config);

    core.grid.wy.fill(2.5);
    core.grid.isSleeping.fill(0);
    for (let i = 0; i < 15; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }
    expect(iron.magneticMoment[1]).toBeGreaterThan(1.0);

    core.grid.wy.fill(0);
    iron.internalHeat = 85.0;
    for (let i = 0; i < 30; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }
    expect(iron.magneticMoment[1]).toBeLessThan(0.5);
  });

  it('9. 極限状態テスト: 極低温同種接触での冷間圧接 ＆ 臨界エネルギー集中でのブラックホール自己捕獲', () => {
    const repoCW = new SpaceStateRepository(createDefaultCoreConfig());
    repoCW.externalSources = [];
    repoCW.entities = [
      {
        id: 'cu_a',
        materialId: 'copper_wire',
        position: [-0.15, 1.5, 0],
        velocity: [0.1, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.18,
        mass: 1.0,
        netCharge: 0,
        dipoleMoment: [0, 0, 0],
        magneticMoment: [0, 0, 0],
        internalHeat: 0.005,
        isGrounded: false,
        isGrabbed: false,
        isSleeping: false,
        domainClass: 'Visible',
      },
      {
        id: 'cu_b',
        materialId: 'copper_wire',
        position: [0.15, 1.5, 0],
        velocity: [-0.1, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.18,
        mass: 1.0,
        netCharge: 0,
        dipoleMoment: [0, 0, 0],
        magneticMoment: [0, 0, 0],
        internalHeat: 0.005,
        isGrounded: false,
        isGrabbed: false,
        isSleeping: false,
        domainClass: 'Visible',
      },
    ];
    const coreCW = new SpaceEngineCore(repoCW.config);
    coreCW.step(repoCW.entities, repoCW.materials, repoCW.externalSources, 1 / 60);
    expect(repoCW.entities[0].isColdWelded).toBe(true);
    expect(repoCW.entities[1].isColdWelded).toBe(true);

    const vm = new SandboxViewModel();
    vm.loadPreset('black_hole_horizon');
    const c = vm.core.config.center;
    vm.injectBrushAt(c, 0.5, 'light_pulse', 8.0);
    const probe = vm.repository.entities.find((e) => e.id === 'orbit_probe')!;
    const initProbeX = probe.position[0];

    for (let i = 0; i < 15; i++) {
      vm.step(1 / 60);
    }
    const state = vm.getUiState();
    expect(state.eventHorizonCount).toBeGreaterThan(0);
    expect(probe.position[0]).toBeLessThan(initProbeX - 0.1);
  });

  it('10. 金属疲労の累積破断と形状記憶合金の加熱復元テスト: Lazy Micro-Unpack による3分岐収支と復元', () => {
    const vm = new SandboxViewModel();
    vm.loadPreset('fatigue_and_shape_memory');

    const wire = vm.repository.entities.find((e) => e.id === 'fatigue_wire')!;
    const wireMat = vm.repository.materials.get(wire.materialId);
    const phaseSolver = vm.core.getPhaseSolver();

    // 1. 繰り返し曲げを加えると熱と残留歪みが蓄積し、疲労限界 (2.5) 超過で破断すること
    for (let cycle = 0; cycle < 8; cycle++) {
      const res = phaseSolver.applyLazyMicroBending(wire, wireMat, 1.5, vm.core.grid);
      expect(res.heatDissipated).toBeGreaterThan(0);
      expect(res.jammedResidual).toBeGreaterThan(0);
    }
    vm.step(1 / 60);
    const wireFrags = vm.repository.entities.filter((e) => e.id.startsWith('fatigue_wire_frag_'));
    expect(wireFrags.length).toBe(2);

    // 2. 形状記憶合金: 加熱 (U_vib > E_act) により記憶された元の形状 [1,1,1] へ復元すること
    const sma = vm.repository.entities.find((e) => e.id === 'sma_spring')!;
    expect(sma.currentShapeScale![0]).toBeCloseTo(1.4, 2);
    sma.internalHeat = 4.0; // metastableWellBarrier (2.2) 以上へ加熱
    for (let i = 0; i < 25; i++) {
      vm.step(1 / 60);
    }
    expect(sma.currentShapeScale![0]).toBeLessThan(1.1);
    expect(sma.currentShapeScale![1]).toBeGreaterThan(0.9);
    expect(sma.residualStrain!).toBeLessThan(0.2);
  });

  it('11. マルチスケール極小での波動染み出し(量子トンネル)＆自己組織化結晶ロックテスト', () => {
    const repo = new SpaceStateRepository({
      ...createDefaultCoreConfig(),
      cellSize: 1e-4, // 極小スケール
    });
    repo.externalSources = [];
    const crystalSeed: SpaceEntity = {
      id: 'crystal_seed',
      materialId: 'ice',
      position: [0, 1.5, 0],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.0002,
      mass: 1e-5,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0.1, // Ψ = 0.95 >= 0.85 (冷却固化中)
      anisotropyAxis: [1, 1, 0],
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };
    repo.entities = [crystalSeed];
    const core = new SpaceEngineCore(repo.config);
    const fieldSolver = core.getFieldSolver();

    // 1. 量子トンネル効果: スケールが極小ほど障壁透過確率が大きくなること
    const tMacro = fieldSolver.evaluateQuantumTunneling(10.0, 2.0, 1.0, 1.0);
    const tMicro = fieldSolver.evaluateQuantumTunneling(10.0, 2.0, 1.0, 1e-6);
    expect(tMicro).toBeGreaterThan(tMacro);
    expect(tMicro).toBeGreaterThan(0.9);

    // 2. 冷却固化時の自己組織化結晶配向ロック
    core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    expect(crystalSeed.crystalOrientation).toBeDefined();
    expect(
      Math.abs(crystalSeed.crystalOrientation![0]) + Math.abs(crystalSeed.crystalOrientation![1]),
    ).toBeGreaterThan(0.5);
  });
});
