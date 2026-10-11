"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useWallet, DEMO_KEYS, ROLES, ROLE_LABEL } from "@/lib/wallet";
import { CHAIN_ID, chain, short } from "@/lib/chain";
import { LogoMark } from "./Logo";

const LINKS = [
  ["/agreements", "Agreements"],
  ["/issuer", "Issuers"],
  ["/mm", "Market makers"],
] as const;

export function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const isOn = (href: string) => path === href || (href === "/agreements" && path.startsWith("/0x"));
  return (
    <header className="top">
      <div className="wrap">
        <Link href="/" className="brand" aria-label="Quoral home">
          <LogoMark />
          <span className="word">Quoral</span>
        </Link>
        <nav className="links" aria-label="Main">
          {LINKS.map(([href, label]) => (
            <Link key={href} href={href} className={isOn(href) ? "on" : ""} aria-current={isOn(href) ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="nav-right">
          <span className="chain-pill" title={`Chain ID ${CHAIN_ID}`}>
            <span className="dot" />
            {chain.name}
          </span>
          <WalletButton />
          <button className="burger ghost" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ padding: 8 }}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              {open ? (
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              ) : (
                <path d="M3 7h14M3 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
      </div>
      <nav className={`mobile-nav ${open ? "open" : ""}`} aria-label="Mobile">
        <Link href="/" className={path === "/" ? "on" : ""}>Overview</Link>
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href} className={isOn(href) ? "on" : ""}>{label}</Link>
        ))}
        <span className="muted small" style={{ paddingTop: 12 }}>Network: {chain.name}</span>
      </nav>
    </header>
  );
}

function useClickAway(ref: React.RefObject<HTMLElement | null>, onAway: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && onAway();
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [ref, onAway]);
}

function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false));

  if (w.address) {
    return (
      <div className="menu" ref={ref}>
        <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
          {w.role && <span className="muted">{ROLE_LABEL[w.role]}</span>}
          <span className="mono">{short(w.address)}</span>
        </button>
        {open && (
          <div className="pop" role="menu">
            <div className="small muted">
              Signed in with {w.kind === "demo" ? "a local demo account" : "a passkey (Mera)"}
            </div>
            {w.roles ? (
              <div className="stack" style={{ gap: 6 }}>
                <div className="small" style={{ fontWeight: 600 }}>One passkey, three keys</div>
                {ROLES.map((r) => (
                  <button
                    key={r}
                    className={`role ${w.role === r ? "on" : ""}`}
                    aria-pressed={w.role === r}
                    onClick={() => w.switchRole(r)}
                  >
                    <span>{ROLE_LABEL[r]}</span>
                    <span className="mono">{short(w.roles![r])}</span>
                  </button>
                ))}
                <div className="tiny muted">
                  Each role signs with its own key, derived from the same passkey prompt. Switching needs no new prompt; the
                  operator key is the one to give the vault for quoting.
                </div>
              </div>
            ) : (
              <div className="addr small">{w.address}</div>
            )}
            <button onClick={() => navigator.clipboard?.writeText(w.address!)}>Copy {w.role ? `${ROLE_LABEL[w.role].toLowerCase()} ` : ""}address</button>
            {w.timeToFirstTx !== undefined && (
              <div className="small">
                First transaction confirmed {(w.timeToFirstTx / 1000).toFixed(1)} s after sign-in.
              </div>
            )}
            <div className="sep" />
            <button onClick={() => { w.disconnect(); setOpen(false); }}>Sign out</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="menu" ref={ref}>
      <button className="primary" onClick={() => setOpen((o) => !o)} disabled={w.connecting} aria-haspopup="menu" aria-expanded={open}>
        {w.connecting ? <><span className="spinner" /> Waiting for passkey</> : "Sign in"}
      </button>
      {open && (
        <div className="pop" role="menu">
          <div style={{ fontWeight: 600 }}>Sign in</div>
          <div className="small muted" style={{ marginBottom: 2 }}>Your passkey is your account. No extension, no seed phrase.</div>
          <button className="primary" style={{ justifyContent: "center" }} onClick={async () => { await w.connectPasskey(); setOpen(false); }}>
            Use my passkey
          </button>
          <form
            className="row"
            style={{ flexWrap: "nowrap" }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name) return;
              await w.createPasskey(name);
              setOpen(false);
            }}
          >
            <input aria-label="Name for a new passkey" placeholder="Name for a new passkey" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" disabled={!name}>Create</button>
          </form>
          {CHAIN_ID === 31337 && (
            <>
              <div className="sep" />
              <div className="small muted">Local demo accounts (anvil only)</div>
              {DEMO_KEYS.map((k, i) => (
                <button key={k.label} onClick={() => { w.connectDemo(i); setOpen(false); }}>{k.label}</button>
              ))}
            </>
          )}
          {w.error && <div className="err">{w.error}</div>}
          <div className="tiny muted" style={{ marginTop: 2 }}>
            Passkeys by Mera. One prompt derives your issuer, market maker and operator keys; all three are wiped when
            you sign out.
          </div>
        </div>
      )}
    </div>
  );
}
