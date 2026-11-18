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
