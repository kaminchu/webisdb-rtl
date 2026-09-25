# アーキテクチャ

WebISDB-RTL の内部構成をまとめた開発者向けドキュメントです。ここに置くファイルは
技術情報のみとし、日本語で記述します。使い方は [README.ja.md](../README.ja.md) を参照して
ください。

## 基本方針

- バックエンドを持たない。配布物は静的な HTML/CSS/JS のみで、GitHub Pages などに置ける。
- 受信から再生までをすべてクライアントサイドで完結させる。ネイティブアプリも常駐プロセスも不要。
- DSP のホットパスは Rust で書き、WebAssembly にコンパイルして呼び出す。
- デバイス制御は WebUSB。ページは HTTPS または `localhost` で配信する必要がある。
- オフライン起動のため Service Worker でキャッシュし、PWA としてインストールできる。

## 実行時構成

アプリは 3 つの実行コンテキストで構成されます。

```text
メインスレッド
  IQSource (RTLSDRSource | IQFileSource)
    │  U8/I8/F32 IQ チャンク（WebUSB またはファイル）
    ▼
Receiver Worker ─ DSP パイプライン
  DC 除去 → 64/63 MSps リサンプル → OFDM 同期 → FFT → 搬送波抽出
  → TMCC → チャネル推定・等化 → FEC（デインターリーブ、Viterbi、RS）
  → MPEG-TS                                            (Transferable Uint8Array)
    ▼
TS Worker ─ MPEG-TS デマックス & PSI/SI
  PAT/PMT/SDT/EIT/NIT/TDT/TOT、統計、種別ごとの PES 分割
    ▼
メインスレッド ─ React UI
  WebCodecs 映像/音声デコード、A/V 同期、字幕描画、IndexedDB、メトリクス/スペクトラム
```

| コンテキスト    | 主な役割                                     | 主なファイル                                            |
| --------------- | -------------------------------------------- | ------------------------------------------------------- |
| メインスレッド  | WebUSB ドライバ、IQ 供給、UI、WebCodecs 再生 | `src/driver/`、`src/iq/`、`src/media/`、`src/features/` |
| Receiver Worker | IQ → MPEG-TS の DSP パイプライン             | `src/dsp/`、`src/workers/receiver.worker.ts`            |
| TS Worker       | MPEG-TS のデマックスと PSI/SI 解析           | `src/ts/`、`src/workers/ts.worker.ts`                   |

Worker 間のメッセージ型は `src/workers/protocol.ts` の union で定義します。IQ サンプルと
MPEG-TS は `Transferable` な `ArrayBuffer` としてコピーなしで受け渡します。

## WebUSB RTL-SDR ドライバ

`src/driver/rtlsdr/` に、RTL2832U と各種チューナーを WebUSB で直接制御する実装があります。

- `usbTransport.ts` — WebUSB の薄い抽象。テストでは `MockUsbTransport` に差し替えられる。
- `rtl2832u.ts` — レジスタ読み書き、I2C、サンプリング設定、IQ 転送。
- `deviceProfile.ts` — 起動時に I2C でチューナーを判定し、機種プロファイルを返す。
- `tuner/r82xx.ts` — R820T2 / R828D 用。
- `tuner/fc0013.ts` — Fitipower FC0013 用。

チューナー判定は I2C の既知レジスタ値を読み、次のように対応します。

| チューナー | I2C アドレス | 判定する機種                    |
| ---------- | ------------ | ------------------------------- |
| R820T2     | `0x34`       | RTL-SDR Blog V3                 |
| R828D      | `0x74`       | RTL-SDR Blog V4                 |
| FC0013     | `0xc6`       | 汎用 RTL2832U + FC0013 ドングル |

RTL-SDR の制御上の決まりとして、`bRequest` は常に 0 で、ブロックは `wIndex`、レジスタ
アドレスは `wValue` に置きます。デモッドへの書き込み後は毎回 page `0x0a`、addr `0x01` の
コミット読み出しを行います。

## IQ ソース抽象

`src/iq/IQSource.ts` がハードウェアとファイルの共通境界です。

- `RTLSDRSource` — WebUSB 経由の実機。
- `IQFileSource` — 保存済み IQ ファイル（U8 I/Q など）を読み込むオフライン用。

同じ DSP パイプラインをチューナーなしで回せるため、回帰テストや開発に使えます。

