"use client";

import { useWallet, ROLE_LABEL, type Role } from "@/lib/wallet";

/** On a passkey sign-in, offers the key this page acts with when another of the passkey's keys is active. */
export function RoleHint({ role }: { role: Role }) {
  const w = useWallet();
  if (w.kind !== "passkey" || !w.role || w.role === role) return null;
  return (
    <div className="notice row" style={{ justifyContent: "space-between", gap: 12 }}>
      <span>
        You are signing as the {ROLE_LABEL[w.role].toLowerCase()}. This page acts as the {ROLE_LABEL[role].toLowerCase()}, another key
        of the same passkey.
      </span>
      <button onClick={() => w.switchRole(role)}>Sign as {ROLE_LABEL[role].toLowerCase()}</button>
    </div>
  );
}
