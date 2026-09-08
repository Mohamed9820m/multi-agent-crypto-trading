import { binanceClient } from '../src/shared/binance';
import Decimal from 'decimal.js';
async function main() {
  const symbol = process.argv[2] || 'SOLUSDT';
  const query = (binanceClient as any).signedQuery({ symbol });
  const { data } = await (binanceClient as any).client.get(`/fapi/v2/positionRisk?${query}`);
  const pos = data.find((p: any) => p.symbol === symbol);
  if (!pos || new Decimal(pos.positionAmt).eq(0)) { console.log('flat'); return; }
  console.log('position:', pos.positionAmt);
}
main().catch(console.error);