## DSP パイプライン

`src/dsp/pipeline.ts` の `OneSegPipeline` が受信チェーン全体を担います。

1. U8/I8/F32 の IQ を複素サンプルへ変換。
2. DC 除去（`WasmDcRemoval`）。
3. 入力サンプルレートから one-seg の 64/63 MSps へ分数リサンプル（`WasmFractionalResampler`）。
4. GI 相関による OFDM 同期（`WasmOfdmSynchronizer`）。シンボル開始位置と小数周波数
   オフセット、C/N の元になる相関値（gamma / phi）を求める。
5. 整数キャリア周波数オフセット（CFO）推定。既知の TMCC 搬送波上で CFO に不変な BPSK
   指標を計算し、±320 搬送波の範囲で抽出基準位置を決める。
6. one-seg FFT（`WasmFftBackend`）と中央セグメントの搬送波抽出。
7. TMCC 復号（`TmccDecoder`）。モード、ガードインターバル、レイヤ A の変調方式・符号化率・
   時間インターリーブ長を取得。
8. チャネル推定・等化（`WasmChannelEstimator` / `equalizeWasm`）。スキャッタードパイロットから
   伝達関数を求める。
9. `OneSegDecoder` による FEC と MPEG-TS 生成。

取得は Mode 3 / GI 1/8 から始め、全モード×GI の組み合わせへ順にフォールバックします。整数
CFO は全帯域キャプチャで数百搬送波ずれることがあるため、TMCC 搬送波を使った指標で抽出基準
そのものをずらして吸収します。

### 対応パラメータ

| 項目                 | 対応範囲                                                         |
| -------------------- | ---------------------------------------------------------------- |
| 伝送モード           | Mode 1 / 2 / 3                                                   |
| ガードインターバル比 | 1/4、1/8、1/16、1/32                                             |
| 部分受信             | あり（レイヤ A、中央セグメントのみ）                             |
| 変調方式             | DQPSK / QPSK / 16QAM / 64QAM（TMCC に従う）                      |
| 内符号の符号化率     | 1/2、2/3、3/4、5/6、7/8                                          |
| 物理チャンネル       | 地上 UHF 13〜52ch（中心周波数 `473.142857 + (n-13)*6` MHz）      |
| 対象                 | 日本の地上デジタル放送のワンセグのみ（フルセグ・BS/CS は対象外） |

## OneSegDecoder（FEC）

`src/dsp/oneSegDecoder.ts` は等化済みデータ搬送波から MPEG-TS バイト列を生成します。
OFDM シンボルごとに次の順で処理します。

周波数デインターリーブ → 時間デインターリーブ → キャリア判定（デマップ）→ ビット
デインターリーブ → デパンクチャ / Viterbi → バイトデインターリーブ → エネルギー逆拡散 →
Reed–Solomon RS(204,188) → TS パケット組み立て。

時間デインターリーブをデマップより先に行うのは、DQPSK の差動検出が時間デインターリーブ後の
同一搬送波の前シンボルを必要とするためです。エネルギー逆拡散の PRBS は OFDM フレームごとに
再初期化するため、呼び出し側は TMCC フレーム境界からシンボルを供給します。

## WebAssembly カーネル

負荷の高い DSP 段は単一の `wasm/dsp/` クレート内の Rust モジュールとして実装し、
`wasm32-unknown-unknown` にコンパイルします。コンパイル済みの `.wasm` は base64 として
`src/dsp/wasm/dsp.bytes.ts` にコミットし、`src/dsp/wasm/dsp.ts` で一度だけインスタンス化
するため、全カーネルが 1 つの線形メモリとアロケータを共有します。通常の `build` と
`test` に Rust ツールチェーンは不要です。

```bash
rustup target add wasm32-unknown-unknown   # 初回のみ
npm run build:wasm                          # 再ビルド -> src/dsp/wasm/dsp.bytes.ts
```

