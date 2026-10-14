// Desktop app — the window, the Dock icon and the JS↔Mac bridge.
// This file is loaded at launch by the app (compiled from app/launcher.js, see README), so you can edit it
// without recompiling the app. Runs on macOS's built-in JavaScript (JXA) — no Node, no installs.

ObjC.import('Cocoa');
ObjC.import('WebKit');

function ycosAlert(title, message) {
  var a = Application.currentApplication(); a.includeStandardAdditions = true;
  try { a.displayAlert(title, { message: String(message).slice(0, 600) }); } catch (e) {}
}

function ycosLog(msg) { // app/app.log — for debugging
  try {
    var line = new Date().toISOString().slice(11, 19) + ' ' + String(msg) + '\n';
    if (!YC.root) return; var path = YC.root + '/app/app.log';
    var fh = $.NSFileHandle.fileHandleForWritingAtPath(path);
    if (fh.isNil()) { $(line).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null); }
    else { fh.seekToEndOfFile; fh.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding)); fh.closeFile; }
  } catch (e) {}
}
// WKWebView's reload / reloadFromOrigin keep showing the old copy of a file:// page after it is rewritten,
// so load the current URL again (keeps the #/route); fall back to the hub.
function ycosReload() {
  try {
    var wv = YC.webview, url = wv.URL;
    if (url.isNil() || !url.isFileURL) url = $.NSURL.fileURLWithPath(YC.root + '/app/index.html');
    wv.loadFileURLAllowingReadAccessToURL(url, $.NSURL.fileURLWithPath(YC.root));
  } catch (e) { ycosLog('reload error ' + e); }
}

function ycosEval(js) { try { YC.webview.evaluateJavaScriptCompletionHandler(js, function () {}); } /* a null completion handler crashes JXA */ catch (e) { ycosLog('eval error ' + e); } }
function ycosBuildJs(root, body) { // run build.js on the built-in JS engine, then `body` (has `io` and `root`)
  var src = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(root + '/app/build.js', $.NSUTF8StringEncoding, null));
  var fn = new Function('ObjC', '$', 'Ref', 'root', 'arg', src + '\nvar io = jxaIO();\n' + body);
  return fn(ObjC, $, Ref, root, arguments[2]);
}
function ycosBuild(root) { // rebuild app/index.html from the vault
  var r = ycosBuildJs(root, 'return [buildVault(io, root), !!io.pending];');
  // a task line in a file edited less than a minute ago is stamped (added:: / done::) on a later build → YC.idle builds again
  YC.pendingSince = r[1] ? (YC.pendingSince || Date.now()) : 0;
  return r[0];
}
function ycosTask(root, req) { // a task changed in the hub → rewrite that one line in the vault (editTask in build.js)
  return ycosBuildJs(root, 'return editTask(io, root, arg);', req);
}

