// Hub builder — runs in Node (`node app/build.js`) AND in macOS's built-in JavaScript
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

// ---------- note actions (status / delete) — called from the app like editTask ----------
const NOTE_FILE = /^(Projects|Library|People)\/[^/]+\.md$/; // only markdown notes in these folders; HTML documents keep their meta tags
// req: {file (vault-relative), status, category?} → sets the status where that kind of file keeps it:
//   a note (.md in Projects/, Library/, People/): `status:` in the frontmatter (added when missing)
//   an HTML document in Library/ (or the main page of a folder document): <meta name="os:status"> (an older hub:status or ycos:status tag is replaced)
//   any other Library file (pdf, Office…): a note next to it with the same name, created when missing, holds the status
const LIB_HTML = /^Library\/(?!\.)[^/]+(?:\/(?!\.)[^/]+)?\.html?$/i, LIB_FILE = /^Library\/(?!\.)[^/]+\.(?!md$)[A-Za-z0-9]+$/;
function editStatus(io, ROOT, req) {
  let file = String(req && req.file || '');
  const status = String(req.status || '').trim().toLowerCase(); if (!/^[a-z][a-z0-9 -]*$/.test(status)) return { ok: false, error: 'not a valid status: ' + req.status };
  if (LIB_HTML.test(file)) {
    const p = ROOT + '/' + file; if (!io.exists(p)) return { ok: false, error: file + ' no longer exists' };
    let src = io.read(p); const tag = '<meta name="os:status" content="' + status + '">';
    const re = /<meta\s+[^>]*name=["'](?:os|hub|ycos):status["'][^>]*>/i;
    if (re.test(src)) src = src.replace(re, tag);
    else if (/<meta\s+charset[^>]*>/i.test(src)) src = src.replace(/(<meta\s+charset[^>]*>)/i, '$1\n' + tag);
    else if (/<head[^>]*>/i.test(src)) src = src.replace(/(<head[^>]*>)/i, '$1\n' + tag);
    else src = tag + '\n' + src;
    io.write(p, src);
    return { ok: true, file, status };
  }
  if (LIB_FILE.test(file)) { // a pdf or similar: its status goes into a note of the same name
    const note = file.replace(/\.[^.]+$/, '.md'); const p = ROOT + '/' + note;
    if (!io.exists(ROOT + '/' + file)) return { ok: false, error: file + ' no longer exists' };
    if (!io.exists(p)) { const cat = String(req.category || '').trim().toLowerCase(); io.write(p, '---\nstatus: ' + status + (/^[a-z][a-z0-9 -]*$/.test(cat) ? '\ncategory: ' + cat : '') + '\n---\n'); return { ok: true, file: note, status, created: true }; }
    file = note;
  }
  if (!NOTE_FILE.test(file)) return { ok: false, error: 'status can only be set on notes in Projects/, Library/ and People/, and on Library documents' };
  const p = ROOT + '/' + file; if (!io.exists(p)) return { ok: false, error: file + ' no longer exists' };
  let src = io.read(p); const cr = src.includes('\r\n'); if (cr) src = src.replace(/\r\n/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (m) { const fm = m[1].split('\n'); const i = fm.findIndex(l => /^status\s*:/.test(l)); if (i >= 0) fm[i] = 'status: ' + status; else fm.push('status: ' + status); src = '---\n' + fm.join('\n') + '\n---' + src.slice(m[0].length - m[2].length); }
  else src = '---\nstatus: ' + status + '\n---\n' + src;
  io.write(p, cr ? src.replace(/\n/g, '\r\n') : src);
  return { ok: true, file, status };
}
// req: {file} → moves the note to <vault>/.trash/ (Obsidian's own trash: recoverable from Finder or Obsidian, and git keeps the history)
function trashNote(io, ROOT, req) {
  const file = String(req && req.file || ''); if (!NOTE_FILE.test(file)) return { ok: false, error: 'only notes in Projects/, Library/ and People/ can be deleted from the hub' };
  const p = ROOT + '/' + file; if (!io.exists(p)) return { ok: false, error: file + ' no longer exists' };
  const dir = ROOT + '/.trash'; io.mkdir(dir);
  const name = file.slice(file.lastIndexOf('/') + 1); let dest = dir + '/' + name;
  if (io.exists(dest)) dest = dir + '/' + name.replace(/\.md$/, '') + ' ' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.md';
  io.move(p, dest);
  return { ok: true, file, trashed: '.trash/' + dest.slice(dir.length + 1) };
}

// ---------- note editing in the app: read the whole file, write it back when nobody else changed it meanwhile ----------
const EDIT_FILE = /^(?:(?:Log|People|Projects|Library)\/[^/]+|Assets(?:\/(?!\.)[^/]+)+|README)\.md$/; // markdown notes only (Assets/ with subfolders); no segment starts with a dot, so no paths outside the vault
function readNote(io, ROOT, req) { // req: {file} → {ok, file, text}
  const file = String(req && req.file || ''); if (!EDIT_FILE.test(file)) return { ok: false, file, error: 'only markdown notes in Log/, People/, Projects/, Library/ and Assets/ can be edited in the app' };
  const p = ROOT + '/' + file; if (!io.exists(p)) return { ok: false, file, error: file + ' no longer exists' };
  return { ok: true, file, text: io.read(p) };
}
// req: {file, text, base (the text as it was opened), force} → refuses when the file changed since it was opened (Obsidian, a sync, a task stamp), unless force
function saveNote(io, ROOT, req) {
  const file = String(req && req.file || ''); if (!EDIT_FILE.test(file)) return { ok: false, file, error: 'only markdown notes in Log/, People/, Projects/, Library/ and Assets/ can be edited in the app' };
  const p = ROOT + '/' + file; const now = io.exists(p) ? io.read(p) : null;
  if (now === null) return { ok: false, file, error: file + ' no longer exists' };
  if (!req.force && now !== String(req.base)) return { ok: false, file, conflict: true, error: 'The file changed since you opened it (Obsidian, a sync or a task update).' };
  io.write(p, String(req.text));
  return { ok: true, file };
}

// req: the Settings page's fields → merged into app/config.json (keys the page does not know, and the _comment lines, stay)
function saveConfig(io, ROOT, req) {
  const p = ROOT + '/app/config.json'; let c = {}; try { c = JSON.parse(io.read(p)); } catch (e) {}
  const str = (v) => String(v == null ? '' : v).trim(); const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map(x => String(x).trim()).filter(Boolean);
  if ('name' in req || 'role' in req) c.profile = Object.assign({}, c.profile, 'name' in req ? { name: str(req.name) } : {}, 'role' in req ? { role: str(req.role) } : {});
  if ('obsidianVault' in req || 'editIn' in req) c.obsidian = Object.assign({}, c.obsidian, 'obsidianVault' in req ? { vault: str(req.obsidianVault) } : {}, 'editIn' in req ? { editIn: req.editIn === 'obsidian' ? 'obsidian' : 'app' } : {});
  if ('publishDir' in req) c.publishDir = str(req.publishDir);
  if ('shareBase' in req) c.shareBase = str(req.shareBase);
  if ('repoRoots' in req || 'repoExclude' in req || 'repoPersonal' in req) { c.repos = Object.assign({}, c.repos); if ('repoRoots' in req) c.repos.roots = list(req.repoRoots); if ('repoExclude' in req) c.repos.exclude = list(req.repoExclude); }
  io.write(p, JSON.stringify(c, null, 2) + '\n');
  return { ok: true };
}

function buildVault(io, ROOT) {
io.pending = stampTasks(io, ROOT); // added:: / done:: on task lines (io.pending → main.js builds again once the file is quiet)
const join = function () { return Array.prototype.slice.call(arguments).join('/'); };
const CONFIG0 = (() => { try { return JSON.parse(io.read(join(ROOT, 'app', 'config.json'))); } catch (e) { return {}; } })();
const VAULT_NAME = String((CONFIG0.obsidian || {}).vault || '') || ROOT.split('/').filter(Boolean).pop(); // the vault's name in Obsidian (obsidian:// links)
const OUT = join(ROOT, 'app', 'index.html');
const TEMPLATE = join(ROOT, 'app', 'template.html');
const CATEGORIES = ['meeting', 'build', 'research', 'writing', 'admin', 'learning'];
const PRIORITIES = ['do', 'plan', 'delegate', 'later']; // Eisenhower: urgent+important · important · urgent · neither
const LIBRARY_CATEGORIES = ['research', 'framework', 'brief', 'report', 'tool', 'reference', 'post', 'note']; // display order only: any other value in os:category works and is listed after these
const CONFIG = CONFIG0; // app/config.json (Settings in the app writes it, saveConfig)
const PUBLISH_DIR = String(CONFIG.publishDir || '').replace(/^~(?=\/|$)/, io.home()); // copies of shared Library docs live here (OneDrive)
const SHARE_BASE = String(CONFIG.shareBase || '').replace(/\/+$/, ''); // web address of that folder → per-file links in the hub

// ---------- helpers ----------
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Library/ and Assets/ names start with the day the file was made: 2026-10-08_website-relaunch-brief.html (see app/datename.js).
// undate() splits that off: base is the name without the date, used for titles, project matching and as a link alias.
// Documents (pdf, Word, PowerPoint, Excel, Keynote, Pages, Numbers…) belong in Library/; Assets/ holds brand files (Assets/Brand Asset/)
// and attachments, images used in notes (Assets/Attachment/, where Obsidian puts pasted images).
const DOC_EXT = /\.(pdf|docx?|pptx?|xlsx?|key|pages|numbers|odt|ods|odp|rtf)$/i;
const undate = (s) => { const m = String(s).match(/^(\d{4}-\d{2}-\d{2})_(.+)$/); return m ? { date: m[1], base: m[2] } : { date: '', base: String(s) }; };
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
    const target = t.trim(); const label = (alias || undate(target).base).trim(); // a dated file name reads without its date
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
function htmlMeta(src) { // <meta name="os:project" content="Acme pilot"> … inside an .html document
  // os: is the prefix; ycos: and hub: are older ones, still read for published copies and older files. os: wins, then hub:, then ycos:
  const RANK = { os: 3, hub: 2, ycos: 1 }, out = {}, rank = {}; const re = /<meta\s+[^>]*name=["'](os|hub|ycos):([\w-]+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi; let m;
  while ((m = re.exec(src))) { const k = m[2].toLowerCase(), r = RANK[m[1].toLowerCase()]; if ((rank[k] || 0) > r) continue; out[k] = m[3].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim(); rank[k] = r; }
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
    if (li) { // nested lists: indentation (a tab, as Obsidian writes it, or spaces) sets the level
      flush(); const items = []; const width = (s) => s.replace(/\t/g, '    ').length;
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) { if (/^(\t|\s{2,})\S/.test(lines[i]) && items.length) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; continue; } break; }
        items.push({ ind: width(m[1]), ordered: /\d/.test(m[2]), text: m[3] }); i++;
      }
      const render = (t, kids) => { const task = t.match(/^\[([ xX\/\-])\]\s+(.*)$/); if (!task) return `<li>${inline(t, resolve)}${kids}</li>`;
        const st = task[1].toLowerCase(); const f = taskFields(task[2]);
        const meta = [f.priority, f.due ? 'due ' + f.due : '', f.waiting ? 'waiting on ' + f.waiting.replace(/\[\[|\]\]/g, '') : '', /^\d{4}/.test(f.done || '') && st !== ' ' ? 'done ' + f.done : ''].filter(Boolean).join(' · ');
        return `<li class="task ${st === 'x' ? 'done' : st === '-' ? 'cancelled' : st === '/' ? 'doing' : ''}"><span class="trow"><span class="box">${st === 'x' ? '✓' : st === '/' ? '◐' : st === '-' ? '×' : ''}</span><span>${inline(f.text, resolve)}${meta ? ` <span class="tmeta">${esc(meta)}</span>` : ''}</span></span>${kids}</li>`; };
      let pos = 0;
      const list = (ind) => { // items at this indent are siblings; a deeper item opens a list inside the one before it
        const ordered = items[pos].ordered; const tag = ordered ? 'ol' : 'ul'; let html = '';
        while (pos < items.length && (items[pos].ind > ind || (items[pos].ind === ind && items[pos].ordered === ordered))) { const it = items[pos++]; html += render(it.text, pos < items.length && items[pos].ind > it.ind ? list(items[pos].ind) : ''); }
        return `<${tag}>${html}</${tag}>`;
      };
      while (pos < items.length) out.push(list(items[pos].ind));
      continue;
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
    location: data.location || '', email: data.email || '', phone: data.phone || '', linkedin: data.linkedin || '', status: data.status || '', tags: namesFrom(data.tags), projectNames: namesFrom(data.projects), fm: data, body, entries: [] });
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
  const fileOf = new Map(files.filter(f => !f.name.endsWith('.md')).map(f => [f.name.replace(/\.[^.]+$/, ''), f.name])); // a .md next to a pdf/html of the same name describes that file
  for (const e of files.filter(f => f.name.endsWith('.md'))) {
    const p = join(dir, e.name); const { data, body } = parseFrontmatter(readMd(p)); const stem = e.name.replace(/\.md$/, '');
    mdStems.add(stem);
    const u = undate(stem);
    const ext = /^~?\//.test(String(data.file || '')); // file: an absolute path → the document lives outside the vault (e.g. a shared OneDrive folder)
    docs.push({ type: 'doc', id: slug(stem), name: data.title || u.base, stem, base: u.base, dated: u.date, file: rel(p), edited: fileDate(p), external: ext,
      category: data.category || 'note', status: data.status || 'draft', added: data.added ? String(data.added) : u.date || fileDate(p),
      projectName: namesFrom(data.project)[0] || '', tags: namesFrom(data.tags), open: data.file ? (ext ? String(data.file).replace(/^~(?=\/)/, io.home()) : 'Library/' + String(data.file).replace(/^Library\//, '')) : fileOf.has(stem) ? 'Library/' + fileOf.get(stem) : '', fm: data, body });
  }
  for (const e of files.filter(f => !f.name.endsWith('.md'))) {
    const stem = e.name.replace(/\.[^.]+$/, ''); if (mdStems.has(stem)) continue; // has sidecar → already listed
    const p = join(dir, e.name); const u = undate(stem); let title = u.base; let meta = {};
    if (/\.html?$/i.test(e.name)) { const src = io.read(p); const m = src.match(/<title>([^<]*)<\/title>/i); if (m) title = m[1].trim(); meta = htmlMeta(src); }
    docs.push({ type: 'doc', id: slug(stem), name: meta.title || title, stem, base: u.base, dated: u.date, file: rel(p), edited: fileDate(p), category: meta.category || (/\.html?$/i.test(e.name) ? 'tool' : DOC_EXT.test(e.name) ? 'document' : 'reference'), status: meta.status || 'live', added: meta.added || u.date || fileDate(p), projectName: meta.project || '', tags: namesFrom(meta.tags), open: rel(p), fm: meta, body: '', description: meta.description || '' });
  }
  // a folder in Library is one document (a bundle): <name>/<name>.html, or index.html, plus the files it needs (data, assets).
  // It is published as a folder, so one share link covers everything in it.
  for (const e of listDir(dir).filter(f => !f.isFile())) {
    const bdir = join(dir, e.name); const inside = listDir(bdir).filter(f => f.isFile()).map(f => f.name).sort();
    const ub = undate(e.name);
    const main = inside.includes(e.name + '.html') ? e.name + '.html' : inside.includes(ub.base + '.html') ? ub.base + '.html' : inside.includes('index.html') ? 'index.html' : inside.find(n => /\.html?$/i.test(n));
    if (!main) { warnings.push('Library/' + e.name + '/ holds no HTML document — skipped'); continue; }
    const p = join(bdir, main); const src = io.read(p); let title = ub.base; const m = src.match(/<title>([^<]*)<\/title>/i); if (m) title = m[1].trim(); const meta = htmlMeta(src);
    let edited = fileDate(p); for (const n of inside) { const d2 = fileDate(join(bdir, n)); if (d2 > edited) edited = d2; }
    docs.push({ type: 'doc', id: slug(e.name), name: meta.title || title, stem: e.name, base: ub.base, dated: ub.date, file: rel(p), edited, category: meta.category || 'tool', status: meta.status || 'live', added: meta.added || ub.date || fileDate(p), projectName: meta.project || '', tags: namesFrom(meta.tags), open: rel(p), fm: meta, body: '', description: meta.description || '', bundle: e.name, bundleFiles: inside });
  }
}
// Assets/ may have subfolders (any depth): each file keeps its folder (asset.folder, '' at the top), the hub groups and filters by it.
const assetDirs = (function walk(rel, out) { out.push(rel); for (const e of listDir(join(ROOT, rel))) if (!e.isFile()) walk(rel + '/' + e.name, out); return out; })('Assets', []);
for (const relDir of assetDirs) {
  const dir = join(ROOT, relDir); const folder = relDir.slice('Assets'.length + 1); const files = listDir(dir).filter(e => e.isFile() && !/\.html?$/i.test(e.name));
  // HTML documents belong in Library/ (they are documents, not files) — an .html in Assets/ is skipped and reported
  for (const e of listDir(dir)) if (e.isFile() && /\.html?$/i.test(e.name)) warnings.push(relDir + '/' + e.name + ' is an HTML document — move it to Library/');
  for (const e of files) if (DOC_EXT.test(e.name)) warnings.push(relDir + '/' + e.name + ' is a document — move it to Library/ (Assets/ is for brand files and attachments)');
  const sidecars = new Map(files.filter(f => f.name.endsWith('.md')).map(f => [f.name.replace(/\.md$/, ''), f.name]));
  const idOf = (stem) => { const id = slug(stem); return assets.some(a => a.id === id) ? slug(folder + '-' + stem) : id; }; // same name in two folders → the folder makes the id unique
  for (const e of files.filter(f => !f.name.endsWith('.md'))) {
    const p = join(dir, e.name); const stem = e.name.replace(/\.[^.]+$/, ''); const st = io.stat(p);
    let data = {}, body = '';
    if (sidecars.has(stem)) ({ data, body } = parseFrontmatter(readMd(join(dir, sidecars.get(stem)))));
    const u = undate(stem);
    assets.push({ type: 'asset', id: idOf(stem), name: data.title || u.base, stem, base: u.base, dated: u.date, added: data.added ? String(data.added) : u.date || isoDate(st.mtime), file: rel(p), folder, edited: isoDate(st.mtime), size: st.size,
      ext: (e.name.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase(), projectName: namesFrom(data.project)[0] || '', tags: namesFrom(data.tags), fm: data, body, sidecar: sidecars.has(stem) ? relDir + '/' + sidecars.get(stem) : '' });
  }
  for (const [stem, mdName] of sidecars) { // sidecar without file → still list as note
    if (assets.some(a => a.stem === stem && a.folder === folder)) continue;
    const p = join(dir, mdName); const { data, body } = parseFrontmatter(readMd(p));
    const u = undate(stem);
    assets.push({ type: 'asset', id: idOf(stem), name: data.title || u.base, stem, base: u.base, dated: u.date, added: data.added ? String(data.added) : u.date || fileDate(p), file: rel(p), folder, edited: fileDate(p), size: io.stat(p).size, ext: 'md', projectName: namesFrom(data.project)[0] || '', tags: namesFrom(data.tags), fm: data, body, sidecar: rel(p) });
  }
}
{ const n = docs.filter(x => !x.dated).length + assets.filter(x => !x.dated).length; if (n) warnings.push(n + ' file' + (n === 1 ? '' : 's') + ' in Library/ or Assets/ without a date in the name — run: node app/datename.js'); }
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
// the name without its date still resolves (an older [[website-relaunch-brief]] link), unless something else already has that name
for (const x of [...docs, ...assets]) if (x.dated && !index.has(x.base.toLowerCase())) register(x.base, x.type, x.id);
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
  x.project = ref(x.projectName, 'project') || (x.projectName ? null : projectByPrefix(x.base));
  if (x.project) byId.project.get(x.project).docs.push(x.id);
  for (const m of wikiTargets(x.body)) { const r = resolve(m); if (r) addBack(r, { type: 'doc', id: x.id, label: x.name }); }
  x.bodyHtml = markdown(x.body, resolve); x.text = plain(x.body); delete x.body;
}
for (const x of assets) {
  x.project = ref(x.projectName, 'project') || (x.projectName ? null : projectByPrefix(x.base));
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
// a bundle (Library/<name>/) is current when the published folder holds exactly its files, each identical
const sameBundle = (abs, copy, files) => { try { const have = listDir(copy).filter(e => e.isFile()).map(e => e.name); if (have.length !== files.length) return false; for (const n of files) { if (!have.includes(n)) return false; const s = sameFile(join(abs, n), join(copy, n)); if (s !== true) return s; } return true; } catch (e) { return null; } };
const bundleSig = (abs, files) => { let size = 0; const parts = []; for (const n of files) { const p = join(abs, n); const st = io.stat(p); size += st.size; parts.push(n + ':' + st.size + ':' + (TEXT_EXT.test(n) ? hashText(io.read(p)) : '')); } return { size, hash: hashText(parts.join('|')) }; };
let pubNames = null; // listing of the Publish folder, null when missing or not readable
if (PUBLISH_DIR && io.exists(PUBLISH_DIR)) { try { const l = io.list(PUBLISH_DIR); pubNames = l ? new Set(l.map(e => e.name)) : null; } catch (e) { pubNames = null; } }
// fallback: what publish.js recorded about the copies the last time it ran (size, hash, date) — used when the folder cannot be read
const pubRecord = (() => { try { const r = JSON.parse(io.read(join(ROOT, 'app', 'publish-state.json'))); return r && r.files ? r.files : null; } catch (e) { return null; } })();
const pubSource = pubNames ? 'folder' : pubRecord ? 'record' : 'none';
const pubAvailable = pubSource !== 'none';
const fromRecord = (d, abs) => { // compare the vault file with the recorded copy
  const r = pubRecord && pubRecord[d.pubFile]; if (!r) return { state: 'none' };
  try { let same;
    if (d.bundle) { const sig = bundleSig(abs, d.bundleFiles); same = sig.size === r.size && (!r.hash || sig.hash === r.hash); }
    else { const st = io.stat(abs); same = st.size === r.size; if (same && r.hash && TEXT_EXT.test(abs)) same = hashText(io.read(abs)) === r.hash; }
    return { state: same ? 'current' : 'outdated', date: r.published || '', via: 'record' }; } catch (e) { return { state: 'unavailable' }; }
};
// a copy keeps the name it was first published under (links already shared keep working), so look it up by its vault source:
// the name publish.js recorded for this source, else the file name, else the file name without its date
const recBySource = new Map(Object.entries(pubRecord || {}).map(([k, r]) => [r.source, k]));
for (const d of docs) {
  if (d.external) { // outside the vault: a file in the Publish folder is the shared copy itself, nothing to compare
    const inPub = PUBLISH_DIR && d.open.startsWith(PUBLISH_DIR + '/'); let date = ''; try { date = fileDate(d.open); } catch (e) {}
    d.pubFile = inPub ? d.open.slice(PUBLISH_DIR.length + 1).split('/')[0] : ''; d.pub = inPub ? { state: 'current', date, via: 'external' } : { state: 'none' };
    continue;
  }
  const src = d.open || d.file; const own = d.bundle || src.split('/').pop();
  const cands = [recBySource.get(d.bundle ? 'Library/' + d.bundle : src), own, undate(own).base].filter(Boolean);
  d.pubFile = (pubNames && cands.find(n => pubNames.has(n))) || cands[0]; const copy = join(PUBLISH_DIR, d.pubFile); const abs = d.bundle ? join(ROOT, 'Library', d.bundle) : join(ROOT, src);
  if (pubSource === 'folder') {
    if (!pubNames.has(d.pubFile)) d.pub = { state: 'none' };                              // never published
    else { const same = d.bundle ? sameBundle(abs, copy, d.bundleFiles) : sameFile(abs, copy); let date = ''; try { date = fileDate(copy); } catch (e) {}
      d.pub = same === null ? (pubRecord ? fromRecord(d, abs) : { state: 'unavailable', date }) : { state: same ? 'current' : 'outdated', date }; }
  } else if (pubSource === 'record') d.pub = fromRecord(d, abs);
  else d.pub = { state: 'unavailable' };                                                  // no folder, no record → unknown
}
const shareLinks = (() => { try { return JSON.parse(io.read(join(ROOT, 'app', 'share-links.json'))) || {}; } catch (e) { return {}; } })(); // saved OneDrive sharing links (publish.js --link) open a preview; folder links download
for (const d of docs) if (d.pub.state === 'current' || d.pub.state === 'outdated') { if (shareLinks[d.pubFile]) { d.pub.link = shareLinks[d.pubFile]; d.pub.shared = true; } else if (SHARE_BASE) d.pub.link = SHARE_BASE + '/' + encodeURIComponent(d.pubFile); }
const pubCounts = { current: docs.filter(d => d.pub.state === 'current').length, outdated: docs.filter(d => d.pub.state === 'outdated').length };

// ---------- git repos next to the vault (~/<name>/.git), read from the .git folder itself: no git or shell needed ----------
// app/config.json → repos: { roots: ["~"], exclude: ["<folder>"], about: { "<folder>": "one-line description" } }
// A repo belongs to the project whose note says  repo: <folder name or URL>  (a list for several), else the project with the same name.
const REPOS = CONFIG.repos || {};
const repos = [];
{
  const roots = (REPOS.roots || ['~']).map(r => String(r).replace(/^~(?=\/|$)/, io.home()).replace(/\/+$/, ''));
  const exclude = new Set((REPOS.exclude || []).map(String)); const about = REPOS.about || {};
  // the standard macOS folders are never repos; looking inside them would make the app ask for Desktop / Documents access
  const MAC_DIRS = new Set(['Applications', 'Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public', 'OneDrive', 'Dropbox', 'Google Drive', 'iCloud Drive']);
  const tryRead = (p) => { try { return io.exists(p) ? io.read(p).replace(/\r\n/g, '\n') : ''; } catch (e) { return ''; } };
  // "git@codeberg.org:me/x.git", "ssh://git@host/me/x.git", "https://github.com/me/x.git" → https://host/me/x
  const webUrl = (u) => { u = String(u || '').trim(); let m = u.match(/^(?:ssh:\/\/)?[\w.-]+@([^:\/]+)[:\/](.+?)(?:\.git)?\/?$/) || u.match(/^https?:\/\/(?:[^@\/]+@)?([^\/]+)\/(.+?)(?:\.git)?\/?$/); return m ? { host: m[1].replace(/:\d+$/, ''), path: m[2], url: 'https://' + m[1].replace(/:\d+$/, '') + '/' + m[2] } : null; };
  const HOSTS = { 'github.com': 'GitHub', 'codeberg.org': 'Codeberg', 'gitlab.com': 'GitLab', 'bitbucket.org': 'Bitbucket' };
  // first prose paragraph of a markdown file: skips frontmatter, headings, badges, html, quotes and tables; cut at a sentence near 260 chars
  const firstPara = (md) => { const body = parseFrontmatter(md).body.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, ''); const para = [];
    for (const raw of body.split('\n')) { if (/^\s*<h[1-6]\b/i.test(raw)) { if (para.length) break; continue; } const l = raw.replace(/<[^>]+>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
      if (!l) { if (para.length) break; continue; } if (/^(#|>|\||[-*_=]{3,}$|\[!)/.test(l) || /^\[[^\]]*\]\([^)]*\)$/.test(l)) { if (para.length) break; continue; } para.push(l); }
    let s = para.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    if (s.length > 260) { const cut = s.slice(0, 260).search(/[.!?](?=\s)[^.!?]*$/); s = cut > 80 ? s.slice(0, cut + 1) : s.slice(0, 257).replace(/\s+\S*$/, '') + '…'; }
    return s; };
  // reflog → date of the last change (commit, pull, merge, …) and the subject of the last commit made here (pulls carry none)
  const lastLog = (log) => { let date = '', msg = ''; for (const l of log.trim().split('\n').reverse()) { const m = l.match(/^\S+ \S+ .*?> (\d+) [+-]\d{4}\t(.*)$/); if (!m || /^checkout:/.test(m[2])) continue;
    if (!date) date = isoDate(new Date(Number(m[1]) * 1000)); const c = m[2].match(/^commit(?: \((?:merge|amend|initial)\))?:\s*(.*)$/); if (c) { msg = c[1]; break; } }
    return date ? { date, msg } : null; };
  for (const root of roots) for (const e of listDir(root)) {
    if (e.isFile() || exclude.has(e.name) || (root === io.home() && MAC_DIRS.has(e.name))) continue;
    const dir = join(root, e.name), git = join(dir, '.git'); if (!io.exists(join(git, 'HEAD'))) continue; // .git as a folder only (worktrees and submodules have a .git file)
    const cfg = tryRead(join(git, 'config')); const remotes = {}; let cur = null;
    for (const l of cfg.split('\n')) { const s = l.match(/^\s*\[remote\s+"([^"]+)"\]/); if (s) { cur = s[1]; continue; } if (/^\s*\[/.test(l)) { cur = null; continue; } const u = l.match(/^\s*url\s*=\s*(.+)$/); if (cur && u) remotes[cur] = u[1].trim(); }
    const remote = remotes.origin || Object.values(remotes)[0] || ''; const w = webUrl(remote);
    const head = tryRead(join(git, 'HEAD')).trim(); const branch = (head.match(/^ref: refs\/heads\/(.+)$/) || [])[1] || head.slice(0, 7);
    const last = lastLog(tryRead(join(git, 'logs', 'refs', 'heads', branch))) || lastLog(tryRead(join(git, 'logs', 'HEAD')));
    const has = (n) => io.exists(join(dir, n)); let pkg = {}; try { pkg = has('package.json') ? JSON.parse(io.read(join(dir, 'package.json'))) : {}; } catch (er) {}
    const readmeName = ['README.md', 'readme.md', 'Readme.md', 'README'].find(has) || ''; const readme = readmeName ? tryRead(join(dir, readmeName)) : '';
    const descFrom = [['config', about[e.name]], [readmeName, readme && firstPara(readme)], ['package.json', pkg.description], ...['CLAUDE.md', 'AGENTS.md', 'DESIGN.md'].filter(has).map(n => [n, firstPara(tryRead(join(dir, n)))])].find(x => x[1]);
    const stack = has('.obsidian') ? 'obsidian vault' : has('Cargo.toml') ? 'rust' : has('go.mod') ? 'go' : has('pyproject.toml') || has('requirements.txt') ? 'python' : has('tsconfig.json') ? 'typescript' : has('package.json') ? 'node' : listDir(dir).some(f => f.isFile() && /\.html?$/i.test(f.name)) ? 'html' : 'other';
    const name = e.name; const projFm = projects.find(p => [].concat(p.fm.repo || []).some(r => { const pw = webUrl(r); return String(r).toLowerCase() === name.toLowerCase() || (pw && w && pw.url.toLowerCase() === w.url.toLowerCase()); }));
    repos.push({ type: 'repo', id: slug(name), name, path: dir, home: dir.startsWith(io.home() + '/') ? '~' + dir.slice(io.home().length) : dir,
      remote, url: w ? w.url : '', host: w ? HOSTS[w.host] || w.host : 'local only', owner: w ? w.path.split('/')[0] : '', branch, lastDate: last ? last.date : fileDate(join(git, 'HEAD')), lastMsg: last ? last.msg : '',
      description: descFrom ? descFrom[1] : '', descFrom: descFrom ? descFrom[0] : '', stack, project: projFm ? projFm.id : (projects.find(p => p.id.replace(/-/g, '') === slug(name).replace(/-/g, '')) || {}).id || null, 
      // relative links in the README (INSTALL.md, docs/) point at the local checkout
      readmeHtml: readme ? markdown(readme.replace(/<[^>]+>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, ''), () => null).replace(/href="(?!https?:|mailto:|#)([^"]+)"/g, (_, h) => 'href="file://' + encodeURI(dir + '/' + h.replace(/^\.\//, '')) + '"') : '' });
  }
  repos.sort((a, b) => b.lastDate.localeCompare(a.lastDate) || a.name.localeCompare(b.name));
}

// ---------- output ----------
const sortByName = (a, b) => a.name.localeCompare(b.name);
const data = {
  generated: new Date().toISOString(), today: todayStr(), vault: VAULT_NAME, categories: CATEGORIES, libraryCategories: LIBRARY_CATEGORIES,
  priorities: PRIORITIES, tasks: tasks.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || b.date.localeCompare(a.date)),
  days, repos, people: people.sort(sortByName), projects: projects.sort(sortByName), docs: docs.sort((a, b) => b.edited.localeCompare(a.edited) || a.name.localeCompare(b.name)), assets: assets.sort((a, b) => b.edited.localeCompare(a.edited)),
  weeks: weekList, backlinks: Object.fromEntries(backlinks),
  settings: { // what the Settings page shows and edits (app/config.json), plus where this vault is
    name: String((CONFIG.profile || {}).name || ''), role: String((CONFIG.profile || {}).role || ''), vaultPath: ROOT, home: io.home(),
    obsidianVault: VAULT_NAME, editIn: (CONFIG.obsidian || {}).editIn === 'obsidian' ? 'obsidian' : 'app',
    publishDir: String(CONFIG.publishDir || ''), shareBase: SHARE_BASE,
    repoRoots: (REPOS.roots || ['~']).map(String), repoExclude: (REPOS.exclude || []).map(String),
    appName: String(CONFIG.appName || 'Nostrion-os'), // the name in the window, the sidebar and the tab
    updates: { repo: String((CONFIG.updates || {}).repo || 'https://github.com/Nostrion/Nostrion-os'), branch: String((CONFIG.updates || {}).branch || 'main'), develop: !!(CONFIG.updates || {}).develop } },
  publish: { dir: PUBLISH_DIR, shareBase: SHARE_BASE, available: pubAvailable, source: pubSource, current: pubCounts.current, outdated: pubCounts.outdated },
  readme: io.exists(join(ROOT, 'README.md')) ? markdown(parseFrontmatter(readMd(join(ROOT, 'README.md'))).body, resolve) : '',
  totals: { hours: Math.round(days.reduce((s, d) => s + d.hours, 0) * 100) / 100, entries: days.reduce((s, d) => s + d.entries.length, 0) },
};
const json = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
const template = io.read(TEMPLATE);
if (!template.includes('/*__DATA__*/')) throw new Error('template.html is missing the /*__DATA__*/ marker');
io.write(OUT, template.replace('/*__DATA__*/', () => 'window.YCOS=' + json + ';'));
return (warnings.length ? warnings.map(w => '⚠ ' + w).join('\n') + '\n' : '') + 'Hub built → app/index.html  (' + days.length + ' days, ' + data.totals.entries + ' entries, ' + data.totals.hours + 'h, ' + people.length + ' people, ' + projects.length + ' projects, ' + docs.length + ' docs, ' + assets.length + ' assets, ' + repos.length + ' repos, ' + pubCounts.current + ' published' + (pubCounts.outdated ? ', ' + pubCounts.outdated + ' outdated' : '') + (pubSource === 'folder' ? '' : pubSource === 'record' ? ', publish state from last publish run' : ', publish folder unavailable/no access') + ')';
}

// ---------- environments ----------
function nodeIO() {
  const fs = require('fs');
  return {
    exists: (p) => fs.existsSync(p),
    home: () => require('os').homedir(),
    read: (p) => fs.readFileSync(p, 'utf8'),
    write: (p, s) => fs.writeFileSync(p, s),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    move: (a, b) => fs.renameSync(a, b),
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
    mkdir: (p) => { fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(p, true, $(), null); },
    move: (a, b) => { const ok = fm.moveItemAtPathToPathError(a, b, null); if (!ok) throw new Error('cannot move ' + a + ' to ' + b); },
    stat: (p) => { const a = fm.attributesOfItemAtPathError(p, null); return { mtime: new Date(a.fileModificationDate.timeIntervalSince1970 * 1000), size: Number(a.fileSize) }; },
    list: (dir) => ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(dir, null)).map(name => { const isDir = Ref(); fm.fileExistsAtPathIsDirectory(dir + '/' + name, isDir); return { name, isFile: () => !isDir[0] }; }),
  };
}

if (typeof require === 'function' && typeof module !== 'undefined') {           // Node
  module.exports = { buildVault, nodeIO, hashText, editTask, editStatus, trashNote, readNote, saveNote, saveConfig, stampTasks };
  const path = require('path');
  if (require.main === module || /build\.m?js$/.test(String(process.argv[1] || ''))) { // run directly (node app/build.js [vault]) — not when required by publish.js
    console.log(buildVault(nodeIO(), path.resolve(process.argv[2] || path.join(__dirname, '..'))));
  }
}
function run(argv) { // entry point when executed with osascript -l JavaScript (argv[0] = vault path, default: the vault folder in your home folder)
  const root = String(argv && argv[0] || '').replace(/\/+$/, '') || ObjC.unwrap($.NSHomeDirectory()) + '/Nostrion-os';
  return buildVault(jxaIO(), root);
}
