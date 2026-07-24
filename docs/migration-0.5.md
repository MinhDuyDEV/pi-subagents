# Migrating to 0.5

## Breaking changes

### `herdr` → `task_control`

The former orchestration tool name was misleading and conflicted conceptually with generic Herdr tools. Update model/tool allowlists and stored prompts to `task_control`.

### Review identity

Old calls that supplied arbitrary `orchestration_id` no longer count:

```diff
 { "action": "review", "task_id": "producer",
-  "orchestration_id": "review-anything", "verdict": "approved" }
+  "reviewer_task_id": "actual-completed-review-task", "verdict": "approved" }
```

### Release ownership

`release` requires `task_id`; `lease_id` is optional and, when supplied, must match that task's durable lease.

### Write claims

`kind: "write"` now requires `mode: "exclusive"` and a project-relative path. Use a named `test` or `evidence` claim for non-path resources.

### Telemetry opt-out

`PI_SUBAGENTS_NO_TELEMETRY=1` no longer suppresses `events.jsonl`. The event journal is mandatory local correctness state; the opt-out strips optional usage/performance fields.

### Evidence authority

Handoff evidence is context only. A proof gate now requires runtime-bound evidence: either the canonical Pi session (auto-bound by the completion hook) or a typed receipt from `record_evidence`. Self-declared `evidence` strings in a handoff no longer satisfy `evidence-only` proof.

### Worktree merge

Retained worktree changes are not auto-merged. Use `task_control worktree_merge` after `ship` passes; the merge verifies the current diff digest matches the approved snapshot. Use `worktree_remove` to explicitly discard retained changes.

### Worktree launch

Worktree isolation now requires a clean source repository (no uncommitted changes). Commit or stash before launching an isolated writer.

### Terminal phase immutability

Once a task reaches `completed`, `failed`, `cancelled`, or `timeout`, its execution phase cannot be reverted. A late or replayed completion hook cannot resurrect a terminal run.

## State migration

No destructive migration is required. Existing task registry/history and Context Packs remain readable. Version `0.5` creates `runs.json` and `schedules.json` lazily. Old in-flight tasks without a run record continue through the base registry; their completion is forwarded without inventing verification state.

For clean testing:

```bash
pi remove npm:@minhduydev/pi-subagents
pi install npm:@minhduydev/pi-subagents
```

Do not delete `.pi/artifacts/tasks/` if durable conversations or retained worktrees are still needed.

## Recommended adoption

1. Upgrade Pi and Pi TUI to `0.81.1+`.
2. Run `/task-doctor`.
3. Convert parallel writers to `isolation: "worktree"`.
4. Add explicit `batch_id` for grouped joins.
5. Replace review calls with real reviewer task IDs.
6. Install the optional attention plugin only after the core runtime works in Herdr.
