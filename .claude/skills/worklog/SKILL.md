---
name: worklog
description: Log what happened (a call, a work session, a thought) into the Nostrion-os vault as a log entry, propose tasks for the user to approve, link people/projects/docs, then rebuild the hub. Use for /worklog or "log this".
---

# /worklog — append entries to the Nostrion-os log

Nostrion-os is an Obsidian vault at the folder that contains this repository, worked on directly from the shell. The app is `Nostrion-os.app` in Applications and rebuilds itself when vault files change. The Markdown files are the source of truth; `app/index.html` is generated. Formats are in the vault `README.md`.

Run this any time something is done — after a call, at the end of a work session, or when the user shares a thought. Several entries per day are normal. Entries have **no clock time**, only the day.

## Hard rule: tasks need the user's approval

**Never write a task (`- [ ]` checkbox) into the vault without the user's explicit OK in this conversation.** Propose candidate tasks first (step 2), write only the ones the user approves, exactly as approved. A task the user dictates directly ("add a task: …") counts as approved. If the user doesn't answer, write the entry without tasks. This also applies to tasks I might think of myself (reminders, follow-ups for my own setup work) — propose, never add.

## 1. Read the vault

- `V="$(git rev-parse --show-toplevel)"` (or the folder you were opened in). Today = `TZ=Europe/Amsterdam date +%F` (or the day the user names). Read that day's file if it exists: `cat "$V/Log/$D.md"` — never duplicate an entry that is already there; update it instead. A session that spans several days gets its entries in each day's file.
- Read `ls "$V/People" "$V/Projects" "$V/Library"` so names can be linked exactly, and `grep -h '^parent:\|^name:' "$V"/Projects/*.md` to know the project tree.
- Edit the files in place (they may have been edited in Obsidian); never overwrite a vault file from an older copy.

## 2. Collect what to log

Sources, in order: what the user says in the message; everything done in **this chat session** (files built, research, decisions, calls the user described); anything the user pastes. Only the current session is visible — do not claim to know other sessions.

One entry per distinct activity. Each entry needs: **title** (short, specific: "Intro call with Mo Jansen"), **project** (most specific one: a subproject if it fits, e.g. `[[Website relaunch]]` under `[[NostrionOS]]`; general Nostrion work → `[[Nostrion]]`; client work → its client project; work on the vault/hub itself → `[[Nostrion-the user]]`), **category** (one of `meeting · build · research · writing · admin · learning`), **hours** (decimal: 40 min → 0.7), **people**, **notes**.

**People detection:** every person named in the input is a person — the one the user met, and anyone mentioned in passing ("she works with Lena"). Match misspellings to existing pages ("Visser" → Sam Visser). Each gets `[[Name]]` in `people::` (if they took part) or in the notes (if only mentioned), and a page in `People/` if none exists. Pick up role, organization, LinkedIn URL and relationship from the text. Relationship categories: **colleague · client · external stakeholder · friend · family** (default `colleague` for Nostrion people; otherwise ask).

**Task candidates:** anything that still has to happen is a *candidate* task — "next", "tomorrow", "he will send", "we will brainstorm", "follow up", a decision still to make. For each candidate prepare:
- `priority` — Eisenhower: **do** (urgent · important), **plan** (important · not urgent), **delegate** (urgent · not important), **later** (neither). Use what the user says ("not urgent but important" → plan); a dated next step within ~2 days → do.
- `due` — only when a day is named or implied ("tomorrow" → tomorrow's date).
- `waiting` — when someone else has to deliver first ("Sam will gather the data" → `(waiting:: [[Sam Visser]])`).

**Ask once:** in a single AskUserQuestion, combine (a) the task candidates — one multiSelect question listing each as `text · priority · due/waiting`, so the user ticks the ones to add (the user can correct text/priority via "Other") — and (b) any missing hours / project / category, with sensible guesses as options. Never invent hours — if the user doesn't answer, leave `hours:: ` empty and add no tasks. Work I did for the user in the session usually costs the user little time: offer small numbers (0.3 / 0.5 / 1).

Closing tasks is different: if the user says an earlier task is done, find it (`grep -rn '\- \[ \]' "$V/Log" "$V/Projects"`) and change `[ ]` to `[x]` in its original file and append `(done:: YYYY-MM-DD)` with today's date (the user's statement is the approval; the hub would otherwise stamp the date a minute later). Don't create a duplicate. Removing a task: delete its line only when the user asks.

