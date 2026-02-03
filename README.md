# Pi Agent Tools

## Skills

- brave-search — Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content. Lightweight, no browser required.
- browser-tools — Interactive browser automation via Chrome DevTools Protocol from WSL to a Windows Chrome instance. Use when you need to interact with web pages, test frontends, or when user interaction with a visible browser is required.
- github — Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries.
- gt-split — Split a Graphite branch into multiple single-commit branches using `gt split`. Includes planning, TUI interaction guidance, and recovery procedures.
- interactive-shell — Cheat sheet + workflow for launching interactive coding-agent CLIs (Claude Code, Gemini CLI, Codex CLI, Cursor CLI, and pi itself) via the interactive_shell overlay. The overlay is for interactive supervision only - headless commands should use the bash tool instead.
- ruff-review — Run Ruff on a folder, list lint issues, and guide a fix-or-ignore review flow with the user.
- uv — Use `uv` instead of pip/python/venv. Run scripts with `uv run script.py`, add deps with `uv add`, use inline script metadata for standalone scripts.

## Extensions

- copy-code — Copy code blocks from the conversation to the clipboard (picker + optional hints).
- files — `/files` and `/diff` picker to browse repo files and run quick actions (open, reveal, edit, diff).
- handoff — Generate a focused prompt to continue work in a new session.
- interactive-shell — Run interactive `!` commands with full terminal access while the TUI suspends.
- oracle — Ask a secondary model for a second opinion (optionally with file context).
- plan-mode — Plan manager with `/plan` UI, planning mode, and `.pi/plans` storage.
- post-edit-format — Auto-format files after edits (ruff for Python, biome for frontend).
- review — `/review` workflows for PRs, branches, commits, or uncommitted changes.
- todos — File-based todo manager with `/todos` UI and tool API.
- pi-annotate — Visual UI annotation via Chrome extension + `/annotate` (fork of https://github.com/nicobailon/pi-annotate, adapted for WSL with Chrome on Windows).
- powerline-footer — Powerline-style status bar, welcome overlay, and AI-generated “working vibes” (customized fork of https://github.com/nicobailon/pi-powerline-footer that works with https://www.npmjs.com/package/@marckrenn/pi-sub-core).
