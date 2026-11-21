/**
 * Pure Core 共通型定義
 * プラットフォーム（Web / Windows / Android）非依存のデータ構造を定義する。
 * @see DATA_FLOW.md
 */

export type Vec3 = [number, number, number];

export type DomainClass = 'Visible' | 'Projected' | 'Absorbed';

export type PhaseState = 'solid' | 'liquid' | 'gas';

export type ShapeKind = 'sphere' | 'box' | 'cylinder' | 'sheet' | 'balloon';

export type DebugOverlayMode = 'none' | 'pressure' | 'vorticity' | 'octree';

export type MediumId = 'vacuum' | 'air' | 'helium' | 'neon' | 'water';

export type MaterialTopology = 'solid' | 'hollow' | 'porous' | 'fluid';

export type GroupRole =
  | 'anode'
  | 'separator'
  | 'cathode'
  | 'wire'
  | 'bulb'
  | 'shell'
  | 'core';

export type InjectorBrushMode =
  | 'hot_air'
  | 'cold_air'
  | 'helium'
  | 'oxygen'
  | 'vacuum'
  | 'light_pulse';

export type PresetId =
  | 'gravity_rest'
  | 'dipole_pair'
  | 'repulsion_pair'
  | 'tribo_induction'
  | 'magnet_attraction'
  | 'multi_scale_solar'
  | 'sandbox_lab'
  | 'battery_circuit'
  | 'helium_balloon_burst'
  | 'thermal_convection'
  | 'black_hole_horizon'
  | 'fatigue_and_shape_memory';

/**
 * 空間を満たす背景媒質（真空・気体・液体）の物性定義
 */
export interface AmbientMediumSpec {
  readonly id: MediumId;
  readonly name: string;
  /** 背景密度 ρ_0（浮力・流体抗力の源） */
  readonly density: number;
  /** 粘性率 ν_0 */
  readonly viscosity: number;
  /** 背景誘電率 ε_r（空間パケット stiffness の基準値） */
  readonly permittivity: number;
  /** 絶縁破壊電界閾値（|∇Φ| 超過で気体電離・空中放電が発生） */
  readonly breakdownThreshold: number;
  /** 酸化剤・酸素濃度（0=不燃、0.21=大気） */
  readonly oxidizerRatio: number;
  /** 環境基準温度（内部振動エネルギーベースライン） */
  readonly ambientHeat: number;
}

/**
 * マテリアル基礎物性パラメータ
 */
export interface MaterialSpec {
  readonly id: string;
  readonly name: string;
  /** 質量密度 */
  readonly density: number;
  /** 電子親和力（仕事関数：正=電子を奪いやすい、負=奪われやすい） */
  readonly electronAffinity: number;
  /** 自由電子移動度（0=完全絶縁体, 1=良導体・アース） */
  readonly conductivity: number;
  /** 誘電分極率（外部 ∇Φ に対する誘導しやすさ） */
  readonly polarizability: number;
  /** 残留磁気スピン強度（定常渦度 ω の生成源） */
  readonly spinMagnitude: number;
  /** 磁気感受率（∇|ω|² によるケルビン力への応答度） */
  readonly magneticSusceptibility: number;
  /** 結合エネルギー（融点・沸点などの相転移閾値） */
  readonly bindingEnergy: number;
  /** 液体相における固体比密度倍率（デフォルト 0.9、氷→水は 1.09 等） */
  readonly liquidDensityRatio?: number;
  /** 酸化還元（燃焼）の活性化障壁 */
  readonly activationBarrier?: number;
  /** 酸化後の安定結合井戸の深さ（燃焼解放エネルギー源） */
  readonly oxidizedWellDepth?: number;
  /** 弾性率（ヤング率相当：硬さ・空間 stiffness 寄与） */
  readonly elasticity?: number;
  /** 塑性・粘弾性散逸率（0=完全弾性、1=変形エネルギーをすべて熱へ散逸） */
  readonly plasticity?: number;
  /** 電荷格子パラメータ：単位体積あたりの結合電荷密度 */
  readonly bondChargeDensity?: number;
  /** 平衡格子間隔 */
  readonly equilibriumSpacing?: number;
  /** 表面波紋波長 λ（定在波の檻の共鳴計算用） */
  readonly surfaceWavelength?: number;
  /** 表面ポテンシャル井戸深さ U_0 */
  readonly surfacePotentialDepth?: number;
  /** 固有共鳴周波数 ω_0（光の透過・反射・共鳴吸収分岐用） */
  readonly resonantFrequency?: number;
  /** 保磁力障壁（強磁性・強誘電ヒステリシス閾値） */
  readonly coerciveBarrier?: number;
  /** 多安定ポテンシャル井戸障壁 E_act（形状記憶・疲労転移用） */
  readonly metastableWellBarrier?: number;
  /** 疲労破断限界（残留歪み累積閾値） */
  readonly fatigueThreshold?: number;
  /** 構造トポロジー */
  readonly topology?: MaterialTopology;
  /** 中空・外殻厚み比 */
  readonly shellThicknessRatio?: number;
  /** 描画用ベースカラー (16進数) */
  readonly colorHex: number;
}

