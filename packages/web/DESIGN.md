# Quoral design direction

The agreement is a score. Read this before adding a page or a component. If the work needs something this document
does not allow, change the document first and give the reason. `pnpm design:check` enforces the bans below.

## Product world

- **Does:** turns a token issuer's market-making deal into a contract on Kuru. The market maker quotes from a vault it
  cannot withdraw from, proves spread and depth every epoch, and loses that epoch's retainer when it misses.
- **First ten seconds:** a holder or judge wants to know whether the market maker is showing up right now; an issuer
  wants to know what they are paying for.
- **Proof data:** the per-epoch proof that `Heartbeat.record` stores: best bid, best ask, spread, depth per side and
  block.
- **Worst moment:** a missed epoch. Its retainer goes back to the issuer, and past the uptime allowance the bond is
  slashed.
- **Never confuse:** quoted and missed; excused (venue paused) and missed; streamed (accruing) and settled.
- **Name:** quote + choral. Quotes are renewed in chorus every block.

## Neighbours surveyed

| Site | Signature element | Display type and weight | Colours | Real data |
|---|---|---|---|---|
| Monad | Dithered pixel imagery, hairline frames | Britti Sans, 500 | Off-white, one purple | Network figures in a ruled row |
| Kuru | The trading widget itself | Inter, 600 | Near-black, lime CTA | Live markets |
| Chainlink | Giant kinetic type on its own blue | Light grotesk | Blue, yellow highlight | Little |
| Envio | Bold orange display type, contract-address input | Heavy grotesk | Black, orange | Logo strip |
| Perpl | An arc of rotating tickers | Light grotesk, 300 | Deep navy, one purple word | Ticker list |
| Morpho | Wireframe line art | Light grotesk, 300 | Black, one blue | Exact live totals |
| Mera | A working demo in the hero | Grotesk, 400 | White, orange | The demo |
| Category Labs | A huge black curve and one orange dot | Light grotesk, serif wordmark | White, black, orange | None |

Shared baseline: display type at weight 300 to 500, one brand colour used sparingly, real numbers.
Nobody does: draw the product's own live data as the main image.

## Concept

The agreement is drawn as a choir part.

| Product fact | Notation |
|---|---|
| Epoch (a run of blocks set in the terms; 1,980 blocks, about 10 min, on the testnet demo) | One bar |
| Block time | Tempo marking: ♩ = 300 ms |
| Resting bid and ask, proven in the requote tx | A two-note chord. Noteheads move with price, so the bars read as a melody |
| Spread | The interval between the two notes. The number under the chord is the spread in bps |
| Missed epoch | A whole rest. Once settled it gets a red-pencil circle and the clawed-back amount |
| Three or more missed epochs in a row | A multirest: one long rest with the count above, circled once settled, with the total clawback |
| Venue pause (excused) | G.P., the general pause, when the whole ensemble is silent |
| Now | The playhead |

Tests:

- **Portability: pass.** Two voices moving with price, bar by bar, only make sense for two-sided quotes per interval.
- **Data: pass.** Every note in the live score is a recorded proof. The rehearsal is simulated, says so in its own
  panel, and never mixes with live bars.
- **Failure: pass.** A missed bar is a circled rest with the amount written underneath.
- **Squint: pass.** At 20% the page is staff lines and ink, unlike anything in the Monad ecosystem.
- **Explainability: pass.** One caption under the score explains every mark.

## Palette

| Name | Hex | Role |
|---|---|---|
| Paper | `#FAFAF7` | Page background. Neutral, not cream |
| Sheet | `#FFFFFF` | Panels and inputs |
| Ink | `#141414` | Text, notes, barlines, primary buttons |
| Graphite | `#5E5E59` / `#97978F` | Secondary and tertiary text, unsettled marks, G.P. |
| Rule | `#DCDCD5` / `#C9C9C1` | Staff lines, hairlines, borders |
| Pencil | `#E0452B` | Only where money moved because the SLA failed: rests, clawbacks, slashes, errors |

Colour means: someone failed and money moved. Compliance is the normal state, so it is drawn in ink.

## Type

- **Hanken Grotesk:** all UI and body text. Display sizes use weight 300 to 400 with tight tracking, in line with the
  ecosystem's light display type. Self-hosted variable font.
- **Newsreader italic:** performance markings only (tempo, G.P., pencil amounts, the notation caption) and the
  wordmark. Printed music sets its markings in an italic serif; that is the reason for the choice.
- **JetBrains Mono:** addresses, hashes and code. Never labels.
- **Figures:** tabular everywhere, because numbers update live and line up in tables.

## Layout

- **Alignment and grid:** left-aligned and asymmetric; on the landing page the hero is the headline beside the
  rehearsal console (stacked under 1060 px), the live score runs full width under both, and each section head is a
  5:7 split of heading and explanation.
