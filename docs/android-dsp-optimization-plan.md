# Android向けDSP軽量化：実装方針とエージェント引き継ぎ

本書は、Fire HD 8 第12世代＋Chromeでの持続的なワンセグ再生を目指し、
別の実装エージェントが調査・実装・評価を引き継ぐための資料である。
**この文書にある提案は、実装済みの機能と明記したものを除いて未実装。**

## 0. 実装状況（この節だけが現状の正）

- Phase 0：`ThroughputMetrics.realTimeFactor`を追加し、`dspProcessingMsPerSecond`を
  「入力信号1秒あたり」に修正。`iq-file`経路の`pushIq`計時漏れを修正。Worker全体の
  入力・処理・破棄カウンタやACKは**未実装**。
- Phase 1：residentポインタ経路を実装。`WasmU8Decimator.processResident`、
  `WasmFractionalResampler.processResident`、`WasmFrontend.pushPointers`・
  `pendingPointers`、`WasmOneSegDecoder.decodePointers`、`OneSegDecoder.decodeResident`、
  locked時の`OneSegPipeline`接続。Frontend→FECのstagingコピーを削除。
- Phase 1：Receiver worker→MainのTS二重`.slice()`を削除（所有コピーをTransfer）。
- Main→Receiver workerのIQコピー削減、FFT/Viterbi等のf32・SIMD化は**未実装**。
- これらは開発機x86で既存テスト（実録音IQ含む）により検証済み。**Fire実機評価は未実施**。

コード確認時点のHEAD：`128755b`。
実装開始時には`git status`、履歴、`AGENTS.md`を再確認し、以降の変更と突き合わせること。

## 1. ユーザーの目的と今回の症状

### 1.1 ユーザーから確認できている事実

- 対象端末は **Amazon Fire HD 8 第12世代（gen12）**。
- その端末にChromeをインストールして本アプリを使用している。
- 「しばらくすると遅くなる」。開始直後から常に再生不能という報告ではない。
- アプリの再生遅延時間を延ばすと、遅くなるまでの時間も延びる。
- ユーザーは、f32／SIMD化とコピー削減を目指している。
- 受信を犠牲にした単なる間引きや、バッファ拡大で問題を先送りする対応ではなく、
  **軽量化を維持しつつ視聴できる状態**を求めている。
- 今回の依頼は実装方針の文書化。次の実装作業をこの文書から開始する。

### 1.2 まだ確認できていないこと

- Fire OS／Chromeのバージョン、Chromeプロセスの32/64-bit、メモリ容量の機種差。
- 使用チューナー、受信局、ゲイン、端末上で選択しているフロントエンドモード。
- 再生遅延の設定値、症状までの実時間、音声と映像のどちらから崩れるか。
- 電源接続・画面輝度・端末温度・省電力設定と症状の相関。
- DSP各段の時間、未処理IQの量、再生側の余裕、GC、USB到着ジッタ。
- ボトルネックがDSPなのか、デコード／音声出力／描画なのか。

会話中に省電力コアやCortex-A55系という説明をしたが、実機のSoC／コア構成・ABIは
本作業では調査していない。**その説明を検証済みの端末仕様として引き継がないこと。**
端末名から推測するだけでなく、実機情報とブラウザ上の計測を記録する。
ARM64対応SoCでも、実行中のChromeが64-bitとは限らない。

### 1.3 現段階の仮説

再生遅延の拡大で発症が後ろにずれる現象は、再生バッファを少しずつ使い切る
「持続的な供給不足」と整合する。ただし、それだけでDSP不足と断定しない。
温度上昇、GC、USB欠落、WebCodecs、PTS／再生時計の問題も切り分ける。

処理速度を`v`（番組秒／壁時計秒、`v < 1`）、実際の再生可能な蓄えを`B`秒とすると、
単純化した枯渇時間は`B / (1 - v)`秒になる。これは診断用の説明モデルであり、
設定した遅延秒数がそのまま実際の蓄えになる保証ではない。

## 2. これまでの経緯

### 2.1 最近のコミット

| コミット  | 内容・今回との関係                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `9f34ac1` | 周波数補正とリサンプリングのWASM処理を軽量化                                                           |
| `332025a` | WASMカーネルのSIMD化・ホスト境界コピー削減。一部最適化済みだが、全カーネルがf32 SIMDという意味ではない |
| `28ee79d` | 未ロック時の獲得スキャンを軽量化                                                                       |
| `8aa7dbc` | WASMを単一モジュールに統合し、one-seg FECを融合                                                        |
| `3da3c6b` | TMCCをWASM化し、ロック後の同期・FFT・等化等を融合                                                      |
| `0e1b8df` | Rayon対応・FFTと獲得スキャンの並列化を一度導入                                                         |
| `421ebc5` | 上記Rayon対応をrevert。現状で有効と考えない。revertの理由はこの会話では確認していない                  |
| `4198ae4` | ISDB-Tモードの128/63 MSps入力とU8展開／DC除去／2:1間引きを追加                                         |
| `8fadf1f` | 単純間引きによる折り返し対策として63タップFIRを追加                                                    |
| `128755b` | 31タップ専用ハーフバンドへ最適化し、実放送IQの映像・音声復号を検証                                     |

