import { describe, expect, it } from 'vitest';
import { SandboxViewModel } from '../src/viewmodel/SandboxViewModel';

describe('Phase 4: 相似性インスペクター・カスタムスポナー検証', () => {
  it('相似性比較インスペクター: 空間場の支配現象（気圧勾配 vs 渦度循環）を正しく判定すること', () => {
    const vm = new SandboxViewModel();
    vm.loadPreset('dipole_pair');
    for (let i = 0; i < 10; i++) {
      vm.step(1 / 60);
    }
    const statePhi = vm.getUiState();
    expect(statePhi.similarity.dominantPhenomenon).toContain('気圧偏差支配');
    expect(statePhi.similarity.microAnalogy).toContain('静電');
    expect(statePhi.similarity.macroAnalogy).toContain('万有引力');

    // 磁石プリセットでは渦度支配として検出されること
    vm.loadPreset('magnet_attraction');
    for (let i = 0; i < 10; i++) {
      vm.step(1 / 60);
    }
    const stateVort = vm.getUiState();
    expect(stateVort.similarity.dominantPhenomenon).toContain('渦度循環支配');
    expect(stateVort.similarity.microAnalogy).toContain('スピン');
    expect(stateVort.similarity.macroAnalogy).toContain('惑星磁場');
  });

  it('カスタムスポナー: 任意マテリアル・電荷・天体強度を指定して空間へスポーンし相互作用すること', () => {
    const vm = new SandboxViewModel();
    vm.loadPreset('gravity_rest');
    const initialCount = vm.repository.entities.length;

    const spawned = vm.spawnCustomEntity({
      materialId: 'neodymium_magnet',
      charge: 1.5,
      radius: 0.25,
      gravityStrength: 0,
    });

    expect(vm.repository.entities.length).toBe(initialCount + 1);
    expect(spawned.netCharge).toBe(1.5);
    expect(spawned.magneticMoment[1]).toBeGreaterThan(0);

    vm.step(1 / 60);
    const state = vm.getUiState();
    expect(state.renderSnapshots.some((s) => s.id === spawned.id)).toBe(true);
  });
});
