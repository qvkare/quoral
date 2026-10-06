import Link from "next/link";
import { LatestProvider, LiveScore, LiveClauses } from "@/components/Landing";

const PERMISSIONS: { action: string; cells: [string, string, string, string]; critical?: boolean }[] = [
  { action: "Place quotes on Kuru", cells: ["No", "No", "Yes", "No"] },
  { action: "Cancel resting quotes", cells: ["After the end", "No", "While live", "No"] },
  { action: "Move inventory out of the vault", cells: ["After notice or expiry", "No", "No", "No"], critical: true },
  { action: "Own the fills", cells: ["Yes, in the vault", "No", "No", "No"], critical: true },
  { action: "Receive the retainer", cells: ["Refunds only", "Yes", "No", "No"] },
  { action: "Settle epochs (clawback, slash)", cells: ["Yes", "Yes", "Yes", "Yes"] },
  { action: "Give notice", cells: ["Yes", "Yes", "No", "No"] },
  { action: "Replace the operator key", cells: ["Both together", "Both together", "No", "No"] },
];

export default function Landing() {
  return (
    <main className="flush">
      <LatestProvider>
        <section className="hero">
          <div className="wrap">
            <h1 className="display">If the quotes stop, the pay stops.</h1>
            <p className="lead">
              Quoral turns a token&apos;s market-making deal into a contract on Kuru, Monad&apos;s onchain order book. The market maker quotes
              from a vault it cannot withdraw from and proves spread and depth every 30 seconds. <strong>Miss a bar and that bar&apos;s retainer
              goes back to the issuer.</strong>
            </p>
            <div className="hero-cta">
              <Link href="/issuer" className="btn primary lg">Open an RFQ</Link>
              <Link href="/agreements" className="textlink">Read the live terms</Link>
            </div>
            <LiveScore />
          </div>
        </section>

        <section className="movement">
          <div className="wrap">
            <div className="movement-head">
              <h2>Six clauses, each one a line of code.</h2>
              <p>
                These are the live terms of the agreement above, read from the contract. Nothing else is negotiable: there is no volume
                target, no price target, no token loan and no call option.
              </p>
            </div>
            <LiveClauses />
          </div>
        </section>

        <section className="movement">
          <div className="wrap">
            <div className="movement-head">
              <h2>The market maker never holds the inventory.</h2>
              <p>
                Kuru credits fills to the vault&apos;s margin account, not to the market maker. The operator key can quote and nothing else, so a
                stolen key cannot move a single token.
              </p>
            </div>
            <div className="tbl-wrap">
              <table className="perm">
                <thead>
                  <tr><th>Who can</th><th>Issuer</th><th>Market maker</th><th>Operator key</th><th>Anyone</th></tr>
                </thead>
                <tbody>
                  {PERMISSIONS.map((r) => (
                    <tr key={r.action} className={r.critical ? "critical" : ""}>
                      <td>{r.action}</td>
                      {r.cells.map((c, i) => (
                        <td key={i} className={c === "No" ? "no" : "yes"}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="movement">
          <div className="wrap">
            <div className="movement-head">
              <h2>Why the deal has to be public now.</h2>
              <p>Market-making terms used to be a private side letter. Exchanges, regulators and holders have stopped accepting that.</p>
            </div>
            <ol className="record">
              <li>
                <time dateTime="2026-03-25">25 March 2026</time>
                <p>Binance requires issuers to disclose their market maker and its terms, and bans profit-sharing, guaranteed returns and open-ended token loans.</p>
                <cite>Binance</cite>
              </li>
              <li>
                <time dateTime="2026-03-30">30 March 2026</time>
                <p>The US Department of Justice charges ten people at four market-making firms with wash trading.</p>
                <cite>US DOJ</cite>
              </li>
              <li>
                <time dateTime="2026">2026</time>
                <p>Fewer than 1 in 100 of the 150+ protocols studied disclose their market-maker terms publicly.</p>
                <cite>Novora, IR Transparency 2026</cite>
              </li>
              <li>
                <time dateTime="2026-07">July 2026</time>
                <p>Movement Labs files for Chapter 11 after a token-loan market-making deal ended in a $38M sell-off.</p>
                <cite>CoinDesk, court filings</cite>
              </li>
            </ol>
          </div>
        </section>

        <section className="movement">
          <div className="wrap">
            <div className="two-col">
              <div>
                <h3>For token issuers</h3>
                <p>
                  Write the SLA, lock inventory and a retainer budget, and award the seat to a bonded bid. You keep custody, you pay only for
                  bars that were quoted, and your holders get a page that answers the question they keep asking.
                </p>
                <p><Link href="/issuer" className="textlink">Open an RFQ</Link></p>
              </div>
              <div>
                <h3>For market makers</h3>
                <p>
                  Bid a retainer with a bond behind it, run your own quoter or the Quoral house quoter, and get paid for every bar you prove.
                  No invoices, and no argument about whether you showed up.
                </p>
                <p><Link href="/mm" className="textlink">See open RFQs</Link></p>
              </div>
            </div>
          </div>
        </section>

        <section className="movement" id="questions">
          <div className="wrap" style={{ maxWidth: 900, marginLeft: "auto", marginRight: "auto" }}>
            <div className="movement-head" style={{ gridTemplateColumns: "1fr" }}>
              <h2>Questions</h2>
            </div>
            <div className="faq">
              <details>
                <summary>What exactly is measured, and when?</summary>
                <p>
                  Every epoch (100 blocks, about 30 seconds on Monad) needs one fresh two-sided quote. Its spread must be within the SLA and its
                  depth within the band must meet the minimum on both sides. The check runs inside the requote transaction, against the
                  vault&apos;s own orders.
                </p>
              </details>
              <details>
                <summary>Can the market maker walk away with the inventory?</summary>
                <p>
                  No. The vault owns the Kuru margin balance and every order. The operator key can only call <code>requote</code> and{" "}
                  <code>cancel</code>, fills are credited back to the vault, and withdrawals go to the issuer after notice or expiry.
                </p>
              </details>
              <details>
                <summary>What if Kuru pauses the market?</summary>
                <p>
                  The pause is read from the chain, and anyone can mark that epoch as excused. It shows up as G.P. in the score and the market
                  maker is not penalised for it.
                </p>
              </details>
              <details>
                <summary>Who settles the epochs?</summary>
                <p>
                  Anyone can. A Chainlink CRE workflow does it every 30 seconds, a self-hosted keeper is the fallback, and both parties have a
                  reason to do it themselves: the issuer to get refunds, the market maker to get paid.
                </p>
              </details>
              <details>
                <summary>Is it audited?</summary>
                <p>Not yet. The contracts have a full test suite but this is hackathon software. Use small inventory until an audit is done.</p>
              </details>
            </div>
          </div>
        </section>

        <section className="closing">
          <div className="wrap">
            <p className="big">Ask your market maker for the score.</p>
            <div className="hero-cta">
              <Link href="/issuer" className="btn primary lg">Open an RFQ</Link>
              <Link href="/mm" className="textlink">I make markets</Link>
            </div>
          </div>
        </section>
      </LatestProvider>
    </main>
  );
}
