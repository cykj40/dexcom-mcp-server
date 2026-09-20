import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.hoisted(() => vi.fn())

vi.mock('../src/db/database.js', () => ({
  getDb: () => ({ execute }),
}))

import { getBaselineParameters } from '../src/db/queries.js'

describe('baseline parameter queries', () => {
  beforeEach(() => {
    execute.mockReset()
  })

  it('fails when the singleton baseline row is missing', async () => {
    execute.mockResolvedValue({ rows: [] })

    await expect(getBaselineParameters()).rejects.toThrow('Baseline parameters row is missing')
  })
})
