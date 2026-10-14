from datetime import date

import pytest

from trading_agent.models import OptionContract, OptionRight
from trading_agent.options_math import black_scholes


def test_occ_round_trip():
    c = OptionContract("AAPL", date(2026, 11, 20), 232.5, OptionRight.CALL)
    assert c.occ_symbol == "AAPL261120C00232500"
    assert OptionContract.from_occ(c.occ_symbol) == c


def test_occ_rejects_garbage():
    with pytest.raises(ValueError):
        OptionContract.from_occ("AAPL")


def test_put_call_parity():
    s, k, t, v, r = 100, 105, 0.5, 0.3, 0.04
    import math
    call = black_scholes(s, k, t, v, OptionRight.CALL, r).price
    put = black_scholes(s, k, t, v, OptionRight.PUT, r).price
    assert call - put == pytest.approx(s - k * math.exp(-r * t), abs=1e-6)


def test_expired_option_is_intrinsic():
    assert black_scholes(110, 100, 0, 0.3, OptionRight.CALL).price == 10
    assert black_scholes(110, 100, 0, 0.3, OptionRight.PUT).price == 0