### 2.2 ISDB-Tモードの意味

RTL2832Uの既存のサンプルレート生成機能を利用する。
「RTL2032」は会話中の呼び違いで、対象は **RTL2832U**。

```text
従来モード
  RTL2832Uが1.2 MSpsなどを生成
    → U8展開 → DC除去 → 分数リサンプラ → 64/63 MSps

ISDB-Tモード
  RTL2832Uが128/63 MSpsを生成
    → U8展開＋専用帯域制限＋2:1間引き＋DC除去 → 64/63 MSps
```

ハードウェアにFFTやViterbiを移管したわけではない。
ソフト側の分数リサンプリングを単純な整数比変換に置き換えられるレートを
ハードウェアで生成させた、という役割分担である。
FFT、TMCC、等化、FEC、TS生成は現在もブラウザ内のWASMで処理している。

純正Realtekの調査では単純2:1間引きが示唆されたが、現状の通常RTL-SDR設定では
周辺セグメントも入力IQに含まれる。対象ワンセグ自体が狭帯域でも、周辺信号が
出力帯域に折り返すため、**帯域制限なしの間引きへ戻してはいけない**。
純正の専用レジスタ列・ハードウェア帯域制限は未確定であり、今回の最適化の前提にしない。

### 2.3 直近の実測結果とその限界

詳細は[ISDB-Tフロントエンドの軽量化と受信検証](isdbt-frontend-validation.md)。

- 開発機上で、RF 100 ms分の前処理をホストコピー込みで比較。
  - 従来1.2 MSps経路：約5.5 ms。
  - 最適化後のISDB-T経路：約1.8 ms。
  - 約3倍高速、処理時間は約67%減少。
  - 変更前の63タップ版は別測定で約13.8 ms。
- これは**前処理だけの速度比**。FFT/FEC、再生、Fire実機の値ではない。
- ISDB-TモードのUSBデータ量は約4.06 MB/sで、1.2 MSpsの約2.4 MB/sに対し約1.69倍。
- 開発用RTL2832U＋FC0013、19.7 dBで19ch・23chを各20秒録音。
  - 両局でMode 3 / GI 1/8、TMCCロック。
  - TSは19chで5410、23chで5396パケット。
  - 映像PES／音声PESは60／160、60／162。
  - H.264 320×180、HE-AAC 48 kHzステレオをFFmpegで復号。
  - 映像は283／272フレーム。
  - IQ 20秒分をアプリのパイプラインで処理する時間は約9.7／9.9秒。
- 録音開始・終了付近には不完全なPESやSPS/PPS待ちの警告があった。
  従来モードでも確認された。先頭5秒と末尾を除いた10秒区間は
  再エンコードなしで抽出し、FFmpegの`-xerror`付き復号が成功した。
- **Android実機でのライブ再生を確認した結果ではない**。
- `128755b`作業時の全テストは540成功・3スキップ。録音の有無で件数は変わる。

## 3. 現在の構成と具体的な調査箇所

### 3.1 所有権とスレッド

```text
Main thread
  WebUSB → RTLSDRSource → ReceiverController
    ↓ IQ ArrayBufferをTransferableで送信
Receiver worker（主要DSPはここで同期実行）
  OneSegPipeline
    → U8Decimator / FractionalResampler
    → acquisition または WasmFrontend
    → WasmOneSegDecoder
    ↓ TSをTransferableで送信
Main threadで転送を中継
    ↓ TSをTransferableで送信
TS worker → PES等 → Main threadのOneSegPlayer / WebCodecs / Web Audio
```

WASMは`wasm/dsp/`の単一crate。`src/dsp/wasm/dsp.ts`が同一JS realm内の
インスタンス／線形メモリを共有する。**異なるWorker間で同じメモリを共有しているという意味ではない**。
現在はSharedArrayBufferやRayonを使う構成ではない。

### 3.2 ソースコードの案内

