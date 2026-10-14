// Source of the Mac app — a tiny stay-open applet that loads app/main.js from the vault at every launch.
// Compile once (Terminal), then never again unless this file changes (README → The app):
//   osacompile -l JavaScript -s -o "/Applications/<APP>.app" <vault>/app/launcher.js
// The vault is the folder chosen under Settings → Vault, else the first of FOLDERS (in your home folder) or the folder next to the app.

var APP = 'Nostrion-os', FOLDERS = ['Nostrion-os', 'Desktop/Nostrion-os', 'Documents/Nostrion-os'];

ObjC.import('Cocoa');
var YC = {};

function ycosFindRoot() {
  var fm = $.NSFileManager.defaultManager;
  var bundle = ObjC.unwrap($.NSBundle.mainBundle.bundlePath);
  var home = ObjC.unwrap($.NSHomeDirectory());
  // Settings → Vault writes the chosen folder to this file (main.js, ycosSetVault)
  var pointer = $.NSString.stringWithContentsOfFileEncodingError(home + '/Library/Application Support/' + APP + '/vault', $.NSUTF8StringEncoding, null);
  var chosen = pointer.isNil() ? '' : ObjC.unwrap(pointer).trim();
  var candidates = (chosen ? [chosen] : []).concat(FOLDERS.map(function (f) { return home + '/' + f; }), [bundle.replace(/\/[^\/]+$/, '') + '/' + FOLDERS[0].split('/').pop()]);
  for (var i = 0; i < candidates.length; i++) if (fm.fileExistsAtPath(candidates[i] + '/app/main.js')) return candidates[i];
  return null;
}

function run() {
  var root = ycosFindRoot();
  if (!root) {
    var a = Application.currentApplication(); a.includeStandardAdditions = true;
    a.displayAlert(APP + ': vault not found', { message: 'Expected the vault at ~/' + FOLDERS[0] + ' or next to the app.' });
    return;
  }
  var src = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(root + '/app/main.js', $.NSUTF8StringEncoding, null));
  eval(src);
  ycosMain(root);
}

function reopen() { if (YC.reopen) YC.reopen(); }
function idle() { return (YC.idle && YC.idle()) || 5; } // seconds until next idle call
