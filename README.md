# Dexcom MCP Server

A Model Context Protocol (MCP) server that connects Claude to your personal Dexcom CGM (Continuous Glucose Monitor) for assistive diabetes management intelligence.

## 🎯 Prime Directive

This is a **human-in-the-loop assistive intelligence system**:

- ✅ Claude analyzes, reasons, and recommends
- ✅ User decides and acts
- ❌ No automation, no control, no silent changes

## 🚀 Features

- **Real-time CGM Data**: Fetch current and historical glucose readings
- **Trend Analysis**: Analyze patterns, post-meal spikes, and overnight stability
- **Event Logging**: Track insulin doses, carbohydrate intake, and exercise
- **Adaptive Modeling**: Learn how your metabolism behaves over time
- **Predictive Intelligence**: Estimate glucose impact of insulin and carbs
- **Visualizations**: Generate charts and AGP (Ambulatory Glucose Profile)
- **Parameter Drift Detection**: Identify when your insulin sensitivity changes

## 📋 Prerequisites

- Node.js 18+
- Dexcom Developer API credentials ([apply here](https://developer.dexcom.com/))
- A Dexcom CGM device actively transmitting data

## 🔧 Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/cykj40/dexcom-mcp-server.git
   cd dexcom-mcp-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and fill in your credentials:
   - `DEXCOM_CLIENT_ID` - From Dexcom Developer Portal
   - `DEXCOM_CLIENT_SECRET` - From Dexcom Developer Portal
   - `DEXCOM_REDIRECT_URI` - OAuth redirect URI
   - `TURSO_DATABASE_URL` - Turso database URL for token and glucose persistence
   - `DEXCOM_ACCESS_TOKEN` / `DEXCOM_REFRESH_TOKEN` - Optional one-time bootstrap only when Turso has no tokens

4. Build the project:
   ```bash
   npm run build
   ```

## 🎮 Usage

### Running the Server Directly

```bash
npm start
```

### Integrating with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dexcom": {
      "command": "node",
      "args": ["/absolute/path/to/dexcom-mcp-server/dist/index.js"],
      "env": {
        "DEXCOM_CLIENT_ID": "your_client_id",
        "DEXCOM_CLIENT_SECRET": "your_client_secret",
        "DEXCOM_REDIRECT_URI": "your_redirect_uri",
        "TURSO_DATABASE_URL": "libsql://your-db.turso.io",
        "TURSO_AUTH_TOKEN": "your_turso_auth_token"
      }
    }
  }
}
```

Restart Claude Desktop, and you'll have access to all Dexcom tools.

## 🛠️ Available Tools

### Glucose Reading Tools
- `get_latest_glucose` - Get current glucose with trend
- `get_glucose_range` - Get readings within a time range
- `get_daily_summary` - Daily glucose statistics
- `get_glucose_statistics` - Comprehensive stats for any period

### Analysis Tools
- `analyze_trends` - Analyze patterns over days/weeks
- `compare_expected_vs_actual` - Compare predictions to reality
- `detect_parameter_drift` - Identify if ISF/ICR has changed

### Event Logging Tools
- `log_insulin` - Log insulin dose
- `log_carbs` - Log carbohydrate intake
- `log_exercise` - Log physical activity
- `get_event_timeline` - View all events with glucose context

### Chart Tools
- `generate_chart` - Create visualizations (timeline, daily, weekly, AGP)

### Modeling Tools
- `get_baseline_parameters` - View your ISF, ICR, and basal dose
- `predict_glucose_impact` - Predict effect of insulin or carbs
- `get_adaptive_insights` - See how predictions compare to reality

## 📊 Database

All data is stored locally in SQLite at `./data/dexcom.db`:

- Glucose readings (from Dexcom API and Share API)
- Insulin, carb, and exercise events
- Adaptive observations (expected vs actual outcomes)

No data is shared with third parties.

## 🔒 Security

- **Environment variables only**: Never hardcode credentials
- **Local storage**: All data stays on your machine
- **OAuth 2.0**: Uses official Dexcom Developer API
- **Read-only device access**: Cannot modify pump settings

## 🏥 Medical Disclaimer

**This is an assistive tool, not medical advice.**

- All recommendations are based on your personal data
- You are the final authority on all diabetes management decisions
- Never rely solely on this tool for treatment decisions
- Consult your healthcare provider before changing insulin doses
- This is not FDA-approved medical software

## 🧪 Development

### Run in Development Mode

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Project Structure

```
dexcom-mcp-server/
├── src/
│   ├── config/         # Environment validation
│   ├── db/             # SQLite database layer
│   ├── services/       # Business logic
│   ├── tools/          # MCP tool definitions
│   ├── types/          # TypeScript types
│   └── index.ts        # Server entrypoint
├── data/               # SQLite database (gitignored)
└── dist/               # Compiled JavaScript
```

## 📝 License

ISC License - See LICENSE file for details

## 🤝 Contributing

This is a personal diabetes management tool. If you'd like to adapt it for your own use:

1. Update baseline parameters in `src/types/index.ts`
2. Adjust target ranges if needed
3. Modify modeling algorithms to match your physiology

## 📧 Support

For issues or questions, please open a GitHub issue.

---

**Remember**: This tool learns from your patterns but never acts autonomously. You decide, you act, you control.
