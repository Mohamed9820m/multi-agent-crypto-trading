import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function getString(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getNumber(key: string, fallback?: number): number {
  const value = process.env[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid number for ${key}: ${value}`);
  return parsed;
}

function getBool(key: string, fallback?: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.toLowerCase() === 'true';
}

export const config = {
  // Binance
  binanceApiKey: getString('BINANCE_API_KEY'),
  binanceApiSecret: getString('BINANCE_API_SECRET'),
  useTestnet: getBool('BINANCE_USE_TESTNET', true),

  // Database
  databaseUrl: getString('DATABASE_URL'),

  // Redis
  redisUrl: getString('REDIS_URL'),

  // Trading
  symbol: getString('TRADING_SYMBOL', 'BTCUSDT'),
  timeframe: getString('TRADING_TIMEFRAME', '1h'),
  tradingMode: getString('TRADING_MODE', 'paper') as 'paper' | 'testnet' | 'live',
  cycleIntervalMs: getNumber('CYCLE_INTERVAL_MS', 300000),

  // Risk
  maxDailyLossPct: getNumber('MAX_DAILY_LOSS_PCT', 3.0),
  riskPerTradePct: getNumber('RISK_PER_TRADE_PCT', 1.0),
  minConfidence: getNumber('MIN_CONFIDENCE', 60),
  minRiskReward: getNumber('MIN_RISK_REWARD', 1.5),
  maxConcurrentPositions: getNumber('MAX_CONCURRENT_POSITIONS', 2),
  maxCorrelationCap: getNumber('MAX_CORRELATION_CAP', 0.8),
  accountEquityFloorEUR: getNumber('ACCOUNT_EQUITY_FLOOR_EUR', 25),
  maxTradesPerDay: getNumber('MAX_TRADES_PER_DAY', 10),
  maxPortfolioHeatPct: getNumber('MAX_PORTFOLIO_HEAT_PCT', 5.0),
  kellyCap: getNumber('KELLY_CAP', 0.25),
  kellyMinEdge: getNumber('KELLY_MIN_EDGE', 0.001),

  // Strategy
  activeStrategy: getString('ACTIVE_STRATEGY', 'trendFollowing'),

  // Futures
  useFutures: getBool('USE_FUTURES', false),
  maxLeverage: getNumber('MAX_LEVERAGE', 2),

  // Capital
  startingCapitalEUR: getNumber('STARTING_CAPITAL_EUR', 50),

  // Execution
  executionMaxRetries: getNumber('EXECUTION_MAX_RETRIES', 3),
  executionRetryDelayMs: getNumber('EXECUTION_RETRY_DELAY_MS', 500),
  executionHaltOnError: getBool('EXECUTION_HALT_ON_ERROR', true),

  // Logging
  logLevel: getString('LOG_LEVEL', 'info'),

  // External AI / CLAWBOT research integration
  openaiApiKey: getString('OPENAI_API_KEY', ''),
  openaiBaseUrl: getString('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  openaiModel: getString('OPENAI_MODEL', 'gpt-4o-mini'),
  clawbotUrl: getString('CLAWBOT_URL', ''),
  clawbotApiKey: getString('CLAWBOT_API_KEY', ''),
  clawbotMode: getString('CLAWBOT_MODE', 'internal') as 'internal' | 'url' | 'off',

  // On-chain / institutional data sources
  ethRpcUrl: getString('ETH_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
  goplusEnabled: getBool('GOPLUS_ENABLED', true),
  tenderlyAccount: getString('TENDERLY_ACCOUNT', ''),
  tenderlyProject: getString('TENDERLY_PROJECT', ''),
  tenderlyApiKey: getString('TENDERLY_API_KEY', ''),
  coinglassApiKey: getString('COINGLASS_API_KEY', ''),
  arkhamApiKey: getString('ARKHAM_API_KEY', ''),
  bubblemapsApiKey: getString('BUBBLEMAPS_API_KEY', ''),

  // Hybrid CeFi / DeFi execution
  dexEnabled: getBool('DEX_ENABLED', false),
  ethPrivateKey: getString('ETH_PRIVATE_KEY', ''),
  oneinchApiKey: getString('ONEINCH_API_KEY', ''),
  flashbotsRelayUrl: getString('FLASHBOTS_RELAY_URL', 'https://relay.flashbots.net'),
  bloxrouteAuthHeader: getString('BLOXROUTE_AUTH_HEADER', ''),
  jitoAuthHeader: getString('JITO_AUTH_HEADER', ''),
};

export default config;
