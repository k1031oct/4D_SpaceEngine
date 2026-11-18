import type {
  AmbientMediumSpec,
  MaterialSpec,
  MediumId,
  PresetId,
  ProjectedExternalSource,
  SpaceCoreConfig,
  SpaceEntity,
} from '../core/types';
import { createMaterialMap, createMediumMap } from './MaterialCatalog';

/**
 * デフォルトのPhase 1単一スケール空間設定
 */
export function createDefaultCoreConfig(): SpaceCoreConfig {
  return {
    nx: 16,
    ny: 16,
    nz: 16,
    cellSize: 0.25,
    center: [0, 1.5, 0],
    waveSpeed: 6.0,
    cflFactor: 0.35,
    diffusionRate: 1.8,
    phiDamping: 1.2,
    momentumDamping: 3.0,
    vorticityDamping: 2.5,
    chargeCoupling: 0.35,
    polarizationCoupling: 2.8,
    magneticCoupling: 6.5,
    lorentzCoupling: 0.6,
    triboRate: 1.5,
    epsilonCutoff: 1e-4,
    sleepVelocityThreshold: 0.06,
    floorY: 0.0,
  };
}

/**
 * 空間状態・エンティティ・マテリアル定義を保持する Repository
 * @see DATA_FLOW.md §1
 */
export class SpaceStateRepository {
  public readonly materials: Map<string, MaterialSpec>;
  public readonly media: Map<MediumId, AmbientMediumSpec>;
  public config: SpaceCoreConfig;
  public entities: SpaceEntity[] = [];
  public externalSources: ProjectedExternalSource[] = [];
  public currentPreset: PresetId = 'sandbox_lab';
  public currentMediumId: MediumId = 'air';

  constructor(config: SpaceCoreConfig = createDefaultCoreConfig()) {
    this.materials = createMaterialMap();
    this.media = createMediumMap();
    this.config = config;
    this.loadPreset('sandbox_lab');
  }

  public getCurrentMedium(): AmbientMediumSpec {
    return this.media.get(this.currentMediumId) ?? this.media.get('air')!;
  }

