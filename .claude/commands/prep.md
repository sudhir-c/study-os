---
description: Work through a practice test — map it to topics, drill the gaps, then run a postmortem
argument-hint: <class> --exam <file> [--mode dry-run|take|postmortem]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

Prepare for an exam using a practice test.

Arguments: $ARGUMENTS

This is the highest-leverage flow in the system: a practice test is direct
evidence of what the instructor actually asks, which is worth more than any
inference from lecture notes.

## Phase 1 — Map the test

1. Read the exam file (`Read` handles PDFs and images natively; loop with
   `pages` past 20). If it isn't already in the vault, copy it to
   `vault/classes/<id>/exams/`.

2. For each question, record: what it asks, which vault topic it maps to, and
   its point value. Topics that appear on a practice test are *validated* as
   exam-relevant — that outranks your own guesses about importance.

3. Cross-reference against the vault and produce a coverage table:

   | Q | Topic | Points | Your mastery | Notes exist? |
   |---|---|---|---|---|

   Three things matter here, and you should call each out explicitly:
   - **Untested topics on the exam** — highest risk, no evidence either way.
   - **Weak topics on the exam** — known gaps, directly targeted.
   - **Exam topics with no notes at all** — a genuine hole in the material.
     Say so plainly; this usually means a missed lecture.

4. Update `class.md` → **Recurring patterns** with the question styles you see
   (merge, don't overwrite). This is how the quizmaster learns to write
   questions that look like the real thing.

## Phase 2 — Drill (`--mode dry-run`, the default)

Do **not** show the practice test's own questions and answers — burning it
means losing the only clean measurement available later.

Instead, dispatch `quizmaster` to write *fresh* questions in the same style,
targeting the untested and weak topics from the coverage table. Then let the
user sit the real practice test cold.

## Phase 3 — Take it (`--mode take`)

Present the actual questions one at a time, no hints. Grade at the end, not
during. Then go to the postmortem.

## Phase 4 — Postmortem (`--mode postmortem`)

Ask for their answers or their score breakdown, then for each miss determine
**why** it was missed:

- didn't know the material
- knew it, misapplied it
- arithmetic/algebra slip
- misread the question
- ran out of time

This distinction drives completely different remedies, and lumping them
together as "got it wrong" is the most common way exam prep wastes time.

Log the result — **one event per topic**, in question counts, with
`kind: "practice"`:

```bash
node lib/log-event.js '[
  {"type":"exam","class":"15-122","exam":"exams/practice-midterm.pdf","kind":"practice","topic":"loop-invariants","asked":6,"correct":3.5,"missed":["forgets metric must be bounded below"]},
  {"type":"exam","class":"15-122","exam":"exams/practice-midterm.pdf","kind":"practice","topic":"big-o-analysis","asked":4,"correct":2,"missed":["misapplies master theorem case 2"]}
]'
```

See the exam-event rules in the skill: singular `topic`, question counts rather
than points, and `kind: "practice"` so this stays out of the real-exam
calibration series. A single event carrying a `topics[]` array reaches nothing —
the result would be silently discarded.

If you genuinely can't attribute questions to topics, log nothing and say so
rather than guessing at a split.

Then write `vault/classes/<id>/exams/<name>-postmortem.md` with the coverage
table, the per-miss causes, and a prioritized fix list. Append anything that
recurs to **My standing misconceptions** in `class.md`.

Finish with `./bin/studyos rebuild <class>`.

## Report

Lead with the score and the two or three highest-value fixes before the real
exam. Then state what the practice test reveals about the *exam's* shape —
which topics carry the most points — since that is what should drive the
remaining study time.
