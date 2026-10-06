"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePoll } from "@/lib/hooks";
import { listAgreements, loadAgreement } from "@/lib/agreement";
import { fmt, short, blocksToDuration, BLOCK_MS } from "@/lib/chain";
import { PageHead, StatusPill, Skeleton } from "@/components/ui";
import { Score } from "@/components/Score";

export default function Agreements() {
  const router = useRouter();
  const { data, error } = usePoll(async () => Promise.all((await listAgreements()).map((a) => loadAgreement(a, 16, 16))), 3000);
  return (
    <main>
      <div className="wrap">
        <PageHead
          title="Agreements"
          sub="Every market-making agreement on Quoral with its terms and its last sixteen bars. Open one to read the full public terms."
          right={<Link href="/issuer" className="btn primary">New agreement</Link>}
        />
        {error && <div className="notice pencil" role="alert" style={{ marginBottom: 16 }}>Could not reach the chain: {error}</div>}
        {!data ? (
          <div className="stack" aria-busy="true"><Skeleton h={22} /><Skeleton h={22} /><Skeleton h={22} /></div>
        ) : data.length === 0 ? (
          <div style={{ padding: "28px 0", borderTop: "1px solid var(--ink)" }}>
            <h2>No agreements yet</h2>
            <p className="muted">The first awarded RFQ creates the first one.</p>
            <Link href="/issuer" className="btn primary">Open an RFQ</Link>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="cards">
              <thead>
                <tr>
                  <th>Market</th>
                  <th style={{ width: "26%" }}>Last 16 bars</th>
                  <th className="num">Spread</th>
                  <th className="num">Depth per side</th>
                  <th className="num">Uptime</th>
                  <th className="num">Retainer</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.map((a) => {
                  const perDay = (a.pay.retainerPerBlock * 86_400_000n) / BigInt(BLOCK_MS);
                  const qd = a.quote.decimals;
                  const minDepth = a.proof.bidDepth < a.proof.askDepth ? a.proof.bidDepth : a.proof.askDepth;
                  return (
                    <tr key={a.vault} className="link" onClick={() => router.push(`/${a.vault}`)}>
                      <td className="head">
                        <Link href={`/${a.vault}`} onClick={(e) => e.stopPropagation()} style={{ textDecoration: "none", fontWeight: 600 }}>
                          {a.base.symbol} / {a.quote.symbol}
                        </Link>
                        <div className="muted small">
                          MM <span className="mono">{short(a.mm)}</span>
                        </div>
                      </td>
                      <td data-label="Last 16 bars" style={{ minWidth: 180 }}>
                        <Score bars={a.bars} current={a.epoch.current} settled={a.epoch.settled} progress={a.progress} variant="mini" />
                      </td>
                      <td data-label="Spread" className="num">
                        {a.proof.blockNumber > 0n ? `${a.proof.spreadBps} bps` : "n/a"}
                        <div className="faint small">limit {a.terms.maxSpreadBps}</div>
                      </td>
                      <td data-label="Depth per side" className="num">
                        {a.proof.blockNumber > 0n ? fmt(minDepth, qd, 0) : "n/a"}
                        <div className="faint small">min {fmt(a.terms.minDepthQuote, qd, 0)} {a.quote.symbol}</div>
                      </td>
                      <td data-label="Uptime" className="num">
                        {(Number(a.epoch.uptimeBps) / 100).toFixed(1)}%
                        <div className="faint small">target {a.terms.uptimeBps / 100}%</div>
                      </td>
                      <td data-label="Retainer" className="num">
                        {fmt(perDay, qd, 0)} {a.quote.symbol}
                        <div className="faint small">per day</div>
                      </td>
                      <td data-label="Status">
                        <StatusPill a={a} />
                        <div className="faint small" style={{ marginTop: 4 }}>
                          {a.live ? `${blocksToDuration(a.endBlock - a.blockNumber)} left` : "ended"}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
