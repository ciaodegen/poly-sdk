/**
 * SnipeService Types
 *
 * Market kapanisina yakin fiyat hareketi yakalamak icin type tanimlari.
 *
 * Strateji:
 * - Market kapanisina 5 dakika kala aktif ol
 * - Entry: YES token fiyati 0.95'e dusunce al
 * - Take Profit: Fiyat 0.99'a cikinca sat
 * - Stop Loss: Fiyat 0.90'a dusunce sat
 * - Reward: Islem sonrasi 2 dk bekle, reward tracking yap
 */

// ============= Configuration =============

/**
 * SnipeService configuration
 *
 * Fiyatlar 0-100 (cent) formatinda:
 * - 95 = 0.95 USDC = %95 ihtimal
 * - 99 = 0.99 USDC = %99 ihtimal
 */
export interface SnipeServiceConfig {
  /**
   * Minutes before market close to activate
   * @default 5
   */
  minutesBeforeClose?: number;

  /**
   * Entry price threshold in cents (buy when price <= this)
   * Hangi tarafta (YES/NO) bu fiyata duserse o taraf alinir
   * @default 95 (95 cent)
   */
  entryPrice?: number;

  /**
   * Take profit price in cents (sell when price >= this)
   * @default 99 (99 cent)
   */
  takeProfitPrice?: number;

  /**
   * Stop loss price in cents (sell when price <= this)
   * @default 91 (91 cent)
   */
  stopLossPrice?: number;

  /**
   * Position size in USDC
   * @default 10
   */
  positionSize?: number;

  /**
   * Minutes to wait after exit before tracking rewards
   * @default 2
   */
  rewardTrackDelayMinutes?: number;

  /**
   * Maximum slippage for orders
   * @default 0.02
   */
  maxSlippage?: number;

  /**
   * Auto execute trades on signals
   * @default false
   */
  autoExecute?: boolean;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Custom log handler
   */
  logHandler?: (message: string) => void;
}

/**
 * Internal config type with all required fields
 */
export type SnipeConfigInternal = Required<Omit<SnipeServiceConfig, 'logHandler'>> & {
  logHandler?: (message: string) => void;
};

/**
 * Default configuration
 *
 * Fiyatlar cent (0-100) formatinda
 */
export const DEFAULT_SNIPE_CONFIG: SnipeConfigInternal = {
  minutesBeforeClose: 5,
  entryPrice: 95,        // 95 cent - bu fiyata dusunce al
  takeProfitPrice: 99,   // 99 cent - bu fiyata cikinca sat (kar al)
  stopLossPrice: 91,     // 91 cent - bu fiyata duserse sat (stop loss)
  positionSize: 10,
  rewardTrackDelayMinutes: 2,
  maxSlippage: 2,        // 2 cent slippage
  autoExecute: false,
  debug: false,
};

// ============= State Machine =============

/**
 * Trade state machine phases
 *
 * Flow:
 * waiting_for_window → waiting_for_entry → position_open →
 *   → exit_take_profit/exit_stop_loss → tracking_rewards → completed
 */
export type SnipePhase =
  | 'waiting_for_window'   // Waiting for 5-min window to open
  | 'waiting_for_entry'    // Window open, waiting for entry price
  | 'position_open'        // Position opened, monitoring for exit
  | 'exit_take_profit'     // Exited with take profit
  | 'exit_stop_loss'       // Exited with stop loss
  | 'exit_market_close'    // Exited due to market close
  | 'tracking_rewards'     // Waiting to track rewards
  | 'completed';           // Trade cycle complete

// ============= Market Configuration =============

/**
 * Market configuration for sniping
 */
export interface SnipeMarketConfig {
  /** Market name (for logging) */
  name: string;
  /** Market slug */
  slug: string;
  /** Condition ID */
  conditionId: string;
  /** YES token ID */
  yesTokenId: string;
  /** NO token ID */
  noTokenId: string;
  /** Market end time */
  endTime: Date;
}

