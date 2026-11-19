# AntiGravity 統合開発指示書 v3.0（Phase 9：非創発ハードコード一掃＆完全第一原理リファクタリング）

**対象リポジトリ:** `k1031oct/4D_SpaceEngine`（ベースコミット `3f6d3b1`）  
**実行エージェント:** AntiGravity（Orbit Command Center 統括下）  
**目的:** Phase 6〜8 のコードベース全9ファイルに対する徹底監査で洗い出された**「従来の物理エンジン的なハードコード定数・名前分岐・エネルギー保存則の抜け・ソルバ間連携の断絶」**をすべて解消し、**「空間の歪み（気圧偏差 $\Delta P$・渦度 $\vec{\omega}$・屈折率 $\varepsilon_{\text{eff}}$）と電荷結合・動的気体媒質場」のみから全現象が創発する純粋空間演算エンジン**へと完成させる。

---

## 0. 開発ガバナンス（絶対遵守ルール）

1. **Documentation First（Single Source of Truth）：**
   コード変更前に必ず `DATA_FLOW.md` と `DEVELOPMENT_PLAN.md` を本指示書の Phase 9 仕様へ更新すること。
2. **純粋創発の原則（ハードコード・名指し分岐の禁止）：**
   * `materialId === 'shape_memory_alloy'` のような特定ID名指しの `if` 分岐を禁止する。
   * 固定摩擦係数（`staticFriction`, `dynamicFriction`）・固定反発係数（`restitution`）・固定電池電圧（`2.5`）・固定ガス密度（`0.00018`）の直書きを禁止する。
   * すべてのエネルギー変換（摩擦熱・ジュール熱・弾性復元・破裂飛散）において**エネルギー保存則（運動エネルギー・化学エネルギーの差し引き）**を厳密に満たすこと。
3. **バックエンド抽象化の徹底：**
   `SpaceEngineCore` からの `instanceof CpuTypedArrayBackend` ダウンキャストを廃止し、`ISpatialComputeBackend` を通じてすべての空間・媒質・光学操作を完結させること。
4. **自律検証義務：**
   実装完了後、`npm test`（Vitest）および `npm run build` を実行し、既存テストおよび新規追加の Phase 9 回帰テストがすべてパスするまで自律修復ループを回すこと。

---

## 1. 全コアファイル別・リファクタリング実装仕様

### Task 1: 型定義とバックエンドインターフェースの整理 (`src/core/types.ts`, `src/core/ISpatialComputeBackend.ts`)
1. **`MaterialSpec` の純化 (`types.ts`)：**
   * `staticFriction`, `dynamicFriction`, `restitution` を廃止（または `@deprecated` 化しソルバから参照を完全削除）。
   * 燃焼パラメータ `ignitionHeat` / `combustionEnergy` を、結合井戸組み換えパラメータ `activationBarrier`（活性化障壁）および `oxidizedWellDepth`（酸化後の安定結合井戸の深さ）へ置換。
   * `density` を任意（`equilibriumSpacing` とコアエネルギーから算出）にするか、整合性ヘルパーで導出。
2. **`SpaceEntity` の拡張 (`types.ts`)：**
   * 中空オブジェクトの封入気体情報 `enclosedMediumId?: MediumId` / `enclosedMediumDensity?: number` を追加（破裂時に固定値 `0.00018` ではなく封入されていた実際の媒質を放出するため）。
3. **`ISpatialComputeBackend` の拡張 (`ISpatialComputeBackend.ts`)：**
   * `injectBrush(...)` と `evaluateLightInteraction(...)` をインターフェース定義へ昇格させ、`SpaceEngineCore` における `CpuTypedArrayBackend` へのダウンキャスト（`getMediumSolver` / `getFieldSolver` の `instanceof` 分岐）を廃止する。
