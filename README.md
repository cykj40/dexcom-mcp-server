# Dexcom MCP Server

MCP (Model Context Protocol) server that connects an MCP host (such as Claude Desktop) to personal Dexcom CGM data for **human-in-the-loop** glucose analysis, event logging, and modeling. The host can analyze and recommend; you decide and act. This project does not automate insulin delivery or change pump settings.

## Features

- **Glucose tools** — latest reading, ranges, daily summaries, and statistics
- **Trend analysis** — patterns over days/weeks, expected vs actual, parameter-drift signals
- **Event logging** — insulin, carbs, and exercise, plus timeline / per-type retrieval
- **Charts** — timeline, daily, weekly, and AGP-style visualizations
- **Modeling** — baseline ISF/ICR/basal parameters, impact predictions, adaptive insights
- **Transports** — `stdio` (local MCP hosts) or `http` (remote connector with OAuth 2.1 + PKCE)

## Requirements

- Node.js 18+ (Docker image uses Node 20)
- Dexcom Developer API credentials ([developer.dexcom.com](https://developer.dexcom.com/))
- A Dexcom CGM account with data available via the Developer API
- A [Turso](https://turso.tech/) database (OAuth tokens and persisted readings/events)

Optional: Dexcom Share username/password as a best-effort fallback when the Developer API path fails.

## Quick start (local / stdio)

### 1. Clone and install

```bash
git clone https://github.com/cykj40/dexcom-mcp-server.git
cd dexcom-mcp-server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Set at least:

| Variable | Required | Purpose |
|----------|----------|---------|
| `DEXCOM_CLIENT_ID` | Yes | Dexcom OAuth client ID |
| `DEXCOM_CLIENT_SECRET` | Yes | Dexcom OAuth client secret |
| `DEXCOM_REDIRECT_URI` | Yes | Must match the app redirect (e.g. `http://localhost:3000/callback`) |
| `TURSO_DATABASE_URL` | Yes | Turso `libsql://…` URL |
| `TURSO_AUTH_TOKEN` | Yes | Turso auth token |
| `DEXCOM_API_ENV` | No | `production` (default) or `sandbox` |
| `TRANSPORT` | No | `stdio` (default, recommended for local) or `http` |
| `SERVER_TIMEZONE` | No | IANA timezone for daily buckets (default UTC) |

Optional (stdio / bootstrap):

| Variable | Purpose |
|----------|---------|
| `DEXCOM_ACCESS_TOKEN` / `DEXCOM_REFRESH_TOKEN` | One-time bootstrap only if Turso has no tokens yet |
| `DEXCOM_SHARE_USERNAME` / `DEXCOM_SHARE_PASSWORD` | Share API fallback |

When `TRANSPORT=http`, also set:

| Variable | Purpose |
|----------|---------|
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | MCP connector client credentials |
| `OAUTH_ALLOWED_REDIRECT_URIS` | Exact callback URLs, comma-separated |
| `OAUTH_ISSUER_URL` | Canonical HTTPS origin (no trailing slash) |
| `OAUTH_OWNER_APPROVAL_KEY_SHA256` | SHA-256 hex digest of your owner approval key |
| `MCP_AUTH_TOKEN` | Legacy bearer accepted at `/mcp` only until a fixed cutoff (see `.env.example`); prefer OAuth grants |
| `PORT` | Listen port (default `3000`) |

Do not commit `.env` or any database files.

### 3. Dexcom OAuth (one-time)

```bash
npm run oauth
```

Complete the browser flow so tokens land in Turso (or use the optional bootstrap env vars once). Manual flow: `npm run oauth:manual`.

### 4. Build and run

```bash
npm run build
npm start
```

Development:

```bash
npm run dev
```

### 5. Claude Desktop (stdio)

Example `claude_desktop_config.json` (use absolute paths and your own secrets):

```json
{
  "mcpServers": {
    "dexcom": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/dexcom-mcp-server/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "DEXCOM_CLIENT_ID": "your_client_id",
        "DEXCOM_CLIENT_SECRET": "your_client_secret",
        "DEXCOM_REDIRECT_URI": "http://localhost:3000/callback",
        "TURSO_DATABASE_URL": "libsql://your-db.turso.io",
        "TURSO_AUTH_TOKEN": "your_turso_auth_token",
        "DEXCOM_API_ENV": "production"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

## HTTP transport (optional / remote)

With `TRANSPORT=http`, the server exposes:

- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`
- `/authorize` and `/token` (OAuth 2.1 authorization code + PKCE S256, owner-key approval)
- Authenticated `/mcp`
- Public `/health`

Operator CLI (after build): `node dist/auth/admin.js list` and `node dist/auth/admin.js revoke <grant-id>`.

Prefer stdio for local use. Treat HTTP mode as a high-sensitivity deployment: strong secrets, exact redirect allowlists, HTTPS issuer URL, and private hosting.

Optional deploy config lives in `fly.toml` (Fly.io). Do not publish live app URLs or secrets in docs.

## Available MCP tools

### Glucose
- `get_latest_glucose`
- `get_glucose_range`
- `get_daily_summary`
- `get_glucose_statistics`

### Analysis
- `analyze_trends`
- `compare_expected_vs_actual`
- `detect_parameter_drift`

### Events
- `log_insulin`, `log_carbs`, `log_exercise`
- `get_event_timeline`
- `get_insulin_events`, `get_carb_events`, `get_exercise_events`

### Charts
- `generate_chart`

### Modeling
- `get_baseline_parameters`
- `update_baseline_parameters` (requires explicit confirmation in the tool args; treat as sensitive)
- `predict_glucose_impact`
- `get_adaptive_insights`

## Example prompts (generic)

```
What's my latest glucose and trend?
```

```
Summarize yesterday's glucose statistics.
```

```
Log 5 units of rapid insulin for lunch and 45g carbs.
```

```
Show an event timeline for the last 24 hours.
```

```
Predict the glucose impact of 40g of carbs with my current baseline.
```

## Data storage

Runtime persistence uses **Turso** (`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`): OAuth tokens, glucose readings, events, and related records. This is a third-party hosted database you control via your Turso account.

Do not commit database files; keep `data/` and `*.db*` gitignored. Prefer keeping the repository private while it holds health-data tooling.

## Security notes

- Keep credentials in environment variables or a secret store — never in source.
- Prefer `TRANSPORT=stdio` for local use.
- HTTP mode uses OAuth 2.1 + PKCE with owner approval and hashed tokens. Rotate any legacy `MCP_AUTH_TOKEN` if it may have been exposed, and prefer OAuth grants.
- This server is assistive and must not be treated as a closed-loop controller.
- Review git history before making the repo public: do not leave historical database blobs or secrets reachable.

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server |
| `npm run dev` | Dev watch mode |
| `npm run oauth` | Dexcom OAuth helper |
| `npm run oauth:manual` | Manual code exchange helper |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run lint` / `npm run lint:fix` | Biome |
| `npm run format` | Format with Biome |

## Project structure

```
dexcom-mcp-server/
├── src/
│   ├── auth/         # HTTP OAuth, crypto helpers, grant admin CLI
│   ├── config/       # Env validation
│   ├── db/           # Turso client, migrations, queries, token store
│   ├── services/     # Dexcom API/Share, glucose, events, modeling, charts
│   ├── tools/        # MCP tool registration
│   ├── types/        # Shared types
│   ├── utils/
│   ├── oauth-helper.ts
│   ├── manual-oauth.ts
│   └── index.ts      # Entrypoint (stdio / http)
├── test/             # Vitest tests and fixtures
├── .env.example
├── fly.toml          # Optional Fly.io deploy config
└── package.json
```

## Known limitations / missing information

- Share API path is undocumented / best-effort and may be unreliable
- Baseline updates currently rely on a caller-supplied confirmation flag — treat compromised clients carefully
- Schema may seed placeholder physiology defaults on empty DB; bootstrap intentionally for real use
- No CI workflows documented in this README
- Health data is sensitive — protect the repo, secrets, remote endpoint, and any clones

## Medical disclaimer

**Assistive tool only — not medical advice and not FDA-approved medical software.**  
You are responsible for all treatment decisions. Consult your clinician before changing insulin or other therapy. Never rely solely on this tool for dosing.

## License

MIT — see [`LICENSE`](LICENSE).
