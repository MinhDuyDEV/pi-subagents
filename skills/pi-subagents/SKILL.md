---
name: pi-subagents
description: Reliably delegate foreground, background, parallel, scheduled, isolated, and independently reviewed work with @minhduydev/pi-subagents. Use when launching or supervising Pi task subagents, choosing Herdr/tmux/SDK execution, coordinating resource claims, using worktrees, collecting evidence, recovering tasks, or operating task_control and /task commands.
license: MIT
compatibility: Pi 0.81.1+, Node.js 20+, optional Herdr 0.7.5+ or tmux, Git required for worktree isolation.
metadata:
  package: "@minhduydev/pi-subagents"
  protocol: "1"
---

# Pi Subagents

Use the `task` tool for delegation. Agent profiles belong to the consumer's `.pi/agents/`; never assume this package bundles profiles.

## Select the execution pattern

- Small read/research task: foreground or background in shared cwd.
- Multiple independent reads: launch in one assistant message; use the same `orchestration.batch_id` and `join: "group"`.
- Any parallel writer or sensitive write: set `isolation: "worktree"` and exclusive write claims.
- Repeated/delayed user-requested work: use `orchestration.schedule`; never schedule from vague intent.
- High-risk completion: require evidence and a separate reviewer task.

## Delegate

Write the prompt as a governed outcome, not a recipe:

- Outcome: the governed outcome, stated as observable behavior — not an implementation.
- Frontier: the open questions the agent owns deciding (approach, design within scope, test strategy).
- Locked decisions: each with rationale and an unlock condition ("locked because X; challenge it if you find evidence Y").
- Acceptance: what evidence would convince a skeptic — the agent chooses how to produce it.
- Non-goals and write/read policy.

Do not hand the agent a verification recipe, a chosen architecture, or pre-named acceptance criteria unless they are genuinely locked; every locked item must carry its rationale.

```json
{
  "agent_type": "general",
  "description": "Implement auth fix",
  "prompt": "Outcome: concurrent logins never mint two sessions for one user. Frontier: you own the fix approach and the test strategy. Locked: keep the public auth API stable — downstream consumers pin it; challenge this if the API itself causes the race. Acceptance: evidence that would convince a skeptic the race is gone. Non-goals: no API redesign.",
  "background": true,
  "isolation": "worktree",
  "orchestration": {
    "id": "auth-fix",
    "claims": [
      { "kind": "write", "resource": "src/auth", "mode": "exclusive" },
      { "kind": "test", "resource": "test:auth", "mode": "exclusive" }
    ],
    "context": {
      "goal": "Fix the auth race",
      "authorization": "write-approved",
      "known_facts": [],
      "unknowns": [],
      "decisions": [
        {
          "statement": "Keep the public auth API stable",
          "rationale": "Downstream consumers pin it",
          "unlock_condition": "A focused test proves the public API causes the race"
        }
      ],
      "references": [{ "path": "src/auth/index.ts" }],
      "evidence": [],
      "claims": ["Auth race is fixed", "Focused auth tests pass"],
      "next_step": "Reproduce the failing test"
    }
  }
}
```

`context.claims` are verifier-side acceptance claims for the proof gate; they are never rendered into the child prompt, so the child cannot write to the rubric. `context.next_step` renders as a non-binding suggested entry point. Add `"disclosure": "blind-first"` to `context` to seal `known_facts`/`decisions` behind a block the agent opens only after writing its own read of the problem.

Write claims must be exclusive and project-relative. Claims coordinate ownership; worktrees provide write isolation. The source repository must be clean before worktree launch. After gates pass, use `task_control` `worktree_status` and `worktree_merge`; use `worktree_remove` only to explicitly discard retained changes.

## Read the result

The child reports `<status>success | failure | blocked | partial | reframed</status>`. Treat `reframed` as a valid outcome, not a failure: the delegated framing was wrong and the agent delivered the corrected framing — read summary/findings for the reframe. An optional `<needs_decision>` field carries a disputed premise or a decision only you can make (options with tradeoffs); resolve it before relaunching or steering.

## Parallel group

Give every related call the same batch ID:

```json
{
  "orchestration": {
    "batch_id": "review-batch-42",
    "join": "group"
  }
}
```

Completions are durably processed first, then coalesced into one follow-up. Do not sleep or poll.

## Schedule only explicit user intent

```json
{
  "orchestration": {
    "schedule": {
      "cron": "0 9 * * 1",
      "timezone": "Asia/Ho_Chi_Minh"
    }
  }
}
```

For one-shot execution use `at` with an ISO date-time instead of `cron`. Scheduled runs are always background runs. Inspect with `/task-schedules`; disable with `/task-unschedule <id>`.

## Evidence and review

Execution, verification, and review are separate states. Self-authored handoff evidence is context only; it cannot pass a proof gate. Use `task_control record_evidence` so the runtime records producer identity, observation time, artifact digest, claim binding, and optional exit code.

1. Let the producer finish and inspect `/task <id>` or `task_control status`.
2. Launch a distinct reviewer task against the producer's retained worktree/diff/session.
3. Record the review with the actual reviewer task ID:

```json
{
  "action": "review",
  "task_id": "producer-task-id",
  "reviewer_task_id": "reviewer-task-id",
  "verdict": "approved"
}
```

4. Call `task_control ship` for the producer. A task cannot self-review; immutable review receipts are bound to the current session, worktree-diff, and evidence digest.

Never invent an orchestration identity, evidence path, test result, or reviewer task ID.

## Operate and recover

Human commands:

```text
/tasks
/task <id>
/task-result <id>
/task-steer <id> <message>
/task-stop <id>
/task-doctor
/task-metrics
/task-schedules
/task-unschedule <schedule-id>
/task-sessions
```

Model-facing `task_control` actions provide status, result, handoff, `record_evidence`, verify, metrics, doctor, review, ship, release, reap, and explicit worktree status/merge/removal. Prefer human commands for destructive operations.

In Herdr, treat lifecycle state as a wake-up hint:

- `working`: leave it alone;
- `blocked`: inspect and steer once;
- `idle`/`done`: reconcile the Pi session JSONL;
- `unknown`: uncertain, never success.

Do not use raw pane text as the final result. Do not close a pane unless its persisted terminal identity matches.

## More detail

Read [references/contract.md](references/contract.md) for the state model, evidence rules, RPC protocol, artifacts, environment variables, and Herdr behavior. When running inside a Herdr-managed workspace, read [references/herdr-room.md](references/herdr-room.md) for pane placement by task shape, the claim-serialization pane-race fix, grouped-completion UX, and writer discipline defaults.
