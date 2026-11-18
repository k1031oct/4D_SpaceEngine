import { describe, expect, it } from 'vitest';
import { DualPacketizer } from '../src/core/DualPacketizer';
import { SpaceEngineCore } from '../src/core/SpaceEngineCore';
import type { ObserverState, SpaceEntity } from '../src/core/types';
import { createDefaultCoreConfig, SpaceStateRepository } from '../src/data/SpaceStateRepository';

describe('Phase 3: 知覚スケール・双対パケッティング・3領域分類ベンチマーク', () => {
  it('スケール連続性テスト(机上): 地球がProjectedとなり境界シェル射影で机上物体が重力落下すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.loadPreset('multi_scale_solar');
    const core = new SpaceEngineCore(repo.config);

    const observer: ObserverState = {
      position: [2.8, 2.5, 3.6],
      velocity: [0, 0, 0],
      focusPoint: [0, 1.5, 0],
      manualScaleLog10: -0.6, // L ≈ 0.25m
      tau: 0.1,
    };

    const deskA = repo.entities.find((e) => e.id === 'desk_ball_a')!;
    const initY = deskA.position[1];

    for (let i = 0; i < 15; i++) {
      const res = core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60, observer);
      repo.entities = res.entities;
    }

    const planet = repo.entities.find((e) => e.id === 'planet_earth')!;
    expect(planet.domainClass).toBe('Projected');
    expect(deskA.domainClass).toBe('Visible');
    expect(deskA.position[1]).toBeLessThan(initY);
  });

  it('スケール連続性テスト(宇宙): ズームアウトで地球・月がVisibleとなり月が引力を受け軌道運動すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.loadPreset('multi_scale_solar');
    const core = new SpaceEngineCore(repo.config);
    core.config = { ...core.config, floorY: -Infinity };

    const observer: ObserverState = {
      position: [0, 50, 150],
      velocity: [0, 0, 0],
      focusPoint: [0, -20, 0],
      manualScaleLog10: 1.1, // L ≈ 12.6m (窓幅 ≈ 201m)
      tau: 0.1,
    };

    const moon = repo.entities.find((e) => e.id === 'moon_sat')!;
    const initMoonX = moon.position[0];

    for (let i = 0; i < 30; i++) {
      const res = core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60, observer);
      repo.entities = res.entities;
    }

    const planet = repo.entities.find((e) => e.id === 'planet_earth')!;
    expect(planet.domainClass).toBe('Visible');
    expect(moon.domainClass).toBe('Visible');
    // 地球の引力により月のX座標が中心方向へ引かれていること
    expect(moon.position[0]).toBeLessThan(initMoonX);
  });

  it('双対パケッティングテスト: 粗視化時に多重極展開でPackされ、細分化時にUnpackされること', () => {
    const packetizer = new DualPacketizer();
    const entities: SpaceEntity[] = [
      {
        id: 'a',
        materialId: 'rubber_balloon',
        position: [0.2, 0.2, 0.2],
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.15,
        mass: 1.0,
        netCharge: 2.0,
        dipoleMoment: [0, 0, 0],
        magneticMoment: [0, 0, 0],
        internalHeat: 0,
        isGrounded: false,
        isGrabbed: false,
        isSleeping: false,
        domainClass: 'Visible',
      },
      {
        id: 'b',
        materialId: 'paper',
        position: [0.6, 0.2, 0.2],
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.15,
        mass: 1.0,
        netCharge: -0.5,
        dipoleMoment: [0, 0, 0],
        magneticMoment: [0, 0, 0],
        internalHeat: 0,
        isGrounded: false,
        isGrabbed: false,
        isSleeping: false,
        domainClass: 'Visible',
      },
    ];

    // 1. 粗いパケットサイズ L = 2.0m へ拡大 -> 1つのクラスターへ Pack
    const packed = packetizer.synchronize(entities, 2.0);
    const cluster = packed.find((e) => e.id.startsWith('cluster_'));
    expect(cluster).toBeDefined();
    expect(cluster!.netCharge).toBeCloseTo(1.5, 5);
    expect(cluster!.mass).toBeCloseTo(2.0, 5);
    expect(Math.abs(cluster!.dipoleMoment[0])).toBeGreaterThan(0.1);

    // 2. 細かいパケットサイズ L = 0.25m へ縮小 -> Unpack されて元の2物体が復元
    const unpacked = packetizer.synchronize(packed, 0.25);
    expect(unpacked.some((e) => e.id.startsWith('cluster_'))).toBe(false);
    const entA = unpacked.find((e) => e.id === 'a')!;
    const entB = unpacked.find((e) => e.id === 'b')!;
    expect(entA.packedIntoId).toBeUndefined();
    expect(entB.packedIntoId).toBeUndefined();
  });

  it('中心窩Octree抽出テスト: 中心部(level 1)と周辺部(level 0)の階層ノードが生成されること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const core = new SpaceEngineCore(repo.config);
    const nodes = core.grid.extractFoveatedOctree(repo.config.center);

    const fineCount = nodes.filter((n) => n.level === 1).length;
    const coarseCount = nodes.filter((n) => n.level === 0).length;
    expect(fineCount).toBeGreaterThan(0);
    expect(coarseCount).toBeGreaterThan(0);
    expect(nodes.length).toBeLessThan(core.grid.count); // 全セル数より圧縮されていること
  });
});
