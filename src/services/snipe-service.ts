/**
 * SnipeService - Market Close Sniper
 *
 * Market kapanisina yakin fiyat hareketi yakalamak icin servis.
 *
 * Strateji:
 * - Market kapanisina 5 dakika kala aktif ol
 * - Entry: YES token fiyati 0.95'e dusunce al
 * - Take Profit: Fiyat 0.99'a cikinca sat
 * - Stop Loss: Fiyat 0.90'a dusunce sat
 * - Reward: Islem sonrasi 2 dk bekle, reward tracking yap
 *
 * Kullanim:
 * ```typescript
 * const sdk = await PolymarketSDK.create({ privateKey: '0x...' });
 *
 * // Kapanacak marketleri bul
 * const markets = await sdk.snipe.scanMarketsEndingSoon({
 *   minMinutesUntilEnd: 3,
 *   maxMinutesUntilEnd: 10
 * });
 *
 * // Konfigurasyon
 * sdk.snipe.updateConfig({
 *   entryPrice: 0.95,
 *   takeProfitPrice: 0.99,
 *   stopLossPrice: 0.90,
 *   autoExecute: true,
 *   debug: true
 * });
 *
 * // Event dinle
 * sdk.snipe.on('signal', (s) => console.log('Signal:', s));
 * sdk.snipe.on('execution', (r) => console.log('Executed:', r));
 * sdk.snipe.on('rewardsTracked', (r) => console.log('Rewards:', r));
 *
 * // Basla
 * await sdk.snipe.start(markets[0]);
 * ```
 */

import { EventEmitter } from 'events';
import {
  RealtimeServiceV2,
  type MarketSubscription,
  type OrderbookSnapshot,
} from './realtime-service-v2.js';
import { TradingService, type MarketOrderParams } from './trading-service.js';
import { MarketService } from './market-service.js';
import type { Side } from '../core/types.js';
import {
  type SnipeServiceConfig,
  type SnipeConfigInternal,
  type SnipeMarketConfig,
  type SnipeTradeState,
  type SnipeStats,
  type SnipeSignal,
  type SnipeEntrySignal,
  type SnipeExitSignal,
  type SnipeExecutionResult,
  type SnipeTradeResult,
  type SnipeWindowOpenEvent,
  type SnipeRewardsTrackedEvent,
  type SnipeScanOptions,
  type SnipePhase,
  type SnipeRewardsInfo,
  type SnipeTokenSide,
  DEFAULT_SNIPE_CONFIG,
  createSnipeInitialStats,
  createSnipeTradeState,
  isSnipeEntrySignal,
} from './snipe-types.js';

// ===== SnipeService =====

export class SnipeService extends EventEmitter {
  // Dependencies
  private realtimeService: RealtimeServiceV2;
  private tradingService: TradingService | null = null;
  private marketService: MarketService;

  // Configuration
  private config: SnipeConfigInternal;

  // State
  private market: SnipeMarketConfig | null = null;
  private currentTrade: SnipeTradeState | null = null;
  private isRunning = false;
  private isExecuting = false;
  private stats: SnipeStats;

  // Subscriptions
  private marketSubscription: MarketSubscription | null = null;

  // Intervals
  private windowCheckInterval: ReturnType<typeof setInterval> | null = null;
  private rewardTrackTimeout: ReturnType<typeof setTimeout> | null = null;

  // Orderbook state for both YES and NO tokens
  private yesBids: Array<{ price: number; size: number }> = [];
  private yesAsks: Array<{ price: number; size: number }> = [];
  private noBids: Array<{ price: number; size: number }> = [];
  private noAsks: Array<{ price: number; size: number }> = [];

  constructor(
    realtimeService: RealtimeServiceV2,
    tradingService: TradingService | null,
    marketService: MarketService
  ) {
    super();

    this.realtimeService = realtimeService;
    this.tradingService = tradingService;
    this.marketService = marketService;

    // Initialize with default config
    this.config = { ...DEFAULT_SNIPE_CONFIG };
    this.stats = createSnipeInitialStats();
  }

