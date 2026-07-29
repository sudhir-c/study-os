# study-os

A command-line study system: persistent per-class memory, automatic note
ingestion from iPad/paper, and a Claude Code harness that quizzes you, finds
patterns in your mistakes, and plans your week.

The vault is the product. The code is thin glue that moves files into it, keeps
derived state honest, and decides when Claude runs.

## Install

```bash
npm link          # puts `studyos` on your PATH
studyos doctor    # check the install
```

## Use

```bash
studyos class add 15-122 --title "Imperative Computation" --syllabus ~/syllabus.pdf
studyos pull notes             # typed Apple Notes → inbox/
studyos pull folder ~/GoodNotes --recursive
studyos ingest                 # transcribe + file everything in inbox/
studyos quiz 15-122 --topic loop-invariants -n 8
studyos prep 15-122 --exam ~/practice-midterm.pdf
studyos plan today             # "3 hrs tonight, midterm Friday"
studyos log "2hr on graphs, stuck on the Dijkstra proof"
studyos review                 # analyst pass over your history
studyos status
studyos                        # interactive session over the whole vault
```

Background automation is **opt-in** and spends tokens unattended:

```bash
studyos automation enable          # watcher on inbox/ + nightly review at 23:00
studyos automation enable --at 22:30
studyos automation status
studyos automation disable
```

## How notes get in

Everything downstream depends on one rule:

> Any PDF, image, or text file dropped in `inbox/` gets transcribed,
> classified to a class and topic, and filed into the vault.

Adding a new source next year means writing one adapter that drops files in
`inbox/`. Nothing downstream changes.

- **Paper** — photograph it, drop the image in `inbox/`.
- **iPad, typed** — the Apple Notes adapter (Phase 3) pulls note bodies via
  AppleScript.
- **iPad, handwritten** — Apple Notes drawings are *not* reachable via
  AppleScript. Share → Export as PDF into `inbox/` (an iOS Shortcut can
  automate this). This is also the path GoodNotes/Notability would use.

Transcription uses Claude's native reading of the PDF/image. `tesseract` is
installed but deliberately unused — it is unreliable on handwriting and mixed
notation.

## Layout

```
bin/studyos             CLI entry point
bin/studyos-watch       launchd target: debounced inbox watcher
lib/vault.js            frontmatter + path conventions
lib/events.js           append-only event log
lib/mastery.js          mastery derivation + spaced-repetition scheduling
lib/automation.js       launchd plist generation
lib/adapters/           apple-notes.js, folder.js
.claude/skills/         study-os conventions (the shared contract)
.claude/agents/         transcriber, quizmaster, planner, analyst
.claude/commands/       /ingest /class /quiz /prep /plan /log /review
inbox/                  drop zone
vault/classes/<id>/     class.md, schedule.md, topics/, notes/, sources/, exams/
vault/log/events.jsonl  source of truth
```

## The two-tier rule

`vault/log/events.jsonl` is append-only and authoritative. Topic mastery, class
stats, and dashboards are **derived caches** rebuildable from it via
`studyos rebuild`. Anything about performance gets logged as an event first —
state written without an event is state that `rebuild` will erase.

One caveat worth knowing: rebuild reconstructs topic *frontmatter* (mastery,
attempts, review dates, confusions). Topic *bodies* come from your notes and are
not reconstructible from the log; a recreated topic file is a stub listing the
source notes to refill it from.

See `.claude/skills/study-os/SKILL.md` for the full contract.

## How mastery is earned

Mastery is 0–5, derived from quiz performance — never self-asserted. Two
independent caps keep it honest:

- **Volume** — you can't show mastery on 2 questions.
- **Persistence** — you can't show *durable* mastery in one sitting, however
  many questions. A perfect 20-question day caps at 3; reaching 5 needs three
  separate sittings.

Recent attempts are weighted more heavily than old ones, and scoring under half
resets the review interval to tomorrow regardless of accumulated mastery.

## Status

Phases 1–4 are built and verified end-to-end: vault, CLI, ingestion, quizzing,
mastery scheduling, exam prep, launchd automation, source adapters, and the
analyst.

Not yet exercised against real data: the interactive quiz loop and the live
Apple Notes sync (which needs a one-time macOS Automation permission grant).

```bash
npm test    # 58 tests
```
