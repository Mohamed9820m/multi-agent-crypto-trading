# AGENTS.md — Multi-Agent Crypto Trading System

This file contains agent-focused context for working on the codebase.

## Build & Run

```bash
npm install
npm run build       # tsc -> dist/
npm test            # vitest indicator tests
npm run lint        # tsc --noEmit
npm run cycle       # single paper cycle
npm run start:orchestrator   # continuous loop
npm run guardian    # separate Guardian process
npm run report      # daily Markdown report
```

## Environment

Copy `.env.example` to `.env` and set real values. In `.env`:

- `BINANCE_USE_TESTNET=true` is the safe default.
- `TRADING_MODE=paper` simulates fills without any trading API calls.
- `DATABASE_URL` and `REDIS_URL` must be valid connection strings.
- `MAX_PORTFOLIO_HEAT_PCT` (default 5.0) caps total open + new risk as a percentage of equity.
- `KELLY_CAP` (default 0.25) clamps the Kelly fraction used for position sizing.
- `EXECUTION_MAX_RETRIES` (default 3) and `EXECUTION_RETRY_DELAY_MS` (default 500) control execution retry behaviour.
- `EXECUTION_HALT_ON_ERROR` (default true) stops the bot if the entry order fails repeatedly.
- `DEX_ENABLED` (default false) activates the hybrid CeFi/DeFi venue router.
- `ETH_PRIVATE_KEY`, `ONEINCH_API_KEY`, `FLASHBOTS_RELAY_URL`, `BLOXROUTE_AUTH_HEADER`, `JITO_AUTH_HEADER` configure on-chain execution and private mempool routing.

## Monitoring Orders

Use the CLI viewer to see balances, open orders, recent orders, and trades on the configured Binance environment:

```bash
npm run view:orders        # default symbol from .env / BTCUSDT
npm run view:orders ETHUSDT
```

Spot Testnet is **API-only** — there is no web trading GUI. `https://testnet.binance.vision` is only for API key generation and docs. This is **not** `demo.binance.com`.

Do not commit `.env` — it is in `.gitignore`.

## Database Schema

See `scripts/init-db.sql`. Core tables:

- `cycle_logs` — full JSON output of every pipeline cycle
- `orders` — every order event with exchange IDs
- `positions` — open/closed positions
- `account_snapshots` — equity curve samples
- `guardian_triggers` — safety halt events
- `strategy_versions` — strategy approvals

## Agent Design Notes

### Orchestrator (`src/agents/orchestrator.ts`)

- Pipeline order is fixed and sequential.
- Hard rules are enforced directly here, not delegated.
- Checks `guardian:kill_switch` in Redis before every cycle.
- Persists a JSON cycle log to `cycle_logs`.
- On data quality gaps/stale flags, stops the cycle and logs the reason.

### Market Data Agent (`src/agents/marketData.ts`)

- Uses Binance REST for candles, depth, and 24h ticker.
- Detects candle gaps, stale data, and low volume.
- Never interpolates missing candles — flags them.

### Market Intelligence Agent (`src/agents/marketIntelligence.ts`)

- Builds a structured `MarketSnapshot` from live market data, regime, microstructure, and technicals.
- Calls the configured LLM (OpenAI-compatible) for a directional verdict, key risks, invalidation conditions, and trade stance (`aggressive` / `neutral` / `defensive` / `no_trade`).
- Falls back to a rules-based local synthesis if the LLM is unavailable.
- Output feeds all BMAD strategy agents and is persisted in the cycle log.

### Technical Analysis Agent (`src/agents/technicalAnalysis.ts`)

- Computes only the indicators required by the active strategy (plus a few extras for bias/conflict detection).
- All indicator math is in `src/shared/indicators.ts`.
- Outputs raw value + interpretation per indicator.

### Sentiment & News Agent (`src/agents/sentiment.ts`)

- Currently a stub returning neutral (0).
- Designed to accept a timeout and fall back to neutral on failure.
- Does not have veto power — only informs Strategy Fusion.

### Strategy Fusion Agent (`src/agents/strategyFusion.ts`)

