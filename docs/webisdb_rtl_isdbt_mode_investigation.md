# WebISDB-RTL 向け RTL2832U「ISDB-T mode」調査メモ

実装後の検証結果は[ISDB-Tフロントエンドの軽量化と受信検証](isdbt-frontend-validation.md)を参照。
通常のRTL-SDR設定では単純間引きによる折り返しが発生するため、現在はWASMの専用ハーフバンドFIRを併用する。

## 目的

`webisdb-rtl` は、RTL2832U から WebUSB で IQ を取得し、ブラウザ内で ISDB-T 1seg の OFDM 同期、FFT、TMCC、等化、FEC、MPEG-TS 化、WebCodecs 再生まで行う実装です。

現状、DSP のホットパスは Rust/WASM 化されているものの、ブラウザ内で全段を処理する負荷が大きく、安定再生が難しいケースがあります。

この調査では、ZOX DS-DT308 系で使われていた Realtek 純正ドライバ／CHUSEI PVR 関連バイナリを解析し、

- RTL2832U に ISDB-T 専用のハードウェア復調経路があるのか
- 純正実装では RTL2832U と PC 側ソフトがどこで処理を分担しているのか
- `webisdb-rtl` でハードウェア側へ逃がせる処理がないか
- 純正の「ISDB-T mode」を再現する価値があるか

を確認しました。

結論を先に書くと、**RTL2832U が ISDB-T を FFT/FEC/RS までハードウェア復調して MPEG-TS を出している形ではありません**。純正 Realtek 実装も、RTL2832U から時間領域 IQ/baseband を取得し、PC 側 `RTKISDBT.dll` で ISDB-T 復調を行っています。

ただし、純正の「ISDB-T mode」には非常に有望な最適化があります。特に **RTL2832U のサンプルレートを約 2.031746 Msps (= 128/63 Msps) に設定し、PC 側で単純 2:1 decimation して 64/63 Msps にする**構成になっている可能性が高く、現在の分数リサンプラを省略できる可能性があります。

---

## 現在の WebISDB-RTL の構成

リポジトリ:

https://github.com/kaminchu/webisdb-rtl

現行アーキテクチャでは、

```text
RTL2832U / tuner
  ↓ WebUSB
U8 IQ
  ↓
DC removal
  ↓
fractional resampler → 64/63 Msps
  ↓
OFDM sync
  ↓
FFT
  ↓
TMCC / channel estimation / equalization
  ↓
deinterleave / Viterbi / RS
  ↓
MPEG-TS
  ↓
WebCodecs
```

となっています。

DSP の主要部分はすでに Rust/WASM に移され、`frontend` と `oneseg` の融合カーネルも実装されています。

参考:

- `docs/architecture.md`
- `src/driver/rtlsdr/rtl2832u.ts`
- `src/driver/rtlsdr/tuner/fc0013.ts`

現在の RTL2832U 初期化は一般的な RTL-SDR の `rtlsdr_init_baseband` に近く、`setSampleRate()` は次の式で resampling ratio を設定しています。

```ts
const rsampRatio = Math.floor((28_800_000 * 2 ** 22) / rate) & 0x0ffffffc
```

この点が純正 ISDB-T mode との比較で非常に重要です。

---

# 解析対象

ユーザー所有の DS-DT308 系ドライバ／ソフトから以下を解析しました。

```text
RTL283XACCESS.dll
SHA256:
cce377fae8f52accd38a35aed7670335efc3db4ea23e98703a0477fd814b3052

RTL2832UBDA(1).sys
SHA256:
5ee9f90f09bd2e2cf1dcbd3189d284f78ad972b8672b098f25616931f57adc42

chusei_pvr8_32_01.exe
SHA256:
2cb3909b48bcc421d8ffc2f6420db8ed7f7fc94c1537d5ba135a028fb911b5a0
```

CHUSEI PVR インストーラ内にはさらに次の Realtek ファイルが含まれていました。

```text
RTKISDBT.dll
RTKISDBTSOURCE.dll
RTL283XACCESS.dll
RTL283XACCESS.h
RTL283XACCESS.lib
rtl2832_register.txt
SampleRTKDLL.exe
```

