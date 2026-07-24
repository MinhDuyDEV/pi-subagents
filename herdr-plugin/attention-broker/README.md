# Pi Subagents Attention Broker

Optional Herdr `0.7.5+` companion plugin. It coalesces `idle`, `done`, `blocked`, exited, and closed events for delegated panes, persists them before delivery, then atomically prompts the supervisor agent named `Root`. It never runs a model or polls task output.

## Install

From the installed npm package directory:

```bash
herdr plugin link ./herdr-plugin/attention-broker
```

For a named Herdr session:

```bash
herdr --session <name> plugin link ./herdr-plugin/attention-broker
```

Optional `config.json` in the plugin config directory:

```json
{
  "root_name": "Root",
  "dedupe_window_ms": 5000
}
```

Inspect state:

```bash
herdr plugin action invoke minhduydev.pi-subagents-attention.status
herdr plugin log list --plugin minhduydev.pi-subagents-attention
```

The task runtime remains authoritative: Herdr events only wake reconciliation; Pi session JSONL and the durable task store decide completion.
