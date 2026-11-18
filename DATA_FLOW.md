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
        ├─ PerceptualScaler  (第4軸: 知覚スケール L_base 算出)
        ├─ BoundaryProjector (視野外 Projected/Absorbed → 境界シェル射影)
        ├─ DualPacketizer    (空間パケット同期 Pack/Unpack & 多重極展開)
        ├─ FieldSolver       (空間場: ポアソン緩和・渦度・散逸・CFL制御)
        └─ ContactSolver     (サブグリッド: めり込み解消・静止摩擦ロック・帯電)
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
  ├─ staticFriction: number     (静止摩擦係数 μ_s)
  └─ dynamicFriction: number    (動摩擦係数 μ_d)

SpaceEntity
  ├─ id: string
  ├─ materialId: string
  ├─ position: [number, number, number]
  ├─ velocity: [number, number, number]
  ├─ angularVelocity: [number, number, number]
  ├─ radius: number             (代表半径)
  ├─ mass: number
  ├─ netCharge: number          (蓄積電荷 q)
  ├─ dipoleMoment: [number, number, number]   (誘起電気双極子 p)
  ├─ magneticMoment: [number, number, number] (磁気双極子 m)
  ├─ internalHeat: number       (内部熱エネルギー)
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
| **4. 空間場更新** | `FieldSolver` | └─ CFL 条件からサブステップ回数 $N_{\text{sub}}$ と $\Delta t_{\text{sub}}$ を決定<br>└─ `isSleeping == false` のパケットに対し：<br>　├─ ポアソン圧力緩和（T字境界では面対称フラックスを適用）<br>　├─ 運動量フロー $\vec{P}$ と渦度 $\vec{\omega}$ の相互更新<br>　└─ 空間粘性による散逸（運動量の一部を $U_{\text{vib}}$ へ変換）<br>└─ $|\Delta \Phi| < \varepsilon$ かつ $|\vec{P}| < \varepsilon$ のパケットをスリープ化 |
| **5. 場からの力取得** | `FieldSolver` | └─ 各 `Visible` エンティティ位置で $\nabla \Phi$（静電・重力）、$\nabla |\vec{\omega}|^2$（ケルビン磁力）、分極力をサンプリングし速度へ積分 |
| **6. サブグリッド接触** | `ContactSolver` | └─ エンティティ同士・床面とのめり込み解消（Position-Based）<br>└─ 接触ペアに対し：<br>　├─ 摩擦帯電（相対滑り速度 $\times \Delta\text{electronAffinity}$ で電荷移動）<br>　├─ 導体分配・アース接地（`conductivity` に応じ $\Phi$ 均等化 / `isGrounded` で $q \to 0$）<br>　└─ **静止摩擦ロック**：$|v_{\text{rel}}| < v_{\text{sleep}}$ かつ接線力 $< \mu_s N$ なら速度を `0` に固定し `isSleeping = true` |
| **7. 状態通知** | `SpaceStateRepository`<br>`SandboxViewModel` | └─ Repository の状態コミット<br>└─ 新しい `SandboxUiState` を生成し、View へ通知 |

### 3.2 ユーザー操作フロー（掴む・動かす・こする）

| 操作 | 経路 | データフロー |
| :--- | :--- | :--- |
| **掴む / 移動** | `View` $\to$ `SandboxViewModel` | └─ レイキャストで対象 `entityId` を特定し `isGrabbed = true`, `isSleeping = false` に設定<br>└─ 目標座標との差分をばね・ダンパ制御（またはキネマティック移動）で速度へ変換し、接触相手に摩擦・帯電を発生させる |
| **スケール操作** | `View` $\to$ `SandboxViewModel` | └─ ズーム入力により `perceptualScaleLog10` を更新 $\to$ 次フレームの `PerceptualScaler` に反映 |
| **リセット / スポーン** | `View` $\to$ `SandboxViewModel` $\to$ `SpaceStateRepository` | └─ Repository の初期プリセットを再構築し、空間場パケットを真空基準（$\Phi=0, \vec{P}=0, \vec{\omega}=0$）へ初期化 |
