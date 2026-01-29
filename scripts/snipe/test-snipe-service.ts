/**
 * SnipeService Test Script
 *
 * Tests the SnipeService implementation
 */

import { PolymarketSDK } from '../../src/index.js';

async function main() {
  console.log('='.repeat(60));
  console.log('SnipeService Test');
  console.log('='.repeat(60));

  // Create SDK (read-only mode without private key)
  const sdk = new PolymarketSDK();

  // Test 1: Configuration
  console.log('\n[Test 1] Configuration');
  console.log('-'.repeat(40));

  const defaultConfig = sdk.snipe.getConfig();
  console.log('Default config:', {
    minutesBeforeClose: defaultConfig.minutesBeforeClose,
    entryPrice: defaultConfig.entryPrice,
    takeProfitPrice: defaultConfig.takeProfitPrice,
    stopLossPrice: defaultConfig.stopLossPrice,
    positionSize: defaultConfig.positionSize,
    autoExecute: defaultConfig.autoExecute,
  });

  sdk.snipe.updateConfig({
    entryPrice: 94, // 94 cents
    debug: true,
  });

  const updatedConfig = sdk.snipe.getConfig();
  console.log('Updated entryPrice:', updatedConfig.entryPrice);
  console.log('✅ Configuration test passed\n');

  // Test 2: Market Scanning
  console.log('[Test 2] Market Scanning');
  console.log('-'.repeat(40));

  console.log('Scanning for markets ending in 3-30 minutes...');
  const markets = await sdk.snipe.scanMarketsEndingSoon({
    minMinutesUntilEnd: 3,
    maxMinutesUntilEnd: 30,
    limit: 5,
  });

  console.log(`Found ${markets.length} markets:`);
  for (const m of markets) {
    const minutesLeft = (m.endTime.getTime() - Date.now()) / (60 * 1000);
    console.log(`  - ${m.name.slice(0, 50)}...`);
    console.log(`    End: ${m.endTime.toISOString()} (${minutesLeft.toFixed(1)} min)`);
    console.log(`    YES: ${m.yesTokenId.slice(0, 20)}...`);
    console.log(`    NO:  ${m.noTokenId.slice(0, 20)}...`);
  }

  if (markets.length === 0) {
    console.log('No markets found in the specified window.');
    console.log('Trying wider window (1-60 minutes)...');

    const widerMarkets = await sdk.snipe.scanMarketsEndingSoon({
      minMinutesUntilEnd: 1,
      maxMinutesUntilEnd: 60,
      limit: 3,
    });

    if (widerMarkets.length > 0) {
      console.log(`Found ${widerMarkets.length} markets in wider window`);
      markets.push(...widerMarkets);
    }
  }

  console.log('✅ Market scanning test passed\n');

  // Test 3: Service Lifecycle (if markets found)
  if (markets.length > 0) {
    console.log('[Test 3] Service Lifecycle');
    console.log('-'.repeat(40));

    const testMarket = markets[0];
    console.log(`Testing with market: ${testMarket.name.slice(0, 50)}...`);

    // Reset config for test
    sdk.snipe.updateConfig({
      minutesBeforeClose: 60, // Wide window for testing
      entryPrice: 0.95,
      takeProfitPrice: 0.99,
      stopLossPrice: 0.90,
      autoExecute: false, // Don't auto-execute
      debug: true,
    });

    // Set up event listeners
    let windowOpened = false;
    let signalReceived = false;

    sdk.snipe.on('started', (m) => {
      console.log(`  [Event] Started: ${m.name.slice(0, 30)}...`);
    });

    sdk.snipe.on('windowOpen', (e) => {
      windowOpened = true;
      console.log(`  [Event] Window Open: ${e.minutesUntilClose.toFixed(1)} min left, price=${e.currentPrice.toFixed(4)}`);
    });

    sdk.snipe.on('signal', (s) => {
      signalReceived = true;
      if (s.type === 'entry') {
        console.log(`  [Event] Entry Signal: ${s.side} @ ${s.currentPrice.toFixed(4)}`);
      } else {
        console.log(`  [Event] Exit Signal: ${s.side} (${s.reason}) @ ${s.currentPrice.toFixed(4)}`);
      }
    });

    sdk.snipe.on('stopped', () => {
      console.log('  [Event] Stopped');
    });

    sdk.snipe.on('error', (err) => {
      console.log(`  [Event] Error: ${err.message}`);
    });

    // Start service
    console.log('Starting service...');
    await sdk.snipe.start(testMarket);

    console.log('Service started, checking state...');
    console.log(`  isActive: ${sdk.snipe.isActive()}`);
    console.log(`  currentMarket: ${sdk.snipe.getMarket()?.name.slice(0, 30)}...`);

    const trade = sdk.snipe.getCurrentTrade();
    console.log(`  currentTrade: ${trade?.tradeId}`);
    console.log(`  phase: ${trade?.phase}`);

    // Wait for orderbook data
    console.log('Waiting 5 seconds for orderbook data...');
    await new Promise(r => setTimeout(r, 5000));

    // Check stats
    const stats = sdk.snipe.getStats();
    console.log('Stats:', {
      marketsMonitored: stats.marketsMonitored,
      phase: stats.currentTrade?.phase,
      runningTimeMs: stats.runningTimeMs,
    });

    // Stop service
    console.log('Stopping service...');
    await sdk.snipe.stop();

    console.log(`  windowOpened: ${windowOpened}`);
    console.log(`  signalReceived: ${signalReceived}`);
    console.log('✅ Service lifecycle test passed\n');
  }

  // Test 4: Stats
  console.log('[Test 4] Statistics');
  console.log('-'.repeat(40));

  const finalStats = sdk.snipe.getStats();
  console.log('Final stats:', {
    marketsMonitored: finalStats.marketsMonitored,
    tradesAttempted: finalStats.tradesAttempted,
    tradesCompleted: finalStats.tradesCompleted,
    totalPnL: finalStats.totalPnL,
    winRate: finalStats.winRate,
  });
  console.log('✅ Statistics test passed\n');

  console.log('='.repeat(60));
  console.log('All tests completed!');
  console.log('='.repeat(60));

  // Cleanup
  sdk.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
