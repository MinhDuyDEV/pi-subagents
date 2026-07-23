# @minhduydev/pi-subagents

Delegation **runtime** for [Pi](https://pi.dev). Adds a robust `task` tool — foreground/background subagents with HerdR/tmux/SDK backends — plus machine-checkable orchestration: resource claims/leases, provenance-aware Context Packs, evidence-only review, an orchestration doctor, local telemetry, a `herdr` companion tool, and pane-creation retry.

**Runtime-only.** This package ships **no agent profiles**. Agents resolve from the consumer's `.pi/agents/*.md` (project) and `~/.pi/agent/agents/*.md` (user). Additive kernel: it never injects policy into a consumer's system prompt.

## Install

```bash
pi install npm:@minhduydev/pi-subagents
```

Then author agents in your repo's `.pi/agents/` (e.g. `explore`, `general`, `reviewer`, `scout`) and delegate:

```json
{ "agent_type": "reviewer", "description": "Review the diff", "prompt": "Goal: ... Non-goals: ... Stop condition: ..." }
```

## The `task` tool

- **Foreground:** parent waits and receives the subagent result directly.
- **Background:** parent continues; a task widget shows progress; completion arrives as a follow-up.
- **Backends:** HerdR and tmux (observable panes), with an in-process SDK fallback when neither is available.
- **Agent frontmatter:** `model`, `thinking`, `tools`, `disallowed_tools`.

## Optional `orchestration` (added on top of the upstream `task` API)

```json
{
  "agent_type": "general",
  "description": "Implement feature X",
  "prompt": "Goal: ...",
  "orchestration": {
    "claims": [
      { "kind": "write", "resource": "src/auth", "mode": "exclusive" },
      { "kind": "test", "resource": "test:auth", "mode": "exclusive" }
    ],
    "lease_ttl_ms": 1800000,
    "context": {
      "goal": "...",
      "authorization": "write-approved",
      "known_facts": [{ "statement": "...", "source": "repository", "reference": "src/auth/index.ts" }],
      "unknowns": ["..."],
      "decisions": [{ "statement": "...", "rationale": "..." }],
      "references": [{ "path": "src/auth/index.ts" }],
      "evidence": [],
      "next_step": "Run the failing test."
    }
  }
}
```

The `orchestration` object is stripped before the upstream task tool runs, so the dependency sees its original contract.

### Resource claims & leases
Claim kinds: `write` (file/dir ownership), `test` (a shared environment), `evidence` (an output artifact). A claim conflicts when resources overlap and at least one is exclusive → the overlapping task is **blocked** until the lease releases. This makes "one owner per resource" machine-checkable and prevents concurrent-pane bursts.

### Context Pack & handoff
Compact, provenance-tagged delegation context (goal, authorization, known facts, unknowns, decisions, references with SHA-256 digests, evidence, next step). Secrets are redacted; out-of-repo references are rejected. On resume the stored pack is appended to the delegated prompt. Use the `herdr` tool's `handoff` action to update it without losing provenance.

### Evidence-only review
`"proof": { "mode": "evidence-only" }` checks that evidence exists, is fresh, is not future-dated, and resolves to a project artifact or captured `session:` JSONL. Raw `command:` claims and uncaptured `url:` claims are rejected.

### `herdr` companion tool
`status` · `result` · `handoff` · `metrics` · `doctor` · `record_review` · `release`.

## Opt-outs

| Env | Effect |
|---|---|
| `PI_SUBAGENTS_NO_CLAIMS=1` | skip claim acquisition (plain delegation) |
| `PI_SUBAGENTS_NO_PROOF=1` | skip evidence-only proof gate |
| `PI_SUBAGENTS_NO_TELEMETRY=1` | write no local telemetry events |

## Telemetry
Local JSONL under `.pi/artifacts/tasks/orchestration/`: started/completed/failed/stale, duration + retries, token/cost, verification pass rate, review-yield. No external monitoring; no automatic model routing.

## License
MIT.