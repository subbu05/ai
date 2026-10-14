#!/usr/bin/env python3
"""Git pre-commit hook: block commits that contain credentials.

Install with:  python -m trading_agent secrets install-hook
Bypass (only if you're sure):  git commit --no-verify
"""

from __future__ import annotations

import re
import subprocess
import sys

BLOCKED_NAMES = re.compile(
    r"(^|/)(\.env(\.[^/]*)?|accounts\.toml|.*\.local\.toml|.*secrets?\.(toml|json|ya?ml)|.*\.pem|.*\.key|"
    r"paper_account\.json|trade_journal\.jsonl|fills\.jsonl)$")
ALLOWED_NAMES = re.compile(r"(\.example(\.[^/]*)?$|example\.|\.sample$)")

CONTENT_PATTERNS = [
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"), "Anthropic API key"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "private key"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "AWS access key"),
    (re.compile(r"(?m)^[ \t]*(ALPACA_API_KEY_ID|ALPACA_API_SECRET_KEY|ALPACA_API_KEY|ALPACA_SECRET_KEY|"
                r"WEBULL_APP_KEY|WEBULL_APP_SECRET|ROBINHOOD_MCP_TOKEN|ANTHROPIC_API_KEY)[ \t]*[=:][ \t]*"
                r"[\"']?(?!your_|\$\{|<)[A-Za-z0-9_\-/+=]{12,}"), "credential assignment"),
    (re.compile(r"(?m)^[ \t]*(api_key|api_key_id|api_secret_key|app_key|app_secret|mcp_token)[ \t]*=[ \t]*"
                r"\"(?!keyring:|env:)[^\"]{12,}\""), "credential in TOML"),
]


def staged_files() -> list[str]:
    out = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
                         capture_output=True, text=True, check=True).stdout
    return [f for f in out.splitlines() if f]


def staged_content(path: str) -> str:
    r = subprocess.run(["git", "show", f":{path}"], capture_output=True)
    return r.stdout.decode("utf-8", errors="ignore")


def main() -> int:
    problems = []
    for f in staged_files():
        if BLOCKED_NAMES.search(f) and not ALLOWED_NAMES.search(f):
            problems.append(f"{f}: file type must never be committed")
            continue
        text = staged_content(f)
        for pattern, label in CONTENT_PATTERNS:
            if pattern.search(text):
                problems.append(f"{f}: looks like it contains a {label}")
    if problems:
        print("pre-commit: refusing to commit possible secrets:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print("Move credentials to ~/.config/stock-trading-agent/accounts.toml "
              "(python -m trading_agent secrets set ...).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
