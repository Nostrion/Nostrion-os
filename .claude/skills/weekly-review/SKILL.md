---
name: weekly-review
description: Friday review of the Nostrion-os vault. Check every workday Mon-Fri has log entries with hours, fill gaps with the user, summarize the week, rebuild the hub. Use for /weekly-review or "weekly review".
---

# /weekly-review — is everything logged and tracked?

Nostrion-os vault: the folder that contains this repository, worked on directly from the shell; `V="$(git rev-parse --show-toplevel)"` (or the folder you were opened in). Log format and folders are described in the vault `README.md`; the `worklog` skill describes how entries are written — reuse that format and writing style exactly (no clock times, bullets, max 2 sentences when written by me).

## 1. Scope

- Week = Monday–Friday containing today (Europe/Amsterdam). If run on Saturday/Sunday, review the week that just ended. If the user names a week ("W39", "last week"), use that.

## 2. Audit (read-only)

For each weekday, read `Log/YYYY-MM-DD.md` (if present) and, with a short python or grep, collect per day: number of entries, total `hours::`, entries with **missing hours / project / category** (skip `## Tasks` entries: they only hold tasks added from the hub), people linked. Also list `Library/` and `Assets/` files added this week (`find -newermt`), and People/Project pages referenced in entries that do not exist as files. Also list open tasks that are overdue (`due::` before today) — they belong in the next-week bullets — and tasks closed this week (`done::` in this week's dates).

Present one compact table:

| Day | Entries | Hours | Gaps |
|---|---|---|---|
| Mon 22 | 3 | 6.5 | — |
| Tue 23 | 0 | 0 | **no log** |
| Wed 24 | 2 | 3 | 1 entry without hours |

Below it: hours by project, hours by category, people contacted, projects touched, documents added. Bold the gaps.

## 3. Fill gaps with the user

Ask in ONE AskUserQuestion (or one short message if there are many gaps): for each empty day "what happened on <day>?" and for each incomplete entry the missing field, offering guesses as options (e.g. hours 1 / 2 / 4, likely project). Also ask whether any session or call this week is not in the log at all. Do not fabricate hours.

Write the answers as proper entries (same format and rules as `worklog`, including creating missing People/Project pages). Use the day's file, not Friday's. Idle days the user confirms ("day off", "sick", "holiday") get a single entry `## Day off` with `category:: admin`, `hours:: 0` and no project, so the week reads as complete.

## 4. Record the review

Append to Friday's log (or the day the review runs):

```

## Weekly review W<nn>
category:: admin
hours:: 0.25

- **<total>h** — <project A> <x>h · <project B> <y>h · …
- By category: meeting <a>h · build <b>h · …
- People: [[…]], [[…]]
- Added: [[doc-slug]], …
- Next week: <1–3 short bullets the user gives, or the open next steps found in this week's entries>
```

## 5. Rebuild and report

`cd "$V" && node app/build.js`. Reply with the final table (after gaps are filled), the three totals (hours, entries, people), and the open next steps. Under 15 lines, no prose recap.
