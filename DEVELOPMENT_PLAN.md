# 開発計画書（DEVELOPMENT_PLAN）

## 1. 開発方針と原則

1. **構造説明書の同期更新：** エンジン構造や数理モデルに新しい要素を追加・変更した際は、必ず [4d_scale_space_engine.md](./4d_scale_space_engine.md) と [DATA_FLOW.md](./DATA_FLOW.md) を先に更新する。
2. **Data-Flow Driven：** 実装前に [DATA_FLOW.md](./DATA_FLOW.md) でデータ構造と処理フローを確定させ、実装後は定義との整合性を検証する。
3. **マルチプラットフォーム移植性（Windows / Web / Android）：**
   * **Step A（現在）：** TypeScript + Vite + Three.js により、Windows ローカルおよび Web ブラウザ上で即座に実行・可視化検証できる環境を構築する。
   * **Step B（将来展開）：** プラットフォーム非依存の `src/core/` を、そのまま WebView/Capacitor（Android）や Tauri/Electron（Windows）に載せるか、TypedArray ベースの設計を活かして Rust/Wasm・C++(NDK) へ 1対1 移植する。

---

## 2. フェーズ別実装計画

### Phase 1：単一スケール・コア空間演算ソルバの確立（最優先）
前回プロトタイプで失敗した「微振動（ドリフト）」「数値不安定」「構造の混在」を解消し、強固な土台を作る。

* **実装タスク：**
  * [x] プロジェクト基盤構築（Vite + TypeScript + Vitest + Three.js）
  * [x] `SpaceStateRepository` / `SandboxViewModel` / `SandboxUiState` の骨格実装
  * [x] `SpacePacketGrid`（単一スケール3Dグリッド、TypedArray/構造体設計）
  * [x] `FieldSolver`（ポアソン圧力緩和、運動量フロー、渦度拡散、散逸 $\to U_{\text{vib}}$、CFL・拡散安定制御）
  * [x] `BoundaryProjector`（境界シェル6面への重力・外部ポテンシャル射影）
  * [x] `ContactSolver`（サブグリッドめり込み解消 + **静止摩擦ロック閾値**）
  * [x] Phase 1 数値検証テスト（Vitest）＋ 3D可視化ビューア
* **完了条件（ベンチマーク）：**
  * 重力射影下の机上で、複数オブジェクトが 3 秒以内に完全静止（速度 0.0）し、ドリフトしない。
  * 正・負ソース間の空間場から引力／斥力が創発する。

### Phase 2：マテリアル物性パラメータと電磁気・摩擦創発
* **実装タスク：**
  * [x] マテリアル辞書（ゴム風船、ウール布、紙片、アルミ缶、鉄球、ネオジム磁石、鋼板アース）
  * [x] `ContactSolver` への摩擦帯電（`electronAffinity` 差による電荷移動）・導体分配・アース接地組み込み
  * [x] `FieldSolver` との誘電分極誘導（`polarizability`）およびケルビン磁力（$\nabla |\vec{\omega}|^2$）連成
  * [x] 3Dマウス／タッチ操作（掴む・水平移動・垂直移動・こすり合わせ）の実装
* **完了条件（ベンチマーク）：**
  * 風船をこする $\to$ 紙片が浮き上がって吸着 $\to$ 鋼板アースに触れて放電・落下の一連の挙動が安定動作する。
  * ネオジム磁石が鉄球・鋼板へ安定吸着し、異常発振しない。

### Phase 3：第4の軸「知覚スケール（$\log_{10} L$）」と双対パケッティング
* **実装タスク：**
  * [x] 動的 Octree（中心窩 Foveated 分割・統合・保存則リメッシュ）
  * [x] `PerceptualScaler`（$L_{\text{obj}}, L_{\text{vel}}$ および手動スケールによるリアルタイム解像度算出）
  * [x] `DualPacketizer`（Pack / Unpack と多重極展開 $Q_{\text{net}}, \vec{p}, \vec{m}, U_{\text{conf}}$）
  * [x] 3領域自動分類（Visible / Projected / Absorbed）と境界シェル自動更新
  * [x] 無次元相対エネルギールールによる波速・拡散率のスケール不変スケーリング
* **完了条件（ベンチマーク）：**
  * 机上スケールから惑星スケールへシームレスにズームアウトしても、重力・電荷挙動が連続性を保つ。

### Phase 4：科学サンドボックス UI・プラットフォーム展開
* **実装タスク：**
  * [x] 相似性比較インスペクター（ミクロ・マクロ方程式パターンのリアルタイム解析・ハイライト）
  * [x] カスタムマテリアル・天体スポナー（`SandboxViewModel.spawnCustomEntity`）
  * [x] Windows ローカルパッケージ化（`base: './'` 相対パスビルド対応） / Android タッチ対応（`touch-action: none`）

