import { describe, expect, it } from 'vitest';
import { PhaseTransitionSolver } from '../src/core/PhaseTransitionSolver';
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
    const woolTopY = wool.position[1] + (wool.dimensions?.[1] ?? wool.radius * 2) * 0.5;
    for (let i = 0; i < 25; i++) {
      balloon.position = [
        wool.position[0] + (i % 2 === 0 ? 0.04 : -0.04),
        woolTopY + balloon.radius * 0.85,
        wool.position[2],
      ];
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

    // 4. 帯電した風船を同じ実験場の鋼板冷蔵庫アース側面へ触れさせて放電させる
    const earthPlate = getEnt('lab_earth_plate');
    const plateHalfW = (earthPlate.dimensions?.[0] ?? earthPlate.radius * 2) * 0.5;
    balloon.position = [
      earthPlate.position[0] + plateHalfW + balloon.radius * 0.85,
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

  it('ローレンツ力テスト: 空間の渦度(磁場 ω_y)中を横切る正電荷が進行方向と垂直(Z軸)へ曲がること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.externalSources = [];
    repo.entities = [
      {
        id: 'moving_charge',
        materialId: 'rubber_balloon',
        position: [0, 1.5, 0],
        velocity: [2.0, 0, 0], // +X 方向へ移動
        angularVelocity: [0, 0, 0],
        radius: 0.15,
        mass: 0.5,
        netCharge: 2.0,
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
    // 空間全体に +Y 向きの渦度（磁場 ω_y = 2.0）を設定
    core.grid.wy.fill(2.0);
    core.grid.isSleeping.fill(0);

    core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    // (v × ω)_z = vx * ωy > 0 により +Z 方向へ曲がること
    expect(repo.entities[0].velocity[2]).toBeGreaterThan(0.01);
  });

  it('磁気双極子極性テスト: 平行配置の磁石は引き合い、反平行配置の磁石は反発すること', () => {
    const runMagnetPair = (m2y: number) => {
      const repo = new SpaceStateRepository(createDefaultCoreConfig());
      repo.externalSources = [];
      repo.entities = [
        {
          id: 'm1',
          materialId: 'neodymium_magnet',
          position: [-0.4, 1.5, 0],
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          radius: 0.18,
          mass: 1.0,
          netCharge: 0,
          dipoleMoment: [0, 0, 0],
          magneticMoment: [0, 12.0, 0],
          internalHeat: 0,
          isGrounded: false,
          isGrabbed: false,
          isSleeping: false,
          domainClass: 'Visible',
        },
        {
          id: 'm2',
          materialId: 'neodymium_magnet',
          position: [0.4, 1.5, 0],
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          radius: 0.18,
          mass: 1.0,
          netCharge: 0,
          dipoleMoment: [0, 0, 0],
          magneticMoment: [0, m2y, 0],
          internalHeat: 0,
          isGrounded: false,
          isGrabbed: false,
          isSleeping: false,
          domainClass: 'Visible',
        },
      ];
      const core = new SpaceEngineCore(repo.config);
      for (let i = 0; i < 20; i++) {
        core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
      }
      return Math.abs(repo.entities[1].position[0] - repo.entities[0].position[0]);
    };

    const distParallel = runMagnetPair(12.0);
    const distAntiParallel = runMagnetPair(-12.0);
    // 平行（引き合い）の方が反平行（反発）より距離が短くなること
    expect(distParallel).toBeLessThan(distAntiParallel);
  });

  it('相転移テスト: 加熱により固体→液体→気体へ遷移し、気化時は集合体が分散粒子へ分裂して上昇し、冷却で再凝固すること', () => {
    const vm = new SandboxViewModel();
    vm.loadPreset('sandbox_lab');
    vm.setMedium('air');

    const ice = vm.repository.entities.find((e) => e.id === 'lab_ice')!;
    const initMass = ice.mass;
    vm.grabEntity(ice.id);
    vm.releaseEntity(ice.id);

    // 1. 初期状態：固体
    vm.step(1 / 60);
    expect(ice.phaseState).toBe('solid');
    const solidY = ice.position[1];

    // 2. 融点以上に加熱：液体（水）へ融解
    vm.addHeatToSelected(2.5);
    vm.step(1 / 60);
    expect(ice.phaseState).toBe('liquid');

    // 3. 沸点以上に加熱：気体（水蒸気）へ気化し、集合体が4つの低密度サブ粒子へ分裂・分散して上昇
    vm.addHeatToSelected(4.0);
    for (let i = 0; i < 30; i++) {
      vm.step(1 / 60);
    }
    const vaporParticles = vm.repository.entities.filter((e) => e.id.startsWith('lab_ice_vapor_'));
    expect(vaporParticles.length).toBe(4);
    const totalVaporMass = vaporParticles.reduce((s, p) => s + p.mass, 0);
    expect(totalVaporMass).toBeCloseTo(initMass, 5); // 質量保存則
    expect(vaporParticles[0].phaseState).toBe('gas');
    expect(vaporParticles[0].position[1]).toBeGreaterThan(solidY + 0.15);

    // 4. 冷却：すべての分散粒子が再び固体に戻り重力で下向きに落下し始めること
    for (const p of vaporParticles) {
      p.internalHeat = 0.0;
    }
    for (let i = 0; i < 45; i++) {
      vm.step(1 / 60);
    }
    expect(vaporParticles[0].phaseState).toBe('solid');
    expect(vaporParticles[0].velocity[1]).toBeLessThan(0);
  });

  it('磁石静止テスト: ネオジム磁石と鉄球が吸着した後に永遠に動き続けず完全静止すること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.loadPreset('magnet_attraction');
    const core = new SpaceEngineCore(repo.config);

    // 5秒間 (300ステップ) 実行
    for (let i = 0; i < 300; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    const magnet = repo.entities.find((e) => e.id === 'magnet')!;
    const iron = repo.entities.find((e) => e.id === 'iron_sphere')!;
    expect(magnet.isSleeping).toBe(true);
    expect(iron.isSleeping).toBe(true);
    expect(magnet.velocity).toEqual([0, 0, 0]);
    expect(iron.velocity).toEqual([0, 0, 0]);
  });

  it('燃焼テスト: 大気中で可燃物(紙片)が発火点を超えると酸化反応で燃焼・発熱し、無酸素環境で鎮火すること', () => {
    const vm = new SandboxViewModel();
    vm.loadPreset('sandbox_lab');
    vm.setMedium('air');

    const paper = vm.repository.entities.find((e) => e.id === 'lab_paper')!;
    vm.grabEntity(paper.id);
    vm.releaseEntity(paper.id);

    // 紙片の発火点 (1.5) 以上に加熱
    vm.addHeatToSelected(1.8);
    const heatBefore = paper.internalHeat;
    for (let i = 0; i < 15; i++) {
      vm.step(1 / 60);
    }
    expect(paper.isBurning).toBe(true);
    // 酸化還元反応により自己発熱で熱量が増加していること
    expect(paper.internalHeat).toBeGreaterThan(heatBefore);

    // 真空（酸素 0）へ切り替えると即座に鎮火すること
    vm.setMedium('vacuum');
    vm.step(1 / 60);
    expect(paper.isBurning).toBe(false);
  });

  it('弾性エネルギーテスト: ゴム風船は衝突時に大きく弾性変形して反発し、高塑性のウール布は熱へ散逸して跳ね返らないこと', () => {
    const dropTest = (materialId: 'rubber_balloon' | 'wool_cloth') => {
      const repo = new SpaceStateRepository(createDefaultCoreConfig());
      repo.externalSources = [{ id: 'g', uniformField: [0, -9.8, 0] }];
      repo.entities = [
        {
          id: 'obj',
          materialId,
          position: [0, 1.0, 0],
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          radius: 0.2,
          mass: 0.5,
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
      let maxCompression = 0;
      let maxReboundVy = 0;
      for (let i = 0; i < 45; i++) {
        core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
        const e = repo.entities[0];
        if ((e.compression ?? 0) > maxCompression) maxCompression = e.compression ?? 0;
        if (e.velocity[1] > maxReboundVy) maxReboundVy = e.velocity[1];
      }
      return { maxCompression, maxReboundVy, heat: repo.entities[0].internalHeat };
    };

    const balloon = dropTest('rubber_balloon');
    const wool = dropTest('wool_cloth');

    expect(balloon.maxCompression).toBeGreaterThan(0.05);
    expect(balloon.maxReboundVy).toBeGreaterThan(wool.maxReboundVy + 1.0);
    expect(wool.heat).toBeGreaterThan(balloon.heat);
  });

  it('結合度連動テスト: 熱軟化により弾性反発が低下し、弾性エネルギーがbindingEnergyを超えると結合破断すること', () => {
    const dropWithHeat = (heat: number) => {
      const repo = new SpaceStateRepository(createDefaultCoreConfig());
      repo.externalSources = [{ id: 'g', uniformField: [0, -9.8, 0] }];
      repo.entities = [
        {
          id: 'b',
          materialId: 'rubber_balloon',
          position: [0, 1.0, 0],
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          radius: 0.2,
          mass: 0.5,
          netCharge: 0,
          dipoleMoment: [0, 0, 0],
          magneticMoment: [0, 0, 0],
          internalHeat: heat,
          isGrounded: false,
          isGrabbed: false,
          isSleeping: false,
          domainClass: 'Visible',
        },
      ];
      const core = new SpaceEngineCore(repo.config);
      let maxVy = 0;
      for (let i = 0; i < 40; i++) {
        core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
        if (repo.entities[0].velocity[1] > maxVy) maxVy = repo.entities[0].velocity[1];
      }
      return maxVy;
    };

    const coldRebound = dropWithHeat(0.0);
    const hotSoftenedRebound = dropWithHeat(18.0); // bindingEnergy(20)に近い高温状態
    expect(coldRebound).toBeGreaterThan(hotSoftenedRebound + 1.0);

    // 2. 弾性エネルギー > bindingEnergy で結合破断（2破片へ分裂）
    const repo2 = new SpaceStateRepository(createDefaultCoreConfig());
    repo2.externalSources = [];
    repo2.entities = [
      {
        id: 'ice_block',
        materialId: 'ice', // bindingEnergy = 2.0
        position: [0, 1.0, 0],
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.18,
        mass: 0.5,
        netCharge: 0,
        dipoleMoment: [0, 0, 0],
        magneticMoment: [0, 0, 0],
        internalHeat: 0,
        elasticEnergy: 3.0, // bindingEnergy (2.0) を超過
        isGrounded: false,
        isGrabbed: false,
        isSleeping: false,
        domainClass: 'Visible',
      },
    ];
    const core2 = new SpaceEngineCore(repo2.config);
    const res = core2.step(repo2.entities, repo2.materials, repo2.externalSources, 1 / 60);
    expect(res.entities.length).toBe(2);
    expect(res.entities[0].id).toContain('ice_block_frag_');
  });

  it('素粒子密度→万有引力統一テスト: gravityStrength未指定でも質量(密度×体積)に応じて中性の周囲物体を引き寄せること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    repo.externalSources = [];
    repo.entities = [
      {
        id: 'dense_body',
        materialId: 'iron_ball',
        position: [-0.6, 1.5, 0],
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.25,
        mass: 500.0, // 高質量（gravityStrength未指定）
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
        id: 'probe',
        materialId: 'paper',
        position: [0.6, 1.5, 0],
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        radius: 0.12,
        mass: 0.1,
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
    const initX = repo.entities[1].position[0];

    for (let i = 0; i < 30; i++) {
      core.step(repo.entities, repo.materials, repo.externalSources, 1 / 60);
    }

    // 中性・非磁性の紙片が、高質量体の統一万有引力 G*M により引き寄せられること
    expect(repo.entities[1].position[0]).toBeLessThan(initX - 0.1);
  });

  it('剛性創発テスト: 密度×電荷結合力から剛性が算出され、鉄＞アルミ＞ゴムの順となり液化で剛性0になること', () => {
    const repo = new SpaceStateRepository(createDefaultCoreConfig());
    const makeEnt = (materialId: string, heat = 0) => ({
      id: materialId,
      materialId,
      position: [0, 0, 0] as [number, number, number],
      velocity: [0, 0, 0] as [number, number, number],
      angularVelocity: [0, 0, 0] as [number, number, number],
      radius: 0.2,
      mass: 1.0,
      netCharge: 0,
      dipoleMoment: [0, 0, 0] as [number, number, number],
      magneticMoment: [0, 0, 0] as [number, number, number],
      internalHeat: heat,
      isGrounded: false,
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible' as const,
    });

    const rIron = PhaseTransitionSolver.getEffectiveRigidity(
      makeEnt('iron_ball'),
      repo.materials.get('iron_ball'),
    );
    const rAlum = PhaseTransitionSolver.getEffectiveRigidity(
      makeEnt('aluminum_can'),
      repo.materials.get('aluminum_can'),
    );
    const rBalloon = PhaseTransitionSolver.getEffectiveRigidity(
      makeEnt('rubber_balloon'),
      repo.materials.get('rubber_balloon'),
    );
    const rMeltedIce = PhaseTransitionSolver.getEffectiveRigidity(
      makeEnt('ice', 3.0), // bindingEnergy (2.0) 以上で液化
      repo.materials.get('ice'),
    );

    expect(rIron).toBeGreaterThan(rAlum);
    expect(rAlum).toBeGreaterThan(rBalloon);
    expect(rMeltedIce).toBe(0);
  });
});
