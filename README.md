# Agent Tools 

This folder contains custom **skills** and **extensions** that enhance Pi for everyday coding work.

## Skills

Skills are instruction packs Pi can load when a task matches a specific workflow.

- **github** — Guidance for working with GitHub via `gh` (issues, PRs, CI runs, API queries).
- **interactive-shell** — Best practices for delegating to interactive coding CLIs (pi, Claude, Gemini, Codex, etc.).
- **uv** — Python workflows with `uv` (`uv run`, `uv add`, script metadata).

## Extensions

Extensions add tools, commands, UI, and automations inside Pi.

- **annotate** — Visual UI annotation in Chrome (select elements, attach comments, include screenshots).
- **browser** — Browser automation and inspection in a managed Chrome session.
- **copy** — Quickly copy code snippets from the conversation.
- **files** — File picker and quick file actions.
- **format** — Automatic post-edit formatting/lint-fix for supported files.
- **handoff** — Generate a focused handoff prompt for a fresh session.
- **interactive-shell** — Supports interactive terminal commands from Pi.
- **plan-mode** — Plan creation and execution workflow support.
- **powerline** — Enhanced statusline/welcome UI plus themed “working vibe” messages.
- **review** — Structured code review workflows.
- **session-breakdown** — Interactive session usage breakdown (activity, tokens, cost).
- **telegram** — Bridge a Pi session to Telegram (topic-based flow).
- **todos** — File-based todo/task management.
- **web-access** — Web search + URL/content retrieval tools.

## Package layout

This repository is installed as a single Pi package:

```bash
pi install https://github.com/cameronmaske/agent-stuff
```

Pi lists it as one package source, but the root `package.json` exposes multiple resources via the `pi` manifest:

- `extensions/` → extension entrypoints
- `skills/` and `extensions/web-access/skills/` → skills
- `themes/` → custom themes such as `mono-dark-flat`

Runtime dependencies are managed through npm workspaces. After clone/update, Pi runs `npm install` from the package root, so nested extension dependencies do not need committed `node_modules/` directories.
