/**
 * The put spread bot. Every day, on each coin that is switched on, it opens Ivan's
 * daily bull put spread on a real Deribit account (the test exchange by default),
 * using limit orders only, and serves a live dashboard at http://127.0.0.1:4191.
 *
 *   npm run bot
 *   npm run bot -- --config other.json
 *
 * Options are Deribit's USDC-settled ones (Deribit lists no USDT options), so every
 * premium, risk figure and P&L is in dollars. A spread is one trade with one risk:
 * the pair together may lose at most `riskPerTradePct` of the account value. With
 * `capitalUsd` set, the account value is that demo capital plus the bot's own P&L,
 * whatever the exchange balance. Coins trade by default; the dashboard switch pauses
 * one. The dashboard listens on 127.0.0.1 only.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { DeribitBroker, type AccountView, type Broker, type PositionView } from '../lib/broker.ts';
import { getChain, getInstrumentSpecs, getOrderBook, getRecentDeliveryPrices, MAINNET, TESTNET, type InstrumentSpec, type Option } from '../lib/deribit.ts';
import {
  advanceJob, LEG, openEntry, openExit, phaseLimitMs, planDailySpread, settleSpread, sizeFor, stopJob,
  type ExecSettings, type JobContext, type MarketSettings, type Plan, type SpreadRecord,
} from '../lib/executor.ts';
import { DOLLAR_MARKETS as M, type MarketId } from '../lib/markets.ts';
import { dealStats, downsample, equityStats } from '../lib/metrics.ts';
import { viewSpread } from '../lib/monitor.ts';
import { addEvent, appendSample, loadSamples, loadState, saveState } from '../lib/store.ts';

type BotConfig = {
  mode: 'testnet' | 'live';
  /** Private dashboard with the trade buttons. Keep it behind a login when it is online. */
  port: number;
  /** Read-only public dashboard: the same live data, no buttons, and no routes that change anything. */
  publicPort?: number;
  /** Extra origins allowed to press the buttons, e.g. the private dashboard's https address behind a login. */
  controlOrigins?: string[];
  /** Order work, positions and account refresh, seconds. */
  pollSeconds: number;
  /** Option chains, plans, settlement and the entry-window check, seconds. */
  chainSeconds: number;
  /** One account-value sample per this many seconds. */
  sampleSeconds: number;
  /** Demo account value in dollars: risk and returns are measured against this plus the bot's P&L. null uses the exchange balance. */
  capitalUsd: number | null;
  /** Share of the current account value one whole spread may lose, percent. */
  riskPerTradePct: number;
  /** Across all coins. One spread per coin per day. */
  maxOpenSpreads: number;
  /** A spread turns "watch" when price is within this % above the sold put. */
  alertDistancePct: number;
  /** Daily entry window, UTC. Deribit's options day starts at the 08:00 UTC settlement. */
  entry: { fromUtc: string; toUtc: string };
  execution: ExecSettings;
  markets: Record<MarketId, MarketSettings>;
  stateFile?: string;
  equityFile?: string;
};

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const config: BotConfig = JSON.parse(readFileSync(arg('config') ?? 'bot.config.json', 'utf8'));
const mode = (arg('mode') ?? config.mode) as BotConfig['mode'];
if (mode !== 'testnet' && mode !== 'live') throw new Error(`Unknown mode "${mode}": use testnet or live`);
try { process.loadEnvFile('.env'); } catch { /* keys can also come from the environment */ }

const IDS = Object.keys(M) as MarketId[];
const stateFile = config.stateFile ?? `data/bot-state-${mode}.json`;
const equityFile = config.equityFile ?? `data/equity-${mode}.jsonl`;
const state = loadState(stateFile, Object.fromEntries(IDS.map((id) => [id, config.markets[id].enabled])) as Record<MarketId, boolean>);
const samples = loadSamples(equityFile);
const save = () => saveState(stateFile, state);
const problems: string[] = [];

const ONCE = process.argv.includes('--once');

