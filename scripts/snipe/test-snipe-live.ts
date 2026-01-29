/**
 * SnipeService Live Test
 *
 * Tests with a real market to verify orderbook subscription works
 */

import { PolymarketSDK } from '../../src/index.js';

async function main() {
  console.log('='.repeat(60));
  console.log('SnipeService Live Test');
  console.log('='.repeat(60));

  const sdk = new PolymarketSDK();

  // Enable realtime service debug
  (sdk.realtime as any).config.debug = true;

  // Get any active market for testing
  console.log('\nSearching for active markets...');
  const searchResults = await sdk.markets.searchMarkets({
    active: true,
    closed: false,
    limit: 5,
  });

  console.log(`Found ${searchResults.length} active markets`);

  if (searchResults.length === 0) {
    console.log('No active markets found');
    process.exit(1);
  }

  // Pick a market with good volume
  let testMarket = null;
  for (const m of searchResults) {
    try {
      const fullMarket = await sdk.markets.getMarket(m.conditionId);
      const yesToken = fullMarket.tokens.find(t => t.outcome.toLowerCase() === 'yes');
      const noToken = fullMarket.tokens.find(t => t.outcome.toLowerCase() === 'no');

      if (yesToken?.tokenId && noToken?.tokenId) {
        // Create a fake end time 3 minutes from now for testing
        const fakeEndTime = new Date(Date.now() + 3 * 60 * 1000);

        testMarket = {
          name: m.question,
          slug: m.slug,
          conditionId: m.conditionId,
          yesTokenId: yesToken.tokenId,
          noTokenId: noToken.tokenId,
          endTime: fakeEndTime,
        };
        console.log(`\nSelected market: ${m.question.slice(0, 60)}...`);
        console.log(`Condition ID: ${m.conditionId.slice(0, 30)}...`);
        break;
      }
    } catch (e) {
      // Skip
    }
  }

  if (!testMarket) {
    console.log('Could not find a suitable market');
    process.exit(1);
  }

  // Configure for testing (prices in cents 0-100)
  sdk.snipe.updateConfig({
    minutesBeforeClose: 10, // Wide window
    entryPrice: 95,         // Entry at 95 cents
    takeProfitPrice: 99,    // TP at 99 cents
    stopLossPrice: 91,      // SL at 91 cents
    autoExecute: false,     // Don't execute
    debug: true,
  });

  // Event listeners
  console.log('\nSetting up event listeners...');

  sdk.snipe.on('started', (m) => {
    console.log(`\n📢 [STARTED] ${m.name.slice(0, 40)}...`);
  });

  sdk.snipe.on('windowOpen', (e) => {
    console.log(`\n🪟 [WINDOW OPEN] ${e.minutesUntilClose.toFixed(1)} min left`);
    console.log(`   Current price: ${e.currentPrice.toFixed(0)}c`);
  });

  sdk.snipe.on('signal', (s) => {
    if (s.type === 'entry') {
      console.log(`\n🎯 [ENTRY SIGNAL] ${s.side} @ ${s.currentPrice.toFixed(0)}c`);
      console.log(`   Target: ${s.targetPrice.toFixed(0)}c`);
      console.log(`   Shares: ${s.shares.toFixed(2)}`);
      console.log(`   Minutes left: ${s.minutesUntilClose.toFixed(1)}`);
    } else {
      console.log(`\n🚪 [EXIT SIGNAL] ${s.side} (${s.reason}) @ ${s.currentPrice.toFixed(0)}c`);
      console.log(`   Entry: ${s.entryPrice.toFixed(0)}c`);
      console.log(`   Expected PnL: $${s.expectedPnL.toFixed(2)} (${(s.expectedPnLPercent * 100).toFixed(2)}%)`);
    }
  });

  sdk.snipe.on('stopped', () => {
    console.log('\n📴 [STOPPED]');
  });

  sdk.snipe.on('error', (err) => {
    console.log(`\n❌ [ERROR] ${err.message}`);
  });

  // Enable realtime debug
  sdk.realtime.on('clobConnected', () => {
    console.log('🔌 [CLOB WS] Connected!');
  });
  sdk.realtime.on('clobDisconnected', () => {
    console.log('🔌 [CLOB WS] Disconnected');
  });
  sdk.realtime.on('orderbook', (book: any) => {
    const side = book.tokenId === testMarket.yesTokenId ? 'YES' : 'NO';
    const bestBid = book.bids?.[0]?.price ?? 0;
    const bestAsk = book.asks?.[0]?.price ?? 0;
    console.log(`📚 [ORDERBOOK] ${side}: bid=${(bestBid*100).toFixed(1)}c ask=${(bestAsk*100).toFixed(1)}c spread=${((bestAsk-bestBid)*100).toFixed(1)}c`);
  });

  // Start monitoring
  console.log('\nStarting snipe service...');
  await sdk.snipe.start(testMarket);

  console.log('\n📊 Monitoring orderbook for 15 seconds...');
  console.log('   (Looking for YES or NO price <= 95c)');

  // Monitor for 15 seconds
  let lastLogTime = 0;
  const startTime = Date.now();

  const monitorInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - startTime) / 1000;

    if (now - lastLogTime >= 3000) {
      lastLogTime = now;
      const trade = sdk.snipe.getCurrentTrade();
      const stats = sdk.snipe.getStats();
      console.log(`\n⏱️  [${elapsed.toFixed(0)}s] Phase: ${trade?.phase || 'N/A'}`);
    }
  }, 500);

  // Wait 15 seconds
  await new Promise(r => setTimeout(r, 15000));

  clearInterval(monitorInterval);

  // Final state
  console.log('\n' + '='.repeat(60));
  console.log('Final State');
  console.log('='.repeat(60));

  const finalTrade = sdk.snipe.getCurrentTrade();
  const finalStats = sdk.snipe.getStats();

  console.log(`Phase: ${finalTrade?.phase}`);
  console.log(`Markets monitored: ${finalStats.marketsMonitored}`);
  console.log(`Running time: ${(finalStats.runningTimeMs / 1000).toFixed(1)}s`);

  // Stop
  await sdk.snipe.stop();
  sdk.stop();

  console.log('\n✅ Test completed');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
