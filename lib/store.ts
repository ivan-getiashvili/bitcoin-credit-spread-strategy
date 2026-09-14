/**
 * The bot's memory on a computer: one JSON state file and one equity log per mode
 * (data/bot-state-testnet.json, data/equity-testnet.jsonl), so test-exchange
 * history never mixes with real-money history. State is written atomically: a
 * crash mid-write leaves the previous file intact. On Cloudflare the same state
 * lives in D1 instead (worker/index.ts).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MarketId } from './markets.ts';
import type { EquitySample } from './metrics.ts';
import { emptyState, mergeState, type BotState } from './state.ts';

export function loadState(file: string, tradingDefaults: Record<MarketId, boolean>): BotState {
  if (!existsSync(file)) return emptyState(tradingDefaults);
  return mergeState(JSON.parse(readFileSync(file, 'utf8')), tradingDefaults);
}

export function saveState(file: string, state: BotState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, file);
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