// One bot per account: two copies would each open the day's spreads. A scheduled
// run (--once) relies on its GitHub Actions concurrency group instead of this lock.
const lockFile = `${stateFile}.lock`;
if (!ONCE) try {
  const other = Number(readFileSync(lockFile, 'utf8'));
  if (other && other !== process.pid) {
    process.kill(other, 0); // throws if that process is gone, leaving a stale lock
    console.error(`Another copy of the bot (process ${other}) is already running on this account. Stop it first.`);
    process.exit(1);
  }
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT' && code !== 'ESRCH') {
    console.error(`Could not confirm no other copy of the bot is running (${code}). Not starting.`);
    process.exit(1);
  }
}
if (!ONCE) {
  mkdirSync(dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, String(process.pid));
}
process.on('exit', () => {
  try { if (Number(readFileSync(lockFile, 'utf8')) === process.pid) unlinkSync(lockFile); } catch { /* already gone */ }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
const r8 = (x: number) => Math.round(x * 1e8) / 1e8;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

let broker: Broker | null = null;
if (mode === 'testnet') {
  const id = process.env.DERIBIT_TESTNET_CLIENT_ID;
  const secret = process.env.DERIBIT_TESTNET_CLIENT_SECRET;
  if (id && secret) broker = new DeribitBroker('testnet', id, secret);
  else problems.push('Connect your Deribit test account: paste DERIBIT_TESTNET_CLIENT_ID and DERIBIT_TESTNET_CLIENT_SECRET into the .env file in the project folder, then restart the bot. Prices show; nothing can trade yet.');
} else {
  const id = process.env.DERIBIT_CLIENT_ID;
  const secret = process.env.DERIBIT_CLIENT_SECRET;
  if (process.env.DERIBIT_ALLOW_LIVE !== 'real-money') problems.push('Live mode is locked because it trades real money. Nothing can trade.');
  else if (!id || !secret) problems.push('Live keys missing: add DERIBIT_CLIENT_ID and DERIBIT_CLIENT_SECRET to .env.');
  else broker = new DeribitBroker('live', id, secret);
}
const base = mode === 'live' ? MAINNET : TESTNET;

type Sizing = { amount: number; riskUsd: number; minAmount: number; marginUsd?: number; freeMarginUsd?: number; marginModel?: string };
type MarketSnap = { spot?: number; sma50?: number; plan?: Plan; skip?: string; error?: string; size?: Sizing };
const chains: Partial<Record<MarketId, { options: Option[]; spot: number }>> = {};
const snaps: Record<MarketId, MarketSnap> = { BTC: {}, ETH: {}, SOL: {} };
const sma: Partial<Record<MarketId, { at: number; value: number }>> = {};
const specs: Partial<Record<MarketId, { at: number; map: Map<string, InstrumentSpec> }>> = {};
// Kept in the saved state, so scheduled runs remember them from one cycle to the next.
const lastSkip = (state.lastSkip ??= {});
const retryAt = (state.retryAt ??= {});
const jobErrors = new Map<string, string>();
let positions: PositionView[] = [];
let accounts: AccountView[] = [];
let exchangeEquityUsd = NaN;
let unpriced: string[] = [];
let accountError = '';
let positionWarning = '';
let pendingMismatch = '';
let lastChainAt = 0;
let lastSampleAt = samples.at(-1)?.t ?? 0;

const clients = new Set<ServerResponse>();
const publicClients = new Set<ServerResponse>();

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
  addEvent(state, msg, level);
  save();
  (level === 'info' ? console.log : console.warn)(`[${new Date().toISOString()}] ${msg}`);
  push();
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const dayKey = (now = new Date()) => now.toISOString().slice(0, 10);

function inEntryWindow(now = new Date()): boolean {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return m >= minutes(config.entry.fromUtc) && m < minutes(config.entry.toUtc);
}

function nextWindow(now = new Date()): { from: string; to: string } {
  let day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (day + minutes(config.entry.toUtc) * 60_000 <= now.getTime()) day += 86_400_000;
  return {
    from: new Date(day + minutes(config.entry.fromUtc) * 60_000).toISOString(),
    to: new Date(day + minutes(config.entry.toUtc) * 60_000).toISOString(),
  };
}

const LIVE = new Set<SpreadRecord['status']>(['opening', 'open', 'long-only', 'closing']);
const activeSpreads = () => state.spreads.filter((s) => LIVE.has(s.status));
const workingJobs = () => state.jobs.filter((j) => j.phase !== 'done');

async function specsFor(id: MarketId): Promise<Map<string, InstrumentSpec>> {
  const cached = specs[id];
  if (cached && Date.now() - cached.at < 6 * 3_600_000) return cached.map;
  const map = await getInstrumentSpecs(M[id], base);
  specs[id] = { at: Date.now(), map };
  return map;
}

function contextFor(id: MarketId, b: Broker, map: Map<string, InstrumentSpec>): JobContext {
  return {
    broker: b,
    market: M[id],
    exec: config.execution,
    book: (name) => getOrderBook(name, 5, b.base),
    spec: (name) => map.get(name),
    index: () => chains[id]?.spot ?? 0,
    now: () => Date.now(),
    save,
    log,
  };
}

/** Realised P&L of finished deals plus unrealised P&L of open ones; NaN if an open spread cannot be valued yet. */
function strategyPnlUsd(): number {
  let total = 0;
  for (const sp of state.spreads) {
    if (sp.status === 'closed' || sp.status === 'settled') total += sp.pnlUsd ?? 0;
    else if (LIVE.has(sp.status) && (sp.amount > 0 || sp.spareLong > 0)) {
      const live = viewSpread(M[sp.market], sp, chains[sp.market], config.alertDistancePct).live;
      if (!live) return NaN;
      total += live.unrealizedUsd;
    }
  }
  return total;
}

/** The account value risk is sized from: demo capital plus the bot's P&L, or the exchange balance. */
function accountValueUsd(): number {
  if (config.capitalUsd === null || config.capitalUsd === undefined) return exchangeEquityUsd;
  const pnl = strategyPnlUsd();
  return Number.isFinite(pnl) ? config.capitalUsd + pnl : NaN;
}

async function refreshMarket(id: MarketId) {
  const market = M[id];
  const chain = await getChain(market, base);
  chains[id] = chain;
  if (!sma[id] || Date.now() - sma[id]!.at > 30 * 60_000) {
    try {
      const prices = Object.entries(await getRecentDeliveryPrices(market.indexName, 60, base))
        .sort(([a], [b]) => (a < b ? 1 : -1))
        .slice(0, 50)
        .map(([, p]) => p);
      if (prices.length === 50) sma[id] = { at: Date.now(), value: sum(prices) / 50 };
    } catch { /* informational only */ }
  }
  const planned = planDailySpread(market, chain, config.markets[id]);
  let size: Sizing | undefined;
  if ('plan' in planned) {
    const spec = (await specsFor(id)).get(planned.plan.shortName);
    const account = accountValueUsd();
    if (spec && Number.isFinite(account)) {
      const riskUsd = (account * config.riskPerTradePct) / 100;
      size = { amount: sizeFor(planned.plan, riskUsd, spec), riskUsd, minAmount: spec.minAmount };
      if (size.amount > 0) {
        try {
          const m = await marginCheck(id, planned.plan, size.amount);
          if (m) Object.assign(size, { marginUsd: m.neededUsd, freeMarginUsd: m.freeUsd, marginModel: m.model });
        } catch { /* shown on the card only; the entry checks again */ }
      }
    }
  }
  snaps[id] = { spot: chain.spot, sma50: sma[id]?.value, size, ...('plan' in planned ? { plan: planned.plan } : { skip: planned.skip }) };
  return planned;
}

/**
 * Collateral a new spread needs, and what is free for it, under the account's margin model.
 * Entries still opening have not placed all their orders, so their collateral is not locked
 * yet; it is counted here, or two entries started together would both pass the check.
 * Returns null until the account has been read.
 */
async function marginCheck(id: MarketId, plan: Plan, amount: number): Promise<{ neededUsd: number; freeUsd: number; model: string } | null> {
  const currency = M[id].currency;
  const acct = accounts.find((a) => a.currency === currency);
  if (!broker || !acct) return null;
  const opening = state.spreads.filter((s) => s.status === 'opening' && M[s.market].currency === currency);

  if (acct.marginModel.endsWith('_pm')) {
    // Portfolio margin prices the pair as one position: simulate the account with the
    // unfilled parts of opening entries and this spread added, and take the increase.
    const add: Record<string, number> = {};
    const put = (name: string, size: number) => {
      if (Math.abs(size) > 1e-9) add[name] = r8((add[name] ?? 0) + size);
    };
    for (const s of opening) {
      put(s.shortName, -(s.plannedAmount - s.amount));
      put(s.longName, s.plannedAmount - s.amount - s.spareLong);
    }
    put(plan.shortName, -amount);
    put(plan.longName, amount);
    const after = await broker.simulatePortfolioMargin(currency, add);
    return { neededUsd: Math.max(after.initialMargin - acct.initialMargin, 0), freeUsd: acct.availableFunds, model: acct.marginModel };
  }

  // Standard margin locks collateral for the short put as if it stood alone.
  const reserved = sum(opening.map((s) => s.marginUsd ?? 0));
  const quote = await broker.margins(plan.shortName, amount, plan.shortMid);
  return { neededUsd: quote.sell, freeUsd: Math.max(acct.availableFunds - reserved, 0), model: acct.marginModel };
}

async function startEntry(id: MarketId, plan: Plan, how: 'scheduled' | 'manual'): Promise<string> {
  if (!broker) return problems[0] ?? 'trading is unavailable';
  if (workingJobs().some((j) => j.market === id && j.kind === 'entry')) return `a ${id} entry is already working`;
  if (activeSpreads().length >= config.maxOpenSpreads) return `the limit of ${config.maxOpenSpreads} open spreads is reached`;
  if (activeSpreads().some((s) => s.market === id && s.expiry === plan.expiry)) return `a ${id} spread expiring ${plan.expiry} is already open`;
  const account = accountValueUsd();
  if (!(account > 0)) return 'the account value is not known yet';
  const spec = (await specsFor(id)).get(plan.shortName);
  if (!spec) return `no order-size details for ${plan.shortName}`;

  // One trade, one risk: the pair together may lose at most this much.
  const riskUsd = (account * config.riskPerTradePct) / 100;
  const amount = sizeFor(plan, riskUsd, spec);
  if (!amount) return `even the smallest order (${spec.minAmount} ${id}) would risk more than $${riskUsd.toFixed(2)}`;

  // The size stays at the full risk; if the exchange will not hold enough collateral
  // for it, skip the trade rather than change the risk.
  const margin = await marginCheck(id, plan, amount);
  if (!margin) return 'the Deribit account has not been read yet';
  if (margin.neededUsd > margin.freeUsd) {
    const why = margin.model.endsWith('_sm') ? ' (standard margin counts the short put alone; portfolio margin counts the spread as one position)' : '';
    return `not enough margin: the spread needs $${Math.round(margin.neededUsd).toLocaleString('en-US')} of collateral and $${Math.round(margin.freeUsd).toLocaleString('en-US')} is free${why}`;
  }

  const { spread, job } = openEntry(M[id], plan, amount, riskUsd, account, Date.now());
  spread.marginUsd = margin.neededUsd;
  state.spreads.push(spread);
  state.jobs.push(job);
  state.lastEntryDay[id] = dayKey();
  save();
  log(`${id}: ${how} entry started, ${amount} ${id} risking at most $${riskUsd.toFixed(2)} (${config.riskPerTradePct}% of $${account.toFixed(2)}). Limit-buy ${plan.longName} at the mid first, then limit-sell ${plan.shortName}`);
  return 'started';
}

async function advanceJobs() {
  if (!broker) return;
  for (const job of workingJobs()) {
    const spread = state.spreads.find((s) => s.id === job.spreadId);
    if (!spread) { job.phase = 'done'; continue; }
    try {
      await advanceJob(job, spread, contextFor(job.market, broker, await specsFor(job.market)));
      jobErrors.delete(job.id);
      if (job.phase === 'done' && spread.status === 'cancelled' && !spread.fills.length) {
        // Nothing traded: drop the empty record, and let a scheduled entry try again in 30 minutes.
        state.spreads = state.spreads.filter((s) => s !== spread);
        if (job.kind === 'entry') {
          delete state.lastEntryDay[job.market];
          retryAt[job.market] = Date.now() + 30 * 60_000;
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (jobErrors.get(job.id) !== msg) {
        jobErrors.set(job.id, msg);
        log(`${job.market}: order work hit an error and will retry: ${msg}`, 'error');
      }
    }
    save();
  }
  const dayAgo = Date.now() - 86_400_000;
  state.jobs = state.jobs.filter((j) => j.phase !== 'done' || j.phaseStartedAt > dayAgo);
}

async function refreshMarkets() {
  for (const id of IDS) {
    const market = M[id];
    try {
      const planned = await refreshMarket(id);

      const expired = state.spreads.filter((x) => x.market === id && (x.status === 'open' || x.status === 'long-only') && Date.now() > x.expiryMs + 10 * 60_000);
      if (expired.length) {
        const prices = await getRecentDeliveryPrices(market.indexName, 10, base);
        for (const sp of expired) {
          const settle = prices[sp.expiry];
          if (!settle) continue;
          settleSpread(market, sp, settle);
          save();
          log(`${id}: ${sp.shortStrike}/${sp.longStrike} spread expired and settled at $${settle}; P&L $${sp.pnlUsd?.toFixed(2)}`);
        }
      }

      if (broker && state.tradingOn[id] && inEntryWindow() && state.lastEntryDay[id] !== dayKey() && Date.now() >= (retryAt[id] ?? 0)) {
        const outcome = 'plan' in planned ? await startEntry(id, planned.plan, 'scheduled') : planned.skip;
        if (outcome !== 'started' && lastSkip[id] !== outcome) {
          lastSkip[id] = outcome;
          log(`${id}: entry window open but no trade: ${outcome}`, 'warn');
        }
      }
    } catch (e) {
      snaps[id] = { ...snaps[id], error: (e as Error).message };
    }
  }
}

function reconcile() {
  const expected: Record<string, number> = {};
  for (const sp of activeSpreads().filter((x) => x.expiryMs > Date.now())) {
    expected[sp.shortName] = r8((expected[sp.shortName] ?? 0) - sp.amount);
    expected[sp.longName] = r8((expected[sp.longName] ?? 0) + sp.amount + sp.spareLong);
  }
  const actual: Record<string, number> = {};
  for (const p of positions) actual[p.instrument] = p.size;
  const diff = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter((n) => Math.abs((expected[n] ?? 0) - (actual[n] ?? 0)) > 1e-6)
    .map((n) => `${n}: bot expects ${expected[n] ?? 0}, Deribit shows ${actual[n] ?? 0}`)
    .join('; ');
  // Fills can land between two reads, so only a difference seen twice in a row is reported.
  if (diff && diff === pendingMismatch && diff !== positionWarning) {
    positionWarning = diff;
    log(`Positions differ from the bot's records: ${diff}`, 'warn');
  }
  if (!diff && positionWarning) {
    positionWarning = '';
    log("Positions match the bot's records again");
  }
  pendingMismatch = diff;
}

const PRICE_USD: Record<string, () => number | undefined> = {
  BTC: () => chains.BTC?.spot,
  ETH: () => chains.ETH?.spot,
  SOL: () => chains.SOL?.spot,
  USDC: () => 1,
  USDT: () => 1,
  USD: () => 1,
};

async function refreshAccount() {
  if (!broker) return;
  try {
    accounts = (await broker.accounts()).filter((a) => a.equity !== 0);
    positions = await broker.positions('USDC');
    if (accountError) log('Deribit account readable again');
    accountError = '';
  } catch (e) {
    const msg = `Could not read the Deribit account: ${(e as Error).message}`;
    if (msg !== accountError) { accountError = msg; log(msg, 'error'); }
    return;
  }

  let total = 0;
  const missing: string[] = [];
  for (const a of accounts) {
    const price = PRICE_USD[a.currency]?.();
    if (price === undefined) missing.push(a.currency);
    else total += a.equity * price;
  }
  exchangeEquityUsd = missing.some((c) => c in PRICE_USD) ? NaN : total;
  unpriced = missing;
  reconcile();

  const value = accountValueUsd();
  const strategy = strategyPnlUsd();
  const now = Date.now();
  if (Number.isFinite(value) && Number.isFinite(strategy) && now - lastSampleAt >= config.sampleSeconds * 1000) {
    const sample = { t: now, equityUsd: value, strategyUsd: strategy };
    samples.push(sample);
    appendSample(equityFile, sample);
    lastSampleAt = now;
  }
}

async function tick() {
  if (Date.now() - lastChainAt >= config.chainSeconds * 1000) {
    lastChainAt = Date.now();
    await refreshMarkets();
  }
  await advanceJobs();
  await refreshAccount();
  push();
}

function view() {
  const spreads = state.spreads.map((sp) => viewSpread(M[sp.market], sp, chains[sp.market], config.alertDistancePct));
  const live = spreads.filter((s) => s.live);
  const value = accountValueUsd();
  const usdc = accounts.find((a) => a.currency === 'USDC');
  return {
    mode,
    canTrade: Boolean(broker),
    problems,
    accountError,
    positionWarning,
    entry: { ...config.entry, inWindow: inEntryWindow(), next: nextWindow() },
    maxOpenSpreads: config.maxOpenSpreads,
    execution: config.execution,
    account: {
      valueUsd: value,
      capitalUsd: config.capitalUsd,
      riskPerTradePct: config.riskPerTradePct,
      riskUsd: (value * config.riskPerTradePct) / 100,
      exchange: usdc ?? null,
      exchangeEquityUsd,
      unpriced,
    },
    totals: { unrealizedUsd: sum(live.map((s) => s.live!.unrealizedUsd)), openRiskUsd: sum(live.map((s) => s.amount * s.maxLossUsd)), open: live.length },
    metrics: { deals: dealStats(state.spreads), equity: equityStats(samples) },
    series: downsample(samples, 600),
    positions,
    markets: IDS.map((id) => ({
      id,
      tradingOn: state.tradingOn[id],
      settings: config.markets[id],
      enteredToday: state.lastEntryDay[id] === dayKey(),
      working: workingJobs().some((j) => j.market === id && j.kind === 'entry'),
      ...snaps[id],
    })),
    jobs: workingJobs().map((j) => {
      const sp = state.spreads.find((s) => s.id === j.spreadId);
      const leg = j.phase === 'done' ? null : LEG[j.phase];
      return {
        id: j.id,
        spreadId: j.spreadId,
        market: j.market,
        kind: j.kind,
        step: leg?.step,
        says: leg?.says,
        instrument: leg && sp ? (leg.leg === 'long' ? sp.longName : sp.shortName) : '',
        order: j.order ? { side: j.order.side, price: j.order.price, amount: j.order.amount, filled: j.order.filled } : null,
        deadlineAt: j.phaseStartedAt + phaseLimitMs(j, config.execution),
        error: jobErrors.get(j.id),
      };
    }),
    spreads: spreads.reverse(),
    events: state.events.slice(-150).reverse(),
  };
}

/** What the public dashboard sees: the same live data, marked read-only so the page shows no buttons. */
function publicView() {
  return { ...view(), readOnly: true };
}

function push() {
  if (clients.size) {
    const message = `data: ${JSON.stringify(view())}\n\n`;
    for (const c of clients) c.write(message);
  }
  if (publicClients.size) {
    const message = `data: ${JSON.stringify(publicView())}\n\n`;
    for (const c of publicClients) c.write(message);
  }
}

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const ORIGINS = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, ...(config.controlOrigins ?? [])]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${config.port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readFileSync('page/index.html'));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return reply(res, 200, view());
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(view())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method !== 'POST') return reply(res, 404, { error: 'not found' });

    // These buttons move money, so only this dashboard may press them. The custom
    // header forces a CORS preflight the bot never approves, which stops any other
    // website open in the same browser from sending these requests.
    if (req.headers['x-bot-dashboard'] !== '1' || (req.headers.origin && !ORIGINS.has(req.headers.origin))) {
      return reply(res, 403, { error: 'forbidden' });
    }
    const body = await readBody(req);
    const id = body.market as MarketId;

    if (url.pathname === '/api/trading' && M[id]) {
      state.tradingOn[id] = Boolean(body.on);
      save();
      log(`${id}: trading switched ${body.on ? 'ON' : 'OFF'} on the dashboard`);
      return reply(res, 200, { result: 'ok' });
    }
    if (url.pathname === '/api/enter' && M[id]) {
      if (!broker) return reply(res, 400, { error: problems[0] ?? 'trading is unavailable' });
      const planned = await refreshMarket(id);
      if (!('plan' in planned)) return reply(res, 200, { result: planned.skip });
      const result = await startEntry(id, planned.plan, 'manual');
      if (result === 'started') await advanceJobs();
      else log(`${id}: manual entry not started: ${result}`, 'warn');
      return reply(res, 200, { result });
    }
    if (url.pathname === '/api/close') {
      const sp = state.spreads.find((x) => x.id === body.id && (x.status === 'open' || x.status === 'long-only'));
      if (!sp) return reply(res, 404, { error: 'no open spread with that id' });
      if (!broker) return reply(res, 400, { error: problems[0] ?? 'trading is unavailable' });
      if (workingJobs().some((j) => j.spreadId === sp.id)) return reply(res, 409, { error: 'orders are already working on this spread' });
      state.jobs.push(openExit(sp, Date.now()));
      save();
      log(`${sp.market}: close started. Limit-buy back ${sp.amount} ${sp.shortName} at the mid first, then limit-sell the long puts`);
      await advanceJobs();
      return reply(res, 200, { result: 'started' });
    }
    if (url.pathname === '/api/stop') {
      const job = workingJobs().find((j) => j.id === body.jobId);
      const sp = job && state.spreads.find((s) => s.id === job.spreadId);
      if (!job || !sp) return reply(res, 404, { error: 'no working job with that id' });
      if (!broker) return reply(res, 400, { error: problems[0] ?? 'trading is unavailable' });
      await stopJob(job, sp, contextFor(job.market, broker, await specsFor(job.market)));
      save();
      push();
      return reply(res, 200, { result: sp.note ?? sp.status });
    }
    return reply(res, 404, { error: 'not found' });
  } catch (e) {
    log(`Dashboard request ${url.pathname} failed: ${(e as Error).message}`, 'error');
    if (!res.headersSent) reply(res, 500, { error: (e as Error).message });
  }
});

