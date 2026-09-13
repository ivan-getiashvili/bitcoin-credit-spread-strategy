/**
 * The put spread bot: trades bull put spreads on a real Deribit account using limit
 * orders only, and serves a live monitoring dashboard at http://127.0.0.1:4191.
 *
 *   npm run bot                      # Deribit test exchange (fake money); keys in .env
 *   npm run bot -- --config x.json   # alternative settings file
 *
 * Every order goes to the exchange and shows in the account. Nothing opens until
 * Ivan switches a coin on: that switch is his judgment that the market is in a
 * range or rising, and the bot never makes that call. With a coin on, the bot starts
 * one entry per Friday window when the rule is met; "Enter now", "Close" and "Stop"
 * act at once. Account equity is sampled every minute for the curve and the ratios.
 * The dashboard listens on 127.0.0.1 only.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DeribitBroker, type AccountView, type Broker, type PositionView } from '../lib/broker.ts';
import { getChain, getInstrumentSpecs, getOrderBook, getRecentDeliveryPrices, MAINNET, TESTNET, type InstrumentSpec, type Option } from '../lib/deribit.ts';
import {
  advanceJob, LEG, openEntry, openExit, phaseLimitMs, planEntry, settleSpread, stopJob, toUsd,
  type ExecSettings, type JobContext, type MarketSettings, type Plan, type SpreadRecord,
} from '../lib/executor.ts';
import { MARKETS, type MarketId } from '../lib/markets.ts';
import { dealStats, downsample, equityStats } from '../lib/metrics.ts';
import { viewSpread } from '../lib/monitor.ts';
import { addEvent, appendSample, loadSamples, loadState, saveState } from '../lib/store.ts';

type BotConfig = {
  mode: 'testnet' | 'live';
  port: number;
  /** Order work, positions and account refresh, seconds. */
  pollSeconds: number;
  /** Option chains, plans, settlement and the entry-window check, seconds. */
  chainSeconds: number;
  /** One account-equity sample per this many seconds. */
  sampleSeconds: number;
  /** Across all coins. Weekly entries on ~28-day expiries overlap about four deep. */
  maxOpenSpreads: number;
  /** A spread turns "watch" when price is within this % above the sold put. */
  alertDistancePct: number;
  /** Automatic entries: weekday (5 = Friday) and time window, UTC. Matches the backtest. */
  entry: { weekdayUtc: number; fromUtc: string; toUtc: string };
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

const IDS = Object.keys(MARKETS) as MarketId[];
const stateFile = config.stateFile ?? `data/bot-state-${mode}.json`;
const equityFile = config.equityFile ?? `data/equity-${mode}.jsonl`;
const state = loadState(stateFile);
const samples = loadSamples(equityFile);
const save = () => saveState(stateFile, state);
const problems: string[] = [];
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

type MarketSnap = { spot?: number; sma50?: number; plan?: Plan; skip?: string; error?: string };
const chains: Partial<Record<MarketId, { options: Option[]; spot: number }>> = {};
const snaps: Record<MarketId, MarketSnap> = { BTC: {}, ETH: {}, SOL: {} };
const sma: Partial<Record<MarketId, { at: number; value: number }>> = {};
const specs: Partial<Record<MarketId, { at: number; map: Map<string, InstrumentSpec> }>> = {};
const lastSkip: Partial<Record<MarketId, string>> = {};
const retryAt: Partial<Record<MarketId, number>> = {};
const jobErrors = new Map<string, string>();
let positions: PositionView[] = [];
let accounts: AccountView[] = [];
let equityUsd = NaN;
let unpriced: string[] = [];
let accountError = '';
let positionWarning = '';
let pendingMismatch = '';
let lastChainAt = 0;
let lastSampleAt = samples.at(-1)?.t ?? 0;

const clients = new Set<ServerResponse>();

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

/** The date of this week's entry day, so each coin enters at most once per week. */
function weekKey(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - config.entry.weekdayUtc + 7) % 7));
  return d.toISOString().slice(0, 10);
}

