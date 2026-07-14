// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import '../test/dom'
import Avatar from './Avatar'

const patternFor = (seed: string) =>
  Array.from(render(<Avatar seed={seed} label={seed} />).container.querySelectorAll('rect'))
    .map(rect => `${rect.getAttribute('x')}:${rect.getAttribute('y')}:${rect.getAttribute('fill')}`)

describe('Avatar', () => {
  test('renders a deterministic identicon for the same visitor seed', () => {
    expect(patternFor('visitor-seed-1')).toEqual(patternFor('visitor-seed-1'))
  })

  test('changes the generated pattern when the visitor seed changes', () => {
    expect(patternFor('visitor-seed-1')).not.toEqual(patternFor('visitor-seed-2'))
  })

  test('keeps the visitor label accessible', () => {
    const { getByRole } = render(<Avatar seed="visitor-seed" label="访客 0001" />)

    expect(getByRole('img', { name: '访客 0001' }).getAttribute('title')).toBe('访客 0001')
  })

  test('adds layered non-interactive ripples only to the highlighted avatar', () => {
    const highlighted = render(
      <Avatar seed="visitor-seed" label="访客 0001" highlighted />,
    )
    const normal = render(<Avatar seed="other-seed" label="访客 0002" />)

    expect(highlighted.container.querySelectorAll('.avatar__ripple')).toHaveLength(2)
    expect(highlighted.container.querySelectorAll('[aria-hidden="true"]')).not.toHaveLength(0)
    expect(normal.container.querySelectorAll('.avatar__ripple')).toHaveLength(0)
  })
})
