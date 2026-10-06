import { type Address } from "viem";
import { inventoryVaultAbi, heartbeatAbi } from "@quoral/shared";
import { publicClient, isAddress } from "@/lib/chain";
import { resolveAgreement } from "@/lib/agreement";

export const dynamic = "force-dynamic";

/** Embeddable SVG badge: live compliance + uptime, read from chain on every request (cached 15 s). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let label = "unknown";
  let color = "#97978f";
  try {
    if (!isAddress(id)) throw new Error("bad address");
    const vault = (await resolveAgreement(id)) as Address | undefined;
    if (!vault) throw new Error("not found");
    const v = { address: vault, abi: inventoryVaultAbi } as const;
    const [live, finalized, heartbeat, current, terms] = await Promise.all([
      publicClient.readContract({ ...v, functionName: "isLive" }),
      publicClient.readContract({ ...v, functionName: "finalized" }),
      publicClient.readContract({ ...v, functionName: "heartbeat" }),
      publicClient.readContract({ ...v, functionName: "currentEpoch" }),
      publicClient.readContract({ ...v, functionName: "terms" }),
    ]);
    const h = { address: heartbeat, abi: heartbeatAbi } as const;
    const windowEpochs = await publicClient.readContract({ ...h, functionName: "windowEpochs" });
    const [uptime, cur, prev] = await Promise.all([
      publicClient.readContract({ ...h, functionName: "windowUptimeBps", args: [current / BigInt(windowEpochs)] }),
      publicClient.readContract({ ...h, functionName: "status", args: [current] }),
      publicClient.readContract({ ...h, functionName: "status", args: [current > 0n ? current - 1n : 0n] }),
    ]);
    const pct = (Number(uptime) / 100).toFixed(1);
    if (finalized || !live) {
      label = "ended";
    } else if (cur === 1 || prev === 1) {
      label = `quoting, ${pct}% uptime`;
      color = Number(uptime) >= terms.uptimeBps ? "#3d3d39" : "#e0452b";
    } else {
      label = `no quote, ${pct}% uptime`;
      color = "#e0452b";
    }
  } catch {
    /* render "unknown" */
  }
  const left = "quoral";
  const lw = Math.round(6.2 * left.length + 14);
  const rw = Math.round(6.4 * label.length + 14);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${left}: ${label}">
<linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${lw + rw}" height="20" rx="4"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#141414"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/><rect width="${lw + rw}" height="20" fill="url(#g)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${left}</text><text x="${lw + rw / 2}" y="14">${label}</text></g></svg>`;
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=15" },
  });
}