## 3. Writing style of the notes — less is more

- **Written by me (from the session or a one-line remark):** at most **2 sentences**, or a short bullet list / table instead. No paragraphs. Example: `Built v1 of the vault + hub.`
- **Written from the user's own note or thoughts:** simplify and clean it up so it reads fast; it may be longer than 2 sentences, but stay in bullets (`- `), one idea per line, no filler, no paragraphs. Keep the user's wording where it is already clear; keep decisions, drop repetition.
- Structure: `- Decided:` / `- Open:` bullets for context, then approved task checkboxes last. Don't write `- Next:` bullets — a next step is either an approved task or stays out. Bold only the key item.
- Links inline as `[[Name]]`; no headings inside an entry.

## 4. Write

Append to `$V/Log/YYYY-MM-DD.md`. If the file does not exist, create it with:

```
---
date: YYYY-MM-DD
---
```

Entry format (exact — the hub parses it; the heading is the title only, no time):

```

## Workshop with the design agency
project:: [[Website relaunch]]
category:: meeting
hours:: 0.5
people:: [[Sam Visser]]

- Agreed on three homepage directions.
- [ ] Quote on illustrations from Sam (waiting:: [[Sam Visser]]) (priority:: plan)
```

(Checkbox lines only for tasks the user approved.) Task syntax: `- [ ] text (priority:: do|plan|delegate|later) (due:: YYYY-MM-DD) (waiting:: [[Name]]) (people:: [[Name]])` — all fields optional; don't write `added::` / `done::` on new tasks, the build stamps them (`added` = the log's date); the task inherits the entry's project unless `(project:: [[X]])` is given. Status: `[ ]` open · `[/]` in progress · `[x]` done · `[-]` cancelled.

Leave a field empty rather than guessing (`people:: `). Write with a quoted heredoc (`cat >> "$V/Log/$D.md" <<'EOF' … EOF`) so nothing is re-typed from truncated output.

## 5. Keep the graph complete

- New person → create `People/<Full Name>.md`:
  ```
  ---
  name: <Full Name>
  role: <role or empty>
  organization: <org or empty>
  relationship: <colleague | client | external stakeholder | friend | family>
  linkedin: <URL if given, else omit the line>
  projects: ["[[Project]]"]
  ---
  - <one or two bullets: what to remember about them>
  ```
  Ask for role/organization only if unknown and it matters, in the same question as step 2.
- New project mentioned → create `Projects/<Name>.md` with `name`, `description` (one line), `category` (client · product · internal · personal — who the work is for), `status: active`, `parent: "[[Parent]]"` if it belongs under a bigger project (e.g. a subproject of Website relaunch), `started: <first logged day>`, `people: [...]`. If an entry predates a project's `started`, move `started` back to that day.
- An HTML document produced this session or pointed to by the user (prototype, report, brief, tool) → copy it into `Library/` as `<slug>.html` (slug starting with the project, e.g. `acme-pilot-week-four-report.html`). **No `.md` sidecar.** Put its details as meta tags just before `</head>` (python read-modify-write, don't retype the file):
  ```html
  <meta name="ycos:title" content="Acme pilot — week four report">
  <meta name="ycos:category" content="research">
  <meta name="ycos:project" content="Acme pilot">
  <meta name="ycos:status" content="live">
  <meta name="ycos:added" content="2026-09-25">
  ```
  Categories: research · framework · brief · report · tool · reference · post · note, or a new one when none fits (the hub picks any value up automatically; prefer an existing one). Status: live · draft · archived (an old version the user wants to keep → archived, in `Library/`, never in `Assets/` — the builder rejects HTML there). Clicking it in the hub opens the page directly. Link it from the entry with `[[<slug>]]`. Sharing it with others is a separate step: the `publish` skill (`node app/publish.js <slug>`) — only when the user asks.
- A written note (no HTML) → `Library/<slug>.md` with frontmatter `title`, `category`, `project`, `status`, `added`.
- Any other file worth keeping (pdf, xlsx, image) → `Assets/`, named `<Project> - <what it is>.<ext>` so it links to the project automatically; add an `Assets/<name>.md` sidecar only if it needs notes.

## 6. Rebuild and report

`cd "$V" && node app/build.js`. The app picks up changes itself within a few seconds.

Reply with one table: title · project · category · hours · people. Then one line per task added (approved) or closed (text · priority · due/waiting), and one line per page created (person/project/library). Nothing else.
