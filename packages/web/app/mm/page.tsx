"use client";

import Link from "next/link";
import { useState } from "react";
import { parseUnits, erc20Abi, type Address } from "viem";
import { bondVaultAbi, rfqAuctionAbi, inventoryVaultAbi, paystreamAbi, iKuruOrderBookAbi } from "@quoral/shared";
import { useWallet } from "@/lib/wallet";
import { usePoll } from "@/lib/hooks";
import { dep, fmt, short, blocksToDuration, BLOCK_MS, publicClient, isAddress } from "@/lib/chain";
import { listAgreements, listRFQs, loadAgreement, token } from "@/lib/agreement";
import { write, ensureAllowance, settleAll, DAY_MS } from "@/lib/actions";
import { TxButton, PageHead, StatusPill, Ledger } from "@/components/ui";

export default function MMConsole() {
  const w = useWallet();
  const d = dep();
  const me = w.address?.toLowerCase();
  const [amount, setAmount] = useState("5000");

  const { data: bond, refresh: refreshBond } = usePoll(
    async () => {
      const t = await token((await publicClient.readContract({ address: d.bondVault, abi: bondVaultAbi, functionName: "token" })) as Address);
      if (!w.address) return { t, free: 0n, locked: 0n, wallet: 0n };
      const [free, locked, wallet] = await Promise.all([
        publicClient.readContract({ address: d.bondVault, abi: bondVaultAbi, functionName: "free", args: [w.address] }),
        publicClient.readContract({ address: d.bondVault, abi: bondVaultAbi, functionName: "locked", args: [w.address] }),
        publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [w.address] }),
      ]);
      return { t, free, locked, wallet };
    },
    4000,
    [w.address],
  );
  const { data: rfqs, refresh: refreshRfqs } = usePoll(listRFQs, 4000);
  const { data: mine, refresh: refreshMine } = usePoll(
    async () => {
      if (!me) return [];
      const all = await Promise.all((await listAgreements()).map((a) => loadAgreement(a, 1)));
      return all.filter((a) => a.mm.toLowerCase() === me);
    },
    3000,
    [me],
  );
  const { data: block } = usePoll(() => publicClient.getBlockNumber(), 2000);
  const sendW = (fn: (x: { client: NonNullable<typeof w.client>; account: NonNullable<typeof w.account> }) => Promise<`0x${string}`>) =>
    w.send((client, account) => fn({ client, account }));

  return (
    <main>
      <div className="wrap stack" style={{ gap: 24 }}>
      <PageHead
        crumb="Market makers"
        title="Bid for the seat, get paid per bar"
        sub="Post a bond, bid a retainer on an open RFQ, and connect a quoter: your own, or the Quoral house quoter built on Avellaneda and Stoikov. Every bar you prove pays out; every bar you miss goes back to the issuer."
      />
      {!w.address && (
        <div className="notice">Sign in to deposit a bond and bid. On the local demo, pick MM A, B or C in the sign-in menu.</div>
      )}

      <Ledger
        items={[
          { k: "Free bond", v: bond ? `${fmt(bond.free, bond.t.decimals)} ${bond.t.symbol}` : "n/a", s: "available to back new bids" },
          { k: "Locked in bids", v: bond ? `${fmt(bond.locked, bond.t.decimals)} ${bond.t.symbol}` : "n/a", s: "unlocks when you withdraw a losing bid" },
          { k: "Wallet", v: bond ? `${fmt(bond.wallet, bond.t.decimals)} ${bond.t.symbol}` : "n/a", s: "bond token balance" },
          { k: "Agreements", v: mine ? mine.length.toString() : "n/a", s: "awarded to this account" },
        ]}
      />

      <section className="card pad-lg stack">
        <h2 style={{ margin: 0 }}>Bond</h2>
        <p className="muted small" style={{ margin: 0 }}>Each bid locks the RFQ&apos;s bond amount from your free balance. Losing bids unlock; the winning bond backs the agreement.</p>
        <div className="row">
          <span className="suffix" style={{ maxWidth: 220, width: "100%" }}><input aria-label="Bond amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /><span>{bond?.t.symbol ?? ""}</span></span>
          <TxButton label="Deposit" className="primary" disabled={!w.address || !bond} onDone={refreshBond}
            run={async () => {
              const v = parseUnits(amount, bond!.t.decimals);
              await ensureAllowance({ client: w.client!, account: w.account! }, bond!.t.address, w.address!, d.bondVault, v);
              return sendW((x) => write(x, d.bondVault, bondVaultAbi, "deposit", [v]));
            }} />
          <TxButton label="Withdraw" disabled={!w.address || !bond} onDone={refreshBond}
            run={() => sendW((x) => write(x, d.bondVault, bondVaultAbi, "withdraw", [parseUnits(amount, bond!.t.decimals)]))} />
        </div>
      </section>

      <section className="card pad-lg stack">
        <h2 style={{ margin: 0 }}>Open RFQs</h2>
        {!rfqs?.filter((r) => r.status === 1).length && <p className="muted">No open RFQs.</p>}
        {rfqs?.filter((r) => r.status === 1).map((r) => (
          <RFQCard key={r.id.toString()} r={r} block={block} me={me} onDone={() => { refreshRfqs(); refreshBond(); }} />
        ))}
      </section>

      <section className="card pad-lg stack">
        <h2 style={{ margin: 0 }}>Your agreements</h2>
        {!mine?.length && <p className="muted">No awarded agreements for this account.</p>}
        {mine?.map((a) => (
          <div key={a.vault} className="card flat">
            <div className="row between">
              <Link href={`/${a.vault}`} style={{ textDecoration: "none" }}><b>{a.base.symbol} / {a.quote.symbol}</b> <span className="mono muted">{short(a.vault)}</span></Link>
              <StatusPill a={a} />
              <span className="muted small" style={{ flexBasis: "100%" }}>
                Operator key <span className="mono">{short(a.operator)}</span>. Last spread {a.proof.blockNumber > 0n ? `${a.proof.spreadBps} bps` : "n/a"}, uptime{" "}
                {(Number(a.epoch.uptimeBps) / 100).toFixed(1)}% this window.
              </span>
            </div>
            <div style={{ marginTop: 14 }}>
              <Ledger
                items={[
                  { k: "Claimable", v: fmt(a.pay.claimable, a.quote.decimals, 4), s: a.quote.symbol },
                  { k: "Streamed so far", v: fmt(a.pay.liveAccrued, a.quote.decimals, 4), s: "settles every epoch" },
                  { k: "Clawed back", v: fmt(a.pay.clawedBack, a.quote.decimals, 4), s: `${a.counts.missed} missed epochs`, pencil: a.pay.clawedBack > 0n },
                  { k: "Bond", v: fmt(a.bond.amount, a.quote.decimals), s: a.bond.slashed > 0n ? `${fmt(a.bond.slashed, a.quote.decimals)} slashed` : "intact", pencil: a.bond.slashed > 0n },
                ]}
              />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <TxButton label="Settle and claim" className="primary" onDone={refreshMine}
                run={async () => {
                  const out: `0x${string}`[] = [];
                  try { out.push(await sendW((x) => settleAll(x, a.vault))); } catch { /* nothing to settle */ }
                  out.push(await sendW((x) => write(x, a.paystream, paystreamAbi, "claim")));
                  return out;
                }} />
              <OperatorRotate vault={a.vault} pending={a.pendingOperator} onDone={refreshMine} />
              {a.live && !a.noticeGiven && (
                <TxButton label="Give notice" className="danger" onDone={refreshMine}
                  run={() => sendW((x) => write(x, a.vault, inventoryVaultAbi, "giveNotice"))} />
              )}
            </div>
            <p className="muted small" style={{ marginBottom: 0, marginTop: 12 }}>
              To run the house quoter, use <code>AGREEMENT={a.vault} pnpm bot</code> with the operator key or a Privy policy-locked wallet.
            </p>
          </div>
        ))}
      </section>
      </div>
    </main>
  );
}

