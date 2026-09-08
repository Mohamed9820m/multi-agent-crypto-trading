# Multi-Agent Crypto Trading System

A testnet-first, multi-agent cryptocurrency trading system for Binance. Built to the spec in the user's design document: independent agents, hard risk rules, audit journal, and a separate Guardian watchdog.

> **Warning:** This project starts in `paper` mode by default and uses Binance Testnet. Do not enable `live` mode or real API keys until you have completed backtesting, paper trading, and you fully understand the risks.

## Architecture

| Agent | Role |
|-------|------|
| Orchestrator | Runs the fixed pipeline, enforces hard rules, writes the cycle audit log |
| Market Data | Fetches OHLCV, order book, 24h ticker from Binance REST |
| Technical Analysis | Computes indicators required by the active strategy |
| Sentiment & News | Returns neutral stub (ready for news/social/on-chain APIs) |
| Strategy Fusion | Applies exactly one active strategy from the playbook |
| Risk Manager | Circuit breaker, position sizing, min R:R, max exposure |
| Execution | Places/mocks orders and logs fills |
| Backtesting | Walk-forward validation before a strategy goes live |
| Reporting | Daily Markdown report from the trade journal |
| Guardian | Independent watchdog process with kill switch |

## Tech Stack

- Node.js 20+ / TypeScript
- Binance REST API (testnet by default)
- PostgreSQL trade journal
- Redis pub/sub for kill switch / inter-agent messages
- Docker Compose (optional) for Postgres + Redis

## Quick Start

1. **Install dependencies**

```bash
cd 07_MultiAgent_Crypto
npm install
```

2. **Set up PostgreSQL and Redis**

If you have Docker:

```bash
cp .env.example .env
# edit .env with your Binance testnet keys if you want testnet trading
npm run db:init
```

Or use a local Postgres/Redis and update `.env` accordingly.

3. **Configure environment**

```bash
cp .env.example .env
# Edit .env — at minimum set BINANCE_API_KEY / BINANCE_API_SECRET for testnet,
# or leave them as placeholders for pure paper mode.
```

4. **Run tests**

```bash
npm test
npm run lint
```

5. **Run a single paper trading cycle**

```bash
npm run cycle
```

6. **Run the orchestrator loop**

```bash
npm run start:orchestrator
```

7. **Run the Guardian watchdog (separate terminal)**

```bash
npm run guardian
```

8. **Generate the daily report**

```bash
npm run report
```

## Monitoring Your Orders

When `TRADING_MODE=testnet`, orders are placed on **Binance Spot Testnet**.

**Important:** Binance Spot Testnet is **API-only** — there is no web trading GUI. To see your orders, use the CLI viewer:

```bash
npm run view:orders        # defaults to BTCUSDT
npm run view:orders ETHUSDT
```

This prints balances, open orders, recent orders, and recent trades.

**Important:** The following are **not** the same environment:

- `https://testnet.binance.vision` — Spot Testnet API key portal / docs (not a trading GUI).
- `https://demo.binance.com` — a manual demo UI; trades here are invisible to the bot and vice versa.
- `https://www.binance.com` — live real-money trading.

If you cannot see the bot's orders, run `npm run view:orders`. That queries the same API endpoint the bot uses.

## Trading Modes

| Mode | Description |
|------|-------------|
| `paper` | Simulates fills locally, does not call Binance trading endpoints |
| `testnet` | Places orders on Binance Testnet (fake funds) |
| `live`  | Places real orders on Binance — only enable after extensive validation |

Set `TRADING_MODE` in `.env`.

## Starting Capital

The default starting capital is **50 EUR** (set in `src/shared/accountState.ts`). This is used as a fallback when the Binance account endpoint cannot be reached in paper/testnet mode.

## Strategies

Only one strategy is active per symbol/timeframe. The default is `trendFollowing` on `BTCUSDT` 1h.

Implemented strategies:

- `trendFollowing` — EMA crossover + ADX confirmation, ATR-based stop
- `meanReversion` — RSI / Bollinger bands in ranging markets
- `momentumBreakout` — Bollinger/Keltner squeeze + volume spike

Stub strategies (require additional config): grid, DCA, arbitrage, market making.

## Risk Rules

- Max risk per trade: `RISK_PER_TRADE_PCT` (default 1%)
- Hard daily loss limit: `MAX_DAILY_LOSS_PCT` (default 3%)
- Minimum signal confidence: `MIN_CONFIDENCE` (default 60)
- Minimum risk/reward: `MIN_RISK_REWARD` (default 1.5)
- Max concurrent positions: `MAX_CONCURRENT_POSITIONS` (default 2)
- Max trades per day (Guardian): `MAX_TRADES_PER_DAY` (default 10)
- Account equity floor (Guardian): `ACCOUNT_EQUITY_FLOOR_EUR` (default 25)

## Project Structure

```
07_MultiAgent_Crypto/
├── src/
│   ├── agents/           # All 10 agents
│   ├── shared/           # Config, DB, Redis, Binance client, indicators
│   ├── strategies/       # Strategy playbook and implementations
│   └── index.ts          # Orchestrator entry point
├── scripts/              # Runner scripts and SQL init
├── tests/                # Indicator unit tests
├── docker-compose.yml
├── .env.example
└── README.md
```

## API Key Permissions

For the Execution Agent / main pipeline:
- Reading
- Spot/Futures Trading

**Never** enable Withdrawal permission.

For the Guardian Agent (architecturally separate process, ideally separate key):
- Reading
- Cancel open orders only

## Backtesting

Run walk-forward validation before changing strategies or parameters:

```bash
# Backtest code is in src/agents/backtesting.ts — add a CLI runner to invoke it.
```

A strategy change must pass backtesting and a minimum paper-trading period before live capital is risked.

## License

MIT
