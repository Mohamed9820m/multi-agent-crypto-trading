import 'dotenv/config';
import binanceClient from '../src/shared/binance';

const SYMBOL = process.argv[2] || process.env.TRADING_SYMBOL || 'BTCUSDT';

function formatTime(ts: number): string {
  return new Date(ts).toISOString();
}

async function main() {
  console.log(`\n🔍 Account snapshot for ${SYMBOL}\n`);

  const account = await binanceClient.getAccount();
  const relevant = account.balances.filter(
    (b) => Number(b.free) > 0 || Number(b.locked) > 0
  );
  console.log('Balances:');
  console.table(
    relevant.map((b) => ({
      asset: b.asset,
      free: b.free.toString(),
      locked: b.locked.toString(),
      total: b.free.plus(b.locked).toString(),
    }))
  );

  console.log('\nOpen orders:');
  const openOrders = await binanceClient.getOpenOrders(SYMBOL);
  if (openOrders.length === 0) {
    console.log('  (none)');
  } else {
    console.table(
      openOrders.map((o: any) => ({
        orderId: o.orderId,
        side: o.side,
        type: o.type,
        price: o.price,
        stopPrice: o.stopPrice,
        origQty: o.origQty,
        status: o.status,
        time: formatTime(o.time),
      }))
    );
  }

  console.log('\nRecent orders (last 10):');
  const allOrders = await binanceClient.getAllOrders(SYMBOL, 10);
  if (allOrders.length === 0) {
    console.log('  (none)');
  } else {
    console.table(
      allOrders.map((o: any) => ({
        orderId: o.orderId,
        side: o.side,
        type: o.type,
        price: o.price,
        origQty: o.origQty,
        executedQty: o.executedQty,
        status: o.status,
        time: formatTime(o.time),
      }))
    );
  }

  console.log('\nRecent trades (last 10):');
  const trades = await binanceClient.getMyTrades(SYMBOL, 10);
  if (trades.length === 0) {
    console.log('  (none)');
  } else {
    console.table(
      trades.map((t: any) => ({
        id: t.id,
        orderId: t.orderId,
        side: t.isBuyer ? 'BUY' : 'SELL',
        price: t.price,
        qty: t.qty,
        quoteQty: t.quoteQty,
        commission: `${t.commission} ${t.commissionAsset}`,
        time: formatTime(t.time),
      }))
    );
  }
}

main().catch((err) => {
  console.error('Failed to fetch orders:', err.message);
  process.exit(1);
});
