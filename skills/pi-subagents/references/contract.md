# Runtime contract

## Delegation prompt contract (governed outcome)

A delegation prompt hands the agent an outcome to govern, not a recipe to execute:

- Outcome: observable behavior wanted, not an implementation.
- Frontier: the open questions the agent owns deciding.
- Locked decisions: each with rationale and an unlock condition. The public
  `context.decisions` and `task_control.handoff.decisions` shapes use
  `unlock_condition`; it is persisted as `unlockCondition` in the internal pack.
- Acceptance: what evidence would convince a skeptic; the agent chooses how.
- Non-goals and write/read policy.

Verification recipes, chosen architectures, and pre-named acceptance criteria belong in the prompt only when genuinely locked, and then with rationale.

## Result envelope

Reported status: `success | failure | blocked | partial | reframed`. `reframed` is a valid outcome — the delegated framing was wrong and the agent delivered the corrected framing. Optional `<needs_decision>` carries a disputed premise or a parent-only decision with options and tradeoffs; it is parsed into result details.

Child-visible context rendering never includes `context.claims` (they are enforced verifier-side by the proof gate), and `context.next_step` is rendered as a non-binding suggested entry point. `context.disclosure: "blind-first"` seals `known_facts`/`decisions` behind an open-after-your-own-read block.

## State model

Each run has a runtime-generated `invocationId`; caller-provided `orchestration.id` is correlation only and grants no authority.

Execution phases:

```text
allocating → starting → working ↔ blocked → completed
                                      └→ failed | cancelled | timeout
```

Independent gates:

```text
verification: not-required | pending | passed | failed
review:       not-required | awaiting | accepted | rejected
```

Execution completion does not imply verification or review acceptance.

## Durable artifacts

Under `.pi/artifacts/tasks/orchestration/`:

| Path | Purpose |
|---|---|
| `runs.json` | versioned durable run state |
| `leases.json` | active claims, heartbeat, expiration |
| `events.jsonl` | mandatory correctness journal |
| `contexts/*.json` | versioned Context Packs |
| `schedules.json` | durable cron/one-shot schedules |
| `evidence/` | reserved typed evidence receipts |

`PI_SUBAGENTS_NO_TELEMETRY=1` removes optional usage/performance fields but never disables the correctness journal.

## Evidence rules

Accepted references must resolve to a local project artifact or a captured `session:` JSONL. Raw `command:` and uncaptured `url:` references fail. Evidence timestamps must be present, parseable, non-future, and within the configured age. Claim linkage is deterministic plausibility checking, not semantic theorem proving; independent review remains required for high-risk acceptance.

Worktree completions include `baseSha`, branch, changed paths, and a SHA-256 diff/content digest. Unchanged worktrees are removed; changed worktrees are retained for review/merge.

## Learning claims

Task outcomes may contribute learning only through explicit `orchestration.context.learning_claims` (max 32), each a versioned claim (`kind: pattern | discovery`, tagged-digest `claimId`, bounded `statement`/`applicability`) whose `support` names 1-16 bounded evidence refs (`mode: direct-artifact | task-outcome`). Task descriptions, free-form context claims, review prose, TODO text, and DCP summaries are never learning candidates by themselves. Do not invent claim IDs, evidence digests, usage receipts, or lower-trust outcome bindings; omit the learning claim when the producer cannot supply the canonical contract.

## Herdr behavior

Automatic preference order is Herdr → tmux → SDK. Lack of Herdr context may fall back. A configured Herdr control-plane outage fails visibly instead of silently launching elsewhere. Herdr agent waits wake reconciliation; Pi JSONL stop reasons remain authoritative.

Handles bind socket, parent pane, pane ID, terminal ID, agent name, tab/workspace, and group. Cleanup verifies ownership and preserves focus. Prompts use atomic `herdr agent prompt`; metadata source is `pi-subagents`.

Optional plugin: `herdr-plugin/attention-broker/`.

## RPC v3

Channels:

```text
pi-subagents:rpc:v3:ping
pi-subagents:rpc:v3:spawn
pi-subagents:rpc:v3:stop
```

Every request carries `requestId` and `protocolVersion: 3`. Spawn returns `{ id, handle }`, where `handle` is an opaque ownership scope. A child spawn may provide `parentHandle`. Stop freezes descendants, cancels descendant-first, waits for bounded settlement, and returns `{ settled, failures }`.

Lifecycle events use protocol version 1:

```text
pi-subagents:task-started
pi-subagents:task-settled
pi-subagents:batch-settled
```

## Environment variables

| Variable | Meaning |
|---|---|
| `PI_TASK_BACKEND=auto|herdr|tmux|sdk` | backend selection |
| `PI_SUBAGENTS_PANE_RETRIES=N` | transient Herdr allocation retry budget |
| `PI_SUBAGENTS_NO_CLAIMS=1` | disable claim coordination/guards |
| `PI_SUBAGENTS_NO_PROOF=1` | opt out only where explicit policy permits |
| `PI_SUBAGENTS_NO_TELEMETRY=1` | omit optional metrics, keep correctness state |
| `PI_TASK_CHILD_NO_EXTENSIONS=1` | disable all child extensions |
| `PI_TASK_TMUX_SPLIT=horizontal|vertical` | tmux split preference |

Child Pi processes receive neither `task` nor `task_control`. Parent control operations are never delegated through the default child allowlist.