| 対象           | ファイル・主な関数                                                       | 現状と狙い                                                          |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| USB入力        | `src/iq/RTLSDRSource.ts`、`readLoop`                                     | 256 KiBの転送を8本キュー。コールバックは複数購読可能                |
| Main→Worker    | `src/app/receiverController.ts`、`#attachSource`                         | IQの`.slice()`後にTransfer。所有権契約を確認して削減                |
| Worker統計     | `src/workers/receiver.worker.ts`、`buildStats`、`iqChunk` handler        | 処理時間はあるが、信号時間基準とキュー観測が不十分                  |
| DSP制御        | `src/dsp/pipeline.ts`、`pushIq`、`processLocked`、`drainFrontend`        | ロック前後の状態とWASM境界を管理                                    |
| 間引き         | `wasm/dsp/src/resample.rs`、`U8Decimator::process_halfband`              | 31タップ、対称8組＋中央。入力f32、積和とDC状態はf64                 |
| 汎用リサンプラ | 同上、`fir_dot`、`FractionalResampler`                                   | 既にf64x2 SIMDを使う部分あり。新規SIMD化と混同しない                |
| NCO            | 同上、`NcoCorrector::process`                                            | f64位相・再帰発振。256サンプルごとにsin/cosで再アンカー             |
| ロック後       | `wasm/dsp/src/frontend.rs`、`Frontend::push`                             | NCO、同期、FFT、TMCC、等化を融合。FECとの境界は残る                 |
| FFT            | `wasm/dsp/src/fft.rs`、`transform`                                       | f32配列、f64バタフライと逐次twiddle更新。明示的f32 SIMD FFTではない |
| 同期           | `wasm/dsp/src/ofdm.rs`、`SyncState::find_peak`                           | f64相関。追跡は±8候補ごとにCP全体の相関を再計算                     |
| 等化           | `wasm/dsp/src/demap.rs`、`estimate_into`、`demap_equalize`               | f64演算、pilot indexのVecを生成。f32 SIMDと割当削減候補             |
| FEC            | `wasm/dsp/src/oneseg.rs`、`process_symbol`                               | deinterleaveからRSまで既に融合。実際のViterbiはstreaming版          |
| Viterbi        | `wasm/dsp/src/viterbi.rs`、`StreamingState::step`                        | 64状態、f64メトリック、毎step正規化、127段traceback                 |
| 再生           | `src/media/player.ts`、`audioDecoder.ts`、`videoDecoder.ts`、`avSync.ts` | DSPと別にキュー・再アンカー・破棄・音声先読みを調査                 |
| 精度参照       | `src/dsp/stages/`、`src/dsp/wasm/*.test.ts`                              | TS参照とWASM比較。精度変更を検証する基盤                            |

`scripts/build-wasm.mjs`は既に`+simd128`と`wasm-opt -O3 --enable-simd`を使う。
**コンパイルフラグを足すだけの変更では、今回必要な最適化にならない。**

## 4. 実装の原則

1. Android上の計測を先に整備し、重い段を確認する。
2. コピー削減と数値演算の変更は別々に評価する。
3. 長時間の状態とサンプル単位の演算を分け、f64を一括置換しない。
4. 正常受信時の速度だけでなく、低SNR、ロック喪失、再獲得、retuneも確認する。
5. 既存の31タップ帯域制限を維持する。タップ数・カットオフ変更をf32化に混ぜない。
6. 測定して効果のない最適化は複雑さを増やしてまで採用しない。
7. JSの統計・UIを更新するためにシンボルごとにWASMを往復しない。
8. Rayon再導入、Worker増設、WebGPU化、チューナーレジスタ変更は初期スコープ外。
   単一Workerでの計測・コピー削減・SIMD化後にも不足すると分かった場合に別途検討する。

## 5. Phase 0：診断を正しい単位で取れるようにする

### 5.1 既存統計の問題

`receiver.worker.ts`の`dspMs.peek()`は直近の壁時計時間で割ったms/sを返す。
一方`ThroughputMetrics.dspProcessingMsPerSecond`のコメントは「入力信号1秒あたり」を示す。
この2つは異なる。Workerが飽和すると稼働率はほぼ100%に張り付くので、
その数値だけではRF 1秒を0.9秒／1.2秒のどちらで処理しているか判別できない。

また`bufferedSamples`はパイプライン内部のサンプルであり、
**Workerのイベントキューに未処理で溜まっているIQを含まない**。
現在のbuffer統計は処理済みの入力レート等から推定しており、真のバックログではない。
`droppedSamples`等、empty値を引き継ぐ項目も実測値と区別する。
`iq-file`経路ではライブ経路と同じ`dspMs`加算をしていない点も揃える。

FEC側の`sync_errors`は確認時点の`oneseg.rs`で初期化／resetされるが増分が見当たらない。
`packetErrors = 0`だけで誤りゼロと判断してはいけない。
必要ならRS成功／訂正不能、TS continuity discontinuityをそれぞれ実測する。

### 5.2 追加する計測

最低限、500〜1000 msの集計窓で以下を出力／保存できるようにする。

```text
session/generation、frontend mode、sampleRate、state
submittedSamples、processedSamples、droppedSamples（累積）
inputSignalSeconds = Σ(chunkSamples / chunkSampleRate)
dspElapsedMs = Σ(pushIq終了 - pushIq開始)
processingMsPerInputSecond = dspElapsedMs / inputSignalSeconds
realTimeFactor = dspElapsedMs / (1000 * inputSignalSeconds)
wallUtilization = dspElapsedMs / windowWallMs
pendingSignalSeconds、lastProcessedSequence、arrival/processing間隔
TMCC lock/loss/reacquire、TS bytes/packets、RS failures、continuity errors
WASM memory bytes、高水位、入力・出力・pendingバッファ容量
再生キュー長、audio/video別のPTS余裕、decodeQueueSize、late/drop/underrun
```

- `realTimeFactor < 1`が実時間処理の必要条件。目標値は後述。
- `pushIq`はコールバックの時間も含む。全体時間とカーネル限定時間を区別する。
- Worker受信開始／処理完了をACKして、Main側の送信済み累積との差で滞留量を求める。
  サンプルレートが変わる場合はセッションを分けるか、累積信号秒で計算する。
