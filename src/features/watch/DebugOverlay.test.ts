import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RtlFrontendMode } from '../../driver/rtlsdr/rtl2832u'
import { AudioChannelMode } from '../../models/media'
import { defaultSettings } from '../../storage/settings'
import type { AppSettings } from '../../storage/settings'
import { DebugOverlay } from './DebugOverlay'
import { formatPlaybackSettings, formatReceptionSettings } from './debugSettings'

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...defaultSettings(), ...overrides }
}

describe('formatReceptionSettings', () => {
  it('reports AGC, the generic front end and the default rate', () => {
    const text = formatReceptionSettings(settings())
    expect(text).toContain('ゲイン AGC')
    expect(text).toContain('フロントエンド 汎用（分数リサンプラ）')
    expect(text).toContain('サンプルレート 1.200 MSps')
    expect(text).not.toContain('Realtek 固定')
    expect(text).toContain('WebGPU 設定 無効')
  })

  it('reports a manual gain and a configured generic sample rate', () => {
    const text = formatReceptionSettings(settings({ gainDb: 19.7, sampleRate: 2_400_000 }))
    expect(text).toContain('ゲイン 19.7 dB')
    expect(text).toContain('サンプルレート 2.400 MSps')
  })

  it('reports the forced Realtek rate instead of the stored sample rate', () => {
    const text = formatReceptionSettings(
      settings({ frontend: RtlFrontendMode.RealtekIsdbt, sampleRate: 1_200_000 }),
    )
    expect(text).toContain('フロントエンド Realtek ISDB-T（128/63 間引き）')
    expect(text).toContain('サンプルレート 2.032 MSps（Realtek 固定）')
    expect(text).not.toContain('1.200 MSps')
  })

  it('reports whether WebGPU is configured', () => {
    expect(formatReceptionSettings(settings({ webgpu: true }))).toContain('WebGPU 設定 有効')
    expect(formatReceptionSettings(settings({ webgpu: false }))).toContain('WebGPU 設定 無効')
  })
})

describe('formatPlaybackSettings', () => {
  it('reports the buffer, audio channel and subtitle state', () => {
    const text = formatPlaybackSettings(
      settings({ bufferSeconds: 3 }),
      AudioChannelMode.Stereo,
      false,
    )
    expect(text).toContain('バッファ 3.0s')
    expect(text).toContain('音声 ステレオ')
    expect(text).toContain('字幕 なし')
  })

  it('handles a zero buffer and the sub audio channel with subtitles on', () => {
    const text = formatPlaybackSettings(settings({ bufferSeconds: 0 }), AudioChannelMode.Sub, true)
    expect(text).toContain('バッファ 0.0s')
    expect(text).toContain('音声 副音声')
    expect(text).toContain('字幕 あり')
  })

  it('reports the main audio channel', () => {
    expect(formatPlaybackSettings(settings(), AudioChannelMode.Main, false)).toContain(
      '音声 主音声',
    )
  })
})

describe('DebugOverlay', () => {
  it('renders the settings groups alongside the existing metrics', () => {
    const markup = renderToStaticMarkup(
      createElement(DebugOverlay, {
        audioChannel: AudioChannelMode.Main,
        subtitles: true,
        settings: settings({
          gainDb: 12.3,
          frontend: RtlFrontendMode.RealtekIsdbt,
          bufferSeconds: 0,
          webgpu: true,
        }),
      }),
    )
    expect(markup).toContain('受信設定 ゲイン 12.3 dB')
    expect(markup).toContain('WebGPU 設定 有効')
    expect(markup).toContain('再生設定 バッファ 0.0s')
    expect(markup).toContain('音声 主音声')
    expect(markup).toContain('字幕 あり')
    expect(markup).toContain('FPS')
    expect(markup).toContain('信号')
  })
})
