// Date-prefix naming for Library/ and Assets/: every document and file is named  YYYY-MM-DD_<name>  (the day it was made),
// so Finder, OneDrive and search list them in order and a name like 2026-10-08_website-relaunch-brief is easy to cite.
//
//   node app/datename.js           dry run: what would be renamed, and which notes link to it
//   node app/datename.js --apply   rename, rewrite the links in the vault's Markdown (and canvas) files, update app/publish-state.json
//
// The date: `added:` (Markdown frontmatter) or <meta name="ycos:added"> (HTML); otherwise the file's creation or modification
// date, whichever is earlier. A sidecar note (same name, .md) gets the same prefix as its file. Names that already start with
// a date are left alone. Published copies in OneDrive keep their old names, so links already shared keep working
// (publish.js and the hub find a copy through app/publish-state.json, or by the name without the date).

const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DATED = /^\d{4}-\d{2}-\d{2}_/;
const apply = process.argv.includes('--apply');

const day = (d) => d.toISOString().slice(0, 10);
const fileDay = (p) => { const st = fs.statSync(p); const b = st.birthtime && st.birthtime.getTime() > 0 ? st.birthtime : st.mtime; return day(b < st.mtime ? b : st.mtime); };
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
const fmAdded = (p) => { const m = fs.readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---/); const a = m && m[1].match(/^added:\s*["']?(\d{4}-\d{2}-\d{2})/m); return a ? a[1] : ''; };
const htmlAdded = (p) => { const m = fs.readFileSync(p, 'utf8').match(/<meta\s+[^>]*name=["']ycos:added["'][^>]*content=["'](\d{4}-\d{2}-\d{2})/i); return m ? m[1] : ''; };
const stemOf = (n) => n.replace(/\.[^.]+$/, '');
const visible = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => !n.startsWith('.')) : [];

// ---- plan: one group per stem (a file and its .md sidecar move together) ----
const plan = []; // {dir, stem, date, names[]}
for (const dir of ['Library', 'Assets']) {
  const abs = path.join(ROOT, dir); const groups = new Map();
  for (const n of visible(abs)) {
    if (DATED.test(n)) continue;
    const isDir = fs.statSync(path.join(abs, n)).isDirectory();
    if (isDir && dir === 'Assets') continue;
    const stem = isDir ? n : stemOf(n);
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(n);
  }
  for (const [stem, names] of groups) {
    let date = '';
    for (const n of names) { // a recorded date wins over the file system
      const p = path.join(ROOT, dir, n);
      if (fs.statSync(p).isDirectory()) { const main = visible(p).find(f => f === n + '.html') || visible(p).find(f => f === 'index.html') || visible(p).find(f => /\.html?$/i.test(f)); if (main) date = date || htmlAdded(path.join(p, main)); }
      else if (n.endsWith('.md')) date = date || fmAdded(p);
      else if (/\.html?$/i.test(n)) date = date || htmlAdded(p);
    }
    if (!isDay(date)) { const ds = names.map(n => fileDay(path.join(ROOT, dir, n))).sort(); date = ds[0]; }
    plan.push({ dir, stem, date, names });
  }
}

const renames = []; // {dir, from, to, fromStem, toStem}
for (const g of plan) for (const n of g.names) renames.push({ dir: g.dir, from: n, to: g.date + '_' + n, fromStem: g.stem, toStem: g.date + '_' + g.stem });
for (const r of renames) if (fs.existsSync(path.join(ROOT, r.dir, r.to))) { console.error(`datename: ${r.dir}/${r.to} already exists — rename by hand first`); process.exit(1); }

// ---- links to rewrite: [[stem…]] wikilinks, and Library/… or Assets/… paths (plain or URL-encoded) ----
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = [];
const stems = new Map(); for (const r of renames) stems.set(r.fromStem, r.toStem);
for (const [from, to] of stems) rules.push([new RegExp('\\[\\[' + esc(from) + '(?=(\\.[A-Za-z0-9]+)?(\\]\\]|\\||#))', 'g'), '[[' + to.replace(/\$/g, '$$$$')]);
for (const r of renames) for (const [a, b] of [[r.from, r.to], [encodeURI(r.from), encodeURI(r.to)], [r.from.replace(/ /g, '%20'), r.to.replace(/ /g, '%20')]])
  rules.push([new RegExp('(^|[^A-Za-z0-9_-])' + esc(r.dir + '/' + a) + '(?![A-Za-z0-9._-])', 'g'), '$1' + r.dir + '/' + b]);
// a Library note's `file:` field may name the file without the folder
for (const r of renames) if (r.dir === 'Library') rules.push([new RegExp('^(file:\\s*["\']?)' + esc(r.from) + '(?=["\']?\\s*$)', 'gm'), '$1' + r.to]);

const SKIP = new Set(['.git', '.obsidian', '.trash', 'app', 'node_modules', '_templates']);
const notes = []; (function walk(d) { for (const n of fs.readdirSync(d)) { if (SKIP.has(n) || n.startsWith('.')) continue; const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else if (/\.(md|canvas)$/i.test(n) && n !== 'README.md') notes.push(p); } })(ROOT);
const edits = [];
for (const p of notes) {
  const src = fs.readFileSync(p, 'utf8'); let out = src, n = 0;
  for (const [re, to] of rules) { const c = (out.match(re) || []).length; if (c) { n += c; out = out.replace(re, to); } }
  if (out !== src) edits.push({ p, out, n });
}

// ---- report ----
if (!renames.length) { console.log('Every file in Library/ and Assets/ already starts with a date.'); process.exit(0); }
const w = Math.max(...renames.map(r => (r.dir + '/' + r.from).length));
for (const r of renames) console.log('  ' + (r.dir + '/' + r.from).padEnd(w + 2) + '→  ' + r.to);
for (const e of edits) console.log('  links  ' + path.relative(ROOT, e.p) + '  (' + e.n + ')');
if (!apply) { console.log(`\n${renames.length} files, ${edits.length} notes with links. Dry run — run with --apply to rename.`); process.exit(0); }

// ---- apply ----
// note: a later rename of a sidecar must not overwrite a rewritten note, so rewrite first (paths still old), then rename
for (const e of edits) fs.writeFileSync(e.p, e.out);
for (const r of renames) fs.renameSync(path.join(ROOT, r.dir, r.from), path.join(ROOT, r.dir, r.to));
const STATE = path.join(ROOT, 'app', 'publish-state.json');
try {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8')); let n = 0;
  for (const rec of Object.values(st.files || {})) for (const r of renames) if (r.dir === 'Library' && rec.source === 'Library/' + r.from) { rec.source = 'Library/' + r.to; n++; }
  if (n) fs.writeFileSync(STATE, JSON.stringify(st, null, 2) + '\n');
} catch (e) { /* no publish state yet */ }
console.log(`\nRenamed ${renames.length} files, rewrote links in ${edits.length} notes. Published copies keep their names. Rebuilding the hub…`);
try { console.log(require('./build.js').buildVault(require('./build.js').nodeIO(), ROOT)); } catch (e) { console.error('hub rebuild failed: ' + (e && e.message || e)); }