- ACKは小さい情報だけをバッチ化する。シンボルごとにpostMessageしない。
- ACKがMainに届くまでの遅れもあるため、ACKベースの未完了量とWorker内処理時間を併記する。
- sequenceの飛びだけではUSBデバイス内のサンプル欠落を検出できない。
  現行sequenceは受信したチャンクにアプリが付番している。
- セッションIDでretune／再接続前のACKや統計を除外する。
- MainとWorkerの`performance.now()`をそのまま引き算しない。
  往復ACK方式か、`performance.timeOrigin + performance.now()`で基準を揃える。
- Playerの`bufferedPes`だけでは再生可能秒数にならない。
  audio/video別にPTS、再生時計、デコード済み／未済を区別して余裕を算出する。
- 表示のためのオブジェクトは集計周期ごとに作る。React storeのselectorは安定値を返す。

`src/models/**`、`src/workers/protocol.ts`、`src/iq/IQSource.ts`はアーキテクチャ契約。
統計やACKを足す前に変更案を明示して調整し、必要最小限の後方互換な拡張にする。

### 5.3 各段の計測方法

最初はTS境界で前処理、獲得、`frontend.push`、FEC decodeを測る。
WASM内部は、オフラインのバッチベンチマークでFFT、NCO、同期、等化、Viterbiを分離する。
どうしてもライブの内部区間計測が必要な場合だけ、診断用の計時import等を追加する。
現在のローダーは`new WebAssembly.Instance(module, {})`なので、import追加にはローダー変更が必要。
シンボルごとのJS計時コールバックを常用する設計にはしない。

Fire上では最低15分、推奨30分の測定を行う。開始直後と熱的に落ち着いた後の
平均・p50/p95/p99・滞留の傾きを比較する。充電条件、画面輝度、受信品質、Chrome版を揃える。
温度／クロックを取得できなければ「熱による原因は未確定」として時間推移を残す。

## 6. Phase 1：数値を変えずにコピーと割当を減らす

### 6.1 現在のコピーを分類する

| 境界                    | 現状                                                | 方針                                                   |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| USB→MainのIQ            | WebUSBが返したUint8Array                            | 所有権を調べる。API都合のコピーとアプリコピーを区別    |
| Main→Receiver worker    | `#attachSource`で`.slice()`、コピーをTransfer       | 排他的所有を保証できるライブ経路でコピーを省く         |
| U8→WASM                 | `WasmU8Decimator.process`の`heap.u8(...).set(data)` | 当面1回残す。WebUSBから直接WASMへ書ける前提を置かない  |
| 間引き出力→JS           | Re/Imをそれぞれ`.slice()`                           | locked経路でポインタ／長さを返し、ホスト配列を作らない |
| JS→Frontend             | `WasmFrontend.push`でRe/Imをstagingへ`.set()`       | WASM内出力を直接`frontend_push`へ渡す                  |
| Frontend内部            | `append`、FFT作業領域、同期用バッファへのコピー     | まず維持。ホスト往復を消した後に実測して削減           |
| Frontend→FEC            | `pendingRe/Im()`のviewをFEC stagingへ`.set()`       | 同一メモリなのでポインタを直接渡す                     |
| FEC→JS TS               | `WasmOneSegDecoder.decode`の`.slice()`              | Transfer用所有バッファとして1回残す                    |
| Receiver worker→Main TS | `onTs`でさらに`.slice()`                            | 所有バッファの契約を確認し二重コピーを削除             |
| Main→TS worker          | 既にTransferで中継                                  | payloadコピーは増やしていない。中継廃止は別の設計変更  |

`pendingRe/Im()`は現在もviewであって、そこ自体がコピーではない。
その後の`WasmOneSegDecoder.decode()`内の`.set()`が余分なコピーである。

### 6.2 WASM内ブロックを受け渡すAPI案

これは提案名。既存公開契約を変えず、WASMラッパー内部のAPIとして追加する。

```ts
type WasmComplexBlock = {
  rePtr: number
  imPtr: number
  length: number // 複素サンプルまたはcarrier要素の数。呼出し側で単位を明示
}

// 所有者の次のprocess/reset/disposeまでのみ有効な借用ブロック
decimator.processResident(u8): WasmComplexBlock
frontend.pushResident(block): number
frontend.pendingResident(): { block: WasmComplexBlock; symbolCount: number }
decoder.decodeResident(block, symbolCount): Uint8Array // TSは所有コピー
```

実装順序：

1. `WasmOneSegDecoder`にポインタ入力のdecode経路を足す。
   `oneseg_decoder_decode_batch`の既存入力ポインタABIを利用できるか確認する。
2. `OneSegDecoder`経由で`pipeline.drainFrontend`をresident経路へつなぐ。
   decode完了後にだけ`frontend.clearPending()`する。
3. `WasmU8Decimator`にresident出力を足し、locked時はFrontendへ直接渡す。
4. 既存の配列を返すAPIは参照テスト・非融合経路のため維持し、同じ内部処理に委譲する。
5. acquisition中のJSバッファ経路は最初は維持する。
   ロック移行時に獲得用サンプルを二重投入／欠落させないことをテストする。
6. 余分なstagingの確保が不要になった経路で`prepareDecode`等を整理する。
7. 数値が変わらない変更なので、同じIQのTS出力のバイト一致を確認する。

