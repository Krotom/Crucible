import { describe, expect, it } from 'vitest'
import { page } from '../src/analysis/report'
import { EMBLEM_DARK_B64, WORDMARK_INK_B64 } from '../src/branding/assets'

describe('branding', () => {
  it('embeds the BALTA header in generated reports, in a way that works without any other file', () => {
    const html = page('Test report', 'sub', '<p>body</p>')
    expect(html).toContain('class="brandbar"')
    expect(html).toContain('BALTA Robotics')
    expect(html).toContain('data:image/png;base64,')
    expect(html).not.toMatch(/src="(?!data:)/) // no external images
  })

  it('the inline images are real PNGs', () => {
    for (const b64 of [EMBLEM_DARK_B64, WORDMARK_INK_B64]) expect(Buffer.from(b64, 'base64').subarray(1, 4).toString()).toBe('PNG')
  })
})
