/**
 * When do the USDC daily options trade, on the real and the test exchange? Trades by
 * weekday and UTC hour over the last 30 days (7 on the test exchange), plus the median
 * distance of each trade from the mark, a proxy for the bid/ask spread at that hour.
 *
 *   npm run liquidity
 */
const MON = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
const expMs = (e) => Date.UTC(2000 + Number(e.slice(-2)), MON[e.slice(-5, -2).toUpperCase()], Number(e.slice(0, -5)), 8);
async function pull(base, days, maxCalls) {
  const end = Date.now(), start = end - days * 86400_000;
  const all = []; let cursor = end;
  for (let i = 0; i < maxCalls; i++) {
    const u = `${base}/public/get_last_trades_by_currency_and_time?currency=USDC&kind=option&start_timestamp=${start}&end_timestamp=${cursor}&count=1000&sorting=desc`;
    const r = (await (await fetch(u)).json()).result;
    const t = r?.trades ?? [];
    all.push(...t);
    if (!r?.has_more || !t.length) break;
    cursor = t[t.length - 1].timestamp - 1;
  }
  return all;
}
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function report(label, trades, days) {
  const daily = trades.filter((t) => /^(BTC|ETH|SOL)_USDC-/.test(t.instrument_name) && expMs(t.instrument_name.split('-')[1]) - t.timestamp < 2 * 86400_000 && expMs(t.instrument_name.split('-')[1]) > t.timestamp);
  console.log(`\n=== ${label}: ${trades.length} USDC option trades in ${days} days, ${daily.length} on expiries within 2 days`);
  const byCoin = {};
  for (const t of daily) { const c = t.instrument_name.split('_')[0]; byCoin[c] = (byCoin[c] ?? 0) + 1; }
  console.log('by coin:', byCoin);
  // Hour of day: trades and median |price-mark|/mark.
  const hours = Array.from({ length: 24 }, () => ({ n: 0, edges: [], notional: 0 }));
  const dows = Array.from({ length: 7 }, () => ({ n: 0 }));
  for (const t of daily) {
    const d = new Date(t.timestamp);
    const h = hours[d.getUTCHours()];
    h.n += 1;
    if (t.mark_price > 0) h.edges.push(Math.abs(t.price - t.mark_price) / t.mark_price);
    h.notional += (t.amount ?? 0) * (t.index_price ?? 0);
    dows[d.getUTCDay()].n += 1;
  }
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
  const max = Math.max(...hours.map((h) => h.n));
  console.log('UTC hour | trades/day | bar | median distance from mark');
  hours.forEach((h, i) => console.log(`${String(i).padStart(5)}h | ${(h.n / days).toFixed(1).padStart(10)} | ${'#'.repeat(Math.round((40 * h.n) / max)).padEnd(40)} | ${Number.isFinite(med(h.edges)) ? (100 * med(h.edges)).toFixed(1) + '%' : '-'}`));
  const weeks = days / 7;
  console.log('weekday | trades/day');
  dows.forEach((d, i) => console.log(`${DOW[i].padStart(7)} | ${(d.n / weeks).toFixed(0)}`));
  // Windows: entry window vs alternatives.
  const win = (a, b) => daily.filter((t) => { const h = new Date(t.timestamp).getUTCHours(); return h >= a && h < b; });
  for (const [a, b] of [[8, 10], [10, 12], [12, 16], [16, 20], [20, 24], [0, 8]]) {
    const w = win(a, b);
    console.log(`window ${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')} UTC: ${(w.length / days / (b - a)).toFixed(1)} trades/hour/day, median distance from mark ${(100 * med(w.filter((t) => t.mark_price > 0).map((t) => Math.abs(t.price - t.mark_price) / t.mark_price))).toFixed(1)}%`);
  }
}
const main = await pull('https://history.deribit.com/api/v2', 30, 150);
report('REAL exchange', main, 30);
const test = await pull('https://test.deribit.com/api/v2', 7, 60);
report('TEST exchange', test, 7);
