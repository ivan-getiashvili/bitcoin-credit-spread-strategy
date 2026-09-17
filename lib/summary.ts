/**
 * The dashboard as plain text, for readers that do not run JavaScript: AI assistants
 * fetching the link, search crawlers, link previews, browsers with scripts off.
 *
 * page/index.html draws everything in the browser from /api/state, so without this a
 * fetch of https://cryptospread.trade returned an empty shell ("connecting…", dashes).
 * The Worker builds the same information here, from the same data, and serves it
 *   - inside the page (hidden by the page's own script once the dashboard has drawn),
 *   - as Markdown at /llms.txt, and at / for clients that ask for text/markdown.
 *
 * Numbers are formatted by hand, not with toLocaleString: the Worker has 10 ms of CPU
 * per request, and Intl formatting is the slow part of a page like this.
 */

export const SITE = 'https://cryptospread.trade';
export const REPO = 'https://github.com/ivan-getiashvili/bitcoin-credit-spread-strategy';

export type Block =
  | { h: string }
  | { p: string }
  | { list: string[] }
  | { links: [label: string, url: string, note?: string][] }
  | { table: { head: string[]; rows: string[][] } };

export type Summary = { title: string; description: string; updated: string | null; blocks: Block[] };

/** What `about` needs; the view and bot.config.json both carry it. */
export type StrategyFacts = {
  entry: { fromUtc: string; toUtc: string; weekdays?: number[] };
  strategy?: { expiry?: string; distanceAtr?: number; atrDays?: number; longSteps?: number };
  markets: { id: string; enabled: boolean; structure?: string }[];
  riskPct: number;
  capitalUsd?: number;
  mode: string;
  execution?: Record<string, number>;
  maxOpenSpreads?: number;
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MARGIN: Record<string, string> = { segregated_sm: 'standard margin', cross_sm: 'standard margin, cross', segregated_pm: 'portfolio margin', cross_pm: 'portfolio margin, cross' };
const STATE: Record<string, string> = { safe: 'safe', watch: 'near the sold strike', breached: 'past the sold strike' };
const MAX_DEALS = 100;
const MAX_DAYS = 120;

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const group = (s: string) => {
  const dot = s.indexOf('.');
  const whole = dot < 0 ? s : s.slice(0, dot);
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dot < 0 ? '' : s.slice(dot));
};
const num = (x: unknown, d = 0) => (fin(x) ? `${x < 0 ? '-' : ''}${group(Math.abs(x).toFixed(d))}` : 'n/a');
const money = (x: unknown, d = 2) => (fin(x) ? `${x < 0 ? '-' : ''}$${group(Math.abs(x).toFixed(d))}` : 'n/a');
const signed = (x: unknown, d = 2) => (fin(x) ? `${x > 0 ? '+' : x < 0 ? '-' : ''}$${group(Math.abs(x).toFixed(d))}` : 'n/a');
const signedPct = (x: unknown, d = 2) => (fin(x) ? `${x > 0 ? '+' : x < 0 ? '-' : ''}${group(Math.abs(x).toFixed(d))}%` : 'n/a');
const strike = (k: number) => num(k, k % 1 ? 1 : 0);
const two = (n: number) => String(n).padStart(2, '0');
/** 17 Sep 2026 13:03 UTC */
const utc = (t: number | string) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? 'n/a' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
};
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The one-sentence strategy description, the same wording as the page header. */
export function about(f: StrategyFacts): string {
  const parts = f.markets.filter((m) => m.enabled).map((m) => `a ${m.structure === 'call' ? 'call' : 'put'} spread on ${m.id}`);
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? 'a spread';
  const st = f.strategy ?? {};
  const when = f.entry.weekdays?.length ? `Every ${f.entry.weekdays.map((d) => DAYS[d]).join(' and ')}` : 'Every day';
  const where = (st.distanceAtr ?? 0) > 0
    ? `the sold strike at least ${num(st.distanceAtr, 1)} × the ${st.atrDays}-day average daily move from the price`
    : 'the sold strike the first one out of the money';
  const steps = st.longSteps ?? 1;
  const exp = st.expiry === 'weekly' ? 'the next Friday expiry' : 'the next daily expiry';
  return `${when} at ${f.entry.fromUtc} UTC the bot sells ${what} at Deribit: ${where}, the bought strike ${steps} strike${steps === 1 ? '' : 's'} further out, on ${exp}, held to settlement. Each spread risks ${num(f.riskPct, 1)}% of the account.`;
}

