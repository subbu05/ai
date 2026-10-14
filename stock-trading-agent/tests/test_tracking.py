"""Secure config, P&L ledger, profit protection and dashboard tests."""

import json
import os
import subprocess
from datetime import datetime, timedelta, timezone

import pytest

from trading_agent import credentials as cred
from trading_agent.dashboard import build_data, render
from trading_agent.models import AssetClass, Fill, Order, OrderStatus, OrderType, Side
from trading_agent.monitor import PriceTracker, ProfitProtectConfig, evaluate, run_check
from trading_agent.pnl import EquityHistory, PnlLedger, realized_trades, summarize
from trading_agent.skills import deny_all

T0 = datetime(2026, 9, 1, 14, 0, tzinfo=timezone.utc)


def fill(i, sym, side, qty, px, day=0, ac=AssetClass.STOCK, fee=0.0):
    return Fill(f"f{i}", sym, Side(side), qty, px, ac, T0 + timedelta(days=day, minutes=i), f"o{i}", fee)


# ------------------------------------------------------------------ credentials
@pytest.fixture
def secrets_file(tmp_path, monkeypatch):
    path = tmp_path / "home" / "accounts.toml"
    monkeypatch.setenv("TRADING_AGENT_SECRETS", str(path))
    for var in cred.FIELDS.values():
        monkeypatch.delenv(var, raising=False)
    return path


def test_init_creates_private_file(secrets_file):
    cred.init_secrets()
    assert secrets_file.exists()
    if os.name == "posix":
        assert secrets_file.stat().st_mode & 0o777 == 0o600
        assert secrets_file.parent.stat().st_mode & 0o777 == 0o700


def test_set_and_apply_exports_env(secrets_file, monkeypatch):
    cred.init_secrets()
    cred.set_secret("alpaca.api_key_id", "PKTESTKEY123456")
    cred.set_secret("webull.app_secret", 'we"ird\\value')
    exported = cred.apply_secrets()
    assert os.environ["ALPACA_API_KEY_ID"] == "PKTESTKEY123456"
    assert os.environ["WEBULL_APP_SECRET"] == 'we"ird\\value'
    assert "ALPACA_API_KEY_ID" in exported


def test_real_env_wins(secrets_file, monkeypatch):
    cred.init_secrets()
    cred.set_secret("alpaca.api_key_id", "FROMFILE")
    monkeypatch.setenv("ALPACA_API_KEY_ID", "FROMENV")
    cred.apply_secrets()
    assert os.environ["ALPACA_API_KEY_ID"] == "FROMENV"


@pytest.mark.skipif(os.name != "posix", reason="POSIX permissions")
def test_world_readable_file_refused(secrets_file):
    cred.init_secrets()
    secrets_file.chmod(0o644)
    with pytest.raises(cred.SecretsError, match="chmod 600"):
        cred.apply_secrets()


