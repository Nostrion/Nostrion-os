# Nostrion-os

This folder is an Obsidian vault and the single source of truth. The hub (`app/index.html`) is generated from it with `node app/build.js`; never edit `app/index.html` by hand.

- Formats for log entries, people, projects, library items and assets: `README.md` (section "Formats"). Follow them exactly, the hub parses them.
- Logging work: the `worklog` skill in `.claude/skills/worklog`. Weekly check: `weekly-review`.
- Tasks are checkboxes inside log entries. Never add a task without the user's explicit approval in the conversation.
- After changing vault files, rebuild: `node app/build.js` (the Mac app rebuilds by itself).
- Setting up on a new machine: `INSTALL.md`.