重要な所有権制約：

- residentポインタは同じWASMインスタンスに限る。Workerをまたいで使用しない。
- `memory.grow`で既存のJS TypedArray viewは無効になり得る。
  ポインタ数値がそのままでもviewは取り直す。`WasmHeap`の既存取得方式を利用する。
- 入力所有Vec自身の再確保／reset／disposeでポインタが無効になる。
  次のprocessを呼ぶ前に消費する。非同期キューに借用ブロックを保存しない。
- 出力側の別Vecの確保と、入力所有Vecの再確保は区別する。
  「WASM呼び出しなら常にポインタが安全」と考えない。
- Rustの同一領域に`&mut`と`&`を重ねない。入力が自分のappend先と重なるケースは拒否する。
- Re/Im長、carriers×symbolCount、範囲、4-byte alignmentを検証する。
- WASMメモリのbufferをTransferしない。TSだけは独立したArrayBufferへコピーして所有権を渡す。
- onTmcc等のコールバックを挟む場合、再入やresetで借用データが消えないことを確認する。
- 空ブロック、奇数個の複素サンプルのチャンク、巨大チャンクによるmemory.grow、
  lock loss、flush、retune、disposeを試験する。

### 6.3 Main→WorkerのIQコピーを削る際の条件

`IQSource.onSamples`は複数購読を許す。単に`chunk.data.buffer`をTransferすると、
後続購読者や同じバッファを保持する処理がdetachされた配列を読む可能性がある。

- ライブ受信の排他的consumerをどう保証するか設計してから変更する。
- 録音、scan、spectrum等の利用箇所と、`UsbTransport.bulkIn`の返却所有権を確認する。
- offset付きsubarrayの場合、全bufferを送ると不要データまで送信する。
  `byteOffset === 0`かつ`byteLength === buffer.byteLength`等を確認し、不適合時はコピーする。
- `IQSource`の契約を変更するなら調整必須。既存全consumerを同時に更新する。
- コピー削減のためにUSBの再投入を遅らせない。保留8転送を無計測に減らさない。

### 6.4 WASM内部のallocationを減らす

- `demap.rs::scattered_pilot_indices()`のVec生成を毎シンボル繰り返さない。
  4種類のphaseごとに事前生成するか、`3*phase`から12刻みの算術ループで処理する。
- FFT plan、twiddle、bit reversal表をサイズごとに再利用する。
- pending、TS、前処理scratchの容量をウォームアップ後に再利用する。
- `frontend`と`ofdm`の二重サンプル保持は、ホストコピー削減後の計測で重要なら統合する。
  同期が必要とする過去CP・追跡範囲を保持し、FFT中の入力を上書きしない。
- 同期の大きなリング化で内側ループに剰余演算を増やすより、連続窓＋小さい残留コピーを優先する。
  現行halfbandの連続窓方式を参考にする。

## 7. Phase 2：f32／SIMDの精度境界

| 対象                                      | 初期方針                               | 理由                                                        |
| ----------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| サンプル、FFTバタフライ、twiddle表        | f32／f32x4                             | 既にサンプル保持はf32。有限長演算の主要候補                 |
| halfband係数・FIR積和                     | f32／f32x4を比較                       | 31タップで有限長。単独改善の余地はあるが前処理は既に軽い    |
| DC running mean                           | 当初f64維持                            | 再帰状態。ここを変えなくてもFIRはSIMD化可能                 |
| NCOの長期位相・周波数・再アンカー         | f64維持                                | 長時間の位相精度、チャンク依存ドリフト防止                  |
| NCOのサンプルへの複素乗算                 | f32x4候補                              | 状態と適用演算を分ける                                      |
| CP相関の積                                | f32 SIMD候補                           | サンプルはf32。和の方式は別評価                             |
| CP相関の和・ピーク判定                    | 最初はf64または短いブロックごとf64集約 | 弱信号での判定、候補の僅差、滑動和ドリフトを守る            |
| チャネル推定・等化                        | f32／f32x4候補                         | キャリア独立処理。深いフェージング時の除算を試験            |
| Viterbiメトリック                         | i32 SIMDを優先検討、f32は比較案        | 入力softはi8の整数。無理に浮動小数点を使う必要がない        |
| RS、bit/byte deinterleave、PRBS           | 既存整数処理維持                       | f32化対象ではない                                           |
| PTS、絶対サンプル位置、長期時刻、統計累積 | 整数またはf64維持                      | f32の整数精度は2^24まで。約1 MSpsでは十数秒で位置精度を失う |

f32は精度を下げれば必ず速くなるわけではない。f64↔f32変換やSIMD laneのshuffleが増えると
逆効果もある。WebAssemblyのSIMDは128-bitで、f32は4 lane、f64は2 lane。
ARM側の実命令化はChromeのJITに依存し、開発機の改善率をそのまま適用しない。

## 8. Phase 3A：FFTをplan化してf32x4化

候補ファイル：`wasm/dsp/src/fft.rs`、`frontend.rs`、`src/dsp/wasm/fft.ts`、`fft.test.ts`。

### 8.1 現状の問題

