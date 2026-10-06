#!/usr/bin/env node
/**
 * design-check: flags the AI-default patterns banned in packages/web/DESIGN.md.
 * It matches code and copy. It cannot judge a concept; DESIGN.md does that.
 * Zero dependencies, Node 18+.
 *
 *   node scripts/design-check.mjs <dir-or-file> [more paths] [--json]
 *
 * Suppress a finding only with a reason, on the same line or the line above:
 *   /* design-allow: loading shimmer, not decoration *\/
 * Exit code 1 when anything is found, so it can run in CI.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative, basename } from "node:path";

const UI = [".tsx", ".jsx", ".html", ".vue", ".svelte", ".astro"];
const STYLE = [".css", ".scss", ".sass", ".less"];
const SCRIPT = [".ts", ".js", ".mjs", ".cjs"];
const DOCS = [".md", ".mdx"];
const DATA = [".json", ".yaml", ".yml", ".txt"];
const TEXT = [...UI, ...STYLE, ...SCRIPT, ...DOCS, ...DATA];

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".next-build", "dist", "build", "out", "target", ".git", "generated",
  "coverage", ".turbo", ".vercel", ".svelte-kit", "fonts", "cache", "broadcast",
]);
// Files that legitimately name the banned patterns.
const SKIP_FILES = new Set(["DESIGN.md", "design-check.mjs", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"]);

const FONTS = ["Inter", "Roboto", "Poppins", "Montserrat", "Open Sans", "Lato", "Space Grotesk", "DM Sans", "Manrope", "Plus Jakarta Sans", "Outfit", "Sora", "Nunito"];
const fontAlt = (f) => FONTS.map(f).join("|");
const PURPLE_HEX = ["6366f1", "4f46e5", "4338ca", "818cf8", "8b5cf6", "7c3aed", "6d28d9", "a78bfa", "a855f7", "9333ea", "c084fc", "d946ef", "6e56cf", "7c6cff", "8b7bff", "6d5bff"];

const RULES = [
  {
    id: "gradient",
    in: [...STYLE, ...UI],
    re: /\b(?:repeating-)?(?:linear|radial|conic)-gradient\(/,
    msg: "Gradient. Use solid named colours from the palette.",
  },
  {
    id: "gradient-utility",
    in: UI,
    re: /\bbg-gradient-to-|\bbg-linear-to-|\bfrom-(?:indigo|violet|purple|fuchsia|blue|cyan|pink|sky)-\d|\bvia-[a-z]+-\d/,
    msg: "Tailwind gradient utility.",
  },
  {
    id: "gradient-text",
    in: [...STYLE, ...UI],
    re: /background-clip:\s*text|\bbg-clip-text\b|-webkit-text-fill-color:\s*transparent/,
    msg: "Gradient or clipped text. One colour per headline.",
  },
  {
    id: "default-purple",
    in: [...STYLE, ...UI, ...SCRIPT],
    re: new RegExp(`\\b(?:indigo|violet|purple|fuchsia)-(?:50|[1-9]00|950)\\b|#(?:${PURPLE_HEX.join("|")})\\b`, "i"),
    msg: "Default indigo or violet. Use a colour with a role in the product palette.",
  },
  {
    id: "glow",
    in: [...STYLE, ...UI],
    re: /(?:box|text)-shadow:[^;]*?\b0(?:px)?\s+0(?:px)?\s+[1-9]\d+px|\bshadow-(?:indigo|violet|purple|fuchsia|cyan|blue|sky)-\d|\bdrop-shadow-\[0_0_/,
    msg: "Glow. Elevation only where depth carries meaning.",
  },
  {
    id: "glass",
    in: [...STYLE, ...UI],
    re: /backdrop-filter|\bbackdrop-blur\b/,
    msg: "Blur panel (glassmorphism). Use opaque surfaces.",
  },
  {
    id: "default-font",
    in: [...STYLE, ...UI, ...SCRIPT, ".json"],
    re: new RegExp(
      [
        `font-family:[^;]*\\b(?:${fontAlt((f) => f)})\\b`,
        `\\b(?:${fontAlt((f) => f.replaceAll(" ", "_"))})\\s*\\(`,
        `@fontsource(?:-variable)?/(?:${fontAlt((f) => f.toLowerCase().replaceAll(" ", "-"))})\\b`,
        `fonts\\.googleapis\\.com/css2?\\?family=(?:${fontAlt((f) => f.replaceAll(" ", "\\+"))})\\b`,
        `\\bfont-(?:inter|roboto|poppins|montserrat)\\b`,
      ].join("|"),
    ),
    msg: "Default typeface. Choose one for this product and write the reason in DESIGN.md.",
  },
  {
    id: "em-dash",
    in: TEXT,
    re: /\u2014/,
    msg: "Em dash. Use a full stop, comma, colon or parentheses.",
  },
  {
    id: "emoji",
    in: UI,
    re: /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u,
    msg: "Emoji in the interface. Use the product's icon set or words.",
  },
  {
    id: "arrow",
    in: UI,
    re: /[→↗➜➔⟶↪]/,
    msg: "Arrow glyph welded to a link or label. Let the link text say where it goes.",
  },
  {
    id: "eyebrow",
    in: [...STYLE, ...UI],
    re: /\b(?:eyebrow|kicker|overline)\b|\buppercase\b[^"'`\n]*\btracking-(?:wide|wider|widest|\[)|\btracking-(?:wide|wider|widest|\[)[^"'`\n]*\buppercase\b|text-transform:\s*uppercase[^}\n]*letter-spacing:\s*0?\.(?:0[5-9]|[1-9])/,
    msg: "Tracked all-caps label over a heading (eyebrow).",
  },
  {
    id: "sequence",
    in: [...STYLE, ...UI],
    re: /decimal-leading-zero|>\s*0[1-9]\s*</,
    msg: "01/02/03 marker. Number only real sequences.",
  },
  {
    id: "scroll-motion",
    in: [...STYLE, ...UI, ...SCRIPT],
    re: /\bfade-?(?:in-?)?up\b|\bslide-?(?:in-?)?up\b|\bdata-aos\b|\bwhileInView\b|\banimate-(?:bounce|ping|pulse)\b/i,
    msg: "Default scroll or attention motion.",
  },
  {
    id: "count-up",
    in: [...UI, ...SCRIPT],
    re: /\bcount-?up\b|react-countup/i,
    msg: "Count-up statistic. Show the number.",
  },
  {
    id: "filler-copy",
    in: [...UI, ...DOCS],
    re: /\b(?:elevate your|empower(?:s|ing)?\b|unlock (?:the|your)\b|seamless(?:ly)?\b|supercharge|revolutioni[sz]e|game[- ]changer|cutting[- ]edge|next[- ]gen(?:eration)?\b|harness the power|effortless(?:ly)?\b|transform your|build faster|ship faster|in today's|world[- ]class|best[- ]in[- ]class|unleash|skyrocket)/i,
    msg: "Copy that fits any product. Say what only this product does.",
  },
  {
    id: "placeholder",
    in: [...UI, ...DOCS, ...SCRIPT, ".json"],
    re: /lorem ipsum|\bjohn doe\b|\bjane doe\b|\bacme (?:inc|corp|co)\b/i,
    msg: "Placeholder content. Use real data or a clearly marked example.",
  },
  {
    id: "round-number",
    in: [...UI, ...DOCS],
    re: /(?<![\d.,$])\d{1,3}(?:,\d{3})+\+|(?<![\w.])\d+[kKmM]\+(?!\w)|\b10x\b|\b99\.9+%/,
    msg: "Round or unsourced number. Use a live figure, or cite it with a date.",
  },
];

const ALLOW = /design-allow:\s*\S/;

function walk(path, out) {
  let st;
  try {
    st = statSync(path);
  } catch {
    console.error(`design-check: cannot read ${path}`);
    process.exitCode = 2;
    return;
  }
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(basename(path))) return;
    for (const name of readdirSync(path)) walk(join(path, name), out);
  } else if (TEXT.includes(extname(path)) && !SKIP_FILES.has(basename(path)) && st.size < 1_000_000) {
    out.push(path);
  }
}

function scan(file) {
  const ext = extname(file);
  const rules = RULES.filter((r) => r.in.includes(ext));
  if (!rules.length) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    if (line.length > 2000) return; // minified or generated
    if (ALLOW.test(line) || (i > 0 && ALLOW.test(lines[i - 1]))) return;
    for (const r of rules) {
      const m = r.re.exec(line);
      if (m) found.push({ file, line: i + 1, col: m.index + 1, rule: r.id, msg: r.msg, text: line.trim().slice(0, 140) });
    }
  });
  return found;
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const targets = args.filter((a) => !a.startsWith("--"));
if (!targets.length) targets.push(".");

const files = [];
for (const t of targets) walk(t, files);
const findings = files.flatMap(scan);

if (json) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  for (const f of findings) {
    console.log(`${relative(process.cwd(), f.file)}:${f.line}:${f.col}  ${f.rule}  ${f.msg}\n    ${f.text}`);
  }
  const byRule = findings.reduce((m, f) => m.set(f.rule, (m.get(f.rule) ?? 0) + 1), new Map());
  const summary = [...byRule].map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(
    findings.length
      ? `\n${findings.length} finding(s) in ${new Set(findings.map((f) => f.file)).size} of ${files.length} files: ${summary}`
      : `design-check: ${files.length} files clean`,
  );
}
if (findings.length) process.exitCode = 1;
