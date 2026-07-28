# Changelog

All notable changes to `@minhduydev/pi-subagents` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.10.0] - 2026-07-28

### Added
- Public `herdr_layout: "attached"` task option for keeping the parent pane in the left 50% while grouped child tasks occupy an adaptive grid in the right 50%.
- Herdr backend tests covering dedicated and attached grids, concurrent grouped launches, stale-pane recovery, restored handles, and cleanup that preserves the parent workspace.

### Changed
- Dedicated Herdr `workspace_group` workspaces now use a balanced grid: one task fills the workspace, two are side-by-side, three use a balanced split, and four form a 2x2 grid. Additional tasks continue splitting the shallowest available cell.
- Herdr group identity and restored handles now retain layout mode so dedicated and attached groups with the same label cannot collide.

### Fixed
- Repeated grouped launches no longer collapse into an increasingly short vertical pane stack.
- Attached-group cleanup closes only owned child panes and never closes the parent workspace.

## [0.9.0] - 2026-07-27

Hardening of the durable orchestration kernel: the run store is now
compare-and-set fenced on terminal results and unique-constrained on
decision-resume correlations, resource leases carry an `expectedFence` on
acquire/release/transfer, and the proof gate binds evidence to a
`resultDigest`. A new independent review gate and a semantic-attestation
evidence module join the kernel. The contract change consumes the new
`@minhduydev/pi-core` 0.2.0 workflow and task-lifecycle modules, so the
peer range moves to `^0.2.0`.

### Added
- `review` orchestration: an independent review gate bound to a settled run, with its own durable state and verdict.
- `evidence` module: `SemanticAttestationV1` evidence and proof substantiation bound to the run's `resultDigest`.
- Multi-process contention fixtures (`test/orchestration-store-contention.test.ts` + `test/fixtures/store-contention-worker.ts`) that spawn real child processes racing the same lease, run, and decision-resume stores — proving mutual exclusion, the terminal-result CAS fence, and the durable-invocation unique constraint under genuine inter-process concurrency, not just `Promise.all` serialization.

### Changed
- `run-store`: terminal execution results are compare-and-set fenced on `resultDigest` (a second completion with a different digest throws `Conflicting terminal result`), and a durable invocation is unique-constrained by decision-resume correlation (a second resume for the same correlation throws `already has a durable invocation`).
- `claims`: lease acquire/release/transfer now carry an `expectedFence` so a stale lease ID is rejected before it mutates the store.
- `proof`: the proof gate attests against the run's `resultDigest` so evidence cannot be replayed against a different terminal result.
- Peer dependency `@minhduydev/pi-core` moved from `^0.1.0` to `^0.2.0` to consume the workflow and task-lifecycle contracts.

## [0.8.1] - 2026-07-27

Redesign of the task-giving language layer: the subagent stays an independent problem-solver (anti pre-solve/worker-ization). The evidence/proof/review kernel (leases, fencing, proof gate, review binding) is semantically unchanged.

### Added
- `reframed` as a first-class reported status in the result envelope (`<status>reframed</status>`): the delegated framing was wrong and the agent delivered the corrected framing. Surfaced to the parent as a valid outcome, not a failure. All prior statuses parse unchanged.
- Optional `<needs_decision>` result tag: a disputed premise or a parent-only decision with options and tradeoffs. Parsed into `ParsedResult.needs_decision`, exposed in completion details and the task result UI. No agent is required to use it.
- Optional `orchestration.context.disclosure: "blind-first"`: seals `known_facts`/`decisions` behind a "Sealed context — open AFTER you have written your own 5-line read of the problem" block placed after the goal, frontier, and policy. Default keeps the previous inline rendering. The option is render-time only and is not persisted in the Context Pack.
- Test locking the child write-claim guard's deliberate no-fence-check behavior: ownership against the live store is the enforced property, since the parent renews/transfers the lease on the child's behalf.

