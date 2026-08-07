# @minhduydev/pi-subagents v0.12.0

This release adds multi-repository task execution, hardened HerdR admission/identity handling, and a bounded public task-provenance replay port for harness recall.

## Highlights

- **Multi-repo execution:** explicit canonical `cwd` flows through SDK, tmux, HerdR, durable resume identity, claims, evidence, and worktree isolation without mixing parent-control and workspace roots.
- **Launch hardening:** same-identity launches serialize, replacement-agent checks fail closed, and HerdR retries require an observed lifecycle transition.
- **Public replay boundary:** `@minhduydev/pi-subagents/replay` exposes newest-first, path-free task provenance with realpath ownership checks and a hard 200-entry limit. It does not expose session references, worktree paths, claims, or issue text.

## Compatibility

- Pi `0.84.x`
- Node.js `22.19.0+`
- Existing durable records without workspace fields remain readable; legacy unscoped leases retain conservative global semantics.

## Verification

- `npm run check`
- 86 base tests passed
- 269 orchestration tests passed
- TypeScript build and package install checks passed
- Production audit reported zero vulnerabilities

## Links

- [CHANGELOG](CHANGELOG.md)
- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
