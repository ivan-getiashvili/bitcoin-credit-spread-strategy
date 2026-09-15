/**
 * The put spread bot, independent of where it runs. The Cloudflare Worker runs it in
 * production (worker/index.ts); scripts/bot.ts runs it on a computer for development.
 *
 * Every day, on each coin that is switched on, it opens Ivan's daily bull put spread on a
 * real Deribit account (the test exchange by default), using limit orders only. A spread
 * is one trade with one risk: the pair together may lose at most `riskPerTradePct` of the
 * account value, which is `capitalUsd` plus the bot's own P&L.
 *
 * The bot works in cycles. A cycle reads the account, checks the option chain when due,
 * settles expired spreads, starts the day's entry inside the entry window, moves working
 * limit orders along and samples the account value. Everything a later cycle needs lives
 * in `state`, so each cycle may run in a fresh process, as it does on Cloudflare.
 */
import type { Broker } from './broker.ts';
import { chainFromSummaries, getBookSummaries, getInstrumentSpec, getOrderBook, getRecentDeliveryPrices, MAINNET, TESTNET, type InstrumentSpec, type Option } from './deribit.ts';
import {
  advanceJob, LEG, openEntry, openExit, phaseLimitMs, planSpread, settleSpread, sizeFor, stopJob,
  type ExecSettings, type JobContext, type MarketSettings, type Plan, type SpreadRecord, type StrategySettings,
} from './executor.ts';
import { DOLLAR_MARKETS as M, type MarketId } from './markets.ts';
import { addSample, dealStats, downsample, equityStatsFromAgg, type EquitySample } from './metrics.ts';
import { viewSpread } from './monitor.ts';
import { seedActive, withSeed, type Seed } from './seed.ts';
import { addEvent, type BotState, type ChainCache, type Sizing } from './state.ts';

export type BotConfig = {
  mode: 'testnet' | 'live';
  /** Local runner only: private dashboard with the trade buttons. */
  port: number;
  /** Local runner only: read-only dashboard, no buttons, no routes that change anything. */
  publicPort?: number;
  /** Local runner only: extra origins allowed to press the buttons. */
  controlOrigins?: string[];
  /** Local runner only: seconds between cycles. On Cloudflare a cron runs one cycle a minute. */
  pollSeconds: number;
  /** Option chains, plans, settlement and the entry check while the entry window is open or orders are working, seconds. */
  chainSeconds: number;
  /** The same check at other times, seconds. Reading the chain is the heaviest part of a cycle. */
  idleChainSeconds?: number;
  /** One account-value sample per this many seconds. */
  sampleSeconds: number;
  /** Demo account value in dollars: risk and returns are measured against this plus the bot's P&L. null uses the exchange balance. */
  capitalUsd: number | null;
  /** Share of the current account value one whole spread may lose, percent. */
  riskPerTradePct: number;
  /** Size a little under the budget, percent, so a few dollars of price movement between sizing and the order do not cancel the entry. */
  sizingSlackPct?: number;
  /** Across all coins. One spread per coin per day. */
  maxOpenSpreads: number;
  /** A spread turns "watch" when price is within this % above the sold put. */
  alertDistancePct: number;
  /** Entry window, UTC, on the given weekdays (0 = Sunday ... 6 = Saturday; every day if absent). Deribit's options day starts at the 08:00 UTC settlement. */
  entry: { fromUtc: string; toUtc: string; weekdays?: number[] };
  /** Expiry and strike choice. */
  strategy: StrategySettings;
  execution: ExecSettings;
  markets: Record<MarketId, MarketSettings>;
  stateFile?: string;
  equityFile?: string;
};

export type CommandResult = { status: number; body: { result?: string; error?: string } };

export type BotDeps = {
  config: BotConfig;
  /** null when keys are missing or live trading is locked; prices still show. */
  broker: Broker | null;
  /** Why the bot cannot trade, shown on the dashboard. */
  problems: string[];
  state: BotState;
  /** Persist `state`. Called often, and may return before the write lands. */
  save: () => void;
  /** A new account-value sample, for the permanent record. */
  onSample?: (sample: EquitySample) => void;
  /** Something on the dashboard changed. */
  onChange?: () => void;
  /** Where log lines go besides the dashboard's activity list. */
  logLine?: (msg: string, level: 'info' | 'warn' | 'error') => void;
  now?: () => number;
  /** Simulated history shown until the real record has enough days (lib/seed.ts). */
  seed?: Seed;
};

