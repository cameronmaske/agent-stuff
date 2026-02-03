---
name: ruff-review
description: Run Ruff on a folder, list lint issues, and guide a fix-or-ignore review flow with the user.
---

# Ruff Review

Run Ruff against a selected folder, present a numbered list of findings, and guide an interactive flow where the user decides whether to fix or ignore each issue.

## Requirements

- `ruff` installed and on PATH (`pipx install ruff` is a common setup).
- `uv` is recommended for running the helper script (optional if you prefer `python`).

## Run Ruff and List Issues

```bash
uv run {baseDir}/scripts/ruff_report.py <path> --save .ruff-issues.json
# or
python {baseDir}/scripts/ruff_report.py <path> --save .ruff-issues.json
```

- `<path>` can be a folder or a single file.
- `--save` writes raw JSON issues so you can reference details later.
- `--config path/to/pyproject.toml` if you need a custom config.

## Interactive Review Flow

1. **Run the report** using the command above.
2. **Present the numbered list** to the user.
3. Ask for actions using a clear prompt, for example:
   - "Fix 1-3 and 7"
   - "Ignore 4"
   - "Skip for now"
4. **Fix path**
   - Prefer manual edits for targeted fixes.
   - If the issue is marked as `(fixable)` and the user approves auto-fix, you may run:
     ```bash
     ruff check <path> --fix --select <CODE>
     ```
     This may fix other occurrences of the same code; confirm scope with the user first.
5. **Ignore path**
   - Ask which ignore style they want:
     - Inline: add `# noqa: <CODE>` on the flagged line.
     - Config-level: add a `per-file-ignores` entry in `pyproject.toml` or `ruff.toml`.
6. **Re-run** the report to confirm remaining issues.

## Output Format

The helper script prints results like:

```
1. src/app.py:12:5 F401 `os` imported but unused (fixable)
2. src/app.py:88:1 E501 line too long (88 > 79 characters) (manual)

Total issues: 2 (fixable: 1)
```

Use the numbering to map user selections to specific issues.
