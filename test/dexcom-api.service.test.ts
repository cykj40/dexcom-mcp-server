import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredTokenSet } from '../src/db/token-store.js';

type DexcomApiService = typeof import('../src/services/dexcom-api.service.js');

const futureDate = new Date(Date.now() + 60 * 60 * 1000);
const expiredDate = new Date(Date.now() - 1000);

const getTokenSetMock = vi.fn<() => Promise<StoredTokenSet | null>>();
const setTokenSetMock = vi.fn<(tokens: StoredTokenSet) => Promise<void>>();

const fetchMock = vi.fn<typeof fetch>();

async function loadService(envTokens?: {
  accessToken?: string;
  refreshToken?: string;
}): Promise<DexcomApiService> {
  vi.resetModules();
  vi.doMock('../src/config/env.js', () => ({
    env: {
      DEXCOM_CLIENT_ID: 'client-id',
      DEXCOM_CLIENT_SECRET: 'client-secret',
      DEXCOM_REDIRECT_URI: 'http://localhost:3000/callback',
      DEXCOM_ACCESS_TOKEN: envTokens?.accessToken,
      DEXCOM_REFRESH_TOKEN: envTokens?.refreshToken,
      DEXCOM_API_ENV: 'sandbox',
      TURSO_DATABASE_URL: 'file::memory:',
    },
    getDexcomApiBaseUrl: () => 'https://sandbox-api.dexcom.com',
  }));
  vi.doMock('../src/db/token-store.js', () => ({
    getTokenSet: getTokenSetMock,
    setTokenSet: setTokenSetMock,
  }));

  return import('../src/services/dexcom-api.service.js');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokenRequestBody(callIndex: number): URLSearchParams {
  const init = fetchMock.mock.calls[callIndex]?.[1];
  expect(init?.body).toBeInstanceOf(URLSearchParams);
  return init?.body as URLSearchParams;
}

describe('Dexcom API token handling', () => {
  beforeEach(() => {
    getTokenSetMock.mockReset();
    setTokenSetMock.mockReset();
    fetchMock.mockReset();
    setTokenSetMock.mockResolvedValue(undefined);
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.doUnmock('../src/config/env.js');
    vi.doUnmock('../src/db/token-store.js');
    vi.restoreAllMocks();
  });

  it('refreshes proactively when the persisted token is expired before calling Dexcom', async () => {
    getTokenSetMock.mockResolvedValue({
      accessToken: 'expired-access',
      refreshToken: 'old-refresh',
      expiresAt: expiredDate,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(200, { start: { systemTime: '2026-01-01T00:00:00' } }));

    const service = await loadService();
    await service.initializeTokens();
    await service.getDataRange();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://sandbox-api.dexcom.com/v3/oauth2/token');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://sandbox-api.dexcom.com/v3/users/self/dataRange');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer fresh-access',
    });
  });

  it('refreshes and retries exactly once after a 401 on a read call', async () => {
    getTokenSetMock.mockResolvedValue({
      accessToken: 'current-access',
      refreshToken: 'current-refresh',
      expiresAt: futureDate,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: 'retry-access',
        refresh_token: 'retry-refresh',
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(200, { start: { systemTime: '2026-01-01T00:00:00' } }));

    const service = await loadService();
    await service.initializeTokens();
    await service.getDataRange();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://sandbox-api.dexcom.com/v3/users/self/dataRange',
      'https://sandbox-api.dexcom.com/v3/oauth2/token',
      'https://sandbox-api.dexcom.com/v3/users/self/dataRange',
    ]);
  });

  it('persists the rotated refresh token and uses it on the next refresh', async () => {
    getTokenSetMock.mockResolvedValue({
      accessToken: 'first-access',
      refreshToken: 'first-refresh',
      expiresAt: futureDate,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: 'second-access',
        refresh_token: 'second-refresh',
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(200, { start: { systemTime: '2026-01-01T00:00:00' } }))
      .mockResolvedValueOnce(jsonResponse(401, { error: 'expired-again' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: 'third-access',
        refresh_token: 'third-refresh',
        expires_in: 3600,
      }))
      .mockResolvedValueOnce(jsonResponse(200, { start: { systemTime: '2026-01-01T00:00:00' } }));

    const service = await loadService();
    await service.initializeTokens();
    await service.getDataRange();
    await service.getDataRange();

    expect(setTokenSetMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accessToken: 'second-access',
      refreshToken: 'second-refresh',
    }));
    expect(tokenRequestBody(1).get('refresh_token')).toBe('first-refresh');
    expect(tokenRequestBody(4).get('refresh_token')).toBe('second-refresh');
  });

  it('throws on persist failure without logging token substrings', async () => {
    const accessToken = 'secret-access-token-value';
    const refreshToken = 'secret-refresh-token-value';
    getTokenSetMock.mockResolvedValue({
      accessToken: 'expired-access',
      refreshToken: 'old-refresh',
      expiresAt: expiredDate,
    });
    setTokenSetMock.mockRejectedValueOnce(new Error('db unavailable'));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
    }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const service = await loadService();

    await expect(service.initializeTokens()).rejects.toThrow('Failed to persist rotated Dexcom OAuth tokens to Turso');
    const logged = consoleErrorSpy.mock.calls.flat().map((arg) => String(arg)).join('\n');
    expect(logged).not.toContain(accessToken);
    expect(logged).not.toContain(refreshToken);
  });

  it('boots with empty env tokens by reading tokens from Turso', async () => {
    getTokenSetMock.mockResolvedValue({
      accessToken: 'db-access',
      refreshToken: 'db-refresh',
      expiresAt: futureDate,
    });

    const service = await loadService();
    await expect(service.initializeTokens()).resolves.toBeUndefined();

    expect(service.getCurrentAccessToken()).toBe('db-access');
    expect(service.getCurrentRefreshToken()).toBe('db-refresh');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts cleanly with no Turso tokens and no bootstrap env tokens', async () => {
    getTokenSetMock.mockResolvedValue(null);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const service = await loadService();
    await expect(service.initializeTokens()).resolves.toBeUndefined();

    const logged = consoleErrorSpy.mock.calls.flat().map((arg) => String(arg)).join('\n');
    expect(logged).toContain('No Dexcom OAuth tokens found in Turso');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
