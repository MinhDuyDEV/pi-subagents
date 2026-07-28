# @minhduydev/pi-subagents v0.10.0

This release improves Herdr pane ergonomics with balanced grouped-workspace grids and an opt-in attached-parent layout.

## Highlights

- **Balanced dedicated workspaces:** `workspace_group` now lays out one task full-screen, two side-by-side, three in a balanced split, and four as a 2x2 grid instead of stacking every task downward.
- **Attached parent grid:** set `herdr_layout: "attached"` together with `workspace_group` to keep the parent in the left 50% and arrange child tasks inside the right 50%.
- **Safe lifecycle:** attached groups preserve parent focus, close only owned child panes, restore their layout mode across handles, recover from stale panes, and never close the parent workspace.
- **Compatible fallbacks:** tmux and SDK behavior is unchanged; calls without `herdr_layout` retain dedicated-workspace grouping.

## Usage

Dedicated balanced workspace:

```json
{
  "workspace_group": "feature-auth"
}
```

Attached grid beside the parent:

```json
{
  "workspace_group": "feature-auth",
  "herdr_layout": "attached"
}
```

## Compatibility

- Pi `0.81.1+`
- Node.js `22.19.0+`
- Herdr `1.1.0+` for attached pane ratios

No migration is required. Existing `workspace_group` callers retain their dedicated workspace lifecycle; only the internal pane arrangement changes from vertical stacking to a balanced grid.

## Verification

- 27 test files passed
- 253 tests passed
- `tsc --noEmit` clean
- Package dry-run includes runtime, docs, skill, and Herdr plugin assets

## Links

- [CHANGELOG](CHANGELOG.md)
- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
- [Herdr integration](docs/herdr-integration.md)
- [Agent Skill](skills/pi-subagents/SKILL.md)
