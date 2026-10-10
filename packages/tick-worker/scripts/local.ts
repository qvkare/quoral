/**
 * Run the tick loop from a laptop against any chain (rehearsal or fallback when the cron worker is down).
 *   RPC_URL=... CHAIN_ID=... VAULT=0x... OPERATOR_KEY=0x... pnpm --filter @quoral/tick-worker local
 * or, signing through the Privy server wallet: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID, PRIVY_ADDRESS instead.
 * Keys come from the environment only; nothing is read from or written to disk.
 */
import { tick, type Env } from "../src/tick";

const env = process.env as unknown as Env;
for (const k of ["RPC_URL", "CHAIN_ID", "VAULT"] as const) {
  if (!env[k]) throw new Error(`missing ${k}`);
}
if (!env.OPERATOR_KEY && !env.PRIVY_WALLET_ID) throw new Error("missing OPERATOR_KEY or PRIVY_WALLET_ID");
const every = Number(process.env.EVERY_S ?? 60) * 1000;

async function loop() {
  try {
    const r = await tick(env);
    console.log(new Date().toISOString().slice(11, 19), JSON.stringify(r));
  } catch (e) {
    console.error(new Date().toISOString().slice(11, 19), "error", e instanceof Error ? e.message.split("\n")[0] : e);
  }
}
await loop();
setInterval(loop, every);
