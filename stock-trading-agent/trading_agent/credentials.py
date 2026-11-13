"""Local, git-safe storage for trading account credentials.

Credentials live in one TOML file **outside the repository** by default:

    ~/.config/stock-trading-agent/accounts.toml   (override: TRADING_AGENT_SECRETS)

Before the file is read, two checks run:
* POSIX permissions must be owner-only (chmod 600). Group- or world-readable is refused.
* If the file sits inside a git work tree, it must be git-ignored. Otherwise it's refused.

Any value can point somewhere else instead of holding the secret:
    "keyring:<name>"  -> OS keychain via the optional `keyring` package
    "env:<VAR>"       -> another environment variable

Loaded values are exported as the environment variables the rest of the code already
uses (ALPACA_API_KEY_ID, WEBULL_APP_KEY, ...). Variables already set in the real
environment win, and the file wins over .env.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tomllib
from dataclasses import dataclass
from pathlib import Path

SERVICE = "stock-trading-agent"
DEFAULT_PATH = Path("~/.config/stock-trading-agent/accounts.toml")

# (section, key) -> environment variable
FIELDS: dict[tuple[str, str], str] = {
    ("agent", "trading_mode"): "TRADING_MODE",
    ("anthropic", "api_key"): "ANTHROPIC_API_KEY",
    ("alpaca", "api_key_id"): "ALPACA_API_KEY_ID",
    ("alpaca", "api_secret_key"): "ALPACA_API_SECRET_KEY",
    ("alpaca", "paper_trade"): "ALPACA_PAPER_TRADE",
    ("webull", "app_key"): "WEBULL_APP_KEY",
    ("webull", "app_secret"): "WEBULL_APP_SECRET",
    ("webull", "region_id"): "WEBULL_REGION_ID",
    ("webull", "environment"): "WEBULL_ENVIRONMENT",
    ("robinhood", "mcp_token"): "ROBINHOOD_MCP_TOKEN",
    ("robinhood", "account_number"): "ROBINHOOD_ACCOUNT_NUMBER",
    ("market_data", "provider"): "MARKET_DATA",
    ("finnhub", "api_key"): "FINNHUB_API_KEY",
    ("fidelity", "mcp_command"): "FIDELITY_MCP_COMMAND",
    ("fidelity", "mcp_args"): "FIDELITY_MCP_ARGS",
}
SECRET_KEYS = {"api_key", "api_key_id", "api_secret_key", "app_key", "app_secret", "mcp_token",
               "account_number"}

TEMPLATE = """\
# Trading account credentials for stock-trading-agent.
# LOCAL ONLY: this file must stay outside git (or be git-ignored) and chmod 600.
# Manage it with:  python -m trading_agent secrets set <section.key>
# Any value may be "keyring:<name>" (OS keychain) or "env:<VAR>".

[agent]
trading_mode = "paper"        # paper | alpaca-paper | alpaca-live

[anthropic]
api_key = ""

[alpaca]
api_key_id = ""
api_secret_key = ""
paper_trade = "true"

[market_data]
provider = "yahoo"            # live prices for paper trading: simulated | yahoo | finnhub | alpaca
                              # fallback chain allowed, e.g. "finnhub,yahoo"

[finnhub]
api_key = ""                  # free key from finnhub.io (real-time US quotes)

[webull]
app_key = ""
app_secret = ""
region_id = "us"
environment = "uat"           # uat = sandbox, prod = live

[robinhood]
mcp_token = ""
account_number = ""           # your Agentic account number

