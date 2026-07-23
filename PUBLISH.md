# Publishing @minhduydev/pi-subagents

Phase 4. The package is built, tested, and locally smoke-tested. The remaining steps need your npm + GitHub credentials (cannot be done from this session).

## State (verified 2026-07-23)
- Built: `dist/task-runtime.js` (entrypoint) + 14 orchestration modules. `tsc` clean.
- Tests: 58/58 base + 40/40 orchestration + 4/4 pane-retry = **98 pass, 0 fail**.
- Tarball clean (`npm pack --dry-run`): ships only `dist/` + `README.md` + `LICENSE`. **No** `agents/`, no `.pi/APPEND_SYSTEM.md`, no `node_modules`, no `package-lock.json`, no `harness-policy`.
- Smoke: `dist/task-runtime.js` loads, default export is a function, registers `task` + `herdr` tools (orchestration wired).
- Runtime-only: ships 0 agent profiles; agents resolve from the consumer's `.pi/agents/`.

## 1. Create the GitHub repo + push
```bash
cd /Users/minhduydev/workspace/pi-subagents
# origin is already set to https://github.com/MinhDuyDEV/pi-subagents.git
# upstream is set to heyhuynhgiabuu/pi-task (for future sync)
git remote -v          # confirm
git push -u origin main      # after you create MinhDuyDEV/pi-subagents on GitHub (empty, no README)
```

## 2. Publish to npm
```bash
cd /Users/minhduydev/workspace/pi-subagents
npm login                       # as MinhDuyDEV (scope owner)
npm publish --access public     # publishes @minhduydev/pi-subagents@0.1.0
npm view @minhduydev/pi-subagents version   # confirm 0.1.0 is live
```

## 3. Install into pi-harness (pikit) + verify
pi-harness `.pi/settings.json` is already rewired to `npm:@minhduydev/pi-subagents@0.1.0` (Phase 3).
```bash
cd /Users/minhduydev/workspace/pi-harness
pi install -l npm:@minhduydev/pi-subagents@0.1.0   # -l = project-local
pi list --approve                                    # confirm source registered
```
Then restart Pi and run an end-to-end smoke:
- **Foreground delegation:** `task` with `agent_type: "reviewer"`, read-only prompt → expect a result.
- **Claims:** a `task` with `orchestration.claims: [{kind:"write",resource:"src/x",mode:"exclusive"}]` → expect lease acquired; a second overlapping `write` claim → expect it blocked.
- **Pane-retry:** fan out 5+ foreground `task` calls in one message → expect **no** `Failed to create herdr execution pane` (claims serialize + pane-retry recovers). Set `PI_SUBAGENTS_PANE_RETRIES=0` to confirm retry can be disabled.
- **Opt-outs:** `PI_SUBAGENTS_NO_CLAIMS=1` → claims skipped; `PI_SUBAGENTS_NO_PROOF=1` → proof gate skipped; `PI_SUBAGENTS_NO_TELEMETRY=1` → no `.pi/artifacts/tasks/orchestration/` events.
- **Runtime-only:** confirm pi-subagents ships no agents — your `.pi/agents/*.md` (explore/general/reviewer/scout, ollama pins) are what delegation uses.
- **No policy injection:** confirm pi-subagents does not touch your system prompt / `APPEND_SYSTEM.md` (additive kernel).

## 4. Keep in sync with upstream pi-task
```bash
cd /Users/minhduydev/workspace/pi-subagents
git fetch upstream
git merge upstream/main          # re-apply the overlay (orchestration + pane-retry + opt-outs)
npm install && npm run build && npm test   # resolve any conflicts, re-verify
```
Keep `vendor`/overlay edits minimal and isolated so rebase is clean. The pane-retry patch lives in `src/subagent/herdr.ts` (`runWithRetry` + 3 wrapped calls) — re-apply if `herdr.ts` changes upstream.

## 5. Versioning
- `0.1.0` — initial: runtime + orchestration + pane-retry + opt-outs.
- Bump on upstream-pi-task re-syncs (minor) and on new orchestration features (minor/patch per semver).
- pi-harness pins the exact version in `.pi/settings.json`; bump there after publish.