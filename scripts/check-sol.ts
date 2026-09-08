import { binanceClient } from '../src/shared/binance';
async function main() {
  try {
    const info = await binanceClient.getExchangeInfo('SOLUSDT');
    console.log('SOLUSDT info:', info);
    const ticker = await binanceClient.getTicker24h('SOLUSDT');
    console.log('SOLUSDT 24h:', {
      lastPrice: ticker.lastPrice.toString(),
      priceChangePercent: ticker.priceChangePercent.toString(),
      volume: ticker.volume.toString(),
    });
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}
main();
