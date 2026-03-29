#!/usr/bin/env node

/**
 * Dexcom MCP Server
 * Main entrypoint for the Model Context Protocol server
 *
 * A human-in-the-loop assistive intelligence system for CGM data analysis
 * Read-only, non-autonomous, user-controlled
 *
 * Transport modes:
 *   TRANSPORT=stdio (default) — Claude Desktop, local use
 *   TRANSPORT=http            — Remote access via claude.ai
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { IncomingMessage, ServerResponse } from 'http';

// Initialize environment (validates and crashes if invalid)
import { env } from './config/env.js';

// Initialize database
import { closeDb } from './db/database.js';
import { runMigrations } from './db/migrations.js';

// Load persisted tokens after DB init
import { initializeTokens } from './services/dexcom-api.service.js';

// Register all tools
import { registerAllTools } from './tools/index.js';

/**
 * Main server initialization
 */
async function main() {
  const transport = env.TRANSPORT ?? 'stdio';

  console.error('🚀 Starting Dexcom MCP Server...');
  console.error(`📡 Transport: ${transport}`);
  console.error(`🔐 API Environment: ${env.DEXCOM_API_ENV}`);

  // Initialize database and run migrations
  try {
    await runMigrations();
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  }

  // Load persisted OAuth tokens from DB (fall back to env vars if not found)
  try {
    await initializeTokens();
  } catch (error) {
    console.error('⚠️  Token initialization warning (using env vars):', error);
  }

  // Create MCP server
  const server = new Server(
    {
      name: 'dexcom-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register all tools
  registerAllTools(server);

  // Handle server errors
  server.onerror = (error) => {
    console.error('❌ Server error:', error);
  };

  // Graceful shutdown handler
  const shutdown = async () => {
    console.error('\n⏸️  Shutting down gracefully...');
    closeDb();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ── HTTP transport ──────────────────────────────────────────────────────────
  if (transport === 'http') {
    const mcpAuthToken = env.MCP_AUTH_TOKEN;
    if (!mcpAuthToken) {
      console.error('❌ MCP_AUTH_TOKEN must be set when TRANSPORT=http');
      process.exit(1);
    }

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // ── OAuth 2.0 endpoints (for Claude.ai MCP connector) ──────────────────────
    const oauthClientId = env.OAUTH_CLIENT_ID;
    const oauthClientSecret = env.OAUTH_CLIENT_SECRET;

    // GET /.well-known/oauth-authorization-server — discovery metadata
    app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
      const base = `https://${req.hostname}`;
      res.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    });

    // GET /authorize — redirect with auth code
    app.get('/authorize', (req: Request, res: Response) => {
      const { response_type, client_id, redirect_uri, state } = req.query as Record<string, string>;

      if (!oauthClientId || client_id !== oauthClientId) {
        res.status(401).json({ error: 'invalid_client' });
        return;
      }
      if (response_type !== 'code') {
        res.status(400).json({ error: 'unsupported_response_type' });
        return;
      }
      if (!redirect_uri) {
        res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri required' });
        return;
      }

      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set('code', mcpAuthToken);
      if (state) redirectUrl.searchParams.set('state', state);
      res.redirect(redirectUrl.toString());
    });

    // POST /token — exchange code for access token
    app.post('/token', (req: Request, res: Response) => {
      const { grant_type, code, client_id, client_secret } = req.body as Record<string, string>;

      if (!oauthClientId || !oauthClientSecret) {
        res.status(503).json({ error: 'server_error', error_description: 'OAuth not configured' });
        return;
      }
      if (client_id !== oauthClientId || client_secret !== oauthClientSecret) {
        res.status(401).json({ error: 'invalid_client' });
        return;
      }
      if (grant_type !== 'authorization_code') {
        res.status(400).json({ error: 'unsupported_grant_type' });
        return;
      }
      if (code !== mcpAuthToken) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }

      res.json({ access_token: mcpAuthToken, token_type: 'bearer', expires_in: 3600 });
    });

    // Bearer token auth middleware for /mcp
    const requireAuth = (req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${mcpAuthToken}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    };

    // Stateless StreamableHTTP transport (one per server process)
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(httpTransport);

    // MCP endpoints
    app.post(
      '/mcp',
      requireAuth,
      async (req: Request, res: Response) => {
        await httpTransport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body as unknown
        );
      }
    );

    app.get(
      '/mcp',
      requireAuth,
      async (req: Request, res: Response) => {
        await httpTransport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse
        );
      }
    );

    app.delete(
      '/mcp',
      requireAuth,
      async (req: Request, res: Response) => {
        await httpTransport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse
        );
      }
    );

    // Health check (no auth required)
    app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', transport: 'http' });
    });

    const port = parseInt(env.PORT ?? '3000', 10);
    app.listen(port, () => {
      console.error(`✅ Dexcom MCP Server running on port ${port}`);
      console.error(`🌐 MCP endpoint: POST/GET https://<your-app>.fly.dev/mcp`);
    });

  // ── stdio transport (default — for Claude Desktop) ──────────────────────────
  } else {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);

    console.error('✅ Dexcom MCP Server is running');
    console.error('📡 Listening for MCP requests via stdio...');
    console.error('');
    console.error('Prime Directive: Human-in-the-loop assistive intelligence');
    console.error('  ✓ Claude analyzes, reasons, recommends');
    console.error('  ✓ User decides and acts');
    console.error('  ✓ No automation, no control, no silent changes');
    console.error('');
  }
}

// Run the server
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
