import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from './StatusBadge'

describe('StatusBadge', () => {
  it('maps source states to Japanese labels', () => {
    expect(renderToStaticMarkup(createElement(StatusBadge, { state: 'running' }))).toContain(
      '受信中',
    )
    expect(renderToStaticMarkup(createElement(StatusBadge, { state: 'error' }))).toContain('エラー')
    expect(renderToStaticMarkup(createElement(StatusBadge, { state: 'none' }))).toContain('未接続')
  })
})