---

# 1. `RTL283XACCESS.dll` の役割

`RTL283XACCESS.dll` は ISDB-T 復調本体ではなく、Realtek BDA ドライバへの低レベルアクセス層です。

確認できた代表的 export:

```text
RTK_GetDemodSupportType
RTK_GetDemodType
RTK_SetDemodType

RTK_Demod_Byte_Read
RTK_Demod_Byte_Write

RTK_USB_Byte_Read
RTK_USB_Byte_Write

RTK_SYS_Byte_Read
RTK_SYS_Byte_Write

RTK_I2C_Read
RTK_I2C_Write

RTK_Tuner_Byte_Read
RTK_Tuner_Byte_Write

RTK_Set_Frequency
RTK_Set_Bandwidth
RTK_ScanChannel

RTK_GetData
```

`RTK_SetDemodType()` は独自 KS Property を経由して `RTL2832UBDA.sys` へ値を渡していました。

ただし、同梱の `RTL283XACCESS.h` から正式な enum が判明しています。

```c
typedef enum {
    DVBT = 0,
    DTMB,
    DVBC
} DEMODTYPE_DEFINE;
```

つまり **`RTK_SetDemodType()` の隠し値として ISDB-T があるわけではありません**。

これは重要です。

---

# 2. ISDB-T の本体は `RTKISDBT.dll`

CHUSEI PVR の Realtek パッケージには約 5.8 MB の `RTKISDBT.dll` が含まれていました。

この DLL は `RTL283XACCESS.dll` を動的ロードし、少なくとも以下を使用しています。

```text
RTK_BDAFilterInit
RTK_BDAFilterRelease

RTK_Set_Frequency
RTK_Set_Bandwidth
RTK_DeviceUpdate

RTK_Demod_Byte_Read
RTK_Demod_Byte_Write

RTK_SYS_Byte_Read
RTK_SYS_Byte_Write

RTK_GetData

RTK_Get_TunerType
RTK_SetDABEventHandle
RTK_ReleaseDABEventHandle
```

また、DLL 内には次の文字列があります。

```text
Fail to set 2832 to ISDB-T mode
fail to start demod module
fail to start rs decoder module
Fail to allocate mem for baseband saving
```

さらに TS 出力 API として、

```text
RTISDBT_SetTSCallBack
```

が存在します。

この構成から、純正 Realtek 実装は概ね次の分担と考えられます。

```text
FC0013
  ↓
RTL2832U
  ├ ADC
  ├ IQ generation
  ├ DDC / sample-rate conversion
  ├ filtering
  ├ AGC / frontend
  └ USB baseband streaming
       ↓
RTL2832UBDA.sys
       ↓
RTL283XACCESS.dll
       ↓ RTK_GetData()
RTKISDBT.dll
  ├ synchronization
  ├ OFDM demod
  ├ FFT
  ├ TMCC
  ├ equalization
  ├ deinterleave
  ├ Viterbi / FEC
  ├ Reed-Solomon
  └ MPEG-TS construction
       ↓
RTISDBT_SetTSCallBack()
       ↓
RTKISDBTSOURCE.dll
       ↓
CHUSEI PVR
```

したがって、**RTL2832U の固定 DVB-T デコーダを ISDB-T 用に流用して FFT/FEC/RS までハードウェア処理する経路は、少なくともこの純正実装では使われていません**。

---

# 3. `RTK_GetData()` から来るのは FFT 後データではなく IQ

`RTL283XACCESS.h` の宣言:

```c
BOOL RTK_GetData(
    UCHAR *data,
    ULONG buflength,
    ULONG *getlength,
    ULONG *discardlength
);
```

`RTKISDBT.dll` は概ね、

```c
RTK_GetData(buffer, 0x3ac08, &getlength, &discardlength);
```

のように呼び、`0x3ac00 = 240640 bytes` を処理単位としていました。

その直後の DSP 入力処理では、入力 byte 列から、

```text
byte 0 → I
byte 1 → Q
byte 4 → 次に使用する I
byte 5 → 次に使用する Q
...
```

という読み方をしています。

さらに、

