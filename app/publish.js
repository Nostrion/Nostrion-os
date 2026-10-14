#!/usr/bin/env node
// Publish — move a Library document into the Publish folder (OneDrive, see app/config.json) so a share link can be made.
// One copy only: the file (or folder document) moves to OneDrive and Library keeps a link note with the same name, whose
// `file:` points at it; the hub lists it as before and opens the OneDrive file. Edit a published document in OneDrive.
// Markdown notes are the exception: they stay in the vault and the Publish folder gets a copy.
//
//   node app/publish.js                       status: every Library document and where its shared version is
//   node app/publish.js <name…>               publish — name = file name, stem, slug or title, case-insensitive
//   node app/publish.js --outdated            re-copy published Markdown notes whose vault version changed
//   node app/publish.js --remove <name…>      unpublish: a moved document comes back into Library, a copied note is deleted from OneDrive
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
    if (/^~?\//.test(file)) { const abs = file.replace(/^~(?=\/)/, os.homedir()); out.push({ stem, title: get('title') || stem, src: 'Library/' + n, external: abs, note: 'Library/' + n }); continue; } // already moved: the link note
    const other = names.find(x => x !== n && x.replace(/\.[^.]+$/, '') === stem); // a .md next to a pdf/html of the same name describes that file
    out.push({ stem, title: get('title') || stem, src: 'Library/' + (file || other || n), note: file || other ? 'Library/' + n : '' });
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
    if (d.external) { // moved: the shared file is the only copy
      const inPub = PUB && d.external.startsWith(PUB + '/'); d.file = inPub ? d.external.slice(PUB.length + 1).split('/')[0] : path.basename(d.external); d.name = d.file;
      d.copy = inPub ? path.join(PUB, d.file) : d.external; d.abs = d.copy; d.bundle = inPub && fs.existsSync(d.copy) && fs.statSync(d.copy).isDirectory(); continue;
    }
    const own = path.basename(d.src); const cands = [bySource.get(d.src), own, undate(own)].filter(Boolean);
    d.name = own; d.file = (PUB && cands.find(n => fs.existsSync(path.join(PUB, n)))) || cands[0]; d.copy = path.join(PUB, d.file); d.abs = path.join(ROOT, d.src);
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}
const sameFile = (a, b) => { const sa = fs.statSync(a), sb = fs.statSync(b); if (sa.size !== sb.size) return false; return TEXT.test(a) ? fs.readFileSync(a).equals(fs.readFileSync(b)) : true; };
const bundleSig = (d) => { let size = 0; const parts = []; for (const n of d.files) { const p = path.join(d.abs, n); const st = fs.statSync(p); size += st.size; parts.push(n + ':' + st.size + ':' + (TEXT.test(n) ? hashText(fs.readFileSync(p, 'utf8')) : '')); } return { size, hash: hashText(parts.join('|')) }; };

function state(d) {
  if (d.external) return fs.existsSync(d.copy) ? { state: 'moved', date: fs.statSync(d.copy).mtime.toISOString().slice(0, 10) } : { state: 'missing' };
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
  const label = { moved: '✓ in OneDrive', current: '✓ current (copy)', outdated: '↑ OUTDATED', none: '—', unavailable: '? folder unavailable', missing: '! file missing' };
  const w = Math.max(...rows.map(r => r.file.length), 4);
  console.log('Publish folder: ' + (PUB || '(not configured)') + (PUB && !fs.existsSync(PUB) ? '  (NOT FOUND)' : ''));
  for (const r of rows) console.log('  ' + (label[r.state] || r.state).padEnd(22) + (r.date || '').padEnd(12) + r.file.padEnd(w + 2) + r.title);
  const n = rows.filter(r => r.state === 'current' || r.state === 'moved').length, o = rows.filter(r => r.state === 'outdated').length;
  console.log(`  ${n} published` + (o ? `, ${o} outdated — run: node app/publish.js --outdated` : ''));
}

