#!/usr/bin/env node
// Nostrion-os publish — copy Library documents into the Publish folder (OneDrive, see app/config.json) so a share link can be made.
// The vault stays the single source of truth; the Publish folder only ever holds copies, named like the vault file.
//
//   node app/publish.js                       status: every Library document and whether its published copy is current
//   node app/publish.js <name…>               publish (or re-publish) documents — name = file name, stem, slug or title, case-insensitive
//   node app/publish.js --outdated            re-publish every published document whose vault version changed
//   node app/publish.js --remove <name…>      take a copy out of the Publish folder (unpublish)
//   node app/publish.js --link <name> <url>   save the OneDrive sharing link of a copy (Finder → Share → Copy Link); the hub shows it
//                                             instead of the folder path. Re-publishing overwrites the same file, so the link stays valid.
//
// A document is "current" when the copy has the same size and (for text files) the same content as the vault file.

const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'Library');
const { buildVault, nodeIO, hashText } = require('./build.js');
const LINKS = path.join(ROOT, 'app', 'share-links.json'); // file name → OneDrive sharing link; those links open a preview, the folder-path link downloads
const STATE = path.join(ROOT, 'app', 'publish-state.json'); // what the copies looked like at the last run — the app uses it when macOS denies it access to OneDrive

const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'config.json'), 'utf8')); } catch (e) { return {}; } })();
const PUB = String(config.publishDir || '').replace(/^~(?=\/|$)/, os.homedir());
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const TEXT = /\.(md|html?|txt|csv|json|svg|xml)$/i;

function fail(msg) { console.error('publish: ' + msg); process.exit(1); }