```text
(I - 127) / 128
(Q - 127) / 128
```

相当の正規化を行って float complex 化しています。

したがって、**PC 側へ渡っているものは時間領域の unsigned 8-bit IQ** とみてよいです。

FFT 済みサブキャリアや FEC 入力ではありません。

---

# 4. 4-byte stride の意味についての重要な推定

`RTKISDBT.dll` は 1 complex sample を 4 byte 構造として扱っているように見えますが、実際には、

```text
[I0][Q0][I1][Q1]
[I2][Q2][I3][Q3]
...
```

という通常の連続 IQ に対して、**1 サンプルおきに拾っている**可能性があります。

つまり、

```text
入力:
I0 Q0 I1 Q1 I2 Q2 I3 Q3 ...

使用:
I0 Q0       I2 Q2       ...
```

です。

この推定を強く支持するのが、次の ISDB-T mode サンプルレート設定です。

---

# 5. 最重要: 純正 ISDB-T mode のサンプルレート

`RTKISDBT.dll` の RTL2832U 初期化コードでは、

```text
demod page 1
reg 0x9F = 03 8B 33 30
```

という 4-byte write が行われています。

`webisdb-rtl` の現在の `setSampleRate()` と同じ RTL2832U の resampling ratio レジスタとして解釈すると、

```text
ratio = 0x038B3330
```

なので、

```text
rate = 28.8 MHz * 2^22 / 0x038B3330
     ≈ 2,031,746.14 samples/s
```

となります。

これはほぼ、

```text
128 / 63 Msps
= 2.031746031... Msps
```

です。

ISDB-T 1seg の DSP で使いたい基準レートは、

```text
64 / 63 Msps
= 1.015873015... Msps
```

なので、純正実装は非常に自然に、

```text
RTL2832U:
128/63 Msps
      ↓
2:1 decimation
      ↓
64/63 Msps
```

という構成にできます。

さらに `RTKISDBT.dll` が入力を 4-byte stride で読み、先頭 2 byte の I/Q だけを使っていることとも一致します。

つまり、**純正 DLL は重い fractional resampling をせず、RTL2832U に最初から 2 × 必要レートで出力させ、1 sample おきに捨てるだけで 64/63 Msps を作っている可能性が非常に高い**です。

これは `webisdb-rtl` にとって、今回の調査で最も実用価値が高い発見です。

---

# 6. WebISDB-RTL の現行初期化との比較

現行 `src/driver/rtlsdr/rtl2832u.ts` の `initBaseband()` は、純正 ISDB-T mode とかなり似ています。

現行コード:

```ts
await this.writeDemodReg(1, 0x15, 0x00)
await this.writeDemodReg(1, 0x16, 0x0000, 2)

for (...) {
  await this.writeDemodReg(1, 0x1c + i, RTL_FIR_COEFFICIENTS[i])
}

await this.writeDemodReg(1, 0x93, 0xf0)
await this.writeDemodReg(1, 0x94, 0x0f)

await this.writeDemodReg(0, 0x61, 0x60)

await this.writeDemodReg(1, 0xb1, 0x1b)
```

FIR 係数も、

```text
CA DC D7 D8 E0 F2 0E 35 06 50 9C 0D 71 11 14 71 74 19 41 A5
```

で、純正 ISDB-T mode で確認した列と一致します。

したがって **「ISDB-T mode」は全く別の RTL2832U 動作モードというより、通常 RTL-SDR baseband mode の設定を ISDB-T 1seg 用に最適化したもの**と考える方が自然です。

確認できた差分候補の一部:

```text
pure ISDB-T mode candidate:

page 0, reg 0x08 = 0xCD

page 1, reg 0xB1 = 0x1F
  ※ webisdb-rtl 現行は 0x1B

page 1, reg 0x3E = 00 00

page 1, reg 0x15 = 00
page 1, reg 0x16 = 00 00

page 1, reg 0x9F = 03 8B 33 30
  → 約 128/63 Msps

page 1, reg 0x1C ... = FIR coefficients
  → 現行と同じ

page 0, reg 0x17 = 08
page 0, reg 0x18 = 10
page 0, reg 0x19 = 21

page 1, reg 0x92 = 00
page 1, reg 0x93 = F0
page 1, reg 0x94 = 0F

page 0, reg 0x61 = 60
page 0, reg 0x20 = 40
```

