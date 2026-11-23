# Gantt Planner (Obsidian plugin)

The planner from `gantt_obsidian.html`, running inside Obsidian. The plan is a JSON
file in your vault, so git syncs it along with your notes. It works the same in any
browser-free setup: no folder picker, no local server, no vault name.

## Install

1. Copy `main.js`, `manifest.json` and `styles.css` from this repository into
   `<your vault>/.obsidian/plugins/gantt-planner/` (create the folder if needed).
2. In Obsidian: **Settings → Community plugins**, turn off Restricted mode if it's on,
   then enable **Gantt Planner** (press the reload button next to "Installed plugins"
   if it isn't listed yet).
3. Open it from the calendar icon in the left ribbon, or the command palette:
   **Gantt Planner: Open Gantt planner**.

If your `.obsidian` folder is committed, the plugin travels to your other machines too.

## Bringing your existing plan across

Your current plan lives in Safari's storage for `gantt_obsidian.html` / `gantt.html`.
Open that page in Safari, click **Save file**, then either

- move the downloaded JSON into the vault root and rename it `gantt-plan.json`, or
- click **Import** in the plugin and pick the downloaded JSON (or a CSV export).

Older plans with separate "full names" are migrated into notes on load, as before.

## What it does

- **Timeline, Tech tree, Editor, Gantt export** and the **Responsible** filter work as in
  the HTML version.
- **Saving:** every change is written to `gantt-plan.json` (no timestamp, so git only
  sees real changes).
- **Git pulls:** when the plan file changes in the vault, the planner reloads it. If it
  changes while you're mid-edit, you choose which version wins. A file with merge
  conflict markers is never overwritten; edits wait until it's fixed.
- **Notes:** click a task to open its note in a new tab. Double-click a task without a
  note (or whose note was deleted) to create `04-tasks/<label>.md` with frontmatter.
  Renaming or moving a note in Obsidian updates the task's link.
- **Linking notes:** the editor's Obsidian note field autocompletes vault notes as you
  type (tasks folder first; notes already linked to another task are marked). When a task
  has no note and a note's name contains every word of the task's label, a
  "Matching note … Link" hint offers it.
- **Frontmatter sync:** `title, type, status, priority, parent (phase), section, start,
  deadline, percent_complete, owner, gantt_id` and the owner tag are rewritten whenever
  the task changes. Other keys, other tags and the note body are left alone. The sync
  is one way: edits to these keys in Obsidian are overwritten on the next change.
- **Deadlines:** each task or milestone can have an optional deadline (editor field,
  shown in the hover panel and the CSV). It's saved in the plan only and doesn't move
  anything yet. Note: in task notes, `deadline:` is still the task's end date.
- **Exports:** CSV, OpenProject CSV and the Gantt export's **Save HTML** are written
  next to the plan file.
- Colours follow Obsidian's light/dark mode.

## Sections, phases and tasks

The plan is a three-level tree: a **section** contains **phases**, and a phase contains
**tasks** (and milestones). Every task belongs to a phase. A phase has no dates of its
own: its bar runs from its earliest task start to its latest task end, and follows along
as you move tasks. The tech tree ignores phases.

- **Editor:** phases are collapsible rows under each section, all collapsed when the
  planner opens; selecting or adding a task opens its phase. The + on a section adds a
  phase; the + and ◆ on a phase add a task or milestone. Right-click a section or phase
  to rename it or delete it (when empty).
- **Timeline and Gantt export:** the **Phases only** switch toggles between showing
  phases with their tasks and showing just the phases.
- **Tech tree:** the **Sort** menu orders each column top to bottom by section, by
  priority (high first, earlier end date breaks ties) or by end date (deadline).
  Finished tasks don't block anything: the **Done** switch shows them in their own
  column on the left (off by default).

## Tasks folder

Every note in the tasks folder (setting below, default `04-tasks`) whose frontmatter is in
this format becomes a task in the plan — including notes you write by hand or that arrive
with a git pull. Notes in any other shape are ignored.

```yaml
title: Steady-state discharge coefficient   # required
type: task                                  # required: task or milestone
status: Doing                               # required: To do, Doing or Done
parent: Rig build                           # required: the phase (created if new)
section: Experimental Work                   # required: the section (created if new)
start: 2026-11-02                           # required for tasks, YYYY-MM-DD
deadline: 2026-11-16                        # required, YYYY-MM-DD, not before start
priority: High                              # optional: Low, Normal (default) or High
owner: Tom                                  # optional
gantt_id: t12                               # optional; filled in by the planner
```

Other keys, tags and the note body are kept. Once a note is in the plan, the plan is
the source of truth for these keys. Deleting a task in the editor moves its note in the
tasks folder to the trash, otherwise it would be picked up again.

There is no sample plan any more: with no plan file and no task notes, the planner starts
empty, and the first section ("General") is created when you add a task.

## Settings

- **Plan file** — vault path of the JSON (default `gantt-plan.json`).
- **Tasks folder** — notes here in the format above become tasks; new task notes are created here (default `04-tasks`).

## Not yet verified

Built and tested against a mock of Obsidian's API, not Obsidian itself. Worth checking
first: Print / PDF from the Gantt export tab, and use on Obsidian mobile.
