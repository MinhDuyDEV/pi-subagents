# @minhduydev/pi-subagents v0.10.1

This patch makes reviewer and other non-success task outcomes explicit and retrievable instead of presenting them like subagent runtime crashes.

## Highlights

- **Retrievable blocking reviews:** `task_control result` now returns valid child-reported failure, partial, blocked, reframed, and unknown results. The success proof gate still protects success claims, but no longer hides a review that deliberately says “do not ship.”
- **Clear completion messaging:** background review failures now say that the task completed with blocking findings, direct the parent to `task_control result`, and explain that verification and shipment were not advanced.
- **Regression coverage:** focused tests lock both result retrieval and notification behavior.

## Compatibility

- Pi `0.81.1+`
- Node.js `22.19.0+`
- No API migration is required from `0.10.0`.

## Verification

- `npm run check`
- 67 base tests passed
- 255 orchestration tests passed
- TypeScript build and package install checks passed
- Production audit reported zero vulnerabilities

## Links

- [CHANGELOG](CHANGELOG.md)
- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