初期化末尾では page 1 / reg 0x01 の bit 2 を、

```text
set
↓
clear
```

する read-modify-write が見られます。

これは現行 `initBaseband()` / `setSampleRate()` の、

```ts
writeDemodReg(1, 0x01, 0x14)
writeDemodReg(1, 0x01, 0x10)
```

と実質同じ操作です。

**注意:** 上記は解析途中で確認できたレジスタ列であり、純正 ISDB-T 初期化の完全な全レジスタリストではありません。

---

# 7. まず試すべき実装方針

## Phase 1: 「ISDB-T mode」ではなく、まず純正 sample-rate 戦略だけ試す

最初にこれを試すのがおすすめです。

```ts
const ISDBT_USB_SAMPLE_RATE = 128_000_000 / 63
const ISDBT_BASE_SAMPLE_RATE = 64_000_000 / 63
```

RTL2832U:

```ts
await rtl.setSampleRate(ISDBT_USB_SAMPLE_RATE)
```

DSP:

```text
U8 IQ @ 128/63 Msps
      ↓
2:1 decimation
      ↓
64/63 Msps
      ↓
OFDM sync
```

現在の、

```text
input sample rate
  ↓
WasmFractionalResampler
  ↓
64/63 Msps
```

を、

```text
128/63 Msps
  ↓
drop every second complex sample
  ↓
64/63 Msps
```

へ置き換えます。

### 期待できる効果

- fractional resampler の計算負荷をほぼ除去
- resampler 用 FIR / phase accumulator の負荷削減
- 中間 buffer / memory traffic 削減
- 純正 Realtek が想定したクロック比に近づく
- OFDM symbol timing が整数関係になりやすい

1seg の占有帯域は約 430 kHz 程度なので、1.015873 Msps に decimation しても Nyquist 的には十分です。

まずはこの変更だけで、

```text
receiver worker CPU %
processing time / chunk
buffer occupancy
dropped IQ chunks
A/V underrun
```

を比較する価値があります。

---

# 8. Phase 2: RTL2832U 純正 ISDB-T レジスタ差分を適用

次に `Rtl2832u` に、例えば、

```ts
async initIsdbtBaseband(): Promise<void>
```

を追加し、現在の `initBaseband()` をベースに純正差分だけ適用します。

概念例:

```ts
async initIsdbtBaseband(): Promise<void> {
  await this.initBaseband()

  await this.writeDemodReg(0, 0x08, 0xcd)

  await this.writeDemodReg(1, 0xb1, 0x1f)

  await this.writeDemodReg(1, 0x3e, 0x0000, 2)

  await this.writeDemodReg(0, 0x17, 0x08)
  await this.writeDemodReg(0, 0x18, 0x10)
  await this.writeDemodReg(0, 0x19, 0x21)

  await this.writeDemodReg(1, 0x92, 0x00)
  await this.writeDemodReg(1, 0x93, 0xf0)
  await this.writeDemodReg(1, 0x94, 0x0f)

  await this.writeDemodReg(0, 0x20, 0x40)

  await this.setSampleRate(128_000_000 / 63)
}
```

ただし、**いきなりこの全差分を有効にするより、1 レジスタ群ずつ A/B test する方が安全**です。

特に `page 0` のレジスタは意味を完全に特定できていないため、

```text
A. 現行 init + 128/63 sample rate
B. A + B1=1F
C. B + page0 08
D. C + page0 17/18/19
E. D + page0 20
```

のように段階的に試すのがよいです。

評価指標:

```text
USB throughput
signal lock time
GI correlation
CFO stability
TMCC success rate
MER/CN
RS correction count
TS continuity errors
CPU usage
```

---

# 9. FC0013 について

`webisdb-rtl` にはすでに FC0013 の WebUSB/I2C 実装があります。

```text
src/driver/rtlsdr/tuner/fc0013.ts
```

DS-DT308 も RTL2832U + FC0013 系なので、今回の純正 ISDB-T mode を試す対象として非常に適しています。

