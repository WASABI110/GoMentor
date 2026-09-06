import { describe, expect, it } from 'vitest'
import { createLineBuffer } from '../../src/main/katago/ring-buffer'

/**
 * The stderr ring buffer's one load-bearing promise is the bound: a chatty
 * engine must not grow memory without limit, and the crash tail must be the
 * LAST lines, not the FIRST — the diagnostic point of the buffer is the
 * engine's final words.
 */

describe('createLineBuffer', () => {
  it('retains fewer lines than capacity when under the bound', () => {
    const buffer = createLineBuffer(3)
    buffer.push('one')
    buffer.push('two')
    expect(buffer.lines()).toEqual(['one', 'two'])
  })

  it('drops the oldest line once capacity is exceeded', () => {
    const buffer = createLineBuffer(3)
    buffer.push('one')
    buffer.push('two')
    buffer.push('three')
    buffer.push('four')
    expect(buffer.lines()).toEqual(['two', 'three', 'four'])
  })

  it('keeps exactly the last N lines under sustained overflow', () => {
    const buffer = createLineBuffer(2)
    for (let index = 0; index < 10; index += 1) buffer.push(`line-${String(index)}`)
    expect(buffer.lines()).toEqual(['line-8', 'line-9'])
  })

  it('returns a copy, so callers cannot mutate retained state', () => {
    const buffer = createLineBuffer(2)
    buffer.push('one')
    const first = buffer.lines()
    ;(first as string[]).push('tampered')
    expect(buffer.lines()).toEqual(['one'])
  })

  it('clear empties the buffer', () => {
    const buffer = createLineBuffer(2)
    buffer.push('one')
    buffer.clear()
    expect(buffer.lines()).toEqual([])
    buffer.push('two')
    expect(buffer.lines()).toEqual(['two'])
  })
})
