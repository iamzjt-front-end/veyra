# Veyra GUI Design Direction

> **Quiet confidence. Clear state. Smooth motion.**

Veyra should look and feel like a modern developer product, not an infrastructure console.

The visual experience is part of the product value: users should understand what ChatGPT, Veyra and Codex are doing without reading logs or deciphering workflow internals.

## Primary surfaces

1. **ChatGPT Side Panel** — primary daily surface.
2. **Local Control Center GUI** — deeper project/run/history/settings surface.
3. **CLI** — setup, init, diagnostics and automation.
4. **TUI** — not required for the roadmap.

## Side Panel information architecture

### Idle / ready

```text
Veyra                                  ● Ready

Project
veyra                                      ▾
~/Projects/veyra

ChatGPT ↔ Codex
Ready to work

[ Bind this conversation ]
```

### Active run

```text
Veyra                                ● Working

veyra
Implement project registry

Plan          ✓
Execute       ●  Codex
Verify        ○
Review        ○

Codex is editing 4 files
18s elapsed

[ Pause ]                    [ Details ]
```

### Review / repair

```text
Review                                ● Needs work

2 findings
Critical  1
Warning   1

Repair is ready to send to Codex

[ Send repair ]               [ Inspect ]
```

### Complete

```text
Completed                                  ✓

6 files changed
42 tests passed
Build passed

ChatGPT approved the result

[ View run ]                    [ Done ]
```

## Visual hierarchy

- use one dominant status per screen;
- project and current task are always identifiable;
- workflow progress is visible but not visually noisy;
- raw IDs and transport details are secondary/diagnostic;
- primary actions have one obvious location;
- secondary actions stay quiet until needed.

## Design tokens

Use semantic CSS variables shared across Side Panel and Control Center. The implemented source is `packages/ui/src/styles/index.css`. Light auxiliary text uses `#5F6962` (slightly stronger than the original suggested gray) so 10–12px text also meets AA contrast on the sage surface. Screenshot regression uses pinned fixture fonts only; production keeps the specified system/sans and monospace stacks.

Recommended groups:

```text
--surface-base
--surface-raised
--surface-subtle
--text-primary
--text-secondary
--text-muted
--border-subtle
--accent
--success
--warning
--danger
--focus
```

Do not encode product logic into literal colors.

## Typography

- UI: modern system/sans stack;
- code, paths, run IDs and diffs: monospace;
- avoid monospace for ordinary controls and status copy;
- prioritize strong spacing and line-height over tiny dense text.

## Dark and light mode

Both are first-class.

Dark mode must not be a simple inversion. Use layered surfaces and restrained contrast.

Light mode must not feel like an afterthought. Keep borders soft, backgrounds calm and status emphasis consistent.

## Motion system

Motion should communicate state, not decorate it.

Recommended durations:

- hover/press: 100–140 ms;
- micro state change: 140–180 ms;
- card/panel transition: 180–260 ms;
- larger layout transition: <= 320 ms.

Recommended easing:

- ease-out for appearing;
- ease-in for disappearing;
- restrained spring for user-driven repositioning only.

Avoid:

- infinite breathing/glow effects while idle;
- constant spinner animation when no work is happening;
- animating every incoming event;
- layout-shifting status changes;
- full-screen fades for routine transitions.

Respect `prefers-reduced-motion`.

## Workflow visualization

The workflow should be understandable in under one second.

Use compact states:

```text
✓ Plan  →  ● Execute  →  ○ Verify  →  ○ Review
```

For branching/repair later, expand progressively rather than rendering a large DAG by default.

The user should never need to understand workflow graph syntax just to know whether Codex is working.

## Activity feed

Use a calm timeline for meaningful milestones only:

```text
15:42  Plan accepted
15:42  Codex started
15:43  4 files changed
15:43  Tests passed
15:43  Review started
```

Do not stream raw stdout by default.

Diagnostics may expose detailed event/log output.

## Errors

Errors should answer three questions:

1. What happened?
2. Is my work safe?
3. What should I do next?

Bad:

```text
ECONNREFUSED 127.0.0.1:3181
```

Good:

```text
Veyra lost the local connection.
Your run is still saved in the Project.

[ Reconnect ]   [ Diagnostics ]
```

## Controls

Primary control vocabulary:

- Bind
- Start
- Pause
- Resume
- Cancel
- Review
- Repair
- Done

Avoid exposing infrastructure verbs like pairing, daemon, grant and dispatch in normal UI.

## Progressive disclosure

Default GUI:

- Project
- ChatGPT/Codex readiness
- workflow state
- current task
- run state
- primary action

Details:

- changed files
- verification
- review findings
- timing
- activity

Diagnostics:

- UUIDs
- native executable
- transport
- grants
- raw events
- log paths
- protocol payloads

## Side Panel implementation direction

Preferred:

- Chrome Side Panel API;
- React + TypeScript;
- shared design system package;
- event-driven state updates;
- no high-frequency DOM/status polling;
- small toolbar action only as launcher/status shortcut.

Suggested shared package:

```text
packages/ui/
├── components/
├── tokens/
├── icons/
├── motion/
└── primitives/
```

A component library should remain product-owned enough to preserve visual consistency. Accessible headless primitives may be used underneath.

## Local Control Center

The Control Center should feel like a richer extension of the same product, not a different dashboard template.

Implemented navigation:

```text
Overview
Projects
Runs
Settings
```

Project page:

```text
Project name / path
Current binding
Current run
Recent runs
Workflow
Agent readiness
```

Run page:

```text
Goal
Plan
Timeline
Changed files
Verification
Review
Artifacts
```

## Performance bar

Beautiful UI is not allowed to make the machine feel heavy.

Targets:

- idle Side Panel: effectively zero periodic work;
- no full conversation DOM scans while idle;
- updates are event-driven;
- avoid expensive blur/backdrop effects over large surfaces;
- avoid giant animation libraries or chart dependencies without need;
- preserve 60fps for normal panel interactions on supported hardware;
- keep run updates visually smooth without rerendering the full panel.

## Product quality bar

Before calling the GUI polished:

- light mode reviewed manually;
- dark mode reviewed manually;
- narrow and wide Side Panel widths reviewed;
- loading, idle, working, success, failure, paused and disconnected states designed;
- keyboard focus visible;
- reduced-motion tested;
- empty-state copy reviewed;
- no raw machine payload dominates normal use;
- no infrastructure step is required in the happy path;
- the user can tell what Veyra is doing within one glance.

The target feeling is simple: **Veyra should make complex agent coordination feel calm and obvious.**