export const IDS = Object.keys(M) as MarketId[];
const LIVE = new Set<SpreadRecord['status']>(['opening', 'open', 'long-only', 'closing']);
const HOUR = 3_600_000;
const r8 = (x: number) => Math.round(x * 1e8) / 1e8;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function createBot(d: BotDeps) {
  const { config, broker, problems, state } = d;
  const now = d.now ?? (() => Date.now());
  const base = config.mode === 'live' ? MAINNET : TESTNET;

  state.runtime = {
    accountError: '', positionWarning: '', pendingMismatch: '', jobErrors: {},
    lastChainAt: 0, lastSampleAt: state.equity?.last.t ?? 0,
    positions: [], accounts: [], exchangeEquityUsd: null, unpriced: [],
    ...state.runtime,
  };
  state.cache = { chains: {}, specs: {}, sma: {}, snaps: {}, ...state.cache };
  state.lastSkip ??= {};
  state.retryAt ??= {};
  const rt = state.runtime;
  const cache = state.cache;
  const lastSkip = state.lastSkip;
  const retryAt = state.retryAt;

  function log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
    addEvent(state, msg, level);
    d.save();
    d.logLine?.(msg, level);
    d.onChange?.();
  }

  const minutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const dayKey = () => new Date(now()).toISOString().slice(0, 10);

  const entryDay = (ms: number) => !config.entry.weekdays?.length || config.entry.weekdays.includes(new Date(ms).getUTCDay());

  function inEntryWindow(): boolean {
    const t = new Date(now());
    const m = t.getUTCHours() * 60 + t.getUTCMinutes();
    return entryDay(t.getTime()) && m >= minutes(config.entry.fromUtc) && m < minutes(config.entry.toUtc);
  }

  function nextWindow(): { from: string; to: string } {
    const t = new Date(now());
    let day = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    if (day + minutes(config.entry.toUtc) * 60_000 <= t.getTime()) day += 86_400_000;
    while (!entryDay(day)) day += 86_400_000;
    return {
      from: new Date(day + minutes(config.entry.fromUtc) * 60_000).toISOString(),
      to: new Date(day + minutes(config.entry.toUtc) * 60_000).toISOString(),
    };
  }

  const activeSpreads = () => state.spreads.filter((s) => LIVE.has(s.status));
  const workingJobs = () => state.jobs.filter((j) => j.phase !== 'done');

  /** One instrument's order-size rules, fetched once a day. */
  async function specFor(name: string): Promise<InstrumentSpec> {
    const hit = cache.specs[name];
    if (hit && now() - hit.at < 24 * HOUR) return hit;
    try {
      const spec = await getInstrumentSpec(name, base);
      cache.specs[name] = { ...spec, at: now() };
      return cache.specs[name];
    } catch (e) {
      if (hit) return hit;
      throw e;
    }
  }

  function pruneSpecs() {
    const keep = new Set(activeSpreads().flatMap((s) => [s.shortName, s.longName]));
    for (const [name, spec] of Object.entries(cache.specs)) {
      if (!keep.has(name) && now() - spec.at > 48 * HOUR) delete cache.specs[name];
    }
  }

  function contextFor(id: MarketId, b: Broker): JobContext {
    return {
      broker: b,
      market: M[id],
      exec: config.execution,
      book: (name) => getOrderBook(name, 5, b.base),
      spec: (name) => cache.specs[name],
      index: () => cache.chains[id]?.spot ?? 0,
      now,
      save: d.save,
      log,
      sizingSlackPct: config.sizingSlackPct,
    };
  }

  /**
   * Only the puts the bot can use, plus the legs of its own spreads. The full chain is
   * megabytes; this keeps the saved state small enough to reload every minute.
   */
  function slimChain(chain: { options: Option[]; spot: number }, type?: 'put' | 'call'): ChainCache {
    const t = now();
    const legs = new Set(activeSpreads().flatMap((s) => [s.shortName, s.longName]));
    const horizon = (config.strategy.expiry === 'weekly' ? 14 : 8) * 24 * HOUR;
    const options = chain.options.filter((o) => legs.has(o.name) || (
      o.type === (type ?? 'put') && o.expiryMs > t && o.expiryMs - t < horizon && o.strike >= chain.spot * 0.6 && o.strike <= chain.spot * 1.4
    ));
    return { at: t, spot: chain.spot, options };
  }

  /** Realised P&L of finished deals plus unrealised P&L of open ones; NaN if an open spread cannot be valued yet. */
  function strategyPnlUsd(): number {
    let total = 0;
    for (const sp of state.spreads) {
      if (sp.status === 'closed' || sp.status === 'settled' || sp.status === 'unwound') total += sp.pnlUsd ?? 0;
      else if (LIVE.has(sp.status) && (sp.amount > 0 || sp.spareLong > 0)) {
        const live = viewSpread(M[sp.market], sp, cache.chains[sp.market], config.alertDistancePct, now()).live;
        if (!live) return NaN;
        total += live.unrealizedUsd;
      }
    }
    return total;
  }

  /** The account value risk is sized from: demo capital plus the bot's P&L, or the exchange balance. */
  function accountValueUsd(): number {
    if (config.capitalUsd === null || config.capitalUsd === undefined) return rt.exchangeEquityUsd ?? NaN;
    const pnl = strategyPnlUsd();
    return Number.isFinite(pnl) ? config.capitalUsd + pnl : NaN;
  }

  async function refreshMarket(id: MarketId, summaries?: unknown[]) {
    const market = M[id];
    const chain = slimChain(chainFromSummaries(summaries ?? (await getBookSummaries(market.currency, base)), market), config.markets[id].structure);
    cache.chains[id] = chain;
    const sma = cache.sma[id];
    if (!sma || now() - sma.at > 30 * 60_000) {
      try {
        // Newest first. The 50-day average is informational; the ATR sizes the strike distance.
        const prices = Object.entries(await getRecentDeliveryPrices(market.indexName, 60, base))
          .sort(([a], [b]) => (a < b ? 1 : -1))
          .map(([, p]) => p);
        const n = config.strategy.atrDays;
        const moves = prices.slice(0, n).map((p, i) => Math.abs(p / prices[i + 1] - 1)).filter(Number.isFinite);
        cache.sma[id] = { at: now(), value: prices.length >= 50 ? sum(prices.slice(0, 50)) / 50 : NaN, atrPct: moves.length === n ? sum(moves) / n : NaN };
      } catch { /* informational only */ }
    }
    const dailyAtr = cache.sma[id]?.atrPct ?? NaN;
    const days = config.strategy.expiry === 'weekly' ? 7 : 1;
    const planned = planSpread(market, chain, config.markets[id], config.strategy, dailyAtr * Math.sqrt(days), now());
    let size: Sizing | undefined;
    if ('plan' in planned) {
      const spec = await specFor(planned.plan.shortName);
      const account = accountValueUsd();
      if (Number.isFinite(account)) {
        const riskUsd = (account * config.riskPerTradePct) / 100;
        size = { amount: sizeFor(planned.plan, riskUsd, spec, config.sizingSlackPct), riskUsd, minAmount: spec.minAmount };
        if (size.amount > 0) {
          try {
            const m = await marginCheck(id, planned.plan, size.amount);
            if (m) Object.assign(size, { marginUsd: m.neededUsd, freeMarginUsd: m.freeUsd, marginModel: m.model });
          } catch { /* shown on the card only; the entry checks again */ }
        }
      }
    }
    cache.snaps[id] = { spot: chain.spot, sma50: cache.sma[id]?.value, atrPct: Number.isFinite(dailyAtr) ? dailyAtr * Math.sqrt(days) * 100 : undefined, size, ...('plan' in planned ? { plan: planned.plan } : { skip: planned.skip }) };
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
    const acct = rt.accounts.find((a) => a.currency === currency);
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
    const [spec] = await Promise.all([specFor(plan.shortName), specFor(plan.longName)]);

    // One trade, one risk: the pair together may lose at most this much.
    const riskUsd = (account * config.riskPerTradePct) / 100;
    const amount = sizeFor(plan, riskUsd, spec, config.sizingSlackPct);
    if (!amount) return `even the smallest order (${spec.minAmount} ${id}) would risk more than $${riskUsd.toFixed(2)}`;

    // The size stays at the full risk; if the exchange will not hold enough collateral
    // for it, skip the trade rather than change the risk.
    const margin = await marginCheck(id, plan, amount);
    if (!margin) return 'the Deribit account has not been read yet';
    if (margin.neededUsd > margin.freeUsd) {
      const why = margin.model.endsWith('_sm') ? ' (standard margin counts the short put alone; portfolio margin counts the spread as one position)' : '';
      return `not enough margin: the spread needs $${Math.round(margin.neededUsd).toLocaleString('en-US')} of collateral and $${Math.round(margin.freeUsd).toLocaleString('en-US')} is free${why}`;
    }

    const { spread, job } = openEntry(M[id], plan, amount, riskUsd, account, now());
    spread.marginUsd = margin.neededUsd;
    state.spreads.push(spread);
    state.jobs.push(job);
    state.lastEntryDay[id] = dayKey();
    d.save();
    log(`${id}: ${how} entry started, ${amount} ${id} risking at most $${riskUsd.toFixed(2)} (${config.riskPerTradePct}% of $${account.toFixed(2)}). Limit-buy ${plan.longName} at the mid first, then limit-sell ${plan.shortName}`);
    return 'started';
  }

  async function advanceJobs() {
    if (!broker) return;
    for (const job of workingJobs()) {
      const spread = state.spreads.find((s) => s.id === job.spreadId);
      if (!spread) { job.phase = 'done'; continue; }
      try {
        await Promise.all([specFor(spread.shortName), specFor(spread.longName)]);
        await advanceJob(job, spread, contextFor(job.market, broker));
        delete rt.jobErrors[job.id];
        if (job.phase === 'done' && spread.status === 'cancelled' && !spread.fills.length) {
          // Nothing traded: drop the empty record, and let a scheduled entry try again in 30 minutes.
          state.spreads = state.spreads.filter((s) => s !== spread);
          if (job.kind === 'entry') {
            delete state.lastEntryDay[job.market];
            retryAt[job.market] = now() + 30 * 60_000;
          }
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (rt.jobErrors[job.id] !== msg) {
          rt.jobErrors[job.id] = msg;
          log(`${job.market}: order work hit an error and will retry: ${msg}`, 'error');
        }
      }
      d.save();
    }
    const dayAgo = now() - 86_400_000;
    state.jobs = state.jobs.filter((j) => j.phase !== 'done' || j.phaseStartedAt > dayAgo);
    for (const id of Object.keys(rt.jobErrors)) if (!state.jobs.some((j) => j.id === id)) delete rt.jobErrors[id];
  }

  /**
   * Coins worth reading the chain for: enabled in the config (so a paused coin still shows
   * its price and today's plan), switched on, or holding a spread or order work.
   */
  function watchedMarkets(): MarketId[] {
    return IDS.filter((id) => config.markets[id].enabled
      || state.tradingOn[id]
      || state.spreads.some((s) => s.market === id && LIVE.has(s.status))
      || workingJobs().some((j) => j.market === id));
  }

  async function refreshMarkets() {
    // All USDC books come from one request, so read it once for every coin that needs it.
    const summaries = new Map<string, Promise<unknown[]>>();
    const summariesFor = (currency: string) => {
      if (!summaries.has(currency)) summaries.set(currency, getBookSummaries(currency, base));
      return summaries.get(currency)!;
    };
    const watched = watchedMarkets();
    for (const id of IDS) if (!watched.includes(id)) cache.snaps[id] = { skip: 'this coin is disabled in the configuration' };

    for (const id of watched) {
      const market = M[id];
      try {
        const planned = await refreshMarket(id, await summariesFor(market.currency));

        const expired = state.spreads.filter((x) => x.market === id && (x.status === 'open' || x.status === 'long-only') && now() > x.expiryMs + 10 * 60_000);
        if (expired.length) {
          const prices = await getRecentDeliveryPrices(market.indexName, 10, base);
          for (const sp of expired) {
            const settle = prices[sp.expiry];
            if (!settle) continue;
            settleSpread(market, sp, settle);
            d.save();
            log(`${id}: ${sp.shortStrike}/${sp.longStrike} spread expired and settled at $${settle}; P&L $${sp.pnlUsd?.toFixed(2)}`);
          }
        }

        if (broker && state.tradingOn[id] && inEntryWindow() && state.lastEntryDay[id] !== dayKey() && now() >= (retryAt[id] ?? 0)) {
          const outcome = 'plan' in planned ? await startEntry(id, planned.plan, 'scheduled') : planned.skip;
          if (outcome !== 'started' && lastSkip[id] !== outcome) {
            lastSkip[id] = outcome;
            log(`${id}: entry window open but no trade: ${outcome}`, 'warn');
          }
        }
      } catch (e) {
        cache.snaps[id] = { ...cache.snaps[id], error: (e as Error).message };
      }
    }
  }

  function reconcile() {
    const expected: Record<string, number> = {};
    for (const sp of activeSpreads().filter((x) => x.expiryMs > now())) {
      expected[sp.shortName] = r8((expected[sp.shortName] ?? 0) - sp.amount);
      expected[sp.longName] = r8((expected[sp.longName] ?? 0) + sp.amount + sp.spareLong);
    }
    const actual: Record<string, number> = {};
    for (const p of rt.positions) actual[p.instrument] = p.size;
    const diff = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
      .filter((n) => Math.abs((expected[n] ?? 0) - (actual[n] ?? 0)) > 1e-6)
      .map((n) => `${n}: bot expects ${expected[n] ?? 0}, Deribit shows ${actual[n] ?? 0}`)
      .join('; ');
    // Fills can land between two reads, so only a difference seen twice in a row is reported.
    if (diff && diff === rt.pendingMismatch && diff !== rt.positionWarning) {
      rt.positionWarning = diff;
      log(`Positions differ from the bot's records: ${diff}`, 'warn');
    }
    if (!diff && rt.positionWarning) {
      rt.positionWarning = '';
      log("Positions match the bot's records again");
    }
    rt.pendingMismatch = diff;
  }

  const PRICE_USD: Record<string, () => number | undefined> = {
    BTC: () => cache.chains.BTC?.spot,
    ETH: () => cache.chains.ETH?.spot,
    SOL: () => cache.chains.SOL?.spot,
    USDC: () => 1,
    USDT: () => 1,
    USD: () => 1,
  };

  async function refreshAccount() {
    if (!broker) return;
    try {
      rt.accounts = (await broker.accounts()).filter((a) => a.equity !== 0);
      rt.positions = await broker.positions('USDC');
      if (rt.accountError) log('Deribit account readable again');
      rt.accountError = '';
    } catch (e) {
      const msg = `Could not read the Deribit account: ${(e as Error).message}`;
      if (msg !== rt.accountError) { rt.accountError = msg; log(msg, 'error'); }
      return;
    }

    let total = 0;
    const missing: string[] = [];
    for (const a of rt.accounts) {
      const price = PRICE_USD[a.currency]?.();
      if (price === undefined) missing.push(a.currency);
      else total += a.equity * price;
    }
    rt.exchangeEquityUsd = missing.some((c) => c in PRICE_USD) ? null : total;
    rt.unpriced = missing;
    reconcile();

    const value = accountValueUsd();
    const strategy = strategyPnlUsd();
    const t = now();
    if (Number.isFinite(value) && Number.isFinite(strategy) && t - rt.lastSampleAt >= config.sampleSeconds * 1000 - 5_000) {
      const sample: EquitySample = { t, equityUsd: value, strategyUsd: strategy };
      state.equity = addSample(state.equity, sample);
      d.onSample?.(sample);
      rt.lastSampleAt = t;
    }
  }

  /**
   * One cycle. `accountFirst` reads the account before planning, which a process that
   * has just started needs for its margin checks; a long-running process already has it.
   */
  async function cycle({ accountFirst = true } = {}) {
    if (accountFirst) await refreshAccount();
    const busy = inEntryWindow() || workingJobs().length > 0;
    const everyMs = (busy ? config.chainSeconds : (config.idleChainSeconds ?? config.chainSeconds)) * 1000;
    // A little slack, so a cron that fires a second early still counts as due.
    if (now() - rt.lastChainAt >= everyMs - 5_000) {
      rt.lastChainAt = now();
      await refreshMarkets();
    }
    await advanceJobs();
    await refreshAccount();
    pruneSpecs();
    d.save();
    d.onChange?.();
  }

  /** True while the dashboard still shows the simulated history in front of the real one. */
  const seedShown = () => seedActive(d.seed, state.equity);

  function view() {
    const spreads = state.spreads.map((sp) => viewSpread(M[sp.market], sp, cache.chains[sp.market], config.alertDistancePct, now()));
    const live = spreads.filter((s) => s.live);
    const value = accountValueUsd();
    const usdc = rt.accounts.find((a) => a.currency === 'USDC');
    const seeded = seedShown() ? withSeed(d.seed!, state.equity, downsample(state.equity?.series ?? [], 600), spreads) : null;
    return {
      mode: config.mode,
      canTrade: Boolean(broker),
      problems,
      accountError: rt.accountError,
      positionWarning: rt.positionWarning,
      entry: { ...config.entry, inWindow: inEntryWindow(), next: nextWindow() },
      strategy: config.strategy,
      maxOpenSpreads: config.maxOpenSpreads,
      execution: config.execution,
      account: {
        valueUsd: value,
        capitalUsd: config.capitalUsd,
        riskPerTradePct: config.riskPerTradePct,
        riskUsd: (value * config.riskPerTradePct) / 100,
        exchange: usdc ?? null,
        exchangeEquityUsd: rt.exchangeEquityUsd ?? NaN,
        unpriced: rt.unpriced,
      },
      totals: { unrealizedUsd: sum(live.map((s) => s.live!.unrealizedUsd)), openRiskUsd: sum(live.map((s) => s.amount * s.maxLossUsd)), open: live.length },
      metrics: seeded ? { deals: seeded.deals, equity: seeded.equity } : { deals: dealStats(state.spreads), equity: equityStatsFromAgg(state.equity) },
      series: seeded ? seeded.series : downsample(state.equity?.series ?? [], 600),
      seeded: seeded?.seeded ?? null,
      positions: rt.positions,
      markets: IDS.map((id) => ({
        id,
        tradingOn: state.tradingOn[id],
        settings: config.markets[id],
        enteredToday: state.lastEntryDay[id] === dayKey(),
        working: workingJobs().some((j) => j.market === id && j.kind === 'entry'),
        ...cache.snaps[id],
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
          says: leg ? `${j.kind === 'entry' && j.phase === 'sell-long' ? 'selling the long puts back' : leg.says}${j.taking ? ` at the ${leg.side === 'buy' ? 'ask' : 'bid'}` : ''}` : undefined,
          instrument: leg && sp ? (leg.leg === 'long' ? sp.longName : sp.shortName) : '',
          order: j.order ? { side: j.order.side, price: j.order.price, amount: j.order.amount, filled: j.order.filled } : null,
          deadlineAt: j.phaseStartedAt + phaseLimitMs(j, config.execution),
          error: rt.jobErrors[j.id],
        };
      }),
      spreads: (seeded ? seeded.spreads : spreads).reverse(),
      events: state.events.slice(-150).reverse(),
    };
  }

  /** What the public dashboard sees: the same data, marked read-only so the page shows no buttons. */
  function publicView() {
    return { ...view(), readOnly: true };
  }

  const commands = {
    async setTrading(id: MarketId, on: boolean): Promise<CommandResult> {
      if (!M[id]) return { status: 404, body: { error: `unknown coin ${id}` } };
      state.tradingOn[id] = Boolean(on);
      d.save();
      log(`${id}: trading switched ${on ? 'ON' : 'OFF'}`);
      return { status: 200, body: { result: 'ok' } };
    },

    async enter(id: MarketId): Promise<CommandResult> {
      if (!M[id]) return { status: 404, body: { error: `unknown coin ${id}` } };
      if (!broker) return { status: 400, body: { error: problems[0] ?? 'trading is unavailable' } };
      if (!rt.accounts.length) await refreshAccount();
      const planned = await refreshMarket(id);
      if (!('plan' in planned)) return { status: 200, body: { result: planned.skip } };
      const result = await startEntry(id, planned.plan, 'manual');
      if (result === 'started') await advanceJobs();
      else log(`${id}: manual entry not started: ${result}`, 'warn');
      return { status: 200, body: { result } };
    },

    async close(spreadId: string): Promise<CommandResult> {
      const sp = state.spreads.find((x) => x.id === spreadId && (x.status === 'open' || x.status === 'long-only'));
      if (!sp) return { status: 404, body: { error: 'no open spread with that id' } };
      if (!broker) return { status: 400, body: { error: problems[0] ?? 'trading is unavailable' } };
      if (workingJobs().some((j) => j.spreadId === sp.id)) return { status: 409, body: { error: 'orders are already working on this spread' } };
      state.jobs.push(openExit(sp, now()));
      d.save();
      log(`${sp.market}: close started. Limit-buy back ${sp.amount} ${sp.shortName} at the mid first, then limit-sell ${sp.longName}`);
      await advanceJobs();
      return { status: 200, body: { result: 'started' } };
    },

    async stop(jobId: string): Promise<CommandResult> {
      const job = workingJobs().find((j) => j.id === jobId);
      const sp = job && state.spreads.find((s) => s.id === job.spreadId);
      if (!job || !sp) return { status: 404, body: { error: 'no working job with that id' } };
      if (!broker) return { status: 400, body: { error: problems[0] ?? 'trading is unavailable' } };
      await Promise.all([specFor(sp.shortName), specFor(sp.longName)]);
      await stopJob(job, sp, contextFor(job.market, broker));
      d.save();
      d.onChange?.();
      return { status: 200, body: { result: sp.note ?? sp.status } };
    },
  };

  return { cycle, view, publicView, log, commands, seedShown };
}

export type Bot = ReturnType<typeof createBot>;
