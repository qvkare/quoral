"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { decodeEventLog, type Address } from "viem";
import { heartbeatAbi, paystreamAbi, inventoryVaultAbi } from "@quoral/shared";
import { usePoll } from "@/lib/hooks";
import { loadAgreement, resolveAgreement, type AgreementView } from "@/lib/agreement";
import { publicClient, fmt, short, blocksToDuration, isAddress, explorerAddr, explorerTx, BLOCK_MS, ENVIO_URL, VENUE } from "@/lib/chain";
import { Ledger, StatusPill, Skeleton } from "@/components/ui";
import { Score } from "@/components/Score";
import { envioRows } from "@/lib/envio";

export default function TermsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [vault, setVault] = useState<Address | null>();
  useEffect(() => {
    if (!isAddress(token)) return setVault(null);
    resolveAgreement(token).then((a) => setVault(a ?? null), () => setVault(null));
  }, [token]);

  return (
    <main>
      <div className="wrap">
        {vault === undefined ? (
          <Loading />
        ) : vault === null ? (
          <div style={{ padding: "40px 0" }}>
            <h1>No agreement found</h1>
            <p className="muted addr">{token}</p>
            <p className="muted">This address is not a Quoral agreement, and no agreement lists it as its token.</p>
            <Link href="/agreements" className="btn primary">Browse agreements</Link>
          </div>
        ) : (
          <Terms vault={vault} />
        )}
      </div>
    </main>
  );
}

function Loading() {
  return (
    <div className="stack" aria-busy="true">
      <Skeleton h={16} w={180} />
      <Skeleton h={44} w={420} />
      <Skeleton h={84} />
      <Skeleton h={180} />
    </div>
  );
}

function useProgress(a?: AgreementView) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return { now, progress: a ? Math.min(1, a.progress + (now - a.fetchedAt) / (a.terms.epochBlocks * BLOCK_MS)) : 0 };
}

