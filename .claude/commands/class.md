---
description: Parse a syllabus into a class's schedule.md and class.md
argument-hint: syllabus <class-id> <file>
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

Manage class metadata.

Arguments: $ARGUMENTS

Read `.claude/skills/study-os/SKILL.md` for vault conventions first.

## `syllabus <class-id> <file>`

Parse the syllabus at `<file>` (relative to the project root) and populate the
class's memory. The class directory already exists — `studyos class add` created
it before invoking you.

Read the file with the `Read` tool (it handles PDFs and images natively; loop
with `pages` if it runs past 20).

### 1. Update `vault/classes/<id>/class.md`

**Merge — do not overwrite.** Read the existing file first and keep anything
already there. Fill in frontmatter you can determine:

```
class: 15-122
title: "Principles of Imperative Computation"
term: "Fall 2026"
instructor: "..."
units: 10
aliases: ["15122", "imperative"]
```

Then fill in the body sections that already exist in the template:

- **Overview** — what the course covers, in two or three sentences.
- **Grading** — the weight of each component, as a table. This directly drives
  study prioritization, so get the percentages exact and note any drop policies,
  curves, or minimum-exam requirements.
- **Exam format** — what the syllabus says about midterms and finals: dates,
  duration, what's permitted (notes? calculator?), question style.

Leave **Recurring patterns** and **My standing misconceptions** empty. Those are
earned from practice tests and quiz history, not asserted from a syllabus.

### 2. Write `vault/classes/<id>/schedule.md`

The schedule is what the planner reasons over, so structure matters more than
prose. Frontmatter carries the dates that need to be machine-readable:

```
---
class: 15-122
term: "Fall 2026"
starts: 2026-08-24
ends: 2026-12-11
exams: [{"name":"Midterm 1","date":"2026-10-02","weight":0.2},{"name":"Final","date":"2026-12-15","weight":0.3}]
---
```

Body: a table of the week-by-week or lecture-by-lecture plan.

| Date | Lecture | Topic | Reading | Due |
|---|---|---|---|---|
| 2026-09-09 | 4 | Loop invariants | Ch. 5 | HW2 |

The `Topic` column is what the transcriber matches incoming notes against, so
use wording close to what will actually appear in lecture notes, and prefer the
syllabus's own vocabulary over your paraphrase.

If the syllabus gives only week ranges rather than dated lectures, keep the weeks
— do not fabricate specific dates.

### 3. Report

Summarize what you extracted: term dates, number of scheduled lectures, exam
dates with weights, and grading breakdown. Then explicitly call out anything the
syllabus did not specify (common gaps: exam format, late policy, whether the
final is cumulative) so it's clear what's still unknown rather than looking
complete.

Do not log an event for syllabus parsing — the event log tracks study activity,
not setup.