- Uses exactly one active strategy from `src/strategies/playbook.ts`.
- Sentiment is a filter/confirmation, not a primary trigger.
- Returns `no_trade` when conditions are not met.

### Risk Manager Agent (`src/agents/riskManager.ts`)

- Has explicit veto power.
- Enforces daily loss circuit breaker, daily trade limit, min confidence, max positions, min R:R, min notional, and available cash.
- Uses capped-Kelly position sizing: `f* = (p*b - q) / b`, clamped to `KELLY_CAP` (default 0.25), then multiplied by the base risk-per-trade amount.
- Enforces a portfolio heat limit (`MAX_PORTFOLIO_HEAT_PCT`, default 5%): total open risk + new trade risk must fit under the cap; resizes if necessary.
- Position sizing uses EUR equity; assumes 1 USDT ≈ 1 EUR for simplicity. Improve this if you trade non-USDT pairs.

### Execution Agent (`src/agents/execution.ts`) + Hybrid Venue Router (`src/execution/`)

- Only agent that places orders.
- In `paper` mode, simulates fills.
- In `testnet`/`live`, defaults to patient LIMIT orders; only falls back to MARKET when the execution planner detects urgency or a wide spread.
- LIMIT and MARKET entry orders are polled for fills after submission; unfilled LIMIT slices are cancelled after a timeout to avoid orphan working orders.
- Spot child orders use `STOP_LOSS_LIMIT` / `TAKE_PROFIT_LIMIT`. USD-M futures conditional orders are placed via `/fapi/v1/algoOrder` (`algoType=CONDITIONAL`) because the regular futures order endpoint rejects raw `STOP`/`TAKE_PROFIT` types on testnet/live.
- Prices and quantities are rounded to the exchange's `tickSize` / `stepSize` rather than the reported precision, which avoids "Price not increased by tick size" errors on futures.
- Retries failed API calls with exponential backoff (`EXECUTION_MAX_RETRIES`, `EXECUTION_RETRY_DELAY_MS`).
- Halts trading (`EXECUTION_HALT_ON_ERROR`) and sets the Guardian kill switch if the entry order fails repeatedly, preventing orphan risk.
- **Hybrid CeFi / DeFi router** (`DEX_ENABLED=true`) quotes both Binance and 1inch, scores cost + latency + confidence, and selects the cheaper venue. DEX swaps are simulated in `paper` mode; live submission requires `ETH_PRIVATE_KEY` and is currently gated behind a safety stub.
- `LatencyMonitor` tracks venue round-trip times for routing decisions.
- `MempoolWatcher` provides the interface for Flashbots / bloXroute / Jito mempool interception; it returns a safe fallback when none are configured.
- Never modifies risk parameters from Risk Manager.

### Research AI / CLAWBOT (`src/agents/researchAI.ts` & `src/agents/clawbot.ts`)

- `CLAWBOT_MODE=internal` (default) activates the built-in CLAWBOT agent.
- CLAWBOT gathers live market data, CoinGecko metrics, Fear & Greed index, cointegrated pairs, crypto news (CoinTelegraph RSS), and forum sentiment (Reddit), then synthesises everything through the configured LLM.
- `CLAWBOT_MODE=url` POSTs the research payload to an external `CLAWBOT_URL` endpoint.
- `CLAWBOT_MODE=off` disables CLAWBOT and falls back to the simpler OpenAI/local research synthesis.
- This agent NEVER executes trades directly. It returns intelligence only.

### Guardian Agent (`src/agents/guardian.ts`)

- Runs as a separate process.
- Uses Redis `guardian:kill_switch` to halt the Orchestrator.
- On trigger, cancels all open orders and requires manual re-enable (delete the Redis key).
- In production, give this a separate API key with read + cancel permissions only.

### Reporting Agent (`src/agents/reporting.ts`)

- Pulls from the trade journal only.
- Flags small sample sizes and Guardian triggers.
- No editorializing or future-performance promises.

### Backtesting Agent (`src/agents/backtesting.ts`)

