from trading_agent.brokers import PaperBroker
from trading_agent.models import AssetClass, Order, OrderStatus, OrderType, Side


def test_buy_and_sell_updates_cash_and_positions(broker):
    q = broker.get_quote("MSFT")
    o = broker.submit_order(Order("MSFT", 10, Side.BUY, AssetClass.STOCK))
    assert o.status == OrderStatus.FILLED
    assert broker.cash == 100_000 - 10 * q.ask
    assert broker.get_position("MSFT").qty == 10

    broker.submit_order(Order("MSFT", 10, Side.SELL, AssetClass.STOCK))
    assert broker.get_position("MSFT") is None


def test_non_marketable_limit_rests_and_cancels(broker):
    px = broker.get_quote("SPY").bid
    o = broker.submit_order(Order("SPY", 1, Side.BUY, AssetClass.ETF, OrderType.LIMIT, limit_price=px * 0.5))
    assert o.status == OrderStatus.NEW
    assert [x.id for x in broker.list_orders()] == [o.id]
    broker.cancel_order(o.id)
    assert broker.list_orders() == []


def test_insufficient_cash_rejected():
    b = PaperBroker(starting_cash=100)
    o = b.submit_order(Order("SPY", 10, Side.BUY, AssetClass.ETF))
    assert o.status == OrderStatus.REJECTED


def test_state_persists(tmp_path):
    path = tmp_path / "acct.json"
    b = PaperBroker(50_000, path)
    b.submit_order(Order("QQQ", 5, Side.BUY, AssetClass.ETF))
    b2 = PaperBroker(50_000, path)
    assert b2.get_position("QQQ").qty == 5
    assert b2.cash == b.cash


def test_option_chain_and_fill(broker):
    chain = broker.get_option_chain("AAPL")
    assert chain
    contract, quote = chain[0]
    o = broker.submit_order(Order(contract.occ_symbol, 1, Side.BUY, AssetClass.OPTION,
                                  OrderType.LIMIT, limit_price=quote.ask))
    assert o.status == OrderStatus.FILLED
    assert broker.cash < 100_000 - quote.ask * 100 + 1e-6  # premium x 100 + commission
