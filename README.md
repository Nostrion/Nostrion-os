# Nostrion-os

A personal work system for people who work with Claude: an Obsidian vault of plain Markdown files, a generated hub (`app/index.html`) that shows today, tasks, hours, projects, people and documents, and two Claude skills (`/worklog`, `/weekly-review`) that keep the log. Everything is files in one folder; nothing is stored anywhere else.

The starter ships with a few example days, people and projects so every page has something to show. Replace them with your own (see `INSTALL.md`).

## Install with Claude

Open Claude Code (or Nostrion AI) and paste:

> Install Nostrion-os for me: clone https://github.com/Nostrion/Nostrion-os into ~/Nostrion-os and follow its INSTALL.md step by step.

Manual install: `git clone https://github.com/Nostrion/Nostrion-os ~/Nostrion-os`, open that folder as a vault in Obsidian, run `node app/build.js`, open `app/index.html`. Details and the Mac app in `INSTALL.md`.

## How it works

**Source of truth = the Markdown files.** The hub is a view: the only thing it writes is task lines (tick, edit, add). Edit everything else in Obsidian (or any editor); the hub rebuilds itself.

## Folders

| Folder | Contains | One file per |
|---|---|---|
| `Log/` | daily logs `YYYY-MM-DD.md`, each a list of time-stamped entries | day |
| `Projects/` | project pages | project |
| `People/` | people pages | person |
| `Library/` | documents: `.md` notes and `.html` files (prototypes, reports, tools), named `YYYY-MM-DD_name` | document |
| `Assets/` | any other file (pdf, png, xlsx, …), named `YYYY-MM-DD_name`; optional `.md` sidecar with the same name for notes | file |
| `_templates/` | Obsidian templates for new files | — |
| `app/` | `build.js` (generator; also stamps task dates and applies task edits from the hub), `template.html` (hub UI), `main.js` + `launcher.js` (the app), `publish.js` (copy a doc to the OneDrive Publish folder), `config.json` (where that folder is), `publish-state.json` + `index.html` (generated — do not edit) | — |

## The app / rebuilding the hub

**Nostrion-os.app** (Applications, Dock) opens the hub in its own window. It rebuilds on launch, whenever a vault file changes (checked every 3 s), on ⌘R and via *↻ rebuild*. It runs on macOS's built-in JavaScript — nothing to install. The vault lives at `~/Nostrion-os`.

The app is compiled once from `app/launcher.js` (Terminal; only needed again if `launcher.js` changes):

```
osacompile -l JavaScript -s -o /Applications/Nostrion-os.app ~/Nostrion-os/app/launcher.js && cp ~/Nostrion-os/app/Nostrion-os.icns /Applications/Nostrion-os.app/Contents/Resources/applet.icns && plutil -remove CFBundleIconName /Applications/Nostrion-os.app/Contents/Info.plist && plutil -replace CFBundleName -string Nostrion-os /Applications/Nostrion-os.app/Contents/Info.plist
```

Everything else lives in the vault and can change without recompiling: `app/main.js` (window + bridge), `app/build.js` (generator), `app/template.html` (hub UI). Rebuild from a terminal with `node app/build.js` or `osascript -l JavaScript app/build.js ~/Nostrion-os`.

Lists (Daily Log, Tasks, Projects, People, Library, Assets, Hours entries) share one filter system: one **dropdown button per group** (category, project, status, …). A plain button means the group is not narrowed; a dark one shows what it is narrowed to (*Project · Acme pilot, Website relaunch*). Open it for checkboxes with live counts: a click shows or hides that value, **only** (on hover, or Alt-click) shows just that one, and *all* ticks everything (or nothing, when everything is ticked). Archived documents and closed tasks are hidden by default (their toggle is simply off).

**Projects** has one tab per stage: *Active* (active and paused), *Ideas* (cards), *Done* and *Archived* (a record with started, ended and hours) and *All*. Tables group by category by default, or by status, or not at all (*group* on the right). Subprojects stay under their parent and count in the parent's group; one shown apart from its parent names it (*Homepage copy · Website relaunch*). Column headers **sort**; filters and sort are remembered across rebuilds; *reset* brings a page back to its defaults.

Keyboard: `⌘R` rebuild + refresh · `⌘[` / `⌘]` back / forward · `←` `→` previous / next day · `/` or `⌘K` search. Every page has an "edit in Obsidian" link (the Obsidian vault must be named `Nostrion-os`).