4. **`SpaceCoreConfig` の統合 (`types.ts`)：**
   * 時間刻みクランプ上限 `maxFrameDt`（デフォルト `0.05`）および `maxMediumSubDt`（デフォルト `0.02`）を設定項目へ統合し、各ソルバ内のマジックナンバー重複を排除する。

---

### Task 2: マテリアルカタログの完全第一原理化 (`src/data/MaterialCatalog.ts`)
1. **欠落パラメータの補完：**
   * これまで抜け落ちていた `aluminum_can`、`neodymium_magnet`、`steel_ground` に、`bondChargeDensity`, `equilibriumSpacing`, `surfaceWavelength`, `surfacePotentialDepth`, `resonantFrequency`, `coerciveBarrier`, `topology`, `shellThicknessRatio` を漏れなく定義する。
   * 特に `aluminum_can` は `topology: 'hollow'`, `shellThicknessRatio: 0.03`, `resonantFrequency: 14.0` を明示し、ファラデーケージ効果および座屈変形が機能するようにする。
2. **固定摩擦・反発係数の削除と密度・燃焼の統一：**
   * 全マテリアルから `staticFriction`, `dynamicFriction`, `restitution` を削除。
   * `computeEmergentDensity(equilibriumSpacing, bondChargeDensity)` により密度を平衡格子間隔 $r_0$ と矛盾しない値として算出する。
   * `DEFAULT_MEDIA` の `water` は背景気体媒質ではなく、`H2O` マテリアルの液体秩序相（$0.2 < \Psi < 0.8$）と整合するよう整理し、媒質の粘性 `viscosity` も密度と温度から動的算出できるようにする。

---

### Task 3: 接触・定在波摩擦・電池回路の完全創発化 (`src/core/ContactSolver.ts`)
1. **エネルギー保存則の厳密化（摩擦熱発生時の運動エネルギー消費）：**
   * 定在波の檻（`trapEnergyStored`）にエネルギーを捕獲した際、および限界突破（決壊）して `internalHeat` を発生させた際、**その消費エネルギー量 $\Delta E$ に応じて双方の接線速度（相対運動エネルギー）を運動量保存則に従って減速させる**こと（エネルギー無から有のバグ解消）。
2. **床面（机）接触の「定在波の檻」への統一：**
   * 床面との接触処理（L162〜L196）から `mat?.dynamicFriction ?? 0.45` および最低塑性値 `0.52` のハードコードを削除し、床も「表面波紋（`floorWavelength`, `floorPotentialDepth`）を持つ空間境界」としてエンティティ同士と同一の定在波の檻ロジックで処理する。
   * 低速時の強制スリープ・強制反発ゼロ化（`velAlongNormal < 0.2`）を廃止し、定在波の檻によるエネルギー捕獲から自然に静止ロックが創発するようにする。
3. **非貫通反発の空間気圧スパイク化：**
   * 座標を直接ワープさせる PBD 位置補正を最小限の安全ガードにとどめ、主たる反発を**外殻電子雲の重なりによる指数関数的空間気圧勾配 $\Delta P_{\text{barrier}} \propto \exp(\text{overlap}/r_0) - 1$** からの速度場加速として計算する。
4. **電池回路の創発化（`solveBatteryCircuits`）：**
   * `targetVoltage = 2.5` のハードコードを削除し、＋極（`anode`）と－極（`cathode`）のマテリアルの**電子親和力差 $\Delta \chi = |\chi_{\text{anode}} - \chi_{\text{cathode}}|$** から維持電圧（気圧落差）を算出する。
   * 磁気・静電吸着のマジックナンバー分岐（`magneticSusceptibility > 0.5` 等）を削除し、磁力・静電力による法線押し付け圧 $\Delta P_{\perp}$ が定在波の檻 $E_{\text{trap\_max}}$ を深めることで自然に吸着静止するようにする。

---

