---
description: Build a study plan for today or the week
argument-hint: [today|week] [free-form context, e.g. "3 hrs, midterm Friday"]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

Build a study plan.

Arguments: $ARGUMENTS

## Steps

1. **Read the situation.** The arguments are free-form — "3 hrs tonight,
   midterm Friday", "week", "I'm behind in 122". Extract the horizon (default
   today), the time budget, and any constraint they mention.

2. **Get the state**: `./bin/studyos status`. This gives due topics, mastery,
   standing confusions, and upcoming exams across all classes from the event
   log.

3. **Dispatch the `planner` subagent** with the horizon, the time budget, and
   any constraints. It handles prioritization, writes
   `vault/log/daily/YYYY-MM-DD.md`, and logs the `plan` event.

4. If no time budget was given, **ask before planning**. It is the input that
   most changes the answer, and a plan built on a guessed budget is usually
   wrong in a way that isn't obvious until the user is mid-evening.

## Rules

- Plans name specific artifacts — a note section, a problem set, a
  `studyos quiz` invocation — not "review invariants".
- Say what is being cut. If four hours of work were ranked and two hours
  budgeted, the two hours dropped are information the user needs.
- Do not replan silently over a plan the user is partway through. Read
  today's `daily/` file first and merge.