- **Separation:** hairline rules and space between sections, not cards.
- **Tables:** clauses, permissions and agreements are real tables. Under 980 px they become stacked rows.
- **Panels:** white sheet, 1 px rule, 10 px radius, no shadow, only for forms and consoles.
- **Radius per role:** score and rules 0, inputs and buttons 7 px, panels 10 px.

## Components

- **Buttons:** an ink fill for the one primary action, an ink outline for secondary ones, a pencil outline for
  destructive actions (give notice). Links are underlined text, never arrow-tipped.
- **Inputs:** white sheet, 1 px rule, the unit (bps, USDC, blocks) inside the field on the right.
- **Status:** notation glyphs. A chord means quoting in compliance (ink); a whole rest means no quote, retainer being
  clawed back (pencil); G.P. means the venue is paused (graphite); a final double barline means the agreement ended.
- **Figures:** a ledger, a ruled row of figures, replaces stat cards. Pencil is used only for clawbacks and slashes.
- **Empty, loading, error:** skeletons keep the final layout's shape; empty states say what will appear; contract
  errors are mapped to plain sentences ("Only the issuer of this agreement can do that.").

## Rehearsal

The hero's console, where the visitor runs the quoter on the live agreement's terms: stop the quotes, widen the
spread past the term, thin the depth, or let the venue pause. The outcome follows the contract: a requote that breaks
a term reverts and proves nothing, an empty bar is a rest that is circled once settled, the second miss in an uptime
window slashes the bond, and a pause is an excused G.P. A sentence under the score says what just happened, and a
ruled list shows what was paid, returned and slashed. Each slider marks its term as a barline on the track. Nothing
is sent to the chain, and the panel says so.

The simulated price follows a melody, one note per bar, so a bar lasts as long as its note: Mozart's theme from
K. 265 (Ah vous dirai-je, maman), the opening of K. 525 (Eine kleine Nachtmusik, a fourth up so it needs no sharps)
or Beethoven's Ode to Joy, all public domain and all in C major. The ask is the melody and the bid sits the spread
below it, so keeping the quotes up plays the tune with a harmony under it, a wider spread opens the harmony from a
third to a fifth, and stopping the quotes breaks the tune into rests. The rehearsal fixes the scale (12.5 bps a step,
with ledger lines beyond the staff) instead of fitting the visible range as the live score does, so the melody is
drawn and heard exactly.

## Sound

Off by default and never started without a click. The staff is read as a treble staff, so a notehead sounds the pitch
it is drawn at (bottom line E4, top line F5, ledger lines beyond): a proven bar sounds its chord on a piano voice
with the top note leading, a rest is silence, and a settled miss makes one pencil stroke. The piano is synthesised
from partials, with no samples to load or license. Listen in the rehearsal starts its tune from the first note; Play
it back plays the visible live bars once, one beat per bar at the tempo marking, without turning Listen on. The live
score never sounds by itself, so it cannot cut into the rehearsal's melody.

## Motion

Only two things move. The playhead advances through the current bar, and a new chord settles into its bar (220 ms).
The rehearsal is the same two motions at the pace of its melody; it runs only while it is on screen, and with
reduced motion it waits for a click. Both respect `prefers-reduced-motion`. There is no scroll motion.

## Voice

- **Headlines:** "If the quotes stop, the pay stops." "Six clauses, each one a line of code." "The market maker never
  holds the inventory."
- **Error message:** "Not enough free bond. Deposit more first."
- **Words we use:** bar, epoch, quote, proof, retainer, clawback, bond, issuer, market maker, settle.
- **Words we never use:** guaranteed, yield, earn, profit share, trustless, escrow (we hold nothing), plus the
  universal list.

## Banned

Universal: purple or indigo gradients and gradient text, glow, glass panels, default UI faces such as Inter, tracked
all-caps eyebrows, "A · B · C" meta strings, arrows welded onto links, fake 01/02/03 markers, emoji, scroll fade-ups,
count-up stats, filler copy, unsourced round numbers and em dashes.

Product-specific:

- Monad purple (`#836EF9` and its neighbours) as an accent; it would read as a Monad property.
- Kuru lime, Chainlink blue, Envio orange: sponsor signatures.
- Green and red good/bad pairs. Compliance is ink and failure is pencil.
- Candlestick charts and trading-terminal chrome. The score is the chart.
- Music clip-art: clefs, staff-paper textures, notes used as decoration outside the score.
- The second-wave palettes: cream and terracotta, and near-black with acid green.

Documented exception: the loading skeleton uses a gradient shimmer (`design-allow` in `app/globals.css`).

## Checks

- `pnpm design:check` runs `scripts/design-check.mjs` on `packages/web` and `README.md`, and runs in CI.
- Screenshots at 375, 820 and 1280 px with real data. To see the failure state, press Stop the quotes in the
  rehearsal; on the live agreement, set `PAUSED = "1"` on the worker for a bar and let the keeper settle it.