def test_unignored_file_in_git_repo_refused(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.setenv("TRADING_AGENT_SECRETS", str(repo / "accounts.toml"))
    with pytest.raises(cred.SecretsError, match="NOT git-ignored"):
        cred.init_secrets()
    assert not (repo / "accounts.toml").exists()
    (repo / ".gitignore").write_text("accounts.toml\n")
    cred.init_secrets()  # ignored -> allowed


def test_unknown_setting_rejected(secrets_file):
    with pytest.raises(cred.SecretsError, match="unknown setting"):
        cred.set_secret("alpaca.password", "x")


def test_status_masks_secrets(secrets_file):
    cred.init_secrets()
    cred.set_secret("alpaca.api_secret_key", "SUPERSECRETVALUE")
    _, rows = cred.status()
    row = next(r for r in rows if r.setting == "alpaca.api_secret_key")
    assert row.source == "file" and "SUPERSECRET" not in row.preview


def test_gitignore_covers_secret_files():
    from trading_agent.config import PROJECT_ROOT

    for name in ("config/accounts.toml", ".env", ".env.local", "data/fills.jsonl", "my.local.toml",
                 "reports/pnl_dashboard.html"):
        assert subprocess.run(["git", "-C", str(PROJECT_ROOT), "check-ignore", "-q", name]).returncode == 0, name
    for name in ("config/accounts.example.toml", ".env.example"):
        assert subprocess.run(["git", "-C", str(PROJECT_ROOT), "check-ignore", "-q", name]).returncode == 1, name


def test_pre_commit_hook_blocks_secrets(tmp_path):
    from trading_agent.config import PROJECT_ROOT

    repo = tmp_path / "r"
    repo.mkdir()
    run = lambda *a: subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True)
    run("init", "-q")
    hook = PROJECT_ROOT / "scripts" / "pre-commit-secrets.py"
    (repo / "ok.py").write_text("x = 1\n")
    (repo / "leak.py").write_text("ALPACA_API_SECRET_KEY = 'abcd1234efgh5678'\n")
    (repo / "accounts.toml").write_text("[alpaca]\n")
    (repo / "settings.example.env").write_text("ALPACA_API_KEY_ID=\nALPACA_API_SECRET_KEY=\n# comment line here\n")
    run("add", "-A")
    r = subprocess.run(["python3", str(hook)], cwd=repo, capture_output=True, text=True)
    assert r.returncode == 1 and "leak.py" in r.stderr and "accounts.toml" in r.stderr
    run("rm", "-q", "--cached", "leak.py", "accounts.toml")
    r = subprocess.run(["python3", str(hook)], cwd=repo, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


# ------------------------------------------------------------------ P&L
def test_fifo_long_partial_closes():
    trades = realized_trades([fill(1, "AAPL", "buy", 10, 100), fill(2, "AAPL", "buy", 10, 110, day=1),
                              fill(3, "AAPL", "sell", 15, 120, day=2)])
    assert [(t.qty, t.open_price, round(t.pnl, 2)) for t in trades] == [(10, 100, 200.0), (5, 110, 50.0)]


def test_short_and_options_multiplier_and_fees():
    trades = realized_trades([
        fill(1, "SPY261120P00540000", "sell", 1, 6.0, ac=AssetClass.OPTION, fee=0.65),
        fill(2, "SPY261120P00540000", "buy", 1, 2.5, day=3, ac=AssetClass.OPTION, fee=0.65)])
    assert trades[0].direction == "short" and trades[0].pnl == pytest.approx(350 - 1.30)


def test_summary_profit_loss_split():
    s = summarize(realized_trades([fill(1, "A", "buy", 1, 10), fill(2, "A", "sell", 1, 15, day=1),
                                   fill(3, "B", "buy", 1, 10), fill(4, "B", "sell", 1, 8, day=2)]))
    assert (s["realized_profit"], s["realized_loss"], s["realized_net"]) == (5, -2, 3)
    assert s["win_rate"] == 0.5 and [d["cumulative"] for d in s["by_day"]] == [5, 3]


def test_ledger_sync_dedupes(broker, tmp_path):
    broker.submit_order(Order("SPY", 2, Side.BUY, AssetClass.ETF))
    ledger = PnlLedger(tmp_path / "fills.jsonl")
    assert ledger.sync(broker) == 1 and ledger.sync(broker) == 0
    assert ledger.fills()[0].symbol == "SPY"


# ------------------------------------------------------------------ resting orders
def test_paper_resting_limit_fills_when_price_moves(broker):
    px = broker.get_quote("AAPL").bid
    broker.submit_order(Order("AAPL", 10, Side.BUY, AssetClass.STOCK))
    o = broker.submit_order(Order("AAPL", 10, Side.SELL, AssetClass.STOCK, OrderType.LIMIT, limit_price=px * 1.05))
    assert o.status == OrderStatus.NEW
    broker.market._prices["AAPL"] = px * 1.06
    assert [x.id for x in broker.process_open_orders()] == [o.id]
    assert broker.get_position("AAPL") is None and len(broker.get_fills()) == 2


def test_open_orders_survive_restart(tmp_path):
    from trading_agent.brokers import PaperBroker

    b = PaperBroker(10_000, tmp_path / "a.json")
    b.submit_order(Order("SPY", 1, Side.BUY, AssetClass.ETF, OrderType.LIMIT, limit_price=1.0))
    b2 = PaperBroker(10_000, tmp_path / "a.json")
    assert len(b2.list_orders()) == 1 and len(b2.get_fills()) == 0


# ------------------------------------------------------------------ profit protection rule
CFG = ProfitProtectConfig(drop_pct=0.03, min_profit_pct=0.01)


def test_rule_holds_until_in_profit():
    assert evaluate(99, 98.9, 100, day_high=100.5, peak=100.5, cfg=CFG)[0] == "hold"  # never >= 1% up


def test_rule_holds_on_small_dip():
    action, trigger, *_ = evaluate(108, 107.9, 100, day_high=110, peak=110, cfg=CFG)
    assert action == "hold" and trigger == pytest.approx(106.7)


def test_rule_sells_in_profit_after_drop():
    action, trigger, ref, reason, limit = evaluate(106.5, 106.4, 100, day_high=110, peak=110, cfg=CFG)
    assert action == "sell_now" and limit == 106.4 and limit >= 100


def test_rule_floor_is_cost():
    # small gain: trigger is the cost floor, not 3% below the high
    action, trigger, *_ , limit = evaluate(100.2, 100.1, 100, day_high=101.5, peak=101.5, cfg=CFG)
    assert trigger == 100 and action == "hold"
    action, trigger, *_ , limit = evaluate(99.0, 98.9, 100, day_high=101.5, peak=101.5, cfg=CFG)
    assert action == "sell_at_cost" and limit == 100.0  # never below what was paid


def test_rule_peak_reference():
    cfg = ProfitProtectConfig(drop_pct=0.05, reference="peak", min_profit_pct=0.01)
    assert evaluate(114, 113.9, 100, day_high=114.5, peak=120, cfg=cfg)[0] == "sell_now"   # 5% off peak
    assert evaluate(114, 113.9, 100, day_high=114.5, peak=120, cfg=CFG)[0] == "hold"      # day-high mode


@pytest.mark.parametrize("bad", [0.005, 0.11])
def test_drop_pct_range_enforced(bad):
    with pytest.raises(ValueError):
        ProfitProtectConfig(drop_pct=bad).validate()


def test_shipped_profit_protect_config_valid():
    cfg = ProfitProtectConfig.load()
    assert 0.01 <= cfg.drop_pct <= 0.10 and cfg.auto_sell_live is False


def _tracker(tmp_path):
    return PriceTracker(tmp_path / "t.json", tmp_path / "log.jsonl")


def test_run_check_sells_whole_position_in_profit(ctx, broker, tmp_path):
    broker.submit_order(Order("NVDA", 50, Side.BUY, AssetClass.STOCK))
    cost = broker.get_position("NVDA").avg_entry_price
    tracker = _tracker(tmp_path)
    broker.market._prices["NVDA"] = cost * 1.10          # +10%: armed, new day high
    assert run_check(ctx, CFG, tracker, today="2026-10-01")[0].action == "hold"
    broker.market._prices["NVDA"] = cost * 1.06          # ~3.6% below the high, still in profit
    d = run_check(ctx, CFG, tracker, today="2026-10-01")[0]
    assert d.action == "sell_now" and d.result == "filled"
    assert broker.get_position("NVDA") is None
    sell = broker.get_fills()[-1]
    assert sell.side == Side.SELL and sell.qty == 50 and sell.price >= cost
    assert any(e["event"] == "profit_protect_trigger" for e in ctx.journal.tail(10))


def test_run_check_breakeven_resting_sell_then_fill(ctx, broker, tmp_path):
    broker.submit_order(Order("JPM", 20, Side.BUY, AssetClass.STOCK))
    cost = broker.get_position("JPM").avg_entry_price
    tracker = _tracker(tmp_path)
    broker.market._prices["JPM"] = cost * 1.02
    run_check(ctx, CFG, tracker, today="2026-10-01")
    broker.market._prices["JPM"] = cost * 0.97            # gapped below cost between checks
    d = run_check(ctx, CFG, tracker, today="2026-10-01")[0]
    assert d.action == "sell_at_cost" and d.result == "new" and d.limit_price >= cost
    assert broker.get_position("JPM").qty == 20           # did NOT sell at a loss
    d2 = run_check(ctx, CFG, tracker, today="2026-10-01")[0]
    assert d2.result == "already has a working sell order"
    broker.market._prices["JPM"] = cost * 1.002           # recovers to cost -> resting order fills
    run_check(ctx, CFG, tracker, today="2026-10-01")
    assert broker.get_position("JPM") is None and broker.get_fills()[-1].price >= cost


def test_run_check_ignores_never_profitable_and_options(ctx, broker, tmp_path):
    broker.submit_order(Order("AAPL", 10, Side.BUY, AssetClass.STOCK))
    cost = broker.get_position("AAPL").avg_entry_price
    broker.market._prices["AAPL"] = cost * 0.80
    decisions = run_check(ctx, CFG, _tracker(tmp_path), today="2026-10-01")
    assert [d.action for d in decisions] == ["hold"] and broker.get_position("AAPL").qty == 10


def test_run_check_dry_run_and_live_without_auto(ctx, broker, tmp_path):
    broker.submit_order(Order("MSFT", 5, Side.BUY, AssetClass.STOCK))
    cost = broker.get_position("MSFT").avg_entry_price
    tracker = _tracker(tmp_path)
    broker.market._prices["MSFT"] = cost * 1.2
    run_check(ctx, CFG, tracker, today="2026-10-01")
    broker.market._prices["MSFT"] = cost * 1.1
    assert run_check(ctx, CFG, tracker, execute=False, today="2026-10-01")[0].result == "dry_run"
    ctx.settings.trading_mode = "alpaca-live"   # live + auto_sell_live=false -> uses ctx.approver
    ctx.approver = deny_all
    assert run_check(ctx, CFG, tracker, today="2026-10-01")[0].result == "declined_by_user"
    assert broker.get_position("MSFT").qty == 5


def test_tracker_daily_ohlc_and_log(tmp_path):
    t = _tracker(tmp_path)
    for p in (10, 12, 9, 11):
        t.observe("X", p, 10, 1, "2026-10-01")
    assert t.state["days"]["X"] == {"open": 10, "high": 12, "low": 9, "last": 11}
    t.observe("X", 13, 10, 1, "2026-10-02")
    assert t.state["days"]["X"]["open"] == 13 and t.state["peaks"]["X"] == 13
    assert len(t.log_rows()) == 5


# ------------------------------------------------------------------ dashboard
def test_dashboard_builds_and_escapes(ctx, broker, tmp_path):
    broker.submit_order(Order("SPY", 3, Side.BUY, AssetClass.ETF))
    broker.submit_order(Order("SPY", 3, Side.SELL, AssetClass.ETF))
    EquityHistory(tmp_path / "equity_history.jsonl").snapshot(broker)
    PriceTracker(tmp_path / "price_tracker.json", tmp_path / "price_log.jsonl").observe("SPY", 560, 559, 3, "2026-10-01")
    data = build_data(broker, tmp_path, "paper")
    assert data["summary"]["closed_trades"] == 1 and data["prices"][0]["symbol"] == "SPY"
    data["mode"] = "</script><script>alert(1)</script>"
    html = render(data)
    assert "</script><script>alert(1)" not in html and html.startswith("<!doctype html>")
    payload = html.split("const DATA = ", 1)[1].split(";\nconst NS", 1)[0]
    assert json.loads(payload.replace("<\\/", "</"))["summary"]["closed_trades"] == 1


def test_pnl_and_tracking_skills(registry, ctx, broker):
    broker.submit_order(Order("QQQ", 2, Side.BUY, AssetClass.ETF))
    out = registry.get("track_prices").run(ctx)
    assert out["dry_run"] is True and out["decisions"][0]["symbol"] == "QQQ"
    assert registry.get("get_price_tracking").run(ctx)["today"]["QQQ"]
    assert registry.get("get_pnl_summary").run(ctx)["closed_trades"] == 0