純正 `RTKISDBT.dll` の初期化コードにも tuner type による分岐があり、RTL2832U 側の一部 bit 設定を tuner type ごとに変更しています。

したがって、最終的には **FC0013 分岐で使われる RTL2832U レジスタ差分を完全に抜き出す**のが理想です。

ただし、Phase 1 の `128/63 Msps + 2:1 decimation` は tuner に依存しない可能性が高く、先に試せます。

---

# 10. 期待しない方がよいこと

今回の解析結果から、次のような最適化は期待しにくいです。

```text
RTL2832U hardware:
OFDM sync
FFT
TMCC
Viterbi
RS
↓
MPEG-TS
```

少なくとも Realtek 純正 ISDB-T 実装は、この経路を使っていません。

`RTKISDBT.dll` 内に、

```text
demod module
rs decoder module
baseband
```

の処理が存在し、`RTK_GetData()` 直後に raw 8-bit IQ を float complex へ変換しているためです。

したがって、ハードウェアへ逃がせそうな領域は主に、

```text
ADC
DDC
sample-rate conversion
channel filtering
AGC
IQ generation
USB streaming
```

までと考えるのが現実的です。

---

# 11. DSP 負荷削減の優先順位

今回の結果を踏まえると、以下の順で試す価値があります。

### 1. 128/63 Msps を RTL2832U に直接生成させる

最優先。

```text
2.031746 Msps hardware output
↓
2:1 decimation
↓
1.015873 Msps
```

これで `WasmFractionalResampler` をホットパスから外せるか確認する。

### 2. decimation を IQ unpack と融合

現在、

```text
U8 → complex
↓
resample
```

なら、

```text
[I0 Q0 I1 Q1 ...]
↓
I0/Q0, I2/Q2 ... のみ float 化
```

にする。

純正 `RTKISDBT.dll` がやっているように、**捨てる sample は最初から変換しない**。

### 3. DC removal / NCO / decimate を 1 kernel に融合

必要なら、

```text
u8 input
→ DC removal
→ CFO/NCO
→ 2:1 decimate
→ float/complex output
```

を 1 回のメモリ走査で行う。

### 4. 純正 ISDB-T レジスタ差分を評価

特に、

```text
page1 B1: 1B → 1F
page0 08
page0 17/18/19
page0 20
```

が実際の IQ 品質や USB 出力に影響するかを見る。

### 5. それでも重い場合

FFT/FEC を RTL2832U に逃がすのではなく、

- SIMD 寄りの WASM 実装
- FFT plan / buffer 再利用
- allocation-free hot path
- SharedArrayBuffer 対応環境で ring buffer
- Web Worker の chunk size 最適化
- WebGPU compute の実験

の方が現実的です。

---

# 12. 実装時のおすすめ feature flag

実験を容易にするため、

```ts
type RtlFrontendMode = 'generic-rtl-sdr' | 'realtek-isdbt'
```

のようにして、

```text
generic-rtl-sdr:
既存 initBaseband
任意 sample rate
fractional resampler

realtek-isdbt:
純正互換 register sequence
128/63 Msps
2:1 decimation
```

を切り替えられるようにすると比較しやすいです。

設定画面または debug query parameter で、

```text
?frontend=realtek-isdbt
```

のように切り替えられると検証が楽です。

---

# 13. 最初の実験として最小変更で試すコード案

RTL2832U 側:

```ts
export const ISDBT_RTL_SAMPLE_RATE = 128_000_000 / 63
export const ISDBT_DSP_SAMPLE_RATE = 64_000_000 / 63

await rtl.initBaseband()
await rtl.setSampleRate(ISDBT_RTL_SAMPLE_RATE)
```

IQ ingest 側:

```ts
// input = [I0,Q0,I1,Q1,I2,Q2,...]
//
// Realtek RTKISDBT.dll の挙動を参考に
// 1 complex sample おきに採用する。

for (let src = 0, dst = 0; src + 3 < input.length; src += 4) {
  const i = (input[src] - 127) / 128
  const q = (input[src + 1] - 127) / 128

  out[dst++] = i
  out[dst++] = q
}
```

