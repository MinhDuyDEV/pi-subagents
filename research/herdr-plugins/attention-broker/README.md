# Herdr Attention Broker

Local event-driven prototype for Herdr engineering rooms. It listens for agent
status events and wakes the seat named `Root` once when another agent becomes
idle, done, or blocked.

The plugin does not poll, run a model, inspect project files, or decide whether a
checkpoint should be accepted. Events are persisted before delivery and submitted
to Root with `pane run`; a busy Codex Root consumes them at its next message
boundary. Failed deliveries remain queued and are retried when Root next reports
idle or done. Runtime state is namespaced by the named session socket, so linked
rooms cannot deduplicate or deliver one another's events even when their workspace
and pane IDs overlap.

Link it into a named room:

```bash
herdr --session Fantasy plugin link /mnt/d/agent-workflow/herdr-plugins/attention-broker
```

Optional config lives at the directory printed by:

```bash
herdr --session Fantasy plugin config-dir local.attention-broker
```

Example `config.json`:

```json
{
  "root_name": "Root",
  "dedupe_window_ms": 5000
}
```

Inspect queued events and plugin command results with:

```bash
herdr --session Fantasy plugin action invoke local.attention-broker.status
herdr --session Fantasy plugin log list --plugin local.attention-broker
```

This first slice intentionally has no periodic deadline. It replaces completion
polling; a later slice may add a deterministic reassessment timer if live room
evidence shows it is necessary.
