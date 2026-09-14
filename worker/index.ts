/// <reference types="@cloudflare/workers-types" />
/**
 * The bot's production home: a Cloudflare Worker at https://cryptospread.trade.
 *
 * - A cron trigger runs one bot cycle (lib/bot.ts) every minute.
 * - The same Worker serves the public, read-only dashboard: GET / and GET /api/state.
 *   Nothing reachable from the internet can trade.
 * - Memory lives in the D1 database `cryptospread`: the bot's state, the latest dashboard
 *   data, and the account value once a minute.
 * - Manual actions are rows in the `commands` table, which only someone with access to
 *   Ivan's Cloudflare account can add, for example:
 *     INSERT INTO commands (kind, payload) VALUES ('enter', '{"market":"BTC"}');
 *   Kinds: enter {"market"}, close {"id"}, stop {"jobId"}, trading {"market","on"}.
 *   The next cycle carries it out and writes the outcome into `result`.
 * - Deribit keys are Worker secrets (DERIBIT_TESTNET_CLIENT_ID, DERIBIT_TESTNET_CLIENT_SECRET),
 *   added by Ivan in the Cloudflare dashboard.
 */
import configJson from '../bot.config.json';
import page from '../page/index.html';
import { createBot, IDS, type Bot, type BotConfig } from '../lib/bot.ts';
import { DeribitBroker, type Broker } from '../lib/broker.ts';
import type { MarketId } from '../lib/markets.ts';
import type { EquitySample } from '../lib/metrics.ts';
import { emptyState, mergeState } from '../lib/state.ts';

export interface Env {
  DB: D1Database;
  DERIBIT_TESTNET_CLIENT_ID?: string;
  DERIBIT_TESTNET_CLIENT_SECRET?: string;
  DERIBIT_CLIENT_ID?: string;
  DERIBIT_CLIENT_SECRET?: string;
  DERIBIT_ALLOW_LIVE?: string;
}

const config = configJson as BotConfig;
const TRADING_DEFAULTS = Object.fromEntries(IDS.map((id) => [id, config.markets[id].enabled])) as Record<MarketId, boolean>;
/** A cycle that dies without releasing its lease blocks later cycles for at most this long. */
const LEASE_MS = 5 * 60_000;

const PAGE = page.replace('<script>', `<script>window.__SNAPSHOT_URL__ = '/api/state';</script>\n<script>`);

const SCHEMA = [
  // key 'state': the bot's full state as JSON; 'view': the latest dashboard data; 'lease': stops two cycles overlapping.
  'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  // The account value once a minute, kept as a permanent record. The dashboard reads a running summary from the state instead.
  'CREATE TABLE IF NOT EXISTS samples (t INTEGER PRIMARY KEY, equity_usd REAL NOT NULL, strategy_usd REAL NOT NULL)',
  "CREATE TABLE IF NOT EXISTS commands (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), done_at INTEGER, result TEXT)",
];

let schemaReady = false;
async function ensureSchema(db: D1Database) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  schemaReady = true;
}

