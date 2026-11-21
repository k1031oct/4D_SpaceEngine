# DATA_FLOW.md（データフロー設計書 / Source of Truth）

> **重要：** 本ファイルは 4D Scale Space Engine の**実装の正解（Source of Truth）**である。  
> コード実装前に必ず本ファイルの定義を確認し、変更が必要な場合は先に本ファイルを更新して承認を得ること。

---

## 1. 全体アーキテクチャ（MVVM + Repository + Pure Core）

描画（View / Three.js）と計算（Pure Core）を完全に分離し、将来の Windows / Web / Android 移植に耐えうる単方向データフローを採用する。

```
[View / Platform Adapter] (Three.js 3D Canvas, DOM/Touch Input)
  │  ユーザー操作イベント (grab, move, zoom, spawn, toggleDebug)
  ▼
[SandboxViewModel] (状態管理・フレーム制御・Input変換)
  │  購読用イミュータブル状態: SandboxUiState
  ├─▶ [SpaceStateRepository] (空間パケット状態・実体リスト・マテリアル辞書)
  └─▶ [SpaceEngineCore] (Pure TypeScript / プラットフォーム非依存)
        ├─ ISpatialComputeBackend (CpuTypedArrayBackend: WebGPU/Wasm差し替え抽象化)
        ├─ PerceptualScaler  (第4軸: 知覚スケール L_base 算出)
        ├─ BoundaryProjector (視野外 Projected/Absorbed → 境界シェル射影)
        ├─ DualPacketizer    (空間パケット同期 Pack/Unpack & 多重極展開)
        ├─ FieldSolver       (真空チャネル: 光共鳴・非線形屈折率・ヒステリシス・気圧緩和)
        ├─ MediumFluxSolver  (媒質チャネル: 動的気体媒質の対流・移流拡散・衝撃波・真空断熱)
        ├─ PhaseTransitionSolver (秩序度 Ψ ∈ [0, 1] 連続相状態・燃焼・気化分散)
        └─ ContactSolver     (不可侵バリア・定在波の檻摩擦・電池連結グループ回路)
```

---

## 2. コアデータ構造（Model / State）

### 2.1 空間パケット（`SpacePacket`）
将来の TypedArray / Wasm 移植を見据え、演算コア内部ではフラット配列（SoA: Structure of Arrays）または固定長構造体として扱う。

| フィールド名 | 型 | 物理的意味 | 保存則の扱い（Split/Merge時） |
| :--- | :--- | :--- | :--- |
| `id` | `number` | パケット一意識別子 | 新規採番 |
| `level` | `number` | Octree階層（$L = L_0 \cdot 2^{-\text{level}}$） | 親$\pm 1$ |
| `center` | `[number, number, number]` | パケット中心座標 $(x, y, z)$ | 象限オフセット |
| `size` | `number` | 一辺の長さ $L$（体積 $V = L^3$） | $L/2$ または $2L$ |
| `phi` | `number` | 気圧偏差 $\Delta P$ / ポテンシャル $\Phi$ | $\Phi \cdot V$ を保存 |
| `momentum` | `[number, number, number]` | 運動量フロー $\vec{P}$ | 総和 $\sum \vec{P}$ を保存 |
| `vorticity` | `[number, number, number]` | 渦度 $\vec{\omega}$（磁場源） | フラックス $\vec{\omega} \cdot L^2$ を保存 |
| `vibrationEnergy` | `number` | 内部振動エネルギー $U_{\text{vib}}$（熱・慣性） | 総和 $\sum U_{\text{vib}}$ を保存 |
| `stiffness` | `number` | 有効弾性・誘電率 $\varepsilon_{\text{eff}}$ | 体積加重平均 |
| `isBoundary` | `boolean` | 境界シェル（最外周6面）フラグ | — |
| `isSleeping` | `boolean` | $\varepsilon$-Cutoff によるスリープ状態 | 外乱で解除 |
| `mediumDensity` | `Float32Array` | 動的気体媒質密度 $\rho_{\text{med}}$ | 質量保存 |
| `mediumConcentration` | `Float32Array` | 媒質濃度 $C_{\text{med}}$（`0`＝真空断熱） | 移流保存 |
| `reactivityPotential` | `Float32Array` | 酸化反応ポテンシャル $U_{\text{ox}}$ | 移流保存 |
| `deviationVariance` | `Float32Array` | サブグリッド2次モーメント分散 $\sigma_E^2$ | 分散合成則 |
| `peakDeviation` | `Float32Array` | サブグリッド最大局所ピーク $\delta E_{\max}$ | $\max$ 保存 |
| `residualStrain` | `Float32Array` | 多安定ポテンシャル井戸の残留空間歪み $\Delta P_{\text{residual}}$ | 総和保存 |
| `anisotropyAxis` | `Float32Array (x3)` | 1次・2次異方性軸ベクトル | 体積加重 |
| `isCriticalSubgrid` | `Uint8Array` | $\bar{E} + \delta E_{\max} \ge E_{\text{barrier}}$ 臨界フラグ | — |
| `orderParameter` | `Float32Array` | 結合維持率（秩序度）$\Psi \in [0, 1]$ | 加重平均 |
| `trapEnergyStored` | `Float32Array` | 定在波の檻の蓄積エネルギー | 総和保存 |
| `groupId` | `Int32Array` | 連結グループ識別子（`-1`＝単独） | 継承 |

