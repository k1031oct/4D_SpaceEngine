import { describe, expect, it } from 'vitest';
import { DualPacketizer } from '../src/core/DualPacketizer';
import { SpaceEngineCore } from '../src/core/SpaceEngineCore';
import type { SpaceEntity } from '../src/core/types';
import { createDefaultCoreConfig, SpaceStateRepository } from '../src/data/SpaceStateRepository';
import { SandboxViewModel } from '../src/viewmodel/SandboxViewModel';

describe('Phase 6-7: 統合空間演算アーキテクチャ検証スイート (9項目)', () => {
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
      velocity: [3.5, -0.5, 0], // 限界を超える強い接線速度
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

    // 接触して限界突破・決壊すると蓄積エネルギーが熱 U_vib へ放出される
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

    // 導線と電球が接続された状態で電流が流れ、電球がジュール発熱すること
    for (let i = 0; i < 30; i++) {
      vm.step(1 / 60);
    }
    const stateMid = vm.getUiState();
    expect(stateMid.circuitCurrent).toBeGreaterThan(0.1);
    expect(bulb.internalHeat).toBeGreaterThan(0.05);
    expect(sep.chemicalEnergy!).toBeLessThan(initChem);

    // 化学エネルギーが枯渇すると電流が停止すること
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
      internalHeat: 16.0, // 局所ホットスポット
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };

    // 1. 粗視化 (L = 2.0m) で統合：2次分散・極値・異方性軸・臨界フラグが保持される
    const packed = packetizer.synchronize([coldPart, hotSpot], 2.0);
    const cluster = packed.find((e) => e.id.startsWith('cluster_'))!;
    expect(cluster).toBeDefined();
    expect(cluster.deviationVariance).toBeGreaterThan(10.0);
    expect(cluster.peakDeviation).toBeGreaterThan(5.0);
    expect(Math.abs(cluster.anisotropyAxis![0])).toBeGreaterThan(0.1);
    expect(cluster.isCriticalSubgrid).toBe(true);

    // 2. 臨界アップスケールトリガーにより、粗いスケールのままでも次ステップで即座に展開されること
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

    // 1. 下部 (y=2) を温風加熱すると、上向き気流 (py > 0) による対流が起きること
    const lowerPos = grid.packetCenter(8, 3, 8);
    medSolver.injectBrush(grid, lowerPos, 0.5, 'hot_air', 2.0);
    for (let i = 0; i < 10; i++) {
      vm.step(1 / 60);
    }
    const idxLower = grid.index(8, 3, 8);
    expect(grid.py[idxLower]).toBeGreaterThan(0);

    // 2. 中間層 (y=7) を真空吸引 (C_med = 0) すると、y=5 の熱が y=9 へ伝導遮断されること
    const vacCenter = grid.packetCenter(8, 7, 8);
    medSolver.injectBrush(grid, vacCenter, 2.0, 'vacuum', 1.0);
    const idxHot = grid.index(8, 4, 8);
    const idxColdAcrossVac = grid.index(8, 11, 8);
    grid.vibrationEnergy[idxHot] = 20.0;
    const coldBefore = grid.vibrationEnergy[idxColdAcrossVac];
    for (let i = 0; i < 10; i++) {
      vm.step(1 / 60);
    }
    // 真空断熱により反対側へ熱がほとんど伝わらない
    expect(grid.vibrationEnergy[idxColdAcrossVac] - coldBefore).toBeLessThan(0.05);
  });

  it('5. ヘリウム風船の浮上と破裂発散テスト: 浮上後に外殻破断すると放射衝撃波とヘリウム拡散が起きること', () => {
    const vm = new SandboxViewModel();
    vm.loadPreset('helium_balloon_burst');
    const balloon = vm.repository.entities.find((e) => e.id === 'he_balloon')!;
    const initY = balloon.position[1];

    // 1. 空気中でアルキメデス浮力により自然に浮上すること
    for (let i = 0; i < 45; i++) {
      vm.step(1 / 60);
    }
    expect(balloon.position[1]).toBeGreaterThan(initY + 0.05);

    // 外殻破断 (elasticEnergy > bindingEnergy) で破裂：破片分裂と放射状圧力波が生成される
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

    // インピーダンスが一致 (Z1 = Z2 = 1.5) なら波動は 100% 透過、不整合なら反射が増える
    const matched = fieldSolver.evaluateHollowTransmissionAndPermeation(1.5, 1.5, 0.1, 0.03);
    const mismatched = fieldSolver.evaluateHollowTransmissionAndPermeation(1.5, 8.0, 0.1, 0.03);
    expect(matched.waveTransmittance).toBeCloseTo(1.0, 4);
    expect(mismatched.waveTransmittance).toBeLessThan(0.6);

    // すき間 d_gap = 0.1 に対し、小粒子 (r=0.03 -> 径0.06) は浸透可能、大粒子 (r=0.08 -> 径0.16) は不可
    expect(matched.canPermeate).toBe(true);
    const blocked = fieldSolver.evaluateHollowTransmissionAndPermeation(1.5, 1.5, 0.1, 0.08);
    expect(blocked.canPermeate).toBe(false);
  });

  it('7. 光相互作用テスト: 固有共鳴周波数と導電率に応じて透過・鏡面反射・共鳴吸収発熱が分岐すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const fieldSolver = core.getFieldSolver();

    // ガラスプリズム (ω0=20, 絶縁体) に可視光 (ω=8) → 高透過
    const glassRes = fieldSolver.evaluateLightInteraction(repo.materials.get('glass_prism'), 8.0);
    expect(glassRes.transmittance).toBeGreaterThan(0.85);

    // 銅線 (ω0=15, 良導体) に低周波光 (ω=8) → 高反射
    const metalRes = fieldSolver.evaluateLightInteraction(repo.materials.get('copper_wire'), 8.0);
    expect(metalRes.reflectance).toBeGreaterThan(0.85);

    // タングステン (ω0=6) に共鳴光 (ω=6) → 共鳴吸収発熱
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
      magneticMoment: [0, 0, 0], // 初期は非着磁
      internalHeat: 0,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };
    repo.entities = [iron];
    const core = new SpaceEngineCore(repo.config);

    // 1. 保磁力障壁 (0.25) を超える強い外部渦度を印加 → 着磁（磁気モーメント獲得）
    core.grid.wy.fill(2.5);
    core.grid.isSleeping.fill(0);
    for (let i = 0; i < 15; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }
    expect(iron.magneticMoment[1]).toBeGreaterThan(1.0);

    // 2. 加熱して秩序度 Ψ を低下させる (Ψ < 0.35) → 熱擾乱により消磁すること
    core.grid.wy.fill(0);
    iron.internalHeat = 85.0; // bindingEnergy=100 → Ψ = 0.15 < 0.35
    for (let i = 0; i < 30; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }
    expect(iron.magneticMoment[1]).toBeLessThan(0.5);
  });

  it('9. 極限状態テスト: 極低温同種接触での冷間圧接 ＆ 臨界エネルギー集中でのブラックホール自己捕獲', () => {
    // (a) 冷間圧接 (Cold Welding)
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
        internalHeat: 0.005, // 極低温
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
        internalHeat: 0.005, // 極低温
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

    // (b) 高密度光焦点によるブラックホール（事象の地平面）創発と周囲物体の捕獲
    const vm = new SandboxViewModel();
    vm.loadPreset('black_hole_horizon');
    const c = vm.core.config.center;
    // 光パルスを一点に集中注入して非線形屈折率の臨界を超えさせる
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
});
