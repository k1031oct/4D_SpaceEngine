import { describe, expect, it } from 'vitest';
import { SpaceEngineCore } from '../src/core/SpaceEngineCore';
import { createDefaultCoreConfig, SpaceStateRepository } from '../src/data/SpaceStateRepository';

describe('Phase 1: コア空間演算ソルバ安定性ベンチマーク', () => {
  it('静止収束テスト: 重力射影下でオブジェクトが落下後に完全静止しドリフトしないこと', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.loadPreset('gravity_rest');
    const core = new SpaceEngineCore(repo.config);

    // 3秒間 (60fps * 3 = 180ステップ) シミュレーションを進める
    for (let i = 0; i < 180; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    // すべてのオブジェクトが床面で静止摩擦ロック状態（速度0）になっていること
    for (const ent of repo.entities) {
      expect(ent.isSleeping).toBe(true);
      expect(ent.velocity).toEqual([0, 0, 0]);
      expect(ent.position[1]).toBeCloseTo(repo.config.floorY + ent.radius, 3);
    }

    // さらに1秒進めても位置がドリフトしないこと
    const snapshotY = repo.entities.map((e) => e.position[1]);
    for (let i = 0; i < 60; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }
    repo.entities.forEach((ent, idx) => {
      expect(ent.position[1]).toBe(snapshotY[idx]);
      expect(ent.velocity).toEqual([0, 0, 0]);
    });
  });

  it('双極子ポアソンテスト: 正・負の歪みソースが空間場を介して引き合うこと', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.loadPreset('dipole_pair');
    const core = new SpaceEngineCore(repo.config);

    const initDist = Math.abs(repo.entities[1].position[0] - repo.entities[0].position[0]);

    // 衝突前の20ステップ（約0.33秒）で互いに近づいていること
    for (let i = 0; i < 20; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    const afterDist = Math.abs(repo.entities[1].position[0] - repo.entities[0].position[0]);
    expect(afterDist).toBeLessThan(initDist);
    expect(repo.entities[0].velocity[0]).toBeGreaterThan(0);
    expect(repo.entities[1].velocity[0]).toBeLessThan(0);
  });

  it('同符号斥力テスト: 同符号の歪みソースが空間場を介して反発し合うこと', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.loadPreset('repulsion_pair');
    const core = new SpaceEngineCore(repo.config);

    const initDist = Math.abs(repo.entities[1].position[0] - repo.entities[0].position[0]);

    for (let i = 0; i < 30; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    const afterDist = Math.abs(repo.entities[1].position[0] - repo.entities[0].position[0]);
    expect(afterDist).toBeGreaterThan(initDist);
  });

  it('ε-Cutoff テスト: 外乱のない真空状態ではパケットがスリープして計算を省略すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.entities = [];
    repo.externalSources = [];
    const core = new SpaceEngineCore(repo.config);

    const { metrics } = core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    expect(metrics.sleepingPacketRatio).toBeGreaterThan(0.95);
  });

  it('自己力抑止テスト: 孤立した単一電荷が自身の空間歪みで勝手に加速・ドリフトしないこと', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.externalSources = [];
    repo.entities = [
      {
        id: 'single_charge',
        materialId: 'rubber_balloon',
        position: [-0.31, 1.43, 0.12], // セル中心から意図的にずらした非対称座標
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.18,
        mass: 1.0,
        netCharge: 2.5,
        dipoleMoment: [0, 0, 0],
        magneticMoment: [0, 0, 0],
        internalHeat: 0,
        isGrounded: false,
        isGrabbed: false,
        isSleeping: false,
        domainClass: 'Visible',
      },
    ];
    const core = new SpaceEngineCore(repo.config);

    for (let i = 0; i < 60; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    const ent = repo.entities[0];
    const speed = Math.sqrt(
      ent.velocity[0] * ent.velocity[0] +
        ent.velocity[1] * ent.velocity[1] +
        ent.velocity[2] * ent.velocity[2],
    );
    // 非対称なセル位置にいても自己力による暴走が起きないこと
    expect(speed).toBeLessThan(0.2);
  });
});
