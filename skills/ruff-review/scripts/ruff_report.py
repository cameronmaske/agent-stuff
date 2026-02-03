#!/usr/bin/env python3
"""Run ruff on a path and print a numbered list of issues.

Exit codes:
- 0: no issues
- 1: issues found (ruff exit code)
- 2: other errors (parsing, ruff invocation)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any, Iterable


def _run_ruff(path: str, config: str | None) -> tuple[int, str, str]:
    cmd = ["ruff", "check", path, "--output-format", "json"]
    if config:
        cmd.extend(["--config", config])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise RuntimeError("ruff is not installed or not on PATH") from exc
    return proc.returncode, proc.stdout, proc.stderr


def _parse_output(raw: str) -> list[dict[str, Any]]:
    raw = raw.strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # Fallback: try per-line JSON (some tools emit one JSON object per line)
        issues: list[dict[str, Any]] = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            issues.append(json.loads(line))
        return issues
    if isinstance(data, list):
        return data
    # Some ruff versions might emit a single object
    return [data]


def _format_issue(idx: int, issue: dict[str, Any], base_dir: str) -> str:
    filename = issue.get("filename", "<unknown>")
    relpath = os.path.relpath(filename, base_dir) if filename else "<unknown>"
    location = issue.get("location", {}) or {}
    row = location.get("row", "?")
    column = location.get("column", "?")
    code = issue.get("code", "<code>")
    message = issue.get("message", "<message>")
    fixable = "fixable" if issue.get("fix") else "manual"
    return f"{idx}. {relpath}:{row}:{column} {code} {message} ({fixable})"


def _save_json(issues: Iterable[dict[str, Any]], path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(list(issues), handle, indent=2, sort_keys=True)
        handle.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run ruff and print a numbered list of issues.",
    )
    parser.add_argument("path", help="Folder or file to lint with ruff")
    parser.add_argument(
        "--config",
        help="Optional ruff config (pyproject.toml or ruff.toml)",
    )
    parser.add_argument(
        "--save",
        help="Write raw JSON issues to a file for later reference",
    )
    parser.add_argument(
        "--base-dir",
        default=os.getcwd(),
        help="Base directory for relative paths (default: cwd)",
    )
    args = parser.parse_args()

    returncode, stdout, stderr = _run_ruff(args.path, args.config)
    if returncode not in (0, 1):
        if stderr:
            sys.stderr.write(stderr)
        raise RuntimeError(f"ruff failed with exit code {returncode}")

    issues = _parse_output(stdout)
    if args.save:
        _save_json(issues, args.save)

    if not issues:
        print("No ruff issues found.")
        return 0

    base_dir = os.path.abspath(args.base_dir)
    for idx, issue in enumerate(issues, start=1):
        print(_format_issue(idx, issue, base_dir))

    fixable_count = sum(1 for issue in issues if issue.get("fix"))
    print()
    print(f"Total issues: {len(issues)} (fixable: {fixable_count})")
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(2)
