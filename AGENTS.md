# AGENTS.md — WebISDB-RTL

Browser-based one-seg (ISDB-T) receiver. TypeScript + React + Vite, no backend.
See `plans/要件定義.md` (requirements) and `plans/実装計画.md` (implementation plan).

## Commands

```bash
npm run dev          # Vite dev server
npm run build        # tsc -b && vite build
npm run build:wasm   # rebuild Rust DSP kernels -> src/dsp/wasm/*.bytes.ts (needs wasm32 target)
npm run typecheck    # tsc -b --force
npm test             # vitest run
npm run lint         # oxlint
npm run format       # oxfmt .  (write)
npm run format:check # oxfmt --check .
npm run knip         # unused code
npm run ci           # lint + format:check + typecheck + test + knip
```

Always run `npm run format` before finishing a task, then `npm run typecheck` and `npm test`.

DSP hot paths run as WebAssembly kernels (`wasm/<name>/` Rust crates). Build with
`rustup target add wasm32-unknown-unknown` once, then `npm run build:wasm`. The compiled
`.wasm` is embedded as base64 in the committed `src/dsp/wasm/<name>.bytes.ts`, so `build`
and `test` do not need Rust. TypeScript reference implementations remain under
`src/dsp/stages/` and are compared against the WASM wrappers in `src/dsp/wasm/*.test.ts`.

## Code conventions

- TypeScript strict, ESM. **No `enum`** (tsconfig has `erasableSyntaxOnly`); use `as const` objects.
- **Do not add comments unless they explain non-obvious algorithms or cite a spec.** No section banners.
- Formatting is enforced by oxfmt: no semicolons, single quotes, 100 columns, trailing commas.
- Lint via oxlint (`correctness` = error). Keep warnings to a minimum; `no-console` is allowed.
- UI: React function components + **CSS Modules**. No external UI/component libraries.
- Tests: colocated `*.test.ts` next to source (Vitest, happy-dom environment). Prefer pure,
  deterministic unit tests. Use synthetic builders for DSP/TS; do not commit large capture files.
- Comments/UI text may be Japanese; identifiers and code comments in English.

## Architecture contracts (do not change without coordination)

- `src/models/**` — data models and PSI/SI/TMCC DTOs. Internal, pure types.
- `src/iq/IQSource.ts` — hardware/file IQ abstraction. `RTLSDRSource` and `IQFileSource` implement it.
- `src/dsp/backend.ts` — `FftBackend` / `ViterbiBackend` / `RsBackend` swap boundary (TS now, WASM later).
- `src/dsp/isdbtParams.ts` — ISDB-T constants (modes, carriers, TMCC positions, pilots).
- `src/workers/protocol.ts` — worker message unions.
- `src/app/store.ts` — app state + `useStore` selector hook. Selectors MUST return stable values
  (primitives or stable references); never return freshly-created objects/arrays.

## Hardware notes

- Target devices: RTL-SDR Blog V3 (R820T2) and V4 (R828D). Local dev hardware is a generic
  RTL2832U + **Fitipower FC0013** tuner, so the driver supports FC0013 too.
- Dev captures live in `tests/fixtures/` (gitignored) or `/tmp`. Real one-seg IQ for Niigata
  is available from physical channels 13/15/17/19/23/26 (UHF, 1.2 MSps, U8 I/Q).
- RTL-SDR rules: `bRequest` is always 0 (block in `wIndex`, addr in `wValue`); every demod write
  must be followed by a commit read of page `0x0a`, addr `0x01`.