### Phase 5〜8：統合空間演算アーキテクチャ v2.0（ISpatialComputeBackend・多安定井戸・量子トンネル）
* **実装タスク：**
  * [x] Task 1: `DATA_FLOW.md` / `DEVELOPMENT_PLAN.md` / `4d_scale_space_engine.md` の同期更新
  * [x] Task 2: `ISpatialComputeBackend` & `CpuTypedArrayBackend` 導入、残留歪み履歴 `residualStrain`・空白ポケットパラメータ統合
  * [x] Task 3: 極小スケール量子トンネル波動染み出し・強誘電/強磁性ヒステリシス統合
  * [x] Task 4: Lazy Micro-Unpack（金属疲労破断・形状記憶合金復元）および自己組織化結晶ロック実装
  * [x] Task 5: 金属疲労・形状記憶合金プリセット追加 & `tests/phase6_8_unified_physics.spec.ts`（11項目）全パス

### Phase 9：非創発ハードコード一掃＆完全第一原理リファクタリング
* **実装タスク：**
  * [x] Step 0: `DATA_FLOW.md` / `DEVELOPMENT_PLAN.md` 同期更新
  * [x] Task 1: `types.ts`, `ISpatialComputeBackend.ts` 純化（固定摩擦/反発削除、燃焼井戸化、ダウンキャスト廃止、時間刻み統合）
  * [x] Task 2: `MaterialCatalog.ts` 完全第一原理化（欠落格子パラメータ補完、`computeEmergentDensity` 導入）
  * [x] Task 3: `ContactSolver.ts` 刷新（摩擦熱運動エネルギー保存、床面定在波統一、指数気圧スパイク反発、$\Delta \chi$ 電池電圧創発）
  * [x] Task 4: `FieldSolver.ts` 刷新（中空密度一元化、連続波速低下 $c_{\text{eff}} \to 0$ 事象地平面、ローレンツ振動子複素屈折率光学）
  * [x] Task 5: `MediumFluxSolver.ts` 刷新（密度差浮力、酸素拡散、3軸アップウィンド移流、加重混合注入）
  * [x] Task 6: `PhaseTransitionSolver.ts` / `DualPacketizer.ts` / `SpaceEngineCore.ts` 統合（名指し分岐削除、ヒステリシス帯、双方向熱交換完結）
  * [x] 検証: `tests/phase9_pure_emergence.spec.ts`（8項目）＋ 既存全39テスト ＋ ビルド全パス

### Phase 10：複数レイヤー入れ子知覚スタック ＆ 階層跨ぎ・双方向相転移
* **実装タスク：**
  * [x] Task 0: `DATA_FLOW.md` / `DEVELOPMENT_PLAN.md` の設計草案承認
  * [x] Task 1: `NestedPerceptualStack` 実装（対数桁数スライド5層 Layer -1〜+3、時間階層間引き $1\times \to 1/60\times$、$10^{-6}\text{ m}$ デカップリング）
  * [x] Task 2: 上下双方向カスケード（窓外逃走ガス・熱の Layer +1/+2 還流とバタフライエフェクト帰還）
  * [x] Task 3: オブジェクトの階層跨ぎハンドオフ（Cross-Layer Handoff：観測者移動・窓外流出時の Co-Pack 追跡と窓内復帰 Unpack）
  * [x] Task 4: 「場（ガス）」$\leftrightarrow$「オブジェクト（凝縮体）」双方向相転移パイプライン（凝縮昇格 Materialization ＆ 気化還元 Vaporization の厳密保存則）
  * [x] Task 5: 観測者移動・マルチレイヤー・双方向相転移の検証テストスイート（`tests/phase10_nested_stack.spec.ts`）追加＆ビルド全パス

### Phase 11：論理変換モジュール ＆ 生命エージェント層（設計草案）
* **実装タスク：**
  * [ ] Task 1: `EnergyModuleSolver` 実装（運動・光・熱・電力のエネルギー型変換、効率ロス廃熱・排気排出、エラー泥塊トークン生成）
  * [ ] Task 2: `BioAgentSolver` 実装（空間パケット五感勾配センサー、代謝消費による能動推力、個体識別 `instanceId` ＆逃避・採餌行動）
  * [ ] Task 3: 工場廃熱・川ゾーニング・生態系変化の統合検証テスト（`tests/phase11_logic_and_bio.spec.ts`）追加＆ビルド全パス

### Phase 12〜13：Android ネイティブ移植 ＆ 「テラリウム・ビルダー」製品化
* **実装予定：** TypeScript Pure Core の Kotlin（`FloatArray`/`IntArray` + Coroutines）への 1対1 移植、Jetpack Compose 2D/2.5D ビュー、Room DB スクラップブック、外部 JSON Mod ローダー連携