`transform()`のtwiddleは`cur = cur * w`という逐次更新で、バタフライ間に依存がある。
配列はf32だが演算はf64。単純に型だけ変えるとtwiddleの累積誤差が増え、
自動ベクトル化も依存関係に阻まれる。

### 8.2 具体案

1. `FftPlan`を追加し、Nごとにbit reversalとstage別twiddleを初期化する。
2. twiddle生成のsin/cosは初期化時にf64で行い、表はf32で保持する。
3. SoA（Re/Im別配列）のまま、同じstageの連続4バタフライを処理する。

```text
vr = br * wr - bi * wi
vi = br * wi + bi * wr
outA = a + v
outB = a - v
```

4. `core::arch::wasm32`の`v128_load/store`、`f32x4_mul/add/sub`を使う。
5. halfが1/2の小stageは専用スカラー処理、半端要素もスカラーにする。
6. inverseの符号と1/N正規化を保持する。fftshiftを新たに加えない。
7. FrontendはN固定のplanを所有し、per-symbolで作り直さない。
   獲得・spectrum等の`WasmFftBackend`もサイズごとのplanを再利用する。
8. 既存`FftBackend`契約は維持。内部WASM ABIにcreate/destroy/transformを追加する場合は、
   旧exportの互換経路と所有者の解放を定義する。グローバル`static mut`の共有scratchは避ける。

まずscalar f32 plan版で品質を確認し、その後SIMD版にする。
relaxed-SIMDやFMA前提の演算変更、radix変更を同じ変更に混ぜない。
Mode 1/2/3の256/512/1024点と既存の小サイズ・forward/inverseを保持する。

## 9. Phase 3B：実際のstreaming Viterbiを軽量化

候補：`wasm/dsp/src/viterbi.rs::StreamingState`、`oneseg.rs`、`src/dsp/wasm/viterbi.test.ts`。

### 9.1 対象を取り違えない

バッチ版`decode_hard/decode_soft`だけを最適化しても、現在のone-segライブ経路の
主要負荷は減らない。`oneseg.rs`が呼ぶ`viterbi_stream_feed_soft_block`と`StreamingState::step`
を計測・最適化する。

現状は各soft pairについて64状態のACS、best探索、正規化を行い、
ウォームアップ後は**毎出力bitで127段のtraceback**を行う。
ACSだけでなくtracebackの割合も測る。

### 9.2 i32 SIMDを第一候補にする

- 入力はsoft i8、枝メトリックは符号付き加減算なので整数で表現できる。
- `metrics/next/pair/sign`の整数化を先にscalar版で行い、出力byteの完全一致を確認する。
- 毎stepの最大値減算は維持する。到達可能なメトリック範囲を解析・試験し、
  i32 overflowがないことを示す。いきなりi16や飽和演算に縮めない。
- `state >> 1`のpredecessorは2状態で共有できる。4 laneで
  `[m0,m0,m1,m1]`と`[m32,m32,m33,m33]`をshuffleで作り、ACSを並列化する。
- `lo >= hi`ではloを選ぶ現行tie規則を保持する。
- best探索はstrict `>`のため同値時に小さいstateが選ばれる。SIMD reductionでも保持する。
- decisionの0..63を正しくu8へ格納し、puncture position、pair_len、byte組立てを維持する。
- code rate 1/2、2/3、3/4、5/6、7/8、erasure、符号端、全ゼロを試験する。

f32 SIMDを選ぶ場合も、整数値が厳密に表現できる範囲の証明と長時間試験が必要。
単に「毎回正規化するから安全」とはしない。

### 9.3 tracebackは別変更

tracebackが支配的なら、依存ロードやdecisionのlayoutの改善を検討する。
しかし「8 bitに1回tracebackしてまとめて出力」は、現在の各stepのbest stateから
1 bitずつ決定する動作と自動的に同値ではない。
深さを短くする／出力遅延を変える／復号方式を変える変更は、SIMD化とは別に扱う。

## 10. Phase 3C：同期・等化・NCO・前処理

実装順序はPhase 0のprofileで入れ替える。FFTとViterbiが必ず最大負荷とは断定しない。

### 10.1 CP相関の再計算を減らす

`find_peak()`は隣接する開始位置ごとにCPの積和を全計算する。
相関窓を1サンプル動かすとき、出る1組を引いて入る1組を足す滑動和にできる。

```text
gamma(s+1) = gamma(s) - product(s, s+N) + product(s+L, s+L+N)
phi(s+1)   = phi(s)   - energyPair(s)  + energyPair(s+L)
```

- 最初の窓は現行式で計算し、開始位置の小さい順に評価する。
- まずf64のままアルゴリズム変更だけを検証する。
- 初期和のSIMD化はその後。長い獲得走査では定期的な再計算で丸め誤差を抑える。
- 最大値の選択、CFOの符号、`next_start`の更新、±8の範囲を維持する。
- trackingとacquisitionは別集計する。ロック中を速くしても獲得が遅くならないよう確認する。

### 10.2 等化をf32x4化

