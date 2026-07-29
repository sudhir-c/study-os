---
description: Analyst pass over your study history — patterns, decay, coverage gaps
argument-hint: [--class X] [--nightly]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

Review the study log and surface what's actually happening.

Arguments: $ARGUMENTS

## Steps

1. **Refresh derived state**: `./bin/studyos rebuild` so mastery reflects every
   logged event before anything is analyzed.

2. **Dispatch the `analyst` subagent**, scoped to `--class` if given, otherwise
   across all classes.

3. **Report** its findings.

## `--nightly` mode

This is how the launchd nightly agent invokes the command. It runs unattended,
so:

- Do **not** ask questions. There is nobody to answer them. Where you would
  normally ask, state the assumption and continue.
- After the analyst runs, dispatch `planner` to draft tomorrow's plan into
  `vault/log/daily/<tomorrow>.md`. Mark it clearly as a draft — the user hasn't
  told you their time budget, so assume a moderate one and say what you assumed.
- Keep output short. It goes to `vault/log/automation.log`, not a screen.
- If there were **no events at all today**, write nothing and exit quietly. A
  nightly file full of "no activity" entries is noise that makes the real
  entries harder to find.

## Rules

- Findings must be computable from `events.jsonl`. If the analyst reports a
  number, it must be traceable to specific events.
- Respect the honesty rule in the analyst's brief: thin evidence gets reported
  as thin, not smoothed into a confident claim.
- Do not log a `reflect` event unless the user actually reflected. The analyst's
  own output is not user input.
