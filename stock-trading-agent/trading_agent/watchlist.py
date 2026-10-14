"""Watchlist: the stocks you track, your own labels for them, and which ones the
profit-protection monitor manages.

Stored locally in ``<data_dir>/watchlist.json`` (git-ignored with the rest of data/).
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

_SYMBOL = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
_LABEL = re.compile(r"^[\w &+\-./]{1,32}$")


def normalize_symbol(symbol: str) -> str:
    s = (symbol or "").strip().upper()
    if not _SYMBOL.match(s):
        raise ValueError(f"invalid ticker {symbol!r}")
    return s


def normalize_label(label: str) -> str:
    s = " ".join((label or "").split())
    if not _LABEL.match(s):
        raise ValueError(f"invalid label {label!r} (1-32 letters, digits, spaces, & + - . /)")
    return s


@dataclass
class WatchItem:
    symbol: str
    labels: list[str] = field(default_factory=list)
    monitor: bool = True          # managed by the profit-protection rule when held
    note: str = ""
    added: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class Watchlist:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._lock = threading.RLock()
        self.items: dict[str, WatchItem] = {}
        self.labels: list[str] = []      # keeps empty labels and the user's ordering
        self._load()

    # ------------------------------------------------------------- persistence
    def _load(self) -> None:
        if not self.path.exists():
            return
        data = json.loads(self.path.read_text())
        self.items = {s: WatchItem(**v) for s, v in data.get("symbols", {}).items()}
        self.labels = list(data.get("labels", []))
        self._sync_labels()

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"labels": self.labels,
                                       "symbols": {s: asdict(i) for s, i in sorted(self.items.items())}},
                                      indent=2))
            tmp.replace(self.path)

    def _sync_labels(self) -> None:
        for item in self.items.values():
            for lab in item.labels:
                if lab not in self.labels:
                    self.labels.append(lab)

    # ------------------------------------------------------------- operations
    def add(self, symbol: str, labels: list[str] | None = None, monitor: bool = True, note: str = "") -> WatchItem:
        with self._lock:
            sym = normalize_symbol(symbol)
            labs = [normalize_label(l) for l in (labels or [])]
            item = self.items.get(sym)
            if item:
                item.labels = sorted(set(item.labels) | set(labs), key=str.lower)
            else:
                item = self.items[sym] = WatchItem(sym, sorted(set(labs), key=str.lower), monitor, note)
            self._sync_labels()
            self.save()
            return item

    def remove(self, symbol: str) -> bool:
        with self._lock:
            removed = self.items.pop(normalize_symbol(symbol), None) is not None
            self.save()
            return removed

    def update(self, symbol: str, *, labels: list[str] | None = None, monitor: bool | None = None,
               note: str | None = None) -> WatchItem:
        with self._lock:
            item = self.items.get(normalize_symbol(symbol))
            if item is None:
                raise KeyError(f"{symbol} is not on the watchlist")
            if labels is not None:
                item.labels = sorted({normalize_label(l) for l in labels}, key=str.lower)
            if monitor is not None:
                item.monitor = bool(monitor)
            if note is not None:
                item.note = note[:200]
            self._sync_labels()
            self.save()
            return item

    def create_label(self, label: str) -> str:
        with self._lock:
            lab = normalize_label(label)
            if lab not in self.labels:
                self.labels.append(lab)
            self.save()
            return lab

    def rename_label(self, old: str, new: str) -> None:
        with self._lock:
            new = normalize_label(new)
            if old not in self.labels:
                raise KeyError(f"no label {old!r}")
            self.labels = [new if l == old else l for l in self.labels]
            self.labels = list(dict.fromkeys(self.labels))
            for item in self.items.values():
                if old in item.labels:
                    item.labels = sorted({new if l == old else l for l in item.labels}, key=str.lower)
            self.save()

    def delete_label(self, label: str) -> None:
        with self._lock:
            self.labels = [l for l in self.labels if l != label]
            for item in self.items.values():
                item.labels = [l for l in item.labels if l != label]
            self.save()

    # ------------------------------------------------------------- queries
    def symbols(self) -> list[str]:
        return sorted(self.items)

    def monitored(self) -> set[str] | None:
        """Symbols the profit-protection rule should manage, or None = no watchlist (all holdings)."""
        if not self.items:
            return None
        return {s for s, i in self.items.items() if i.monitor}

    def filter(self, labels: list[str] | None = None, match: str = "any", text: str = "") -> list[WatchItem]:
        text = text.strip().upper()
        out = []
        for item in sorted(self.items.values(), key=lambda i: i.symbol):
            if text and text not in item.symbol and text.lower() not in item.note.lower():
                continue
            if labels:
                have = set(item.labels)
                if match == "all" and not set(labels) <= have:
                    continue
                if match == "any" and not (set(labels) & have):
                    continue
            out.append(item)
        return out

    def grouped(self, items: list[WatchItem] | None = None) -> dict[str, list[str]]:
        """label -> symbols (a symbol appears under each of its labels); 'Unlabeled' last."""
        items = items if items is not None else list(self.items.values())
        groups: dict[str, list[str]] = {l: [] for l in self.labels}
        unlabeled = []
        for item in items:
            for lab in item.labels or []:
                groups.setdefault(lab, []).append(item.symbol)
            if not item.labels:
                unlabeled.append(item.symbol)
        groups = {k: sorted(v) for k, v in groups.items() if v}
        if unlabeled:
            groups["Unlabeled"] = sorted(unlabeled)
        return groups