function inEntryWindow(now = new Date()): boolean {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return now.getUTCDay() === config.entry.weekdayUtc && m >= minutes(config.entry.fromUtc) && m < minutes(config.entry.toUtc);
}

function nextWindow(now = new Date()): { from: string; to: string } | null {
  for (let i = 0; i < 8; i++) {
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i);
    if (new Date(day).getUTCDay() !== config.entry.weekdayUtc) continue;
    const to = day + minutes(config.entry.toUtc) * 60_000;
    if (to > now.getTime()) return { from: new Date(day + minutes(config.entry.fromUtc) * 60_000).toISOString(), to: new Date(to).toISOString() };
  }
  return null;
}

const LIVE = new Set<SpreadRecord['status']>(['opening', 'open', 'long-only', 'closing']);
const activeSpreads = () => state.spreads.filter((s) => LIVE.has(s.status));
const workingJobs = () => state.jobs.filter((j) => j.phase !== 'done');

async function specsFor(id: MarketId): Promise<Map<string, InstrumentSpec>> {
  const cached = specs[id];
  if (cached && Date.now() - cached.at < 6 * 3_600_000) return cached.map;
  const map = await getInstrumentSpecs(MARKETS[id], base);
  specs[id] = { at: Date.now(), map };
  return map;
}

function contextFor(id: MarketId, b: Broker, map: Map<string, InstrumentSpec>): JobContext {
  return {
    broker: b,
    market: MARKETS[id],
    settings: config.markets[id],
    exec: config.execution,
    book: (name) => getOrderBook(name, 5, b.base),
    spec: (name) => map.get(name),
    index: () => chains[id]?.spot ?? 0,
    now: () => Date.now(),
    save,
    log,
  };
}

async function refreshMarket(id: MarketId) {
  const market = MARKETS[id];
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
  const planned = planEntry(market, chain, config.markets[id]);
  snaps[id] = { spot: chain.spot, sma50: sma[id]?.value, ...('plan' in planned ? { plan: planned.plan } : { skip: planned.skip }) };
  return planned;
}

function startEntry(id: MarketId, plan: Plan, how: 'scheduled' | 'manual'): string {
  if (!broker) return problems[0] ?? 'trading is unavailable';
  if (workingJobs().some((j) => j.market === id && j.kind === 'entry')) return `a ${id} entry is already working`;
  if (activeSpreads().length >= config.maxOpenSpreads) return `the limit of ${config.maxOpenSpreads} open spreads is reached`;
  if (activeSpreads().some((s) => s.market === id && s.expiry === plan.expiry)) return `a ${id} spread expiring ${plan.expiry} is already open`;
  const s = config.markets[id];
  const { spread, job } = openEntry(MARKETS[id], plan, s, Date.now());
  state.spreads.push(spread);
  state.jobs.push(job);
  state.lastEntryWeek[id] = weekKey();
  save();
  log(`${id}: ${how} entry started. Limit-buy ${s.amount} ${plan.longName} at the mid first, then limit-sell ${plan.shortName}, never below the ${s.maxLossToCredit}:1 price`);
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
          delete state.lastEntryWeek[job.market];
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
    const market = MARKETS[id];
    try {
      const planned = await refreshMarket(id);

      const expired = state.spreads.filter((x) => x.market === id && (x.status === 'open' || x.status === 'long-only') && Date.now() > x.expiryMs + 15 * 60_000);
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

      if (broker && state.tradingOn[id] && inEntryWindow() && state.lastEntryWeek[id] !== weekKey() && Date.now() >= (retryAt[id] ?? 0)) {
        if ('plan' in planned) startEntry(id, planned.plan, 'scheduled');
        else if (lastSkip[id] !== planned.skip) {
          lastSkip[id] = planned.skip;
          log(`${id}: entry window open but no trade: ${planned.skip}`);
        }
      }
    } catch (e) {
      snaps[id] = { ...snaps[id], error: (e as Error).message };
    }
  }
}