type R = Awaited<ReturnType<typeof listRFQs>>[number];

function RFQCard({ r, block, me, onDone }: { r: R; block?: bigint; me?: string; onDone: () => void }) {
  const w = useWallet();
  const d = dep();
  const blocksPerDay = BigInt(Math.round(DAY_MS / BLOCK_MS));
  const [perDay, setPerDay] = useState("");
  const [operator, setOperator] = useState("");
  const { data: info } = usePoll(async () => {
    const params = await publicClient.readContract({
      address: r.terms.market,
      abi: iKuruOrderBookAbi,
      functionName: "getMarketParams",
    });
    const [b, q] = await Promise.all([token(params[2]), token(params[4])]);
    return { b, q };
  }, 60_000, [r.id]);
  const mine = r.bids.find((b) => b.bidder.toLowerCase() === me);
  const best = r.bids.filter((b) => b.active).sort((a, b) => Number(a.retainerPerBlock - b.retainerPerBlock))[0];
  const q = info?.q;
  const closed = block !== undefined && block > r.deadline;
  return (
    <div className="card flat">
      <div className="row between">
        <b>RFQ {r.id.toString()}, {info ? `${info.b.symbol} / ${info.q.symbol}` : short(r.terms.market)}</b>
        <span className="muted" style={{ fontSize: 13 }}>
          {closed ? "bidding closed" : block !== undefined ? `closes in ${blocksToDuration(r.deadline - block)}` : ""}
        </span>
      </div>
      {q && (
        <p className="muted small" style={{ marginTop: 4, marginBottom: 0 }}>
          Spread at most {r.terms.maxSpreadBps} bps, depth {fmt(r.terms.minDepthQuote, q.decimals, 0)} {q.symbol} per side, {r.terms.uptimeBps / 100}% uptime
          for {blocksToDuration(r.terms.durationBlocks)}. Bond {fmt(r.terms.bondAmount, q.decimals)} {q.symbol}. The issuer pays at most{" "}
          {fmt(r.terms.retainerPerBlock * blocksPerDay, q.decimals)} {q.symbol} a day
          {best ? <>; the lowest bid so far is {fmt(best.retainerPerBlock * blocksPerDay, q.decimals)}.</> : "."}
        </p>
      )}
      {!closed && q && (
        <div className="row" style={{ marginTop: 10 }}>
          <input style={{ maxWidth: 170 }} placeholder={`Retainer, ${q.symbol} per day`} value={perDay} onChange={(e) => setPerDay(e.target.value)} />
          <input style={{ maxWidth: 360 }} className="mono" placeholder="Operator key address (defaults to you)" value={operator} onChange={(e) => setOperator(e.target.value)} />
          <TxButton
            className="primary"
            label={mine?.active ? "Update bid" : "Place bid and lock bond"}
            disabled={!w.address || !perDay}
            onDone={onDone}
            run={() => {
              const rate = parseUnits(perDay, q.decimals) / blocksPerDay;
              const op = isAddress(operator) ? operator : w.address!;
              return w.send((client, account) => write({ client, account }, d.rfq, rfqAuctionAbi, "bid", [r.id, rate, op]));
            }}
          />
          {mine?.active && (
            <TxButton label="Withdraw bid" onDone={onDone}
              run={() => w.send((client, account) => write({ client, account }, d.rfq, rfqAuctionAbi, "withdrawBid", [r.id]))} />
          )}
        </div>
      )}
    </div>
  );
}

function OperatorRotate({ vault, pending, onDone }: { vault: Address; pending: Address; onDone: () => void }) {
  const w = useWallet();
  const [op, setOp] = useState("");
  return (
    <span className="row">
      <input style={{ maxWidth: 330 }} className="mono" placeholder="New operator key, e.g. a Privy wallet" value={op} onChange={(e) => setOp(e.target.value)} />
      <TxButton label="Propose operator" disabled={!isAddress(op)} onDone={onDone}
        run={() => w.send((client, account) => write({ client, account }, vault, inventoryVaultAbi, "proposeOperator", [op]))} />
      {pending !== "0x0000000000000000000000000000000000000000" && <span className="muted small">{short(pending)} is waiting for the issuer to accept</span>}
    </span>
  );
}
