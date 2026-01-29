/**
 * SnipeService Logic Test
 *
 * Tests the signal detection logic with simulated orderbook data
 */

import { EventEmitter } from 'events';

// Import types directly
import {
  SnipeService,
  type SnipeMarketConfig,
  type SnipeEntrySignal,
  type SnipeExitSignal,
} from '../../src/services/snipe-service.js';

// Create mock services
class MockRealtimeService extends EventEmitter {
  private connected = false;

  connect() {
    this.connected = true;
    setTimeout(() => this.emit('connected'), 100);
  }

  disconnect() {
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }

  subscribeMarkets(tokenIds: string[], handlers: any) {
    console.log(`[Mock] Subscribed to ${tokenIds.length} tokens`);

    // Store handlers for simulation
    (this as any)._handlers = handlers;

    return {
      unsubscribe: () => console.log('[Mock] Unsubscribed'),
    };
  }

  // Simulate orderbook update
  simulateOrderbook(tokenId: string, bids: Array<{price: number, size: number}>, asks: Array<{price: number, size: number}>) {
    const handlers = (this as any)._handlers;
    if (handlers?.onOrderbook) {
      handlers.onOrderbook({
        tokenId,
        market: 'test-condition',
        bids: bids.map(b => ({ price: b.price, size: b.size })),
        asks: asks.map(a => ({ price: a.price, size: a.size })),
        hash: 'test-hash',
        tickSize: '0.01',
        minOrderSize: '1',
      });
    }
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('SnipeService Logic Test');
  console.log('='.repeat(60));

  // Create mock services
  const mockRealtime = new MockRealtimeService();

  // Create snipe service with mocks
  const snipe = new SnipeService(
    mockRealtime as any,
    null, // No trading service
    { searchMarkets: async () => [], getMarket: async () => ({}) } as any
  );

  // Configure (prices in cents)
  snipe.updateConfig({
    minutesBeforeClose: 10,
    entryPrice: 95,        // 95 cents
    takeProfitPrice: 99,   // 99 cents
    stopLossPrice: 91,     // 91 cents
    autoExecute: false,
    debug: true,
  });

  // Create test market
  const testMarket: SnipeMarketConfig = {
    name: 'Test Market',
    slug: 'test-market',
    conditionId: '0x123',
    yesTokenId: 'yes-token-123',
    noTokenId: 'no-token-123',
    endTime: new Date(Date.now() + 3 * 60 * 1000), // 3 min from now
  };

  // Collect events
  const events: any[] = [];

  snipe.on('windowOpen', (e) => {
    events.push({ type: 'windowOpen', data: e });
    console.log(`\n🪟 Window Open: ${e.minutesUntilClose.toFixed(1)} min left`);
  });

  snipe.on('signal', (s) => {
    events.push({ type: 'signal', data: s });
    if (s.type === 'entry') {
      console.log(`\n🎯 Entry Signal: ${s.side} @ ${s.currentPrice}c`);
    } else {
      console.log(`\n🚪 Exit Signal: ${s.side} (${s.reason}) @ ${s.currentPrice}c`);
    }
  });

  // Start service
  console.log('\n[Test] Starting service...');
  await snipe.start(testMarket);

  // Wait for window to open
  await new Promise(r => setTimeout(r, 200));

  console.log('\n' + '-'.repeat(60));
  console.log('Test 1: NO signal when prices > 95c');
  console.log('-'.repeat(60));

  // Simulate orderbook with prices > 95c (no signal expected)
  mockRealtime.simulateOrderbook('yes-token-123',
    [{ price: 0.50, size: 100 }],  // bid 50c
    [{ price: 0.52, size: 100 }]   // ask 52c - below 95c but we want >95c for no signal
  );
  await new Promise(r => setTimeout(r, 100));

  // Actually set prices > 95c
  mockRealtime.simulateOrderbook('yes-token-123',
    [{ price: 0.96, size: 100 }],  // bid 96c
    [{ price: 0.97, size: 100 }]   // ask 97c > 95c - no entry
  );
  mockRealtime.simulateOrderbook('no-token-123',
    [{ price: 0.02, size: 100 }],
    [{ price: 0.03, size: 100 }]   // ask 3c < 95c - but this is NO
  );
  await new Promise(r => setTimeout(r, 100));

  console.log(`Signals received: ${events.filter(e => e.type === 'signal').length}`);

  console.log('\n' + '-'.repeat(60));
  console.log('Test 2: Entry signal when YES <= 95c');
  console.log('-'.repeat(60));

  // Reset events
  events.length = 0;

  // Simulate YES at 94c (should trigger entry)
  mockRealtime.simulateOrderbook('yes-token-123',
    [{ price: 0.93, size: 100 }],  // bid 93c
    [{ price: 0.94, size: 100 }]   // ask 94c <= 95c - ENTRY!
  );
  await new Promise(r => setTimeout(r, 100));

  const entrySignals = events.filter(e => e.type === 'signal' && e.data.type === 'entry');
  console.log(`Entry signals received: ${entrySignals.length}`);
  if (entrySignals.length > 0) {
    const sig = entrySignals[0].data as SnipeEntrySignal;
    console.log(`  Side: ${sig.side}`);
    console.log(`  Price: ${sig.currentPrice}c`);
    console.log(`  Target: ${sig.targetPrice}c`);
    console.log(`  Shares: ${sig.shares.toFixed(2)}`);
  }

  console.log('\n' + '-'.repeat(60));
  console.log('Test 3: Entry signal when NO <= 95c');
  console.log('-'.repeat(60));

  // Stop and restart with fresh state
  await snipe.stop();
  events.length = 0;

  // Create new market
  const testMarket2: SnipeMarketConfig = {
    name: 'Test Market 2',
    slug: 'test-market-2',
    conditionId: '0x456',
    yesTokenId: 'yes-token-456',
    noTokenId: 'no-token-456',
    endTime: new Date(Date.now() + 3 * 60 * 1000),
  };

  await snipe.start(testMarket2);
  await new Promise(r => setTimeout(r, 200));

  // YES at 98c (no signal), NO at 92c (should trigger)
  mockRealtime.simulateOrderbook('yes-token-456',
    [{ price: 0.97, size: 100 }],
    [{ price: 0.98, size: 100 }]   // ask 98c > 95c - no entry
  );
  mockRealtime.simulateOrderbook('no-token-456',
    [{ price: 0.91, size: 100 }],
    [{ price: 0.92, size: 100 }]   // ask 92c <= 95c - ENTRY NO!
  );
  await new Promise(r => setTimeout(r, 100));

  const noEntrySignals = events.filter(e => e.type === 'signal' && e.data.type === 'entry');
  console.log(`Entry signals received: ${noEntrySignals.length}`);
  if (noEntrySignals.length > 0) {
    const sig = noEntrySignals[0].data as SnipeEntrySignal;
    console.log(`  Side: ${sig.side}`);
    console.log(`  Price: ${sig.currentPrice}c`);
  }

  console.log('\n' + '-'.repeat(60));
  console.log('Test 4: Take Profit signal when price >= 99c');
  console.log('-'.repeat(60));

  // Manually set position to simulate entry
  const trade = snipe.getCurrentTrade();
  if (trade) {
    (trade as any).phase = 'position_open';
    (trade as any).position = {
      side: 'NO',
      entryPrice: 92,
      shares: 10.87,
      entryTimestamp: Date.now(),
      tokenId: 'no-token-456',
    };
    // Update internal state
    (snipe as any).currentTrade = trade;
  }

  events.length = 0;

  // NO price at 99c (take profit)
  mockRealtime.simulateOrderbook('no-token-456',
    [{ price: 0.99, size: 100 }],  // bid 99c >= TP
    [{ price: 1.00, size: 100 }]
  );
  await new Promise(r => setTimeout(r, 100));

  const exitSignals = events.filter(e => e.type === 'signal' && e.data.type === 'exit');
  console.log(`Exit signals received: ${exitSignals.length}`);
  if (exitSignals.length > 0) {
    const sig = exitSignals[0].data as SnipeExitSignal;
    console.log(`  Reason: ${sig.reason}`);
    console.log(`  Price: ${sig.currentPrice}c`);
    console.log(`  Expected PnL: $${sig.expectedPnL.toFixed(2)}`);
  }

  console.log('\n' + '-'.repeat(60));
  console.log('Test 5: Stop Loss signal when price <= 91c');
  console.log('-'.repeat(60));

  // Reset position
  if (trade) {
    (trade as any).phase = 'position_open';
    (trade as any).position = {
      side: 'NO',
      entryPrice: 95,
      shares: 10.53,
      entryTimestamp: Date.now(),
      tokenId: 'no-token-456',
    };
    (snipe as any).currentTrade = trade;
  }

  events.length = 0;

  // NO price drops to 90c (stop loss)
  mockRealtime.simulateOrderbook('no-token-456',
    [{ price: 0.90, size: 100 }],  // bid 90c <= SL (91c)
    [{ price: 0.91, size: 100 }]
  );
  await new Promise(r => setTimeout(r, 100));

  const slSignals = events.filter(e => e.type === 'signal' && e.data.type === 'exit');
  console.log(`Exit signals received: ${slSignals.length}`);
  if (slSignals.length > 0) {
    const sig = slSignals[0].data as SnipeExitSignal;
    console.log(`  Reason: ${sig.reason}`);
    console.log(`  Price: ${sig.currentPrice}c`);
    console.log(`  Expected PnL: $${sig.expectedPnL.toFixed(2)}`);
  }

  // Stop
  await snipe.stop();

  console.log('\n' + '='.repeat(60));
  console.log('Logic tests completed!');
  console.log('='.repeat(60));

  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
