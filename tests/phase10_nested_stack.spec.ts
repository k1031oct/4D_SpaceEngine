import { describe, expect, it } from 'vitest';
import { NestedPerceptualStack } from '../src/core/NestedPerceptualStack';
import { PhaseTransitionSolver } from '../src/core/PhaseTransitionSolver';
import { SpaceEngineCore } from '../src/core/SpaceEngineCore';
import type { ObserverState, SpaceEntity } from '../src/core/types';
import { createDefaultCoreConfig, SpaceStateRepository } from '../src/data/SpaceStateRepository';

describe('Phase 10: 複数レイヤー入れ子知覚スタック ＆ 階層跨ぎ・双方向相転移 (5項目)', () => {
  it('1. 対数桁数スライド階層＆時間階層間引きテスト: Layer -1〜+3が構築され、stride(4/16/60)で更新間引きされること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const air = repo.media.get('air')!;

    let lastSnapshots = core.step([], repo.materials, [], 1 / 60, undefined, air, repo.media).metrics
      .layerSnapshots!;
    expect(lastSnapshots.length).toBe(5);
    expect(lastSnapshots.map((s) => s.layerId)).toEqual([-1, 0, 1, 2, 3]);

    const l0 = lastSnapshots.find((s) => s.layerId === 0)!;
    const l1 = lastSnapshots.find((s) => s.layerId === 1)!;
    const l2 = lastSnapshots.find((s) => s.layerId === 2)!;
    const l3 = lastSnapshots.find((s) => s.layerId === 3)!;
    expect(l1.cellSize / l0.cellSize).toBeCloseTo(Math.pow(10, 2.5), 1);
    expect(l2.cellSize / l0.cellSize).toBeCloseTo(Math.pow(10, 5.5), -1);
    expect(l3.cellSize / l0.cellSize).toBeCloseTo(Math.pow(10, 9.0), -4);

    // 4フレーム目まで進めると Layer +1 (stride=4) は更新され、Layer +2 (stride=16), +3 (stride=60) は未更新
    for (let f = 2; f <= 4; f++) {
      lastSnapshots = core.step([], repo.materials, [], 1 / 60, undefined, air, repo.media).metrics
        .layerSnapshots!;
    }
    expect(lastSnapshots.find((s) => s.layerId === 1)!.lastUpdatedFrame).toBe(4);
    expect(lastSnapshots.find((s) => s.layerId === 2)!.lastUpdatedFrame).toBe(0);
    expect(lastSnapshots.find((s) => s.layerId === 3)!.lastUpdatedFrame).toBe(0);
  });

  it('2. 10^-6m デカップリング定理テスト: 巨視的スケールでは Layer -1 がスリープし、極小ズームで起動すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);

    // 通常スケール (0.25m >= 1e-6m): Layer -1 はデカップリングでスキップ
    const macroObs: ObserverState = {
      position: [2, 2, 2],
      velocity: [0, 0, 0],
      focusPoint: [0, 1.5, 0],
      manualScaleLog10: Math.log10(0.25),
      tau: 0.1,
    };
    const macroRes = core.step([], repo.materials, [], 1 / 60, macroObs);
    const lMinusMacro = macroRes.metrics.layerSnapshots!.find((s) => s.layerId === -1)!;
    expect(lMinusMacro.isDecoupled).toBe(true);

    // 極小スケール (10^-7m < 1e-6m): Layer -1 がアクティブ化
    const microObs: ObserverState = {
      ...macroObs,
      manualScaleLog10: -7.0,
    };
    const microRes = core.step([], repo.materials, [], 1 / 60, microObs);
    const lMinusMicro = microRes.metrics.layerSnapshots!.find((s) => s.layerId === -1)!;
    expect(lMinusMicro.isDecoupled).toBe(false);
    expect(NestedPerceptualStack.DECOUPLING_SCALE_LIMIT).toBe(1e-6);
  });

  it('3. 上下双方向カスケード（バタフライエフェクト）テスト: Layer 0 境界熱が Layer +1 へ流出し還流すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const air = repo.media.get('air')!;
    core.getBackend().syncMediumBaseline(core.grid, air);

    // Layer 0 境界付近 (x=1, y=1, z=8) に熱と上昇流を注入
    const edgeIdx = core.grid.index(1, 1, 8);
    core.grid.vibrationEnergy[edgeIdx] = 20.0;
    core.grid.py[edgeIdx] = 3.0;

    let l1Heat = 0;
    for (let f = 0; f < 4; f++) {
      const res = core.step(
        [],
        repo.materials,
        [{ id: 'g', uniformField: [0, -9.8, 0] }],
        1 / 60,
        undefined,
        air,
        repo.media,
      );
      l1Heat = res.metrics.layerSnapshots!.find((s) => s.layerId === 1)!.totalHeat;
    }
    expect(l1Heat).toBeGreaterThan(0.5);

    // Layer +1 の還流により Layer 0 の他境界セルにもわずかな還流運動量が届くこと
    const otherEdgeIdx = core.grid.index(3, 1, 3);
    expect(Math.abs(core.grid.py[otherEdgeIdx])).toBeGreaterThan(0);
  });

  it('4. 階層跨ぎハンドオフ（Cross-Layer Handoff）テスト: 観測者移動で窓外へ出た物体が消滅せず継続運動し、再接近で復帰すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);

    const flyer: SpaceEntity = {
      id: 'flyer_1',
      materialId: 'iron_ball',
      position: [0, 1.5, 0],
      velocity: [2.0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: 0.15,
      shape: 'sphere',
      mass: 1.0,
      netCharge: 1.2,
      dipoleMoment: [0, 0, 0],
      magneticMoment: [0, 0, 0],
      internalHeat: 3.5,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };

    // 1. 観測者を遠く (-20, 1.5, 0) へ移動させ、flyer_1 を Layer 0 窓外へ出す
    const farObserver: ObserverState = {
      position: [-20, 3, 4],
      velocity: [0, 0, 0],
      focusPoint: [-20, 1.5, 0],
      manualScaleLog10: Math.log10(0.25),
      tau: 0.1,
    };

    let entities: SpaceEntity[] = [flyer];
    let stepRes = core.step(entities, repo.materials, [], 1 / 60, farObserver);
    entities = stepRes.entities;

    expect(entities.find((e) => e.id === 'flyer_1')).toBeUndefined();
    expect(stepRes.metrics.handedOffEntityCount).toBe(1);

    // 窓外にある間も上位レイヤーで等速運動を継続 (10ステップ経過)
    for (let i = 0; i < 10; i++) {
      stepRes = core.step(entities, repo.materials, [], 1 / 60, farObserver);
      entities = stepRes.entities;
    }
    const tracked = core.getNestedStack().getHandedOffEntity('flyer_1')!;
    expect(tracked).toBeDefined();
    expect(tracked.position[0]).toBeGreaterThan(0.25);

    // 2. 観測者が移動先にフォーカスを戻すと、flyer_1 が Visible として Layer 0 に Unpack 復帰する
    const returnObserver: ObserverState = {
      ...farObserver,
      focusPoint: [tracked.position[0], 1.5, 0],
    };
    const returnRes = core.step(entities, repo.materials, [], 1 / 60, returnObserver);
    const restored = returnRes.entities.find((e) => e.id === 'flyer_1')!;
    expect(restored).toBeDefined();
    expect(restored.domainClass).toBe('Visible');
    expect(restored.netCharge).toBeCloseTo(1.2, 5);
    expect(restored.internalHeat).toBeCloseTo(3.5, 2);
    expect(returnRes.metrics.handedOffEntityCount).toBe(0);
  });

  it('5. 「場（ガス）」↔「オブジェクト（凝縮体）」双方向相転移テスト: 過飽和低温場から固体が凝縮生成され、気化で場へ厳密還元されること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const air = repo.media.get('air')!;
    core.getBackend().syncMediumBaseline(core.grid, air);

    // A. 凝縮昇格（場 → 実体）：高密度・高濃度・低温セルを構築
    const cIdx = core.grid.index(7, 7, 7);
    core.grid.mediumConcentration[cIdx] = 0.98;
    core.grid.mediumDensity[cIdx] = 0.12;
    core.grid.vibrationEnergy[cIdx] = 0.005;
    const densBefore = core.grid.mediumDensity[cIdx];

    const stepRes = core.step([], repo.materials, [], 1 / 60, undefined, air, repo.media);
    expect(stepRes.metrics.condensedEntityCount).toBeGreaterThan(0);
    const condensedObj = stepRes.entities.find((e) => e.id.startsWith('condensate_'))!;
    expect(condensedObj).toBeDefined();
    expect(core.grid.mediumDensity[cIdx]).toBeLessThan(densBefore);

    // B. 気化還元（実体 → 場）：実体の質量・電荷・熱が空間パケットへ厳密保存で溶け込むこと
    const phaseSolver = new PhaseTransitionSolver();
    const vaporTarget: SpaceEntity = {
      ...condensedObj,
      id: 'vapor_test',
      mass: 0.02,
      netCharge: 0.5,
      internalHeat: 4.0,
    };
    const [gx, gy, gz] = core.grid.worldToGrid(vaporTarget.position);
    const vIdx = core.grid.index(Math.round(gx), Math.round(gy), Math.round(gz));
    const medMassBefore = core.grid.mediumDensity[vIdx] * core.grid.cellVolume;
    const heatBefore = core.grid.vibrationEnergy[vIdx];

    phaseSolver.vaporizeToField(vaporTarget, core.grid);

    const medMassAfter = core.grid.mediumDensity[vIdx] * core.grid.cellVolume;
    expect(medMassAfter - medMassBefore).toBeCloseTo(0.02, 5);
    expect(core.grid.vibrationEnergy[vIdx] - heatBefore).toBeCloseTo(4.0, 5);
  });
});
