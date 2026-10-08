// Nostrion-os hub builder — runs in Node (`node app/build.js`) AND in macOS's built-in JavaScript
// (`osascript -l JavaScript app/build.js <vault>`), so no install is needed on a Mac.
// Reads the vault (Log, Projects, People, Library, Assets) and writes app/index.html from app/template.html.

// FNV-1a over the text of a file — what publish.js records in app/publish-state.json and build.js compares against
function hashText(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }

// ---------- tasks in the vault files: date stamps + edits from the hub ----------
// A task is one line: "- [ ] text (priority:: plan) (due:: 2026-10-10) (added:: 2026-10-08) (done:: 2026-10-09)".
// stampTasks() runs before every build and keeps added:: / done:: right; editTask() is what the hub calls (through main.js) to change a line.
const TASK_LINE = /^(\s*[-*+]\s+\[)([ xX\/\-])(\]\s+)(.*)$/;
const TASK_FIELD = /\s*\((\w+)::\s*([^)]*)\)/g;
const STATUS_CHAR = { open: ' ', doing: '/', done: 'x', cancelled: '-' };
const DATE_FIELDS = ['added', 'done'];
const QUIET_MS = 60000; // a file edited less than a minute ago is not stamped yet (Obsidian may still have the cursor on that line)
function localToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function parseTaskLine(line) {
  const m = String(line).match(TASK_LINE); if (!m) return null;
  const fields = []; m[4].replace(TASK_FIELD, (_, k, v) => { fields.push([k.toLowerCase(), v.trim()]); return ''; });
  return { indent: m[1], ch: m[2], text: m[4].replace(TASK_FIELD, '').replace(/\s{2,}/g, ' ').trim(), fields, closed: /[xX\-]/.test(m[2]) };
}
const taskGet = (t, k) => { const f = t.fields.find(x => x[0] === k); return f ? f[1] : undefined; };
function taskSet(t, k, v) { // empty value removes the field; a new field goes before added:: / done:: so the dates stay last
  const i = t.fields.findIndex(x => x[0] === k);
  if (v == null || v === '') { if (i >= 0) t.fields.splice(i, 1); return; }
  if (i >= 0) { t.fields[i][1] = v; return; }
  const at = DATE_FIELDS.includes(k) ? -1 : t.fields.findIndex(x => DATE_FIELDS.includes(x[0]));
  if (at < 0) t.fields.push([k, v]); else t.fields.splice(at, 0, [k, v]);
}
const formatTask = (t) => `${t.indent}${t.ch}] ${t.text}${t.fields.map(([k, v]) => ` (${k}:: ${v})`).join('')}`;
// added:: missing → the log's date (project pages: today); a task written already closed is done that same day.
// closed without done:: → today; reopened → done:: removed. "done:: unknown" (tasks closed before dates were tracked) is left alone.
function stampTask(t, addedDefault, today) {
  if (!taskGet(t, 'added')) { taskSet(t, 'added', addedDefault); if (t.closed && !taskGet(t, 'done')) taskSet(t, 'done', addedDefault); }
  else if (t.closed && !taskGet(t, 'done')) taskSet(t, 'done', today);
  if (!t.closed && taskGet(t, 'done') !== undefined) taskSet(t, 'done', '');
}
function stampTasks(io, ROOT) { // → true when a recently edited file still waits for its stamps
  const today = localToday(); let pending = false;
  for (const dir of ['Log', 'Projects']) {
    const base = ROOT + '/' + dir; if (!io.exists(base)) continue;
    for (const e of io.list(base)) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) continue;
      const p = base + '/' + e.name; const src = io.read(p); if (!/\[[ xX\/\-]\]/.test(src)) continue;
      const day = dir === 'Log' && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name) ? e.name.slice(0, 10) : today;
      let fence = false; let changed = false;
      const out = src.split('\n').map(line => {
        if (/^\s*```/.test(line)) fence = !fence; if (fence) return line;
        const t = parseTaskLine(line.replace(/\r$/, '')); if (!t) return line;
        stampTask(t, day, today); const nl = formatTask(t) + (line.endsWith('\r') ? '\r' : '');
        if (nl !== line) changed = true; return nl;
      }).join('\n');
      if (!changed) continue;
      if (Date.now() - io.stat(p).mtime.getTime() < QUIET_MS) { pending = true; continue; }
      io.write(p, out);
    }
  }
  return pending;
}
const asLink = (name) => { const n = String(name || '').replace(/^\s*\[\[|\]\]\s*$/g, '').trim(); return n ? `[[${n}]]` : ''; };
function applyTaskChange(t, req, today, addedDefault) { // req: {status, text, priority, due, waiting, project, people[]} — only the keys present are changed
  if (req.status && STATUS_CHAR[req.status] !== undefined) { const was = t.closed; t.ch = STATUS_CHAR[req.status]; t.closed = req.status === 'done' || req.status === 'cancelled'; if (t.closed && !was) taskSet(t, 'done', today); }
  if (typeof req.text === 'string') { const s = req.text.replace(/\s+/g, ' ').trim(); if (s) t.text = s; }
  for (const k of ['priority', 'due']) if (k in req) taskSet(t, k, String(req[k] || '').trim());
  for (const k of ['waiting', 'project']) if (k in req) taskSet(t, k, asLink(req[k]));
  if ('people' in req) taskSet(t, 'people', (Array.isArray(req.people) ? req.people : []).map(asLink).filter(Boolean).join(', '));
  stampTask(t, addedDefault || today, today);
}
// req.op 'edit': {file (vault-relative), raw (the line as the hub saw it), …changes}; 'add': {…changes} → appended to today's log under "## Tasks"
function editTask(io, ROOT, req) {
  const today = localToday();
  if (!req || (req.op !== 'edit' && req.op !== 'add')) return { ok: false, error: 'unknown task request' };
  if (req.op === 'add') {
    if (!String(req.text || '').trim()) return { ok: false, error: 'a task needs some text' };
    const t = { indent: '- [', ch: ' ', text: '', fields: [], closed: false }; applyTaskChange(t, Object.assign({}, req, { status: req.status || 'open' }), today);
    const p = ROOT + '/Log/' + today + '.md';
    let src = io.exists(p) ? io.read(p) : `---\ndate: ${today}\n---\n`;
    const lines = src.replace(/\s+$/, '').split('\n'); const h = lines.findIndex(l => /^##\s+Tasks\s*$/.test(l));
    if (h < 0) lines.push('', '## Tasks', '', formatTask(t));
    else { let end = h + 1; while (end < lines.length && !/^##\s/.test(lines[end])) end++; while (end > h + 1 && !lines[end - 1].trim()) end--;
      if (end === h + 1) lines.splice(end, 0, '', formatTask(t)); else lines.splice(end, 0, formatTask(t)); }
    io.write(p, lines.join('\n') + '\n');
    return { ok: true, file: 'Log/' + today + '.md' };
  }
  const file = String(req.file || ''); if (!/^(Log|Projects)\/[^/]+\.md$/.test(file)) return { ok: false, error: 'tasks can only be edited in Log/ and Projects/' };
  const p = ROOT + '/' + file; if (!io.exists(p)) return { ok: false, error: file + ' no longer exists' };
  const lines = io.read(p).split('\n'); const want = String(req.raw || '').trim();
  const i = lines.findIndex(l => l.replace(/\r$/, '').trim() === want);
  if (i < 0) return { ok: false, error: 'This task changed in ' + file + ' since the hub was built. The hub will refresh; try again.' };
  const cr = lines[i].endsWith('\r'); const t = parseTaskLine(lines[i].replace(/\r$/, ''));
  const day = (file.match(/^Log\/(\d{4}-\d{2}-\d{2})\.md$/) || [])[1];
  applyTaskChange(t, req, today, day); lines[i] = formatTask(t) + (cr ? '\r' : '');
  io.write(p, lines.join('\n'));
  return { ok: true, file };
}

function buildVault(io, ROOT) {
io.pending = stampTasks(io, ROOT); // added:: / done:: on task lines (io.pending → main.js builds again once the file is quiet)
const join = function () { return Array.prototype.slice.call(arguments).join('/'); };
const VAULT_NAME = ROOT.split('/').filter(Boolean).pop();
const OUT = join(ROOT, 'app', 'index.html');
const TEMPLATE = join(ROOT, 'app', 'template.html');
const CATEGORIES = ['meeting', 'build', 'research', 'writing', 'admin', 'learning'];
const PRIORITIES = ['do', 'plan', 'delegate', 'later']; // Eisenhower: urgent+important · important · urgent · neither
const LIBRARY_CATEGORIES = ['research', 'framework', 'brief', 'report', 'tool', 'reference', 'post', 'note']; // display order only: any other value in ycos:category works and is listed after these
const CONFIG = (() => { try { return JSON.parse(io.read(join(ROOT, 'app', 'config.json'))); } catch (e) { return {}; } })(); // app/config.json
const PUBLISH_DIR = String(CONFIG.publishDir || '').replace(/^~(?=\/|$)/, io.home()); // copies of shared Library docs live here (OneDrive)
const SHARE_BASE = String(CONFIG.shareBase || '').replace(/\/+$/, ''); // web address of that folder → per-file links in the hub

// ---------- helpers ----------
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isoDate = (d) => d.toISOString().slice(0, 10);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const listDir = (dir) => io.exists(dir) ? io.list(dir).filter(e => !e.name.startsWith('.')) : [];
const readMd = (p) => io.read(p).replace(/\r\n/g, '\n');
const fileDate = (p) => isoDate(io.stat(p).mtime);
const rel = (p) => p.startsWith(ROOT + '/') ? p.slice(ROOT.length + 1) : p;

function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function weekMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return isoDate(d);
}

// ---------- frontmatter (small YAML subset) ----------
function parseScalar(v) {
  v = v.trim();
  if (v === '' ) return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    // split on commas not inside [[ ]] or quotes
    const out = []; let cur = '', depth = 0, q = null;
    for (const ch of inner) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '[') depth++; if (ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(parseScalar(cur)); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(parseScalar(cur));
    return out;
  }
  if (v === 'true') return true; if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: text };
  const raw = text.slice(4, end).split('\n');
  const body = text.slice(end + 4).replace(/^\n/, '');
  const data = {}; let key = null;
  for (const line of raw) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const li = line.match(/^\s+-\s*(.*)$/);
    if (li && key) { if (!Array.isArray(data[key])) data[key] = []; data[key].push(parseScalar(li[1])); continue; }
    const li2 = line.match(/^-\s*(.*)$/);
    if (li2 && key) { if (!Array.isArray(data[key])) data[key] = []; data[key].push(parseScalar(li2[1])); continue; }
    const kv = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (kv) { key = kv[1]; data[key] = parseScalar(kv[2]); }
  }
  return { data, body };
}

// ---------- wikilinks ----------
const WIKI = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
function wikiTargets(text) {
  const out = []; let m; WIKI.lastIndex = 0;
  while ((m = WIKI.exec(String(text || '')))) out.push(m[1].trim());
  return out;
}
function namesFrom(v) { // frontmatter value → list of names (strip [[ ]])
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map(s => String(s).trim()).filter(Boolean).map(s => { const t = wikiTargets(s); return t.length ? t[0] : s.replace(/^\[\[|\]\]$/g, ''); });
}

// ---------- markdown → html (small, good-enough) ----------
function inline(text, resolve) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, t, alias) => {
    const target = t.trim(); const label = (alias || target).trim();
    const r = resolve(target);
    return r ? `<a class="wl" href="#/${r.type}/${r.id}">${esc(label)}</a>` : `<span class="wl missing" title="no page: ${esc(target)}">${esc(label)}</span>`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${src}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, l, href) => `<a href="${href}" target="_blank" rel="noopener">${l}</a>`);
  s = s.replace(/(^|[\s(])((https?:\/\/)[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|\s)#([a-zA-Z][\w\/-]*)/g, '$1<span class="tag">#$2</span>');
  return s;
}
function htmlMeta(src) { // <meta name="ycos:project" content="FBN"> … inside an .html document
  const out = {}; const re = /<meta\s+[^>]*name=["']ycos:([\w-]+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi; let m;
  while ((m = re.exec(src))) out[m[1].toLowerCase()] = m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
  return out;
}
const FIELD = /\((\w+)::\s*([^)]*)\)/g;
function taskFields(t) { const f = {}; t.replace(FIELD, (_, k, v) => { f[k.toLowerCase()] = v.trim(); return ''; }); f.text = t.replace(FIELD, '').replace(/\s{2,}/g, ' ').trim(); return f; }
function extractTasks(md) { // "- [ ] text (priority:: plan) (due:: 2026-10-06) (waiting:: [[Name]])"
  const out = []; for (const line of String(md || '').split('\n')) { const m = line.match(/^\s*[-*+]\s+\[([ xX\/\-])\]\s+(.*)$/); if (!m) continue;
    const f = taskFields(m[2]); const st = m[1].toLowerCase();
    out.push({ status: st === 'x' ? 'done' : st === '-' ? 'cancelled' : st === '/' ? 'doing' : 'open', text: f.text, priority: (f.priority || '').toLowerCase(), due: f.due || '',
      added: /^\d{4}-\d{2}-\d{2}$/.test(f.added || '') ? f.added : '', done: /^\d{4}-\d{2}-\d{2}$/.test(f.done || '') ? f.done : '', doneUnknown: f.done === 'unknown', raw: line.trim(), peopleField: namesFrom(f.people), waitingName: namesFrom(f.waiting)[0] || '', ownerName: namesFrom(f.owner)[0] || '', projectName: namesFrom(f.project)[0] || '', mentions: wikiTargets(m[2]) }); }
  return out;
}
function markdown(md, resolve) {
  const lines = md.split('\n'); const out = []; let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '), resolve)}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { flush(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const lvl = Math.min(h[1].length + 1, 6); out.push(`<h${lvl}>${inline(h[2], resolve)}</h${lvl}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush(); const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim(), resolve));
      const head = cells(line); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush(); const ordered = /\d/.test(li[2]); const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) { if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; } break; }
        items.push(m[3]); i++;
      }
      const render = (t) => { const task = t.match(/^\[([ xX\/\-])\]\s+(.*)$/); if (!task) return `<li>${inline(t, resolve)}</li>`;
        const st = task[1].toLowerCase(); const f = taskFields(task[2]);
        const meta = [f.priority, f.due ? 'due ' + f.due : '', f.waiting ? 'waiting on ' + f.waiting.replace(/\[\[|\]\]/g, '') : '', /^\d{4}/.test(f.done || '') && st !== ' ' ? 'done ' + f.done : ''].filter(Boolean).join(' · ');
        return `<li class="task ${st === 'x' ? 'done' : st === '-' ? 'cancelled' : st === '/' ? 'doing' : ''}"><span class="box">${st === 'x' ? '✓' : st === '/' ? '◐' : st === '-' ? '×' : ''}</span>${inline(f.text, resolve)}${meta ? ` <span class="tmeta">${esc(meta)}</span>` : ''}</li>`; };
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(render).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (/^>\s?/.test(line)) { flush(); const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${markdown(buf.join('\n'), resolve)}</blockquote>`); continue; }
    if (/^[a-zA-Z_][\w-]*::\s*/.test(line)) { i++; continue; } // inline fields handled elsewhere
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim()); i++;
  }
  flush();
  return out.join('\n');
}
const plain = (md) => String(md || '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|\[\]!()-]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- load vault ----------
const people = [], projects = [], docs = [], assets = [], days = []; const warnings = [];

for (const e of listDir(join(ROOT, 'People'))) {
  if (!e.isFile() || !e.name.endsWith('.md')) continue;
  const p = join(ROOT, 'People', e.name); const { data, body } = parseFrontmatter(readMd(p));
  const name = data.name || e.name.replace(/\.md$/, '');
  people.push({ type: 'person', id: slug(name), name, stem: e.name.replace(/\.md$/, ''), file: rel(p), edited: fileDate(p),
    role: data.role || '', organization: data.organization || data.org || '', relationship: data.relationship || '',
    location: data.location || '', email: data.email || '', phone: data.phone || '', linkedin: data.linkedin || '', tags: namesFrom(data.tags), projectNames: namesFrom(data.projects), fm: data, body, entries: [] });
}
for (const e of listDir(join(ROOT, 'Projects'))) {
  if (!e.isFile() || !e.name.endsWith('.md')) continue;
  const p = join(ROOT, 'Projects', e.name); const { data, body } = parseFrontmatter(readMd(p));
  const name = data.name || e.name.replace(/\.md$/, '');
  projects.push({ type: 'project', id: slug(name), name, stem: e.name.replace(/\.md$/, ''), file: rel(p), edited: fileDate(p),
    description: data.description || '', category: data.category || '', status: data.status || 'active', started: data.started ? String(data.started) : '',
    tags: namesFrom(data.tags), peopleNames: namesFrom(data.people), parentName: namesFrom(data.parent)[0] || '',
    fm: data, body, entries: [], hours: 0, docs: [], children: [], tasks: [] });
}
{
  const dir = join(ROOT, 'Library'); const mdStems = new Set();
  const files = listDir(dir).filter(e => e.isFile());
  for (const e of files.filter(f => f.name.endsWith('.md'))) {
    const p = join(dir, e.name); const { data, body } = parseFrontmatter(readMd(p)); const stem = e.name.replace(/\.md$/, '');
    mdStems.add(stem);
    docs.push({ type: 'doc', id: slug(stem), name: data.title || stem, stem, file: rel(p), edited: fileDate(p),
      category: data.category || 'note', status: data.status || 'draft', added: data.added ? String(data.added) : fileDate(p),
      projectName: namesFrom(data.project)[0] || '', tags: namesFrom(data.tags), open: data.file ? 'Library/' + String(data.file).replace(/^Library\//, '') : '', fm: data, body });
  }
  for (const e of files.filter(f => !f.name.endsWith('.md'))) {
    const stem = e.name.replace(/\.[^.]+$/, ''); if (mdStems.has(stem)) continue; // has sidecar → already listed
    const p = join(dir, e.name); let title = stem; let meta = {};
    if (/\.html?$/i.test(e.name)) { const src = io.read(p); const m = src.match(/<title>([^<]*)<\/title>/i); if (m) title = m[1].trim(); meta = htmlMeta(src); }
    docs.push({ type: 'doc', id: slug(stem), name: meta.title || title, stem, file: rel(p), edited: fileDate(p), category: meta.category || (/\.html?$/i.test(e.name) ? 'tool' : 'reference'), status: meta.status || 'live', added: meta.added || fileDate(p), projectName: meta.project || '', tags: namesFrom(meta.tags), open: rel(p), fm: meta, body: '', description: meta.description || '' });
  }
}
{
  const dir = join(ROOT, 'Assets'); const files = listDir(dir).filter(e => e.isFile() && !/\.html?$/i.test(e.name));
  // HTML documents belong in Library/ (they are documents, not files) — an .html in Assets/ is skipped and reported
  for (const e of listDir(dir)) if (e.isFile() && /\.html?$/i.test(e.name)) warnings.push('Assets/' + e.name + ' is an HTML document — move it to Library/');
  const sidecars = new Map(files.filter(f => f.name.endsWith('.md')).map(f => [f.name.replace(/\.md$/, ''), f.name]));
  for (const e of files.filter(f => !f.name.endsWith('.md'))) {
    const p = join(dir, e.name); const stem = e.name.replace(/\.[^.]+$/, ''); const st = io.stat(p);
    let data = {}, body = '';
    if (sidecars.has(stem)) ({ data, body } = parseFrontmatter(readMd(join(dir, sidecars.get(stem)))));
    assets.push({ type: 'asset', id: slug(stem), name: data.title || stem, stem, file: rel(p), edited: isoDate(st.mtime), size: st.size,
      ext: (e.name.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase(), projectName: namesFrom(data.project)[0] || '', tags: namesFrom(data.tags), fm: data, body, sidecar: sidecars.has(stem) ? 'Assets/' + sidecars.get(stem) : '' });
  }
  for (const [stem, mdName] of sidecars) { // sidecar without file → still list as note
    if (assets.some(a => a.stem === stem)) continue;
    const p = join(dir, mdName); const { data, body } = parseFrontmatter(readMd(p));
    assets.push({ type: 'asset', id: slug(stem), name: data.title || stem, stem, file: rel(p), edited: fileDate(p), size: io.stat(p).size, ext: 'md', projectName: namesFrom(data.project)[0] || '', tags: namesFrom(data.tags), fm: data, body, sidecar: rel(p) });
  }
}
for (const e of listDir(join(ROOT, 'Log'))) {
  if (!e.isFile() || !/^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)) continue;
  const p = join(ROOT, 'Log', e.name); const { data, body } = parseFrontmatter(readMd(p)); const date = e.name.slice(0, 10);
  // split into entries at "## " headings; text before first heading = day intro
  const parts = body.split(/^(?=## )/m); const intro = parts[0].startsWith('## ') ? '' : parts.shift();
  const entries = parts.map((chunk, idx) => {
    const lines = chunk.split('\n'); const head = lines.shift().replace(/^##\s*/, '').trim();
    const tm = head.match(/^(\d{1,2}:\d{2})\s*[·\-–—:]?\s*(.*)$/); const time = tm ? tm[1].padStart(5, '0') : ''; const title = tm ? tm[2].trim() || head : head;
    const fields = {}; const rest = [];
    for (const l of lines) { const f = l.match(/^([a-zA-Z_][\w-]*)::\s*(.*)$/); if (f) fields[f[1].toLowerCase()] = f[2].trim(); else rest.push(l); }
    const notes = rest.join('\n').trim();
    const hours = fields.hours !== undefined && fields.hours !== '' ? Number(String(fields.hours).replace(',', '.')) : null;
    return { id: `${date}-${idx + 1}`, date, time, title, projectName: namesFrom(fields.project)[0] || '', category: (fields.category || '').toLowerCase(),
      hours: Number.isFinite(hours) ? hours : null, peopleNames: namesFrom(fields.people), docNames: namesFrom(fields.docs), notes, fields, mentions: wikiTargets(chunk) };
  });
  days.push({ type: 'day', id: date, name: date, date, file: rel(p), edited: fileDate(p), summary: data.summary || '', intro: intro.trim(), entries, hours: 0, fm: data });
}
days.sort((a, b) => b.date.localeCompare(a.date));

// ---------- resolve names ----------
const index = new Map(); // lowercased name/stem → {type,id}
const register = (n, t, id) => { if (n) index.set(String(n).toLowerCase(), { type: t, id }); };
for (const x of people) { register(x.name, 'person', x.id); register(x.stem, 'person', x.id); }
for (const x of projects) { register(x.name, 'project', x.id); register(x.stem, 'project', x.id); }
for (const x of docs) { register(x.name, 'doc', x.id); register(x.stem, 'doc', x.id); }
for (const x of assets) { register(x.name, 'asset', x.id); register(x.stem, 'asset', x.id); }
for (const x of days) register(x.date, 'day', x.id);
register('README', 'readme', 'readme');
const resolve = (name) => index.get(String(name).replace(/\.md$/, '').toLowerCase()) || null;
const byId = { person: new Map(people.map(x => [x.id, x])), project: new Map(projects.map(x => [x.id, x])), doc: new Map(docs.map(x => [x.id, x])), asset: new Map(assets.map(x => [x.id, x])), day: new Map(days.map(x => [x.id, x])) };
const ref = (name, wantType) => { const r = resolve(name); return r && (!wantType || r.type === wantType) ? r.id : null; };

// ---------- link everything ----------
const backlinks = new Map(); // "type/id" → [{type,id,label,date}]
const addBack = (target, from) => { if (!target) return; const k = `${target.type}/${target.id}`; if (!backlinks.has(k)) backlinks.set(k, []); const arr = backlinks.get(k); if (!arr.some(b => b.type === from.type && b.id === from.id)) arr.push(from); };

for (const d of days) {
  for (const en of d.entries) {
    en.project = ref(en.projectName, 'project');
    const inbox = /^tasks$/i.test(en.title); // "## Tasks" = tasks added from the hub: no project of its own, each task keeps its own
    en.people = en.peopleNames.map(n => ref(n, 'person')).filter(Boolean);
    en.docs = en.docNames.map(n => ref(n, 'doc')).filter(Boolean);
    // wikilinks in the notes also count as people/project/doc mentions
    for (const m of en.mentions) { const r = resolve(m); if (!r) continue;
      if (r.type === 'person' && !en.people.includes(r.id)) en.people.push(r.id);
      if (r.type === 'project' && !en.project && !inbox) en.project = r.id;
      if (r.type === 'doc' && !en.docs.includes(r.id)) en.docs.push(r.id);
      if (r.type === 'asset') { en.assets = en.assets || []; if (!en.assets.includes(r.id)) en.assets.push(r.id); }
    }
    en.tasks = extractTasks(en.notes).map((t, i) => ({ ...t, id: `${en.id}-t${i + 1}`, date: d.date, entry: en.id, entryTitle: en.title, file: d.file }));
    en.notesHtml = markdown(en.notes, resolve);
    en.text = plain(`${en.title} ${en.notes}`);
    d.hours += en.hours || 0;
    const from = { type: 'day', id: d.id, label: `${d.date} · ${en.title}`, date: d.date, entry: en.id };
    for (const pid of en.people) { byId.person.get(pid).entries.push(en.id); addBack({ type: 'person', id: pid }, from); }
    if (en.project) { const pr = byId.project.get(en.project); pr.entries.push(en.id); pr.hours += en.hours || 0; addBack({ type: 'project', id: en.project }, from); }
    for (const did of en.docs) addBack({ type: 'doc', id: did }, from);
    for (const aid of en.assets || []) addBack({ type: 'asset', id: aid }, from);
    delete en.mentions; delete en.fields;
  }
  d.introHtml = markdown(d.intro, resolve);
  d.projects = [...new Set(d.entries.map(e => e.project).filter(Boolean))];
  d.people = [...new Set(d.entries.flatMap(e => e.people))];
  d.hours = Math.round(d.hours * 100) / 100;
  d.text = plain(d.intro + ' ' + d.entries.map(e => e.text).join(' '));
}
const entryById = new Map(days.flatMap(d => d.entries.map(e => [e.id, e])));
const tasks = [];
const resolveTask = (t, fallbackProject) => {
  t.project = ref(t.projectName, 'project') || null; t.people = [];
  for (const m of t.mentions) { const r = resolve(m); if (!r) continue; if (r.type === 'person' && !t.people.includes(r.id)) t.people.push(r.id); if (r.type === 'project' && !t.project) t.project = r.id; }
  if (!t.project) t.project = fallbackProject || null;
  t.waiting = ref(t.waitingName, 'person'); t.owner = ref(t.ownerName, 'person');
  if (t.waiting && !t.people.includes(t.waiting)) t.people.push(t.waiting);
  if (!PRIORITIES.includes(t.priority)) t.priority = '';
  if (!t.added) t.added = t.date; // until the stamp lands
  if (t.added && t.done) t.days = Math.round((Date.parse(t.done) - Date.parse(t.added)) / 86400000);
  t.textHtml = markdown(t.text, resolve).replace(/^<p>|<\/p>$/g, ''); t.search = plain(t.text);
  delete t.mentions; delete t.projectName; delete t.waitingName; delete t.ownerName; tasks.push(t);
};
for (const d of days) for (const en of d.entries) { for (const t of en.tasks) resolveTask(t, /^tasks$/i.test(en.title) ? null : en.project); en.taskIds = en.tasks.map(t => t.id); delete en.tasks; }

for (const x of people) {
  x.projects = x.projectNames.map(n => ref(n, 'project')).filter(Boolean);
  for (const m of wikiTargets(x.body)) { const r = resolve(m); if (r) addBack(r, { type: 'person', id: x.id, label: x.name }); }
  x.bodyHtml = markdown(x.body, resolve); x.text = plain(x.body);
  x.entries.sort((a, b) => b.localeCompare(a));
  x.lastContact = x.entries.length ? entryById.get(x.entries[0]).date : (x.fm.last_contact ? String(x.fm.last_contact) : '');
  x.days = [...new Set(x.entries.map(id => entryById.get(id).date))];
  // projects from entries too
  for (const id of x.entries) { const pr = entryById.get(id).project; if (pr && !x.projects.includes(pr)) x.projects.push(pr); }
  delete x.body;
}
for (const x of projects) {
  x.people = x.peopleNames.map(n => ref(n, 'person')).filter(Boolean);
  for (const id of x.entries) for (const pid of entryById.get(id).people) if (!x.people.includes(pid)) x.people.push(pid);
  for (const m of wikiTargets(x.body)) { const r = resolve(m); if (r) addBack(r, { type: 'project', id: x.id, label: x.name }); }
  x.parent = ref(x.parentName, 'project'); if (x.parent === x.id) x.parent = null;
  extractTasks(x.body).forEach((t, i) => resolveTask({ ...t, id: `p-${x.id}-t${i + 1}`, date: x.started || x.edited, entry: null, source: x.id, file: x.file }, x.id));
  x.bodyHtml = markdown(x.body, resolve); x.text = plain(x.description + ' ' + x.body);
  x.entries.sort((a, b) => b.localeCompare(a));
  x.lastActivity = x.entries.length ? entryById.get(x.entries[0]).date : x.edited;
  x.hours = Math.round(x.hours * 100) / 100;
  delete x.body;
}
const projectByPrefix = (stem) => { const st = slug(stem); let best = null; for (const pr of projects) { const ps = pr.id; if ((st === ps || st.startsWith(ps + '-')) && (!best || ps.length > best.length)) best = ps; } return best; };
for (const x of docs) {
  x.project = ref(x.projectName, 'project') || (x.projectName ? null : projectByPrefix(x.stem));
  if (x.project) byId.project.get(x.project).docs.push(x.id);
  for (const m of wikiTargets(x.body)) { const r = resolve(m); if (r) addBack(r, { type: 'doc', id: x.id, label: x.name }); }
  x.bodyHtml = markdown(x.body, resolve); x.text = plain(x.body); delete x.body;
}
for (const x of assets) {
  x.project = ref(x.projectName, 'project') || (x.projectName ? null : projectByPrefix(x.stem));
  for (const m of wikiTargets(x.body)) { const r = resolve(m); if (r) addBack(r, { type: 'asset', id: x.id, label: x.name }); }
  x.bodyHtml = markdown(x.body, resolve); x.text = plain(x.body); delete x.body;
}
// project tree + task links
for (const x of projects) if (x.parent) { const par = byId.project.get(x.parent); if (par) par.children.push(x.id); else x.parent = null; }
for (const x of projects) { const kids = (id) => { const p = byId.project.get(id); return p.children.reduce((s, c) => s + kids(c), p.hours); }; x.totalHours = Math.round(kids(x.id) * 100) / 100; }
for (const t of tasks) if (t.project) byId.project.get(t.project).tasks.push(t.id);
// people ↔ projects symmetric
for (const pr of projects) for (const pid of pr.people) { const pe = byId.person.get(pid); if (pe && !pe.projects.includes(pr.id)) pe.projects.push(pr.id); }
for (const pe of people) for (const prid of pe.projects) { const pr = byId.project.get(prid); if (pr && !pr.people.includes(pe.id)) pr.people.push(pe.id); }

// ---------- hours aggregation ----------
const weeks = {};
for (const d of days) for (const en of d.entries) {
  const w = isoWeek(d.date); if (!weeks[w]) weeks[w] = { week: w, monday: weekMonday(d.date), hours: 0, byCategory: {}, byProject: {}, entries: 0, days: new Set() };
  const W = weeks[w]; W.entries++; W.days.add(d.date); const h = en.hours || 0; W.hours += h;
  W.byCategory[en.category || 'uncategorized'] = (W.byCategory[en.category || 'uncategorized'] || 0) + h;
  W.byProject[en.project || '—'] = (W.byProject[en.project || '—'] || 0) + h;
}
const weekList = Object.values(weeks).sort((a, b) => b.week.localeCompare(a.week)).map(w => ({ ...w, days: [...w.days].sort(), hours: Math.round(w.hours * 100) / 100 }));


// ---------- publish status: is there a copy of the document in the Publish folder, and is it the current version? ----------
const TEXT_EXT = /\.(md|html?|txt|csv|json|svg|xml)$/i;
// true / false, or null when the copy cannot be read (macOS denies the app access to OneDrive files until allowed under
// System Settings → Privacy & Security → Files and Folders) — never report "outdated" on a failed read.
const sameFile = (a, b) => { try { const sa = io.stat(a), sb = io.stat(b); if (sa.size !== sb.size) return false; return TEXT_EXT.test(a) ? io.read(a) === io.read(b) : true; } catch (e) { return null; } };
let pubNames = null; // listing of the Publish folder, null when missing or not readable
if (PUBLISH_DIR && io.exists(PUBLISH_DIR)) { try { const l = io.list(PUBLISH_DIR); pubNames = l ? new Set(l.map(e => e.name)) : null; } catch (e) { pubNames = null; } }
// fallback: what publish.js recorded about the copies the last time it ran (size, hash, date) — used when the folder cannot be read
const pubRecord = (() => { try { const r = JSON.parse(io.read(join(ROOT, 'app', 'publish-state.json'))); return r && r.files ? r.files : null; } catch (e) { return null; } })();
const pubSource = pubNames ? 'folder' : pubRecord ? 'record' : 'none';
const pubAvailable = pubSource !== 'none';
const fromRecord = (d, abs) => { // compare the vault file with the recorded copy
  const r = pubRecord && pubRecord[d.pubFile]; if (!r) return { state: 'none' };
  try { const st = io.stat(abs); let same = st.size === r.size; if (same && r.hash && TEXT_EXT.test(abs)) same = hashText(io.read(abs)) === r.hash;
    return { state: same ? 'current' : 'outdated', date: r.published || '', via: 'record' }; } catch (e) { return { state: 'unavailable' }; }
};
for (const d of docs) {
  const src = d.open || d.file; d.pubFile = src.split('/').pop(); const copy = join(PUBLISH_DIR, d.pubFile); const abs = join(ROOT, src);
  if (pubSource === 'folder') {
    if (!pubNames.has(d.pubFile)) d.pub = { state: 'none' };                              // never published
    else { const same = sameFile(abs, copy); let date = ''; try { date = fileDate(copy); } catch (e) {}
      d.pub = same === null ? (pubRecord ? fromRecord(d, abs) : { state: 'unavailable', date }) : { state: same ? 'current' : 'outdated', date }; }
  } else if (pubSource === 'record') d.pub = fromRecord(d, abs);
  else d.pub = { state: 'unavailable' };                                                  // no folder, no record → unknown
}
const shareLinks = (() => { try { return JSON.parse(io.read(join(ROOT, 'app', 'share-links.json'))) || {}; } catch (e) { return {}; } })(); // saved OneDrive sharing links (publish.js --link) open a preview; folder links download
for (const d of docs) if (d.pub.state === 'current' || d.pub.state === 'outdated') { if (shareLinks[d.pubFile]) { d.pub.link = shareLinks[d.pubFile]; d.pub.shared = true; } else if (SHARE_BASE) d.pub.link = SHARE_BASE + '/' + encodeURIComponent(d.pubFile); }
const pubCounts = { current: docs.filter(d => d.pub.state === 'current').length, outdated: docs.filter(d => d.pub.state === 'outdated').length };

// ---------- output ----------
const sortByName = (a, b) => a.name.localeCompare(b.name);
const data = {
  generated: new Date().toISOString(), today: todayStr(), vault: VAULT_NAME, categories: CATEGORIES, libraryCategories: LIBRARY_CATEGORIES,
  priorities: PRIORITIES, tasks: tasks.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || b.date.localeCompare(a.date)),
  days, people: people.sort(sortByName), projects: projects.sort(sortByName), docs: docs.sort((a, b) => b.edited.localeCompare(a.edited) || a.name.localeCompare(b.name)), assets: assets.sort((a, b) => b.edited.localeCompare(a.edited)),
  weeks: weekList, backlinks: Object.fromEntries(backlinks),
  publish: { dir: PUBLISH_DIR, shareBase: SHARE_BASE, available: pubAvailable, source: pubSource, current: pubCounts.current, outdated: pubCounts.outdated },
  readme: io.exists(join(ROOT, 'README.md')) ? markdown(parseFrontmatter(readMd(join(ROOT, 'README.md'))).body, resolve) : '',
  totals: { hours: Math.round(days.reduce((s, d) => s + d.hours, 0) * 100) / 100, entries: days.reduce((s, d) => s + d.entries.length, 0) },
};
const json = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
const template = io.read(TEMPLATE);
if (!template.includes('/*__DATA__*/')) throw new Error('template.html is missing the /*__DATA__*/ marker');
io.write(OUT, template.replace('/*__DATA__*/', () => 'window.YCOS=' + json + ';'));
return (warnings.length ? warnings.map(w => '⚠ ' + w).join('\n') + '\n' : '') + 'Nostrion-os hub built → app/index.html  (' + days.length + ' days, ' + data.totals.entries + ' entries, ' + data.totals.hours + 'h, ' + people.length + ' people, ' + projects.length + ' projects, ' + docs.length + ' docs, ' + assets.length + ' assets, ' + pubCounts.current + ' published' + (pubCounts.outdated ? ', ' + pubCounts.outdated + ' outdated' : '') + (pubSource === 'folder' ? '' : pubSource === 'record' ? ', publish state from last publish run' : ', publish folder unavailable/no access') + ')';
}

// ---------- environments ----------
function nodeIO() {
  const fs = require('fs');
  return {
    exists: (p) => fs.existsSync(p),
    home: () => require('os').homedir(),
    read: (p) => fs.readFileSync(p, 'utf8'),
    write: (p, s) => fs.writeFileSync(p, s),
    stat: (p) => { const s = fs.statSync(p); return { mtime: s.mtime, size: s.size }; },
    list: (dir) => fs.readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isFile: () => e.isFile() })),
  };
}
function jxaIO() { // macOS: osascript -l JavaScript (JavaScript for Automation), Foundation via the ObjC bridge
  ObjC.import('Foundation');
  const fm = $.NSFileManager.defaultManager;
  return {
    exists: (p) => fm.fileExistsAtPath(p),
    home: () => ObjC.unwrap($.NSHomeDirectory()),
    read: (p) => { const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null); if (s.isNil()) throw new Error('cannot read ' + p); return ObjC.unwrap(s); },
    write: (p, s) => { const ok = $(s).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null); if (!ok) throw new Error('cannot write ' + p); },
    stat: (p) => { const a = fm.attributesOfItemAtPathError(p, null); return { mtime: new Date(a.fileModificationDate.timeIntervalSince1970 * 1000), size: Number(a.fileSize) }; },
    list: (dir) => ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(dir, null)).map(name => { const isDir = Ref(); fm.fileExistsAtPathIsDirectory(dir + '/' + name, isDir); return { name, isFile: () => !isDir[0] }; }),
  };
}

if (typeof require === 'function' && typeof module !== 'undefined') {           // Node
  module.exports = { buildVault, nodeIO, hashText, editTask, stampTasks };
  const path = require('path');
  if (require.main === module || /build\.m?js$/.test(String(process.argv[1] || ''))) { // run directly (node app/build.js [vault]) — not when required by publish.js
    console.log(buildVault(nodeIO(), path.resolve(process.argv[2] || path.join(__dirname, '..'))));
  }
}
function run(argv) { // entry point when executed with osascript -l JavaScript (argv[0] = vault path, default ~/Desktop/Nostrion-os)
  const root = String(argv && argv[0] || '').replace(/\/+$/, '') || ObjC.unwrap($.NSHomeDirectory()) + '/Desktop/Nostrion-os';
  return buildVault(jxaIO(), root);
}
