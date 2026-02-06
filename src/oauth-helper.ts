#!/usr/bin/env node

/**
 * Dexcom OAuth 2.0 Helper with PKCE
 *
 * Implements OAuth 2.0 with PKCE (Proof Key for Code Exchange) for enhanced security.
 *
 * Usage:
 *   npm run oauth
 *
 * Prerequisites:
 *   - DEXCOM_CLIENT_ID, DEXCOM_CLIENT_SECRET, and DEXCOM_REDIRECT_URI set in .env
 *   - DEXCOM_API_ENV set to "sandbox" or "production" in .env (defaults to production)
 */

import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Load .env manually
// ---------------------------------------------------------------------------
function loadDotEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    console.error('❌ No .env file found. Copy .env.example to .env and fill in your client credentials first.');
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

// ---------------------------------------------------------------------------
// Validate required credentials
// ---------------------------------------------------------------------------
const dotenv = loadDotEnv();

const CLIENT_ID = dotenv['DEXCOM_CLIENT_ID'];
const CLIENT_SECRET = dotenv['DEXCOM_CLIENT_SECRET'];
const REDIRECT_URI = dotenv['DEXCOM_REDIRECT_URI'] || 'http://localhost:3000/callback';
const API_ENV = dotenv['DEXCOM_API_ENV'] || 'production';

if (!CLIENT_ID || CLIENT_ID === 'your_client_id_here') {
  console.error('❌ DEXCOM_CLIENT_ID is not set in .env');
  process.exit(1);
}
if (!CLIENT_SECRET || CLIENT_SECRET === 'your_client_secret_here') {
  console.error('❌ DEXCOM_CLIENT_SECRET is not set in .env');
  process.exit(1);
}

const BASE_URL =
  API_ENV === 'sandbox'
    ? 'https://sandbox-api.dexcom.com'
    : 'https://api.dexcom.com';

// Extract port from redirect URI
const redirectUrl = new URL(REDIRECT_URI);
const PORT = parseInt(redirectUrl.port, 10) || 3000;
const CALLBACK_PATH = redirectUrl.pathname;

// ---------------------------------------------------------------------------
// PKCE Helper Functions
// ---------------------------------------------------------------------------
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return crypto.randomBytes(16).toString('base64url');
}

// ---------------------------------------------------------------------------
// Main OAuth Flow
// ---------------------------------------------------------------------------
(async () => {
  try {
    console.log('');
    console.log('='.repeat(60));
    console.log('  Dexcom OAuth 2.0 Setup (PKCE)');
    console.log(`  Environment: ${API_ENV}`);
    console.log('='.repeat(60));
    console.log('');

    // Generate PKCE code verifier and challenge
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    // Build authorization URL with PKCE
    const authUrl = new URL(`${BASE_URL}/v3/oauth2/login`);
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'offline_access');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);

    console.log('Step 1: Open this URL in your browser to authorize:\n');
    console.log(`  ${authUrl.toString()}\n`);
    console.log(`Waiting for callback on ${REDIRECT_URI} ...\n`);

    // Start local callback server
    const server = createServer(async (req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }

      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

      // Only handle the callback path
      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const error = reqUrl.searchParams.get('error');
      if (error) {
        console.error(`\n❌ Authorization denied: ${error}`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization Denied</h1><p>You can close this tab.</p>');
        server.close();
        process.exit(1);
      }

      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');

      if (!code || !returnedState) {
        console.error('\n❌ No authorization code or state received');
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Error</h1><p>No authorization code received.</p>');
        return;
      }

      // Validate state
      if (returnedState !== state) {
        console.error('\n❌ State mismatch! Possible CSRF attack.');
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Error</h1><p>State validation failed.</p>');
        server.close();
        process.exit(1);
      }

      console.log('✅ Authorization code received! Exchanging for tokens...\n');

      // Exchange code for tokens with PKCE
      try {
        const tokenResponse = await fetch(`${BASE_URL}/v3/oauth2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            code_verifier: codeVerifier,
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

        // Success — display tokens
        console.log('='.repeat(60));
        console.log('  Tokens Received Successfully!');
        console.log('='.repeat(60));
        console.log('');
        console.log(`  Access Token:  ${tokenData.access_token.slice(0, 20)}...`);
        console.log(`  Refresh Token: ${tokenData.refresh_token.slice(0, 20)}...`);
        console.log(`  Expires In:    ${tokenData.expires_in} seconds`);
        console.log(`  Token Type:    ${tokenData.token_type}`);
        console.log('');

        // Write tokens to .env
        const envPath = resolve(process.cwd(), '.env');
        let envContent = readFileSync(envPath, 'utf-8');

        envContent = upsertEnvVar(envContent, 'DEXCOM_ACCESS_TOKEN', tokenData.access_token);
        envContent = upsertEnvVar(envContent, 'DEXCOM_REFRESH_TOKEN', tokenData.refresh_token);

        writeFileSync(envPath, envContent, 'utf-8');

        console.log('✅ Tokens written to .env automatically!');
        console.log('');
        console.log('You can now start the MCP server:');
        console.log('');
        console.log('  npm run build && npm start');
        console.log('');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1>Success!</h1><p>Tokens have been saved to your <code>.env</code> file. You can close this tab.</p>'
        );
      } catch (err) {
        console.error('\n❌ Token exchange failed:', err);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Error</h1><p>Token exchange failed. Check the terminal for details.</p>');
      }

      // Shut down the helper server
      server.close(() => process.exit(0));
    });

    server.listen(PORT, () => {
      console.log(`  (Local server listening on port ${PORT})\n`);
    });

  } catch (error) {
    console.error('❌ Failed to initialize OAuth client:', error);
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// Utility — insert or update a key in .env content
// ---------------------------------------------------------------------------
function upsertEnvVar(content: string, key: string, value: string): string {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const newLine = `${key}=${value}`;

  if (regex.test(content)) {
    return content.replace(regex, newLine);
  }
  // Append if not found
  return content.trimEnd() + '\n' + newLine + '\n';
}