const coins = (f: StrategyFacts) => f.markets.filter((m) => m.enabled).map((m) => m.id).join(' and ') || 'crypto';

export function metaDescription(f: StrategyFacts): string {
  const weekly = f.strategy?.expiry === 'weekly' ? 'weekly ' : '';
  return `Live dashboard of an automated trading bot that sells ${weekly}credit spreads on ${coins(f)} options at Deribit: account value, open positions, every deal, win rate, profit factor, Sharpe, Sortino and drawdown, updated every minute.`;
}

function account(f: StrategyFacts) {
  return f.mode === 'live'
    ? 'a real-money Deribit account'
    : `a ${fin(f.capitalUsd) ? `${money(f.capitalUsd, 0)} ` : ''}demo account on the Deribit test exchange`;
}

function rules(f: StrategyFacts): string[] {
  const x = f.execution ?? {};
  const mid = x.buyLongMinutes ?? 15;
  const take = x.takeMinutes ?? 15;
  return [
    `Entry: ${about(f)}`,
    'A credit spread is two options of the same type and expiry: one sold closer to the price, one bought further out as protection. The premium difference is collected up front (the credit); the most it can lose is the distance between the strikes minus the credit.',
    `Size: each spread is sized so that its maximum loss is ${num(f.riskPct, 1)}% of the current account value${fin(f.maxOpenSpreads) ? `, with at most ${f.maxOpenSpreads} spreads open` : ''}. The whole spread is one position with one risk; it is never resized to fit margin, only skipped.`,
    `Orders: limit orders only. Each leg rests at the mid price for ${mid} minutes; after that it may cross to the other side of the order book for ${take} minutes, never past the price the risk budget allows. No market orders.`,
    'Leg order: the protective (bought) option is bought first, then the short option is sold for exactly the amount that filled, so the account never holds an uncovered short option. When closing, the short option is bought back first.',
    'If the short leg does not fill, the bought leg is sold back and the deal is recorded as "unwound" with its small realised cost; a bought option is never held on its own.',
    "Exit: spreads are held to expiry and settled at Deribit's delivery price (08:00 UTC).",
    'Costs: Deribit charges 0.03% of the underlying per option leg (capped at 12.5% of the option price) and a 0.015% delivery fee on legs that expire in the money; every figure here is after fees.',
    "Instruments: Deribit's dollar-settled (USDC) linear options, for example BTC_USDC-25SEP26-78000-C; prices, profit and loss are in US dollars.",
    `Account: ${account(f)}. Percentages are measured against the account value when each deal opened.`,
    'Infrastructure: a Cloudflare Worker runs one bot cycle a minute and keeps its state in a Cloudflare D1 database. The website is read-only: nothing reachable from the internet can place or change an order.',
  ];
}

function factsFromView(v: any): StrategyFacts {
  return {
    entry: v.entry,
    strategy: v.strategy,
    markets: (v.markets ?? []).map((m: any) => ({ id: m.id, enabled: Boolean(m.settings?.enabled), structure: m.settings?.structure })),
    riskPct: v.account?.riskPerTradePct,
    capitalUsd: v.account?.capitalUsd,
    mode: v.mode,
    execution: v.execution,
    maxOpenSpreads: v.maxOpenSpreads,
  };
}

