# Install Nostrion-os

Written for Claude to follow step by step, and readable by a person. Ask before anything that installs software. Report what was done at the end.

## 1. Get the folder

```
git clone https://github.com/Nostrion/Nostrion-os ~/Nostrion-os
```

Keep the folder name `Nostrion-os`: the Mac app looks for it at `~/Nostrion-os`, next to the app, `~/Desktop/Nostrion-os` or `~/Documents/Nostrion-os`. If the person wants another location, pick one of those.

## 2. Obsidian

If Obsidian is not installed, offer to install it (`brew install --cask obsidian`, or https://obsidian.md). Then open `~/Nostrion-os` as a vault: Obsidian, "Open folder as vault". The vault settings (daily notes in `Log/`, templates in `_templates/`, attachments in `Assets/`) are in `.obsidian/` and apply at once. Obsidian may ask to trust the vault; it contains no community plugins.

## 3. Build the hub

Needs Node (`node -v`); on macOS the built-in JavaScript works too.

```
cd ~/Nostrion-os && node app/build.js
```

or without Node: `osascript -l JavaScript app/build.js ~/Nostrion-os`. Open `app/index.html` in a browser to check it shows the example data.

## 4. The Mac app (macOS only, optional but recommended)

It opens the hub in its own window, rebuilds whenever a file changes, and lets you tick and edit tasks from the hub.

```
osacompile -l JavaScript -s -o /Applications/Nostrion-os.app ~/Nostrion-os/app/launcher.js && cp ~/Nostrion-os/app/Nostrion-os.icns /Applications/Nostrion-os.app/Contents/Resources/applet.icns && plutil -remove CFBundleIconName /Applications/Nostrion-os.app/Contents/Info.plist && plutil -replace CFBundleName -string Nostrion-os /Applications/Nostrion-os.app/Contents/Info.plist
```

Then open the app from Applications. The first launch may ask for permission to control Obsidian or to read folders; allow it.

## 5. Skills

The `worklog` and `weekly-review` skills in `.claude/skills/` work whenever Claude Code runs inside the vault folder. To have `/worklog` available from any folder, copy them:

```
mkdir -p ~/.claude/skills && cp -R ~/Nostrion-os/.claude/skills/* ~/.claude/skills/
```

## 6. Make it yours

When the person is ready to start with their own notes, remove the example files (and nothing else):

```
cd ~/Nostrion-os && rm Log/2026-10-05.md Log/2026-10-06.md Log/2026-10-07.md Log/2026-10-12.md "People/Lena Bakker.md" "People/Mo Jansen.md" "People/Sam Visser.md" "Projects/Acme pilot.md" "Projects/Website relaunch.md" "Projects/Onboarding guide.md" Library/homepage-directions.md && node app/build.js
```

The Nostrion logo files in `Assets/` can stay. Then log the first entry: tell Claude what you did today and say `/worklog`.

## 7. Optional: publishing documents

To share Library documents by link, set `publishDir` and `shareBase` in `app/config.json` to a folder synced with OneDrive, Dropbox or Google Drive and its web address, then `node app/publish.js <name>`. See README, section "Publishing".