[fidelity]                    # unofficial MCP server only; see docs/MCP.md
mcp_command = ""
mcp_args = ""
"""


class SecretsError(RuntimeError):
    pass


def secrets_path() -> Path:
    return Path(os.getenv("TRADING_AGENT_SECRETS", str(DEFAULT_PATH))).expanduser()


# ------------------------------------------------------------------ safety checks
def permission_problem(path: Path) -> str | None:
    if os.name != "posix":
        return None
    mode = path.stat().st_mode
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        return f"{path} is accessible by other users (mode {oct(mode & 0o777)}); run: chmod 600 {path}"
    return None


def git_problem(path: Path) -> str | None:
    """Refuse a secrets file that is inside a git work tree and not ignored."""
    try:
        inside = subprocess.run(["git", "-C", str(path.parent), "rev-parse", "--is-inside-work-tree"],
                                capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None  # git not installed: nothing to commit it with
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return None
    ignored = subprocess.run(["git", "-C", str(path.parent), "check-ignore", "-q", str(path)],
                             capture_output=True, timeout=10)
    if ignored.returncode == 0:
        tracked = subprocess.run(["git", "-C", str(path.parent), "ls-files", "--error-unmatch", str(path)],
                                 capture_output=True, timeout=10)
        if tracked.returncode == 0:
            return f"{path} is ignored but already tracked by git; run: git rm --cached {path}"
        return None
    return f"{path} is inside a git repository and NOT git-ignored; move it or add it to .gitignore"


# ------------------------------------------------------------------ read / resolve
def _resolve(value: str) -> str:
    if value.startswith("keyring:"):
        try:
            import keyring  # optional dependency
        except ImportError as e:
            raise SecretsError("value uses keyring: but the `keyring` package isn't installed "
                               "(pip install keyring)") from e
        got = keyring.get_password(SERVICE, value[len("keyring:"):])
        if got is None:
            raise SecretsError(f"no keyring entry {value[len('keyring:'):]!r} for service {SERVICE}")
        return got
    if value.startswith("env:"):
        return os.environ.get(value[4:], "")
    return value


def read_secrets(path: Path | None = None, check: bool = True) -> dict[str, dict[str, str]]:
    path = path or secrets_path()
    if not path.exists():
        return {}
    if check:
        for problem in (permission_problem(path), git_problem(path)):
            if problem:
                raise SecretsError(f"refusing to load secrets: {problem}")
    with path.open("rb") as fh:
        data = tomllib.load(fh)
    return {sec: {k: ("true" if v is True else "false" if v is False else str(v)) for k, v in vals.items()}
            for sec, vals in data.items() if isinstance(vals, dict)}


def apply_secrets(path: Path | None = None) -> list[str]:
    """Export configured values as env vars (real env wins). Returns variable names set."""
    data = read_secrets(path)
    exported = []
    for (sec, key), var in FIELDS.items():
        raw = data.get(sec, {}).get(key, "")
        if not raw or os.environ.get(var):
            continue
        value = _resolve(raw)
        if value:
            os.environ[var] = value
            exported.append(var)
    return exported


# ------------------------------------------------------------------ write
def _dump(data: dict[str, dict[str, str]]) -> str:
    lines = ["# Trading account credentials - LOCAL ONLY (chmod 600, never commit).", ""]
    for sec, vals in data.items():
        lines.append(f"[{sec}]")
        for k, v in vals.items():
            lines.append(f"{k} = {json.dumps(v)}")  # JSON strings are valid TOML basic strings
        lines.append("")
    return "\n".join(lines)


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        os.chmod(path.parent, 0o700)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.replace(tmp, path)
    if os.name == "posix":
        os.chmod(path, 0o600)


def init_secrets(path: Path | None = None, force: bool = False) -> Path:
    path = path or secrets_path()
    if path.exists() and not force:
        raise SecretsError(f"{path} already exists (use --force to overwrite)")
    _write_private(path, TEMPLATE)
    problem = git_problem(path)
    if problem:
        path.unlink()
        raise SecretsError(problem)
    return path


def set_secret(dotted: str, value: str, path: Path | None = None, use_keyring: bool = False) -> None:
    sec, _, key = dotted.partition(".")
    if (sec, key) not in FIELDS:
        raise SecretsError(f"unknown setting {dotted!r}; choose from: "
                           + ", ".join(f"{s}.{k}" for s, k in FIELDS))
    path = path or secrets_path()
    data = read_secrets(path) if path.exists() else {}
    if use_keyring:
        try:
            import keyring
        except ImportError as e:
            raise SecretsError("pip install keyring to use --keyring") from e
        keyring.set_password(SERVICE, dotted, value)
        value = f"keyring:{dotted}"
    data.setdefault(sec, {})[key] = value
    _write_private(path, _dump(data))


@dataclass
class SecretStatus:
    setting: str
    env_var: str
    source: str     # "env", "file", "keyring", "unset"
    preview: str


def mask(value: str) -> str:
    if not value:
        return ""
    return "****" if len(value) <= 8 else f"{value[:2]}****{value[-2:]}"


def status(path: Path | None = None) -> tuple[list[str], list[SecretStatus]]:
    """Problems with the file plus a masked view of every setting."""
    path = path or secrets_path()
    problems: list[str] = []
    data: dict = {}
    if path.exists():
        problems += [p for p in (permission_problem(path), git_problem(path)) if p]
        data = read_secrets(path, check=False)
    rows = []
    for (sec, key), var in FIELDS.items():
        raw = data.get(sec, {}).get(key, "")
        if os.environ.get(var) and not raw:
            source, val = "env", os.environ[var]
        elif raw.startswith("keyring:"):
            source, val = "keyring", raw
        elif raw:
            source, val = "file", raw
        else:
            source, val = "unset", ""
        shown = val if (key not in SECRET_KEYS or source == "keyring") else mask(val)
        rows.append(SecretStatus(f"{sec}.{key}", var, source, shown))
    return problems, rows
