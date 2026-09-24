import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProgressBar } from './ProgressBar'
import { StatusBadge } from './StatusBadge'

describe('ProgressBar', () => {
  it('clamps the value into 0..100 percent', () => {
    const high = renderToStaticMarkup(createElement(ProgressBar, { value: 2 }))
    expect(high).toContain('aria-valuenow="100"')
    const low = renderToStaticMarkup(createElement(ProgressBar, { value: -1 }))
    expect(low).toContain('aria-valuenow="0"')
  })

  it('renders a label when provided', () => {
    const html = renderToStaticMarkup(createElement(ProgressBar, { value: 0.5, label: '使用率' }))
    expect(html).toContain('使用率')
    expect(html).toContain('aria-valuenow="50"')
  })
})

describe('StatusBadge', () => {
  it('maps source states to Japanese labels', () => {
    expect(renderToStaticMarkup(createElement(StatusBadge, { state: 'running' }))).toContain(
      '受信中',
    )
    expect(renderToStaticMarkup(createElement(StatusBadge, { state: 'error' }))).toContain('エラー')
    expect(renderToStaticMarkup(createElement(StatusBadge, { state: 'none' }))).toContain('未接続')
  })
})