- Walk-forward testing with rolling train/test windows.
- Requires >= 30 trades for statistical significance.
- Gatekeeper for strategy changes.

### Regime Detection Agent (`src/agents/regimeDetection.ts`)

- Computes ADX(14) (+DI/−DI), Hurst exponent (R/S method), variance-ratio tie-breaker, and ATR percentile.
- Produces a strategic regime classification: `STRONG_TREND`, `BUILDING_TREND`, `CLEAN_RANGE`, `CHOPPY_VOLATILE`, `RANDOM_WALK`.
- Preserves legacy probabilistic regimes (TREND_UP, RANGE, etc.) for downstream consumers.
- All metrics are persisted in `cycle_logs` under `specialistAnalysis.regime`.

### Market Microstructure Agent (`src/agents/marketMicrostructure.ts`)

- Analyzes orderbook imbalance, depth imbalance, spread, liquidity score.
- Computes volume delta / cumulative delta from recent candles.
- Estimates order-flow imbalance, absorption, sweep, and replenishment scores.

### Strategy Selector Agent (`src/agents/strategySelector.ts`)

- Evaluates all 12 registered strategies every cycle.
- Scores each candidate with:
  - `RegimeFit` against the strategic regime matrix (hard veto = 0 for real mismatches).
  - `RecentPerformance` from closed `positions` (win rate, Sharpe, Kelly fraction).
  - `SignalConfidence` from the strategy's own signal strength.
  - `CorrelationPenalty` for simultaneous same-direction bets.
  - `SwitchingCost` hysteresis requiring 2+ confirmed regime cycles before abandoning the incumbent.
- Outputs capital-weighted allocations across the top-N non-vetoed strategies, ramped over cycles.
- Persists allocations in `cycle_logs` under `strategyAllocations`.
- The top-weighted candidate is passed to Risk Manager / Execution; full multi-strategy execution is not yet implemented.

### Red Team Agent (`src/agents/redTeam.ts`)

- Adversarial challenge of every selected candidate.
- Attacks data quality, regime mismatch, costs, liquidity, overconfidence, expected value.
- Can recommend proceed, caution, or reject.

### Portfolio Manager Agent (`src/agents/portfolioManager.ts`)

- Tracks gross/net/long/short exposure by symbol and strategy.
- Enforces concentration and gross-exposure limits.
- Feeds portfolio-fit score into strategy selection.

### Trade Monitor Agent (`src/agents/tradeMonitor.ts`)

- Monitors open positions for distance to stop/target, unrealized PnL, thesis validity.
- Recommended actions: hold, reduce, exit, take partial, move stop.

### Post-Trade Forensics Agent (`src/agents/postTradeForensics.ts`)

- After a trade closes, classifies the loss/profit type.
- Distinguishes good loss, bad loss, execution failure, model failure, news invalidation.
- Records lessons for research memory.

### Expected-Value Engine (`src/shared/expectedValue.ts`)

- Estimates execution costs (fees, spread, slippage, funding).
- Computes win probability, expectancy, profit factor, expected value.
- Penalizes low liquidity, high costs, and poor data quality.

## Adding a New Strategy

1. Create `src/strategies/myStrategy.ts` implementing the `Strategy` interface.
2. Add it to `strategyRegistry` in `src/strategies/playbook.ts`.
3. Add required indicator names to `requiredIndicatorsByStrategy` in `src/agents/technicalAnalysis.ts`.
4. Backtest before live.

## Adding a New Indicator

1. Add the pure function to `src/shared/indicators.ts`.
2. Add an `IndicatorConfig` entry in `src/agents/technicalAnalysis.ts`.
3. Reference it in strategy code by name.

## Safety Checklist Before Live

- [ ] Strategy passed walk-forward backtest.
- [ ] Strategy ran paper/testnet for defined period.
- [ ] Binance API key has no withdrawal permission.
- [ ] IP-whitelist is configured.
- [ ] Guardian process is running on separate credentials.
- [ ] Daily loss limit, equity floor, and max-trade limits are set.
- [ ] Starting capital is set correctly in `src/shared/accountState.ts` fallback or Binance account.
