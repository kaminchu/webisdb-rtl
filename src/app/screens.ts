import { Screen } from './store'

export interface ScreenMeta {
  id: Screen
  label: string
  description: string
}

export const SCREENS: ScreenMeta[] = [
  { id: Screen.Watch, label: '視聴', description: 'ワンセグ映像・音声・字幕' },
  { id: Screen.Epg, label: '番組表', description: 'EPG（番組表）' },
  { id: Screen.Scan, label: 'スキャン', description: 'チャンネル / EPG スキャン' },
  { id: Screen.Debug, label: 'デバッグ', description: 'PSI/SI・TMCC・統計' },
  { id: Screen.Settings, label: '設定', description: '地域・デバイス・バッファ' },
]