### 2.2 マテリアル物性（`MaterialSpec`）と実体オブジェクト（`SpaceEntity`）

```
MaterialSpec
  ├─ id: string                 (例: "neodymium_magnet", "rubber_balloon", "paper", "iron_ball", "steel_ground")
  ├─ density: number            (質量密度)
  ├─ electronAffinity: number   (電子親和力 / 仕事関数：正=電子を奪いやすい、負=奪われやすい)
  ├─ conductivity: number       (自由電子移動度：0=完全絶縁体、1=良導体・アース)
  ├─ polarizability: number     (誘電分極率：外部 ∇Φ に対する誘導しやすさ)
  ├─ spinMagnitude: number      (残留磁気スピン強度：定常渦度 ω の生成源)
  ├─ magneticSusceptibility: number (磁気感受率：∇|ω|² によるケルビン力への応答度)
  ├─ bindingEnergy: number      (結合エネルギー：相転移閾値)
  ├─ activationBarrier?: number (酸化還元・燃焼の活性化障壁)
  ├─ oxidizedWellDepth?: number (酸化後の安定結合井戸の深さ)
  ├─ elasticity: number         (弾性率：結合の硬さ・空間 stiffness 寄与)
  ├─ plasticity: number         (塑性・粘弾性散逸率：変形エネルギーの熱変換割合)
  ├─ bondChargeDensity: number  (結合電荷密度)
  ├─ equilibriumSpacing: number (平衡格子間隔 r_0：密度・バリア反発の源)
  ├─ surfaceWavelength: number  (表面波紋波長 λ：定在波の檻共鳴用)
  ├─ surfacePotentialDepth: number (表面ポテンシャル井戸深さ U_0)
  ├─ resonantFrequency: number  (固有共鳴周波数 ω_0：ローレンツ複素屈折率光学用)
  ├─ coerciveBarrier: number    (保磁力障壁：ヒステリシス閾値)
  ├─ topology: "solid" | "hollow" | "porous" | "fluid"
  └─ shellThicknessRatio: number (中空・外殻厚み比)

SpaceEntity
  ├─ id: string
  ├─ materialId: string
  ├─ position: [number, number, number]
  ├─ velocity: [number, number, number]
  ├─ angularVelocity: [number, number, number]
  ├─ radius: number             (代表半径)
  ├─ shape?: "sphere" | "box" | "cylinder" | "sheet" | "balloon" (実体形状)
  ├─ dimensions?: [number, number, number] (幅・高さ・奥行のサイズ)
  ├─ mass: number
  ├─ netCharge: number          (蓄積電荷 q)
  ├─ dipoleMoment: [number, number, number]   (誘起電気双極子 p)
  ├─ magneticMoment: [number, number, number] (磁気双極子 m)
  ├─ internalHeat: number       (内部熱エネルギー)
  ├─ elasticEnergy?: number     (蓄積された弾性ポテンシャルエネルギー U_elastic)
  ├─ compression?: number       (弾性圧縮ひずみ量 0..0.35：3Dスクイーズ変形用)
  ├─ phaseState: "solid" | "liquid" | "gas" (相状態：internalHeat と bindingEnergy の比から遷移)
  ├─ isBurning?: boolean        (酸化還元による燃焼中フラグ)
  ├─ fuelRemaining?: number     (可燃残量 0..1)
  ├─ isVaporParticle?: boolean  (気化分散によって生成されたサブ粒子フラグ)
  ├─ enclosedMediumId?: string  (中空容器の封入気体媒質ID)
  ├─ enclosedMediumDensity?: number (封入気体実効密度：破裂時に空間へ解放)
  ├─ isGrounded: boolean        (アース接続・巨大導体フラグ)
  ├─ isGrabbed: boolean         (ユーザー操作中フラグ)
  ├─ isSleeping: boolean        (静止摩擦ロック状態フラグ)
  └─ domainClass: "Visible" | "Projected" | "Absorbed"
```