これで DSP へ渡すサンプルレートは約、

```text
1.015873 Msps
```

になります。

まずこの状態で OFDM lock / TMCC / TS が安定するかを見るのがよいと思います。

もし動けば、現行の fractional resampler を丸ごと省けるため、非常に大きな成果です。

---

# 14. 注意点

## 128/63 Msps は API 指定値と実クロックがわずかに違う

純正レジスタ値:

```text
0x038B3330
```

から得られる実値は、

```text
≈ 2,031,746.141 samples/s
```

です。

理想値:

```text
128/63 MHz
≈ 2,031,746.032 samples/s
```

なので誤差は極小です。

`setSampleRate(128_000_000 / 63)` で RTL2832U の quantized ratio が同じ `0x038B3330` になることを unit test で確認するとよいです。

## byte 2/3 が本当に「捨てる隣接 IQ」かは最終確認が必要

逆アセンブルの挙動とサンプルレートの数学的整合性から、この解釈はかなり有力ですが、USB キャプチャまたは既知信号で最終確認するのが望ましいです。

例えば 1 tone を入力して、

```text
all samples FFT
even samples FFT
odd samples FFT
```

を比較すれば確認できます。

## 純正 ISDB-T register sequence はまだ完全抽出ではない

本メモにある値は、解析で確認できた重要部分です。

「純正と完全同一の RTL2832U ISDB-T mode」を再現するには、`RTKISDBT.dll` の初期化関数をさらに完全に table 化する必要があります。

---

# 15. 現時点の結論

今回の解析から、次が最も重要です。

1. **RTL2832U の DVB-T hardware decoder を ISDB-T にそのまま流用しているわけではない。**
2. **Realtek 純正 ISDB-T も、RTL2832U から raw/time-domain IQ を PC に送ってソフト復調している。**
3. **FFT / TMCC / FEC / RS は少なくとも大部分が `RTKISDBT.dll` 側。**
4. ただし RTL2832U には純正の **「ISDB-T baseband mode」相当のレジスタ設定**が存在する。
5. 現行 `webisdb-rtl` の baseband 初期化は、その純正設定とかなり共通している。
6. 純正設定では **sample-rate ratio `0x038B3330` = 約 128/63 Msps** が使われている。
7. `RTKISDBT.dll` が 4 byte stride で I/Q を取得していることから、**2:1 decimation で 64/63 Msps を作っている可能性が非常に高い。**
8. したがって `webisdb-rtl` で最初に試す価値が高いのは、**fractional resampling をやめて RTL2832U を 128/63 Msps に設定し、単純 2:1 decimation にすること**。
9. その次に、純正 ISDB-T mode の RTL2832U レジスタ差分を段階的に適用して IQ 品質・ロック率・CPU 負荷を比較する。

---

## 参考

WebISDB-RTL:

https://github.com/kaminchu/webisdb-rtl

Architecture:

https://github.com/kaminchu/webisdb-rtl/blob/main/docs/architecture.md

RTL2832U driver:

https://github.com/kaminchu/webisdb-rtl/blob/main/src/driver/rtlsdr/rtl2832u.ts

FC0013 driver:

https://github.com/kaminchu/webisdb-rtl/blob/main/src/driver/rtlsdr/tuner/fc0013.ts

---

## 次に解析すると有用なもの

追加で深掘りする場合は、以下を行うとよいです。

- `RTKISDBT.dll` の「set 2832 to ISDB-T mode」関数を完全逆アセンブル
- tuner type == FC0013 の分岐だけ抽出
- 全 `RTK_Demod_Byte_Write` を時系列で table 化
- `RTK_SYS_Byte_Write` も含めて USB endpoint 設定を比較
- `RTK_GetData()` 直前の streaming setup を解析
- USBPcap で純正 CHUSEI PVR 起動時をキャプチャ
- WebUSB 実装の register trace と純正 trace を diff

最終的には、

```text
Realtek original trace
vs
webisdb-rtl generic RTL-SDR trace
vs
webisdb-rtl ISDB-T mode trace
```

の 3-way diff を取ると、純正 mode の意味をかなり正確に特定できるはずです。