if (!ONCE) server.listen(config.port, '127.0.0.1', () => {
  console.log(`Put spread bot · ${mode} · dashboard http://127.0.0.1:${config.port}`);
  for (const p of problems) console.warn(p);
});

// The public dashboard answers GET requests only, so nothing on this port can change
// the bot or touch the account, whoever reaches it.
if (config.publicPort && !ONCE) {
  const publicServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${config.publicPort}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(readFileSync('page/index.html'));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return reply(res, 200, publicView());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(publicView())}\n\n`);
        publicClients.add(res);
        req.on('close', () => publicClients.delete(res));
        return;
      }
      return reply(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
    }
  });
  publicServer.listen(config.publicPort, '127.0.0.1', () => console.log(`Public read-only dashboard http://127.0.0.1:${config.publicPort}`));
}

if (!ONCE) log(`Bot started on the Deribit ${mode === 'live' ? 'LIVE' : 'test'} exchange${problems.length ? `, not yet able to trade: ${problems[0]}` : ''}`, problems.length ? 'warn' : 'info');
let ticking = false;
const loop = async () => {
  if (ticking) return;
  ticking = true;
  try { await tick(); } catch (e) { console.error(e); } finally { ticking = false; }
};
if (ONCE) {
  // One scheduled cycle (GitHub Actions): read the account first so margin checks work,
  // then settle, plan and start entries, move working orders along, take an account
  // sample, save a snapshot for the public dashboard, and exit.
  try {
    await refreshAccount();
    lastChainAt = Date.now();
    await refreshMarkets();
    await advanceJobs();
    await refreshAccount();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    save();
    writeFileSync(`${dirname(stateFile)}/public-state.json`, JSON.stringify({ ...publicView(), snapshotAt: Date.now() }));
    for (const e of state.events.slice(-5)) console.log(`[event ${e.t}] ${e.msg}`);
  }
  process.exit();
} else {
  loop();
  setInterval(loop, config.pollSeconds * 1000);
}