### 2.2.1 空間媒質（`AmbientMediumSpec`）

```
AmbientMediumSpec
  ├─ id: string                 ("vacuum" | "air" | "neon" | "water")
  ├─ name: string
  ├─ density: number            (背景密度 ρ_0：浮力・流体抗力の源)
  ├─ viscosity: number          (粘性率：速度減衰)
  ├─ permittivity: number       (背景誘電率 ε_r：パケット stiffness の基準値)
  ├─ breakdownThreshold: number (絶縁破壊電界閾値：|∇Φ| 超過で空中プラズマ放電)
  ├─ oxidizerRatio: number      (酸化剤・酸素濃度：0=不燃、0.21=大気)
  └─ ambientHeat: number        (環境基準温度 U_0)
```

### 2.3 UI状態（`SandboxUiState`）

```
SandboxUiState
  ├─ isRunning: boolean         (シミュレーション再生/停止)
  ├─ currentMediumId: string    (現在の空間媒質: vacuum / air / neon / water)
  ├─ activeDischargeCount: number (空中絶縁破壊プラズマ放電の発生数)
  ├─ perceptualScaleLog10: number (現在の知覚スケール log10(L_base))
  ├─ activePacketCount: number  (稼働中の空間パケット数)
  ├─ sleepingPacketRatio: number (ε-Cutoff による計算省略率 0..1)
  ├─ totalEnergy: number        (系全体のエネルギー総和：保存・散逸監視用)
  ├─ dtEffective: number        (CFL制約に基づく実効タイムステップ Δt)
  ├─ selectedEntityId: string | null
  ├─ selectedEntityMetrics: { charge, velocityMag, heat, isSleeping } | null
  ├─ debugOverlayMode: "none" | "pressure" | "vorticity" | "octree"
  └─ renderSnapshots: EntityRenderSnapshot[] (描画用の軽量スナップショット配列)
```

---

## 3. 処理データフロー（ツリー型テーブル）

### 3.1 1ステップ演算フロー（`SandboxViewModel.step(rawDt)`）

| ステップ | 実行モジュール | データ変換・処理内容（ツリー構造） |
| :--- | :--- | :--- |
| **1. スケール決定** | `PerceptualScaler` | └─ カメラ位置・速度・近接最大オブジェクトから基準サイズ $L_{\text{base}}$ を算出<br>└─ 全 `SpaceEntity` を `Visible` / `Projected` / `Absorbed` に分類 |
| **2. 境界・双対同期** | `BoundaryProjector`<br>`DualPacketizer` | └─ `Projected`（地球・太陽・遠方電源等）を境界シェル6面の $\vec{G}_{\text{boundary}}, \vec{B}_{\text{boundary}}$ へ射影<br>└─ 必要に応じ Octree を分割/統合し、内部の `Visible` オブジェクトを Pack/Unpack |
| **3. ソース注入** | `FieldSolver` | └─ `Visible` エンティティの $q, \vec{m}, U$ を包含パケットのソース項 $S_{\Phi}, S_{\omega}$ へ加算 |
| **4. 空間場更新（2大チャネル）** | `ISpatialComputeBackend`<br>(`FieldSolver` / `MediumFluxSolver`) | └─ **真空チャネル（`FieldSolver`）**：非線形屈折率 $\varepsilon_{\text{eff}}$ による連続的波速低下（$c_{\text{eff}} \to 0$ で事象の地平面自己捕獲）、ローレンツ振動子モデル $\tilde{n}(\omega)$ による連続光学応答、ヒステリシス更新<br>└─ **媒質チャネル（`MediumFluxSolver`）**：実効密度差 $\rho_{\text{eff}} - \bar{\rho}_{\text{eff}}$ によるアルキメデス対流、酸素 `reactivityPotential` 拡散、3軸アップウィンド移流（$C_{\text{med}} = 0$ は自動断熱） |
| **5. 場からの力取得 & 熱交換** | `FieldSolver`<br>`SpaceEngineCore` | └─ 各 `Visible` エンティティ位置で $\nabla \Phi$、$q(\vec{v} \times \vec{\omega})$、$\nabla(\vec{m}\cdot\vec{\omega})$、$\nabla|\nabla\Phi|^2$ を積分<br>└─ 物体と周囲空間パケット `vibrationEnergy` 間で双方向熱交換フラックスを実行（摩擦熱・ジュール熱 $\to$ 周囲空気加熱 $\to$ 上昇対流） |
| **6. 不可侵バリア・定在波接触** | `ContactSolver` | └─ 電子雲重なり指数関数的空間気圧スパイク反発（PBDワープ最小化）<br>└─ 定在波の檻 $E_{\text{trap\_max}}$ によるエネルギー捕獲・決壊時の**運動エネルギー厳密差し引き**（床面も同一ロジックへ統一）<br>└─ 連結グループ（電池）の電子親和力差 $\Delta \chi$ に基づく電圧創発・電流・ジュール発熱 |
| **6.5 秩序度 Ψ・相転移** | `PhaseTransitionSolver` | └─ 連続秩序度 $\Psi \in [0, 1]$ を更新し、汎用結晶の形状記憶復元、合計 `1.0` 保存の3分岐曲げ収支、局所酸素比例燃焼、封入媒質放出破裂を実行 |
| **7. 状態通知** | `SpaceStateRepository`<br>`SandboxViewModel` | └─ Repository の状態コミット<br>└─ 新しい `SandboxUiState` を生成し、View へ通知 |

