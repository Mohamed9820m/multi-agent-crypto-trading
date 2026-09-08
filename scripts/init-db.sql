-- Trade journal and configuration tables for the multi-agent system.

CREATE TABLE IF NOT EXISTS cycle_logs (
  id SERIAL PRIMARY KEY,
  cycle_id UUID NOT NULL UNIQUE,
  symbol VARCHAR(20) NOT NULL,
  timeframe VARCHAR(10) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  orchestrator_output JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cycle_logs_symbol_time ON cycle_logs(symbol, timeframe, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cycle_logs_cycle_id ON cycle_logs(cycle_id);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_id UUID NOT NULL UNIQUE,
  cycle_id UUID,
  symbol VARCHAR(20) NOT NULL,
  side VARCHAR(10) NOT NULL,          -- BUY / SELL
  type VARCHAR(20) NOT NULL,          -- LIMIT / MARKET / STOP_LOSS / TAKE_PROFIT
  quantity NUMERIC(36, 18) NOT NULL,
  price NUMERIC(36, 18),
  stop_price NUMERIC(36, 18),
  status VARCHAR(20) NOT NULL,        -- submitted / filled / partial / cancelled / rejected
  exchange_order_id VARCHAR(64),
  fill_price NUMERIC(36, 18),
  fill_qty NUMERIC(36, 18),
  fee NUMERIC(36, 18),
  fee_asset VARCHAR(10),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_response JSONB
);

CREATE INDEX IF NOT EXISTS idx_orders_symbol_time ON orders(symbol, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_orders_cycle_id ON orders(cycle_id);

CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  position_id UUID NOT NULL UNIQUE,
  symbol VARCHAR(20) NOT NULL,
  strategy VARCHAR(64),
  side VARCHAR(10) NOT NULL,          -- LONG / SHORT
  entry_price NUMERIC(36, 18) NOT NULL,
  quantity NUMERIC(36, 18) NOT NULL,
  stop_loss NUMERIC(36, 18),
  take_profit NUMERIC(36, 18),
  realized_pnl NUMERIC(36, 18) DEFAULT 0,
  unrealized_pnl NUMERIC(36, 18) DEFAULT 0,
  status VARCHAR(20) NOT NULL,        -- open / closed
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_positions_symbol_status ON positions(symbol, status);

-- Migration for existing databases
ALTER TABLE positions ADD COLUMN IF NOT EXISTS strategy VARCHAR(64);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS state VARCHAR(32) DEFAULT 'OPEN';

CREATE TABLE IF NOT EXISTS position_state_history (
  id SERIAL PRIMARY KEY,
  position_id UUID NOT NULL REFERENCES positions(position_id) ON DELETE CASCADE,
  from_state VARCHAR(32),
  to_state VARCHAR(32) NOT NULL,
  reason VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_position_state_history_position_id ON position_state_history(position_id);

CREATE TABLE IF NOT EXISTS features (
  id SERIAL PRIMARY KEY,
  cycle_id UUID,
  symbol VARCHAR(20) NOT NULL,
  features JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_features_symbol_time ON features(symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS ml_models (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  label VARCHAR(10) NOT NULL, -- long / short
  weights JSONB NOT NULL,
  bias NUMERIC(36, 18) NOT NULL,
  feature_mean JSONB NOT NULL,
  feature_std JSONB NOT NULL,
  accuracy NUMERIC(5, 4) NOT NULL,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(symbol, label)
);

CREATE INDEX IF NOT EXISTS idx_ml_models_symbol_label ON ml_models(symbol, label);

CREATE TABLE IF NOT EXISTS strategy_lifecycle (
  id SERIAL PRIMARY KEY,
  strategy_name VARCHAR(64) NOT NULL,
  version VARCHAR(32) NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'IDEA',
  capital_allocation_pct NUMERIC(5, 2) DEFAULT 0,
  live_trades INTEGER DEFAULT 0,
  live_win_rate NUMERIC(5, 4) DEFAULT 0,
  live_expectancy NUMERIC(10, 4) DEFAULT 0,
  max_drawdown_pct NUMERIC(10, 4) DEFAULT 0,
  deployed_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(strategy_name, version)
);

CREATE INDEX IF NOT EXISTS idx_strategy_lifecycle_state ON strategy_lifecycle(state);

CREATE TABLE IF NOT EXISTS account_snapshots (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  equity_eur NUMERIC(36, 18) NOT NULL,
  cash_eur NUMERIC(36, 18) NOT NULL,
  open_exposure_eur NUMERIC(36, 18) NOT NULL,
  daily_realized_pnl_eur NUMERIC(36, 18) NOT NULL,
  trades_today INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_account_snapshots_time ON account_snapshots(timestamp DESC);

CREATE TABLE IF NOT EXISTS guardian_triggers (
  id SERIAL PRIMARY KEY,
  trigger_type VARCHAR(64) NOT NULL,
  message TEXT NOT NULL,
  account_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guardian_triggers_time ON guardian_triggers(created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id SERIAL PRIMARY KEY,
  strategy_name VARCHAR(64) NOT NULL,
  version VARCHAR(32) NOT NULL,
  params JSONB NOT NULL,
  backtest_result JSONB,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(strategy_name, version)
);

CREATE TABLE IF NOT EXISTS research_memory (
  id SERIAL PRIMARY KEY,
  item_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  item_type VARCHAR(32) NOT NULL,        -- strategy, hypothesis, feature, backtest, postmortem, news, regime, lesson
  source VARCHAR(64) NOT NULL,           -- agent name or external source
  title VARCHAR(255) NOT NULL,
  content TEXT,
  symbol VARCHAR(20),
  strategy VARCHAR(64),
  regime VARCHAR(32),
  confidence NUMERIC(5, 4) DEFAULT 0.5,
  context JSONB,
  validation_status VARCHAR(32) DEFAULT 'unvalidated', -- unvalidated, validated, rejected, deprecated
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_memory_type ON research_memory(item_type);
CREATE INDEX IF NOT EXISTS idx_research_memory_strategy ON research_memory(strategy);
CREATE INDEX IF NOT EXISTS idx_research_memory_symbol ON research_memory(symbol);
CREATE INDEX IF NOT EXISTS idx_research_memory_status ON research_memory(validation_status);