// where the launcher looks for the vault first (see launcher.js): one line, the vault's folder
function ycosConfig(root) { // app/config.json, {} when missing or broken
  try { var s = $.NSString.stringWithContentsOfFileEncodingError(root + '/app/config.json', $.NSUTF8StringEncoding, null); return s.isNil() ? {} : (JSON.parse(ObjC.unwrap(s)) || {}); } catch (e) { return {}; }
}
function ycosName() { return String(ycosConfig(YC.root).appName || 'Nostrion-os'); } // the product name (app/config.json → appName)
function ycosPointerDir() { return ObjC.unwrap($.NSHomeDirectory()) + '/Library/Application Support/' + ycosName(); } // launcher.js reads <this>/vault
function ycosPickFolder(start) { // macOS folder dialog → path, or '' when cancelled
  try {
    var panel = $.NSOpenPanel.openPanel; panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false;
    panel.message = 'Choose the vault folder (the folder with Log, People, Projects, Library and app/)'; panel.prompt = 'Use this vault';
    panel.directoryURL = $.NSURL.fileURLWithPath(start);
    if (panel.runModal !== 1 /* NSModalResponseOK */) return '';
    return ObjC.unwrap(panel.URLs.objectAtIndex(0).path);
  } catch (e) { ycosLog('pick folder error ' + e); return ''; }
}
function ycosSetVault(path) { // '' → back to the default folder
  try {
    var fm = $.NSFileManager.defaultManager;
    if (path && !fm.fileExistsAtPath(path + '/app/main.js')) return { ok: false, error: 'No app/main.js in ' + path + ' — not a vault for this app.' };
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(ycosPointerDir(), true, $(), null);
    var ok = $(path + '\n').writeToFileAtomicallyEncodingError(ycosPointerDir() + '/vault', true, $.NSUTF8StringEncoding, null);
    return ok ? { ok: true, path: path } : { ok: false, error: 'Cannot write ' + ycosPointerDir() + '/vault' };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// ---------- updates: the app code from the shared repo (app/config.json → updates.repo, default Nostrion/Nostrion-os) ----------
// Only these paths are compared and replaced; notes, app/config.json and everything else in the vault stay as they are.
var YC_UPDATE_PATHS = ['app/build.js', 'app/template.html', 'app/main.js', 'app/launcher.js', 'app/publish.js', 'app/datename.js', 'app/fonts', 'README.md', 'INSTALL.md'];
function ycosSh(cmd) { var a = Application.currentApplication(); a.includeStandardAdditions = true; return a.doShellScript(cmd); }
function ycosUpdates(root, install) {
  var q = function (s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; };
  var u = ycosConfig(root).updates || {}; var repo = String(u.repo || 'https://github.com/Nostrion/Nostrion-os'); var branch = String(u.branch || 'main');
  var git = 'cd ' + q(root) + ' && /usr/bin/git ';
  try {
    try { ycosSh(git + 'rev-parse --is-inside-work-tree'); } catch (e) { return { ok: false, repo: repo, error: 'This vault is not a git folder, so it cannot update itself. Install it again with git clone (see INSTALL.md).' }; }
    ycosSh(git + 'fetch --quiet --no-tags ' + q(repo) + ' ' + q(branch));
    var latest = ycosSh(git + "log -1 --format='%h%x09%cs%x09%s' FETCH_HEAD").split('\t');
    var paths = YC_UPDATE_PATHS.map(q).join(' ');
    var inRepo = ycosSh(git + 'ls-tree -r --name-only FETCH_HEAD -- ' + paths + ' || true').split(/\r?\n|\r/).filter(Boolean);
    var changed = ycosSh(git + 'diff --name-only FETCH_HEAD -- ' + paths + ' || true').split(/\r?\n|\r/).filter(Boolean);
    var res = { ok: true, repo: repo, branch: branch, latest: { hash: latest[0], date: latest[1], subject: latest[2] }, changed: changed, develop: !!u.develop };
    if (!install || !changed.length) return res;
    if (u.develop) return { ok: false, repo: repo, error: 'This vault is the development copy: it is not overwritten from the repo.' };
    var take = changed.filter(function (f) { return inRepo.indexOf(f) >= 0; });
    if (take.length) ycosSh(git + 'checkout FETCH_HEAD -- ' + take.map(q).join(' ') + ' && /usr/bin/git reset -q -- ' + take.map(q).join(' '));
    res.installed = take; res.launcher = take.indexOf('app/launcher.js') >= 0; res.changed = [];
    return res;
  } catch (e) { return { ok: false, repo: repo, error: String(e && e.message || e).replace(/^.*?error:\s*/i, '') }; }
}

function ycosMain(root) {
  YC.root = root;
  var app = $.NSApplication.sharedApplication;

  // 1. build (errors are shown, then the last built hub opens anyway)
  ycosLog('launch, root=' + root);
  try { YC.status = ycosBuild(root); ycosLog('build ok: ' + YC.status); } catch (e) { ycosLog('build error: ' + (e && e.message || e)); ycosAlert(ycosName() + ' build failed', String(e && e.message || e)); }

  // 2. bridge: page → Mac (open links in the default browser / Obsidian, rebuild on request)
  if (!YC.bridgeClass) {
    ObjC.registerSubclass({
      name: 'YcBridge', superclass: 'NSObject', protocols: ['WKScriptMessageHandler'],
      methods: {
        'rebuild:': { types: ['void', ['id']], implementation: function (sender) { ycosLog('menu rebuild'); try { YC.status = ycosBuild(YC.root); ycosLog('build ok: ' + YC.status); ycosReload(); } catch (e) { ycosLog('build error: ' + (e && e.message || e)); ycosAlert(ycosName() + ' build failed', String(e && e.message || e)); } } },
        // ⌘← ⌘→ are also cursor keys: while a note is open in the editor they stay in the text (⌘[ ⌘] and the page's Back still work)
        'goBack:': { types: ['void', ['id']], implementation: function (sender) { try { if (YC.editing && sender && ObjC.unwrap(sender.keyEquivalent) !== '[') return; YC.webview.goBack; } catch (e) {} } },
        'goForward:': { types: ['void', ['id']], implementation: function (sender) { try { if (YC.editing && sender && ObjC.unwrap(sender.keyEquivalent) !== ']') return; YC.webview.goForward; } catch (e) {} } },
        'focusSearch:': { types: ['void', ['id']], implementation: function (sender) { try { YC.webview.evaluateJavaScriptCompletionHandler("document.getElementById('q').focus();document.getElementById('q').select();", function () {}); } /* a null completion handler crashes JXA */ catch (e) {} } },
        'userContentController:didReceiveScriptMessage:': {
          types: ['void', ['id', 'id']],
          implementation: function (ucc, msg) {
            var m = ObjC.deepUnwrap(msg.body) || {};
            ycosLog('message ' + JSON.stringify(m));
            try {
              if (m.open) $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(String(m.open)));
              if (m.copy) { var pb = $.NSPasteboard.generalPasteboard; pb.clearContents; pb.setStringForType($(String(m.copy)), $.NSPasteboardTypeString); }
              if (m.reveal) $.NSWorkspace.sharedWorkspace.selectFileInFileViewerRootedAtPath($(String(m.reveal)), $(''));
              if (m.task) { var tr = ycosTask(YC.root, m.task); ycosLog('task ' + JSON.stringify(tr)); if (!tr.ok) ycosAlert(ycosName() + ' task', tr.error); m.rebuild = true; }
              if (m.status) { var sr = ycosBuildJs(YC.root, 'return editStatus(io, root, arg);', m.status); ycosLog('status ' + JSON.stringify(sr)); if (!sr.ok) ycosAlert(ycosName() + ' status', sr.error); m.rebuild = true; }
              // in-app editor: read the note into the page, save it back (refused when the file changed meanwhile); while it is open the idle rebuild waits
              if (m.read) { var rr = ycosBuildJs(YC.root, 'return readNote(io, root, arg);', m.read); if (rr.ok) YC.editing = Date.now(); ycosEval('window.ycEditLoaded(' + JSON.stringify(rr) + ')'); }
              if (m.save) { var wr = ycosBuildJs(YC.root, 'return saveNote(io, root, arg);', m.save); ycosLog('save ' + JSON.stringify({ file: wr.file, ok: wr.ok, error: wr.error })); if (wr.ok) YC.editing = 0; ycosEval('window.ycEditSaved(' + JSON.stringify(wr) + ')'); }
              if (m.editing === false) YC.editing = 0;
              // Settings page: app/config.json (rebuilds), the vault folder (a pointer the launcher reads at the next start)
              if (m.config) { var cr = ycosBuildJs(YC.root, 'return saveConfig(io, root, arg);', m.config); ycosLog('config ' + JSON.stringify(cr)); if (!cr.ok) ycosAlert('Settings', cr.error); m.rebuild = true; }
              if (m.pickVault) { var picked = ycosPickFolder(YC.root); ycosEval('window.ycVaultPicked(' + JSON.stringify(picked) + ')'); }
              if (m.setVault !== undefined) { var vr = ycosSetVault(String(m.setVault)); ycosEval('window.ycVaultSet(' + JSON.stringify(vr) + ')'); }
              if (m.updates) { var ur = ycosUpdates(YC.root, m.updates === 'install'); ycosLog('updates ' + JSON.stringify(ur).slice(0, 300)); if (m.updates === 'install' && ur.ok && ur.installed) m.rebuild = true; else ycosEval('window.ycUpdates(' + JSON.stringify(ur) + ')'); }
              if (m.trash) { var dr = ycosBuildJs(YC.root, 'return trashNote(io, root, arg);', m.trash); ycosLog('trash ' + JSON.stringify(dr)); if (!dr.ok) ycosAlert(ycosName() + ' delete', dr.error); m.rebuild = true; }
              if (m.rebuild) { try { YC.status = ycosBuild(YC.root); ycosLog('build ok: ' + YC.status); } catch (e) { ycosLog('build error: ' + (e && e.message || e)); ycosAlert(ycosName() + ' build failed', String(e && e.message || e)); } ycosReload(); }
            } catch (e) { ycosLog('message error: ' + e); ycosAlert(ycosName(), String(e && e.message || e)); }
          }
        }
      }
    });
    YC.bridgeClass = true;
    ycosLog('bridge class registered');
  }
  YC.bridge = $.YcBridge.alloc.init;

  // 3. window with a web view showing app/index.html
  var rect = $.NSMakeRect(0, 0, 1400, 900);
  var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(rect, 15 /* titled|closable|miniaturizable|resizable */, $.NSBackingStoreBuffered, false);
  win.title = ycosName();
  win.releasedWhenClosed = false;
  win.minSize = $.NSMakeSize(900, 600);
  win.setFrameAutosaveName('Nostrion-os.main');
  win.center;

  var cfg = $.WKWebViewConfiguration.alloc.init;
  cfg.userContentController.addScriptMessageHandlerName(YC.bridge, 'ycos');
  // floating ← → ⌂ bar on every page that is not the hub itself (Library html files), so you can always get back to the hub
  try {
    var us = $.WKUserScript.alloc.initWithSourceInjectionTimeForMainFrameOnly(ycosNavBarScript(root), 1 /* at document end */, true);
    cfg.userContentController.addUserScript(us);
  } catch (e) { ycosLog('navbar script error: ' + e); }
  var wv = $.WKWebView.alloc.initWithFrameConfiguration(rect, cfg);
  wv.autoresizingMask = 18; /* width + height sizable */
  wv.allowsBackForwardNavigationGestures = true; /* two-finger swipe = back / forward */
  wv.allowsMagnification = true; /* pinch / ⌘+ zoom */
  win.contentView = wv;
  wv.loadFileURLAllowingReadAccessToURL($.NSURL.fileURLWithPath(root + '/app/index.html'), $.NSURL.fileURLWithPath(root));

  YC.win = win; YC.webview = wv;

  // 4. Dock icon + bring to front
  var icon = $.NSImage.alloc.initWithContentsOfFile(root + '/app/Nostrion-os.icns'); 
  if (!icon.isNil()) app.setApplicationIconImage(icon);
  win.makeKeyAndOrderFront(null);
  win.makeFirstResponder(wv);
  app.activateIgnoringOtherApps(true);

  // 5. View menu: keyboard shortcuts work through the menu even when the web view does not see ⌘-keys
  try {
    var main = app.mainMenu;
    if (!main.isNil() && !YC.menuDone) {
      var viewMenu = $.NSMenu.alloc.initWithTitle('View');
      var add = function (title, action, key, mask) { var it = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, key); it.target = YC.bridge; if (mask) it.keyEquivalentModifierMask = mask; viewMenu.addItem(it); };
      add('Rebuild', 'rebuild:', 'r');
      add('Search', 'focusSearch:', 'k');
      viewMenu.addItem($.NSMenuItem.separatorItem);
      add('Back', 'goBack:', '[');
      add('Forward', 'goForward:', ']');
      add('Back (⌘←)', 'goBack:', '\uF702', 1048576);
      add('Forward (⌘→)', 'goForward:', '\uF703', 1048576);
      var viewItem = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent('View', null, '');
      viewItem.submenu = viewMenu;
      main.insertItemAtIndex(viewItem, Math.min(1, main.numberOfItems));
      YC.menuDone = true;
      ycosLog('view menu added (' + main.numberOfItems + ' menus)');
    } else ycosLog('no main menu: ' + (main.isNil() ? 'nil' : 'already done'));
  } catch (e) { ycosLog('menu error: ' + e); }
}

