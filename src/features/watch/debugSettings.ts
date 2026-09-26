import { desiredSampleRate } from '../../app/receiverController'
import { RtlFrontendMode } from '../../driver/rtlsdr/rtl2832u'
import type { AudioChannelMode } from '../../models/media'
import type { AppSettings } from '../../storage/settings'

const AUDIO_CHANNEL_LABELS: Record<AudioChannelMode, string> = {
  stereo: 'ステレオ',
  main: '主音声',
  sub: '副音声',
}

const FRONTEND_LABELS: Record<RtlFrontendMode, string> = {
  [RtlFrontendMode.Generic]: '汎用（分数リサンプラ）',
  [RtlFrontendMode.RealtekIsdbt]: 'Realtek ISDB-T（128/63 間引き）',
}

export function formatReceptionSettings(settings: AppSettings): string {
  const gain = settings.gainDb === null ? 'AGC' : `${settings.gainDb.toFixed(1)} dB`
  const rate = (desiredSampleRate(settings) / 1_000_000).toFixed(3)
  const fixed = settings.frontend === RtlFrontendMode.RealtekIsdbt ? '（Realtek 固定）' : ''
  const webgpu = settings.webgpu ? '有効' : '無効'
  return `受信設定 ゲイン ${gain} / フロントエンド ${FRONTEND_LABELS[settings.frontend]} / サンプルレート ${rate} MSps${fixed} / WebGPU 設定 ${webgpu}`
}

export function formatPlaybackSettings(
  settings: AppSettings,
  audioChannel: AudioChannelMode,
  subtitles: boolean,
): string {
  return `再生設定 バッファ ${settings.bufferSeconds.toFixed(1)}s / 音声 ${AUDIO_CHANNEL_LABELS[audioChannel]} / 字幕 ${subtitles ? 'あり' : 'なし'}`
}
