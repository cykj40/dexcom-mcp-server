import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.hoisted(() => vi.fn())

vi.mock('../src/db/database.js', () => ({
  getDb: () => ({ execute, batch: vi.fn(async () => {}) }),
}))

import { runMigrations } from '../src/db/migrations.js'

function executedSql(): string[] {
  return execute.mock.calls.map(([statement]) =>
    typeof statement === 'string' ? statement : statement.sql,
  )
}

describe('baseline migration', () => {
  beforeEach(() => {
    execute.mockReset()
  })

  it('initializes baseline parameters when creating the table', async () => {
    execute.mockResolvedValue({ rows: [] })

    await runMigrations()

    expect(executedSql().some((sql) => sql.includes('INSERT INTO baseline_parameters'))).toBe(true)
  })

  it('does not recreate a missing row in an existing baseline table', async () => {
    execute.mockImplementation(async (statement: string | { sql: string }) => {
      const sql = typeof statement === 'string' ? statement : statement.sql
      return { rows: sql.includes('FROM sqlite_master') ? [{ exists: 1 }] : [] }
    })

    await runMigrations()

    expect(executedSql().some((sql) => sql.includes('INSERT INTO baseline_parameters'))).toBe(false)
  })
})
