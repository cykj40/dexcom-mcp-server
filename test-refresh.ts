#!/usr/bin/env node
/**
 * Test script to verify token refresh and fetch fresh data
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env manually
function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    console.error('❌ No .env file found.');
    process.exit(1);
  }

  const raw = readFileSync(envPath, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    process.env[key] = value;
  }
}

loadDotEnv();

import { fetchEGVs } from './src/services/dexcom-api.service.js';

async function test() {
  try {
    console.log('Testing token refresh and data fetch...');
    console.log('Attempting to fetch last 24 hours of data...\n');

    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    console.log(`Start: ${startDate}`);
    console.log(`End: ${endDate}\n`);

    const readings = await fetchEGVs(startDate, endDate);

    console.log(`\n✅ Success! Fetched ${readings.length} readings`);
    if (readings.length > 0) {
      const latest = readings[readings.length - 1];
      console.log(`\nLatest reading:`);
      console.log(`  Value: ${latest.value} mg/dL`);
      console.log(`  Trend: ${latest.trendDescription}`);
      console.log(`  Time: ${latest.recordedAt}`);
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

test();
