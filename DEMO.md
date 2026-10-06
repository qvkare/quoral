# Demo script (≤ 3 min)

Setup before recording: `pnpm local:chain`, `pnpm local:deploy`, `pnpm web`. Keep the bot and keeper ready in two terminals
(or point everything at mainnet with a small XAUt0-USDC or WETH-USDC agreement).

| Time | Show | Say |
|---|---|---|
| 0:00 | `/issuer`, sign in with a **passkey** (Mera). Set the SLA: 50 bps, 10k per side, 95% uptime, 30 days. Click **Approve & open RFQ**. | "Under 1% of projects disclose their MM deal. Here the deal is a contract. These are the only levers: spread, depth, uptime, retainer." |
| 0:30 | `/mm` as MM A/B/C: deposit bond, bid. Back in `/issuer`, the lowest bid is tagged. Click **Award**. | "Bonded RFQ. The winning bond moves into the agreement, losers unlock. The issuer's inventory goes into a vault, not to the MM." |
| 1:00 | `pnpm bot` log + agreement page: heartbeat strip turns green, spread/depth tiles, the retainer counter ticking per block, explorer link. | "Every 30 s the quoter calls `requote`. Kuru `postOnly` proves the quotes rest on the book, and SLALib proves spread and depth in the same tx." |
| 1:30 | `pnpm --filter @quoral/bot demo:attack` | "A stolen operator key: withdraw → NotIssuer. Bid 5 bps through the ask → Kuru PostOnlyError. Quote 100 bps wide → SpreadTooWide." |
| 2:00 | Stop the bot. Wait 3 epochs; the keeper (or anyone) calls `checkEpoch`. The strip goes red, the enforcement log shows a clawback and an uptime breach slashing the bond. | "No reporter, no committee. Missed epochs are refunded to the issuer, and breaking the uptime target slashes the bond." |
| 2:40 | Agreement page as a holder: parties, attestations, terms hash, inventory lock, embeddable badge. | "This is the disclosure Binance now asks for, live onchain and enforced on Monad: 300 ms blocks make a proof every 30 s affordable: about 0.07 MON per requote at the 100 gwei floor, roughly $2k a year at our measured ~0.7M gas." |