### 3.2 ユーザー操作フロー（掴む・動かす・こする）

| 操作 | 経路 | データフロー |
| :--- | :--- | :--- |
| **掴む / 移動** | `View` $\to$ `SandboxViewModel` | └─ レイキャストで対象 `entityId` を特定し `isGrabbed = true`, `isSleeping = false` に設定<br>└─ 目標座標との差分をばね・ダンパ制御（またはキネマティック移動）で速度へ変換し、接触相手に摩擦・帯電を発生させる |
| **スケール操作** | `View` $\to$ `SandboxViewModel` | └─ ズーム入力により `perceptualScaleLog10` を更新 $\to$ 次フレームの `PerceptualScaler` に反映 |
| **リセット / スポーン** | `View` $\to$ `SandboxViewModel` $\to$ `SpaceStateRepository` | └─ Repository の初期プリセットを再構築し、空間場パケットを真空基準（$\Phi=0, \vec{P}=0, \vec{\omega}=0$）へ初期化 |

---

## 4. Phase 10〜11 設計草案（入れ子知覚スタック・双方向相転移・論理＆生命レイヤー）

> **ステータス:** 設計草案（ユーザー承認後に Phase 10 から順次実装へ移行）

### 4.1 Phase 10：複数レイヤー入れ子知覚スタック（`NestedPerceptualStack`）
単一計算窓の限界（窓外へ出たガスの停止・観測者移動時の矛盾）を解決しつつ、計算量を単一レイヤーの 1.5 倍以内に抑える 5 層構造。

| レイヤー | 相対スケール | 更新間引き | 主な責務とデータフロー（ツリー構造） |
| :--- | :--- | :--- | :--- |
| **Layer -1** | $-2.5$ 桁 | Lazy オンデマンド | └─ **ミクロ基底層**：疲労転位・火花・トンネル種火を臨界セルのみ展開<br>└─ **$10^{-6}\text{ m}$ デカップリング**：`cellSize >= 1e-6` 時は自動スリープし演算スキップ |
| **Layer 0** | $0.0$ 桁 | 毎フレーム ($1\times$) | └─ **知覚フォーカス層**：既存の `SpacePacketGrid` ＋ `FieldSolver` / `MediumFluxSolver` による主演算<br>└─ 窓外へ流出した熱・ガス・運動量フラックスを Layer +1 境界へ受け渡す |
| **Layer +1** | $+2.5$ 桁 | $4$ フレームに1回 | └─ **環境・箱庭全体層**：Layer 0 窓外の対流・ガス還流・音波伝播を継続演算<br>└─ 上昇した熱気や環境変化を Layer 0 境界シェルへ還流射影 |
| **Layer +2** | $+5.5$ 桁 | $16$ フレームに1回 | └─ **気象・地形層**：広域の上昇気流成長・気圧配置変化を演算し、風向・気圧勾配として下層へ帰還（バタフライエフェクト） |
| **Layer +3** | $+9.0$ 桁 | $60$ フレームに1回 | └─ **惑星・背景大気海層**：重力ポテンシャルと大気リザーバーを維持し、下層の質量変化に対する逆射影を受容 |

