/**
 * Runs the put spread bot on this computer, for development and testing. Production runs
 * on Cloudflare (worker/index.ts, https://cryptospread.trade). Never run both against the
 * same Deribit account: both would trade.
 *
 *   npm run bot
 *   npm run bot -- --config other.json
 *
 * Serves the dashboard with trade buttons at http://127.0.0.1:4191 and a read-only copy
 * at http://127.0.0.1:4192, both reachable from this computer only.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { createBot, IDS, type BotConfig, type CommandResult } from '../lib/bot.ts';
import { DeribitBroker, type Broker } from '../lib/broker.ts';
import type { MarketId } from '../lib/markets.ts';
import { addSample } from '../lib/metrics.ts';
import type { Seed } from '../lib/seed.ts';
import { appendSample, loadSamples, loadState, saveState } from '../lib/store.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const fileConfig: BotConfig = JSON.parse(readFileSync(arg('config') ?? 'bot.config.json', 'utf8'));
const mode = (arg('mode') ?? fileConfig.mode) as BotConfig['mode'];
if (mode !== 'testnet' && mode !== 'live') throw new Error(`Unknown mode "${mode}": use testnet or live`);
const config: BotConfig = { ...fileConfig, mode };
try { process.loadEnvFile('.env'); } catch { /* keys can also come from the environment */ }

const stateFile = config.stateFile ?? `data/bot-state-${mode}.json`;
const equityFile = config.equityFile ?? `data/equity-${mode}.jsonl`;
const state = loadState(stateFile, Object.fromEntries(IDS.map((id) => [id, config.markets[id].enabled])) as Record<MarketId, boolean>);
// A state saved before the running equity summary existed: rebuild it from the log.
if (!state.equity) for (const s of loadSamples(equityFile)) state.equity = addSample(state.equity, s);

// One bot per account on this computer: two copies would each open the day's spreads.
const lockFile = `${stateFile}.lock`;
try {
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
mkdirSync(dirname(lockFile), { recursive: true });
writeFileSync(lockFile, String(process.pid));
process.on('exit', () => {
  try { if (Number(readFileSync(lockFile, 'utf8')) === process.pid) unlinkSync(lockFile); } catch { /* already gone */ }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));

const problems: string[] = [];
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

const clients = new Set<ServerResponse>();
const publicClients = new Set<ServerResponse>();

let seed: Seed | undefined;
try { seed = JSON.parse(readFileSync('data/seed.json', 'utf8')); } catch { /* no simulated history */ }

const bot = createBot({
  config,
  broker,
  problems,
  state,
  seed,
  save: () => saveState(stateFile, state),
  onSample: (s) => appendSample(equityFile, s),
  onChange: () => push(),
  logLine: (msg, level) => (level === 'info' ? console.log : console.warn)(`[${new Date().toISOString()}] ${msg}`),
});

function push() {
  if (clients.size) {
    const message = `data: ${JSON.stringify(bot.view())}\n\n`;
    for (const c of clients) c.write(message);
  }
  if (publicClients.size) {
    const message = `data: ${JSON.stringify(bot.publicView())}\n\n`;
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

function stream(req: IncomingMessage, res: ServerResponse, set: Set<ServerResponse>, data: () => unknown) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify(data())}\n\n`);
  set.add(res);
  req.on('close', () => set.delete(res));
}

function page(res: ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(readFileSync('page/index.html'));
}

const ORIGINS = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, ...(config.controlOrigins ?? [])]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${config.port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') return page(res);
    if (req.method === 'GET' && url.pathname === '/api/state') return reply(res, 200, bot.view());
    if (req.method === 'GET' && url.pathname === '/api/events') return stream(req, res, clients, bot.view);
    if (req.method !== 'POST') return reply(res, 404, { error: 'not found' });

    // These buttons move money, so only this dashboard may press them. The custom
    // header forces a CORS preflight the bot never approves, which stops any other
    // website open in the same browser from sending these requests.
    if (req.headers['x-bot-dashboard'] !== '1' || (req.headers.origin && !ORIGINS.has(req.headers.origin))) {
      return reply(res, 403, { error: 'forbidden' });
    }
    const body = await readBody(req);
    let r: CommandResult | null = null;
    if (url.pathname === '/api/trading') r = await bot.commands.setTrading(body.market as MarketId, Boolean(body.on));
    if (url.pathname === '/api/enter') r = await bot.commands.enter(body.market as MarketId);
    if (url.pathname === '/api/close') r = await bot.commands.close(String(body.id));
    if (url.pathname === '/api/stop') r = await bot.commands.stop(String(body.jobId));
    return r ? reply(res, r.status, r.body) : reply(res, 404, { error: 'not found' });
  } catch (e) {
    bot.log(`Dashboard request ${url.pathname} failed: ${(e as Error).message}`, 'error');
    if (!res.headersSent) reply(res, 500, { error: (e as Error).message });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Put spread bot · ${mode} · dashboard http://127.0.0.1:${config.port}`);
  for (const p of problems) console.warn(p);
});

// The public dashboard answers GET requests only, so nothing on this port can change
// the bot or touch the account, whoever reaches it.
if (config.publicPort) {
  const publicServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${config.publicPort}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') return page(res);
      if (req.method === 'GET' && url.pathname === '/api/state') return reply(res, 200, bot.publicView());
      if (req.method === 'GET' && url.pathname === '/api/events') return stream(req, res, publicClients, bot.publicView);
      return reply(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
    }
  });
  publicServer.listen(config.publicPort, '127.0.0.1', () => console.log(`Public read-only dashboard http://127.0.0.1:${config.publicPort}`));
}

bot.log(`Bot started on this computer against the Deribit ${mode === 'live' ? 'LIVE' : 'test'} exchange${problems.length ? `, not yet able to trade: ${problems[0]}` : ''}`, problems.length ? 'warn' : 'info');

let ticking = false;
const loop = async (accountFirst: boolean) => {
  if (ticking) return;
  ticking = true;
  try { await bot.cycle({ accountFirst }); } catch (e) { console.error(e); } finally { ticking = false; }
};
// The first cycle reads the account before planning; later ones already know it.
loop(true);
setInterval(() => loop(false), config.pollSeconds * 1000);
