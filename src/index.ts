#!/usr/bin/env node

/**
 * Dexcom MCP Server
 * Main entrypoint for the Model Context Protocol server
 *
 * A human-in-the-loop assistive intelligence system for CGM data analysis
 * Read-only, non-autonomous, user-controlled
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Initialize environment (validates and crashes if invalid)
import { env } from './config/env.js';

// Initialize database
import { getDb, closeDb } from './db/database.js';
import { runMigrations } from './db/migrations.js';

// Register all tools
import { registerAllTools } from './tools/index.js';

/**
 * Main server initialization
 */
async function main() {
  console.error('🚀 Starting Dexcom MCP Server...');
  console.error(`📊 Database: ${env.DB_PATH}`);
  console.error(`🔐 API Environment: ${env.DEXCOM_API_ENV}`);

  // Initialize database
  try {
    getDb();
    runMigrations();
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
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

  // Handle process signals
  process.on('SIGINT', async () => {
    console.error('\n⏸️  Shutting down gracefully...');
    closeDb();
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('\n⏸️  Shutting down gracefully...');
    closeDb();
    await server.close();
    process.exit(0);
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('✅ Dexcom MCP Server is running');
  console.error('📡 Listening for MCP requests via stdio...');
  console.error('');
  console.error('Prime Directive: Human-in-the-loop assistive intelligence');
  console.error('  ✓ Claude analyzes, reasons, recommends');
  console.error('  ✓ User decides and acts');
  console.error('  ✓ No automation, no control, no silent changes');
  console.error('');
}

// Run the server
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
