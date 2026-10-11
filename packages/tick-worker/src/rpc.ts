/**
 * Just enough JSON-RPC and ABI coding for the tick, without viem.
 *
 * Workers on the free plan get about 10 ms of CPU per invocation, and most of a viem-based tick went into running
 * viem's generic encoding paths cold on every cron run. The tick only ever makes the same few calls, so selectors
 * are constants and every value is read or written as a 32-byte word.
 */
export type Hex = `0x${string}`;
export type Address = Hex;

export class RpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}${data ? ` (${String(data).slice(0, 74)})` : ""}`);
  }
}

let nextId = 0;
export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const text = await res.text();
  let j: { result?: T; error?: { message: string; data?: unknown } };
  try {
    j = JSON.parse(text);
  } catch {
    throw new RpcError(method, `HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  if (j.error) throw new RpcError(method, j.error.message, j.error.data);
  return j.result as T;
}

export const ethCall = (url: string, to: Address, data: Hex) => rpc<Hex>(url, "eth_call", [{ to, data }, "latest"]);

// ---------------------------------------------------------------- encoding

/** One 32-byte word, as 64 hex characters without 0x. */
export const word = (v: bigint | number | boolean) => (typeof v === "boolean" ? (v ? 1n : 0n) : BigInt(v)).toString(16).padStart(64, "0");
const addrWord = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");

/** selector + static arguments */
export const calldata = (selector: string, ...args: (bigint | number)[]): Hex => `0x${selector.slice(2)}${args.map(word).join("")}` as Hex;

/** selector + any number of uint arrays (each argument is one dynamic array) */
export function calldataArrays(selector: string, arrays: (bigint | number)[][]): Hex {
  let head = "";
  let tail = "";
  let offset = arrays.length * 32;
  for (const a of arrays) {
    head += word(offset);
    tail += word(a.length) + a.map(word).join("");
    offset += 32 * (a.length + 1);
  }
  return `0x${selector.slice(2)}${head}${tail}` as Hex;
}

export type Call = { to: Address; data: Hex };

/** Multicall3.aggregate3((address target, bool allowFailure, bytes callData)[]) with allowFailure = false */
export function aggregate3(calls: Call[]): Hex {
  const parts = calls.map((c) => {
    const bytes = c.data.slice(2);
    const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0");
    return addrWord(c.to) + word(0) + word(96) + word(bytes.length / 2) + padded;
  });
  let offsets = "";
  let at = calls.length * 32;
  for (const p of parts) {
    offsets += word(at);
    at += p.length / 2;
  }
  return `0x82ad56cb${word(32)}${word(calls.length)}${offsets}${parts.join("")}` as Hex;
}

// ---------------------------------------------------------------- decoding

/** Return data split into words (hex without 0x). */
export const words = (data: Hex | string) => {
  const h = data.startsWith("0x") ? data.slice(2) : data;
  const out: string[] = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
};
export const uint = (w: string) => BigInt(`0x${w || "0"}`);
export const num = (w: string) => Number(uint(w));
export const addr = (w: string) => `0x${w.slice(24)}` as Address;
export const bool = (w: string) => uint(w) !== 0n;

/** Results of aggregate3, each as the raw return data of one call. */
export function decodeAggregate3(data: Hex): string[] {
  const h = data.slice(2);
  const wordAt = (byte: number) => h.slice(byte * 2, byte * 2 + 64);
  const arr = Number(uint(wordAt(0)));
  const n = Number(uint(wordAt(arr)));
  const base = arr + 32;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = base + Number(uint(wordAt(base + 32 * i)));
    if (!bool(wordAt(t))) throw new Error(`multicall: call ${i} failed`);
    const b = t + Number(uint(wordAt(t + 32)));
    const len = Number(uint(wordAt(b)));
    out.push(h.slice((b + 32) * 2, (b + 32 + len) * 2));
  }
  return out;
}

/** A dynamic uint array returned on its own (e.g. openOrders()). */
export function uintArray(ret: string): bigint[] {
  const w = words(ret);
  const start = num(w[0]) / 32;
  const n = num(w[start]);
  return w.slice(start + 1, start + 1 + n).map(uint);
}
