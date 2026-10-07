"use client";

import { parseAbi, parseUnits, type Address } from "viem";
import { useWallet } from "@/lib/wallet";
import { usePoll } from "@/lib/hooks";
import { CHAIN_ID, dep, publicClient } from "@/lib/chain";
import { token } from "@/lib/agreement";
import { write } from "@/lib/actions";
import { TxButton } from "@/components/ui";

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

/** Testnet only: the demo's test tokens have an open mint, so anyone can try the issuer and MM flows. */
export function Faucet() {
  const w = useWallet();
  const d = dep();
  const { data: mon, refresh } = usePoll(
    async () => (w.address ? publicClient.getBalance({ address: w.address as Address }) : undefined),
    8000,
    [w.address],
  );
  if (CHAIN_ID !== 10143 || !w.address || !d.base || !d.quote) return null;
  const lowGas = mon !== undefined && mon < 50_000_000_000_000_000n; // 0.05 MON

  async function mint(addr: Address, whole: string) {
    const t = await token(addr);
    return w.send((client, account) => write({ client, account }, addr, mintAbi, "mint", [w.address as Address, parseUnits(whole, t.decimals)]));
  }

  return (
    <section className="card flat stack" style={{ gap: 10 }} aria-label="Test tokens">
      <div className="row between" style={{ alignItems: "baseline" }}>
        <b>Test tokens</b>
        <span className="muted small">Monad testnet only. These tokens have no value.</span>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Mint test XAUt0 and USDC to try the flows: inventory and a retainer budget as an issuer, a bond as a market maker.
        {lowGas && (
          <>
            {" "}You also need a little testnet MON for gas: get some from the{" "}
            <a href="https://faucet.monad.xyz" target="_blank" rel="noreferrer">Monad faucet</a>.
          </>
        )}
      </p>
      <div className="row" style={{ gap: 8 }}>
        <TxButton label="Mint 20 XAUt0" onDone={refresh} run={() => mint(d.base!, "20")} disabled={lowGas} />
        <TxButton label="Mint 100,000 USDC" onDone={refresh} run={() => mint(d.quote!, "100000")} disabled={lowGas} />
      </div>
    </section>
  );
}