### Task 4: 空間場ソルバの単一ループ統一 (`src/core/FieldSolver.ts`)
1. **中空密度・重力二重計算の解消：**
   * `FieldSolver` 内の `if (mat?.topology === 'hollow')` による体積密度再計算を削除し、`PhaseTransitionSolver.getEffectiveDensity` に一元化する（中空シェルの実効密度は殻厚比 `shellThicknessRatio` と内部封入媒質密度の加重平均から自動算出）。
2. **真空チャネルの自己完結化：**
   * 空間グリッドの更新（`stepGrid`）内部で非線形屈折率 $\varepsilon_{\text{eff}}$ と波速 $c_{\text{eff}} = c_0 / \sqrt{\varepsilon_{\text{eff}}}$ の勾配を直接計算し、ブラックホール（事象の地平面）および極小スケールでの波動染み出し（量子トンネル効果）が専用 `if (stiff >= 14.0)` ハードコードではなく**連続的な波速低下（$c_{\text{eff}} \to 0$ による光・波の閉じ込め）**として創発するようにする。
3. **光相互作用のローレンツ振動子モデル連続化：**
   * `evaluateLightInteraction` の不連続な `detuning < 0.22` / `cond > 0.65` 分岐を廃止し、共鳴周波数 $\omega_0$・減衰率 $\gamma$・自由電荷密度から決まる**複素屈折率 $\tilde{n}(\omega) = n + i\kappa$** の連続関数から透過率・反射率・吸収率を算出する。

---

### Task 5: 動的気体媒質場の浮力・移流・酸素拡散の完全実装 (`src/core/MediumFluxSolver.ts`)
1. **ヘリウム浮力（密度差対流）の実装：**
   * 現在の `heatExcess`（温度差）のみの浮力計算を修正し、熱膨張を考慮した**局所実効媒質密度 $\rho_{\text{eff}} = \rho_{\text{med}} \cdot C_{\text{med}} / (1 + \alpha U_{\text{vib}})$** と空間平均密度 $\bar{\rho}_{\text{eff}}$ の差に基づくアルキメデス浮力加速度を実装する：
     $$a_{\text{buoyancy}} = \vec{g} \cdot \frac{\rho_{\text{eff}} - \bar{\rho}_{\text{eff}}}{\bar{\rho}_{\text{eff}} + \varepsilon}$$
   * これにより、常温のヘリウム風船放出ガスが自然に天井へ上昇し、二酸化炭素が沈降し、暖気が上昇する現象が単一の密度差数式で創発する。
2. **酸素ポテンシャル（`reactivityPotential`）の拡散・移流：**
   * `MediumFluxSolver.solve()` において `reactivityPotential` も `mediumDensity` と同様に隣接6近傍へ拡散・移流させ、注入した酸素が気流に乗って広がり、燃焼で消費された場所へ周囲から酸素が流れ込むようにする。
3. **3軸アップウィンド移流とブラシ注入の加重混合：**
   * `y` 軸1マスのみの移流から `px, py, pz` の3軸風下移流（アップウィンド法）へ拡張し、対流循環（上昇 $\to$ 天井広がり $\to$ 下降）を実現する。
   * `injectBrush` での `'helium'` 密度直書き `0.00018` を廃止し、`DEFAULT_MEDIA` の基準密度を参照した濃度加重平均混合にする。

---

### Task 6: 相転移・疲労・形状記憶・双対パケッティング・コアパイプラインの統合 (`PhaseTransitionSolver.ts`, `DualPacketizer.ts`, `SpaceEngineCore.ts`)
1. **`PhaseTransitionSolver.ts`：**
   * `ent.materialId === 'shape_memory_alloy'` の名指し分岐を削除し、`memorizedShapeScale` と `metastableWellBarrier` を持つすべての結晶固体に共通の復元ロジックを適用する。
   * `applyLazyMicroBending` の 3分岐比率（`0.45`, `0.3`, `0.35`）を `plasticity` と $\Psi$ に基づく**合計 `1.0` の厳密エネルギー保存分配**へ修正。
   * 気化・破断時の固定分割数・速度定数を余剰エネルギー $\Delta E = U_{\text{vib}} - U_{\text{bind}}$ からの運動エネルギー保存則へ置換し、破裂時は `ent.enclosedMediumDensity` を空間へ解放する。
   * 燃焼消費レートを局所パケットの `grid.reactivityPotential[idx]` と熱振動の積に比例させる。
