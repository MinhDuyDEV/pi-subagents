# @minhduydev/pi-subagents v0.5.0

A Herdr-native, durable, isolation-first delegation runtime for [Pi](https://pi.dev). This release introduces a durable orchestration kernel, typed Herdr integration, Git worktree isolation, runtime-bound evidence receipts, independent review gates, grouped completion, scheduling, RPC v3, recovery, and a packaged Agent Skill — all while preserving the runtime-only design (no bundled agent profiles).

## Highlights

- **Durable task kernel:** `runs.json` with separate execution/verification/review phases, idempotent correctness events, terminal-phase immutability, and cross-restart recovery. The telemetry opt-out strips optional metrics only — the correctness journal is always persisted.
- **Runtime-bound evidence:** `record_evidence` creates typed receipts with producer identity, observation time, artifact SHA-256, claim binding, and exit code. Self-declared handoff evidence is context only and cannot pass a proof gate.
- **Independent review gates:** A task cannot self-review. Reviews require a completed, verified, distinct reviewer task matching the configured profile, bound to an immutable subject digest (session + worktree diff + evidence). `ship` enforces the gate; `worktree_merge` enforces it again with diff-digest verification.
- **Git worktree isolation:** Parallel writers run in dedicated worktrees with base SHA, changed-path, and diff-digest provenance. Launch requires a clean source repository. Explicit `worktree_status`/`worktree_merge`/`worktree_remove` actions handle retained changes.
- **Typed Herdr client:** Structured envelopes/errors, abort/timeouts, capabilities, atomic `agent prompt`, agent waits, metadata reporting, classified transient retries, and symlink/ownership verification before cleanup.
- **Grouped completion:** `batch_id` + `join: "group"` coalesces nearby completions into one parent notification to prevent turn storms.
- **Scheduling & RPC v3:** Durable cron/one-shot schedules and cross-extension RPC with opaque recursive ownership scopes and descendant-first cancellation.
- **Recovery:** Allocating runs are rebound to the durable registry; terminal JSONL is reconciled after parent restart; file locks heartbeat with process-alive detection.
- **CI:** Node 20/24 matrix, Pi SDK minimum/latest compatibility, audit, pack, and package-install verification.

## Breaking changes

- **`herdr` → `task_control`:** The orchestration tool is renamed to avoid collision with `@ogulcancelik/pi-herdr`.
- **Review identity:** Arbitrary `orchestration_id` no longer counts as a review. Use real `reviewer_task_id` from a completed, verified, distinct reviewer task.
- **Evidence authority:** Handoff evidence strings no longer satisfy proof gates. Use `record_evidence` for gate-authoritative evidence.
- **Write claims:** `kind: "write"` requires `mode: "exclusive"` and a project-relative path.
- **Worktree launch:** Requires a clean source repository (no uncommitted changes).
- **Telemetry opt-out:** `PI_SUBAGENTS_NO_TELEMETRY=1` no longer suppresses the event journal.

## Upgrade

```bash
pi remove npm:@heyhuynhgiabuu/pi-task  # if upgrading from the upstream fork
pi install npm:@minhduydev/pi-subagents@0.5.0
```

Requires Pi `0.81.1+`, Node.js `20+`. Optional: Herdr `0.7.5+` or tmux. Git required for worktree isolation.

See [`docs/migration-0.5.md`](docs/migration-0.5.md) for the full migration guide.

## Test results

- 163 tests pass (61 base + 102 orchestration)
- `tsc --noEmit` clean
- `npm audit` 0 vulnerabilities
- Package install test passes
- No `as any` in source

## Links

- [CHANGELOG](CHANGELOG.md)
- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
- [Herdr integration](docs/herdr-integration.md)
- [Migration guide](docs/migration-0.5.md)
- [Agent Skill](skills/pi-subagents/SKILL.md)