- パイロット位置の生成／割当を先に削る。
- 補間係数は12間隔という構造を利用する。
- `Y * conj(H) / |H|²`を4キャリア同時処理する。
- 小さい分母を0出力にする閾値を維持。SIMDでは安全な分母へ置換してから除算し、
  結果をmaskするなど、0/0・NaNが周辺laneに漏れない設計にする。
- `alpha=1`でもprevious estimateを利用する経路がないか確認してから不要コピーを省く。
- soft demapのclampと丸め規則を維持する。Rustの`round()`とJSの`Math.round()`は
  負の半整数で異なるため、`js_round`の意味を勝手に変えない。

### 10.3 NCOの位相精度を保持したSIMD化

- 周波数、サンプルレート、長期位相はf64のまま保持する。
- 4サンプル分のphasorを用意して複素乗算をf32x4化する案を比較する。
- 現行の256サンプルごとの再アンカーを維持または同等以上にする。
- 毎サンプルsin/cosへ戻さない。
- チャンクサイズを変えても位相が連続し、長いブロックで振幅が増減しないことを確認する。

### 10.4 halfbandのf32 SIMD化

- 現行31タップ・8組＋中央の構造は維持する。
- 係数をf32へ変換し、複数の出力時刻またはtap pairをlaneに置く案を比較する。
- interleaved I/Qを使う現在の連続窓はgather／shuffleコストにも注意する。
- FIR出力だけ先にSIMDで作り、DC再帰はf64で逐次適用する構成でもよい。
- phaseのチャンク持越し、30複素サンプルの履歴、reset時のゼロ初期化を維持する。
- 今の前処理は既に軽いため、ここだけ改善して全体不足が解消したと判断しない。

## 11. 検証方針と合格基準

### 11.1 参照実装を残す

- `src/dsp/stages/`のTS実装を精度比較の参照として保持する。
- 必要に応じて旧WASMも比較用に一時利用するが、巨大な旧バイナリを恒久追加しない。
- 数値変更なしのコピー最適化は、TS出力byte一致を基本基準とする。
- Viterbi整数化も全rate・分割・resetでbyte一致を要求する。
- FFT／等化等のf32化はbit一致ではなく誤差と復号品質で判定する。
  既存テストが落ちたら、無条件に桁数を下げず、誤差の原因と大きさを記録する。

### 11.2 数値の確認項目

以下は新実装の初期目標。実測と受信マージンを確認して採否を判断する。

- FFT：決定論的乱数、impulse、DC、bin上／bin間tone、forward→inverse。
  相対L2誤差は概ね`1e-5`以下を初期目標とし、低振幅では絶対誤差も併用する。
- Halfband：既存の±25/100/214/240 kHz試験を維持。
  折り返し成分40 dB以上の抑圧を維持し、帯域内gainが基準から劣化しないこと。
- NCO：既存の0、微小offset、±大offset、長ブロック、`setOffset/reset`試験を維持。
- OFDM：mode/GI別、整数・分数CFO、入力分割、雑音、dropout／再獲得。
- 等化：深いfade、零分母、弱いpilot、DQPSK/QPSK/16QAM/64QAM。
- 全体：同じIQに対しMER中央値の悪化0.1 dB以内を初期目標とし、
  lock率・TS出力・訂正不能RS・continuity・A/V復号も確認する。
  小さい数値誤差でも低SNRの受信閾値が悪化したら採用しない。
- TSパケット数だけで合否を決めない。連続再生できる映像・音声が出ているかを確認する。
- 実装の違いで獲得開始位置が変わる場合は、共通の安定区間を比較し、差分理由を記録する。

### 11.3 所有権・メモリ試験

- resident経路とcopy経路に同一入力を渡し、出力が一致すること。
- 1複素サンプル、奇数個、USB標準サイズ、不規則分割、空入力を扱う。
- 強制的なmemory.growを挟んでも古いJS viewを読まないこと。
- 複数pipelineインスタンスが同じWASMに存在してもstate／plan／scratchが干渉しないこと。
- retune／切替／再接続で古いsessionのIQ・ACKを適用しないこと。
- dispose二重呼び出し等は既存契約に沿って扱い、use-after-freeを作らないこと。
- WASMメモリは通常縮小しないため、解放後にbyteLengthが減ることを要求しない。
  ウォームアップ後の容量の安定・繰り返し操作時の高水位を確認する。

### 11.4 性能・ライブ再生の合格目標

Fire実機で、同じ局・ゲイン・モード・遅延設定・充電条件を揃えて比較する。

- warm状態の平均`realTimeFactor`は **0.8以下を目標**。最低でも持続的に1未満。
- 同じチャンク条件でp95も確認し、長いGC／処理停止を平均値で隠さない。
- 30分のライブ受信で、未処理IQ秒数が右肩上がりにならない。
- 再生可能な蓄えが一方向に減り続けず、継続的な音声underrunがない。
- 低遅延設定でも持続再生する。バッファ増量で合格扱いにしない。
- drop数を増やして見かけのRTFだけを良くしない。入力／処理／破棄の累積を併記する。
- spectrum有効／無効、開始直後／温まった後を分ける。
- DSPだけの高速replayと、WebUSB＋WebCodecs＋描画のライブを両方測る。
- x86開発機でも従来モード／ISDB-Tモードを回帰確認する。

