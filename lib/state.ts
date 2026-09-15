/**
 * The bot's memory, as plain data. Where it is kept is up to the runner: files on a
 * computer (lib/store.ts) or the D1 database on Cloudflare (worker/index.ts). Test-exchange
 * and real-money history are always kept apart.
 */
import type { AccountView, PositionView } from './broker.ts';
import type { InstrumentSpec, Option } from './deribit.ts';
import type { Job, Plan, SpreadRecord } from './executor.ts';
import type { MarketId } from './markets.ts';
import type { EquityAgg } from './metrics.ts';

export type BotEvent = { t: string; level: 'info' | 'warn' | 'error'; msg: string };

export type Sizing = { amount: number; riskUsd: number; minAmount: number; marginUsd?: number; freeMarginUsd?: number; marginModel?: string };

/** What a coin's dashboard card shows. */
export type MarketSnap = { spot?: number; sma50?: number; /** ATR over the expiry's horizon, percent of price. */ atrPct?: number; plan?: Plan; skip?: string; error?: string; size?: Sizing };

/** The part of an option chain the bot uses: nearby puts on the next week's expiries. */
export type ChainCache = { at: number; spot: number; options: Option[] };

/** What the last cycle learned about the account, for the next cycle and the dashboard. */
export type BotRuntime = {
  accountError: string;
  positionWarning: string;
  /** A position difference seen once; reported only if the next read shows it again. */
  pendingMismatch: string;
  jobErrors: Record<string, string>;
  lastChainAt: number;
  lastSampleAt: number;
  positions: PositionView[];
  accounts: AccountView[];
  /** null when a balance could not be priced in dollars. */
  exchangeEquityUsd: number | null;
  unpriced: string[];
};

export type BotCache = {
  chains: Partial<Record<MarketId, ChainCache>>;
  specs: Record<string, InstrumentSpec & { at: number }>;
  sma: Partial<Record<MarketId, { at: number; value: number; atrPct?: number }>>;
  snaps: Partial<Record<MarketId, MarketSnap>>;
};

export type BotState = {
  /** Per coin: trade it. On by default; the dashboard switch pauses a coin. */
  tradingOn: Record<MarketId, boolean>;
  /** The UTC date whose entry has already started, per coin. */
  lastEntryDay: Partial<Record<MarketId, string>>;
  spreads: SpreadRecord[];
  /** Order work in progress (and recently finished). */
  jobs: Job[];
  events: BotEvent[];
  /** Last reason logged for not entering, per coin, so it is logged once rather than every cycle. */
  lastSkip?: Partial<Record<MarketId, string>>;
  /** Earliest time a coin may retry an entry that filled nothing. */
  retryAt?: Partial<Record<MarketId, number>>;
  runtime?: BotRuntime;
  cache?: BotCache;
  /** Running summary of the account value over time: metrics and chart. */
  equity?: EquityAgg;
};

export function emptyState(tradingDefaults: Record<MarketId, boolean>): BotState {
  return { tradingOn: { ...tradingDefaults }, lastEntryDay: {}, spreads: [], jobs: [], events: [] };
}

/** A saved state, with defaults for anything it predates. */
export function mergeState(saved: Partial<BotState>, tradingDefaults: Record<MarketId, boolean>): BotState {
  return { ...emptyState(tradingDefaults), ...saved, tradingOn: { ...tradingDefaults, ...saved.tradingOn } };
}

export function addEvent(state: BotState, msg: string, level: BotEvent['level'] = 'info'): void {
  state.events.push({ t: new Date().toISOString(), level, msg });
  if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
}
