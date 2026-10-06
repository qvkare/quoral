/**
 * Creates the Quoral operator policy + a policy-locked Privy server wallet for one agreement.
 *   AGREEMENT=0x… PRIVY_APP_ID=… PRIVY_APP_SECRET=… pnpm --filter @quoral/bot privy:setup
 * Prints PRIVY_WALLET_ID and the wallet address; then propose/accept it as operator on the vault (2-of-2).
 */
import { readFileSync } from "node:fs";
import { cfg, chainId, agreementAddress } from "./config";

async function main() {
  const { appId, appSecret } = cfg.privy;
  const headers = {
    "content-type": "application/json",
    "privy-app-id": appId,
    authorization: "Basic " + Buffer.from(`${appId}:${appSecret}`).toString("base64"),
  };
  const vault = agreementAddress();
  const template = readFileSync(new URL("../privy-policy.json", import.meta.url), "utf8");
  const policy = JSON.parse(template.replaceAll("<VAULT>", vault.toLowerCase()).replaceAll("<CHAIN_ID>", String(chainId)));

  const p = await fetch("https://api.privy.io/v1/policies", { method: "POST", headers, body: JSON.stringify(policy) });
  const pj = await p.json();
  if (!p.ok) throw new Error(`policy: ${JSON.stringify(pj)}`);

  const w = await fetch("https://api.privy.io/v1/wallets", {
    method: "POST",
    headers,
    body: JSON.stringify({ chain_type: "ethereum", policy_ids: [pj.id] }),
  });
  const wj = await w.json();
  if (!w.ok) throw new Error(`wallet: ${JSON.stringify(wj)}`);
  console.log(`policy   ${pj.id}\nPRIVY_WALLET_ID=${wj.id}\noperator ${wj.address}`);
  console.log(`next: vault.proposeOperator(${wj.address}) from the MM, vault.acceptOperator() from the issuer`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