「前処理だけ速くなった」「録音20秒だけ通った」は最終完了条件ではない。
対象端末へアクセスできなければ、確認済み範囲と未確認範囲を明記して引き継ぐ。

## 12. データ・コマンド・運用

### 12.1 既存の録音とベンチマーク

直近の作業で使用した一時ファイル。永続性は保証しないので存在確認する。

- `/tmp/opencode/isdbt19.u8`、`/tmp/opencode/isdbt23.u8`：128/63 MSps相当のU8 IQ。
- `/tmp/opencode/iq/all19.iq`：1.2 MSpsの比較用。
- `/tmp/opencode/isdbt19.ts`、`/tmp/opencode/isdbt23.ts`：パイプライン出力。
- 録音や大きい生成データはgitに含めない。

```bash
RUN_FRONTEND_BENCHMARK=1 npm test -- src/dsp/wasm/resample.bench.test.ts --disableConsoleIntercept
ISDBT_IQ_FILE=/tmp/opencode/isdbt19.u8 ISDBT_TS_FILE=/tmp/opencode/isdbt19.ts \
  npm test -- src/dsp/pipeline.test.ts -t 'ISDB-T hardware rate' --disableConsoleIntercept
ISDBT_IQ_FILE=/tmp/opencode/isdbt23.u8 ISDBT_TS_FILE=/tmp/opencode/isdbt23.ts \
  npm test -- src/dsp/pipeline.test.ts -t 'ISDB-T hardware rate' --disableConsoleIntercept
```

前処理ベンチマークは20回warm-up、100回交互測定の中央値。
今回追加するFFT／FEC／locked全体のベンチマークでも、同じ信号時間・チャンク・出力条件で比較する。
メモリコピーを除いたカーネル時間と、コピー込みの時間は別表にする。
性能ベンチマークを全unit testと並列実行しない。

実機録音とFFmpeg検証のコマンドは[既存検証資料](isdbt-frontend-validation.md)を参照。
`rtl_sdr`録音前にはブラウザからデバイスを「切断」する。
前回はChromeのUSB占有で`usb_claim_interface error -6`となり、ユーザーに切断してもらった。
別アプリを勝手に終了する運用にしない。

### 12.2 ビルドと必須チェック

```bash
# Rustを変更した場合。初回はwasm32 targetが必要
rustup target add wasm32-unknown-unknown
npm run build:wasm

npm run format
npm run typecheck
npm test
npm run lint
npm run knip
npm run build
```

- Rust変更と再生成した`src/dsp/wasm/dsp.bytes.ts`を揃える。
- 古い組み込みWASMでテストを通して完了しない。
- `AGENTS.md`に従い、終了前にformat→typecheck→testを実行する。
- 現在の`frontend.rs`には未使用`stats_out`のRust warningがある。新規性能変更と区別する。
- 資料やtestだけを変えた場合に不要なWASM再ビルドを行う必要はない。

## 13. 推奨する作業分割と成果物

| 順序 | 作業                                         | 完了時に残すもの                               |
| ---- | -------------------------------------------- | ---------------------------------------------- |
| 1    | 統計の単位修正、ACK、再生側の観測            | Fireの開始〜発症までの時系列、最大負荷段の特定 |
| 2    | Frontend→FECのresident入力、TS二重コピー削減 | 出力byte一致、コピーbyte/s、時間・allocation差 |
| 3    | 間引き→Frontendのresident入力                | lock遷移・memory.grow試験、locked全体速度      |
| 4    | FFT plan＋scalar f32→f32x4                   | 誤差分布、mode別結果、実機速度                 |
| 5    | streaming Viterbi整数化＋SIMD                | 全rate byte一致、ACS／traceback内訳            |
| 6    | profileに応じ同期・等化・NCO・halfband       | 段ごとの品質・性能差分                         |
| 7    | Main→Workerの所有権整理、残る割当削減        | 全consumer回帰、USB欠落・キューの長期推移      |
| 8    | Fireで30分ライブ・温度条件を含む評価         | 同一条件のbefore/after表、残課題               |

この順番は初期案。Phase 0でViterbiや同期が支配的と分かれば、数値最適化の順は変更する。
各変更を独立に比較できる小さい単位に分け、失敗時に一つずつ戻せるようにする。
Gitコミット／pushはユーザーから依頼された場合に行う。

最終報告には必ず以下を含める。

1. 対象端末・Chrome版・ABI・モード・RF条件・再生設定。
2. RF 1秒あたりのDSP時間と各段の比率、冷間／温間の差。
3. コピー量、allocation／memory高水位、IQ滞留の変化。
4. MER／lock／TS／RS／映像・音声復号の品質比較。
5. 何分間、どの設定でライブ再生を確認したか。
6. 実測した結果と推測、未確認事項の区別。

## 14. 関連資料

- [ISDB-Tフロントエンドの軽量化と受信検証](isdbt-frontend-validation.md)
- [RTL2832U「ISDB-T mode」調査メモ](webisdb_rtl_isdbt_mode_investigation.md)
- [アーキテクチャ](architecture.md)
- `../AGENTS.md`
- `../plans/要件定義.md`
- `../plans/実装計画.md`