/** Realised P&L of finished deals plus unrealised P&L of open ones; NaN if an open spread cannot be valued. */
function strategyPnlUsd(): number {
  let total = 0;
  for (const sp of state.spreads) {
    if (sp.status === 'closed' || sp.status === 'settled') total += sp.pnlUsd ?? 0;
    else if (LIVE.has(sp.status)) {
      const live = viewSpread(MARKETS[sp.market], sp, chains[sp.market], config.alertDistancePct).live;
      if (!live) return NaN;
      total += live.unrealizedUsd;
    }
  }
  return total;
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
    const next: PositionView[] = [];
    for (const currency of ['BTC', 'ETH', 'USDC']) next.push(...(await broker.positions(currency)));
    positions = next;
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
  equityUsd = total;
  unpriced = missing;
  reconcile();

  // Sample only when every coin the account holds could be priced, so the curve never dips on a missing price.
  const strategy = strategyPnlUsd();
  const now = Date.now();
  if (!missing.some((c) => c in PRICE_USD) && Number.isFinite(strategy) && now - lastSampleAt >= config.sampleSeconds * 1000) {
    const sample = { t: now, equityUsd: total, strategyUsd: strategy };
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
  const spreads = state.spreads.map((sp) => viewSpread(MARKETS[sp.market], sp, chains[sp.market], config.alertDistancePct));
  const live = spreads.filter((s) => s.live);
  return {
    mode,
    canTrade: Boolean(broker),
    problems,
    accountError,
    positionWarning,
    entry: { ...config.entry, inWindow: inEntryWindow(), next: nextWindow() },
    maxOpenSpreads: config.maxOpenSpreads,
    execution: config.execution,
    account: { equityUsd, currencies: accounts, unpriced },
    totals: { unrealizedUsd: sum(live.map((s) => s.live!.unrealizedUsd)), openRiskUsd: sum(live.map((s) => s.amount * s.maxLossUsd)), open: live.length },
    metrics: { deals: dealStats(state.spreads), equity: equityStats(samples) },
    series: downsample(samples, 600),
    positions,
    markets: IDS.map((id) => ({
      id,
      tradingOn: state.tradingOn[id],
      settings: config.markets[id],
      enteredThisWeek: state.lastEntryWeek[id] === weekKey(),
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
        order: j.order ? {
          side: j.order.side,
          price: j.order.price,
          priceUsd: toUsd(MARKETS[j.market], j.order.price, chains[j.market]?.spot ?? 0),
          amount: j.order.amount,
          filled: j.order.filled,
        } : null,
        deadlineAt: j.phaseStartedAt + phaseLimitMs(j, config.execution),
        error: jobErrors.get(j.id),
      };
    }),
    spreads: spreads.reverse(),
    events: state.events.slice(-150).reverse(),
  };
}

function push() {
  if (!clients.size) return;
  const message = `data: ${JSON.stringify(view())}\n\n`;
  for (const c of clients) c.write(message);
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

const ORIGINS = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);

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

    if (url.pathname === '/api/trading' && MARKETS[id]) {
      state.tradingOn[id] = Boolean(body.on);
      save();
      log(`${id}: trading switched ${body.on ? 'ON' : 'OFF'} on the dashboard`);
      return reply(res, 200, { result: 'ok' });
    }
    if (url.pathname === '/api/enter' && MARKETS[id]) {
      if (!broker) return reply(res, 400, { error: problems[0] ?? 'trading is unavailable' });
      const planned = await refreshMarket(id);
      if (!('plan' in planned)) return reply(res, 200, { result: planned.skip });
      const result = startEntry(id, planned.plan, 'manual');
      if (result === 'started') await advanceJobs();
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

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Put spread bot · ${mode} · dashboard http://127.0.0.1:${config.port}`);
  for (const p of problems) console.warn(p);
});

log(`Bot started on the Deribit ${mode === 'live' ? 'LIVE' : 'test'} exchange${problems.length ? `, not yet able to trade: ${problems[0]}` : ''}`, problems.length ? 'warn' : 'info');
let ticking = false;
const loop = async () => {
  if (ticking) return;
  ticking = true;
  try { await tick(); } catch (e) { console.error(e); } finally { ticking = false; }
};
loop();
setInterval(loop, config.pollSeconds * 1000);
