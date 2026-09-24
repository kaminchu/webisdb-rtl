# WebISDB-RTL

ブラウザだけで動くワンセグ (ISDB-T) 受信アプリです。RTL-SDR を WebUSB で制御し、日本の
地上デジタルテレビ放送のワンセグ信号をブラウザ内で復調して、映像・音声・字幕を再生します。
ネイティブアプリもバックエンドサーバーもインストールも不要です。

USB ドライバ、OFDM 復調、FEC、MPEG-TS デマックス、映像・音声デコードまでをすべてクライアント
サイドで完結させるため、GitHub Pages で配信でき、オフライン起動可能な PWA としてインストール
できます。

## 主な機能

- **独自 WebUSB RTL-SDR ドライバ** — RTL2832U ベースバンドに加え、R820T2 (Blog V3)、
  R828D (Blog V4)、FC0013 チューナーに対応。
- **ISDB-T ワンセグ復調** — DC 除去、64/63 MSps への分数リサンプリング、GI 相関による
  OFDM 同期、搬送波周波数オフセット補正、TMCC 復号、チャネル推定・等化、周波数/時間/ビット
  デインターリーブ、デパンクチャ + Viterbi、エネルギー逆拡散、Reed–Solomon RS(204,188) を
  経て MPEG-TS を生成。
- **MPEG-TS 解析** — PAT / PMT / SDT / EIT / NIT / TDT / TOT とストリーム統計。
- **再生** — WebCodecs による H.264 映像と AAC 音声、A/V 同期、字幕描画、主/副音声の切り替え、
  設定可能なジッタバッファ。
- **EPG（番組表）** — ライブ EIT と IndexedDB に保存した番組情報から複数局横断の番組表を生成し、
  番組表から選局可能。
- **選局・スキャン** — 物理チャンネル 13〜52、周波数直接指定、地域・送信所からの選択、GPS
  自動選択、チャンネルスキャンとサービス取得。
- **診断** — Signal level、C/N、MER、周波数オフセット、USB/IQ/DSP スループット、バッファ占有量、
  スペクトラム表示。
- **PWA** — Service Worker によるキャッシュでオフライン起動が可能。一度読み込めば、UI と
  取得済みチャンネルデータはネットワーク接続なしで動作します。

## 動作要件

- **ブラウザ**: Android / Windows / macOS 版 Google Chrome。WebUSB と WebCodecs が必要なため、
  Firefox と Safari は対象外です。ページは HTTPS（または `localhost`）で配信する必要があります。
- **ハードウェア**: RTL-SDR Blog V3 (R820T2)、RTL-SDR Blog V4 (R828D)、または FC0013 チューナー
  搭載の汎用 RTL2832U ドングル。信号を受信するには UHF 地上波用のアンテナが必要です。
- **実行環境**: 開発・ビルドには Node.js と npm が必要です。

## はじめかた

```bash
npm install
npm run dev
```

Vite が表示する HTTPS URL を開き、視聴画面でステージをクリックして RTL-SDR デバイスを選択
します。チャンネルが未設定の場合は先に設定画面が開くので、地域と送信所を選ぶかチャンネル
スキャンを実行してから視聴画面に戻ります。

## コマンド

```bash
npm run dev          # Vite 開発サーバー (HTTPS)
npm run build        # tsc -b && vite build -> dist/
npm run preview      # 本番ビルドのプレビュー
npm test             # Vitest を実行
npm run test:watch   # Vitest ウォッチモード
npm run typecheck    # tsc -b --force
npm run lint         # oxlint
npm run format       # oxfmt . (書き込み)
npm run format:check # oxfmt --check .
npm run knip         # 未使用コードの検出
npm run ci           # lint + format:check + typecheck + test + knip
```

## WebAssembly DSP カーネル

負荷の高い DSP 段は `wasm/<name>/` の Rust クレートとして実装し、`wasm32-unknown-unknown`
にコンパイルします。コンパイル済みの `.wasm` は base64 として `src/dsp/wasm/<name>.bytes.ts`
にコミットされているため、`build` と `test` に Rust ツールチェーンは不要です。

```bash
rustup target add wasm32-unknown-unknown   # 初回のみ
npm run build:wasm                          # すべて再ビルド -> src/dsp/wasm/*.bytes.ts
```