/** Token side for entry/exit */
export type SnipeTokenSide = 'YES' | 'NO';

// ============= Trade State =============

/**
 * Position info
 */
export interface SnipePositionInfo {
  /** Which token was bought (YES or NO) */
  side: SnipeTokenSide;
  /** Entry price */
  entryPrice: number;
  /** Entry size in shares */
  shares: number;
  /** Entry timestamp */
  entryTimestamp: number;
  /** Token ID that was bought */
  tokenId: string;
  /** Order ID */
  orderId?: string;
}

/**
 * Exit info
 */
export interface SnipeExitInfo {
  /** Exit price */
  exitPrice: number;
  /** Exit shares */
  shares: number;
  /** Exit timestamp */
  exitTimestamp: number;
  /** Exit reason */
  reason: 'take_profit' | 'stop_loss' | 'market_close';
  /** Order ID */
  orderId?: string;
}

/**
 * Trade state
 */
export interface SnipeTradeState {
  /** Trade ID */
  tradeId: string;
  /** Current phase */
  phase: SnipePhase;
  /** Market config */
  market: SnipeMarketConfig;
  /** Window open time */
  windowOpenTime?: number;
  /** Position info (if opened) */
  position?: SnipePositionInfo;
  /** Exit info (if exited) */
  exit?: SnipeExitInfo;
  /** Realized PnL */
  realizedPnL?: number;
  /** Rewards info */
  rewards?: SnipeRewardsInfo;
}

// ============= Signals =============

/**
 * Entry signal - emitted when price hits entry threshold
 * Triggers when YES or NO price <= entryPrice (0.95)
 */
export interface SnipeEntrySignal {
  type: 'entry';
  /** Trade ID */
  tradeId: string;
  /** Market condition ID */
  conditionId: string;
  /** Which token triggered entry (YES or NO) */
  side: SnipeTokenSide;
  /** Current price (best ask) of the triggering token */
  currentPrice: number;
  /** Target entry price with slippage */
  targetPrice: number;
  /** Shares to buy */
  shares: number;
  /** Token ID to buy */
  tokenId: string;
  /** Minutes until market close */
  minutesUntilClose: number;
}

/**
 * Exit signal - emitted when exit conditions are met
 */
export interface SnipeExitSignal {
  type: 'exit';
  /** Trade ID */
  tradeId: string;
  /** Market condition ID */
  conditionId: string;
  /** Which token is being sold (YES or NO) */
  side: SnipeTokenSide;
  /** Exit reason */
  reason: 'take_profit' | 'stop_loss' | 'market_close';
  /** Current price (best bid) of the token being sold */
  currentPrice: number;
  /** Target exit price with slippage */
  targetPrice: number;
  /** Shares to sell */
  shares: number;
  /** Token ID to sell */
  tokenId: string;
  /** Entry price */
  entryPrice: number;
  /** Expected PnL */
  expectedPnL: number;
  /** Expected PnL percent */
  expectedPnLPercent: number;
}

/** Signal type union */
export type SnipeSignal = SnipeEntrySignal | SnipeExitSignal;

// ============= Execution Results =============

/**
 * Execution result
 */
export interface SnipeExecutionResult {
  /** Success flag */
  success: boolean;
  /** Action type */
  action: 'entry' | 'exit';
  /** Trade ID */
  tradeId: string;
  /** Executed price */
  price?: number;
  /** Executed shares */
  shares?: number;
  /** Order ID */
  orderId?: string;
  /** Error message */
  error?: string;
  /** Execution time in ms */
  executionTimeMs: number;
}

/**
 * Trade completion result
 */
export interface SnipeTradeResult {
  /** Trade ID */
  tradeId: string;
  /** Final status */
  status: 'completed' | 'cancelled' | 'failed';
  /** Market info */
  market: SnipeMarketConfig;
  /** Entry info */
  entry?: SnipePositionInfo;
  /** Exit info */
  exit?: SnipeExitInfo;
  /** Realized PnL in USDC */
  realizedPnL?: number;
  /** PnL percent */
  pnlPercent?: number;
  /** Rewards tracked */
  rewards?: SnipeRewardsInfo;
}