### Changed
- Governed-outcome prompt contract in the `task` tool description and prompt schema: Outcome (observable behavior, not an implementation), Frontier (what the agent owns deciding), Locked decisions (each with rationale and an unlock condition), Acceptance (what evidence would convince a skeptic; the agent chooses how), plus the existing non-goals and write/read policy. Parents are told not to hand the agent a verification recipe, a chosen architecture, or pre-named acceptance criteria unless genuinely locked.
- Anti-Goodhart child rendering: `context.claims` are no longer rendered into the child prompt (they stay in the data model and are enforced verifier-side by the proof gate), and `next_step` renders as "Suggested entry point (optional, non-binding)".
- `expectedOwner` is now REQUIRED on `releaseResourceLease` and `transferResourceLeaseOwnership`; all runtime call sites pass the owner recorded on the lease they hold. System-side reaping of dead owners remains `releaseOrphanedLeases`, which proves liveness instead of ownership.
- The launch-time lease heartbeat routes a failed renewal through the same `abandonLostLease` path as the main heartbeat (durable `blocked` phase, `claim_lease_lost` event, lease-lost notification) instead of returning silently.
- The doctor's delegation-contract check accepts the governed-outcome dialect (`Outcome`/`Acceptance`) alongside the legacy recipe dialect (`Goal`/`Expected output`/`Stop condition`/`Verification recipe`).
- README and the packaged `pi-subagents` skill document the governed-outcome contract, `reframed`, `needs_decision`, and blind-first disclosure.

## [0.5.0] - 2026-07-23

### Added
- Durable `runs.json` task kernel with separate execution, verification, and review phases; active orchestration now restores across parent-session restart instead of depending only on an in-memory map. Terminal execution phases are immutable — a completed/failed run cannot be resurrected or rewritten.
- Runtime-generated invocation ownership IDs, lease heartbeat/renewal with adaptive intervals, safe orphan reaping from durable state, and validation that write claims are exclusive and project-relative.
- Git worktree isolation for task writers, including base SHA, retained branch/path, changed paths, and SHA-256 diff/content provenance. Unchanged worktrees are removed automatically. Worktree launch requires a clean source repository so local edits cannot be silently omitted.
- Explicit `worktree_status`, `worktree_merge` (only after verification and review gates pass, with diff-digest verification), and `worktree_remove` actions in `task_control`.
- Typed `HerdrClient` with structured envelopes/errors, abort/timeouts, capabilities, atomic agent prompts, agent waits, worktree/metadata helpers, transient classification, and pane metadata reporting. Launch commands propagate abort signals and timeouts.
- Event-driven Herdr wake-up layered over JSONL completion truth, Herdr completion notifications, parent/session-namespaced workspace groups, and vertical stacking for grouped panes. Stale grouped workspace panes are pruned before reuse.
- Grouped background completion (`batch_id` + `join: group`) and versioned lifecycle events with exported payload types.
- Durable cron/one-shot scheduling via `croner`, `/task-schedules`, and `/task-unschedule`. Schedule records are validated on read.
- Cross-extension RPC protocol v3 with opaque recursive ownership scopes, descendant-first cancellation, and bounded settled-stop replies.
- Human task commands: `/tasks` (with interactive selection in TUI), `/task`, `/task-result`, `/task-steer`, `/task-stop`, `/task-doctor`, and `/task-metrics`.
- Public `@minhduydev/pi-subagents/api` subpath for lifecycle/RPC constants, typed event maps, run-state types, transition guards, worktree merge helpers, `TaskScheduler`, evidence receipt helpers, and the typed Herdr client.
- Optional cross-platform Herdr attention-broker plugin under `herdr-plugin/attention-broker/`.
- Packaged Agent Skill under `skills/pi-subagents/` with progressive-disclosure workflow/reference docs and a local state inspection script.
- Runtime-bound evidence authority: `record_evidence` creates typed receipts with producer identity, observation time, artifact SHA-256, claim binding, and exit code. Self-declared handoff evidence cannot satisfy a proof gate.
- Idempotent correctness events with durable keys prevent duplicate completion/release/review/ship records across restarts.
- Allocating-run recovery: non-terminal durable runs without a task ID are conservatively rebound to a unique matching durable registry entry at `session_start`.
- Terminal JSONL reconciliation: after a parent restart, completed/failed tasks discovered in the Pi session JSONL are settled and forwarded before the parent resumes polling.
- Symlink escape guards for evidence artifacts, context references, and parent write-claim guards.
- File-lock heartbeat with process-alive detection and bounded busy-retry to prevent stale-lock theft under long operations.
- Launch-event-driven task identity binding: the base task tool emits a hidden `__pi_subagents_invocation_id` that the wrapper correlates to durable state before the upstream result returns.
- Doctor resilience: corrupt run/event/lease/context stores produce scoped error issues instead of crashing the doctor.
- CI workflow with Node.js 20/24 matrix, Pi SDK minimum/latest compatibility, audit, pack, and package-install verification tests.
- Integration tests for durable state, worktrees, merge/removal, scheduler, RPC v3, typed Herdr errors, lease heartbeat, child isolation, file-lock heartbeat, recovery, terminal-phase immutability, event idempotency, and real Pi `tool_call` write guarding.