const linkBlock = (): Block => ({
  links: [
    ['Live dashboard', `${SITE}/`, 'interactive, needs JavaScript'],
    ['This page as Markdown', `${SITE}/llms.txt`, 'the same content as text, always current'],
    ['All dashboard data as JSON', `${SITE}/api/state`, 'account, metrics, equity series, positions, deals, plans'],
    ['Source code', REPO, 'TypeScript: the bot, the Cloudflare Worker, the dashboard, the backtests'],
  ],
});

/** Everything the dashboard shows, as headings, paragraphs, lists and tables. `view` is /api/state; null before the first cycle. */
export function summarize(view: any | null, fallback: StrategyFacts): Summary {
  const f = view ? factsFromView(view) : fallback;
  const description = metaDescription(f);
  const intro = `Crypto Spread is an automated options-trading bot with a public, read-only dashboard at ${SITE}. ${about(f)} It trades with limit orders only, on ${account(f)}, and this page is its live record: account value, open positions, every finished deal and the performance metrics.`;
  const blocks: Block[] = [{ p: intro }];

  if (!view) {
    blocks.push({ p: 'The bot has not completed its first cycle yet, so there are no figures to show.' }, { h: 'How the bot trades' }, { list: rules(f) }, { h: 'Links' }, linkBlock());
    return { title: 'Crypto Spread', description, updated: null, blocks };
  }

  const v = view;
  const a = v.account ?? {};
  const d = v.metrics?.deals ?? {};
  const e = v.metrics?.equity ?? {};
  const seeded = v.seeded;
  const spreads: any[] = v.spreads ?? [];
  const updated = fin(v.snapshotAt) ? new Date(v.snapshotAt).toISOString() : null;

  blocks.push({ p: `Snapshot taken ${fin(v.snapshotAt) ? utc(v.snapshotAt) : 'just now'}; the bot refreshes it every minute. ${v.entry?.inWindow ? `The entry window is open until ${utc(v.entry.next.to)}.` : v.entry?.next ? `Next entry window: ${utc(v.entry.next.from)} to ${utc(v.entry.next.to)}.` : ''}`.trim() });
  const alerts = [...(v.problems ?? []), v.accountError, v.positionWarning ? `Positions differ from the bot's records: ${v.positionWarning}` : ''].filter(Boolean);
  if (alerts.length) blocks.push({ h: 'Alerts' }, { list: alerts });

  // Performance: the three headline figures and their captions.
  const ex = a.exchange;
  blocks.push({ h: 'Performance' }, {
    list: [
      !v.canTrade ? 'Account value: not connected to the exchange'
        : `Account value${fin(a.capitalUsd) ? ' (demo)' : ''}: ${money(a.valueUsd)}${fin(a.capitalUsd) && fin(a.valueUsd) ? ` (${money(a.capitalUsd, 0)} starting capital, ${signed(a.valueUsd - a.capitalUsd)})` : ''}`,
      fin(a.riskUsd) ? `Risk per spread: ${num(a.riskPerTradePct, 1)}% of the account = ${money(a.riskUsd)}` : '',
      ex ? `Deribit balance: ${num(ex.equity, 2)} USDC, ${num(ex.availableFunds, 0)} free for margin (${MARGIN[ex.marginModel] ?? ex.marginModel})` : '',
      `Unrealised P&L: ${signed(v.totals?.unrealizedUsd)} (${v.totals?.open ?? 0} open spread${v.totals?.open === 1 ? '' : 's'}, ${money(v.totals?.openRiskUsd)} at risk)`,
      `Realised P&L: ${signed(d.netPnlUsd)} (${d.deals ?? 0} finished deal${d.deals === 1 ? '' : 's'}${seeded ? `, ${seeded.deals} of them simulated` : ''})`,
    ].filter(Boolean),
  });
  if (seeded) {
    blocks.push({ p: `Simulated history: figures dated up to ${seeded.to} are simulated, the same strategy run on real ${seeded.markets.join(' and ')} option prices for ${seeded.days} days with fees, so that the metrics are not empty while the real record is short. Every simulated day and deal is labelled. The simulation drops out once the bot has ${seeded.realClosesNeeded - 1} real daily returns (${seeded.realCloses} real day${seeded.realCloses === 1 ? '' : 's'} so far).` });
  }

  // The metric tiles, in the page's order.
  const ready = e.dailyReturns >= 7;
  const waiting = `needs 7 daily returns (${e.dailyReturns ?? 0} so far)`;
  blocks.push({ h: 'Metrics' }, {
    table: {
      head: ['Metric', 'Value', 'Meaning'],
      rows: [
        ['Deals', num(d.deals), `${d.wins ?? 0} won, ${d.losses ?? 0} lost`],
        ['Win rate', fin(d.winRatePct) ? `${num(d.winRatePct, 1)}%` : 'n/a', `${d.wins ?? 0} of ${d.deals ?? 0} deals`],
        ['Average gain per deal', signedPct(d.avgGainPct, 3), 'of the account value when the deal opened'],
        ['Average win', signedPct(d.avgWinPct, 3), fin(d.avgWinUsd) ? `${signed(d.avgWinUsd)} per winning deal` : 'of the account value'],
        ['Average loss', signedPct(d.avgLossPct, 3), fin(d.avgLossUsd) ? `${signed(-d.avgLossUsd)} per losing deal` : 'of the account value'],
        ['Return on risk', fin(d.avgR) ? signedPct(d.avgR * 100, 1) : 'n/a', "average P&L per deal divided by that deal's maximum loss"],
        ['Risk : reward', fin(d.realizedRiskToReward) ? `${num(d.realizedRiskToReward, 2)} : 1` : 'n/a', 'average loss per average win'],
        ['Profit factor', d.deals && d.losses === 0 && d.wins > 0 ? 'infinite' : fin(d.profitFactor) ? num(d.profitFactor, 2) : 'n/a', 'gross profit divided by gross loss'],
        ['Expectancy', signed(d.expectancyUsd), 'average P&L per deal'],
        ['Total return', signedPct(e.strategyReturnPct, 2), fin(e.since) ? `since ${utc(e.since)}` : 'since the first sample'],
        ['Sharpe ratio', ready ? num(e.sharpe, 2) : 'n/a', ready ? `annualised, from ${e.dailyReturns} daily returns${seeded ? ` (${seeded.days} days simulated)` : ''}` : waiting],
        ['Sortino ratio', ready ? num(e.sortino, 2) : 'n/a', ready ? 'like Sharpe, but only losing days count as risk' : waiting],
        ['Max drawdown', fin(e.maxDrawdownUsd) ? signed(-e.maxDrawdownUsd) : 'n/a', fin(e.maxDrawdownPct) ? `${num(e.maxDrawdownPct, 2)}% from the peak` : 'on the strategy line'],
        ['Best / worst deal', `${signedPct(d.bestDealPct, 2)} / ${signedPct(d.worstDealPct, 2)}`, `longest losing streak: ${d.maxConsecutiveLosses ?? 0}`],
        ['Max loss : credit', fin(d.plannedRiskToReward) ? `${num(d.plannedRiskToReward, 1)} : 1` : 'n/a', 'average, as filled at entry'],
      ],
    },
  });

  const open = spreads.filter((s) => ['opening', 'open', 'long-only', 'closing'].includes(s.status));
  blocks.push({ h: `Open spreads (${open.length} of ${v.maxOpenSpreads} allowed)` });
  if (!open.length) blocks.push({ p: 'No open spreads.' });
  else {
    blocks.push({
      table: {
        head: ['Coin', 'Type', 'Status', 'Expires', 'Sold / bought strike', 'Size', 'Credit', 'Max loss', 'Risk budget', 'Unrealised P&L', 'Price from sold strike', 'Market odds it stays safe'],
        rows: open.map((sp) => {
          const L = sp.live;
          const status = sp.status === 'open' && L ? STATE[L.state] ?? L.state : sp.status === 'long-only' ? 'bought leg only' : sp.status;
          return [
            sp.market, `${sp.type ?? 'put'} spread`, status,
            `${utc(sp.expiryMs)}${L ? ` (${num(Math.max(L.daysLeft, 0), 1)} days left)` : ''}`,
            `${strike(sp.shortStrike)} / ${strike(sp.longStrike)}`,
            `${sp.amount} ${sp.market}`,
            sp.creditUsd ? money(sp.creditUsd * sp.amount) : 'n/a',
            sp.maxLossUsd ? money(sp.maxLossUsd * sp.amount) : 'n/a',
            money(sp.riskUsd),
            `${signed(L?.unrealizedUsd)}${L && fin(L.unrealizedR) ? ` (${signedPct(L.unrealizedR * 100, 0)} of max loss)` : ''}`,
            L ? `${num(L.distancePct, 2)}%` : 'n/a',
            L && fin(L.chanceAboveShortPct) ? `${num(L.chanceAboveShortPct)}%` : 'n/a',
          ];
        }),
      },
    });
    const notes = open.filter((sp) => sp.note).map((sp) => `${sp.market}: ${sp.note}`);
    if (notes.length) blocks.push({ list: notes });
  }

  const jobs: any[] = v.jobs ?? [];
  blocks.push({ h: 'Working orders (limit orders resting on Deribit)' });
  if (!jobs.length) blocks.push({ p: 'No orders working.' });
  else {
    blocks.push({
      table: {
        head: ['Coin', 'Doing', 'Instrument', 'Limit price', 'Filled', 'Deadline'],
        rows: jobs.map((j) => [
          j.market,
          `${j.kind === 'entry' ? 'Opening' : 'Closing'}, step ${j.step ?? '?'} of 2: ${j.says ?? ''}${j.error ? ` (${j.error})` : ''}`,
          j.instrument ?? '',
          j.order ? `${j.order.side === 'buy' ? 'Buy' : 'Sell'} at ${num(j.order.price, 2)} USDC` : 'placing',
          j.order ? `${j.order.filled} / ${j.order.amount}` : '',
          fin(j.deadlineAt) ? utc(j.deadlineAt) : '',
        ]),
      },
    });
  }

  const positions: any[] = v.positions ?? [];
  blocks.push({ h: 'Positions on Deribit (as the exchange reports them, in USDC)' });
  if (!positions.length) blocks.push({ p: v.canTrade ? 'No USDC option positions on the account.' : 'Not connected to the exchange.' });
  else {
    blocks.push({
      table: {
        head: ['Instrument', 'Size', 'Average price', 'Mark', 'Unrealised P&L', 'Delta'],
        rows: positions.map((p) => [p.instrument, `${p.size > 0 ? '+' : ''}${p.size}`, num(p.averagePrice, 2), num(p.markPrice, 2), signed(p.floatingPnlUsd), num(p.delta, 3)]),
      },
    });
  }

  // The coin cards: price, and the spread the bot would open right now.
  blocks.push({ h: 'Coins and the spread the bot would open now' });
  const w = v.entry ?? {};
  const every = w.weekdays?.length ? `every ${w.weekdays.map((x: number) => DAYS[x]).join(' and ')}` : 'every day';
  blocks.push({
    list: (v.markets ?? []).map((m: any) => {
      if (!m.tradingOn && !m.settings?.enabled && !fin(m.spot)) return `${m.id}: not traded (switched off).`;
      const dp = m.id === 'SOL' ? 2 : 0;
      const p = m.plan;
      const z = m.size;
      const type = p?.type ?? (m.settings?.structure === 'call' ? 'call' : 'put');
      const out = [`${m.id}: price ${money(m.spot, dp)}.`];
      out.push(m.tradingOn ? `Trading on: opens one ${type} spread ${every} between ${w.fromUtc} and ${w.toUtc} UTC.` : 'Paused: no new spreads.');
      if (fin(m.sma50) && fin(m.spot)) out.push(`Price is ${m.spot > m.sma50 ? 'above' : 'below'} its 50-day average of ${money(m.sma50, dp)}.`);
      if (p) {
        out.push(`The spread now, at mid prices after fees: buy the ${strike(p.longStrike)} ${type}, then sell the ${strike(p.shortStrike)} ${type}, expiring ${utc(p.expiryMs)} (${num(p.hoursToExpiry / 24, 1)} days).`);
        if (z && z.amount > 0) out.push(`Size for ${num(a.riskPerTradePct, 1)}% risk: ${z.amount} ${m.id}; collects ${money(p.creditUsd * z.amount)}, maximum loss ${money(p.maxLossUsd * z.amount)}.`);
        else if (z) out.push(`Even the smallest order (${z.minAmount} ${m.id}) would risk more than ${money(z.riskUsd)}.`);
        out.push(`Sold ${type} is ${num(p.distancePct, 2)}% ${type === 'call' ? 'above' : 'below'} the price${fin(m.atrPct) ? ` (expected move to expiry ${num(m.atrPct, 2)}%)` : ''}, strikes ${money(Math.abs(p.shortStrike - p.longStrike), dp)} apart, maximum loss ${num(p.lossToCredit, 1)} × the credit, market odds of profit ${num(p.marketWinPct)}%.`);
        if (z && z.amount > 0 && fin(z.marginUsd)) out.push(`Margin for this spread: ${money(z.marginUsd, 0)} of ${money(z.freeMarginUsd, 0)} free (${MARGIN[z.marginModel] ?? z.marginModel}).`);
      } else if (m.tradingOn || m.error) {
        out.push(m.error ? `Price feed error: ${m.error}` : m.skip ?? 'No plan yet.');
      }
      if (m.working) out.push('Entry orders are working.');
      else if (m.enteredToday) out.push('Entered today.');
      return out.join(' ');
    }),
  });

  const done = spreads.filter((s) => ['closed', 'settled', 'cancelled', 'unwound'].includes(s.status));
  blocks.push({ h: `Finished deals (${done.length})` });
  if (!done.length) blocks.push({ p: 'No finished deals yet.' });
  else {
    if (done.length > MAX_DEALS) blocks.push({ p: `The latest ${MAX_DEALS} are listed; all of them are in ${SITE}/api/state.` });
    blocks.push({
      table: {
        head: ['Coin', 'Type', 'Opened', 'Finished', 'Settlement price', 'Sold / bought strike', 'Size', 'Credit', 'Max loss', 'P&L', '% of account', '% of max loss', 'Result'],
        rows: done.slice(0, MAX_DEALS).map((sp) => {
          const risk = sp.openedAmount * sp.maxLossUsd;
          const onRisk = risk > 0 && fin(sp.pnlUsd) ? (100 * sp.pnlUsd) / risk : NaN;
          const onAccount = sp.accountUsdAtEntry > 0 && fin(sp.pnlUsd) ? (100 * sp.pnlUsd) / sp.accountUsdAtEntry : NaN;
          const result = sp.status === 'cancelled' ? 'cancelled' : sp.status === 'unwound' ? 'unwound' : sp.pnlUsd > 0 ? 'win' : sp.pnlUsd < 0 ? 'loss' : 'flat';
          return [
            sp.market, `${sp.type ?? 'put'} spread`, utc(sp.openedAt), sp.closedAt ? utc(sp.closedAt) : 'n/a',
            sp.settlePrice ? money(sp.settlePrice, sp.market === 'SOL' ? 2 : 0) : 'n/a',
            `${strike(sp.shortStrike)} / ${strike(sp.longStrike)}`, String(sp.openedAmount),
            sp.creditUsd ? money(sp.creditUsd * sp.openedAmount) : 'n/a', risk ? money(risk) : 'n/a',
            signed(sp.pnlUsd), signedPct(onAccount, 3), signedPct(onRisk, 1), sp.simulated ? `${result} (simulated)` : result,
          ];
        }),
      },
    });
  }

  // The chart as numbers: the last sample of each UTC day.
  const byDay = new Map<string, any>();
  for (const s of v.series ?? []) if (fin(s.t)) byDay.set(day(s.t), s);
  const days = [...byDay.entries()].slice(-MAX_DAYS);
  if (days.length) {
    blocks.push({ h: 'Account value by day (the equity curve)' }, { p: `The last value of each UTC day. "Strategy P&L" is realised plus unrealised profit of this bot's deals, at Deribit's marks.${seeded ? ` Days up to ${seeded.to} are simulated.` : ''}` }, {
      table: {
        head: ['Date', 'Account value', 'Strategy P&L', 'Record'],
        rows: days.map(([date, s]) => [date, money(s.equityUsd), signed(s.strategyUsd), seeded && date <= seeded.to ? 'simulated' : 'real']),
      },
    });
  }

  blocks.push({ h: 'How the bot trades' }, { list: rules(f) }, { h: 'Links' }, linkBlock());
  return { title: 'Crypto Spread', description, updated, blocks };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** A table cell cannot hold a pipe or a line break in Markdown. */
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ');

export function toHtml(s: Summary): string {
  return s.blocks.map((b) => {
    if ('h' in b) return `<h2>${esc(b.h)}</h2>`;
    if ('p' in b) return `<p>${esc(b.p)}</p>`;
    if ('list' in b) return `<ul>${b.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    if ('links' in b) return `<ul>${b.links.map(([label, url, note]) => `<li><a href="${esc(url)}">${esc(label)}</a>: ${esc(url)}${note ? ` (${esc(note)})` : ''}</li>`).join('')}</ul>`;
    return `<table><thead><tr>${b.table.head.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${b.table.rows.map((r) => `<tr>${r.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }).join('\n');
}

export function toMarkdown(s: Summary): string {
  const out = [`# ${s.title}`, '', `> ${s.description}`, ''];
  for (const b of s.blocks) {
    if ('h' in b) out.push(`## ${b.h}`, '');
    else if ('p' in b) out.push(b.p, '');
    else if ('list' in b) out.push(...b.list.map((x) => `- ${x}`), '');
    else if ('links' in b) out.push(...b.links.map(([label, url, note]) => `- [${label}](${url})${note ? `: ${note}` : ''}`), '');
    else out.push(`| ${b.table.head.map(cell).join(' | ')} |`, `|${b.table.head.map(() => ' --- ').join('|')}|`, ...b.table.rows.map((r) => `| ${r.map(cell).join(' | ')} |`), '');
  }
  return out.join('\n');
}

/** Tags for the page head: description, link previews, the text alternatives, and schema.org data. */
export function headTags(s: Summary): string {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: s.title,
    url: `${SITE}/`,
    description: s.description,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Any (web browser)',
    isAccessibleForFree: true,
    inLanguage: 'en',
    ...(s.updated ? { dateModified: s.updated } : {}),
    author: { '@type': 'Person', name: 'Ivan Getiashvili', url: 'https://github.com/ivan-getiashvili' },
    sameAs: [REPO],
  };
  return [
    `<meta name="description" content="${esc(s.description)}">`,
    '<meta name="robots" content="index, follow, max-snippet:-1">',
    `<link rel="canonical" href="${SITE}/">`,
    `<link rel="alternate" type="text/markdown" href="${SITE}/llms.txt" title="This page as Markdown">`,
    `<link rel="alternate" type="application/json" href="${SITE}/api/state" title="All dashboard data as JSON">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${esc(s.title)}">`,
    `<meta property="og:title" content="${esc(s.title)}: automated credit spreads on crypto options">`,
    `<meta property="og:description" content="${esc(s.description)}">`,
    `<meta property="og:url" content="${SITE}/">`,
    '<meta name="twitter:card" content="summary">',
    // "<" cannot appear raw inside a script element without risking an early close.
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  ].join('\n');
}
