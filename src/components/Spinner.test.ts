import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Spinner } from './Spinner'

describe('Spinner', () => {
  it('renders a status indicator with the given label', () => {
    const markup = renderToStaticMarkup(
      createElement(Spinner, { label: 'ch 13 の番組情報を取得中' }),
    )
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-label="ch 13 の番組情報を取得中"')
  })

  it('defaults to the small size', () => {
    expect(renderToStaticMarkup(createElement(Spinner, {}))).toContain('sm')
  })
})
