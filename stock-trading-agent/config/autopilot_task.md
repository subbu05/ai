Daily portfolio maintenance:

1. Check the account, positions and open orders.
2. Target allocation: VTI 50%, VXUS 15%, AGG 25% (10% cash). Run rebalance_portfolio with
   dry_run=true and tolerance 0.03. If any trade is needed, execute it with dry_run=false.
3. For any stock position of at least 100 shares with no covered call open, find a call
   ~30-45 days out with delta between 0.20 and 0.30 and sell one covered call per 100 shares
   using a limit order at the mid.
4. Report a short summary: trades placed, fills, current allocation, and anything the risk
   engine rejected.
