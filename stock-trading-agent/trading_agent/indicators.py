"""Small, dependency-free technical indicators."""

from __future__ import annotations

import math
import statistics


def sma(values: list[float], n: int) -> float | None:
    return sum(values[-n:]) / n if len(values) >= n else None


def rsi(values: list[float], n: int = 14) -> float | None:
    if len(values) <= n:
        return None
    gains = losses = 0.0
    for a, b in zip(values[-n - 1:-1], values[-n:]):
        diff = b - a
        gains += max(diff, 0)
        losses += max(-diff, 0)
    if losses == 0:
        return 100.0
    rs = (gains / n) / (losses / n)
    return 100 - 100 / (1 + rs)


def realized_vol(values: list[float], n: int = 20) -> float | None:
    if len(values) <= n:
        return None
    rets = [math.log(b / a) for a, b in zip(values[-n - 1:-1], values[-n:])]
    return statistics.stdev(rets) * math.sqrt(252)


def momentum(values: list[float], n: int) -> float | None:
    return values[-1] / values[-n - 1] - 1 if len(values) > n else None


def summarize(closes: list[float]) -> dict:
    def r(x, d=4):
        return round(x, d) if x is not None else None

    last = closes[-1] if closes else None
    s20, s50 = sma(closes, 20), sma(closes, 50)
    trend = None
    if last and s20 and s50:
        trend = "up" if last > s20 > s50 else "down" if last < s20 < s50 else "mixed"
    return {
        "last": r(last, 2), "sma20": r(s20, 2), "sma50": r(s50, 2), "rsi14": r(rsi(closes), 1),
        "vol20_annualized": r(realized_vol(closes)), "mom_20d": r(momentum(closes, 20)),
        "mom_60d": r(momentum(closes, 60)), "trend": trend,
    }