function recordState() { // app/publish-state.json: size, hash and date of every copy now in the Publish folder
  if (!PUB || !fs.existsSync(PUB)) return;
  const files = {};
  for (const d of docs()) {
    if (d.external || !fs.existsSync(d.copy)) continue; // a moved document is its own record
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

// ---- moving: the vault file goes, a link note with the same name stays ----
const META = (src, k) => { const m = src.match(new RegExp('<meta\\s+[^>]*name=["\']ycos:' + k + '["\'][^>]*content=["\']([^"\']*)["\']', 'i')); return m ? m[1].trim() : ''; };
const yaml = (v) => /^[\w .,()&+-]*$/.test(v) && !/^\d/.test(v) ? v : JSON.stringify(v);
function linkNote(d) { // the note that stays in Library: the file's own frontmatter/meta, plus file: → OneDrive
  const tilde = (p) => p.startsWith(os.homedir() + '/') ? '~' + p.slice(os.homedir().length) : p;
  const main = d.bundle ? path.join(d.copy, d.files.includes(d.name + '.html') ? d.name + '.html' : d.files.includes(undate(d.name) + '.html') ? undate(d.name) + '.html' : d.files.includes('index.html') ? 'index.html' : d.files.find(f => /\.html?$/i.test(f))) : d.copy;
  const notePath = path.join(LIB, d.stem + '.md');
  if (fs.existsSync(notePath)) { // a note already describes it: point its file: at OneDrive
    let src = fs.readFileSync(notePath, 'utf8'); const fm = src.match(/^---\n([\s\S]*?)\n---/);
    const line = 'file: ' + tilde(main);
    if (fm) { const lines = fm[1].split('\n').filter(l => !/^file:/.test(l)); lines.push(line); src = '---\n' + lines.join('\n') + '\n---' + src.slice(fm[0].length); } else src = '---\n' + line + '\n---\n' + src;
    fs.writeFileSync(notePath, src); return;
  }
  const html = /\.html?$/i.test(main) ? fs.readFileSync(main, 'utf8') : '';
  const title = META(html, 'title') || ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim() || undate(d.stem);
  const fm = [['title', title], ['category', META(html, 'category') || (/\.html?$/i.test(main) ? 'tool' : 'document')], ['project', META(html, 'project') ? '[[' + META(html, 'project') + ']]' : ''],
    ['status', META(html, 'status') || 'live'], ['added', META(html, 'added') || (d.stem.match(/^\d{4}-\d{2}-\d{2}/) || [''])[0]], ['tags', META(html, 'tags')], ['file', tilde(main)]].filter(([, v]) => v);
  const desc = META(html, 'description');
  fs.writeFileSync(notePath, '---\n' + fm.map(([k, v]) => k + ': ' + (k === 'file' || k === 'added' ? v : yaml(v))).join('\n') + '\n---\n' + (desc ? desc + '\n\n' : '') + `Published: lives in the OneDrive Publish folder as \`${d.file}\`. Edit it there; this note only points at it.\n`);
}
const same = (d) => d.bundle ? d.files.every(n => fs.existsSync(path.join(d.copy, n)) && sameFile(path.join(d.abs, n), path.join(d.copy, n))) : fs.existsSync(d.copy) && sameFile(d.abs, d.copy);
const isNote = (d) => !d.bundle && /\.md$/i.test(d.src);

for (const d of targets) {
  if (remove) {
    if (d.external) { // unpublish a moved document: bring it back into Library, the link note becomes its description
      if (!fs.existsSync(d.copy)) { console.log('missing in OneDrive  ' + d.file); continue; }
      const back = path.join(LIB, d.bundle ? d.stem : d.stem + path.extname(d.copy));
      if (fs.existsSync(back)) fail('already in Library: ' + path.relative(ROOT, back));
      fs.cpSync(d.copy, back, { recursive: true }); fs.rmSync(d.copy, { recursive: true, force: true });
      const np = path.join(ROOT, d.note); fs.writeFileSync(np, fs.readFileSync(np, 'utf8').replace(/^file:.*\n/m, '').replace(/^Published: lives in the OneDrive Publish folder.*\n?/m, ''));
      console.log('back in Library  ' + path.relative(ROOT, back)); continue;
    }
    if (fs.existsSync(d.copy)) { fs.rmSync(d.copy, { recursive: true, force: true }); console.log('removed   ' + d.file); } else console.log('not published  ' + d.file); continue;
  }
  if (d.external) { console.log('already in OneDrive  ' + d.file); continue; }
  if (!fs.existsSync(d.abs)) fail('vault file missing: ' + d.src);
  const was = state(d).state;
  if (!same(d)) { // copy (a share link to an existing copy or folder stays valid: files are overwritten in place)
    if (d.bundle) {
      fs.mkdirSync(d.copy, { recursive: true });
      for (const n of d.files) fs.copyFileSync(path.join(d.abs, n), path.join(d.copy, n));
      for (const n of fs.readdirSync(d.copy)) if (!n.startsWith('.') && !d.files.includes(n) && fs.statSync(path.join(d.copy, n)).isFile()) fs.unlinkSync(path.join(d.copy, n));
    } else fs.copyFileSync(d.abs, d.copy);
  }
  if (isNote(d)) { console.log((was === 'none' ? 'published ' : 'updated   ') + d.file + ' (copy; the note stays in the vault)'); continue; }
  if (!same(d)) fail('the copy in OneDrive does not match ' + d.src + ' — nothing removed from the vault');
  linkNote(d); fs.rmSync(d.abs, { recursive: true, force: true }); // verified identical → the vault keeps only the link note
  console.log('moved     ' + d.src + '  →  ' + d.copy + '  (Library keeps ' + d.stem + '.md)');
}
recordState();
rebuild();
if (!remove) {
  const links = readLinks(); const missing = targets.filter(d => !links[d.file]);
  for (const d of targets) if (links[d.file]) console.log('\nLink (unchanged): ' + links[d.file]);
  if (missing.length) console.log('\nShare: Finder → right-click the ' + (missing.some(d => d.bundle) ? 'folder or file' : 'file') + ' in ' + PUB + ' → Share → Copy Link (OneDrive), then save it once:\n' + missing.map(d => '  node app/publish.js --link ' + d.stem + ' "<link>"').join('\n') + '\nA sharing link opens a preview in the browser; the plain folder link downloads the file.');
}