// JS injected into every page the window shows. On a Library html file it adds a small floating bar: ← back, → forward, ⌂ hub.
// (The hub has its own buttons, so the bar hides itself on app/index.html.)  ⌘[ ⌘] and ⌘← ⌘→ keep working through the View menu.
function ycosNavBarScript(root) {
  var home = 'file://' + encodeURI(root) + '/app/index.html#/library';
  return "(function(){" +
    "if(/\\/app\\/index\\.html$/.test(location.pathname)||document.getElementById('ycos-nav'))return;" +
    "var home=" + JSON.stringify(home) + ";" +
    "var st=document.createElement('style');st.textContent='" +
      "#ycos-nav{position:fixed;top:10px;left:10px;z-index:2147483647;display:flex;gap:4px;padding:4px;background:rgba(255,255,255,.92);border:1px solid #D6D6D6;border-radius:0;box-shadow:0 10px 28px rgba(12,16,30,.08);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font:13px/1 \"Helvetica Neue\",Helvetica,Arial,-apple-system,sans-serif;opacity:.75;transition:opacity .15s}" +
      "#ycos-nav:hover{opacity:1}" +
      "#ycos-nav button{height:28px;min-width:28px;padding:0 8px;border:0;background:transparent;border-radius:0;color:#666;cursor:pointer;font:inherit;font-size:14px;display:flex;align-items:center;gap:6px}" +
      "#ycos-nav button:hover{background:#000;color:#fff}" +
      "#ycos-nav button.home{font-size:12px;font-weight:500;color:#000}" +
      "#ycos-nav button.home i{display:inline-block;width:9px;height:9px;border:2.5px solid currentColor;border-radius:50%}" +
    "';document.documentElement.appendChild(st);" +
    "var bar=document.createElement('div');bar.id='ycos-nav';" +
    "bar.innerHTML='<button class=\"home\" title=\"Back to the hub (Esc)\"><i></i>Hub</button><button data-go=\"-1\" title=\"Back (\u2318[)\">\u2190</button><button data-go=\"1\" title=\"Forward (\u2318])\">\u2192</button>';" +
    "bar.addEventListener('click',function(ev){var b=ev.target.closest('button');if(!b)return;if(b.classList.contains('home'))location.href=home;else history.go(+b.dataset.go);});" +
    "(document.body||document.documentElement).appendChild(bar);" +
    // WKWebView drops target=_blank links and window.open (no UI delegate), so hand external links to the Mac, like the hub does
    "var native=window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.ycos;" +
    "if(native){" +
      "document.addEventListener('click',function(ev){var a=ev.target.closest&&ev.target.closest('a[href]');if(!a||ev.defaultPrevented)return;" +
        "var h=a.getAttribute('href')||'';" +
        "if(/^(https?:|mailto:|obsidian:)/i.test(h)){ev.preventDefault();native.postMessage({open:a.href});}" +
        "else if(a.target==='_blank'){ev.preventDefault();location.href=a.href;}" +
      "});" +
      "var wo=window.open;window.open=function(u){if(u){var x=new URL(u,location.href).href;if(/^(https?:|mailto:|obsidian:)/i.test(x))native.postMessage({open:x});else location.href=x;return null;}return wo.apply(window,arguments);};" +
    "}" +
    "document.addEventListener('keydown',function(ev){" +
      "var typing=/input|textarea|select/i.test((document.activeElement||{}).tagName||'');" +
      "if((ev.metaKey||ev.ctrlKey)&&(ev.key==='['||ev.key==='ArrowLeft')){ev.preventDefault();history.back();}" +
      "else if((ev.metaKey||ev.ctrlKey)&&(ev.key===']'||ev.key==='ArrowRight')){ev.preventDefault();history.forward();}" +
      "else if(ev.key==='Escape'&&!typing){location.href=home;}" +
    "});" +
  "})();";
}

