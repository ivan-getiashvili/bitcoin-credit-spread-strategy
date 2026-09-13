/**
 * The bot's memory: one JSON state file and one equity log per mode
 * (data/bot-state-testnet.json, data/equity-testnet.jsonl), so test-exchange
 * history never mixes with real-money history. State is written atomically: a
 * crash mid-write leaves the previous file intact.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Job, SpreadRecord } from './executor.ts';
import type { MarketId } from './markets.ts';
import type { EquitySample } from './metrics.ts';

export type BotEvent = { t: string; level: 'info' | 'warn' | 'error'; msg: string };

export type BotState = {
  /** Ivan's call, per coin, that the market is in a range or rising. Off until he turns it on. */
  tradingOn: Record<MarketId, boolean>;
  /** The Friday whose entry has already started, per coin. */
  lastEntryWeek: Partial<Record<MarketId, string>>;
  spreads: SpreadRecord[];
  /** Order work in progress (and recently finished). */
  jobs: Job[];
  events: BotEvent[];
};

export function loadState(file: string): BotState {
  const empty: BotState = {
    tradingOn: { BTC: false, ETH: false, SOL: false },
    lastEntryWeek: {},
    spreads: [],
    jobs: [],
    events: [],
  };
  if (!existsSync(file)) return empty;
  return { ...empty, ...JSON.parse(readFileSync(file, 'utf8')) };
}

export function saveState(file: string, state: BotState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, file);
}

export function addEvent(state: BotState, msg: string, level: BotEvent['level'] = 'info'): void {
  state.events.push({ t: new Date().toISOString(), level, msg });
  if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
}

export function loadSamples(file: string): EquitySample[] {
  if (!existsSync(file)) return [];
  const out: EquitySample[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line from a crash */ }
  }
  return out;
}

export function appendSample(file: string, sample: EquitySample): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(sample)}\n`);
}