## Formats

### Log entry (`Log/2026-09-29.md`)

Everything hangs off log entries. One file per day, one `##` heading per entry. `/worklog` appends entries any time.

```markdown
---
date: 2026-09-29
---

## Workshop with the design agency
project:: [[Website relaunch]]
category:: meeting
hours:: 1
people:: [[Lena Bakker]]

Free notes. Wikilinks anywhere are picked up: [[Some doc]].

## Built prototype v2
project:: [[Website relaunch]]
category:: build
hours:: 3
```

- Heading: `## Title` — one per activity, no times.
- Fields (`key:: value`, Obsidian Dataview style), all optional: `project`, `category`, `hours`, `people`, `docs`.
- Categories: **meeting · build · research · writing · admin · learning** (edit `CATEGORIES` in `app/build.js`).
- People pages show every entry that links them (via `people::` or a `[[wikilink]]` in the notes). Project pages the same, plus total hours.

### Person (`People/Lena Bakker.md`)

```markdown
---
name: Lena Bakker
role: Product manager
organization: Nostrion
relationship: colleague
linkedin: https://www.linkedin.com/in/…
projects: ["[[Website relaunch]]"]
---
Free notes about the person.
```

`relationship` is the people category — use **colleague · client · external stakeholder · friend · family** (free text; the People page filters on it). `linkedin`, `email` and `phone` are optional.

### Project (`Projects/Website relaunch.md`)

```markdown
---
name: Website relaunch
description: New nostrion.com, launch planned for November
category: client
status: active
started: 2026-09-14
people: ["[[Lena Bakker]]"]
---
Free notes, decisions, links.
```

Project categories, by who the work is for: **client** (paid work for an outside client) · **product** (what Nostrion builds) · **internal** (running Nostrion) · **personal** (own tooling). Free text, these are conventions. Status: `idea · active · paused · done · archived`. An **idea** is parked, not started; set it to *active* when work begins. **Done** means the work finished; **archived** keeps it out of the way for good.

### Tasks (inside log entries)

A call to action is a checkbox in the entry it came from — no separate task file:

```markdown
- [ ] Pick a homepage direction with [[Sam Visser]] (priority:: plan) (due:: 2026-10-06) (added:: 2026-09-29)
- [x] Quote on illustrations from Sam (waiting:: [[Sam Visser]]) (added:: 2026-09-29) (done:: 2026-10-02)
```

