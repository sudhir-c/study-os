---
name: study-os
description: Conventions for the study-os vault — where class notes, topics, schedules, and the event log live, how frontmatter is encoded, and how to record events. Load this before reading or writing anything under vault/.
---

# study-os vault conventions

This is the shared contract. Every command and subagent in this project reads and
writes the vault through these rules. If you are about to touch anything under
`vault/`, follow what is here rather than inventing a layout.

## Layout

```
vault/
├── classes/<class-id>/          # e.g. 15-122, 21-241
│   ├── class.md                 # long-term memory for the class
│   ├── schedule.md              # parsed syllabus: dates, exams, weights
│   ├── topics/<topic-slug>.md   # one per topic, mastery in frontmatter
│   ├── notes/YYYY-MM-DD-<slug>.md
│   ├── sources/                 # original PDFs/images, never edited
│   └── exams/                   # practice tests + postmortems
└── log/
    ├── events.jsonl             # append-only source of truth
    └── daily/YYYY-MM-DD.md      # daily plan + reflection
```

`<class-id>` is the course number as the school writes it (`15-122`), lowercased
and hyphenated if it isn't already. Topic slugs are lowercase-hyphenated
(`loop-invariants`, `big-o-analysis`).

## The two-tier rule

`vault/log/events.jsonl` is the **source of truth**. Everything else — topic
mastery numbers, class stats, dashboards — is a **derived cache** that must be
reconstructible from the log alone.

Consequences you must respect:

- Any fact about *performance* (a quiz result, a session, an exam score) gets
  written as an event **first**. Updating a topic file without logging an event
  creates state that `studyos rebuild` will silently erase.
- Never edit or delete a line in `events.jsonl`. It is append-only.
- Topic frontmatter numbers are caches. It is fine to recompute them.

## Frontmatter encoding

Frontmatter is **not full YAML**. It is a restricted subset that `lib/vault.js`
parses by trying `JSON.parse` on each value and falling back to a raw string.
When you write frontmatter by hand:

- Arrays must be **inline JSON**: `confusions: ["mixes up X with Y"]`
  — not YAML block lists. (Block lists are tolerated on read, but always
  re-serialized as JSON, so don't rely on them.)
- Strings containing `:`, `#`, or leading/trailing spaces must be JSON-quoted.
- Plain identifiers, dates, and numbers can be bare: `class: 15-122`,
  `next_review: 2026-09-17`, `mastery: 3`.
- `# comment` at the end of a line is stripped (but not inside quotes or arrays).

Prefer going through `lib/vault.js` (`readDoc`, `writeDoc`, `patchDoc`) over
hand-writing files when you are already running Node.

## Accumulate, don't overwrite

`class.md` and `topics/*.md` are long-lived memory that grows all semester.
When you learn something new about a class or topic, **append to or merge into**
the existing file. Read it first. Never clobber a file that already has content
unless you are explicitly told to replace it.

`patchDoc(file, patch)` in `lib/vault.js` merges frontmatter keys while leaving
the body untouched — use it for mechanical updates.

## Topic files

```markdown
---
class: 15-122
topic: loop-invariants
mastery: 2
attempts: 7
last_reviewed: 2026-09-14
next_review: 2026-09-17
confusions: ["mixes up loop invariant with postcondition"]
sources: ["notes/2026-09-09-lecture-04.md"]
---

## Summary

## Key results

## Worked examples

## Where I go wrong
```

`mastery` is 0–5:

| | |
|---|---|
| 0 | seen it, can't use it |
| 1 | recognizes it, needs the notes open |
| 2 | can do routine cases with hints |
| 3 | reliable on routine cases unaided |
| 4 | handles novel, multi-step applications |
| 5 | can derive it and explain why it works |

## Events

Append with the helper — it validates the type and guarantees a well-formed line:

```bash
node lib/log-event.js '{"type":"quiz","class":"15-122","topic":"loop-invariants","asked":8,"correct":5,"missed":["loop invariant at exit","termination metric"]}'
```

Types and their conventional fields (`ts` is added automatically):

| type | fields |
|---|---|
| `ingest` | `class`, `source` (original filename), `note` (written path), `topics[]`, `pages`, `confidence` |
| `quiz` | `class`, `topic`, `asked`, `correct`, `missed[]` |
| `session` | `class`, `topic`, `minutes`, `what`, `stuck[]` |
| `exam` | `class`, `exam`, `kind`, `topic`, `asked`, `correct`, `missed[]`, optional `points_earned`/`points_possible` |
| `plan` | `class`, `horizon`, `items[]` |
| `reflect` | `class`, `note` |

**`missed[]` carries concepts, not question numbers.** `"termination metric"` is
useful to the analyst and the planner; `"Q3b"` is not.

### Exam events: one per topic, in question counts

An `exam` event is shaped **exactly like a quiz event** — singular `topic` plus
`asked`/`correct` — with exam metadata alongside. Emit one event per topic, all
sharing the same `exam` and `ts` so they group into one sitting:

```bash
node lib/log-event.js '[
  {"type":"exam","class":"15-122","exam":"exams/midterm-1","kind":"real","ts":"2026-10-02T00:00:00Z","topic":"loop-invariants","asked":6,"correct":3.5,"points_earned":7,"points_possible":12,"missed":["..."]},
  {"type":"exam","class":"15-122","exam":"exams/midterm-1","kind":"real","ts":"2026-10-02T00:00:00Z","topic":"big-o-analysis","asked":4,"correct":4,"missed":[]}
]'
```

Three rules, each of which was a real bug before it was written down:

- **`topic` is singular and required.** Mastery only counts events carrying a
  `topic`; an event with a `topics[]` array reaches nothing and the exam result
  is silently discarded.
- **`asked`/`correct` are question counts, never points.** Mastery treats
  `asked` as a confidence signal, so a 50-point exam logged as `asked: 50` would
  push a topic to the top confidence tier off one sitting. Points belong in
  `points_earned`/`points_possible`, which never feed mastery. `correct` may be
  fractional for partial credit.
- **`kind` is `"real"` or `"practice"`.** Calibration reports the two as
  separate series and never pools them — a self-graded practice test is not
  evidence about a real exam. An event with no `kind` is treated as practice.

**Paths in events are class-relative** — the event already carries `class`, so
write `"note":"notes/2026-09-09-loop-invariants.md"`, never
`"vault/classes/15-122/notes/..."`. The same applies to `source` and any other
path field, and it matches the `source:` field in note frontmatter. Mixed
conventions in an append-only log can't be cleaned up later, so get this right
on the way in.

## Worksheets

A worksheet is a generated PDF answered by hand on an iPad and graded from an
image of the handwriting. Two artefacts, deliberately in different places:

```
<synced folder>/<slug>.pdf                      the PDF the iPad sees
vault/classes/<id>/worksheets/<slug>.json       the manifest (stays local)
```

The synced folder is iCloud Drive › StudyOS › worksheets by default, or whatever
`STUDYOS_SHEET_DIR` points at. Only the PDF leaves the machine; the manifest —
which contains the expected answers — never syncs.

**Two invariants, both load-bearing:**

- **One question per page, and no cover page**, so page N is always question N.
  Grading addresses pages by number; an extra leading page silently mis-grades
  everything after it.
- **The manifest is the source of truth for intent.** It records each page's
  topic, question, and what a correct answer contains, so grading never has to
  re-derive the question from a photograph of it.

Always go through `lib/sheet.js` (`buildManifest`, `writeManifest`,
`writeSheetPdf`) rather than assembling paths or PDFs by hand — the invariants
above are enforced there.

To read a page, rasterise it with `lib/pdfpage.js` and look at the image.
Handwriting lives in PDF *annotations*, and rendering to pixels is what
guarantees it's visible. `inkFraction()` distinguishes an unanswered page
(≈0.002–0.008, just the printed question) from an attempted one, so a blank page
is reported as not attempted rather than graded wrong.

Grading a worksheet logs ordinary `quiz` events per topic. Skipped, blank, and
unreadable pages are **excluded from `asked`** — they are not evidence either
way, and counting them as wrong would fabricate a weakness.

## Style for note files

Transcribed notes are faithful records, not summaries. Preserve the original
structure, notation, and worked examples. Math goes in LaTeX (`$...$`,
`$$...$$`), code in fenced blocks with a language tag. Describe diagrams in a
short italic caption rather than dropping them.

Mark anything you could not read confidently as `<!-- ?? original unclear -->`
inline. A flagged gap is recoverable; a confident guess is not.
