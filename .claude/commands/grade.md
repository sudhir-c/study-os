---
description: Record a real exam result, mapped to topics, so mastery can be calibrated
argument-hint: <class> [--exam "Midterm 1"] [--date YYYY-MM-DD]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

Record the result of an exam you actually sat.

Arguments: $ARGUMENTS

Read `.claude/skills/study-os/SKILL.md` first for the event schema.

This is the highest-value data the system ever receives. Quiz results are
self-generated; a real graded exam is external ground truth, and it's the only
thing that can tell you whether the `mastery` numbers mean anything. Treat the
numbers the user gives you as authoritative — do not round, re-grade, or
"correct" them.

## Steps

### 1. Resolve the class and exam

`./bin/studyos class list` resolves partial names. Ask for the exam's name and
the date it was taken if not given. **The date matters**: calibration compares
mastery as it stood *before* that timestamp, so a wrong date silently corrupts
the measurement. If they sat it last Tuesday, use last Tuesday, not today.

### 2. Get the breakdown, per topic

You need, for each topic the exam covered:

- **questions asked** on that topic
- **questions correct** — fractional is fine for partial credit (`3.5` of 6)

Ask for whatever form they have it in — a returned scoresheet, a Gradescope
breakdown, a photo of the front page. `Read` handles images and PDFs directly.

**Map questions to topics using existing vault slugs.** Read
`vault/classes/<id>/topics/` first and reuse those names. A near-duplicate slug
(`invariants` vs `loop-invariants`) splits the mastery record and makes the
calibration comparison miss entirely, because the predicted value is looked up
by slug.

If a question spans two topics, assign it to the one it primarily tests rather
than double-counting — the totals should reconcile with the real exam.

### 3. Confirm before writing

Show the mapping as a table and have them confirm:

| Topic | Questions | Correct | Points |
|---|---|---|---|
| loop-invariants | 6 | 3.5 | 7/12 |

This is the one place where a misread number permanently pollutes an
append-only log, so it's worth the extra turn.

### 4. Log one event per topic

```bash
node lib/log-event.js '[
  {"type":"exam","class":"15-122","exam":"exams/midterm-1","kind":"real","ts":"2026-10-02T00:00:00Z","topic":"loop-invariants","asked":6,"correct":3.5,"points_earned":7,"points_possible":12,"missed":["forgets metric must be bounded below"]},
  {"type":"exam","class":"15-122","exam":"exams/midterm-1","kind":"real","ts":"2026-10-02T00:00:00Z","topic":"big-o-analysis","asked":4,"correct":4,"points_earned":8,"points_possible":8,"missed":[]}
]'
```

Rules that matter:

- **`kind` must be `"real"`.** It keeps this out of the practice series, which
  is weaker evidence and must never be pooled with it.
- **`asked`/`correct` are question counts, never points.** Mastery uses `asked`
  as a confidence signal — a 50-point exam logged as `asked: 50` would vault a
  topic to the top confidence tier off a single sitting. Points go in
  `points_earned`/`points_possible`, which never touch mastery.
- **`ts` is the exam date**, not now.
- Every event in the batch shares the same `exam` and `ts` — that's what groups
  them into one sitting.

### 5. Rebuild and report

Run `./bin/studyos rebuild <class>`, then `./bin/studyos calibrate <class>`.

Report:

- The score, and how it compares to what mastery predicted.
- Topics the exam covered that had **never been quizzed** — a coverage gap the
  system should have caught earlier.
- Anything in `missed[]` that also appears in a topic's existing `confusions` —
  a misconception that survived studying and cost real marks.

Append durable misconceptions to **My standing misconceptions** in `class.md`.

## Rules

- Never invent a breakdown. If they only have a total score and can't recall the
  per-topic split, log nothing and say so — a fabricated breakdown produces a
  confident, wrong calibration figure, which is worse than no calibration.
- Don't editorialise about the grade. Record it, report what it implies for
  studying, move on.