async function kvGet(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM kv WHERE key = ?1').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function kvPut(db: D1Database, key: string, value: string) {
  await db.prepare('INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

/** Only one cycle at a time: two would each place the day's orders. */
async function acquireLease(db: D1Database, until: string): Promise<boolean> {
  const r = await db
    .prepare("INSERT INTO kv (key, value) VALUES ('lease', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(kv.value AS INTEGER) < ?2")
    .bind(until, Date.now())
    .run();
  return r.meta.changes > 0;
}

async function releaseLease(db: D1Database, until: string) {
  await db.prepare("UPDATE kv SET value = '0' WHERE key = 'lease' AND value = ?1").bind(until).run();
}

function connect(env: Env): { broker: Broker | null; problems: string[] } {
  const problems: string[] = [];
  if (config.mode === 'testnet') {
    if (env.DERIBIT_TESTNET_CLIENT_ID && env.DERIBIT_TESTNET_CLIENT_SECRET) {
      return { broker: new DeribitBroker('testnet', env.DERIBIT_TESTNET_CLIENT_ID, env.DERIBIT_TESTNET_CLIENT_SECRET), problems };
    }
    problems.push('Deribit test keys are not set up yet: add DERIBIT_TESTNET_CLIENT_ID and DERIBIT_TESTNET_CLIENT_SECRET as secrets on the cryptospread Worker (Cloudflare dashboard, Workers & Pages, cryptospread, Settings, Variables and Secrets). Prices show; nothing can trade yet.');
    return { broker: null, problems };
  }
  if (env.DERIBIT_ALLOW_LIVE !== 'real-money') problems.push('Live mode is locked because it trades real money. Nothing can trade.');
  else if (!env.DERIBIT_CLIENT_ID || !env.DERIBIT_CLIENT_SECRET) problems.push('Live keys missing: add DERIBIT_CLIENT_ID and DERIBIT_CLIENT_SECRET as Worker secrets.');
  else return { broker: new DeribitBroker('live', env.DERIBIT_CLIENT_ID, env.DERIBIT_CLIENT_SECRET), problems };
  return { broker: null, problems };
}

/** The saved state, with a save that coalesces the many small saves a cycle makes into few writes. */
async function openState(db: D1Database) {
  const raw = await kvGet(db, 'state');
  const state = raw ? mergeState(JSON.parse(raw), TRADING_DEFAULTS) : emptyState(TRADING_DEFAULTS);
  const sampleWrites: Promise<unknown>[] = [];
  let writing: Promise<void> | null = null;
  let again = false;

  const write = async () => {
    do {
      again = false;
      try {
        await kvPut(db, 'state', JSON.stringify(state));
      } catch (e) {
        console.error(`Saving the bot state failed: ${(e as Error).message}`);
      }
    } while (again);
    writing = null;
  };
  const save = () => {
    if (writing) again = true;
    else writing = write();
  };

  return {
    state,
    save,
    addSample(s: EquitySample) {
      sampleWrites.push(db.prepare('INSERT OR REPLACE INTO samples (t, equity_usd, strategy_usd) VALUES (?1, ?2, ?3)').bind(s.t, s.equityUsd, s.strategyUsd).run());
    },
    async flush() {
      save();
      while (writing) await writing;
      await Promise.allSettled(sampleWrites);
    },
  };
}

type CommandRow = { id: number; kind: string; payload: string };

async function runCommands(db: D1Database, bot: Bot) {
  const { results } = await db.prepare('SELECT id, kind, payload FROM commands WHERE done_at IS NULL ORDER BY id LIMIT 5').all<CommandRow>();
  for (const c of results ?? []) {
    // Claim it first, so a cycle that dies halfway never runs the same command twice.
    const claim = await db.prepare("UPDATE commands SET done_at = ?1, result = 'running' WHERE id = ?2 AND done_at IS NULL").bind(Date.now(), c.id).run();
    if (!claim.meta.changes) continue;
    let outcome: string;
    try {
      const p = JSON.parse(c.payload || '{}');
      const r = c.kind === 'enter' ? await bot.commands.enter(p.market)
        : c.kind === 'close' ? await bot.commands.close(p.id)
        : c.kind === 'stop' ? await bot.commands.stop(p.jobId)
        : c.kind === 'trading' ? await bot.commands.setTrading(p.market, Boolean(p.on))
        : { status: 400, body: { error: `unknown command "${c.kind}"` } };
      outcome = r.body.result ?? r.body.error ?? `status ${r.status}`;
    } catch (e) {
      outcome = `error: ${(e as Error).message}`;
    }
    await db.prepare('UPDATE commands SET done_at = ?1, result = ?2 WHERE id = ?3').bind(Date.now(), outcome, c.id).run();
  }
}

async function runCycle(env: Env) {
  await ensureSchema(env.DB);
  const until = String(Date.now() + LEASE_MS);
  if (!(await acquireLease(env.DB, until))) {
    console.warn('The previous cycle is still running; this one is skipped.');
    return;
  }
  try {
    const store = await openState(env.DB);
    const { broker, problems } = connect(env);
    const bot = createBot({
      config,
      broker,
      problems,
      state: store.state,
      save: store.save,
      onSample: (s) => store.addSample(s),
      logLine: (msg, level) => (level === 'info' ? console.log : console.warn)(msg),
    });
    try {
      await bot.cycle();
      await runCommands(env.DB, bot);
    } catch (e) {
      const msg = `Cycle failed and will retry next minute: ${(e as Error).message}`;
      console.error(msg);
      if (store.state.events.at(-1)?.msg !== msg) bot.log(msg, 'error');
    }
    await store.flush();
    await kvPut(env.DB, 'view', JSON.stringify({ ...bot.publicView(), snapshotAt: Date.now() }));
  } finally {
    await releaseLease(env.DB, until);
  }
}

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runCycle(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', ...SECURITY_HEADERS } });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS } });
    }
    if (url.pathname === '/api/state') {
      await ensureSchema(env.DB);
      const view = await kvGet(env.DB, 'view');
      return new Response(view ?? JSON.stringify({ error: 'The bot has not completed its first cycle yet.' }), {
        status: view ? 200 : 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
      });
    }
    return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
  },
} satisfies ExportedHandler<Env>;
