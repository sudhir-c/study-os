---
description: Record a study session in your own words
argument-hint: "<what you did, how long, what you got stuck on>"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

Record a study session.

Input: $ARGUMENTS

This is the low-friction capture path. The user types one sentence; you turn it
into structured history. Keep it fast — do not interrogate them.

## Steps

1. **Parse what they said** into: class, topic(s), minutes, what they did, and
   what they got stuck on.

   > "2hr on graphs, stuck on the Dijkstra correctness proof"

   → class = the one whose topics mention graphs (resolve via
   `./bin/studyos class list` and the topic files), topic = `graphs` or
   `shortest-paths`, minutes = 120, stuck = `["Dijkstra correctness proof"]`.

   Match topics to **existing slugs** wherever possible. Inventing a near-
   duplicate slug fragments the mastery record.

2. **Ask only if genuinely ambiguous** — and at most one question. If the class
   is unclear and two are plausible, ask. If the duration is missing, log
   without it rather than interrogating. Friction here means the user stops
   logging, and an incomplete log beats an empty one.

3. **Log it:**

   ```bash
   node lib/log-event.js '{"type":"session","class":"15-122","topic":"graphs","minutes":120,"what":"worked through Dijkstra","stuck":["Dijkstra correctness proof"]}'
   ```

   Multiple topics → one event per topic, splitting the minutes sensibly.

4. **If they described a struggle**, append it to the **Reflection** section of
   `vault/log/daily/YYYY-MM-DD.md` (create the file if today has no plan).

5. **If what they said reveals a misconception** rather than just difficulty —
   "I thought big-O was about worst case specifically" — add it to
   **My standing misconceptions** in `class.md`. That is exactly what the
   quizmaster mines later.

## Rules

- A `session` event is not a `quiz` event. Sessions carry no `asked`/`correct`
  and must not move the mastery estimate — self-reported study time is not
  evidence of mastery, only of exposure.
- Confirm in one line what you logged, so a misparse is visible immediately.
  Don't summarize their session back to them at length.