| モジュール     | 役割                                            |
| -------------- | ----------------------------------------------- |
| `fft`          | forward FFT                                     |
| `ofdm`         | GI 相関同期                                     |
| `demap`        | チャネル推定・等化・デマップ                    |
| `resample`     | DC 除去、分数リサンプル、NCO 周波数補正         |
| `deinterleave` | 周波数/時間/ビット/バイトの各デインターリーブ   |
| `viterbi`      | ストリーミング Viterbi 復号（デパンクチャ含む） |
| `reed_solomon` | RS(204,188) 誤り訂正                            |
| `tmcc`         | TMCC 復号（フレーム同期・DSC パリティ）         |
| `frontend`     | ロック後の NCO/同期/FFT/TMCC/デマップ融合       |
| `oneseg`       | 上記 FEC 段を融合した one-seg デコーダ          |

`oneseg` は等化後のデータキャリアをまとめて受け取り、時間デインターリーブから TS 組み立て
までを WASM 内で完結させて MPEG-TS を返します。`frontend` はロック後のサンプルバッファ・NCO・
トラッキング同期・FFT・TMCC・チャネル推定/等化を保持し、シンボルごとの中間データをホストへ
戻しません。`OneSegDecoder` と `OneSegPipeline` はこれらの融合カーネルを呼びます。

TypeScript の参照実装は `src/dsp/stages/` に残してあり、対応する
`src/dsp/wasm/*.test.ts` で WASM ラッパーの出力と比較します。TS/WASM の差し替え境界は
`src/dsp/backend.ts` です。

## TS / PSI/SI

`src/ts/` が MPEG-TS を解析します。

- `packet.ts` / `TransportStream.ts` — 188 バイトパケットの同期・分割。
- `demuxer.ts` — PID ごとの分離、PSI セクションの再構成、PES の種別分割。
- `descriptors.ts` — 記述子のデコード。
- `sections/` — PAT / PMT / SDT / EIT / NIT / TDT / TOT と時刻表現。
- `crc32.ts` — PSI セクションの CRC。
- `statistics.ts` — ストリーム統計。

結果は `src/models/si.ts` の DTO として Worker からメインスレッドへ送られます。

## メディア再生

`src/media/` がデコードと再生を担当します。

- `elementaryStream.ts` — PES から映像/音声/字幕の基本ストリームを組み立てる。
- `videoDecoder.ts` / `audioDecoder.ts` — WebCodecs `VideoDecoder` / `AudioDecoder` の薄い
  ラッパー。H.264 と AAC を扱う。
- `avSync.ts` — PTS/DTS に基づく A/V 同期とジッタバッファ。
- `caption.ts` — ARIB 字幕の描画。
- `player.ts` — これらの統括。

## データモデルと永続化

- `src/models/` — 純粋なデータモデルと DTO。PSI/SI、TMCC、チャンネル、地域、受信品質など。
- `src/data/japan/` — 同梱の地域・送信所・チャンネル・局データ（JSON）と型付きローダー。
- `src/data/arib/` — ARIB 文字符号のデコードと外字処理。
- `src/storage/` — IndexedDB ラッパーとリポジトリ（events / services / stations /
  scanResults / receptionHistory）、および localStorage の設定。
- 設定（最後の地域・チャンネル、ゲイン、サンプルレート、再生バッファ、UI、デバッグ）は
  localStorage、番組情報などの大きなメタデータは IndexedDB に保存する。

## ディレクトリ構成

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
wasm/dsp/        Rust DSP カーネル (単一 Cargo クレート、融合 oneseg 含む)
public/          manifest、アイコン、Service Worker
scripts/         build-wasm.mjs、fetch-channel-data.ts
```

## テスト

Vitest を happy-dom 環境で実行し、ソースの隣に置いた `*.test.ts` を対象にします。

- DSP 層と TS 層は実キャプチャをコミットせず、合成ビルダーで決定的にテストする。
- WASM カーネルは `src/dsp/stages/` の TypeScript 参照実装と出力を比較する。
- WebUSB ドライバは `MockUsbTransport` でレジスタ列を検証する。
- 実 IQ のテストファイルが必要な場合は `tests/fixtures/`（gitignore 対象）から読み込む。

```bash
npm test             # Vitest を実行
npm run test:coverage
npm run ci           # lint + format:check + typecheck + test + knip
```

## ビルドとデプロイ

```bash
npm run build        # tsc -b && vite build -> dist/
npm run preview      # 本番ビルドのプレビュー
```

Vite の `base` は `GITHUB_REPOSITORY` から導出し、`VITE_BASE` で上書きできます。`main` への
push で GitHub Actions が CI を実行し、`deploy.yml` が `dist/` を GitHub Pages に公開します。
