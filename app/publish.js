#!/usr/bin/env node
// Publish — copy Library documents into the Publish folder (OneDrive, see app/config.json) so a share link can be made.
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
// A folder in Library (a bundle: <name>/<name>.html plus its data and assets) is one document, published as a folder of the same
// name: copy each file in place and drop stale ones, never recreate the folder, so a share link to the folder stays valid.

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
const undate = (s) => String(s).replace(/^\d{4}-\d{2}-\d{2}_/, ''); // vault names start with a date (app/datename.js); older copies may not

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
    if (/^~?\//.test(file)) continue; // lives outside the vault (e.g. already in the shared folder): nothing to copy
    out.push({ stem, title: get('title') || stem, src: 'Library/' + (file || n) });
  }
  for (const n of names.filter(n => !n.endsWith('.md'))) {
    const stem = n.replace(/\.[^.]+$/, ''); if (mdStems.has(stem)) continue;
    let title = stem;
    if (/\.html?$/i.test(n)) { const src = fs.readFileSync(path.join(LIB, n), 'utf8'); const m = src.match(/<meta\s+name="ycos:title"\s+content="([^"]*)"/i) || src.match(/<title>([^<]*)<\/title>/i); if (m) title = m[1].trim(); }
    out.push({ stem, title, src: 'Library/' + n });
  }
  for (const n of fs.readdirSync(LIB).filter(n => !n.startsWith('.') && fs.statSync(path.join(LIB, n)).isDirectory())) { // bundles
    const files = fs.readdirSync(path.join(LIB, n)).filter(f => !f.startsWith('.') && fs.statSync(path.join(LIB, n, f)).isFile()).sort();
    const main = files.includes(n + '.html') ? n + '.html' : files.includes(undate(n) + '.html') ? undate(n) + '.html' : files.includes('index.html') ? 'index.html' : files.find(f => /\.html?$/i.test(f));
    if (!main) continue;
    let title = n; const src = fs.readFileSync(path.join(LIB, n, main), 'utf8'); const m = src.match(/<meta\s+name="ycos:title"\s+content="([^"]*)"/i) || src.match(/<title>([^<]*)<\/title>/i); if (m) title = m[1].trim();
    out.push({ stem: n, title, src: 'Library/' + n, bundle: true, files });
  }
  // the copy keeps the name it was first published under, so links already shared keep working: the name recorded for this
  // source in publish-state.json, else an existing copy named like the file (with or without its date), else the file name
  const rec = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')).files || {}; } catch (e) { return {}; } })();
  const bySource = new Map(Object.entries(rec).map(([k, r]) => [r.source, k]));
  for (const d of out) {
    const own = path.basename(d.src); const cands = [bySource.get(d.src), own, undate(own)].filter(Boolean);
    d.name = own; d.file = (PUB && cands.find(n => fs.existsSync(path.join(PUB, n)))) || cands[0]; d.copy = path.join(PUB, d.file); d.abs = path.join(ROOT, d.src);
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}
const sameFile = (a, b) => { const sa = fs.statSync(a), sb = fs.statSync(b); if (sa.size !== sb.size) return false; return TEXT.test(a) ? fs.readFileSync(a).equals(fs.readFileSync(b)) : true; };
const bundleSig = (d) => { let size = 0; const parts = []; for (const n of d.files) { const p = path.join(d.abs, n); const st = fs.statSync(p); size += st.size; parts.push(n + ':' + st.size + ':' + (TEXT.test(n) ? hashText(fs.readFileSync(p, 'utf8')) : '')); } return { size, hash: hashText(parts.join('|')) }; };

function state(d) {
  if (!PUB || !fs.existsSync(PUB)) return { state: 'unavailable' };
  if (!fs.existsSync(d.abs)) return { state: 'missing' };
  if (!fs.existsSync(d.copy)) return { state: 'none' };
  const date = fs.statSync(d.copy).mtime.toISOString().slice(0, 10);
  if (d.bundle) {
    const have = fs.readdirSync(d.copy).filter(f => !f.startsWith('.') && fs.statSync(path.join(d.copy, f)).isFile());
    if (have.length !== d.files.length || d.files.some(n => !have.includes(n) || !sameFile(path.join(d.abs, n), path.join(d.copy, n)))) return { state: 'outdated', date };
    return { state: 'current', date };
  }
  return { state: sameFile(d.abs, d.copy) ? 'current' : 'outdated', date };
}

function find(q) { // match on file name, stem, slug or title; exact first, then prefix/contains
  const all = docs(); const k = String(q).toLowerCase().replace(/^library\//i, ''); const ks = slug(k.replace(/\.[^.]+$/, ''));
  const exact = all.filter(d => [d.file, d.name, d.stem, undate(d.stem), slug(d.stem), d.title, slug(d.title)].map(x => x.toLowerCase()).includes(k) || slug(d.stem) === ks || slug(undate(d.stem)) === ks || slug(d.title) === ks);
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
    if (d.bundle) { const sig = bundleSig({ ...d, abs: d.copy }); files[d.file] = { ...sig, published: st.mtime.toISOString().slice(0, 10), source: d.src, bundle: true }; continue; }
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
  if (remove) { if (fs.existsSync(d.copy)) { fs.rmSync(d.copy, { recursive: true, force: true }); console.log('removed   ' + d.file); } else console.log('not published  ' + d.file); continue; }
  if (!fs.existsSync(d.abs)) fail('vault file missing: ' + d.src);
  const was = state(d).state;
  if (d.bundle) { // copy each file in place and remove stale ones; the folder itself is kept so its share link survives
    fs.mkdirSync(d.copy, { recursive: true });
    for (const n of d.files) fs.copyFileSync(path.join(d.abs, n), path.join(d.copy, n));
    for (const n of fs.readdirSync(d.copy)) if (!n.startsWith('.') && !d.files.includes(n) && fs.statSync(path.join(d.copy, n)).isFile()) fs.unlinkSync(path.join(d.copy, n));
  } else fs.copyFileSync(d.abs, d.copy); // plain copy, new mtime → the app notices the Publish folder changed and rebuilds the hub
  console.log((was === 'none' ? 'published ' : 'updated   ') + d.file + (d.bundle ? '/ (' + d.files.length + ' files)' : '') + '  →  ' + d.copy);
}
recordState();
rebuild();
if (!remove) {
  const links = readLinks(); const missing = targets.filter(d => !links[d.file]);
  for (const d of targets) if (links[d.file]) console.log('\nLink (unchanged): ' + links[d.file]);
  if (missing.length) console.log('\nShare: Finder → right-click the ' + (missing.some(d => d.bundle) ? 'folder or file' : 'file') + ' in ' + PUB + ' → Share → Copy Link (OneDrive), then save it once:\n' + missing.map(d => '  node app/publish.js --link ' + d.stem + ' "<link>"').join('\n') + '\nA sharing link opens a preview in the browser; the plain folder link downloads the file.');
}
