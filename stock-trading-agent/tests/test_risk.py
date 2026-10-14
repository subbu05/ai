from datetime import date, timedelta

from trading_agent.models import AssetClass, OptionContract, OptionRight, Order, OrderType, PositionIntent, Side


def _occ(underlying, days, strike, right):
    return OptionContract(underlying, date.today() + timedelta(days=days), strike, right).occ_symbol


def test_order_notional_limit(ctx):
    d = ctx.risk.check(Order("AAPL", 500, Side.BUY, AssetClass.STOCK))
    assert not d.approved
    assert any("max_order_notional" in r for r in d.reasons)


def test_position_cap_stock_vs_etf(ctx):
    ctx.risk.limits.max_order_notional = 1e9
    assert not ctx.risk.check(Order("AAPL", 120, Side.BUY, AssetClass.STOCK)).approved  # ~27%
    assert ctx.risk.check(Order("VTI", 150, Side.BUY, AssetClass.ETF)).approved          # ~41%


def test_no_short_selling(ctx):
    d = ctx.risk.check(Order("AAPL", 1, Side.SELL, AssetClass.STOCK))
    assert not d.approved and any("short" in r for r in d.reasons)


def test_closing_always_allowed_even_with_kill_limits(ctx, broker):
    broker.submit_order(Order("AAPL", 10, Side.BUY, AssetClass.STOCK))
    ctx.risk.limits.max_order_notional = 1
    assert ctx.risk.check(Order("AAPL", 10, Side.SELL, AssetClass.STOCK)).approved


def test_kill_switch_blocks_everything(ctx, limits, tmp_path):
    open(limits.kill_switch_file, "w").close()
    d = ctx.risk.check(Order("AAPL", 1, Side.BUY, AssetClass.STOCK))
    assert not d.approved and "kill switch" in d.reasons[0]


def test_blocked_and_allowed_symbols(ctx):
    ctx.risk.limits.blocked_symbols = ["TSLA"]
    assert not ctx.risk.check(Order("TSLA", 1, Side.BUY, AssetClass.STOCK)).approved
    ctx.risk.limits.allowed_symbols = ["SPY"]
    assert not ctx.risk.check(Order("AAPL", 1, Side.BUY, AssetClass.STOCK)).approved
    assert ctx.risk.check(Order("SPY", 1, Side.BUY, AssetClass.ETF)).approved


def test_daily_loss_limit(ctx, broker):
    broker.day_start_equity = 110_000  # pretend we're down ~9% today
    d = ctx.risk.check(Order("SPY", 1, Side.BUY, AssetClass.ETF))
    assert not d.approved and any("daily loss" in r for r in d.reasons)


def test_naked_call_rejected_covered_call_allowed(ctx, broker):
    sym = _occ("AAPL", 30, 240, OptionRight.CALL)
    sell = Order(sym, 1, Side.SELL, AssetClass.OPTION, OrderType.LIMIT, limit_price=1.0)
    assert not ctx.risk.check(sell).approved
    broker.submit_order(Order("AAPL", 100, Side.BUY, AssetClass.STOCK))
    assert ctx.risk.check(sell).approved
    sell2 = Order(sym, 2, Side.SELL, AssetClass.OPTION, OrderType.LIMIT, limit_price=1.0)
    assert not ctx.risk.check(sell2).approved  # only 100 shares


def test_cash_secured_put_needs_collateral(ctx, broker):
    sym = _occ("SPY", 30, 550, OptionRight.PUT)
    assert ctx.risk.check(Order(sym, 1, Side.SELL, AssetClass.OPTION, OrderType.LIMIT, limit_price=5)).approved
    assert not ctx.risk.check(Order(sym, 2, Side.SELL, AssetClass.OPTION, OrderType.LIMIT, limit_price=5)).approved


def test_option_dte_and_premium_limits(ctx):
    short_dated = _occ("AAPL", 2, 225, OptionRight.CALL)
    d = ctx.risk.check(Order(short_dated, 1, Side.BUY, AssetClass.OPTION, OrderType.LIMIT, limit_price=2))
    assert any("DTE" in r for r in d.reasons)
    big = _occ("AAPL", 30, 225, OptionRight.CALL)
    d = ctx.risk.check(Order(big, 100, Side.BUY, AssetClass.OPTION, OrderType.LIMIT, limit_price=6))
    assert any("max_option_premium_pct" in r for r in d.reasons)


def test_close_intent_without_position_rejected(ctx):
    sym = _occ("AAPL", 30, 225, OptionRight.CALL)
    d = ctx.risk.check(Order(sym, 1, Side.SELL, AssetClass.OPTION, OrderType.LIMIT, limit_price=2,
                             intent=PositionIntent.CLOSE))
    assert not d.approved
