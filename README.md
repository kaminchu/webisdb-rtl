# WebISDB-RTL

A browser-based one-seg (ISDB-T) receiver. It drives an RTL-SDR over WebUSB, demodulates
the Japanese terrestrial digital TV one-seg signal entirely in the browser, and plays back
video, audio and captions — no native app, no backend server, no installation.

The whole stack (USB driver, OFDM demodulation, FEC, MPEG-TS demuxing, video/audio decode)
runs client-side, so the app is a static bundle that can be hosted on GitHub Pages and
installed as an offline-capable PWA.

## Features

- **Custom WebUSB RTL-SDR driver** — RTL2832U baseband plus R820T2 (Blog V3), R828D (Blog V4)
  and FC0013 tuners.
- **ISDB-T one-seg demodulation** — DC removal, fractional resampling to 64/63 MSps,
  GI-correlation OFDM synchronisation, carrier frequency offset correction, TMCC decoding,
  channel estimation/equalisation, frequency/time/bit deinterleaving, depuncture + Viterbi,
  energy descrambling and Reed–Solomon RS(204,188) → MPEG-TS.
- **MPEG-TS analysis** — PAT / PMT / SDT / EIT / NIT / TDT / TOT and stream statistics.
- **Playback** — H.264 video and AAC audio via WebCodecs, A/V sync, caption rendering,
  audio main/sub channel selection and a configurable jitter buffer.
- **EPG** — cross-channel program guide built from live EIT and events persisted in IndexedDB,
  with tuning from the guide.
- **Tuning & scan** — physical channel 13–52, direct frequency, region/transmitter selection,
  GPS auto-selection, channel scan and service acquisition.
- **Diagnostics** — signal level, C/N, MER, frequency offset, USB/IQ/DSP throughput, buffer
  occupancy and a live spectrum view.
- **PWA** — service worker caching so the app starts offline; previously loaded channel data
  and the UI work without a network connection.

## Requirements

- **Browser**: Google Chrome on Android, Windows or macOS. WebUSB and WebCodecs are required,
  so Firefox and Safari are not supported. The page must be served over HTTPS (or `localhost`).
- **Hardware**: RTL-SDR Blog V3 (R820T2), RTL-SDR Blog V4 (R828D), or a generic RTL2832U dongle
  with an FC0013 tuner. An antenna receiving UHF terrestrial TV is required to see a signal.
- **Runtime**: Node.js and npm for development and building.

## Getting started

```bash
npm install
npm run dev
```

Open the HTTPS URL printed by Vite, then on the Watch screen click the stage to select the
RTL-SDR device. If no channels are configured yet, the app opens Settings first — pick a region
and transmitter or run a channel scan, then return to Watch.

## Commands

```bash
npm run dev          # Vite dev server (HTTPS)
npm run build        # tsc -b && vite build -> dist/
npm run preview      # preview the production build
npm test             # run the Vitest suite
npm run test:watch   # Vitest watch mode
npm run typecheck    # tsc -b --force
npm run lint         # oxlint
npm run format       # oxfmt . (write)
npm run format:check # oxfmt --check .
npm run knip         # detect unused code
npm run ci           # lint + format:check + typecheck + test + knip
```

## WebAssembly DSP kernels

The hot DSP stages are implemented as Rust crates under `wasm/<name>/` and compiled to
`wasm32-unknown-unknown`. Each compiled `.wasm` is embedded as base64 in a committed
`src/dsp/wasm/<name>.bytes.ts`, so `build` and `test` work without a Rust toolchain.

```bash
rustup target add wasm32-unknown-unknown   # once
npm run build:wasm                          # rebuild all -> src/dsp/wasm/*.bytes.ts
```

Kernels: `fft`, `ofdm`, `demap`, `resample`, `deinterleave`, `viterbi`, `reed_solomon`.
Pure TypeScript reference implementations remain under `src/dsp/stages/` and are compared
against the WASM wrappers in the corresponding `*.test.ts` files.

## Architecture

```text
IQSource (RTLSDRSource | IQFileSource)
  │  U8/I8/F32 IQ chunks (main thread, WebUSB)
  ▼
Receiver Worker ─ DSP pipeline
  DC removal → resample 64/63 MSps → OFDM sync → FFT → carrier extraction
  → TMCC → channel estimation/equalisation → FEC (deinterleave, Viterbi, RS)
  → MPEG-TS                                              (Transferable Uint8Array)
  ▼
TS Worker ─ demux & PSI/SI
  PAT/PMT/SDT/EIT/NIT/TDT/TOT, statistics, PES split by kind
  ▼
Main thread ─ React UI
  WebCodecs video/audio, caption rendering, IndexedDB, metrics/spectrum
```

- `src/app/receiverController.ts` orchestrates the workers, IQ source, player and app store.
- `src/iq/IQSource.ts` is the hardware/file IQ boundary; `RTLSDRSource` and `IQFileSource`
  implement it so the DSP chain can be developed and regression-tested without a tuner.
- `src/dsp/backend.ts` is the TS/WASM swap boundary.
- `src/models/` holds pure data models and PSI/SI/TMCC DTOs.
- `src/workers/protocol.ts` defines the worker message unions.
- The app store (`src/app/store.ts`) uses `useSyncExternalStore`; selectors must return stable
  values.

### Project layout

```text
src/
├─ app/          SPA state, navigation, receiver/scan orchestration
├─ components/   Generic UI (Button, Panel, ProgressBar, …)
├─ features/     watch / epg / settings / scan / shell screens
├─ driver/       rtlsdr/ WebUSB driver (rtl2832u, deviceProfile, tuner/{r82xx,fc0013})
├─ iq/           IQSource abstraction, RTLSDRSource, IQFileSource
├─ dsp/          pipeline, oneSegDecoder, isdbtParams, stages/, wasm/
├─ ts/           MPEG-TS packet/descriptors/sections/demuxer/statistics
├─ media/        WebCodecs video/audio decoders, A/V sync, captions, player
├─ data/         japan/ region/transmitter/channel/station JSON, arib/ decoding
├─ storage/      IndexedDB wrapper, repositories, localStorage settings
├─ workers/      receiver.worker.ts, ts.worker.ts, protocol.ts
├─ models/       data models and DTOs
└─ styles/       design tokens and global CSS
wasm/<name>/     Rust DSP kernels (with Cargo)
public/          manifest, icons, service worker
scripts/         build-wasm.mjs, fetch-channel-data.ts
```

## Testing

Vitest runs in a happy-dom environment, with colocated `*.test.ts` files next to their sources.
DSP and TS layers use synthetic builders rather than committed captures; real IQ test files are
read from `tests/fixtures/` (gitignored) when available.

## Deployment

Pushing to `main` triggers GitHub Actions: CI runs on every push/PR, and `deploy.yml` builds the
app and publishes `dist/` to GitHub Pages. The Vite `base` is derived from `GITHUB_REPOSITORY`
and can be overridden with `VITE_BASE`.

## Scope and limitations

This project targets **Japanese terrestrial one-seg** only. The following are intentionally out
of scope: full-seg, B-CAS/ACAS and descrambling, recording, data-broadcast (BML) rendering, and
browsers other than Chrome. There is no DRM circumvention; scramble-free Japanese one-seg is
received as-is.

## License

No license has been declared for this repository yet.