### Changed
- Renamed the orchestration companion tool from misleading `herdr` to `task_control`; generic Herdr control remains owned by `@ogulcancelik/pi-herdr`.
- Background completion is now delayed until execution outcome and verification are persisted. Verification failure cannot race behind an already-delivered success notification.
- Execution failure/cancellation/timeout, verification failure, and awaiting review are no longer conflated as one `task_failed` state.
- Independent reviews now require a real completed reviewer task (that passed its own verification), a distinct runtime identity, the configured reviewer profile, and the current subject-session/worktree/evidence digest. Caller-supplied orchestration IDs no longer establish independence. Verdicts are immutable per subject digest.
- Shared-working-tree `git status` is no longer used for task attribution. Changed-path claim checks consume worktree completion receipts.
- Pi built-in write protection now uses the global `tool_call` event instead of a proxy that could only observe the upstream task extension's own registrations. Symlink escapes are blocked while leases are active.
- `PI_SUBAGENTS_NO_TELEMETRY=1` suppresses optional metrics but preserves the mandatory correctness journal.
- Child Pi mode registers no task control plane, commands, RPC, schedules, timers, or parent write guard.
- HerdR steering now uses atomic `agent prompt` instead of raw `send-text` plus delayed Enter.
- Herdr allocation retries only classified transient failures; permanent CLI/validation failures fail immediately with their cause.
- Unified source schemas on Pi's `typebox` package and removed all source-level `any` casts from SDK boundaries.
- Raised package version to `0.5.0`, aligned development testing with Pi/TUI `0.81.1`, added Node.js `>=20`, upgraded Vitest, and ships skill/plugin assets in the tarball.

### Fixed
- Background execution failures being recorded as orchestration successes.
- Foreground/background/result-query paths validating different evidence sets.
- Proof/review hooks deleting in-memory state before durable processing could retry.
- Long-running tasks silently losing leases after the initial TTL.
- Two roots sharing a Herdr socket and workspace-group string colliding in process-local group state.
- `task_control` accidentally being available inside child Pi processes.
- False unclaimed-write findings caused by pre-existing or concurrent dirty paths.
- Self-authored evidence strings passing proof gates without runtime-verified artifact bindings.
- Duplicate completion/ship/review events after parent restart.
- Terminal runs being resurrected to a non-terminal phase by a late or replayed completion hook.
- Stale file locks being stolen from live long-running operations.
- Doctor crashing on a corrupt run/event/lease/context store instead of reporting a scoped error.

## [0.4.0] - 2026-07-23

### Added
- **Semantic proof-audit (Herdr §6.3):** evidence must substantiate a claim, not just exist. `ContextEvidence` gains an optional `claim` field (the producer tags which claim each evidence proves); `ContextPack` gains a `claims` list (the claims that must be proven). `validateEvidenceOnlyProof` now runs `validateSubstantiation`: every claim must have ≥1 bound evidence, and for file-reference evidence the file content must contain a significant token from the claim (deterministic, no LLM). Opt-in via `claims` — empty/absent preserves existing presence/freshness/locality behavior.
- **Ship-gate + verifier (Herdr §7):** a task declaring `verifier: { required: true, minReviews?: n }` cannot complete as proven until ≥ `minReviews` (default 1) independent reviews are recorded from a different `orchestrationId`. New `herdr review` (record a `task_reviewed` event) and `herdr ship` (count independent reviews → `task_shipped` or `task_ship_blocked`) actions; `validateShipGate` runs at completion and blocks via the existing evidence-only-proof failure flow; the doctor reports `unverified-ship` for ship-blocked tasks. Opt-in via `verifier`.
- **Write-tool lease consultation (single-ownership at the tool layer):** `findClaimCoveringPath`/`assertNoConflictingWrite` in `claims.ts`. The parent's `edit`/`write` tools are wrapped to block writes into a path covered by another task's active write/test lease (prevents the parent clobbering a subagent's in-progress work); skips when there are no active leases or `PI_SUBAGENTS_NO_CLAIMS=1`, and degrades gracefully on store-read errors. `auditWriteClaims` (new `write-claims.ts`) does a post-hoc `git diff`-vs-lease-claims audit at completion → `unclaimed-write` issues + doctor report. Subagent-side write interception is infeasible (the upstream task tool owns the subagent's tool set), so parent-side guarding + post-hoc audit are used instead.

