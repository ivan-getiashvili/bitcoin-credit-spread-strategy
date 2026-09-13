/**
 * Builds the static monitoring site: the dashboard page, set to read the snapshot the
 * last scheduled bot run published, plus that snapshot.
 *
 *   npm run site -- [snapshot path]    # default data/public-state.json -> _site/
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const snapshot = process.argv[2] ?? 'data/public-state.json';
if (!existsSync(snapshot)) throw new Error(`No snapshot at ${snapshot}; run the bot with --once first`);

const page = readFileSync('page/index.html', 'utf8');
const marker = '<script>';
if (!page.includes(marker)) throw new Error('page/index.html has no <script> to place the snapshot setting before');
const html = page.replace(marker, `<script>window.__SNAPSHOT_URL__ = 'public-state.json';</script>\n${marker}`);

mkdirSync('_site', { recursive: true });
writeFileSync('_site/index.html', html);
copyFileSync(snapshot, '_site/public-state.json');
// Serve files as they are, without GitHub Pages' Jekyll processing.
writeFileSync('_site/.nojekyll', '');
console.log(`Built _site/ from ${snapshot}`);
