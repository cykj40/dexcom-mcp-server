#!/usr/bin/env node
/**
 * Fetch latest glucose data from Dexcom API
 */

import { readFileSync, existsSync } from 'node:fs';
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
const ACCESS_TOKEN = dotenv['DEXCOM_ACCESS_TOKEN'];
const API_ENV = dotenv['DEXCOM_API_ENV'] || 'production';

const BASE_URL = API_ENV === 'sandbox'
  ? 'https://sandbox-api.dexcom.com'
  : 'https://api.dexcom.com';

// Format date for Dexcom API
function formatDexcomDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

console.log('Fetching latest glucose readings...\n');

try {
  // Fetch last 24 hours of data
  const endDate = new Date();
  const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const formattedStart = formatDexcomDate(startDate);
  const formattedEnd = formatDexcomDate(endDate);

  console.log(`Start: ${formattedStart}`);
  console.log(`End: ${formattedEnd}\n`);

  const endpoint = `/v3/users/self/egvs?startDate=${encodeURIComponent(formattedStart)}&endDate=${encodeURIComponent(formattedEnd)}`;
  const url = `${BASE_URL}${endpoint}`;

  console.log(`Fetching: ${url}\n`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  console.log(`Response: ${response.status} ${response.statusText}\n`);

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`❌ API request failed: ${response.status} ${response.statusText}`);
    console.error(`Error body: ${errorBody}`);
    process.exit(1);
  }

  const data = await response.json() as { records?: any[]; egvs?: any[] };
  const readings = data.records || data.egvs || [];

  console.log(`✅ Fetched ${readings.length} readings\n`);

  if (readings.length > 0) {
    // Sort by systemTime to ensure correct order
    readings.sort((a: any, b: any) =>
      new Date(a.systemTime).getTime() - new Date(b.systemTime).getTime()
    );

    const latest = readings[readings.length - 1];
    const latestTime = new Date(latest.systemTime);

    console.log('Latest reading:');
    console.log(`  Value: ${latest.value} mg/dL`);
    console.log(`  Trend: ${latest.trend}`);
    console.log(`  Time (UTC): ${latestTime.toISOString()}`);
    console.log(`  Time (EST): ${latestTime.toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    console.log(`  Age: ${Math.round((Date.now() - latestTime.getTime()) / 1000 / 60)} minutes ago\n`);

    console.log('Latest 5 readings:');
    console.log('='.repeat(60));
    readings.slice(-5).forEach((reading: any, i: number) => {
      const time = new Date(reading.systemTime).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'short',
        timeStyle: 'short'
      });
      console.log(`${5 - i}. ${reading.value} mg/dL  |  ${reading.trend}  |  ${time}`);
    });
    console.log('='.repeat(60));
  }

} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}
