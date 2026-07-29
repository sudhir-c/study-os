---
description: Generate and grade study questions for a class
argument-hint: <class> [--topic slug] [-n count]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

Quiz the user.

Arguments: $ARGUMENTS

## Steps

1. **Resolve the class.** `./bin/studyos class list` shows registered classes;
   partial names and aliases resolve. If no class was given and only one is
   registered, use it. If several are, ask which.

2. **Pick topics.**
   - `--topic <slug>` given → use exactly that.
   - Otherwise run `./bin/studyos status <class>` and take what is due, weakest
     first. That ordering already accounts for overdue reviews, low mastery,
     and never-tested material.
   - Cover at most 2–3 topics in one sitting. A quiz spanning eight topics
     tests nothing deeply enough to move a mastery estimate.

3. **Run the quiz** via the `quizmaster` subagent. Default to 8 questions;
   `-n` overrides. Pass it the class, the chosen topics, and the reason each
   was chosen (overdue / weak / never tested) so it can weight accordingly.

   The quizmaster asks one question at a time and waits — this is an
   interactive session, not a worksheet.

4. **Afterwards**, run `./bin/studyos rebuild <class>` so mastery and
   `next_review` pick up the new events.

## Rules

- Do not quiz on a topic with no notes behind it. Say the notes are missing and
  suggest ingesting them. A quiz on material the user never covered measures
  nothing.
- The quizmaster logs the events. Do not also write them yourself, and do not
  hand-edit topic frontmatter — `rebuild` derives it.
