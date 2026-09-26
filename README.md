# WebISDB-RTL

**WebISDB-RTL** is a browser-based receiver for Japanese terrestrial digital TV (ISDB-T)
one-segment broadcasts. It drives an RTL-SDR over WebUSB, demodulates the one-seg signal in
the browser, and plays back video, audio and captions — no native application, no backend
server, no installation.

The entire receive chain (USB driver, OFDM demodulation, FEC, MPEG-TS demuxing and WebCodecs
decoding) runs client-side, so the app is a static bundle that can be hosted on GitHub Pages
and installed as an offline-capable PWA.

A hosted build is available at **https://kaminchu.github.io/webisdb-rtl/** — open it in
supported Chrome over HTTPS and click the stage to select your receiver.

**日本語のREADMEは [README.ja.md](README.ja.md) です。**

## Background

Receiving Japanese terrestrial digital TV on a PC has traditionally meant dedicated
PCIe/USB tuner cards, and those products are being discontinued one after another. RTL-SDR
receivers, by contrast, remain cheap and easy to obtain, and the same RTL2832U chip is used
in one-segment USB tuners that can be found for a few thousand yen. WebISDB-RTL targets that
hardware and removes the last barrier — the operating system and the installed application.

One-segment broadcasting is a good fit for a browser client:

- **Small, already-encoded streams.** One-seg video and audio are low-bitrate H.264/AAC, so
  they can be decoded and displayed without transcoding even on modest mobile hardware.
- **One sixth of a channel.** One-seg occupies only a fraction of a full-segment channel, so a
  small antenna and a cheap dongle are enough to receive it.
- **Nothing to install.** With WebUSB and WebCodecs the receiver runs as a web app: open the
  page, pick the device, and watch. There is no driver or native program to build or install.

The project deliberately keeps everything on the client. It is a static site, so it can be
served from GitHub Pages or any static host, and it works offline once loaded.

## Features

- **Custom WebUSB RTL-SDR driver** — RTL2832U baseband plus R820T2 (Blog V3), R828D (Blog V4)
  and Fitipower FC0013 tuners, with automatic tuner detection over I2C.
- **ISDB-T one-seg demodulation** in the browser — OFDM synchronisation, carrier frequency
  offset correction, TMCC decoding, channel estimation/equalisation, and the full FEC chain
  through Reed–Solomon RS(204,188) to MPEG-TS.
- **MPEG-TS analysis** — PAT / PMT / SDT / EIT / NIT / TDT / TOT and stream statistics.
- **Playback** — H.264 video and AAC audio via WebCodecs, A/V sync, ARIB caption rendering,
  main/sub audio channel selection and a configurable jitter buffer.
- **EPG** — a cross-channel program guide built from live EIT and from events persisted in
  IndexedDB, with tuning straight from the guide.
- **Tuning & scan** — physical channels 13–52, region/transmitter selection, GPS
  auto-selection, and a full channel scan with service acquisition.
- **Diagnostics** — signal level, C/N, MER, frequency offset, USB/IQ/DSP throughput, buffer
  occupancy and a live spectrum view.
- **PWA** — a service worker caches the app so it starts offline; previously loaded channel
  data and the UI keep working without a network connection.

## Requirements

- **Browser:** Google Chrome on Android, Windows or macOS. WebUSB and WebCodecs are required,
  so Firefox and Safari are not supported. The page must be served over HTTPS (or
  `localhost`).
- **Hardware:** RTL-SDR Blog V3 (R820T2), RTL-SDR Blog V4 (R828D), or a generic RTL2832U dongle
  with an FC0013 tuner. An antenna receiving UHF terrestrial TV is required to see a signal.
- **Runtime:** Node.js and npm for development and building.

Only ISDB-T **one-segment** is supported. Full-segment, BS/CS, B-CAS/ACAS descrambling and
data-broadcast (BML) rendering are out of scope. See
[docs/architecture.md](docs/architecture.md) (Japanese) for the supported transmission
parameters and the receiver internals.

## Getting started

```bash
npm install
npm run dev
```

Open the HTTPS URL printed by Vite (the dev server uses a self-signed certificate, so accept
the browser warning). On the Watch screen, click the stage to select the RTL-SDR device from
the WebUSB picker. If no channels are configured yet, the app opens Settings first — pick a
region and transmitter or run a channel scan, then return to Watch.

### Using RTL-SDR on Linux

On Linux, Chrome can fail to connect with `NetworkError: Unable to claim interface`. The
kernel DVB driver `dvb_usb_rtl28xxu` binds to the RTL2832U automatically and holds interface
0, and WebUSB cannot claim an interface owned by a kernel driver.

Unbind it for the current session (with the dongle plugged in):

```bash
sudo rmmod dvb_usb_rtl28xxu
```

To disable it permanently, blacklist the module and reboot:

```bash
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl-sdr.conf
sudo modprobe -r dvb_usb_rtl28xxu
```

