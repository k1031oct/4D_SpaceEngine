import { describe, expect, it } from 'vitest';
import { SpaceEngineCore } from '../src/core/SpaceEngineCore';
import { createDefaultCoreConfig, SpaceStateRepository } from '../src/data/SpaceStateRepository';

describe('Phase 2: マテリアル物性・摩擦帯電・静電誘導・磁気創発ベンチマーク', () => {
  it('摩擦帯電テスト: ゴム風船とウール布をこすり合わせると電子親和力差で帯電分離し総電荷が保存されること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.loadPreset('tribo_induction');
    const core = new SpaceEngineCore(repo.config);

    const balloon = repo.entities.find((e) => e.id === 'balloon')!;
    const wool = repo.entities.find((e) => e.id === 'wool')!;

    // ウール布を押さえながら風船を接触させて横方向にこすり合わせる
    balloon.isGrabbed = true;
    wool.isGrabbed = true;
    for (let i = 0; i < 30; i++) {
      balloon.position = [wool.position[0] - 0.1 + (i % 2 === 0 ? 0.05 : -0.05), wool.position[1] + 0.35, 0.0];
      balloon.velocity = [i % 2 === 0 ? 1.5 : -1.5, -0.5, 0];
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    expect(balloon.netCharge).toBeLessThan(-0.1);
    expect(wool.netCharge).toBeGreaterThan(0.1);
    // 電荷保存則
    expect(balloon.netCharge + wool.netCharge).toBeCloseTo(0, 4);
    expect(balloon.internalHeat).toBeGreaterThan(0);
  });

  it('静電誘導テスト: 帯電した風船を中性紙片に近づけると分極引力(∇|∇Φ|²)で吸い寄せられること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.loadPreset('tribo_induction');
    const core = new SpaceEngineCore(repo.config);

    const balloon = repo.entities.find((e) => e.id === 'balloon')!;
    const paper = repo.entities.find((e) => e.id === 'paper_piece')!;

    // 紙片を一旦床に落ち着かせる
    for (let i = 0; i < 30; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    // 帯電した風船を紙片の斜め上に配置して固定
    balloon.isGrabbed = true;
    balloon.netCharge = -3.5;
    balloon.position = [paper.position[0] + 0.1, paper.position[1] + 0.7, 0.0];
    balloon.velocity = [0, 0, 0];

    const initY = paper.position[1];
    // 接触前の8ステップで静電誘導力によって紙片が中性のまま浮き上がること
    for (let i = 0; i < 8; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    expect(paper.netCharge).toBe(0);
    expect(paper.position[1]).toBeGreaterThan(initY + 0.01);
  });

  it('アース放電テスト: 帯電した物体が鋼板アースに触れると電荷が0へ放電されること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.loadPreset('tribo_induction');
    const core = new SpaceEngineCore(repo.config);

    const balloon = repo.entities.find((e) => e.id === 'balloon')!;
    const earth = repo.entities.find((e) => e.id === 'earth_plate')!;

    balloon.netCharge = -3.0;
    balloon.isGrabbed = true;
    // 紙片と干渉しない鋼板アースの右側に接触させる
    balloon.position = [earth.position[0] + (balloon.radius + earth.radius) * 0.9, earth.position[1], 0];

    for (let i = 0; i < 60; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    expect(Math.abs(balloon.netCharge)).toBeLessThan(0.1);
  });

  it('ケルビン磁力テスト: ネオジム磁石の渦度勾配(∇|ω|²)により鉄球が引き寄せられること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.loadPreset('magnet_attraction');
    const core = new SpaceEngineCore(repo.config);

    const magnet = repo.entities.find((e) => e.id === 'magnet')!;
    const iron = repo.entities.find((e) => e.id === 'iron_sphere')!;
    const initDist = Math.abs(iron.position[0] - magnet.position[0]);

    for (let i = 0; i < 60; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    const afterDist = Math.abs(iron.position[0] - magnet.position[0]);
    expect(afterDist).toBeLessThan(initDist - 0.05);
  });
});