#### 4.1.1 階層跨ぎハンドオフ（Cross-Layer Handoff）＆「場 $\leftrightarrow$ オブジェクト」双方向相転移

| 機能 | 担当モジュール | データフロー（ツリー構造） |
| :--- | :--- | :--- |
| **階層跨ぎハンドオフ** | `NestedPerceptualStack`<br>`DualPacketizer` | └─ **窓外流出時（Co-Pack）**：観測者の `focusPoint` 移動や高速飛行で Layer 0 窓外へ出た `SpaceEntity` を即座に消滅させず、上位レイヤー（Layer +1 / +2）の統計モーメント＋粗視化運動状態へ畳み込んで継続追跡<br>└─ **窓内復帰時（Unpack）**：再び Layer 0 窓内に入った瞬間に元の `SpaceEntity`（位置・速度・熱・電荷を保存）として再展開 |
| **凝縮昇格（場 $\to$ 実体）** | `PhaseTransitionSolver` | └─ 空間パケットの媒質濃度 $C_{\text{med}}$・密度 $\rho_{\text{med}}$ が臨界を超え、かつ低温（低 $U_{\text{vib}}$）で連続秩序度 $\Psi$ が凝固閾値を超えた場合、パケットの媒質質量を消費して液滴・固体コア（`SpaceEntity`）を生成 |
| **気化還元（実体 $\to$ 場）** | `PhaseTransitionSolver` | └─ `SpaceEntity` が加熱されて $\Psi \to 0$（気相臨界）に達した際、離散エンティティを空間場へ溶かし込み、質量・電荷・内部熱を包含パケットの `mediumDensity`, `mediumConcentration`, `sourcePhi`, `vibrationEnergy` へ厳密保存で加算 |

---

### 4.2 Phase 11：論理ワークフロー ＆ 生命エージェント層（`Logic & Bio Agency Layer`）
空間演算エンジンが生成する「光・熱・風・水流・ガス濃度」の上で稼働するアプリケーション固有知能層。

```
LogicalModuleSpec (変換モジュール定義)
  ├─ id: string
  ├─ inputEnergyType: "kinetic" | "light" | "thermal" | "electric"
  ├─ outputEnergyType: "kinetic" | "light" | "thermal" | "electric"
  ├─ efficiency: number          (変換効率 η ∈ (0, 1]：ロス (1 - η) は廃熱・ガスへ)
  └─ failRate: number            (エラー確率：発生時は泥塊/破損トークンを物理排出)

BioAgentState (自律生物エージェント：SpaceEntity 拡張または連結グループ)
  ├─ instanceId: string          (個体識別 ID：スクラップブック命名用)
  ├─ speciesId: string           (種族 ID：走光性昆虫・分解者・水棲生物 等)
  ├─ metabolicEnergy: number     (内部代謝エネルギー：消費して能動推力を生成)
  ├─ comfortTempRange: [min, max] (適温 $U_{\text{vib}}$ レンジ)
  └─ sensoryWeights: { light, heat, oxGradient, pressureShock }
```

| モジュール | 役割 | データフロー（ツリー構造） |
| :--- | :--- | :--- |
| **エネルギー型変換** | `EnergyModuleSolver` | └─ 占有パケットから入力エネルギー（$\vec{P}$・光・$U_{\text{vib}}$）を吸収し、$\eta$ 倍を出力エネルギーとして隣接パケットへ再注入<br>└─ ロス分 $(1 - \eta)$ を廃熱 `vibrationEnergy` および排気 `reactivityPotential` として空間へ放出（工場廃熱による環境汚染の創発） |
| **空間五感＆能動推力** | `BioAgentSolver` | └─ **座標カンニング禁止**：占有パケットおよび隣接 6 パケットの勾配（光強度・$U_{\text{vib}}$・$\nabla U_{\text{ox}}$・気圧衝撃 $\Delta P$）のみをサンプリング<br>└─ **行動決定**：適温探索・走光性・採餌・驚愕逃避ベクトルを算出し、内部代謝エネルギーを消費して周囲パケットへの反作用（能動推力）としてエンティティ速度を更新<br>└─ **ゾーニング創発**：工場廃熱・騒音振動の流入により生物が逃避するため、川（冷却・進入阻止境界）や高さ分離の必要性が自然に発生 |