// newest modification time of any .md / .html file in the vault (skips app/, .obsidian/)
function ycosNewest(root) {
  var fm = $.NSFileManager.defaultManager; var newest = 0;
  var dirs = ['Log', 'People', 'Projects', 'Library', 'Assets', ''];
  for (var i = 0; i < dirs.length; i++) {
    var dir = dirs[i] ? root + '/' + dirs[i] : root;
    var names = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(dir, null)) || [];
    for (var j = 0; j < names.length; j++) {
      if (names[j].charAt(0) === '.' || names[j] === 'app' || names[j] === '_templates') continue;
      var a = fm.attributesOfItemAtPathError(dir + '/' + names[j], null); if (a.isNil()) continue;
      var t = a.fileModificationDate.timeIntervalSince1970; if (t > newest) newest = t;
    }
  }
  // app/publish-state.json is rewritten by every publish run → refresh the "Published" column (app/ is otherwise ignored)
  var ps = fm.attributesOfItemAtPathError(root + '/app/publish-state.json', null);
  if (!ps.isNil()) { var pst = ps.fileModificationDate.timeIntervalSince1970; if (pst > newest) newest = pst; }
  // also the Publish folder itself (OneDrive, app/config.json) — only works once macOS lets the app read it
  var pub = ycosPublishDir(root);
  if (pub && fm.fileExistsAtPath(pub)) {
    var pn = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(pub, null)) || []; var count = 0;
    for (var k = 0; k < pn.length; k++) {
      if (pn[k].charAt(0) === '.') continue; count++;
      var pa = fm.attributesOfItemAtPathError(pub + '/' + pn[k], null); if (pa.isNil()) continue; // metadata only — does not download cloud-only files
      var pt = pa.fileModificationDate.timeIntervalSince1970; if (pt > newest) newest = pt;
    }
    if (YC.pubCount !== undefined && count !== YC.pubCount) newest = Math.max(newest, Date.now() / 1000); // a copy was removed
    YC.pubCount = count;
  }
  return newest;
}
function ycosPublishDir(root) { // publishDir from app/config.json, ~ expanded; '' when not configured
  try {
    var s = $.NSString.stringWithContentsOfFileEncodingError(root + '/app/config.json', $.NSUTF8StringEncoding, null); if (s.isNil()) return '';
    var d = String((JSON.parse(ObjC.unwrap(s)) || {}).publishDir || '');
    return d.replace(/^~(?=\/|$)/, ObjC.unwrap($.NSHomeDirectory()));
  } catch (e) { return ''; }
}
YC.idle = function () { // called by the applet every few seconds: rebuild + reload when the vault changed
  try {
    if (!YC.root || !YC.webview) return 5;
    if (YC.editing && Date.now() - YC.editing < 3 * 3600 * 1000) return 3; // a note is open in the editor: a reload would drop it
    var newest = ycosNewest(YC.root);
    if (YC.lastSeen === undefined) YC.lastSeen = newest;
    var stamp = YC.pendingSince && Date.now() - YC.pendingSince > 65000;
    if (newest > YC.lastSeen || stamp) { YC.lastSeen = newest; ycosLog(stamp ? 'task dates pending → rebuild' : 'vault changed → rebuild'); YC.pendingSince = 0; YC.status = ycosBuild(YC.root); ycosReload(); }
  } catch (e) { ycosLog('idle error: ' + e); }
  return 3;
};
YC.reopen = function () { // Dock icon clicked while the window is closed
  if (YC.win) { ycosLog('reopen'); try { YC.status = ycosBuild(YC.root); ycosReload(); } catch (e) {} YC.win.makeKeyAndOrderFront(null); $.NSApplication.sharedApplication.activateIgnoringOtherApps(true); }
};
