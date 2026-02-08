#!/usr/bin/env node
/**
 * Direct test of token refresh without importing service layer
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
const REFRESH_TOKEN = dotenv['DEXCOM_REFRESH_TOKEN'];
const API_ENV = dotenv['DEXCOM_API_ENV'] || 'production';

const BASE_URL = API_ENV === 'sandbox'
  ? 'https://sandbox-api.dexcom.com'
  : 'https://api.dexcom.com';

console.log('Testing token refresh...\n');
console.log(`Environment: ${API_ENV}`);
console.log(`Base URL: ${BASE_URL}`);
console.log(`Client ID: ${CLIENT_ID}`);
console.log(`Refresh Token: ${REFRESH_TOKEN.slice(0, 20)}...\n`);

try {
  const response = await fetch(`${BASE_URL}/v3/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  console.log(`Response status: ${response.status} ${response.statusText}\n`);

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`❌ Token refresh failed: ${response.status} ${response.statusText}`);
    console.error(`Error body: ${errorBody}`);
    process.exit(1);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  console.log('✅ Token refreshed successfully!\n');
  console.log(`New access token: ${data.access_token.slice(0, 30)}...`);
  console.log(`New refresh token: ${data.refresh_token.slice(0, 30)}...`);
  console.log(`Expires in: ${data.expires_in} seconds (${data.expires_in / 3600} hours)\n`);

  // Update .env file
  const envPath = resolve(process.cwd(), '.env');
  let envContent = readFileSync(envPath, 'utf-8');

  envContent = envContent.replace(
    /^DEXCOM_ACCESS_TOKEN=.*$/m,
    `DEXCOM_ACCESS_TOKEN=${data.access_token}`
  );
  envContent = envContent.replace(
    /^DEXCOM_REFRESH_TOKEN=.*$/m,
    `DEXCOM_REFRESH_TOKEN=${data.refresh_token}`
  );

  writeFileSync(envPath, envContent, 'utf-8');
  console.log('✅ .env file updated with new tokens\n');

} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}
