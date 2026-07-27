# @minhduydev/pi-subagents

A Herdr-native delegation runtime for [Pi](https://pi.dev): durable foreground/background subagents, observable terminal execution, worktree isolation, resource ownership, evidence and independent-review gates, grouped completion, schedules, recovery, lifecycle RPC, and tmux/SDK fallback.

**Runtime-only.** The package ships no agent profiles. Profiles remain owned by the consumer in `.pi/agents/*.md` or `~/.pi/agent/agents/*.md`. The runtime is additive and does not inject package policy into the consumer's parent system prompt. Its packaged skill is loaded only on demand through Pi's normal skill mechanism.

## What's new in 0.9.0

- Independent **review** gate bound to a settled run, with its own durable verdict.
- **Semantic attestation** evidence module; the proof gate now binds evidence to the run's `resultDigest`.
- The run store is **CAS-fenced** on terminal results and **unique-constrained** on decision-resume correlations; leases carry an `expectedFence` on acquire/release/transfer.
- New **multi-process contention fixtures** prove lease mutual exclusion, the terminal-result CAS, and the durable-invocation unique constraint under real inter-process concurrency.
- Peer `@minhduydev/pi-core` moved to `^0.2.0`. See `CHANGELOG.md`.

## Requirements

- Node.js 20+
- Pi `0.81.1+`
- Optional: Herdr `0.7.5+` (preferred observable backend)
- Optional: tmux
- Git with at least one commit for `isolation: "worktree"`

## Install

```bash
pi install npm:@minhduydev/pi-subagents
```

Create at least one consumer-owned profile:

```markdown
<!-- .pi/agents/general.md -->
---
description: Implements focused repository changes and verifies them.
tools: read, grep, find, ls, bash, edit, write
---

Work only within the delegated scope. Return a concise summary, changed files,
evidence, caveats, and next steps.
```

Then delegate:

```json
{
  "agent_type": "general",
  "description": "Fix auth race",
  "prompt": "Outcome: concurrent logins never mint two sessions for one user. Frontier: you own the fix approach and the test strategy. Locked: keep the public auth API stable — downstream consumers pin it; challenge this if you find evidence the API itself causes the race. Acceptance: evidence that would convince a skeptic the race is gone. Non-goals: no API redesign.",
  "background": true
}
```

## Execution model

| Backend | Selection | Visibility | Completion truth |
|---|---|---|---|
| Herdr | preferred in an active Herdr pane | first-class pane/agent metadata and waits | Pi session JSONL |
| tmux | fallback when available | split pane | Pi session JSONL |
| SDK | final fallback | Pi task widget | AgentSession result |

`PI_TASK_BACKEND=herdr|tmux|sdk|auto` overrides selection. In `auto`, absence of Herdr context may fall back. A detected Herdr control-plane outage fails visibly rather than silently launching the same work elsewhere.

Herdr lifecycle (`working`, `blocked`, `idle`, `done`, `unknown`) is a wake-up and UI signal. It never replaces the child Pi JSONL stop reason as authoritative completion.

## The `task` tool

Core parameters:

| Field | Meaning |
|---|---|
| `agent_type` | consumer profile name |
| `description` | short task title |
| `prompt` | governed-outcome brief: self-contained about context, not pre-solved about solution |
| `background` | defaults to `true`; `false` waits foreground |
| `task_id` | resume an existing task |
| `conversation_id` | durable specialist conversation |
| `workspace_group` | put related Herdr tasks in one owned workspace |
| `isolation: "worktree"` | run in a dedicated Git worktree |
| `orchestration` | optional durable coordination and verification |

### Prompt contract (governed outcome)

The prompt hands the agent an outcome to govern, not a recipe to execute:

- **Outcome** — the governed outcome wanted, stated as observable behavior, not an implementation.
- **Frontier** — the open questions the agent OWNS deciding (approach, design within scope, test strategy).
- **Locked decisions** — constraints that stand, each WITH rationale and an unlock condition ("locked because X; challenge it if you find evidence Y").
- **Acceptance** — what evidence would convince a skeptic the outcome holds; the agent chooses HOW to produce it.
- **Non-goals** and **write/read policy** — scope and mutation boundaries.

Do not hand the agent a verification recipe, a chosen architecture, or pre-named acceptance criteria unless they are genuinely locked; every locked item must carry its rationale. This keeps the subagent an independent problem-solver rather than a worker executing a pre-solved plan.

### Result envelope: `reframed` and `needs_decision`

The child's XML result envelope accepts `<status>success | failure | blocked | partial | reframed</status>`. `reframed` is a first-class, valid outcome — the delegated framing was wrong and the agent delivered the corrected framing instead (with summary/findings as usual). It is surfaced to the parent as a legitimate result, not a failure.

A child may also emit an optional `<needs_decision>` tag: a disputed premise or a decision only the parent can make, with options and tradeoffs. It is parsed into the result details (`needs_decision`) and shown in the task UI. No agent is required to use it.

### Worktree isolation

Use it for parallel or sensitive writers:

```json
{
  "isolation": "worktree",
  "orchestration": {
    "claims": [
      { "kind": "write", "resource": "src/auth", "mode": "exclusive" }
    ]
  }
}
```

The runtime requires a clean source repository, then creates a branch under `pi-subagents/*` and a checkout outside it. This prevents local edits from being silently omitted from the delegated base. It records `baseSha`, branch, changed paths, and a SHA-256 diff/content digest. Unchanged worktrees are removed automatically; changed worktrees are retained for review and explicit merge. Write claims must be exclusive and project-relative.

## Durable orchestration

```json
{
  "orchestration": {
    "id": "auth-fix",
    "batch_id": "auth-batch",
    "join": "group",
    "lease_ttl_ms": 1800000,
    "claims": [
      { "kind": "write", "resource": "src/auth", "mode": "exclusive" },
      { "kind": "test", "resource": "test:auth", "mode": "exclusive" }
    ],
    "context": {
      "goal": "Fix the authentication race",
      "authorization": "write-approved",
      "known_facts": [
        {
          "statement": "The race is reproduced by auth.concurrent.test.ts",
          "source": "repository",
          "reference": "test/auth.concurrent.test.ts"
        }
      ],
      "unknowns": [],
      "decisions": [],
      "references": [
        { "path": "src/auth/index.ts" },
        { "path": "test/auth.concurrent.test.ts" }
      ],
      "evidence": [],
      "claims": [
        "The authentication race is fixed",
        "The focused auth tests pass"
      ],
      "next_step": "Reproduce the focused failing test"
    },
    "proof": {
      "mode": "evidence-only",
      "max_evidence_age_ms": 900000
    },
    "verifier": {
      "required": true,
      "reviewer_agent": "reviewer",
      "min_reviews": 1
    }
  }
}
```

`orchestration.id` is a correlation label only. The runtime creates an opaque invocation identity for authority and lease ownership.

### State model

Execution, verification, and review are independent:

```text
execution:    allocating → starting → working ↔ blocked → completed
                                                   └→ failed/cancelled/timeout
verification: not-required | pending | passed | failed
review:       not-required | awaiting | accepted | rejected
```

A successful child self-report is not surfaced as final verified success before verification has run. A required but missing review produces `awaiting_review`, not a fake execution failure.

### Claims and lease heartbeats

- `write`: exclusive project path ownership
- `test`: shared/exclusive named test environment
- `evidence`: shared/exclusive artifact production

Claims are acquired before launch and transferred to the canonical task ID. Active tasks renew heartbeat/expiry every minute. User-provided correlation IDs are never authority. The parent built-in `edit`/`write` tools are protected through Pi's `tool_call` event; isolated worktrees provide the real boundary for child writes and shell commands.

### Context Packs

Context Packs are versioned, secret-redacted and project-scoped. File references include SHA-256 digests; out-of-project references are rejected. Stored context is reused on resume.

Two anti-Goodhart properties of the child-visible rendering:

- `context.claims` (acceptance claims) are **never rendered into the child prompt**. They stay in the data model and are enforced verifier-side by the proof gate, so the child cannot write to the rubric instead of solving the problem.
- `context.next_step` renders as "Suggested entry point (optional, non-binding)" — a hint, not an instruction.

Optional blind-first disclosure: pass `"disclosure": "blind-first"` in `orchestration.context` and the parent's `known_facts`/`decisions` are sealed behind a "Sealed context — open AFTER you have written your own 5-line read of the problem" block placed after the goal, frontier, and policy. Default (`"open"`) keeps the previous inline rendering.

Add a handoff with `task_control`:

```json
{
  "action": "handoff",
  "task_id": "task-id",
  "handoff": {
    "decisions": [
      { "statement": "Keep the public API stable", "rationale": "Compatibility" }
    ],
    "evidence": [
      {
        "description": "Focused test log",
        "reference": ".pi/artifacts/test-auth.log",
        "recorded_at": "2026-07-23T12:00:00.000Z",
        "claim": "The focused auth tests pass"
      }
    ],
    "next_step": "Run independent review"
  }
}
```

### Evidence

Handoff evidence is contextual and **cannot satisfy a proof gate by self-declaration**. Gate-authoritative evidence must be bound by the runtime either to the canonical Pi session or to a typed receipt created with `record_evidence`:

```json
{
  "action": "record_evidence",
  "task_id": "task-id",
  "evidence_kind": "test",
  "evidence_description": "Focused auth tests pass",
  "evidence_reference": ".pi/artifacts/test-auth.log",
  "evidence_claim": "The focused auth tests pass",
  "evidence_exit_code": 0
}
```

The runtime supplies observation time, producer identity, artifact SHA-256, and claim binding, then rejects mutation, staleness, symlink escape, raw `command:` assertions, and uncaptured `url:` assertions. Claim-to-artifact token linkage is only a deterministic plausibility check, not semantic theorem proving; use independent review for high-risk acceptance.

### Independent review and ship

Launch a distinct reviewer task. Then bind its real task identity to the producer:

```json
{
  "action": "review",
  "task_id": "producer-task-id",
  "reviewer_task_id": "reviewer-task-id",
  "verdict": "approved"
}
```

The reviewer must be completed, different from the producer, pass its own verification gate, and match `reviewer_agent` when configured. The immutable verdict is bound to a digest of the canonical subject session, retained worktree diff, and recorded evidence. Duplicate, contradictory, self, stale-digest, or incorrect-profile reviews do not satisfy the gate.

Finalize:

```json
{ "action": "ship", "task_id": "producer-task-id" }
```

## Grouped completion

For parallel calls, use one batch ID and `join: "group"`:

```json
{
  "orchestration": {
    "batch_id": "audit-42",
    "join": "group"
  }
}
```

Each completion is persisted and verified immediately. Nearby completions are coalesced into one `task-batch-complete` follow-up to prevent notification/turn storms.

## Scheduling

Scheduling is included in the `task` orchestration schema and uses a durable store.

Cron:

```json
{
  "orchestration": {
    "schedule": {
      "cron": "0 9 * * 1",
      "timezone": "Asia/Ho_Chi_Minh",
      "max_runs": 12
    }
  }
}
```

One-shot:

```json
{
  "orchestration": {
    "schedule": {
      "at": "2026-07-24T02:00:00.000Z"
    }
  }
}
```

Exactly one of `cron` or `at` is required. Scheduled tasks always run in background and cannot recursively reschedule themselves. Only schedule work the user explicitly requested.

## Human commands

| Command | Purpose |
|---|---|
| `/tasks` | FleetView-lite durable task list |
| `/task <id>` | execution/verification/review/claims/session |
| `/task-result <id>` | canonical final assistant result |
| `/task-steer <id> <message>` | atomic follow-up |
| `/task-stop <id>` | close owned resource and release lease |
| `/task-doctor` | recovery, lease, context, proof and runtime checks |
| `/task-metrics` | local aggregate metrics |
| `/task-schedules` | list schedules |
| `/task-unschedule <id>` | disable schedule |
| `/task-sessions` | durable conversation mappings |

The model-facing control tool is named **`task_control`**, not `herdr`. This avoids collision with `@ogulcancelik/pi-herdr`, whose `herdr_layout`, `herdr_pane`, and `herdr_agent` tools can be installed alongside this package. Its lifecycle actions include `status`, `result`, `handoff`, `record_evidence`, `verify`, `review`, `ship`, `release`, `reap`, `doctor`, and `metrics`. Retained isolated changes are handled explicitly with `worktree_status`, `worktree_merge` (only after verification/review gates pass), or `worktree_remove`.

## Herdr integration

The internal client uses structured `{ result, error }` envelopes, typed error codes, abort/timeouts, classified transient retry, atomic `agent prompt`, agent waits, ownership verification, preserve-focus layout, and `pi-subagents` metadata tokens.

Optional attention plugin:

```bash
herdr plugin link ./node_modules/@minhduydev/pi-subagents/herdr-plugin/attention-broker
```

For globally managed Pi packages, locate the installed package and link its `herdr-plugin/attention-broker` directory. The plugin persists and deduplicates settled/blocked events, then wakes the supervisor named `Root`; it never polls or runs a model. See [`herdr-plugin/attention-broker/README.md`](herdr-plugin/attention-broker/README.md).

## Lifecycle API and RPC v3

Import stable constants/types from:

```ts
import {
  TASK_LIFECYCLE_EVENTS,
  TASK_LIFECYCLE_PROTOCOL_VERSION,
  TASK_RPC_PROTOCOL_VERSION,
} from "@minhduydev/pi-subagents/api";
```

Lifecycle events:

```text
pi-subagents:task-started
pi-subagents:task-settled
pi-subagents:batch-settled
```

RPC v3 channels:

```text
pi-subagents:rpc:v3:ping
pi-subagents:rpc:v3:spawn
pi-subagents:rpc:v3:stop
```

Spawn returns `{ id, handle }`. The opaque handle owns a recursive scope. Stop freezes new descendants, cancels descendant-first, waits for bounded settlement, and returns `{ settled, failures }`. Every request includes `requestId` and `protocolVersion: 3`.

## Durable files

`.pi/artifacts/tasks/orchestration/` contains:

```text
runs.json          # mandatory versioned run state
leases.json        # claims + heartbeat/expiry
contexts/*.json    # Context Packs
events.jsonl       # mandatory correctness journal
schedules.json     # durable schedules
evidence/          # typed evidence receipt namespace
```

The event journal is correctness state. `PI_SUBAGENTS_NO_TELEMETRY=1` removes optional duration/token/cost/review-yield fields, but never disables recovery, leases, proof or review state.

## Environment

| Variable | Effect |
|---|---|
| `PI_TASK_BACKEND=auto|herdr|tmux|sdk` | backend selection |
| `PI_SUBAGENTS_PANE_RETRIES=N` | transient Herdr allocation retry budget |
| `PI_SUBAGENTS_NO_CLAIMS=1` | disable claim coordination/parent write guard |
| `PI_SUBAGENTS_NO_PROOF=1` | explicit proof opt-out where policy permits |
| `PI_SUBAGENTS_NO_TELEMETRY=1` | omit optional metrics only |
| `PI_TASK_CHILD_NO_EXTENSIONS=1` | disable all child extensions |
| `PI_TASK_TMUX_SPLIT=horizontal|vertical` | tmux split preference |

Child Pi processes do not register `task`, `task_control`, commands, schedules, RPC, timers, or the parent write guard. Default child allowlists explicitly remove parent control tools.

## Packaged skill

Pi discovers `skills/pi-subagents/SKILL.md` from the package. Load it on demand:

```text
/skill:pi-subagents
```

It documents reliable delegation recipes without shipping an agent profile or changing the consumer's parent prompt by default.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm audit --omit=dev
```

The suite includes base runtime, Herdr transport, durable state, lease heartbeat, proof/review, worktree, scheduler, RPC, recovery and fault-path tests.

## Security notes

- Treat agent profiles and skills as executable instructions; review them.
- Correlation IDs, verdict text and evidence descriptions are not authority.
- Worktree isolation is not an OS sandbox; symlinks and arbitrary shell access still require normal repository/tool policy.
- Destructive task operations are parent-only and scope-check durable identities.
- No telemetry is sent externally.

## License

MIT