Check with `lsmod | grep rtl28xxu`. Also make sure no other browser tab or application
(`rtl_tcp`, gqrx, SDR#) has the device open.

### Using a hosted build

The production build is a static site, published at
**https://kaminchu.github.io/webisdb-rtl/**. Open it in supported Chrome over HTTPS and click
the stage to grant access to the receiver. The app can be installed as a PWA from the browser
menu for offline launch.

## Usage

The app has three screens, reached from the sidebar on each screen's top bar: **視聴
(Watch)**, **番組表 (EPG)** and **設定 (Settings)**. The URL hash tracks the screen, so a
given screen can be bookmarked.

### Watch

- Click the stage while disconnected to open the WebUSB device picker and start reception.
- Click the stage while connected to open the overlay controls:
  - **音声** — stereo, main audio or sub audio.
  - **字幕** — show or hide captions.
  - **デバッグ** — show the live debug overlay (FPS, dropped frames, decoder counters, signal
    level, C/N, BER, TS/DSP throughput, buffer occupancy and delay).
- The compact guide at the bottom lists the configured channels with their current/next
  programs. Tap a channel or a program to tune to it.
- On reconnecting, the controller reuses an already-authorized device without another picker
  and tunes the last watched channel.

### EPG

The program guide is assembled from live EIT plus events stored in IndexedDB, so it survives
reloads. It shows a timetable per configured channel and lets you tune by selecting a
program. Since one-seg only broadcasts current/next events, the guide is intentionally
compact.

### Settings

- **チャンネル設定** — choose channels two ways:
  - **地域・送信所から選ぶ** — select a prefecture and transmitter from the bundled station
    data, or use **現在地から自動選択 (GPS)** to pick the nearest transmitter automatically.
  - **チャンネルスキャンで選ぶ** — scan physical channels 13–52, then add the channels that
    broadcast a signal. Results are persisted and reused.
- **再生設定** — playback jitter buffer in seconds (0–10 s, default 3 s). A larger buffer
  delays playback to absorb reception gaps; it is applied when the Watch screen is reopened.
- **受信設定** — tuner gain (manual dB or **AGC**) and sample rate (1.2 / 2.0 / 2.048 /
  2.4 MSps). The sample rate is applied on reconnect.

## Building and self-hosting

```bash
npm run build        # tsc -b && vite build -> dist/
npm run preview      # preview the production build
```

Deploy `dist/` to any static host. Pushing to `main` triggers GitHub Actions: CI runs on every
push/PR, and `deploy.yml` publishes `dist/` to GitHub Pages. The Vite `base` is derived from
`GITHUB_REPOSITORY` and can be overridden with `VITE_BASE`.

## Development

```bash
npm run dev          # Vite dev server (HTTPS)
npm run build        # tsc -b && vite build
npm run typecheck    # tsc -b --force
npm test             # Vitest
npm run test:watch   # Vitest watch mode
npm run lint         # oxlint
npm run format       # oxfmt . (write)
npm run format:check # oxfmt --check .
npm run knip         # detect unused code
npm run ci           # lint + format:check + typecheck + test + knip
```

The DSP hot paths are Rust kernels in the single `wasm/dsp/` crate compiled to WebAssembly. The
compiled `.wasm` is embedded as base64 in a committed `src/dsp/wasm/dsp.bytes.ts` and loaded once
via `src/dsp/wasm/dsp.ts`, so all kernels share one instance and linear memory and `build`/`test`
work without a Rust toolchain. To rebuild the kernels:

```bash
rustup target add wasm32-unknown-unknown   # once
npm run build:wasm                          # rebuild all -> src/dsp/wasm/*.bytes.ts
```

Pure TypeScript reference implementations live under `src/dsp/stages/` and are compared against
the WASM wrappers in the corresponding `*.test.ts` files. Tests run in a happy-dom environment
with colocated `*.test.ts` files; DSP and TS layers use synthetic builders rather than committed
captures. Real IQ test files are read from `tests/fixtures/` (gitignored) when available.

The WebGPU shader regression test runs in headless Chrome with SwiftShader. Set
`WEBGPU_CHROME` to a Chrome/Chromium executable to enable it; otherwise it is skipped:

```bash
WEBGPU_CHROME=/usr/bin/google-chrome npm test -- src/dsp/gpu/shaders.test.ts
```

To also check sustained reception and video/audio PES output with WebGPU enabled, set
`WEBGPU_IQ_FILE` to a filtered 128/63 MSps U8 IQ capture. The test feeds it at real-time speed
with the production lock-stall timeout and verifies that reception does not restart acquisition:

```bash
WEBGPU_CHROME=/usr/bin/google-chrome WEBGPU_IQ_FILE=/tmp/opencode/isdbt19.u8 \
  npm test -- src/dsp/gpu/shaders.test.ts
```

See [docs/architecture.md](docs/architecture.md) (Japanese) for the receive chain, the WebUSB
driver, the supported parameters, the project layout and the testing approach.

## Documentation

The files under `docs/` are written in Japanese.

- [docs/architecture.md](docs/architecture.md): runtime architecture, the DSP/FEC pipeline,
  WebAssembly kernels, the WebUSB driver, supported parameters, project layout, testing and
  deployment.
- [README.ja.md](README.ja.md): Japanese README.

## Scope and limitations

This project targets **Japanese terrestrial one-seg** only. Full-seg, B-CAS/ACAS and
descrambling, recording, data-broadcast (BML) rendering, and browsers other than Chrome are
intentionally out of scope. There is no DRM circumvention; scramble-free Japanese one-seg is
received as-is.

## License

No license has been declared for this repository yet.