### Changed
- `recordForegroundCompletion`/`recordBackgroundCompletion` thread `claims` into `validateEvidenceOnlyProof` and merge ship-gate + write-claim audit failures into the proof result (so a pending review or an out-of-claim write blocks completion). The background proof-failed message now fires for any invalid proof, not only when completion `details` are present.

## [0.3.0] - 2026-07-23

### Added
- `herdr action=reap` releases orphaned resource leases — active leases whose owner task is no longer alive (no `task_started`/`task_resumed` within the stale window, or already terminal) — instead of waiting for TTL expiry (Herdr §16.3 — handle abandoned locks on crash/freeze/compact). Backed by `releaseOrphanedLeases` in `claims.ts`.

### Changed
- `validateCeremony` now requires a VERIFIABLE `uniqueValue` (an existing artifact path or a content hash) and flags non-verifiable values at ERROR severity (was a WARNING-level non-empty-string check). A warning-level non-empty-string check is itself the ceremony Herdr §11.3 warns against; ceremony must justify itself with real proof. **Breaking for callers** whose `ceremony_steps` use descriptive-string `uniqueValue`s — point them at a real artifact path or hash, or remove the step.

## [0.2.0] - 2026-07-23

### Added
- Default evidence-only proof for `write-approved`/`sensitive-approved` tasks: when no explicit `orchestration.proof` is passed, completion now runs `validateEvidenceOnlyProof` automatically (the Herdr curriculum's core guarantee). The `PI_SUBAGENTS_NO_PROOF` escape is no longer honored for write tasks using the auto-default — it cannot silently disable the guarantee. It is still honored for non-write tasks and for callers who pass an explicit `proof` policy.

### Changed
- `herdr result` (`taskFinalResult`) re-runs `validateEvidenceOnlyProof` for write/sensitive tasks and surfaces a "Claim not proven by evidence" message (with the specific issues) instead of the raw subagent self-report when proof fails. Non-write, explicit-opt-out, and legacy tasks return the raw result unchanged. Re-validation uses the task's completion-event timestamp to avoid false staleness; falls back to the raw result on any error.

### Fixed
- `herdr doctor` no longer false-positives on additive/external-package consumers. `validateRuntimeParity` recognizes `.pi/settings.json` `packages`-style integration (a `packages` entry matching `@minhduydev/pi-subagents` or `/pi-subagents/`) and treats the runtime as externally provided, so `runtime-wrapper-missing` and `packaged-runtime-drift` are not flagged for consumers that load the runtime via the pinned package. Embedded-source checks are preserved for repos that use that pattern. `readJson` now tolerates `SyntaxError` (corrupt settings/manifest) in addition to `ENOENT`.

## [0.1.0] - 2026-07-23

### Added
- Runtime-only delegation package: `task` tool (foreground/background, HerdR/tmux/SDK backends).
- Machine-checkable orchestration: resource claims/leases (`write`/`test`/`evidence`, exclusive/shared, hierarchical conflict), Context Pack + handoff (provenance, SHA-256, secret redaction, out-of-repo rejection), evidence-only review, orchestration doctor, local telemetry.
- `herdr` companion tool: `status`/`result`/`handoff`/`metrics`/`doctor`/`record_review`/`release`.
- Opt-out envs: `PI_SUBAGENTS_NO_CLAIMS`, `PI_SUBAGENTS_NO_PROOF`, `PI_SUBAGENTS_NO_TELEMETRY`.

### Changed
- Runtime-only: no bundled agent profiles; agents resolve from the consumer's `.pi/agents/`.
- `peerDependencies` floor: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `>=0.81.1`.
- Additive kernel: never injects policy into a consumer's system prompt.

### Removed
- Bundled starter agents (`scout`, `explore`, `general`, `reviewer`) — owned by consuming repos now.