// ---- the Library, the way the hub sees it: one document per item; an .md sidecar with `file:` points at the real file ----
function docs() {
  if (!fs.existsSync(LIB)) fail('no Library folder in ' + ROOT);
  const names = fs.readdirSync(LIB).filter(n => !n.startsWith('.') && fs.statSync(path.join(LIB, n)).isFile());
  const out = []; const mdStems = new Set();
  for (const n of names.filter(n => n.endsWith('.md'))) {
    const stem = n.replace(/\.md$/, ''); mdStems.add(stem);
    const src = fs.readFileSync(path.join(LIB, n), 'utf8'); const fm = (src.match(/^---\n([\s\S]*?)\n---/) || ['', ''])[1];
    const get = (k) => (fm.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) || ['', ''])[1].trim().replace(/^["']|["']$/g, '');
    const file = get('file').replace(/^Library\//, '');
    out.push({ stem, title: get('title') || stem, src: 'Library/' + (file || n) });
  }
  for (const n of names.filter(n => !n.endsWith('.md'))) {
    const stem = n.replace(/\.[^.]+$/, ''); if (mdStems.has(stem)) continue;
    let title = stem;
    if (/\.html?$/i.test(n)) { const src = fs.readFileSync(path.join(LIB, n), 'utf8'); const m = src.match(/<meta\s+name="ycos:title"\s+content="([^"]*)"/i) || src.match(/<title>([^<]*)<\/title>/i); if (m) title = m[1].trim(); }
    out.push({ stem, title, src: 'Library/' + n });
  }
  for (const d of out) { d.file = path.basename(d.src); d.copy = path.join(PUB, d.file); d.abs = path.join(ROOT, d.src); }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

function state(d) {
  if (!PUB || !fs.existsSync(PUB)) return { state: 'unavailable' };
  if (!fs.existsSync(d.abs)) return { state: 'missing' };
  if (!fs.existsSync(d.copy)) return { state: 'none' };
  const a = fs.statSync(d.abs), b = fs.statSync(d.copy); const date = b.mtime.toISOString().slice(0, 10);
  if (a.size !== b.size) return { state: 'outdated', date };
  if (TEXT.test(d.abs) && !fs.readFileSync(d.abs).equals(fs.readFileSync(d.copy))) return { state: 'outdated', date };
  return { state: 'current', date };
}

function find(q) { // match on file name, stem, slug or title; exact first, then prefix/contains
  const all = docs(); const k = String(q).toLowerCase().replace(/^library\//i, ''); const ks = slug(k.replace(/\.[^.]+$/, ''));
  const exact = all.filter(d => [d.file, d.stem, slug(d.stem), d.title, slug(d.title)].map(x => x.toLowerCase()).includes(k) || slug(d.stem) === ks || slug(d.title) === ks);
  if (exact.length) return exact;
  return all.filter(d => slug(d.stem).includes(ks) || slug(d.title).includes(ks));
}

function requirePub() {
  if (!PUB) fail('no publishDir in app/config.json');
  if (!fs.existsSync(PUB)) fail('Publish folder not found: ' + PUB + '\n  Is OneDrive running and signed in? Create the folder there or change publishDir in app/config.json.');
}

function printStatus() {
  const rows = docs().map(d => ({ ...d, ...state(d) }));
  const label = { current: '✓ current', outdated: '↑ OUTDATED', none: '—', unavailable: '? folder unavailable', missing: '! file missing' };
  const w = Math.max(...rows.map(r => r.file.length), 4);
  console.log('Publish folder: ' + (PUB || '(not configured)') + (PUB && !fs.existsSync(PUB) ? '  (NOT FOUND)' : ''));
  for (const r of rows) console.log('  ' + (label[r.state] || r.state).padEnd(22) + (r.date || '').padEnd(12) + r.file.padEnd(w + 2) + r.title);
  const n = rows.filter(r => r.state === 'current').length, o = rows.filter(r => r.state === 'outdated').length;
  console.log(`  ${n} published` + (o ? `, ${o} outdated — run: node app/publish.js --outdated` : ''));
}

function recordState() { // app/publish-state.json: size, hash and date of every copy now in the Publish folder
  if (!PUB || !fs.existsSync(PUB)) return;
  const files = {};
  for (const d of docs()) {
    if (!fs.existsSync(d.copy)) continue;
    const st = fs.statSync(d.copy);
    files[d.file] = { size: st.size, hash: TEXT.test(d.copy) ? hashText(fs.readFileSync(d.copy, 'utf8')) : '', published: st.mtime.toISOString().slice(0, 10), source: d.src };
  }
  fs.writeFileSync(STATE, JSON.stringify({ dir: PUB, updated: new Date().toISOString(), files }, null, 2) + '\n');
}

function readLinks() { try { return JSON.parse(fs.readFileSync(LINKS, 'utf8')); } catch (e) { return {}; } }

function rebuild() { try { console.log(buildVault(nodeIO(), ROOT)); } catch (e) { console.error('hub rebuild failed: ' + (e && e.message || e)); } }

const args = process.argv.slice(2);
if (!args.length || args[0] === '--status') { printStatus(); recordState(); process.exit(0); }
if (args[0] === '--link') {
  const [q, url] = args.slice(1);
  if (!q || !/^https:\/\/\S+$/.test(url || '')) fail('usage: node app/publish.js --link <name> <https://…sharing link>');
  const m = find(q);
  if (m.length !== 1) fail(m.length ? `"${q}" is ambiguous:\n` + m.map(d => '  ' + d.file + '  —  ' + d.title).join('\n') : `no Library document matches "${q}"`);
  const links = readLinks(); links[m[0].file] = url;
  fs.writeFileSync(LINKS, JSON.stringify(links, null, 2) + '\n');
  console.log('link saved  ' + m[0].file + '  →  ' + url);
  rebuild(); process.exit(0);
}

requirePub();
const remove = args[0] === '--remove'; const names = remove ? args.slice(1) : args;
let targets = [];
if (!remove && args[0] === '--outdated') targets = docs().filter(d => state(d).state === 'outdated');
else for (const q of names) {
  const m = find(q);
  if (!m.length) fail(`no Library document matches "${q}". Documents:\n` + docs().map(d => '  ' + d.file + '  —  ' + d.title).join('\n'));
  if (m.length > 1) fail(`"${q}" is ambiguous:\n` + m.map(d => '  ' + d.file + '  —  ' + d.title).join('\n'));
  targets.push(m[0]);
}
if (!targets.length) { console.log(remove ? 'nothing to remove' : 'nothing outdated — every published copy is current'); process.exit(0); }

for (const d of targets) {
  if (remove) { if (fs.existsSync(d.copy)) { fs.unlinkSync(d.copy); console.log('removed   ' + d.file); } else console.log('not published  ' + d.file); continue; }
  if (!fs.existsSync(d.abs)) fail('vault file missing: ' + d.src);
  const was = state(d).state;
  fs.copyFileSync(d.abs, d.copy); // plain copy, new mtime → the app notices the Publish folder changed and rebuilds the hub
  console.log((was === 'none' ? 'published ' : 'updated   ') + d.file + '  →  ' + d.copy);
}
recordState();
rebuild();
if (!remove) {
  const links = readLinks(); const missing = targets.filter(d => !links[d.file]);
  for (const d of targets) if (links[d.file]) console.log('\nLink (unchanged): ' + links[d.file]);
  if (missing.length) console.log('\nShare: Finder → right-click the file in ' + PUB + ' → Share → Copy Link (OneDrive), then save it once:\n' + missing.map(d => '  node app/publish.js --link ' + d.stem + ' "<link>"').join('\n') + '\nA sharing link opens a preview in the browser; the plain folder link downloads the file.');
}
