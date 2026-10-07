"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { CHAIN_ID } from "./chain";

/** Public RPCs are rate limited and epochs last minutes, so poll four times less often off the local chain. */
const scalePoll = (ms: number) => (CHAIN_ID === 31337 ? ms : Math.max(ms * 4, 8000));

/** Polls an async loader; keeps the last good value on transient errors. */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(undefined);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (alive) await refresh();
    };
    run();
    const id = setInterval(run, scalePoll(ms));
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, refresh, ...deps]);
  return { data, error, refresh };
}

const HUMAN: Record<string, string> = {
  NotIssuer: "Only the issuer of this agreement can do that.",
  NotParty: "Only the issuer or the market maker can do that.",
  NotOperator: "Only the agreement's operator key can quote.",
  NotLive: "The agreement is not live.",
  NotEnded: "Available once the agreement has ended (after notice or expiry).",
  NotFullySettled: "Settle all ended epochs first.",
  AlreadyFinalized: "This agreement is already finalized.",
  NoticeAlreadyGiven: "Notice has already been given.",
  NoPendingOperator: "There is no pending operator change.",
  SameProposer: "The other party must accept this operator change.",
  EpochNotEnded: "That epoch hasn't ended yet.",
  AlreadySettled: "Those epochs are already settled.",
  NotPaused: "The venue is not paused right now.",
  BiddingClosed: "Bidding for this RFQ has closed.",
  AboveCap: "Your bid is above the issuer's retainer cap.",
  ZeroRetainer: "Enter a retainer greater than zero.",
  NoBid: "No active bid from this account.",
  IsWinner: "The winning bond is assigned to the agreement and can't be withdrawn.",
  NotOpen: "This RFQ is no longer open.",
  Insufficient: "Not enough free bond. Deposit more first.",
  MarketNotAllowed: "This market isn't enabled on Quoral yet.",
  InvalidTerms: "Some terms are invalid",
  SpreadTooWide: "Quoted spread is wider than the SLA allows.",
  DepthTooThin: "Quoted depth is below the SLA minimum.",
  PostOnlyError: "The quote would cross the book (post-only).",
  MidMovedTooFar: "The quoted mid moved further from the last proof than the agreement allows per epoch.",
  NoTwoSidedQuote: "Quote both sides (one side alone is allowed only once its inventory is used up).",
  BidChanged: "That bid changed since you loaded it. Review the new retainer and award again.",
  OrderAlreadyFilledOrCancelled: "One of those orders was already filled or cancelled.",
  ERC20InsufficientBalance: "Insufficient token balance.",
  ERC20InsufficientAllowance: "Token approval is too low.",
};

export function errMsg(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = rev?.data?.errorName;
    if (name) {
      const human = HUMAN[name];
      if (name === "InvalidTerms" && rev?.data?.args?.[0]) return `${human}: ${String(rev.data.args[0])}.`;
      return human ?? `${name}${rev?.data?.args?.length ? ` (${rev.data.args.join(", ")})` : ""}`;
    }
    if (/User rejected|denied/i.test(e.shortMessage)) return "Request rejected in wallet.";
    return e.shortMessage;
  }
  const m = e instanceof Error ? e.message : String(e);
  if (/NotAllowedError|The operation either timed out or was not allowed/i.test(m)) return "Passkey prompt was cancelled.";
  return m;
}