// ============= Rewards =============

/**
 * Rewards info
 */
export interface SnipeRewardsInfo {
  /** Orders scoring status */
  ordersScoring: Record<string, boolean>;
  /** Daily earnings */
  dailyEarnings: number;
  /** Tracked at timestamp */
  trackedAt: number;
}

// ============= Statistics =============

/**
 * Service statistics
 */
export interface SnipeStats {
  /** Service start time */
  startTime: number;
  /** Total running time in ms */
  runningTimeMs: number;
  /** Markets monitored */
  marketsMonitored: number;
  /** Trades attempted */
  tradesAttempted: number;
  /** Trades completed */
  tradesCompleted: number;
  /** Winning trades (PnL > 0) */
  tradesWon: number;
  /** Losing trades (PnL < 0) */
  tradesLost: number;
  /** Total PnL */
  totalPnL: number;
  /** Total rewards earned */
  totalRewards: number;
  /** Win rate */
  winRate: number;
  /** Average PnL per trade */
  avgPnL: number;
  /** Current trade info */
  currentTrade?: {
    tradeId: string;
    phase: SnipePhase;
    market: string;
    position?: { entryPrice: number; shares: number };
  };
}

// ============= Events =============

/**
 * Window opened event
 */
export interface SnipeWindowOpenEvent {
  /** Trade ID */
  tradeId: string;
  /** Market config */
  market: SnipeMarketConfig;
  /** Minutes until close */
  minutesUntilClose: number;
  /** Current YES price */
  currentPrice: number;
}

/**
 * Rewards tracked event
 */
export interface SnipeRewardsTrackedEvent {
  /** Trade ID */
  tradeId: string;
  /** Rewards info */
  rewards: SnipeRewardsInfo;
}

/**
 * Service events
 */
export interface SnipeServiceEvents {
  started: (market: SnipeMarketConfig) => void;
  stopped: () => void;
  windowOpen: (event: SnipeWindowOpenEvent) => void;
  signal: (signal: SnipeSignal) => void;
  execution: (result: SnipeExecutionResult) => void;
  tradeComplete: (result: SnipeTradeResult) => void;
  rewardsTracked: (event: SnipeRewardsTrackedEvent) => void;
  error: (error: Error) => void;
}

// ============= Scan Options =============

/**
 * Market scan options
 */
export interface SnipeScanOptions {
  /** Minimum minutes until market end */
  minMinutesUntilEnd?: number;
  /** Maximum minutes until market end */
  maxMinutesUntilEnd?: number;
  /** Limit number of results */
  limit?: number;
}

// ============= Helper Functions =============

/**
 * Create initial statistics
 */
export function createSnipeInitialStats(): SnipeStats {
  return {
    startTime: Date.now(),
    runningTimeMs: 0,
    marketsMonitored: 0,
    tradesAttempted: 0,
    tradesCompleted: 0,
    tradesWon: 0,
    tradesLost: 0,
    totalPnL: 0,
    totalRewards: 0,
    winRate: 0,
    avgPnL: 0,
  };
}

/**
 * Create new trade state
 */
export function createSnipeTradeState(
  tradeId: string,
  market: SnipeMarketConfig
): SnipeTradeState {
  return {
    tradeId,
    phase: 'waiting_for_window',
    market,
  };
}

/**
 * Type guard: is entry signal
 */
export function isSnipeEntrySignal(signal: SnipeSignal): signal is SnipeEntrySignal {
  return signal.type === 'entry';
}

/**
 * Type guard: is exit signal
 */
export function isSnipeExitSignal(signal: SnipeSignal): signal is SnipeExitSignal {
  return signal.type === 'exit';
}
