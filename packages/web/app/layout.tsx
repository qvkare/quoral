import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

// Self-hosted variable fonts (SIL OFL), see DESIGN.md: Hanken Grotesk for UI, Newsreader for markings.
const sans = localFont({
  src: [
    { path: "./fonts/HankenGrotesk.woff2", style: "normal", weight: "100 900" },
    { path: "./fonts/HankenGrotesk-Italic.woff2", style: "italic", weight: "100 900" },
  ],
  variable: "--font-sans",
  display: "swap",
});
const serif = localFont({
  src: [
    { path: "./fonts/Newsreader.woff2", style: "normal", weight: "200 800" },
    { path: "./fonts/Newsreader-Italic.woff2", style: "italic", weight: "200 800" },
  ],
  variable: "--font-serif",
  display: "swap",
});
const mono = localFont({ src: "./fonts/JetBrainsMono.woff2", variable: "--font-mono", weight: "100 800", display: "swap", adjustFontFallback: false });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: { default: "Quoral: market making on contract terms", template: "%s | Quoral" },
  description:
    "If the quotes stop, the pay stops. Quoral is a market-making agreement on Kuru, Monad's onchain order book: spread and depth proven every 30 seconds, retainer clawed back for every missed bar.",
  openGraph: {
    title: "Quoral: if the quotes stop, the pay stops",
    description: "Market-making agreements on Kuru with onchain proofs, a quote-only inventory vault and public terms.",
    type: "website",
    siteName: "Quoral",
  },
  twitter: { card: "summary_large_image", title: "Quoral", description: "If the quotes stop, the pay stops." },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#fafaf7",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>
        <WalletProvider>
          <a href="#content" className="sr-only">Skip to content</a>
          <Nav />
          <div id="content" style={{ flex: 1, display: "flex", flexDirection: "column" }}>{children}</div>
          <Footer />
        </WalletProvider>
      </body>
    </html>
  );
}
