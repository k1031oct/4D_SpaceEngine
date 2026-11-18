# 4D Scale Space Engine（空間演算エンジン）

従来の「物体（剛体・質点）」を主語とする物理エンジンではなく、**「空間そのもの（可変体積の空間パケット）」を主語として物理現象を第一原理から創発させる4次元空間演算エンジン**および科学サンドボックスです。

---

## コアコンセプト

1. **空間の歪みが主役：** 空間パケットごとの気圧偏差 $\Delta P$（ポテンシャル $\Phi$）・運動量フロー $\vec{P}$・渦度 $\vec{\omega}$・内部振動 $U_{\text{vib}}$ の交換のみから、電荷・磁力・重力・熱・摩擦が創発する。
2. **第4の空間軸「知覚スケール（$\log_{10} L$）」：** 観測者の速度と近接オブジェクトに応じて空間パケットが動的に分割・統合され、原子から銀河まで単一の無次元相対エネルギールールでシームレスに動作する。
3. **マルチプラットフォーム設計：** 演算コア（Pure Core）を UI・描画層から完全に分離し、**Windows（ローカル）・Webブラウザ・Android** への展開・移植を前提としている。

---

## ドキュメント構成

| ファイル | 役割 |
| :--- | :--- |
| [4d_scale_space_engine.md](./4d_scale_space_engine.md) | 空間演算エンジンの基本設計理念・数理モデル・構造説明書 |
| [DATA_FLOW.md](./DATA_FLOW.md) | **実装の正解（Source of Truth）**。MVVM + Repository パターンに基づくデータフロー・型定義 |
| [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md) | Phase 1〜4 の実装計画、検証ベンチマーク、移植戦略 |

---

## アーキテクチャ方針とマルチプラットフォーム実行

* **開発・検証基盤：** TypeScript + Vite + Three.js（ローカル即起動・単体テスト環境 Vitest）
* **設計パターン：** MVVM + Repository パターン（`SpaceStateRepository` / `SandboxViewModel` / `SandboxUiState`）
* **移植性：** 演算コア（`src/core/`）は DOM・Three.js 非依存の純粋 TypeScript（TypedArray ベース）で構築。

### ローカル起動・テスト・展開手順

```powershell
# 1. 依存関係インストール
npm install

# 2. 数値安定性・物理創発・マルチスケール全テストの実行
npm test

# 3. 開発サーバー起動（Web / Windows ローカル確認）
npm run dev

# 4. 本番ビルド（dist/ 配下へ相対パス構成で出力 → Tauri/Electron や Android Capacitor/WebView へそのまま組込可能）
npm run build
```