/**
 * 空間内に配置される実体オブジェクト
 */
export interface SpaceEntity {
  id: string;
  materialId: string;
  position: Vec3;
  velocity: Vec3;
  angularVelocity: Vec3;
  /** 代表半径 */
  radius: number;
  /** 3D形状種別 */
  shape?: ShapeKind;
  /** 形状寸法 [幅, 高さ, 奥行] */
  dimensions?: Vec3;
  /** 質量 */
  mass: number;
  /** 蓄積電荷 q（空間の歪みソース強度） */
  netCharge: number;
  /** 誘起電気双極子 p */
  dipoleMoment: Vec3;
  /** 磁気双極子 m */
  magneticMoment: Vec3;
  /** 内部熱エネルギー */
  internalHeat: number;
  /** 蓄積された弾性ポテンシャルエネルギー U_elastic */
  elasticEnergy?: number;
  /** 弾性圧縮ひずみ (0..0.35) */
  compression?: number;
  /** 現在の相状態（固体 / 液体 / 気体） */
  phaseState?: PhaseState;
  /** 連続秩序度（結合維持率）Ψ ∈ [0, 1]（1=固体ロック, 0=完全自由気体） */
  orderParameter?: number;
  /** 定在波の檻に蓄積されたエネルギー */
  trapEnergyStored?: number;
  /** 連結パケットグループID (-1=単独) */
  groupId?: number;
  /** 連結グループ内での機能ロール */
  groupRole?: GroupRole;
  /** 電池グループ等の化学エネルギー残量 */
  chemicalEnergy?: number;
  /** サブグリッド2次モーメント分散 σ_E² */
  deviationVariance?: number;
  /** サブグリッド最大局所ピーク δE_max */
  peakDeviation?: number;
  /** 多安定ポテンシャル井戸の残留空間歪み履歴 ΔP_residual */
  residualStrain?: number;
  /** 記憶された安定形状スケール（形状記憶合金用） */
  memorizedShapeScale?: Vec3;
  /** 現在の変形形状スケール */
  currentShapeScale?: Vec3;
  /** 自己組織化結晶配向ベクトル */
  crystalOrientation?: Vec3;
  /** 1次・2次異方性軸ベクトル */
  anisotropyAxis?: Vec3;
  /** 臨界アップスケールトリガーフラグ */
  isCriticalSubgrid?: boolean;
  /** 冷間圧接による結合状態 */
  isColdWelded?: boolean;
  /** ブラックホール（事象の地平面自己捕獲）状態 */
  isBlackHole?: boolean;
  /** 事象の地平面半径 */
  eventHorizonRadius?: number;
  /** 不可侵ハードバリア半径 */
  hardBarrierRadius?: number;
  /** 連結すき間サイズ d_gap（サイズ選別浸透用） */
  gapSpacing?: number;
  /** 酸化還元反応（燃焼）中フラグ */
  isBurning?: boolean;
  /** 可燃残量 (0..1) */
  fuelRemaining?: number;
  /** 気化分散により生成されたサブ粒子フラグ */
  isVaporParticle?: boolean;
  /** 中空容器の封入気体媒質ID */
  enclosedMediumId?: MediumId;
  /** 中空容器の封入気体実効密度（破裂時に空間へ放出） */
  enclosedMediumDensity?: number;
  /** アース接続・巨大導体フラグ */
  isGrounded: boolean;
  /** ユーザー操作中フラグ */
  isGrabbed: boolean;
  /** 静止摩擦ロック状態フラグ */
  isSleeping: boolean;
  /** 現在のスケール領域分類 */
  domainClass: DomainClass;
  /** 巨大天体等の重力ソース強度（Projected時に境界シェルへ射影される） */
  gravityStrength?: number;
  /** 統合クラスターID（Packされている場合） */
  packedIntoId?: string;
}

