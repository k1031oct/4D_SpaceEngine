import { describe, expect, it } from 'vitest';
import { SpaceEngineCore } from '../src/core/SpaceEngineCore';
import { createDefaultCoreConfig, SpaceStateRepository } from '../src/data/SpaceStateRepository';
import { SandboxViewModel } from '../src/viewmodel/SandboxViewModel';

describe('空間媒質（真空・気体・水）および統合実験場（全現象同時再現）ベンチマーク', () => {
  it('真空 vs 標準大気テスト: 真空では紙片と鉄球が等速落下し、大気では空気抵抗で紙片が遅れること', () => {
    const runDrop = (mediumId: 'vacuum' | 'air') => {
      const repo = new SpaceStateRepository(createDefaultCoreConfig());
      repo.currentMediumId = mediumId;
      repo.externalSources = [{ id: 'g', uniformField: [0, -9.8, 0] }];
      repo.entities = [
        {
          id: 'iron',
          materialId: 'iron_ball',
          position: [-0.4, 2.5, 0],
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          radius: 0.16,
          mass: 2.0,
          netCharge: 0,
          dipoleMoment: [0, 0, 0],
          magneticMoment: [0, 0, 0],
          internalHeat: 0,
          isGrounded: false,
          isGrabbed: false,
          isSleeping: false,
          domainClass: 'Visible',
        },
        {
          id: 'paper',
          materialId: 'paper',
          position: [0.4, 2.5, 0],
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          radius: 0.16,
          mass: 0.03,
          netCharge: 0,
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
      for (let i = 0; i < 35; i++) {
        core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60, undefined, repo.getCurrentMedium());
      }
      return {
        ironY: repo.entities[0].position[1],
        paperY: repo.entities[1].position[1],
      };
    };

    const vac = runDrop('vacuum');
    // 真空では同じ高さまで落下する
    expect(Math.abs(vac.ironY - vac.paperY)).toBeLessThan(0.01);

    const air = runDrop('air');
    // 大気では空気抵抗により紙片の方が高い位置に残る（落下速度が遅い）
    expect(air.paperY).toBeGreaterThan(air.ironY + 0.05);
  });

  it('水中浮力テスト: 媒質を水(water)にするとゴム風船は浮上し鉄球は沈むこと', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.currentMediumId = 'water';
    repo.externalSources = [{ id: 'g', uniformField: [0, -9.8, 0] }];
    repo.entities = [
      {
        id: 'balloon',
        materialId: 'rubber_balloon',
        position: [-0.4, 0.5, 0],
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.2,
        mass: 0.3,
        netCharge: 0,
        dipoleMoment: [0, 0, 0],
        magneticMoment: [0, 0, 0],
        internalHeat: 0,
        isGrounded: false,
        isGrabbed: false,
        isSleeping: false,
        domainClass: 'Visible',
      },
      {
        id: 'iron',
        materialId: 'iron_ball',
        position: [0.4, 1.5, 0],
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.16,
        mass: 1.5,
        netCharge: 0,
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
    for (let i = 0; i < 30; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60, undefined, repo.getCurrentMedium());
    }

    expect(repo.entities[0].position[1]).toBeGreaterThan(0.5 + 0.2); // 風船は浮上
    expect(repo.entities[1].position[1]).toBeLessThan(1.5 - 0.1); // 鉄球は沈降
  });

  it('絶縁破壊プラズマ放電テスト: ネオンガス中で高帯電体を近づけると非接触で空中放電が起きること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.currentMediumId = 'neon';
    repo.loadPreset('dipole_pair');
    const core = new SpaceEngineCore(repo.config);

    // ギャップ 0.35m で向かい合わせる（非接触）
    repo.entities[0].isGrabbed = true;
    repo.entities[1].isGrabbed = true;
    repo.entities[0].position = [-0.35, 1.5, 0];
    repo.entities[1].position = [0.35, 1.5, 0];
    repo.entities[0].netCharge = 3.0;
    repo.entities[1].netCharge = -3.0;

    const res = core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60, undefined, repo.getCurrentMedium());
    expect(res.metrics.activeDischargeCount).toBeGreaterThan(0);
    expect(Math.abs(repo.entities[0].netCharge)).toBeLessThan(3.0);
  });

  it('統合実験場テスト(sandbox_lab): 重力射影・磁気吸着・摩擦帯電・静電誘導・アース放電・媒質浮力を同一空間で同時再現すること', () => {
    const vm = new SandboxViewModel();
    vm.loadPreset('sandbox_lab');
    vm.setMedium('air');

    const getEnt = (id: string) => vm.repository.entities.find((e) => e.id === id)!;
    const initIronX = getEnt('lab_iron').position[0];

    // 1. 空間を数フレーム進める：地球はProjectedとなり重力射影、同時にネオジム磁石が鉄球を引き寄せ始める
    for (let i = 0; i < 45; i++) {
      vm.step(1 / 60);
    }
    expect(getEnt('earth_projected').domainClass).toBe('Projected');
    expect(getEnt('lab_iron').position[0]).toBeLessThan(initIronX - 0.05); // 磁気吸着

    // 2. 同じ実験場内でゴム風船をウール布にこすり合わせて摩擦帯電させる
    const balloon = getEnt('lab_balloon');
    const wool = getEnt('lab_wool');
    balloon.isGrabbed = true;
    wool.isGrabbed = true;
    for (let i = 0; i < 25; i++) {
      balloon.position = [wool.position[0] + (i % 2 === 0 ? 0.04 : -0.04), wool.position[1] + 0.36, wool.position[2]];
      balloon.velocity = [i % 2 === 0 ? 1.8 : -1.8, -0.4, 0];
      vm.step(1 / 60);
    }
    wool.isGrabbed = false;
    expect(balloon.netCharge).toBeLessThan(-0.1);
    expect(wool.netCharge).toBeGreaterThan(0.1);

    // 3. 帯電した風船を中性紙片の斜め上へ移動させ、静電誘導で紙片を浮き上がらせる
    const paper = getEnt('lab_paper');
    const paperInitY = paper.position[1];
    balloon.netCharge = -3.5; // 十分な帯電状態で誘導を確認
    balloon.position = [paper.position[0] + 0.05, paper.position[1] + 0.65, paper.position[2]];
    balloon.velocity = [0, 0, 0];
    for (let i = 0; i < 12; i++) {
      vm.step(1 / 60);
    }
    expect(paper.position[1]).toBeGreaterThan(paperInitY + 0.01);

    // 4. 帯電した風船を同じ実験場の鋼板アースへ触れさせて放電させる
    const earthPlate = getEnt('lab_earth_plate');
    balloon.position = [
      earthPlate.position[0] + (balloon.radius + earthPlate.radius) * 0.9,
      earthPlate.position[1],
      earthPlate.position[2],
    ];
    for (let i = 0; i < 50; i++) {
      vm.step(1 / 60);
    }
    expect(Math.abs(balloon.netCharge)).toBeLessThan(0.15);

    // 5. 空間を満たす媒質を「水」に切り替えると、離した風船がアルキメデス浮力で浮上する
    balloon.isGrabbed = false;
    const yBeforeWater = balloon.position[1];
    vm.setMedium('water');
    for (let i = 0; i < 25; i++) {
      vm.step(1 / 60);
    }
    expect(balloon.position[1]).toBeGreaterThan(yBeforeWater + 0.2);
  });
});
