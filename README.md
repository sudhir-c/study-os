# study-os

A command-line study system: persistent per-class memory, automatic note
ingestion from iPad/paper, and a Claude Code harness that quizzes you, finds
patterns in your mistakes, and plans your week.

The vault is the product. The code is thin glue that moves files into it, keeps
derived state honest, and decides when Claude runs.

## Install

```bash
npm link                # puts `studyos` on your PATH
studyos theme install   # optional: StudyOS Terminal.app profile
studyos doctor          # check the install
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
studyos sheet new 15-122       # worksheet → iPad, answer with the Pencil
studyos sheet live 15-122      # grade handwriting question-by-question
studyos grade 15-122           # record a real exam result
studyos calibrate              # did mastery predict your scores?
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
bin/statusline          StudyOS status bar (reads the vault, not the session)
bin/studyos-sheet       live handwriting grading loop
bin/studyos-watch       launchd target: debounced inbox watcher
lib/vault.js            frontmatter + path conventions
lib/events.js           append-only event log
lib/mastery.js          mastery derivation + spaced-repetition scheduling
lib/dashboard.js        shared snapshot behind `status` and the status line
lib/calibration.js      predicted mastery vs actual exam performance
lib/sheet.js            worksheets, manifests, iCloud settle-wait
lib/pdfpage.js          per-page rasterisation with annotations rendered
lib/terminal.js         Terminal.app profile switching
lib/automation.js       launchd plist generation
lib/adapters/           apple-notes.js, folder.js
.claude/skills/         study-os conventions (the shared contract)
.claude/agents/         transcriber, quizmaster, planner, analyst
.claude/commands/       /ingest /class /quiz /sheet /grade-sheet /prep /grade /plan /log /review
inbox/                  drop zone (contents gitignored)
vault/                  your notes and study log — gitignored, never pushed
```

## Appearance

`studyos` doesn't look like Claude Code. Three things change, and all of them
apply **only** to `studyos` — running plain `claude` in this repo gives you
ordinary Claude Code, because developing the tool and using it want opposite UI.

- **Status line** — replaced with study state rather than session state:

  ```
  15-122 · loop-invariants ███░░ 3/5   ▲ Midterm in 4d
  1 due · 2 never tested · inbox: 3 waiting · 73% acc
  ```

  Set `STUDYOS_STATUSLINE=compact` for a one-line version, or `NO_COLOR=1` for
  plain text.

- **Terminal profile** — `studyos theme install` creates a StudyOS profile for
  Terminal.app; sessions switch to it on launch and restore your previous
  profile on exit. Apple Terminal only; silently skipped elsewhere. If a session
  is `kill -9`'d the restore is skipped, so `studyos theme restore` recovers it.

  The colours are **randomised per launch** from eight curated dark palettes —
  indigo, forest, plum, teal, oxblood, navy, espresso, slate. `studyos theme list`
  shows swatches. The same palette never comes up twice in a row, and every one
  clears WCAG AAA contrast (text 13.8–14.3:1, accent 7.4–11.4:1), enforced by a
  test. Pin one with `STUDYOS_THEME=teal studyos`. Only the StudyOS profile is
  ever restyled — your stock profiles are left alone.

- **Banner and session name** — an ASCII wordmark with live study state, and the
  session is named `StudyOS`, which also retitles the terminal window. Launching
  clears the viewport first (scrollback is preserved) so the wordmark opens a
  clean window.

  **Claude Code's own startup box can't be hidden** — there is no banner,
  welcome, splash, or logo setting to suppress it. It appears once after the
  StudyOS banner and scrolls away as you work.

The separation is enforced by keeping the chrome in `.claude/studyos.settings.json`,
loaded via `--settings` by the binary and never picked up automatically.

Print-mode commands (`ingest`, `review`, `log`) emit **no** banner, colour, or
status line — the watcher and nightly job parse that output.

## Privacy

`vault/` and the contents of `inbox/` are gitignored. Class notes, lecture
sources, grades, instructor names, and the full study log stay on your machine.
`ensureVault()` recreates the directory skeleton on every run, so a fresh clone
works with nothing missing.

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

## Handwritten worksheets — never upload anything

Proofs and derivations belong on paper, not a keyboard. So StudyOS generates a
worksheet, it appears on the iPad, and the grader reads your actual handwriting
out of the synced file.

```bash
studyos sheet new 15-122 -n 6     # writes a PDF into iCloud Drive › StudyOS › worksheets
# open it in Files on the iPad, answer with the Pencil
studyos sheet live 15-122          # grade question-by-question as you finish each one
studyos sheet grade 15-122         # or grade the whole sheet at the end
studyos sheet where                # find the folder
```

**One question per page, no cover page** — so page N is always question N.
Grading addresses pages by number, and this removes answer-region coordinates,
crop maths, and layout parsing from the problem entirely.

**How the ink is read.** Handwriting lives in PDF *annotations*, not page
content, so pages are rasterised with `gs -dShowAnnots` before the grader looks
at them. Measured on a real `/Ink` annotation: 0.0271 ink coverage with
annotations rendered vs 0.0020 with them suppressed — a 13.5× difference, locked
in by a regression test. Without that, every answer would be graded as a blank
page.

**Blank vs wrong vs unreadable are three different outcomes.** A freshly
generated page reads ≈0.002–0.008 ink, so an unanswered page is reported *not
attempted* and logs nothing. Illegible work is reported `UNREADABLE`, never
graded as incorrect. And because reading handwritten mathematics is error-prone,
**anything below high confidence asks you before it logs** — a confidently wrong
grade would corrupt both mastery and the calibration baseline that checks it.

Skipped, blank, and unreadable pages are excluded from `asked`, so they can't
fabricate a weakness.

Live mode is rendered entirely by StudyOS over headless Claude Code
(`--input-format stream-json`), so none of Claude Code's own chrome appears.

Prefer GoodNotes? Point `STUDYOS_SHEET_DIR` at its Dropbox/Drive auto-backup
folder. That path is **batch-only** — auto-backup exports whole notebooks with
minutes of latency, which live grading can't use.

## Calibration — does mastery actually predict anything?

Every other number leans on the mastery estimator, so it gets checked against
ground truth. Record a real exam with `studyos grade <class>`, then:

```
studyos calibrate

15-122 · calibration

  Real exams  (1 exam, 6 topic results)

    predicted    actual    n
    4 (~80%)        54%    3   overconfident by 26pts
    3 (~60%)        31%    2   (too few to read)

    Overall bias: -29pts (overconfident)

    Examined but never tested beforehand:
      recursion                scored 25%
```

Three properties worth knowing:

- **The prediction is time-bounded.** Predicted mastery is recomputed as it
  stood *strictly before* each exam. Including the exam would make the estimator
  look perfectly calibrated by construction.
- **Expected accuracy is not invented.** Mastery is `round(accuracy × 5)`, so
  the expected value is just `mastery / 5`. Nothing to argue with.
- **Small-n honesty is enforced in `lib/calibration.js`, not in the renderer.**
  No headline bias below 5 topic results, no per-level verdict below 3, and real
  and practice exams are never pooled — a self-graded practice test is not
  evidence about a real exam.

It is **report-only**. Mastery stays a pure function of the event log; a handful
of exam results is nowhere near enough to start bending the estimator.

## Status

Phases 1–4 are built and verified end-to-end: vault, CLI, ingestion, quizzing,
mastery scheduling, exam prep, launchd automation, source adapters, and the
analyst.

Not yet exercised against real data: the interactive quiz loop and the live
Apple Notes sync (which needs a one-time macOS Automation permission grant).

```bash
npm test    # 127 tests
```
