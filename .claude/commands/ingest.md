---
description: Transcribe and file everything waiting in inbox/ (or one specific file)
argument-hint: [path]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

Ingest class notes into the vault.

Target: $ARGUMENTS

Read `.claude/skills/study-os/SKILL.md` for the vault conventions before you
start.

## Steps

1. **Build the work list.**
   - If a path was given above, that is the only item.
   - Otherwise take every file at the top level of `inbox/` — skip `_processed/`,
     `_unfiled/`, and dotfiles.
   - Supported: `.pdf`, `.png`, `.jpg`, `.jpeg`, `.heic`, `.md`, `.txt`.
     Report anything else as skipped rather than trying to parse it.

   If the work list is empty, say so in one line and stop. Do not invent work.

2. **Dispatch a `transcriber` subagent per file, in parallel.** Send them in a
   single message with multiple tool calls so they run concurrently. Give each
   agent the absolute file path and the list of currently registered classes
   (from `vault/classes/`).

   Plain `.md`/`.txt` files that already look like clean notes don't need a
   subagent — classify and file them yourself, following the same conventions.

3. **Archive originals.** Each transcriber moves its own source into the class's
   `sources/`. For anything that ended up unfiled, move it to `inbox/_unfiled/`.
   When you're done, `inbox/` should have no loose files left at the top level.

4. **Report.** One line per file:

   ```
   ✓ lecture-04.pdf → 15-122/notes/2026-09-09-loop-invariants.md  (6pp, 2 topics, high)
   ? scan-8812.jpg  → inbox/_unfiled/  — couldn't determine class
   ```

   Then, if any transcriber flagged unclear passages, list them grouped by file
   so they can be checked against the original. This is the most useful part of
   the output — do not omit it.

## Rules

- Never delete a source file. Move it; never `rm`.
- If a target note path already exists, do not overwrite it. Append a `-2`
  suffix and note the collision in your report — a re-ingest of the same lecture
  usually means something went wrong upstream, and silently replacing the
  earlier transcription would hide it.
- Every successfully filed note gets an `ingest` event. No exceptions — the log
  is the source of truth, and an unlogged note is invisible to `rebuild`.
