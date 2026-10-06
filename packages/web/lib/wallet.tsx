"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createWalletClient,
  custom,
  http,
  keccak256,
  concat,
  toBytes,
  toHex,
  type Account,
  type Address,
  type Hash,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  createSecp256k1SigningSession,
  type PasskeyCredentialMetadata,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { chain, RPC_URL, CHAIN_ID, publicClient } from "./chain";

type Kind = "passkey" | "injected" | "demo";
type Wallet = {
  kind?: Kind;
  address?: Address;
  client?: WalletClient;
  account?: Account | Address;
  connecting: boolean;
  error?: string;
  /** ms from the first connect click to the first confirmed tx (Mera bounty metric) */
  timeToFirstTx?: number;
  createPasskey(name: string): Promise<void>;
  connectPasskey(): Promise<void>;
  connectInjected(): Promise<void>;
  connectDemo(index: number): void;
  disconnect(): void;
  send(fn: (c: WalletClient, account: Account | Address) => Promise<Hash>): Promise<Hash>;
};

const Ctx = createContext<Wallet | null>(null);
const LS_CRED = "quoral.passkey.credential";
const LS_TTFT = "quoral.ttft";
const SS_SESSION = "quoral.session"; // remembers demo / browser-wallet sign-in across reloads (never a key)

// anvil default accounts, only offered on chain 31337
export const DEMO_KEYS: { label: string; key: `0x${string}` }[] = [
  { label: "Issuer (anvil #0)", key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" },
  { label: "MM A (anvil #1)", key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
  { label: "MM B (anvil #2)", key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  { label: "MM C (anvil #3)", key: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" },
];

/** App-side derivation: the passkey PRF output is the seed; mera keeps the key in a zeroizable session. */
const deriveKey = (prf: Uint8Array) => keccak256(concat([toBytes("quoral.evm.v1"), prf]), "bytes");

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<Wallet, "createPasskey" | "connectPasskey" | "connectInjected" | "connectDemo" | "disconnect" | "send">>({
    connecting: false,
  });
  const startedAt = useRef<number | undefined>(undefined);
  const endSession = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    const t = ls.get(LS_TTFT);
    if (t) setState((s) => ({ ...s, timeToFirstTx: Number(t) }));
  }, []);

  const remember = (v: string | null) => {
    try {
      if (v) sessionStorage.setItem(SS_SESSION, v);
      else sessionStorage.removeItem(SS_SESSION);
    } catch {}
  };

  const fromAccount = useCallback((kind: Kind, account: Account) => {
    const client = createWalletClient({ account, chain, transport: http(RPC_URL) });
    setState((s) => ({ ...s, kind, address: account.address, client, account, connecting: false, error: undefined }));
  }, []);

  const fail = (e: unknown) => setState((s) => ({ ...s, connecting: false, error: (e as Error).message }));

  const sessionFromPrf = useCallback(
    (prf: Uint8Array) => {
      endSession.current?.();
      const session = createSecp256k1SigningSession({ privateKey: deriveKey(prf) });
      endSession.current = () => session.end();
      fromAccount("passkey", toViemAccount(session));
    },
    [fromAccount],
  );

  const createPasskey = useCallback(
    async (name: string) => {
      startedAt.current ??= performance.now();
      setState((s) => ({ ...s, connecting: true }));
      try {
        const r = await createPasskeyWithPrfOutput({
          rp: { id: window.location.hostname, name: "Quoral" },
          user: { name, displayName: name },
        });
        const meta: PasskeyCredentialMetadata = { credentialId: r.credentialId, transports: r.transports };
        ls.set(LS_CRED, JSON.stringify(meta));
        sessionFromPrf(r.prfOutput);
      } catch (e) {
        fail(e);
      }
    },
    [sessionFromPrf],
  );

  const connectPasskey = useCallback(async () => {
    startedAt.current ??= performance.now();
    setState((s) => ({ ...s, connecting: true }));
    try {
      const saved = ls.get(LS_CRED);
      const r = await getPasskeyPrfOutput({
        rpId: window.location.hostname,
        credential: saved ? (JSON.parse(saved) as PasskeyCredentialMetadata) : undefined,
      });
      sessionFromPrf(r.prfOutput);
    } catch (e) {
      fail(e);
    }
  }, [sessionFromPrf]);

  const connectInjected = useCallback(async () => {
    startedAt.current ??= performance.now();
    const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!eth) return fail(new Error("No browser wallet found"));
    setState((s) => ({ ...s, connecting: true }));
    try {
      const [address] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      await eth
        .request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(CHAIN_ID) }] })
        .catch(() => undefined);
      const client = createWalletClient({ account: address, chain, transport: custom(eth) });
      setState((s) => ({ ...s, kind: "injected", address, client, account: address, connecting: false, error: undefined }));
      remember("injected");
    } catch (e) {
      fail(e);
    }
  }, []);

  const connectDemo = useCallback(
    (i: number) => {
      startedAt.current ??= performance.now();
      fromAccount("demo", privateKeyToAccount(DEMO_KEYS[i].key));
      remember(`demo:${i}`);
    },
    [fromAccount],
  );

  // Restore a demo / browser-wallet session after reload (passkey sessions always re-prompt by design).
  useEffect(() => {
    let v: string | null = null;
    try {
      v = sessionStorage.getItem(SS_SESSION);
    } catch {}
    if (v?.startsWith("demo:") && CHAIN_ID === 31337) connectDemo(Number(v.slice(5)));
    else if (v === "injected") {
      const eth = (window as unknown as { ethereum?: { request: (a: { method: string }) => Promise<unknown> } }).ethereum;
      eth?.request({ method: "eth_accounts" }).then((a) => {
        if ((a as string[])?.length) connectInjected();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnect = useCallback(() => {
    endSession.current?.();
    endSession.current = undefined;
    remember(null);
    setState((s) => ({ connecting: false, timeToFirstTx: s.timeToFirstTx }));
  }, []);

  const send = useCallback(
    async (fn: (c: WalletClient, account: Account | Address) => Promise<Hash>) => {
      if (!state.client || !state.account) throw new Error("Connect a wallet first");
      const hash = await fn(state.client, state.account);
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
      if (state.timeToFirstTx === undefined && startedAt.current !== undefined) {
        const ms = Math.round(performance.now() - startedAt.current);
        ls.set(LS_TTFT, String(ms));
        setState((s) => ({ ...s, timeToFirstTx: ms }));
      }
      return hash;
    },
    [state.client, state.account, state.timeToFirstTx],
  );

  const value = useMemo<Wallet>(
    () => ({ ...state, createPasskey, connectPasskey, connectInjected, connectDemo, disconnect, send }),
    [state, createPasskey, connectPasskey, connectInjected, connectDemo, disconnect, send],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const w = useContext(Ctx);
  if (!w) throw new Error("useWallet outside WalletProvider");
  return w;
}