  // ===== Public API: Configuration =====

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SnipeServiceConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
    this.log(`Config updated: ${JSON.stringify(config)}`);
  }

  /**
   * Get current configuration
   */
  getConfig(): SnipeConfigInternal {
    return { ...this.config };
  }

  // ===== Public API: Market Discovery =====

  /**
   * Scan for markets ending soon
   *
   * Finds markets that are within the snipe window.
   */
  async scanMarketsEndingSoon(options: SnipeScanOptions = {}): Promise<SnipeMarketConfig[]> {
    const {
      minMinutesUntilEnd = 3,
      maxMinutesUntilEnd = 10,
      limit = 20,
    } = options;

    try {
      // Use gamma API via market service to find markets
      const markets = await this.marketService.searchMarkets({
        active: true,
        closed: false,
        limit,
      });

      const now = Date.now();
      const results: SnipeMarketConfig[] = [];

      for (const market of markets) {
        if (!market.endDate) continue;

        const endTime = new Date(market.endDate).getTime();
        const minutesUntilEnd = (endTime - now) / (60 * 1000);

        // Check if within window
        if (minutesUntilEnd >= minMinutesUntilEnd && minutesUntilEnd <= maxMinutesUntilEnd) {
          try {
            // Get full market info with token IDs
            const fullMarket = await this.marketService.getMarket(market.conditionId);

            // Find YES and NO tokens
            const yesToken = fullMarket.tokens.find(t =>
              t.outcome.toLowerCase() === 'yes'
            );
            const noToken = fullMarket.tokens.find(t =>
              t.outcome.toLowerCase() === 'no'
            );

            if (yesToken?.tokenId && noToken?.tokenId) {
              results.push({
                name: market.question,
                slug: market.slug,
                conditionId: market.conditionId,
                yesTokenId: yesToken.tokenId,
                noTokenId: noToken.tokenId,
                endTime: new Date(market.endDate),
              });
            }
          } catch {
            // Skip markets that fail to load
          }
        }
      }

      // Sort by end time (soonest first)
      results.sort((a, b) => a.endTime.getTime() - b.endTime.getTime());

      return results.slice(0, limit);
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  // ===== Public API: Lifecycle =====

  /**
   * Start monitoring a market
   */
  async start(market: SnipeMarketConfig): Promise<void> {
    if (this.isRunning) {
      throw new Error('SnipeService is already running. Call stop() first.');
    }

    // Validate token IDs
    if (!market.yesTokenId || !market.noTokenId) {
      throw new Error(`Invalid market config: missing token IDs`);
    }

    this.market = market;
    this.isRunning = true;
    this.stats = createSnipeInitialStats();
    this.stats.marketsMonitored++;

    // Create trade state
    const tradeId = `snipe-${market.slug}-${Date.now()}`;
    this.currentTrade = createSnipeTradeState(tradeId, market);

    this.log(`Starting Snipe monitor for: ${market.name}`);
    this.log(`Condition ID: ${market.conditionId.slice(0, 20)}...`);
    this.log(`End Time: ${market.endTime.toISOString()}`);
    this.log(`Auto Execute: ${this.config.autoExecute ? 'YES' : 'NO'}`);

    // Initialize trading service if available
    if (this.tradingService) {
      try {
        await this.tradingService.initialize();
        this.log('Trading service initialized');
      } catch (error) {
        this.log(`Warning: Trading service init failed: ${error}`);
      }
    } else {
      this.log('No trading service - monitoring only');
    }

    // Connect realtime service and wait for connection
    this.realtimeService.connect();

    // Wait for WebSocket connection
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.log('Warning: WebSocket connection timeout, proceeding anyway');
        resolve();
      }, 10000);

      if (this.realtimeService.isConnected?.()) {
        clearTimeout(timeout);
        resolve();
        return;
      }

      this.realtimeService.once('connected', () => {
        clearTimeout(timeout);
        this.log('WebSocket connected');
        resolve();
      });
    });

    // Subscribe to market orderbook (both YES and NO tokens)
    this.log(`Subscribing to tokens: YES=${market.yesTokenId.slice(0, 20)}..., NO=${market.noTokenId.slice(0, 20)}...`);
    this.marketSubscription = this.realtimeService.subscribeMarkets(
      [market.yesTokenId, market.noTokenId],
      {
        onOrderbook: (book: OrderbookSnapshot) => {
          this.handleOrderbookUpdate(book);
        },
        onError: (error: Error) => this.emit('error', error),
      }
    );

    // Start window check interval (every second)
    this.startWindowCheck();

    this.emit('started', market);
    this.log('Monitoring for snipe opportunities...');
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Clear intervals
    this.stopWindowCheck();
    this.stopRewardTrack();

    // Unsubscribe
    if (this.marketSubscription) {
      this.marketSubscription.unsubscribe();
      this.marketSubscription = null;
    }

    // Update stats
    this.stats.runningTimeMs = Date.now() - this.stats.startTime;

    this.log('Stopped');
    this.log(`Trades completed: ${this.stats.tradesCompleted}`);
    this.log(`Total PnL: $${this.stats.totalPnL.toFixed(2)}`);
    this.log(`Win rate: ${(this.stats.winRate * 100).toFixed(1)}%`);

    this.emit('stopped');
  }

  /**
   * Check if service is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get current market
   */
  getMarket(): SnipeMarketConfig | null {
    return this.market;
  }

  // ===== Public API: State Access =====

  /**
   * Get statistics
   */
  getStats(): SnipeStats {
    const stats = {
      ...this.stats,
      runningTimeMs: this.isRunning ? Date.now() - this.stats.startTime : this.stats.runningTimeMs,
    };

    // Update win rate and avg PnL
    if (stats.tradesCompleted > 0) {
      stats.winRate = stats.tradesWon / stats.tradesCompleted;
      stats.avgPnL = stats.totalPnL / stats.tradesCompleted;
    }

    // Add current trade info
    if (this.currentTrade) {
      stats.currentTrade = {
        tradeId: this.currentTrade.tradeId,
        phase: this.currentTrade.phase,
        market: this.currentTrade.market.name,
        position: this.currentTrade.position ? {
          entryPrice: this.currentTrade.position.entryPrice,
          shares: this.currentTrade.position.shares,
        } : undefined,
      };
    }

    return stats;
  }

  /**
   * Get current trade state
   */
  getCurrentTrade(): SnipeTradeState | null {
    return this.currentTrade ? { ...this.currentTrade } : null;
  }

  // ===== Public API: Manual Execution =====

  /**
   * Execute entry trade
   */
  async executeEntry(signal: SnipeEntrySignal): Promise<SnipeExecutionResult> {
    const startTime = Date.now();

    if (!this.tradingService || !this.market || !this.currentTrade) {
      this.isExecuting = false;
      return {
        success: false,
        action: 'entry',
        tradeId: signal.tradeId,
        error: 'Trading service not available or no active trade',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      this.isExecuting = true;

      // Trading service expects USDC amount
      const orderParams: MarketOrderParams = {
        tokenId: signal.tokenId,
        side: 'BUY' as Side,
        amount: this.config.positionSize, // USDC amount
      };

      this.log(`Executing entry: BUY ${signal.side} ~${signal.shares.toFixed(2)} shares @ ${signal.targetPrice.toFixed(0)}c`);

      const result = await this.tradingService.createMarketOrder(orderParams);

      if (result.success) {
        // Update trade state (prices in cents)
        this.currentTrade.position = {
          side: signal.side,
          entryPrice: signal.currentPrice, // cents
          shares: signal.shares,
          entryTimestamp: Date.now(),
          tokenId: signal.tokenId,
          orderId: result.orderId,
        };
        this.currentTrade.phase = 'position_open';
        this.stats.tradesAttempted++;

        this.log(`Entry FILLED: ${signal.side} x${signal.shares.toFixed(2)} @ ${signal.currentPrice.toFixed(0)}c`);

        return {
          success: true,
          action: 'entry',
          tradeId: signal.tradeId,
          price: signal.currentPrice,
          shares: signal.shares,
          orderId: result.orderId,
          executionTimeMs: Date.now() - startTime,
        };
      } else {
        this.log(`Entry FAILED: ${result.errorMsg}`);
        return {
          success: false,
          action: 'entry',
          tradeId: signal.tradeId,
          error: result.errorMsg,
          executionTimeMs: Date.now() - startTime,
        };
      }
    } catch (error) {
      return {
        success: false,
        action: 'entry',
        tradeId: signal.tradeId,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Execute exit trade
   */
  async executeExit(signal: SnipeExitSignal): Promise<SnipeExecutionResult> {
    const startTime = Date.now();

    if (!this.tradingService || !this.market || !this.currentTrade || !this.currentTrade.position) {
      this.isExecuting = false;
      return {
        success: false,
        action: 'exit',
        tradeId: signal.tradeId,
        error: 'Trading service not available or no open position',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      this.isExecuting = true;

      // Trading service expects USDC amount (convert cents to USDC)
      const amountUsdc = signal.shares * (signal.targetPrice / 100);
      const orderParams: MarketOrderParams = {
        tokenId: signal.tokenId,
        side: 'SELL' as Side,
        amount: amountUsdc,
      };

      this.log(`Executing exit (${signal.reason}): SELL ${signal.side} x${signal.shares.toFixed(2)} @ ${signal.targetPrice.toFixed(0)}c`);

      const result = await this.tradingService.createMarketOrder(orderParams);

      if (result.success) {
        // Calculate PnL in USDC (prices are in cents)
        const entryValueUsdc = (this.currentTrade.position.entryPrice / 100) * signal.shares;
        const exitValueUsdc = (signal.currentPrice / 100) * signal.shares;
        const realizedPnL = exitValueUsdc - entryValueUsdc;

        // Update trade state
        this.currentTrade.exit = {
          exitPrice: signal.currentPrice,
          shares: signal.shares,
          exitTimestamp: Date.now(),
          reason: signal.reason,
          orderId: result.orderId,
        };
        this.currentTrade.realizedPnL = realizedPnL;

        // Update phase based on reason
        if (signal.reason === 'take_profit') {
          this.currentTrade.phase = 'exit_take_profit';
        } else if (signal.reason === 'stop_loss') {
          this.currentTrade.phase = 'exit_stop_loss';
        } else {
          this.currentTrade.phase = 'exit_market_close';
        }

        this.log(`Exit FILLED: ${signal.side} x${signal.shares.toFixed(2)} @ ${signal.currentPrice.toFixed(0)}c`);
        this.log(`Realized PnL: $${realizedPnL.toFixed(2)} (${(realizedPnL / entryValueUsdc * 100).toFixed(2)}%)`);

        // Schedule reward tracking
        this.scheduleRewardTracking();

        return {
          success: true,
          action: 'exit',
          tradeId: signal.tradeId,
          price: signal.currentPrice,
          shares: signal.shares,
          orderId: result.orderId,
          executionTimeMs: Date.now() - startTime,
        };
      } else {
        this.log(`Exit FAILED: ${result.errorMsg}`);
        return {
          success: false,
          action: 'exit',
          tradeId: signal.tradeId,
          error: result.errorMsg,
          executionTimeMs: Date.now() - startTime,
        };
      }
    } catch (error) {
      return {
        success: false,
        action: 'exit',
        tradeId: signal.tradeId,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    } finally {
      this.isExecuting = false;
    }
  }

  // ===== Private: Event Handlers =====

  private handleOrderbookUpdate(book: OrderbookSnapshot): void {
    if (!this.market) return;

    // Update orderbook state based on which token
    if (book.tokenId === this.market.yesTokenId) {
      this.yesBids = book.bids.map(l => ({ price: l.price, size: l.size }));
      this.yesAsks = book.asks.map(l => ({ price: l.price, size: l.size }));
    } else if (book.tokenId === this.market.noTokenId) {
      this.noBids = book.bids.map(l => ({ price: l.price, size: l.size }));
      this.noAsks = book.asks.map(l => ({ price: l.price, size: l.size }));
    } else {
      return; // Unknown token
    }

    // Skip signal detection if executing
    if (this.isExecuting) return;

    // Detect signals based on current phase
    const signal = this.detectSignal();
    if (signal) {
      this.handleSignal(signal);
    }
  }

  // ===== Private: Window Management =====

  private startWindowCheck(): void {
    if (this.windowCheckInterval) {
      clearInterval(this.windowCheckInterval);
    }

    // Check every second
    this.windowCheckInterval = setInterval(() => {
      this.checkWindow();
    }, 1000);

    // Also check immediately
    this.checkWindow();
  }

  private stopWindowCheck(): void {
    if (this.windowCheckInterval) {
      clearInterval(this.windowCheckInterval);
      this.windowCheckInterval = null;
    }
  }

  private checkWindow(): void {
    if (!this.market || !this.currentTrade) return;

    const now = Date.now();
    const endTime = this.market.endTime.getTime();
    const minutesUntilEnd = (endTime - now) / (60 * 1000);

    // Check if market has ended
    if (minutesUntilEnd <= 0) {
      this.handleMarketClose();
      return;
    }

    // Check if window should open
    if (this.currentTrade.phase === 'waiting_for_window') {
      if (minutesUntilEnd <= this.config.minutesBeforeClose) {
        this.openWindow(minutesUntilEnd);
      }
    }
  }

  private openWindow(minutesUntilClose: number): void {
    if (!this.currentTrade || !this.market) return;

    this.currentTrade.phase = 'waiting_for_entry';
    this.currentTrade.windowOpenTime = Date.now();

    // Convert to cents for display
    const yesPriceCents = (this.yesAsks[0]?.price ?? 0) * 100;
    const noPriceCents = (this.noAsks[0]?.price ?? 0) * 100;

    const event: SnipeWindowOpenEvent = {
      tradeId: this.currentTrade.tradeId,
      market: this.market,
      minutesUntilClose,
      currentPrice: Math.min(yesPriceCents, noPriceCents), // Report the lower price in cents
    };

    this.emit('windowOpen', event);
    this.log(`Window OPEN: ${minutesUntilClose.toFixed(1)} min until close, YES @ ${yesPriceCents.toFixed(0)}c, NO @ ${noPriceCents.toFixed(0)}c`);
  }

  private handleMarketClose(): void {
    if (!this.currentTrade) return;

    // If we have an open position, emit exit signal for market close
    if (this.currentTrade.phase === 'position_open' && this.currentTrade.position) {
      const position = this.currentTrade.position;
      // Convert to cents
      const currentBidCents = (position.side === 'YES'
        ? (this.yesBids[0]?.price ?? 0)
        : (this.noBids[0]?.price ?? 0)) * 100;
      const signal = this.createExitSignal('market_close', currentBidCents);
      if (signal) {
        this.handleSignal(signal);
      }
    }

    // Stop monitoring
    this.stop();
  }

  // ===== Private: Signal Detection =====

  private detectSignal(): SnipeSignal | null {
    if (!this.currentTrade || !this.market) return null;

    const phase = this.currentTrade.phase;

    if (phase === 'waiting_for_entry') {
      return this.detectEntrySignal();
    } else if (phase === 'position_open') {
      return this.detectExitSignal();
    }

    return null;
  }

  private detectEntrySignal(): SnipeEntrySignal | null {
    if (!this.currentTrade || !this.market) return null;

    // Orderbook prices are 0-1, convert to cents (0-100)
    const yesAskCents = (this.yesAsks[0]?.price ?? 1) * 100;
    const noAskCents = (this.noAsks[0]?.price ?? 1) * 100;
    const minutesUntilClose = (this.market.endTime.getTime() - Date.now()) / (60 * 1000);

    // Check YES token first - if price <= entryPrice (e.g., 95 cents), buy YES
    if (yesAskCents <= this.config.entryPrice) {
      const currentPrice = yesAskCents;
      const targetPrice = currentPrice + this.config.maxSlippage; // Add slippage in cents
      const shares = this.config.positionSize / (targetPrice / 100); // Convert back to USDC

      return {
        type: 'entry',
        tradeId: this.currentTrade.tradeId,
        conditionId: this.market.conditionId,
        side: 'YES',
        currentPrice,
        targetPrice,
        shares,
        tokenId: this.market.yesTokenId,
        minutesUntilClose,
      };
    }

    // Check NO token - if price <= entryPrice (e.g., 95 cents), buy NO
    if (noAskCents <= this.config.entryPrice) {
      const currentPrice = noAskCents;
      const targetPrice = currentPrice + this.config.maxSlippage;
      const shares = this.config.positionSize / (targetPrice / 100);

      return {
        type: 'entry',
        tradeId: this.currentTrade.tradeId,
        conditionId: this.market.conditionId,
        side: 'NO',
        currentPrice,
        targetPrice,
        shares,
        tokenId: this.market.noTokenId,
        minutesUntilClose,
      };
    }

    return null;
  }

  private detectExitSignal(): SnipeExitSignal | null {
    if (!this.currentTrade || !this.market || !this.currentTrade.position) return null;

    const position = this.currentTrade.position;

    // Get best bid for the token we're holding (convert to cents)
    const bestBidCents = (position.side === 'YES'
      ? (this.yesBids[0]?.price ?? 0)
      : (this.noBids[0]?.price ?? 0)) * 100;

    // Check take profit (e.g., price >= 99 cents)
    if (bestBidCents >= this.config.takeProfitPrice) {
      return this.createExitSignal('take_profit', bestBidCents);
    }

    // Check stop loss (e.g., price <= 91 cents)
    if (bestBidCents <= this.config.stopLossPrice) {
      return this.createExitSignal('stop_loss', bestBidCents);
    }

    return null;
  }

  private createExitSignal(
    reason: 'take_profit' | 'stop_loss' | 'market_close',
    currentPriceCents: number
  ): SnipeExitSignal | null {
    if (!this.currentTrade || !this.market || !this.currentTrade.position) return null;

    const position = this.currentTrade.position;
    const targetPriceCents = currentPriceCents - this.config.maxSlippage; // Slippage in cents

    // Calculate PnL in USDC (convert cents to USDC by /100)
    const entryValueUsdc = (position.entryPrice / 100) * position.shares;
    const exitValueUsdc = (targetPriceCents / 100) * position.shares;
    const expectedPnL = exitValueUsdc - entryValueUsdc;
    const expectedPnLPercent = entryValueUsdc > 0 ? expectedPnL / entryValueUsdc : 0;

    return {
      type: 'exit',
      tradeId: this.currentTrade.tradeId,
      conditionId: this.market.conditionId,
      side: position.side,
      reason,
      currentPrice: currentPriceCents,
      targetPrice: targetPriceCents,
      shares: position.shares,
      tokenId: position.tokenId,
      entryPrice: position.entryPrice,
      expectedPnL,
      expectedPnLPercent,
    };
  }

  // ===== Private: Signal Handling =====

  private async handleSignal(signal: SnipeSignal): Promise<void> {
    // Emit signal event
    this.emit('signal', signal);

    if (this.config.debug) {
      if (isSnipeEntrySignal(signal)) {
        this.log(`Signal: ENTRY ${signal.side} @ ${signal.currentPrice.toFixed(0)}c, ${signal.minutesUntilClose.toFixed(1)} min left`);
      } else {
        this.log(`Signal: EXIT ${signal.side} (${signal.reason}) @ ${signal.currentPrice.toFixed(0)}c, PnL: $${signal.expectedPnL.toFixed(2)}`);
      }
    }

    // Auto execute if enabled
    if (this.config.autoExecute && this.tradingService && !this.isExecuting) {
      this.isExecuting = true;

      let result: SnipeExecutionResult;
      if (isSnipeEntrySignal(signal)) {
        result = await this.executeEntry(signal);
      } else {
        result = await this.executeExit(signal);
      }

      this.emit('execution', result);
    }
  }

  // ===== Private: Reward Tracking =====

  private scheduleRewardTracking(): void {
    if (!this.currentTrade) return;

    this.currentTrade.phase = 'tracking_rewards';

    const delayMs = this.config.rewardTrackDelayMinutes * 60 * 1000;
    this.log(`Reward tracking scheduled in ${this.config.rewardTrackDelayMinutes} min`);

    this.rewardTrackTimeout = setTimeout(() => {
      this.trackRewards();
    }, delayMs);
  }

  private stopRewardTrack(): void {
    if (this.rewardTrackTimeout) {
      clearTimeout(this.rewardTrackTimeout);
      this.rewardTrackTimeout = null;
    }
  }

  private async trackRewards(): Promise<void> {
    if (!this.currentTrade || !this.tradingService) {
      this.completeTrade();
      return;
    }

    try {
      this.log('Tracking rewards...');

      // Get order IDs to check
      const orderIds: string[] = [];
      if (this.currentTrade.position?.orderId) {
        orderIds.push(this.currentTrade.position.orderId);
      }
      if (this.currentTrade.exit?.orderId) {
        orderIds.push(this.currentTrade.exit.orderId);
      }

      // Check if orders are scoring
      let ordersScoring: Record<string, boolean> = {};
      if (orderIds.length > 0) {
        ordersScoring = await this.tradingService.areOrdersScoring(orderIds);
      }

      // Get daily earnings
      const today = new Date().toISOString().split('T')[0];
      const earnings = await this.tradingService.getEarningsForDay(today);
      const dailyEarnings = earnings.reduce((sum, e) => sum + e.earnings, 0);

      // Store rewards info
      const rewards: SnipeRewardsInfo = {
        ordersScoring,
        dailyEarnings,
        trackedAt: Date.now(),
      };
      this.currentTrade.rewards = rewards;

      // Update stats
      this.stats.totalRewards += dailyEarnings;

      // Emit event
      const event: SnipeRewardsTrackedEvent = {
        tradeId: this.currentTrade.tradeId,
        rewards,
      };
      this.emit('rewardsTracked', event);

      this.log(`Rewards tracked: Daily earnings = $${dailyEarnings.toFixed(2)}`);
      this.log(`Orders scoring: ${JSON.stringify(ordersScoring)}`);
    } catch (error) {
      this.log(`Reward tracking error: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.completeTrade();
  }

  private completeTrade(): void {
    if (!this.currentTrade) return;

    this.currentTrade.phase = 'completed';
    this.stats.tradesCompleted++;

    // Update win/loss stats
    if (this.currentTrade.realizedPnL !== undefined) {
      this.stats.totalPnL += this.currentTrade.realizedPnL;
      if (this.currentTrade.realizedPnL > 0) {
        this.stats.tradesWon++;
      } else if (this.currentTrade.realizedPnL < 0) {
        this.stats.tradesLost++;
      }
    }

    // Calculate result
    const result: SnipeTradeResult = {
      tradeId: this.currentTrade.tradeId,
      status: 'completed',
      market: this.currentTrade.market,
      entry: this.currentTrade.position,
      exit: this.currentTrade.exit,
      realizedPnL: this.currentTrade.realizedPnL,
      pnlPercent: this.currentTrade.position && this.currentTrade.realizedPnL !== undefined
        ? this.currentTrade.realizedPnL / (this.currentTrade.position.entryPrice * this.currentTrade.position.shares)
        : undefined,
      rewards: this.currentTrade.rewards,
    };

    this.emit('tradeComplete', result);
    this.log(`Trade COMPLETE: PnL = $${result.realizedPnL?.toFixed(2) ?? 'N/A'}`);
  }

  // ===== Private: Helpers =====

  private log(message: string): void {
    const shouldLog = this.config.debug ||
      message.startsWith('Starting') ||
      message.startsWith('Stopped') ||
      message.startsWith('Window') ||
      message.startsWith('Entry') ||
      message.startsWith('Exit') ||
      message.startsWith('Trade');

    if (!shouldLog) return;

    const formatted = `[Snipe] ${message}`;

    if (this.config.logHandler) {
      this.config.logHandler(formatted);
    } else {
      console.log(formatted);
    }
  }
}

// Re-export types
export * from './snipe-types.js';
