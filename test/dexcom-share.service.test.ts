import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const insertGlucoseReading = vi.hoisted(() => vi.fn())
const fetchMock = vi.fn<typeof fetch>()
const originalFetch = globalThis.fetch

vi.mock('../src/config/env.js', () => ({
  DEXCOM_SHARE_BASE_URL: 'https://share.example.invalid',
  env: {
    DEXCOM_SHARE_USERNAME: 'share-user',
    DEXCOM_SHARE_PASSWORD: 'share-password',
  },
}))
vi.mock('../src/db/queries.js', () => ({ insertGlucoseReading }))

import { fetchShareReadings } from '../src/services/dexcom-share.service.js'

describe('Dexcom Share persistence', () => {
  beforeEach(() => {
    insertGlucoseReading.mockReset()
    fetchMock.mockReset()
    globalThis.fetch = fetchMock
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('awaits persistence and propagates a rejected write', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('"synthetic-session"', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              WT: '/Date(1760000000000)/',
              ST: '/Date(1760000000000)/',
              DT: '/Date(1760000000000)/',
              Value: 123,
              Trend: 4,
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    insertGlucoseReading.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(fetchShareReadings()).rejects.toThrow('database unavailable')
    expect(insertGlucoseReading).toHaveBeenCalledOnce()
  })
})
