// Source of Nostrion-os.app — a tiny stay-open applet that loads app/main.js from the vault at every launch.
// Compile once (Terminal), then never again unless this file changes:
//   osacompile -l JavaScript -s -o /Applications/Nostrion-os.app ~/Nostrion-os/app/launcher.js
// The vault is looked for at ~/Nostrion-os, next to the app, ~/Desktop/Nostrion-os, ~/Documents/Nostrion-os (first match wins).

ObjC.import('Cocoa');
var YC = {};

function ycosFindRoot() {
  var fm = $.NSFileManager.defaultManager;
  var bundle = ObjC.unwrap($.NSBundle.mainBundle.bundlePath);
  var home = ObjC.unwrap($.NSHomeDirectory());
  var candidates = [home + '/Nostrion-os', bundle.replace(/\/[^\/]+$/, '') + '/Nostrion-os', home + '/Desktop/Nostrion-os', home + '/Documents/Nostrion-os'];
  for (var i = 0; i < candidates.length; i++) if (fm.fileExistsAtPath(candidates[i] + '/app/main.js')) return candidates[i];
  return null;
}

function run() {
  var root = ycosFindRoot();
  if (!root) {
    var a = Application.currentApplication(); a.includeStandardAdditions = true;
    a.displayAlert('Nostrion-os vault not found', { message: 'Expected the Nostrion-os folder next to Nostrion-os.app or at ~/Desktop/Nostrion-os.' });
    return;
  }
  var src = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(root + '/app/main.js', $.NSUTF8StringEncoding, null));
  eval(src);
  ycosMain(root);
}

function reopen() { if (YC.reopen) YC.reopen(); }
function idle() { return (YC.idle && YC.idle()) || 5; } // seconds until next idle call