function Terms({ vault }: { vault: Address }) {
  const { data: a, error } = usePoll(() => loadAgreement(vault, 96, 48), 2000, [vault]);
  const { now, progress } = useProgress(a);
  if (!a) return error ? <div className="notice pencil" role="alert">Could not load this agreement: {error}</div> : <Loading />;
  const t = a.terms;
  const qd = a.quote.decimals;
  const bd = a.base.decimals;
  const Q = a.quote.symbol;
  const perDay = a.pay.retainerPerBlock * BigInt(Math.round(86_400_000 / BLOCK_MS));
  const perBar = a.pay.retainerPerBlock * BigInt(t.epochBlocks);
  const returned = a.pay.clawedBack + a.bond.totalSlashed;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const has = a.proof.blockNumber > 0n;
  const extraBlocks = a.live ? Math.floor((now - a.fetchedAt) / BLOCK_MS) : 0;
  const streamed = a.pay.liveAccrued + a.pay.retainerPerBlock * BigInt(Math.max(0, extraBlocks));

  return (
    <div className="stack" style={{ gap: 44 }}>
      <div>
        <div className="crumbs"><Link href="/agreements">Agreements</Link> / {a.base.symbol}-{a.quote.symbol}</div>
        <div className="row between" style={{ alignItems: "flex-end", gap: 20 }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontWeight: 300, fontSize: "clamp(32px, 4.6vw, 54px)", letterSpacing: "-0.04em" }}>
              {a.base.symbol} / {a.quote.symbol} market making
            </h1>
            <p className="muted" style={{ margin: 0 }}>
              Agreement <span className="addr">{short(a.vault)}</span> on {VENUE.name} <span className="addr">{short(t.market)}</span>.{" "}
              {a.live ? `${blocksToDuration(a.endBlock - a.blockNumber)} remaining.` : "The agreement has ended."}
            </p>
          </div>
          <div className="stack" style={{ gap: 8, alignItems: "flex-start" }}>
            <StatusPill a={a} />
            <img src={`/badge/${a.vault}`} alt="Quoral status badge" height={20} />
          </div>
        </div>
      </div>

      <Ledger
        items={[
          { k: "Spread, last proof", v: has ? `${a.proof.spreadBps} bps` : "n/a", s: `limit ${t.maxSpreadBps} bps` },
          { k: "Depth per side", v: has ? `${fmt(a.proof.bidDepth, qd, 0)} / ${fmt(a.proof.askDepth, qd, 0)}` : "n/a", s: `minimum ${fmt(t.minDepthQuote, qd, 0)} ${Q}` },
          { k: "Uptime, this window", v: `${(Number(a.epoch.uptimeBps) / 100).toFixed(1)}%`, s: `target ${t.uptimeBps / 100}%, ${a.epoch.allowedMisses} ${a.epoch.allowedMisses === 1 ? "miss" : "misses"} allowed in ${a.epoch.windowEpochs}` },
          { k: "Returned to the issuer", v: `${fmt(returned, qd)} ${Q}`, s: "clawbacks and bond slashes", pencil: returned > 0n },
        ]}
      />

      <section>
        <div className="row between" style={{ alignItems: "baseline", marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>The score</h2>
          <span className="muted small">
            Bar {a.epoch.current.toLocaleString("en-US")} of {a.epoch.total.toLocaleString("en-US")}, settled through{" "}
            {(a.epoch.settled > 0n ? a.epoch.settled - 1n : 0n).toLocaleString("en-US")}
          </span>
        </div>
        <Score
          bars={a.bars}
          current={a.epoch.current}
          settled={a.epoch.settled}
          progress={progress}
          clawback={fmt(perBar, qd, 3)}
          tempoMs={BLOCK_MS}
          blocksPerBar={t.epochBlocks}
          variant="full"
        />
        <p className="caption">
          Each bar is one epoch of {t.epochBlocks} blocks. A chord is the vault&apos;s best bid and ask, resting on Kuru and proven in the
          requote transaction, with the spread in bps underneath. A circled rest is a missed epoch whose {fmt(perBar, qd, 3)} {Q} went back to
          the issuer. So far: {a.counts.quoted.toString()} quoted, {a.counts.excused.toString()} excused, {a.counts.missed.toString()} missed.
        </p>
      </section>

      <section className="grid g2" style={{ gap: 40 }}>
        <div>
          <h2>Retainer</h2>
          <div className="muted small">Streamed to the market maker so far, net of clawbacks</div>
          <div className="counter" style={{ margin: "2px 0 14px" }}>{fmt(streamed, qd, 4)} {Q}</div>
          <dl className="kv">
            <dt>Rate</dt>
            <dd>{fmt(perDay, qd)} {Q} per day</dd>
            <dt>Earned, settled</dt>
            <dd>{fmt(a.pay.earned, qd, 4)} {Q}</dd>
            <dt>Clawed back</dt>
            <dd style={{ color: a.pay.clawedBack > 0n ? "var(--pencil)" : undefined }}>{fmt(a.pay.clawedBack, qd, 4)} {Q} to the issuer</dd>
            <dt>Paid out</dt>
            <dd>{fmt(a.pay.claimed, qd, 4)} {Q}, of which {Number(a.pay.feeBps) / 100}% protocol fee</dd>
            <dt>In escrow</dt>
            <dd>{fmt(a.pay.escrow, qd)} {Q}</dd>
          </dl>
        </div>
        <div>
          <h2>Bond and inventory</h2>
          <dl className="kv">
            <dt>Bond</dt>
            <dd>
              {fmt(a.bond.amount, qd)} {Q}
              {a.bond.slashed > 0n && <span style={{ color: "var(--pencil)" }}>, {fmt(a.bond.slashed, qd)} slashed to the issuer</span>}
            </dd>
            <dt>Penalty</dt>
            <dd>{fmt(t.slashAmount, qd)} {Q} per window below {t.uptimeBps / 100}% uptime</dd>
            <dt>Price drift cap</dt>
            <dd>{t.maxMidMoveBps > 0 ? `the quoted mid may move at most ${(t.maxMidMoveBps / 100).toFixed(2)}% per epoch from the last proof` : "none"}</dd>
            <dt>Free in Kuru</dt>
            <dd>{fmt(a.inventory.base, bd, 4)} {a.base.symbol} and {fmt(a.inventory.quote, qd)} {Q}; the rest is in resting orders</dd>
            <dt>Committed</dt>
            <dd>{fmt(t.baseInventory, bd, 4)} {a.base.symbol} and {fmt(t.quoteInventory, qd)} {Q}</dd>
            <dt>Withdrawal</dt>
            <dd>
              Issuer only, from block {a.endBlock.toString()}
              {a.live ? ` (${blocksToDuration(a.endBlock - a.blockNumber)} away)` : ""}. Notice period {blocksToDuration(t.noticeBlocks)}.
            </dd>
          </dl>
        </div>
      </section>

      <section className="grid g2" style={{ gap: 40 }}>
        <div>
          <h2>Parties and disclosure</h2>
          <dl className="kv">
            <dt>Issuer</dt>
            <dd className="mono">{addr(a.issuer)} {a.disclosure.issuerAttested && <span className="muted">attested</span>}</dd>
            <dt>Market maker</dt>
            <dd className="mono">{addr(a.mm)} {a.disclosure.mmAttested && <span className="muted">attested</span>}</dd>
            <dt>Operator key</dt>
            <dd className="mono">{addr(a.operator)}</dd>
            <dt>Terms hash</dt>
            <dd className="addr">{a.disclosure.termsHash}</dd>
            <dt>Terms document</dt>
            <dd className="addr">{a.disclosure.uri || "none"}</dd>
            <dt>Not in the contract</dt>
            <dd>Volume or price targets, token loans, call options. The fee is time-based only.</dd>
          </dl>
        </div>
        <div>
          <h2>Embed</h2>
          <p className="muted">Show holders the live state of this agreement.</p>
          <img src={`/badge/${a.vault}`} alt="Quoral status badge" height={20} />
          <pre className="addr" style={{ whiteSpace: "pre-wrap", fontSize: 12.5, background: "var(--wash)", padding: 12, borderRadius: 6, marginTop: 12 }}>
            {`<a href="${origin}/${a.vault}"><img src="${origin}/badge/${a.vault}" alt="Quoral market-making terms"/></a>`}
          </pre>
        </div>
      </section>

      <Activity a={a} />
    </div>
  );
}

const addr = (x: string) =>
  explorerAddr(x) ? (
    <a href={explorerAddr(x)} target="_blank" rel="noreferrer">{short(x)}</a>
  ) : (
    short(x)
  );

type Row = { block: bigint; tx?: string; when?: string; text: string; pencil?: boolean };

/** Public Monad RPCs cap eth_getLogs at 100 blocks; then the log is rebuilt from contract state instead. */
function stateRows(a: AgreementView): Row[] {
  const qd = a.quote.decimals;
  const Q = a.quote.symbol;
  const perBar = a.pay.retainerPerBlock * BigInt(a.terms.epochBlocks);
  const rows: Row[] = a.bars
    .filter((b) => b.status === 3)
    .map((b) => ({ block: b.epoch, when: `epoch ${b.epoch}`, text: `Missed epoch settled. ${fmt(perBar, qd, 4)} ${Q} returned to the issuer.`, pencil: true }));
  if (a.bond.slashed > 0n) rows.push({ block: -1n, when: "to date", text: `Bond slashed ${fmt(a.bond.slashed, qd)} ${Q} in total for uptime breaches.`, pencil: true });
  if (a.noticeGiven) rows.push({ block: -2n, when: "notice", text: `Notice given. The agreement ends at block ${a.endBlock}.` });
  if (a.finalized) rows.push({ block: -3n, when: "final", text: "Agreement finalized." });
  return rows.sort((x, y) => Number(y.block - x.block));
}

function Activity({ a }: { a: AgreementView }) {
  const { data } = usePoll(
    async (): Promise<Row[]> => {
      if (ENVIO_URL) {
        try {
          return await envioRows(a);
        } catch {
          // fall through to the chain
        }
      }
      const latest = await publicClient.getBlockNumber();
      const fromBlock = latest > 20_000n ? latest - 20_000n : 0n;
      const qd = a.quote.decimals;
      const Q = a.quote.symbol;
      let hb, ps, vlt;
      try {
        [hb, ps, vlt] = await Promise.all([
          publicClient.getLogs({ address: a.heartbeat, fromBlock, toBlock: latest }),
          publicClient.getLogs({ address: a.paystream, fromBlock, toBlock: latest }),
          publicClient.getLogs({ address: a.vault, fromBlock, toBlock: latest }),
        ]);
      } catch {
        return stateRows(a);
      }
      const rows: Row[] = [];
      const dec = (abi: readonly unknown[], l: (typeof vlt)[number]) => {
        try {
          return decodeEventLog({ abi: abi as never, data: l.data, topics: l.topics }) as unknown as { eventName: string; args: Record<string, bigint | string> };
        } catch {
          return undefined;
        }
      };
      const push = (l: (typeof vlt)[number], text: string, pencil?: boolean) => rows.push({ block: l.blockNumber!, tx: l.transactionHash!, text, pencil });
      for (const l of hb) {
        const e = dec(heartbeatAbi, l);
        if (e?.eventName === "UptimeBreached") push(l, `Uptime fell below target in window ${e.args.window} (${e.args.misses} misses, ${e.args.allowedMisses} allowed). Bond slashed ${fmt(e.args.slashed as bigint, qd)} ${Q}.`, true);
        if (e?.eventName === "EpochExcused") push(l, `Epoch ${e.args.epoch} excused: the venue was paused.`);
      }
      for (const l of ps) {
        const e = dec(paystreamAbi, l);
        if (e?.eventName === "Clawback") push(l, `${e.args.missedEpochs} missed epoch(s) settled. ${fmt(e.args.amount as bigint, qd, 4)} ${Q} returned to the issuer.`, true);
        if (e?.eventName === "Claimed") push(l, `Market maker paid ${fmt(e.args.net as bigint, qd, 4)} ${Q} (fee ${fmt(e.args.fee as bigint, qd, 4)}).`);
        if (e?.eventName === "Refunded") push(l, `Unused retainer of ${fmt(e.args.amount as bigint, qd)} ${Q} refunded to the issuer.`);
      }
      for (const l of vlt) {
        const e = dec(inventoryVaultAbi, l);
        if (e?.eventName === "NoticeGiven") push(l, `Notice given by ${short(e.args.by as string)}. The agreement ends at block ${e.args.newEndBlock}.`);
        if (e?.eventName === "OperatorChanged") push(l, `Operator key replaced by both parties: now ${short(e.args.newOperator as string)}.`);
        if (e?.eventName === "Finalized") push(l, "Agreement finalized.");
        if (e?.eventName === "InventoryWithdrawn") push(l, "Inventory returned to the issuer.");
        if (e?.eventName === "InventoryLimited")
          push(l, `Epoch ${e.args.epoch}: ${e.args.askShort ? a.base.symbol : a.quote.symbol} inventory used up, so the vault posted all it had on that side.`);
        if (e?.eventName === "InventoryAdded") push(l, `Issuer added ${fmt(e.args.baseAmount as bigint, a.base.decimals, 4)} ${a.base.symbol} and ${fmt(e.args.quoteAmount as bigint, qd)} ${Q} of inventory.`);
      }
      return rows.sort((x, y) => Number(y.block - x.block)).slice(0, 25);
    },
    5000,
    [a.vault],
  );
  return (
    <section>
      <div className="row between" style={{ alignItems: "baseline" }}>
        <h2>Enforcement log</h2>
        <span className="muted small">{ENVIO_URL ? "Envio HyperIndex" : "Read from the chain"}</span>
      </div>
      {!data?.length ? (
        <p className="muted">{ENVIO_URL ? "No events indexed yet." : "No clawbacks, slashes or notices yet."}</p>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>When</th><th>Event</th><th className="num">Transaction</th></tr>
            </thead>
            <tbody>
              {data.map((r, i) => (
                <tr key={i}>
                  <td className="muted" style={{ width: 120 }}>{r.when ?? `block ${r.block}`}</td>
                  <td style={{ color: r.pencil ? "var(--pencil)" : undefined }}>{r.text}</td>
                  <td className="num mono">
                    {!r.tx ? <span className="faint">n/a</span> : explorerTx(r.tx) ? <a href={explorerTx(r.tx)} target="_blank" rel="noreferrer">{r.tx.slice(0, 10)}</a> : r.tx.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
