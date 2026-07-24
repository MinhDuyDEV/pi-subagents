# Herdr integration

## Compatibility

- Herdr `0.7.5+`
- Pi `0.81.1+`
- Required environment inside a managed pane: `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`

`herdr integration install pi` improves Herdr's native Pi lifecycle/session detection but is not required for spawning `--kind pi`.

## Launch sequence

1. Validate Herdr environment and control plane.
2. Create/split an owned pane or grouped workspace with `--no-focus`.
3. Start a unique Pi agent with `herdr agent start ... --kind pi --pane ... -- <argv>`.
4. Submit the task with atomic `herdr agent prompt`.
5. Report `task_id`, `task_phase`, `task_agent`, and `task_parent` metadata from source `pi-subagents`.
6. Start `agent wait`; use its settled/blocked status to trigger JSONL reconciliation.
7. Show a Herdr toast when the task settles.
8. Verify socket, pane and terminal identity before cleanup.

## Failure policy

| Failure | Behavior |
|---|---|
| not inside Herdr | auto may use tmux/SDK |
| Herdr binary absent | auto may fall back |
| socket/server transient outage | bounded classified retry, then visible failure |
| invalid CLI arguments/permanent error | no retry |
| status `unknown` | uncertain, never success |
| wait/subscription interrupted | reconnect through periodic reconciliation |
| pane ID reused with different terminal ID | ownership mismatch; do not control/close |

## Grouping

Groups are namespaced by socket, parent pane and group label. The first task creates an owned workspace root; later tasks stack downward. Group state is a cache only—persisted handles remain the cleanup authority after restart.

## Coexistence with `@ogulcancelik/pi-herdr`

This package registers `task` and `task_control`. It does not register generic `herdr_layout`, `herdr_pane`, or `herdr_agent`, so both packages can be installed together.

## Optional attention broker

The plugin in `herdr-plugin/attention-broker/` listens to settled/blocked/exited events, persists and deduplicates them by named-session socket, and atomically prompts the supervisor named `Root`. It is a wake-up bridge only; the task kernel and Pi JSONL remain authoritative.

```bash
herdr plugin link ./node_modules/@minhduydev/pi-subagents/herdr-plugin/attention-broker
```

Configure `root_name` and `dedupe_window_ms` in the plugin config directory when needed.
