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

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { type Request, type Response } from 'express'
import { oauthConfig } from './auth/config.js'
import { registerOAuth, sanitizedHttpError } from './auth/http.js'
import { OAuthStore } from './auth/store.js'

export { secretEquals } from './auth/crypto.js'

// Initialize environment (validates and crashes if invalid)
import { env } from './config/env.js'

// Initialize database
import { closeDb, getDb } from './db/database.js'
import { runMigrations } from './db/migrations.js'

// Load persisted tokens after DB init
import { initializeTokens } from './services/dexcom-api.service.js'

// Register all tools
import { registerAllTools } from './tools/index.js'

/**
 * Main server initialization
 */
async function main() {
  const transport = env.TRANSPORT ?? 'stdio'
  const httpConfig = transport === 'http' ? oauthConfig(env) : undefined

  console.error('🚀 Starting Dexcom MCP Server...')
  console.error(`📡 Transport: ${transport}`)
  console.error(`🔐 API Environment: ${env.DEXCOM_API_ENV}`)

  // Initialize database and run migrations
  try {
    await runMigrations()
  } catch (error) {
    console.error('❌ Database initialization failed:', error)
    process.exit(1)
  }

  // Load persisted OAuth tokens from Turso, with env vars as one-time bootstrap only
  try {
    await initializeTokens()
  } catch (error) {
    console.error('❌ Token initialization failed:', error)
    process.exit(1)
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
    },
  )

  // Register all tools
  registerAllTools(server)

  // Handle server errors
  server.onerror = (error) => {
    console.error('❌ Server error:', error)
  }

  // Graceful shutdown handler
  const shutdown = async () => {
    console.error('\n⏸️  Shutting down gracefully...')
    closeDb()
    await server.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // ── HTTP transport ──────────────────────────────────────────────────────────
  if (httpConfig) {
    const app = express()
    app.disable('x-powered-by')
    app.use(express.json())
    app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 }))
    const oauthStore = new OAuthStore(getDb)
    const requireAuth = registerOAuth(app, httpConfig, oauthStore)
    // Cleanup is housekeeping only; every authorization query independently enforces expiry.
    await oauthStore.cleanup()
    const cleanupTimer = setInterval(
      () => {
        void oauthStore.cleanup().catch(() => console.error('OAuth cleanup failed'))
      },
      60 * 60 * 1000,
    )
    cleanupTimer.unref()

    // Stateless StreamableHTTP transport (one per server process)
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    await server.connect(httpTransport)

    // MCP endpoints
    app.post('/mcp', requireAuth, async (req: Request, res: Response) => {
      await httpTransport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body as unknown,
      )
    })

    app.get('/mcp', requireAuth, async (req: Request, res: Response) => {
      await httpTransport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      )
    })

    app.delete('/mcp', requireAuth, async (req: Request, res: Response) => {
      await httpTransport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      )
    })

    // Health check (no auth required)
    app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', transport: 'http' })
    })

    // Never allow Express's default error handler to print parser bodies or driver errors.
    app.use(sanitizedHttpError)

    const port = parseInt(env.PORT ?? '3000', 10)
    app.listen(port, () => {
      console.error(`✅ Dexcom MCP Server running on port ${port}`)
      console.error(`🌐 MCP endpoint: POST/GET https://<your-app>.fly.dev/mcp`)
    })

    // ── stdio transport (default — for Claude Desktop) ──────────────────────────
  } else {
    const stdioTransport = new StdioServerTransport()
    await server.connect(stdioTransport)

    console.error('✅ Dexcom MCP Server is running')
    console.error('📡 Listening for MCP requests via stdio...')
    console.error('')
    console.error('Prime Directive: Human-in-the-loop assistive intelligence')
    console.error('  ✓ Claude analyzes, reasons, recommends')
    console.error('  ✓ User decides and acts')
    console.error('  ✓ No automation, no control, no silent changes')
    console.error('')
  }
}

// Run the server
main().catch((error) => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})