カーネル: `fft`、`ofdm`、`demap`、`resample`、`deinterleave`、`viterbi`、`reed_solomon`。
TypeScript の参照実装は `src/dsp/stages/` に残してあり、対応する `*.test.ts` で WASM ラッパーと
比較しています。

## アーキテクチャ

```text
IQSource (RTLSDRSource | IQFileSource)
  │  U8/I8/F32 IQ チャンク（メインスレッド、WebUSB）
  ▼
Receiver Worker ─ DSP パイプライン
  DC 除去 → 64/63 MSps リサンプル → OFDM 同期 → FFT → キャリア抽出
  → TMCC → チャネル推定・等化 → FEC（デインターリーブ、Viterbi、RS）
  → MPEG-TS                                                    (Transferable Uint8Array)
  ▼
TS Worker ─ デマックス & PSI/SI
  PAT/PMT/SDT/EIT/NIT/TDT/TOT、統計、種別ごとの PES 分割
  ▼
メインスレッド ─ React UI
  WebCodecs 映像/音声、字幕描画、IndexedDB、メトリクス/スペクトラム
```

- `src/app/receiverController.ts` が Worker、IQ ソース、プレイヤー、アプリ状態を統括します。
- `src/iq/IQSource.ts` はハードウェア/ファイルの IQ 境界です。`RTLSDRSource` と `IQFileSource`
  が実装し、チューナーなしで DSP チェーンの開発・回帰テストを可能にします。
- `src/dsp/backend.ts` は TS/WASM の差し替え境界です。
- `src/models/` は純粋なデータモデルと PSI/SI/TMCC の DTO を保持します。
- `src/workers/protocol.ts` は Worker のメッセージ union を定義します。
- アプリ状態 (`src/app/store.ts`) は `useSyncExternalStore` を使用します。セレクタは安定した値を
  返す必要があります。

### ディレクトリ構成

```text
src/
├─ app/          SPA 状態、ナビゲーション、受信/スキャンの統括
├─ components/   汎用 UI (Button, Panel, ProgressBar, …)
├─ features/     watch / epg / settings / scan / shell 画面
├─ driver/       rtlsdr/ WebUSB ドライバ (rtl2832u, deviceProfile, tuner/{r82xx,fc0013})
├─ iq/           IQSource 抽象化、RTLSDRSource、IQFileSource
├─ dsp/          pipeline、oneSegDecoder、isdbtParams、stages/、wasm/
├─ ts/           MPEG-TS パケット/記述子/セクション/デマクサ/統計
├─ media/        WebCodecs 映像/音声デコーダ、A/V 同期、字幕、プレイヤー
├─ data/         japan/ 地域・送信所・チャンネル・局の JSON、arib/ デコード
├─ storage/      IndexedDB ラッパー、リポジトリ、localStorage 設定
├─ workers/      receiver.worker.ts、ts.worker.ts、protocol.ts
├─ models/       データモデルと DTO
└─ styles/       デザイントークンとグローバル CSS
wasm/<name>/     Rust DSP カーネル (Cargo 付き)
public/          manifest、アイコン、Service Worker
scripts/         build-wasm.mjs、fetch-channel-data.ts
```

## テスト

Vitest は happy-dom 環境で動作し、ソースの隣に配置した `*.test.ts` を実行します。DSP 層と TS 層
はキャプチャをコミットせず、合成ビルダーでテストします。実 IQ のテストファイルは必要に応じて
`tests/fixtures/`（gitignore 対象）から読み込みます。

## デプロイ

`main` への push で GitHub Actions が起動します。CI は push/PR ごとに実行され、`deploy.yml` が
アプリをビルドして `dist/` を GitHub Pages に公開します。Vite の `base` は `GITHUB_REPOSITORY`
から導出し、`VITE_BASE` で上書きできます。

## 対象範囲と制限

本プロジェクトは**日本国内の地上デジタル放送のワンセグ**のみを対象とします。フルセグ、
B-CAS/ACAS とスクランブル解除、録画、データ放送 (BML) の描画、Chrome 以外のブラウザは
対象外です。DRM の回避は行わず、スクランブルのない日本のワンセグをそのまま受信します。

## ライセンス

このリポジトリのライセンスは現時点で明示されていません。
