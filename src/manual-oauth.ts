#!/usr/bin/env node

/**
 * Manual Dexcom OAuth 2.0 Token Exchange
 *
 * Use this when the automatic callback doesn't work.
 * You'll manually copy the authorization code from the browser.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as readline from 'node:readline/promises';

// Load .env
function loadDotEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    console.error('❌ No .env file found.');
    process.exit(1);
  }

  const raw = readFileSync(envPath, 'utf-8');
  const vars: Record<string, string> = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    vars[key] = value;
  }

  return vars;
}

const dotenv = loadDotEnv();
const CLIENT_ID = dotenv['DEXCOM_CLIENT_ID'];
const CLIENT_SECRET = dotenv['DEXCOM_CLIENT_SECRET'];
const API_ENV = dotenv['DEXCOM_API_ENV'] || 'production';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Client credentials not set in .env');
  process.exit(1);
}

const BASE_URL = API_ENV === 'sandbox'
  ? 'https://sandbox-api.dexcom.com'
  : 'https://api.dexcom.com';

// For manual flow, we'll use the OAuth "out of band" redirect URI
const MANUAL_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

console.log('');
console.log('='.repeat(60));
console.log('  Manual Dexcom OAuth 2.0 Flow');
console.log(`  Environment: ${API_ENV}`);
console.log('='.repeat(60));
console.log('');
console.log('Step 1: Open this URL in your browser:\n');

const authUrl = new URL(`${BASE_URL}/v3/oauth2/login`);
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', MANUAL_REDIRECT);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', 'offline_access');

console.log(`  ${authUrl.toString()}\n`);
console.log('Step 2: After authorizing, you\'ll be redirected to:');
console.log(`  ${MANUAL_REDIRECT}/?code=XXXXXX\n`);
console.log('Step 3: Copy the "code" parameter from the URL\n');
console.log('='.repeat(60));
console.log('');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const code = await rl.question('Paste the authorization code here: ');
rl.close();

if (!code || code.trim() === '') {
  console.error('❌ No code provided');
  process.exit(1);
}

console.log('\n✅ Code received! Exchanging for tokens...\n');

try {
  const tokenResponse = await fetch(`${BASE_URL}/v3/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code.trim(),
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: MANUAL_REDIRECT,
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    throw new Error(`Token exchange failed (${tokenResponse.status}): ${errorBody}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };

  console.log('='.repeat(60));
  console.log('  Tokens Received Successfully!');
  console.log('='.repeat(60));
  console.log('');
  console.log(`  Access Token:  ${tokenData.access_token.slice(0, 20)}...`);
  console.log(`  Refresh Token: ${tokenData.refresh_token.slice(0, 20)}...`);
  console.log(`  Expires In:    ${tokenData.expires_in} seconds`);
  console.log(`  Token Type:    ${tokenData.token_type}`);
  console.log('');

  console.log('Seed Turso with these tokens once, or set them as temporary bootstrap env vars before first boot.');
  console.log('');

} catch (err) {
  console.error('\n❌ Token exchange failed:', err);
  process.exit(1);
}