- Status: `[ ]` open · `[/]` in progress · `[x]` done · `[-]` cancelled. Tick it in Obsidian or in the hub.
- Optional fields: `priority`, `due` (YYYY-MM-DD), `waiting` (person you wait for), `people` (others involved, `[[A]], [[B]]`), `project` (defaults to the entry's project).
- **Dates are automatic.** Every build adds `added::` (the log's date; today for a task on a project page) and `done::` (the day it was closed; removed again when reopened). A file edited less than a minute ago is stamped a minute later, so the line you are typing in Obsidian is left alone. `done:: unknown` marks tasks closed before dates were tracked.
- **Editing in the hub** (the app only): click a box to tick or reopen; click a task to edit text, status, priority, due date, project, waiting on and people; **+ task** or `N` adds one. A new task goes into today's log under `## Tasks` (prefilled with the project or person when added from their page). Each change rewrites that one line in its file; if the line changed in the meantime the hub refuses and refreshes.
- Tasks can also live in a project page body.
- The **Tasks** page shows them as an Eisenhower matrix or a sortable list (added, done, days open or days to finish); open tasks also show on project and person pages (projects also list recently done ones), and "Do now" on Today.

### Priority (tasks only)

`priority:` = **do** (urgent · important) · **plan** (important · not urgent) · **delegate** (urgent · not important) · **later** (neither).

### Subprojects

Add `parent: "[[Website relaunch]]"` to a project. The parent lists its subprojects, rolls up their hours and tasks, and the Projects list shows the tree.

### Naming: date first (Library and Assets)

Every file in `Library/` and `Assets/` starts with the day it was made, then an underscore: `2026-10-06_homepage-directions.md`, `2026-10-08_Acme pilot - contract.pdf`. Finder, OneDrive and the hub list them in order, and the name is enough to cite and find a document (search the hub for `2026-10-06_` or part of the name).

- The date is when the document was made, not last edited: `added` in the frontmatter or `ycos:added` meta tag, else the file's creation date. It never changes when the file is edited.
- After the underscore: Library documents in kebab case starting with the project (`acme-pilot-week-four-report`), Assets as readable names starting with the project (`Acme pilot - contract`). A sidecar `.md` has the same name as its file.
- The hub shows titles without the date, and the name without its date still works as a link (`[[homepage-directions]]`) when nothing else has that name.
- Dropped a file without a date? The build warns. `node app/datename.js` lists what it would rename; `node app/datename.js --apply` renames, rewrites `[[links]]` and `Library/…` / `Assets/…` paths in every note, and rebuilds the hub.
- Published copies keep the name they were first published under, so links already shared keep working.

### Library item

- **HTML document** (prototype, report, tool): just drop `YYYY-MM-DD_name.html` in `Library/`. Clicking it in the hub opens the page directly, with a small floating bar (Nostrion-os · ← · →) in the top-left corner to come back; `Esc` also returns to the hub. Put its details inside the file's `<head>` — no extra `.md` needed:

  ```html
  <meta name="ycos:title" content="Acme pilot — week four report">
  <meta name="ycos:category" content="research">
  <meta name="ycos:project" content="Acme pilot">
  <meta name="ycos:status" content="live">
  <meta name="ycos:added" content="2026-09-25">
  ```

  Without these tags the hub uses the page `<title>`, and a file name that starts with a project name (`acme-…`, `Nostrion - …`) is linked to that project.
- **Markdown note**: `Library/YYYY-MM-DD_name.md` with frontmatter `title`, `category`, `project`, `status`, `added`.
- `category` is free text. Known values (research · framework · brief · report · tool · reference · post · note) have a fixed colour and order; any new value is picked up automatically, gets its own colour and is shown by default in every filter.
- Categories: **research · framework · brief · report · tool · reference · post · note**. Status: `draft · live · archived`.

### Asset (`Assets/2026-10-08_Acme pilot - contract.pdf` + optional `.md` sidecar)

Drop any file in `Assets/` with the date in front. A name starting with a project name after the date (`2026-10-08_Acme pilot - contract.pdf`) is linked to that project automatically. Optional: `2026-10-08_Acme pilot - contract.md` next to it with frontmatter (`title`, `project`, `tags`) and notes.

## Publishing (sharing a document)

The vault is the only source of truth and never moves. To share a Library document, **publish** it: a copy goes to the shared folder set in `app/config.json` (OneDrive, Dropbox, Drive) (`your synced folder`), and you make the share link from there (Finder → right-click → Share → Copy Link). Copies keep the vault file name. Never edit a copy — change the vault file and publish again.

```
node app/publish.js                       status of every Library document
node app/publish.js report                publish / re-publish (name = file name, stem or title, loosely)
node app/publish.js --outdated            re-publish every copy whose vault version changed
node app/publish.js --remove report        unpublish
```

Or just say `publish the report` to Claude (`/publish`). The Library page has a **Published** column and filter: `✓ date` = the copy is the current version · `↑ outdated` = the vault file changed since it was published · `—` = not published · `?` = unknown. On every rebuild the hub compares each copy with its vault file (size + content), so the column is the real state of the folder. Every publish run also writes `app/publish-state.json` (size, hash, date of each copy); the app falls back to that when macOS does not let it read the OneDrive folder — the column is then correct as of the last publish run. To make the app read the folder live, allow **Nostrion-os** under System Settings → Privacy & Security → Files and Folders (OneDrive) when macOS asks.

**Links.** `shareBase` in `app/config.json` is the web address of the Publish folder; the hub shows a **copy link** button next to every published document (Library list and document page) and the document page has **show in Finder**. The copied link is the file's address inside your OneDrive, so it works for people who already have access to the Publish folder — share that folder once (OneDrive web or Finder → Share) with the colleagues or the organisation, after that every new copy is reachable by its link. For an *anyone with the link* link, use Finder → Share on the copy. Note: OneDrive does not open shared `.html` files in the browser — recipients download them; share a PDF export when that matters.

## Linking

`[[Name]]` links work everywhere (Obsidian and hub): `[[Lena Bakker]]`, `[[Website relaunch]]`, `[[2026-09-29]]` (a day), `[[2026-10-06_homepage-directions]]` (a library item, by file name; the hub shows it without the date).