/**
 * 観測者（カメラ／プレイヤー）の知覚状態
 */
export interface ObserverState {
  position: Vec3;
  velocity: Vec3;
  focusPoint: Vec3;
  /** 手動ズームによるスケール係数 (log10 L_base) */
  manualScaleLog10: number | null;
  /** 知覚時間定数 τ */
  tau: number;
}

/**
 * 中心窩（Foveated）Octree可視化・階層計算用ノード
 */
export interface OctreeCellInfo {
  readonly center: Vec3;
  readonly size: number;
  readonly level: number;
  readonly phi: number;
}

/**
 * 計算窓の外側に存在する巨大・遠方オブジェクトの射影ソース
 */
export interface ProjectedExternalSource {
  readonly id: string;
  /** 一様重力加速度ベクトル (例: 地球からの射影 [0, -9.8, 0]) */
  readonly uniformField?: Vec3;
  /** 遠方点ソース位置 */
  readonly position?: Vec3;
  /** 遠方電荷・質量強度 */
  readonly strength?: number;
}

/**
 * 空間演算コア設定
 */
export interface SpaceCoreConfig {
  /** 各軸の分割数（Phase 1 は単一スケール均一グリッド） */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** 1パケットの一辺の長さ L */
  readonly cellSize: number;
  /** 空間中心座標 */
  readonly center: Vec3;
  /** 空間の基準波速 c_eff */
  readonly waveSpeed: number;
  /** CFL安全係数 (<= 0.5) */
  readonly cflFactor: number;
  /** ポアソン・気圧拡散係数 */
  readonly diffusionRate: number;
  /** 気圧偏差の自然減衰率 γ_Φ */
  readonly phiDamping: number;
  /** 運動量フローの粘性散逸率 ν_space */
  readonly momentumDamping: number;
  /** 渦度の減衰率 */
  readonly vorticityDamping: number;
  /** 電荷→力変換の結合定数 */
  readonly chargeCoupling: number;
  /** 誘電分極→力変換の結合定数（静電誘導引力） */
  readonly polarizationCoupling: number;
  /** 渦度勾配→力変換の結合定数（ケルビン力） */
  readonly magneticCoupling: number;
  /** ローレンツ力 q(v×ω) の結合定数 */
  readonly lorentzCoupling: number;
  /** 万有引力統一結合定数 G（質量＝素粒子密度の積分から重力を創発） */
  readonly gravitationalConstant: number;
  /** 摩擦帯電係数 */
  readonly triboRate: number;
  /** ε-Cutoff 最小エネルギー閾値 */
  readonly epsilonCutoff: number;
  /** 静止摩擦ロックの速度閾値 */
  readonly sleepVelocityThreshold: number;
  /** 床面（机）の Y 座標 */
  readonly floorY: number;
  /** 1フレームの最大時間刻み上限 (デフォルト 0.05s) */
  readonly maxFrameDt?: number;
  /** 媒質チャネルの最大サブステップ刻み (デフォルト 0.02s) */
  readonly maxMediumSubDt?: number;
}

export type LayerId = -1 | 0 | 1 | 2 | 3;

export interface LayerMetricsSnapshot {
  readonly layerId: LayerId;
  readonly cellSize: number;
  readonly stride: number;
  readonly lastUpdatedFrame: number;
  readonly isDecoupled: boolean;
  readonly totalHeat: number;
  readonly totalMediumMass: number;
  readonly handedOffCount: number;
}

/**
 * 1ステップ実行結果の統計サマリ
 */
export interface CoreStepMetrics {
  readonly activePacketCount: number;
  readonly sleepingPacketRatio: number;
  readonly totalEnergy: number;
  readonly dtEffective: number;
  readonly activeDischargeCount: number;
  readonly eventHorizonCount?: number;
  readonly circuitCurrent?: number;
  readonly layerSnapshots?: readonly LayerMetricsSnapshot[];
  readonly handedOffEntityCount?: number;
  readonly condensedEntityCount?: number;
  readonly vaporizedToFieldCount?: number;
}
