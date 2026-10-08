// Nostrion-os desktop app — the window, the Dock icon and the JS↔Mac bridge.
// This file is loaded at launch by Nostrion-os.app (compiled from app/launcher.js, see README), so you can edit it
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
    var path = (YC.root || ObjC.unwrap($.NSHomeDirectory()) + '/Desktop/Nostrion-os') + '/app/app.log';
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

function ycosMain(root) {
  YC.root = root;
  var app = $.NSApplication.sharedApplication;

  // 1. build (errors are shown, then the last built hub opens anyway)
  ycosLog('launch, root=' + root);
  try { YC.status = ycosBuild(root); ycosLog('build ok: ' + YC.status); } catch (e) { ycosLog('build error: ' + (e && e.message || e)); ycosAlert('Nostrion-os build failed', String(e && e.message || e)); }

  // 2. bridge: page → Mac (open links in the default browser / Obsidian, rebuild on request)
  if (!YC.bridgeClass) {
    ObjC.registerSubclass({
      name: 'YcBridge', superclass: 'NSObject', protocols: ['WKScriptMessageHandler'],
      methods: {
        'rebuild:': { types: ['void', ['id']], implementation: function (sender) { ycosLog('menu rebuild'); try { YC.status = ycosBuild(YC.root); ycosLog('build ok: ' + YC.status); ycosReload(); } catch (e) { ycosLog('build error: ' + (e && e.message || e)); ycosAlert('Nostrion-os build failed', String(e && e.message || e)); } } },
        'goBack:': { types: ['void', ['id']], implementation: function (sender) { try { YC.webview.goBack; } catch (e) {} } },
        'goForward:': { types: ['void', ['id']], implementation: function (sender) { try { YC.webview.goForward; } catch (e) {} } },
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
              if (m.task) { var tr = ycosTask(YC.root, m.task); ycosLog('task ' + JSON.stringify(tr)); if (!tr.ok) ycosAlert('Nostrion-os task', tr.error); m.rebuild = true; }
              if (m.rebuild) { try { YC.status = ycosBuild(YC.root); ycosLog('build ok: ' + YC.status); } catch (e) { ycosLog('build error: ' + (e && e.message || e)); ycosAlert('Nostrion-os build failed', String(e && e.message || e)); } ycosReload(); }
            } catch (e) { ycosLog('message error: ' + e); ycosAlert('Nostrion-os', String(e && e.message || e)); }
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
  win.title = 'Nostrion-os';
  win.releasedWhenClosed = false;
  win.minSize = $.NSMakeSize(900, 600);
  win.setFrameAutosaveName('Nostrion-os.main');
  win.center;

  var cfg = $.WKWebViewConfiguration.alloc.init;
  cfg.userContentController.addScriptMessageHandlerName(YC.bridge, 'ycos');
  // floating ← → ⌂ bar on every page that is not the hub itself (Library html files), so you can always get back to Nostrion-os
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

// JS injected into every page the window shows. On a Library html file it adds a small floating bar: ← back, → forward, ⌂ Nostrion-os.
// (The hub has its own buttons, so the bar hides itself on app/index.html.)  ⌘[ ⌘] and ⌘← ⌘→ keep working through the View menu.
function ycosNavBarScript(root) {
  var home = 'file://' + encodeURI(root) + '/app/index.html#/library';
  return "(function(){" +
    "if(/\\/app\\/index\\.html$/.test(location.pathname)||document.getElementById('ycos-nav'))return;" +
    "var home=" + JSON.stringify(home) + ";" +
    "var st=document.createElement('style');st.textContent='" +
      "#ycos-nav{position:fixed;top:10px;left:10px;z-index:2147483647;display:flex;gap:4px;padding:4px;background:rgba(255,255,255,.92);border:1px solid #e9e9ec;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.08);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font:13px/1 \"Helvetica Neue\",Helvetica,Arial,-apple-system,sans-serif;opacity:.75;transition:opacity .15s}" +
      "#ycos-nav:hover{opacity:1}" +
      "#ycos-nav button{height:28px;min-width:28px;padding:0 8px;border:0;background:transparent;border-radius:7px;color:#8a8a8f;cursor:pointer;font:inherit;font-size:14px;display:flex;align-items:center;gap:6px}" +
      "#ycos-nav button:hover{background:#f0f0f2;color:#161616}" +
      "#ycos-nav button.home{font-size:12px;font-weight:500;color:#161616}" +
      "#ycos-nav button.home i{display:inline-block;width:9px;height:9px;border:2.5px solid #161616;border-radius:50%}" +
    "';document.documentElement.appendChild(st);" +
    "var bar=document.createElement('div');bar.id='ycos-nav';" +
    "bar.innerHTML='<button class=\"home\" title=\"Back to Nostrion-os (Esc)\"><i></i>Nostrion-os</button><button data-go=\"-1\" title=\"Back (\u2318[)\">\u2190</button><button data-go=\"1\" title=\"Forward (\u2318])\">\u2192</button>';" +
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
