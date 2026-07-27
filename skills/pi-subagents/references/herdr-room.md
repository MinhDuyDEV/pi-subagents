# Herdr room recipes

Operational doctrine for running this package inside a Herdr-managed workspace. Applies only when
the Herdr backend is active; the tmux/SDK fallbacks ignore pane placement entirely.

## Pane and workspace placement by task shape

Pick placement by task shape, not habit. Foreground splits preserve focus (`--no-focus`), so they
open without stealing the cursor.

| Situation | Mode | Where it appears |
|---|---|---|
| trivial single-file edit, direct Q&A, one known file | inline — no `task` | parent pane |
| 1-3 quick parallel reads / explore / research | foreground, shared cwd | foreground split in the current workspace (visible, easy to watch) |
| a coherent batch of related tasks (audit N files; implement + review + proof-audit; parallel writers on different areas) | one `workspace_group` label + same `batch_id`, `join: "group"` | first task opens an owned workspace root; later same-group tasks stack downward (parent workspace stays clean) |
| fire-and-forget, past the split limit, or reducing visual noise | `background: true` | queues; no immediate pane; recovers from a split race |
| any parallel or sensitive writer | `isolation: "worktree"` + exclusive `claims` | separate workspace + separate git checkout (physical isolation, clean review) |

## The pane-race fix is structural, not just batching

Exclusive write `claims` are acquired and serialized before launch — conflicting writers BLOCK
rather than bursting concurrent `splitWindowPane` calls. So declare `orchestration.claims` for
every writer; the old "at most 3 foreground tasks per message" rule is only a light fallback for
claim-less read-only fan-out. If a `task` still reports `Failed to create herdr execution pane`,
re-launch it as `background: true` — never drop the work.

## UX-smoothing behaviors to lean on

- **Preserve-focus** (`--no-focus`): panes open without stealing the cursor; the parent keeps typing.
- **Grouped completion** (`batch_id` + `join: "group"`): one coalesced follow-up instead of N pings —
  the smoothest UX for parallel work, no turn storm.
- **Herdr toast on settle**: a non-intrusive completion signal.
- **Lifecycle state is a wake-up hint, never success** — see "Operate and recover" in the skill body:
  `working` → leave alone; `blocked` → inspect and steer once (`/task-steer <id> <msg>`);
  `idle`/`done` → reconcile the Pi session JSONL; `unknown` → uncertain, never success. Do not stare
  at `working` panes.
- **Attention broker** (optional): link the bundled plugin so the `Root` supervisor wakes on
  settle/blocked without polling:

  ```bash
  herdr plugin link ./node_modules/@minhduydev/pi-subagents/herdr-plugin/attention-broker
  ```

## Discipline defaults for writers

For `task` calls that WRITE files or touch sensitive scope, pass `orchestration` with exclusive
project-relative `claims`, a `lease_ttl_ms`, `proof: { "mode": "evidence-only" }`, and a `context`
pack (goal, known_facts, decisions, references) so the subagent starts with provenance, not a blank
slate. Keep the opt-in intentional — orchestration is off by default to preserve the additive,
non-clobbering contract; turn it on where evidence and single-ownership matter.
