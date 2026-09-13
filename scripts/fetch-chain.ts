/**
 * Fetch and cache today's option chains for BTC, ETH and SOL.
 *
 *   npm run chain
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { MARKETS, type MarketId } from '../lib/markets.ts';
import { getChain } from '../lib/deribit.ts';

await mkdir('data', { recursive: true });
for (const id of Object.keys(MARKETS) as MarketId[]) {
  const chain = await getChain(MARKETS[id]);
  await writeFile(`data/chain-${id}.json`, JSON.stringify(chain));
  const expiries = new Set(chain.options.map((o) => o.expiry)).size;
  console.log(`${id}: ${chain.options.length} options across ${expiries} expiries, index $${chain.spot.toLocaleString('en-US')}`);
}
