import { describe, expect, it } from 'vitest';
import { ContactSolver } from '../src/core/ContactSolver';
import { PhaseTransitionSolver } from '../src/core/PhaseTransitionSolver';
import { DualPacketizer } from '../src/core/DualPacketizer';
import { SpaceEngineCore } from '../src/core/SpaceEngineCore';
import type { MaterialSpec, SpaceEntity } from '../src/core/types';
import { createDefaultCoreConfig, SpaceStateRepository } from '../src/data/SpaceStateRepository';

describe('Phase 9: 非創発ハードコード一掃＆完全第一原理リファクタリング検証 (8項目)', () => {
  it('1. 摩擦熱の厳密エネルギー保存テスト: 定在波の檻突破時の運動エネルギー損失＋蓄積歪み＝発生熱量であること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const config = { ...repo.config, floorY: -Infinity };
    const solver = new ContactSolver();

    const a: SpaceEntity = {
      id: 'slider_a',
      materialId: 'iron_ball',
      position: [-0.025, 1.0, 0],
      velocity: [1.5, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.2,
      shape: 'sphere',
      mass: 1.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0,
      trapEnergyStored: 0.2,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };
    const b: SpaceEntity = {
      id: 'slider_b',
      materialId: 'paper',
      position: [0.025, 1.399, 0], // 1ステップ後に x=0 で overlap = 0.001 <= 0.002 の純粋接線摩擦
      velocity: [-1.5, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.2,
      shape: 'sphere',
      mass: 1.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0,
      trapEnergyStored: 0.1,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };

    const keBefore =
      0.5 * a.mass * (a.velocity[0] ** 2 + a.velocity[1] ** 2 + a.velocity[2] ** 2) +
      0.5 * b.mass * (b.velocity[0] ** 2 + b.velocity[1] ** 2 + b.velocity[2] ** 2);
    const trapBefore = (a.trapEnergyStored ?? 0) + (b.trapEnergyStored ?? 0);
    const heatBefore = a.internalHeat + b.internalHeat;

    solver.solve([a, b], repo.materials, 1 / 60, config);

    const keAfter =
      0.5 * a.mass * (a.velocity[0] ** 2 + a.velocity[1] ** 2 + a.velocity[2] ** 2) +
      0.5 * b.mass * (b.velocity[0] ** 2 + b.velocity[1] ** 2 + b.velocity[2] ** 2);
    const trapAfter = (a.trapEnergyStored ?? 0) + (b.trapEnergyStored ?? 0);
    const heatAfter = a.internalHeat + b.internalHeat;

    const totalBefore = keBefore + trapBefore + heatBefore;
    const totalAfter = keAfter + trapAfter + heatAfter;
    expect(heatAfter).toBeGreaterThan(heatBefore);
    expect(totalAfter).toBeCloseTo(totalBefore, 5);
  });

  it('2. 電子親和力差 Δχ に基づく創発電池電圧テスト: 固定値2.5ではなく電極間のΔχに応じて電流が変化すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const lowChiMat: MaterialSpec = {
      ...repo.materials.get('copper_wire')!,
      id: 'low_chi_electrode',
      electronAffinity: 0.1,
    };
    const midChiMat: MaterialSpec = {
      ...repo.materials.get('copper_wire')!,
      id: 'mid_chi_electrode',
      electronAffinity: 0.4,
    };
    const highChiMat: MaterialSpec = {
      ...repo.materials.get('copper_wire')!,
      id: 'high_chi_electrode',
      electronAffinity: 1.8,
    };

    const customMats = new Map(repo.materials);
    customMats.set(lowChiMat.id, lowChiMat);
    customMats.set(midChiMat.id, midChiMat);
    customMats.set(highChiMat.id, highChiMat);

    const runCircuit = (anodeMatId: string, cathodeMatId: string): number => {
      const solver = new ContactSolver();
      const anode: SpaceEntity = {
        id: 'anode',
        materialId: anodeMatId,
        position: [0, 0.2, 0],
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.15,
        shape: 'sphere',
        mass: 1,
        netCharge: 0,
        dipoleMoment: [0, 0, 0],
        magneticMoment: [0, 0, 0],
        internalHeat: 0,
        isGrounded: true,
        isGrabbed: false,
        isSleeping: false,
        domainClass: 'Visible',
        groupId: 1,
        groupRole: 'anode',
      };
      const sep: SpaceEntity = {
        ...anode,
        id: 'sep',
        position: [0.2, 0.2, 0],
        groupRole: 'separator',
        chemicalEnergy: 50,
      };
      const cathode: SpaceEntity = {
        ...anode,
        id: 'cathode',
        materialId: cathodeMatId,
        position: [0.4, 0.2, 0],
        groupRole: 'cathode',
      };
      const wire: SpaceEntity = {
        ...anode,
        id: 'wire',
        materialId: 'copper_wire',
        position: [0.2, 0.3, 0],
        radius: 0.3,
        groupRole: 'wire',
      };
      let lastCurrent = 0;
      for (let i = 0; i < 15; i++) {
        lastCurrent = solver.solve([anode, sep, cathode, wire], customMats, 1 / 60, repo.config);
      }
      return lastCurrent;
    };

    const smallDeltaCurrent = runCircuit('low_chi_electrode', 'mid_chi_electrode');
    const largeDeltaCurrent = runCircuit('low_chi_electrode', 'high_chi_electrode');
    expect(smallDeltaCurrent).toBeGreaterThan(0);
    expect(largeDeltaCurrent).toBeGreaterThan(smallDeltaCurrent * 2.0);
  });

  it('3. ローレンツ振動子連続光相互作用＆エネルギー保存テスト: 全周波数で T+R+A=1 かつ連続分散すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const glass = repo.materials.get('glass_prism')!;
    const bulb = repo.materials.get('tungsten_bulb')!;
    const copper = repo.materials.get('copper_wire')!;

    for (const freq of [1.0, 4.0, 6.0, 8.0, 12.0, 20.0, 35.0]) {
      for (const mat of [glass, bulb, copper]) {
        const res = core.evaluateLightInteraction(mat, freq);
        expect(res.transmittance + res.reflectance + res.absorption).toBeCloseTo(1.0, 6);
        expect(res.transmittance).toBeGreaterThanOrEqual(0);
        expect(res.reflectance).toBeGreaterThanOrEqual(0);
        expect(res.absorption).toBeGreaterThanOrEqual(0);
      }
    }

    // 共鳴点 (w = w0) 近傍の吸収が非共鳴点より高いこと
    const atResonance = core.evaluateLightInteraction(bulb, bulb.resonantFrequency!);
    const offResonance = core.evaluateLightInteraction(bulb, bulb.resonantFrequency! * 2.5);
    expect(atResonance.absorption).toBeGreaterThan(offResonance.absorption);
  });

  it('4. 密度差アルキメデス浮力対流＆3軸風上移流テスト: ヘリウム密度差による上昇対流と水平移流が成立すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const air = repo.media.get('air')!;
    core.getBackend().syncMediumBaseline(core.grid, air);

    // 同温のままヘリウムブラシを注入（密度差のみで上昇対流が創発）
    const centerPos = core.grid.packetCenter(8, 6, 8);
    core.injectBrush(centerPos, 0.5, 'helium', 1.0, repo.media);
    // injectBrushによる初速を一旦リセットして、純粋な密度差浮力による加速を確認
    const idx = core.grid.index(8, 6, 8);
    core.grid.py[idx] = 0;

    for (let i = 0; i < 10; i++) {
      core.step([], repo.materials, [{ id: 'g', uniformField: [0, -9.8, 0] }], 1 / 60, undefined, air, repo.media);
    }
    expect(core.grid.py[idx]).toBeGreaterThan(0);

    // 3軸風上移流：x方向に強い流れを与えて熱エネルギーと酸化剤ポテンシャルが隣接セルへ運ばれること
    const srcIdx = core.grid.index(5, 8, 8);
    const dstIdx = core.grid.index(6, 8, 8);
    core.grid.px[srcIdx] = 5.0;
    core.grid.vibrationEnergy[srcIdx] = 10.0;
    core.grid.vibrationEnergy[dstIdx] = 0.0;
    core.grid.reactivityPotential[srcIdx] = 0.9;
    core.grid.reactivityPotential[dstIdx] = 0.1;

    core.step([], repo.materials, [{ id: 'g', uniformField: [0, -9.8, 0] }], 1 / 60, undefined, air, repo.media);
    expect(core.grid.vibrationEnergy[dstIdx]).toBeGreaterThan(0.05);
    expect(core.grid.reactivityPotential[dstIdx]).toBeGreaterThan(0.1);
  });

  it('5. 汎用準安定障壁による形状記憶復元（ID非依存テスト）: 任意IDの物体でも障壁超過で形状復元すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const solver = new PhaseTransitionSolver();
    const customMat: MaterialSpec = {
      ...repo.materials.get('iron_ball')!,
      id: 'custom_generic_alloy',
      metastableWellBarrier: 3.0,
    };
    const mats = new Map(repo.materials);
    mats.set(customMat.id, customMat);

    const ent: SpaceEntity = {
      id: 'generic_shape_obj',
      materialId: 'custom_generic_alloy',
      position: [0, 1, 0],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.2,
      shape: 'cylinder',
      mass: 1.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 3.5, // metastableWellBarrier (3.0) を超過
      memorizedShapeScale: [1, 1, 1],
      currentShapeScale: [1.5, 0.6, 1],
      residualStrain: 2.0,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };

    solver.solve([ent], mats, 0.1);
    expect(ent.currentShapeScale![0]).toBeLessThan(1.5);
    expect(ent.currentShapeScale![1]).toBeGreaterThan(0.6);
    expect(ent.residualStrain!).toBeLessThan(2.0);
  });

  it('6. Lazy Micro-Unpack 3分岐エネルギー保存則テスト: 外力曲げエネルギーが弾性・熱・残留歪みに厳密保存分配されること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const solver = new PhaseTransitionSolver();
    const mat = repo.materials.get('metal_wire')!;

    const wire: SpaceEntity = {
      id: 'bend_wire',
      materialId: 'metal_wire',
      position: [0, 1, 0],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.15,
      shape: 'cylinder',
      mass: 0.5,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0,
      elasticEnergy: 0,
      residualStrain: 0,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };

    const inputEnergy = 10.0;
    const res = solver.applyLazyMicroBending(wire, mat, inputEnergy);
    expect(res.elasticRecovered + res.heatDissipated + res.jammedResidual).toBeCloseTo(inputEnergy, 6);
    expect((wire.elasticEnergy ?? 0) + wire.internalHeat + (wire.residualStrain ?? 0)).toBeCloseTo(
      inputEnergy,
      6,
    );
  });

  it('7. DualPacketizer ヒステリシス・相対障壁・歪み還元テスト: チャタリング防止と展開時の歪み伝播が機能すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const packetizer = new DualPacketizer();
    const mats = new Map(repo.materials);
    mats.set('fragile_mat', {
      ...repo.materials.get('paper')!,
      id: 'fragile_mat',
      bindingEnergy: 8.0, // 従来のハードコード15.0未満
    });

    const mkChild = (id: string, pos: [number, number, number]): SpaceEntity => ({
      id,
      materialId: 'fragile_mat',
      position: pos,
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.18, // cellSize=1.0 なら 0.18 < 0.20 で Pack される
      shape: 'sphere',
      mass: 0.5,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 1.0,
      residualStrain: 0,
      elasticEnergy: 0,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    });

    // 1. cellSize = 1.0 (0.18 < 0.20) で Pack
    let list = packetizer.synchronize(
      [mkChild('c1', [0.2, 0.2, 0.2]), mkChild('c2', [0.3, 0.2, 0.2])],
      1.0,
      mats,
    );
    const cluster = list.find((e) => e.id.startsWith('cluster_'))!;
    expect(cluster).toBeDefined();

    // クラスターへ歪み・弾性エネルギーを蓄積
    cluster.residualStrain = (cluster.residualStrain ?? 0) + 1.2;
    cluster.elasticEnergy = (cluster.elasticEnergy ?? 0) + 0.8;

    // 2. ヒステリシス帯 cellSize = 0.75 (0.18 / 0.75 = 0.24 ∈ [0.20, 0.28)) では展開せず維持
    list = packetizer.synchronize(list, 0.75, mats);
    expect(list.some((e) => e.id.startsWith('cluster_'))).toBe(true);

    // 3. cellSize = 0.60 (0.18 >= 0.28 * 0.60 = 0.168) で Unpack され、歪み・弾性エネルギーが子へ還元
    list = packetizer.synchronize(list, 0.6, mats);
    expect(list.some((e) => e.id.startsWith('cluster_'))).toBe(false);
    const c1 = list.find((e) => e.id === 'c1')!;
    const c2 = list.find((e) => e.id === 'c2')!;
    expect(c1.residualStrain).toBeCloseTo(0.6, 5);
    expect(c2.elasticEnergy).toBeCloseTo(0.4, 5);

    // 4. 相対バインディング障壁 (bindingEnergy = 8.0) でホットスポット臨界判定が動作すること
    const packetizer2 = new DualPacketizer();
    const hotA = mkChild('h1', [0.2, 0.2, 0.2]);
    hotA.internalHeat = 12.0; // meanE + peakDev >= 8.0 かつ < 15.0 の領域
    const hotB = mkChild('h2', [0.3, 0.2, 0.2]);
    hotB.internalHeat = 6.0;
    const list2 = packetizer2.synchronize([hotA, hotB], 1.0, mats);
    const cluster2 = list2.find((e) => e.id.startsWith('cluster_'))!;
    expect(cluster2.isCriticalSubgrid).toBe(true);
  });

  it('8. 空間パケット ⇄ エンティティ双方向熱交換＆真空断熱テスト: 大気中で双方向伝熱し真空では断熱されること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const air = repo.media.get('air')!;
    const vacuum = repo.media.get('vacuum')!;

    // A. 大気中：高温空間パケット → 冷たい物体 への熱流入
    const coreAir = new SpaceEngineCore(repo.config);
    const coldObj: SpaceEntity = {
      id: 'cold_obj',
      materialId: 'iron_ball',
      position: [0, 1.5, 0],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.15,
      shape: 'sphere',
      mass: 1.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 0.0,
      isGrounded: true,
      isGrabbed: false,
      isSleeping: true,
      domainClass: 'Visible',
    };
    coreAir.getBackend().syncMediumBaseline(coreAir.grid, air);
    coreAir.injectBrush([0, 1.5, 0], 0.4, 'light_pulse', 2.0, repo.media);
    coreAir.step([coldObj], repo.materials, [], 1 / 60, undefined, air, repo.media);
    expect(coldObj.internalHeat).toBeGreaterThan(0.01);

    // B. 大気中：高温物体 → 冷たい空間パケット への放熱
    const hotObj: SpaceEntity = { ...coldObj, id: 'hot_obj', internalHeat: 15.0 };
    const coreAir2 = new SpaceEngineCore(repo.config);
    coreAir2.getBackend().syncMediumBaseline(coreAir2.grid, air);
    const [gx, gy, gz] = coreAir2.grid.worldToGrid(hotObj.position);
    const idx = coreAir2.grid.index(Math.round(gx), Math.round(gy), Math.round(gz));
    const gridHeatBefore = coreAir2.grid.vibrationEnergy[idx];
    coreAir2.step([hotObj], repo.materials, [], 1 / 60, undefined, air, repo.media);
    expect(coreAir2.grid.vibrationEnergy[idx]).toBeGreaterThan(gridHeatBefore);

    // C. 真空中：C_med = 0 のため、高温物体と空間パケットの間で熱交換が起きない（真空断熱）
    const hotVacObj: SpaceEntity = { ...coldObj, id: 'hot_vac', internalHeat: 15.0 };
    const coreVac = new SpaceEngineCore(repo.config);
    coreVac.getBackend().syncMediumBaseline(coreVac.grid, vacuum);
    const idxVac = coreVac.grid.index(Math.round(gx), Math.round(gy), Math.round(gz));
    coreVac.grid.vibrationEnergy[idxVac] = 0.0;
    coreVac.step([hotVacObj], repo.materials, [], 1 / 60, undefined, vacuum, repo.media);
    expect(coreVac.grid.vibrationEnergy[idxVac]).toBeCloseTo(0.0, 6);
  });
});
