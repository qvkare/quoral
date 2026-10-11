import Link from "next/link";
import { LogoMark } from "./Logo";

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="cols">
          <div style={{ maxWidth: 380 }}>
            <Link href="/" className="brand">
              <LogoMark size={22} />
              <span className="word" style={{ fontSize: 20 }}>Quoral</span>
            </Link>
            <p style={{ marginTop: 12 }}>
              Market-making agreements on Kuru, Monad&apos;s onchain order book.
            </p>
          </div>
          <nav aria-label="Footer">
            <Link href="/agreements">Agreements</Link>
            <Link href="/issuer">Issuers</Link>
            <Link href="/mm">Market makers</Link>
            <Link href="/#questions">Questions</Link>
            <a href="https://github.com/Kuru-Labs/Kuru-contracts-dex-public" target="_blank" rel="noreferrer">Kuru contracts</a>
            <a href="https://x.com/qvkare" target="_blank" rel="noreferrer">@qvkare on X</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