  /**
   * 検証用プリセットを読み込む
   */
  public loadPreset(presetId: PresetId): void {
    this.currentPreset = presetId;

    if (presetId === 'gravity_rest') {
      // 重力静止収束テスト：境界シェルへ地球重力を射影し、机の上へオブジェクトを落下・静止させる
      this.externalSources = [
        {
          id: 'earth_gravity',
          uniformField: [0, -9.8, 0],
        },
      ];
      this.entities = [
        this.createEntity('ball_1', 'iron_ball', [-0.6, 0.9, 0.0], 0.18, 1.0, 0),
        this.createEntity('ball_2', 'rubber_balloon', [0.0, 1.2, 0.2], 0.22, 0.4, 0),
        this.createEntity('ball_3', 'paper', [0.6, 0.6, -0.2], 0.16, 0.3, 0),
      ];
    } else if (presetId === 'dipole_pair') {
      // 空間歪み双極子（引力テスト）：無重力下で正・負の歪みソースが空間場を介して引き合う
      this.externalSources = [];
      this.entities = [
        this.createEntity('pos_source', 'rubber_balloon', [-0.55, 1.5, 0.0], 0.18, 0.8, 2.5),
        this.createEntity('neg_source', 'paper', [0.55, 1.5, 0.0], 0.18, 0.8, -2.5),
      ];
    } else if (presetId === 'repulsion_pair') {
      // 同符号空間歪み（斥力テスト）：無重力下で同符号の歪みソースが空間場を介して反発し合う
      this.externalSources = [];
      this.entities = [
        this.createEntity('pos_a', 'rubber_balloon', [-0.35, 1.5, 0.0], 0.18, 0.8, 2.5),
        this.createEntity('pos_b', 'rubber_balloon', [0.35, 1.5, 0.0], 0.18, 0.8, 2.5),
      ];
    } else if (presetId === 'tribo_induction') {
      // 摩擦帯電・静電誘導・アース放電実験
      this.externalSources = [
        {
          id: 'earth_gravity',
          uniformField: [0, -9.8, 0],
        },
      ];
      this.entities = [
        this.createEntity('balloon', 'rubber_balloon', [-0.7, 0.24, 0.0], 0.24, 0.35, 0),
        this.createEntity('wool', 'wool_cloth', [-0.15, 0.2, 0.0], 0.2, 0.8, 0),
        this.createEntity('paper_piece', 'paper', [0.45, 0.12, 0.0], 0.12, 0.08, 0),
        this.createEntity('earth_plate', 'steel_ground', [1.15, 0.25, 0.0], 0.25, 10.0, 0),
      ];
    } else if (presetId === 'magnet_attraction') {
      // ネオジム磁石と鉄球・鋼板のケルビン力吸着実験
      this.externalSources = [
        {
          id: 'earth_gravity',
          uniformField: [0, -9.8, 0],
        },
      ];
      this.entities = [
        this.createEntity('magnet', 'neodymium_magnet', [-0.45, 0.22, 0.0], 0.22, 1.2, 0),
        this.createEntity('iron_sphere', 'iron_ball', [0.2, 0.16, 0.0], 0.16, 0.5, 0),
        this.createEntity('can', 'aluminum_can', [0.85, 0.18, 0.0], 0.18, 0.3, 0),
      ];
    } else if (presetId === 'multi_scale_solar') {
      // 4次元マルチスケール連続実験：机上のミクロ物体とマクロ天体が共存し、スケール変更で3領域・Pack/Unpackが切り替わる
      this.externalSources = [];
      const planet: SpaceEntity = {
        ...this.createEntity('planet_earth', 'steel_ground', [0, -50.0, 0], 18.0, 1e6, 0),
        isGrounded: false,
        gravityStrength: 9.8 * 50.0 * 50.0, // 机上 (y≈0) で g = 9.8 m/s² になる巨大重力源
      };
      const moon: SpaceEntity = {
        ...this.createEntity('moon_sat', 'iron_ball', [65.0, -50.0, 0], 5.0, 1e4, 0),
        velocity: [0, 0, Math.sqrt((9.8 * 2500) / 65.0)], // 円軌道速度
      };
      this.entities = [
        planet,
        moon,
        this.createEntity('desk_ball_a', 'rubber_balloon', [-0.5, 0.8, 0.0], 0.18, 0.5, 2.0),
        this.createEntity('desk_ball_b', 'paper', [0.5, 0.8, 0.0], 0.16, 0.3, -2.0),
      ];
    } else if (presetId === 'sandbox_lab') {
      // 統合実験場：境界シェル地球重力・摩擦帯電・静電誘導・磁石吸着・アース放電・空間媒質が全て共存する実験場
      this.externalSources = [];
      const earth: SpaceEntity = {
        ...this.createEntity('earth_projected', 'steel_ground', [0, -50.0, 0], 18.0, 1e6, 0),
        isGrounded: false,
        gravityStrength: 9.8 * 50.0 * 50.0,
      };
      this.entities = [
        earth,
        this.createEntity('lab_balloon', 'rubber_balloon', [-1.0, 0.24, -0.3], 0.24, 0.35, 0),
        this.createEntity('lab_wool', 'wool_cloth', [-0.45, 0.2, -0.3], 0.2, 0.8, 0),
        this.createEntity('lab_paper', 'paper', [0.1, 0.12, -0.3], 0.12, 0.08, 0),
        this.createEntity('lab_earth_plate', 'steel_ground', [1.1, 0.25, -0.3], 0.25, 10.0, 0),
        this.createEntity('lab_magnet', 'neodymium_magnet', [-0.5, 0.22, 0.55], 0.22, 1.2, 0),
        this.createEntity('lab_iron', 'iron_ball', [0.2, 0.16, 0.55], 0.16, 0.5, 0),
      ];
    }
  }

  private createEntity(
    id: string,
    materialId: string,
    position: [number, number, number],
    radius: number,
    mass: number,
    netCharge: number,
  ): SpaceEntity {
    const mat = this.materials.get(materialId);
    const spin = mat?.spinMagnitude ?? 0;
    return {
      id,
      materialId,
      position: [...position],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius,
      mass,
      netCharge,
      dipoleMoment: [0, 0, 0],
      magneticMoment: spin > 0 ? [0, spin * 12.0, 0] : [0, 0, 0],
      internalHeat: 0,
      isGrounded: materialId === 'steel_ground',
      isGrabbed: false,
      isSleeping: false,
      domainClass: 'Visible',
    };
  }
}
