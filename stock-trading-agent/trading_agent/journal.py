"""Append-only JSONL audit log of every proposed, rejected and submitted order."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import PROJECT_ROOT


class TradeJournal:
    def __init__(self, path: str | Path):
        path = Path(path)
        self.path = path if path.is_absolute() else PROJECT_ROOT / path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def record(self, event: str, **data: Any) -> None:
        entry = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **data}
        with self.path.open("a") as fh:
            fh.write(json.dumps(entry, default=str) + "\n")

    def tail(self, n: int = 20) -> list[dict]:
        if not self.path.exists():
            return []
        lines = self.path.read_text().splitlines()[-n:]
        return [json.loads(line) for line in lines]
