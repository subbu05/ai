"""Black-Scholes pricing and Greeks (used for paper fills and option analytics)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

from .models import OptionRight


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


@dataclass
class Greeks:
    price: float
    delta: float
    gamma: float
    theta: float  # per calendar day
    vega: float   # per 1 vol point

    def to_dict(self) -> dict[str, float]:
        return {k: round(v, 4) for k, v in self.__dict__.items()}


def years_to_expiry(expiration: date, today: date | None = None) -> float:
    today = today or date.today()
    return max((expiration - today).days, 0) / 365.0


def black_scholes(
    spot: float,
    strike: float,
    t: float,
    vol: float,
    right: OptionRight,
    rate: float = 0.04,
) -> Greeks:
    if t <= 0 or vol <= 0:
        intrinsic = max(spot - strike, 0) if right == OptionRight.CALL else max(strike - spot, 0)
        delta = (1.0 if spot > strike else 0.0) if right == OptionRight.CALL else (-1.0 if spot < strike else 0.0)
        return Greeks(intrinsic, delta, 0.0, 0.0, 0.0)

    sqrt_t = math.sqrt(t)
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * t) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t
    disc = math.exp(-rate * t)

    if right == OptionRight.CALL:
        price = spot * _norm_cdf(d1) - strike * disc * _norm_cdf(d2)
        delta = _norm_cdf(d1)
        theta = -spot * _norm_pdf(d1) * vol / (2 * sqrt_t) - rate * strike * disc * _norm_cdf(d2)
    else:
        price = strike * disc * _norm_cdf(-d2) - spot * _norm_cdf(-d1)
        delta = _norm_cdf(d1) - 1
        theta = -spot * _norm_pdf(d1) * vol / (2 * sqrt_t) + rate * strike * disc * _norm_cdf(-d2)

    gamma = _norm_pdf(d1) / (spot * vol * sqrt_t)
    vega = spot * _norm_pdf(d1) * sqrt_t / 100
    return Greeks(price, delta, gamma, theta / 365, vega)
