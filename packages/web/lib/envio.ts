import { ENVIO_URL, fmt, isPrivyOperator, short } from "./chain";
import type { AgreementView } from "./agreement";

export type LogRow = { block: bigint; tx?: string; when?: string; text: string; pencil?: boolean };

type Ev = { kind: string; amount: string | null; detail: string | null; block: string; txHash: string };

/**
 * The agreement's history from Envio HyperIndex with transaction hashes: the latest proofs, plus every fill, clawback,
 * slash and lifecycle event, so a proof every epoch does not push the rarer events off the page.
 */
export async function envioRows(a: AgreementView, proofs = 8, others = 30): Promise<LogRow[]> {
  const res = await fetch(ENVIO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query ($id: String!, $p: Int!, $o: Int!) {
        proofs: AgreementEvent(where: { agreement_id: { _eq: $id }, kind: { _eq: "QUOTE" } }, order_by: { block: desc }, limit: $p) { kind amount detail block txHash }
        others: AgreementEvent(where: { agreement_id: { _eq: $id }, kind: { _neq: "QUOTE" } }, order_by: { block: desc }, limit: $o) { kind amount detail block txHash }
      }`,
      variables: { id: a.vault.toLowerCase(), p: proofs, o: others },
    }),
  });
  const j = (await res.json()) as { data?: { proofs: Ev[]; others: Ev[] }; errors?: { message: string }[] };
  if (!j.data) throw new Error(j.errors?.[0]?.message ?? `envio ${res.status}`);
  return [...j.data.proofs, ...j.data.others]
    .sort((x, y) => Number(BigInt(y.block) - BigInt(x.block)))
    .map((e) => ({ block: BigInt(e.block), tx: e.txHash, ...describe(a, e) }));
}

function describe(a: AgreementView, e: Ev): { text: string; pencil?: boolean } {
  const qd = a.quote.decimals;
  const Q = a.quote.symbol;
  const B = a.base.symbol;
  const pp = Number(a.scale.pricePrecision);
  const sp = Number(a.scale.sizePrecision);
  const amt = e.amount ? BigInt(e.amount) : 0n;
  const px = (raw: string) => (Number(raw) > 0 ? (Number(raw) / pp).toFixed(2) : "none");
  switch (e.kind) {
    case "QUOTE": {
      // "epoch 12: 41029000 / 41067000, 25 bps"
      const m = /epoch (\d+): (\d+) \/ (\d+), (\d+) bps/.exec(e.detail ?? "");
      return { text: m ? `Proof for epoch ${m[1]}: bid ${px(m[2])}, ask ${px(m[3])}, spread ${m[4]} bps, resting on the book.` : "Requote proven." };
    }
    case "FILL": {
      const side = e.detail?.startsWith("bid") ? "sold into the vault's bid" : "bought from the vault's ask";
      const at = /@ (\d+)/.exec(e.detail ?? "")?.[1];
      return { text: `A taker ${side}: ${(Number(amt) / sp).toFixed(4)} ${B}${at ? ` at ${px(at)}` : ""}. The proceeds stay in the vault.` };
    }
    case "CLAWBACK":
      return { text: `${e.detail ?? "Missed epochs"} missed, settled: ${fmt(amt, qd, 4)} ${Q} returned to the issuer.`, pencil: true };
    case "SLASH":
      return { text: `Uptime below target: bond slashed ${fmt(amt, qd)} ${Q} to the issuer.`, pencil: true };
    case "CLAIM":
      return { text: `Market maker paid ${fmt(amt, qd, 4)} ${Q} of earned retainer.` };
    case "REFUND":
      return { text: `Unused retainer of ${fmt(amt, qd)} ${Q} refunded to the issuer.` };
    case "EXCUSED":
      return { text: `${e.detail ?? "Epoch"} excused: the venue was paused.` };
    case "INVENTORY_LIMITED":
      return { text: `${e.detail ?? "Inventory used up"} (the depth term is met by posting all of it).` };
    case "INVENTORY_ADDED":
      return { text: `Issuer added inventory: ${fmt(amt, qd)} ${Q} (${e.detail ?? ""}).` };
    case "NOTICE":
      return { text: `Notice given (${e.detail ?? ""}).` };
    case "OPERATOR":
      return { text: `Operator key replaced by both parties: now ${short(e.detail ?? "")}${isPrivyOperator(e.detail) ? ", a policy-locked Privy server wallet" : ""}.` };
    case "WITHDRAW":
      return { text: "Inventory returned to the issuer." };
    case "FINALIZED":
      return { text: "Agreement finalized." };
    case "BOND_RELEASED":
      return { text: `Remaining bond of ${fmt(amt, qd)} ${Q} released to the market maker.` };
    case "CREATED":
      return { text: "Agreement awarded and deployed; terms published." };
    default:
      return { text: e.kind };
  }
}