2. **`DualPacketizer.ts`：**
   * Pack / Unpack 閾値にヒステリシス帯（Pack `< 0.20 * cellSize`、Unpack `> 0.28 * cellSize`）を設けてチャタリングを防止。
   * 臨界ホットスポット閾値 `15.0` のハードコードを削除し、グループ内最小 `bindingEnergy` に対する相対判定へ変更。
   * Unpack 時に `residualStrain` と `elasticEnergy` の差分を子要素へ還元し、`isCriticalSubgrid` フラグの適切な減衰・再評価を実装。
3. **`SpaceEngineCore.ts`：**
   * 物体（`SpaceEntity`）と空間パケット（`SpacePacketGrid.vibrationEnergy`）の間の**双方向熱交換フラックス**をステップ内に組み込み、摩擦熱やジュール熱が周囲の空気を温めて上昇対流を起こす因果ループを完結させる。
   * `absorbedBackgroundEnergy` を別変数で累積せず、背景パケットの `vibrationEnergy` へ保存則に従って分配・回収する。

---

## 2. Phase 9 回帰・創発検証テストスイート（`tests/phase9_pure_emergence.spec.ts`）

リファクタリング完了後、以下の8項目の自動テストを新規作成し、全テストパスを確認すること。

1. **摩擦熱のエネルギー保存則テスト：** 物体が摩擦で減速した際、失われた運動エネルギーと発生した熱エネルギーの総和が保存されること。
2. **電子親和力差による電池電圧創発テスト：** 異なる電子親和力ペアの電極を持つ電池グループが、固定値ではなく親和力差に応じた電圧（気圧落差）を自律生成すること。
3. **常温ヘリウムガスの密度差浮上と酸素拡散テスト：** 加熱なしの常温ヘリウムを注入した際、密度差浮力のみで上方パケットへ移動すること、および酸素濃度が風下へ移流・拡散すること。
4. **汎用結晶マテリアルの形状記憶復元テスト：** `shape_memory_alloy` 以外の任意マテリアルIDであっても、`memorizedShapeScale` と `metastableWellBarrier` が設定されていれば加熱により復元すること。
5. **ローレンツ振動子モデルによる連続光学応答テスト：** 周波数スイープに対して、透過率・反射率・吸収率が不連続なジャンプなく連続的に遷移すること。
6. **波速低下（$c_{\text{eff}} \to 0$）による連続的事象の地平面創発テスト：** 高エネルギー集中により屈折率が連続的に増大し、ハードコード閾値なしで波動の脱出が閉じ込められること。
7. **DualPacketizer のヒステリシス＆疲労履歴引き継ぎテスト：** 境界サイズ付近で Pack/Unpack がチャタリングしないこと、および Pack 中に蓄積した `residualStrain` が Unpack 後の子要素へ引き継がれること。
8. **摩擦熱 $\to$ 周囲空気加熱 $\to$ 上昇対流の完全連鎖テスト：** 2つの物体をこすり合わせて発生した摩擦熱が空間パケットの `vibrationEnergy` へ伝わり、周囲の空気に上昇気流（`py > 0`）を創発させること。
```

---

これで、これまでの議論で組み上げた設計思想と、Phase 6〜8 の全コード監査で判明した修正ポイントが **1つの統合仕様書（`ANTIGRAVITY_MASTER_DIRECTIVE_V3.md`）** にまとまりました。
これを AntiGravity に渡して Phase 9 を実行させれば、コード上のハードコードやエネルギー収支のズレが一掃され、名実ともに「空間演算を起点とした純粋創発エンジン」として仕上がります！