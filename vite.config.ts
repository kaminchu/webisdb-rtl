import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import basicSsl from '@vitejs/plugin-basic-ssl'

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base = process.env.VITE_BASE ?? (repoName ? `/${repoName}/` : '/webisdb-rtl/')

export default defineConfig(({ command }) => ({
  base: command === 'build' ? base : '/',
  plugins: [react(), basicSsl()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
  server: {
    headers: {
      // Reserved for future SharedArrayBuffer usage. Currently unused (Transferable only).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/main.tsx'],
    },
  },
}))
