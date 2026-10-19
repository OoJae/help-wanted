# HELP WANTED: how the site looks, moves and speaks

This is the brand document for the team that keeps polishing the site. It describes the system as the
code has it: the tokens in [`src/styles/tokens.css`](src/styles/tokens.css), the rules in
[`src/styles/global.css`](src/styles/global.css) and [`src/styles/clockin.css`](src/styles/clockin.css),
the components named below. Where this document and the code differ, the code is right and this
document is out of date: fix it in the same change. The drawn files are in [`brand/`](brand/), and
the last section says how to make every one of them again.

## The idea

**Clocking In.** HELP WANTED is the job board where the employers are smart contracts, and the pay
waits for proof: the employer's IMD stays in escrow until IdentityMD's on-chain receipt for that exact
job is there, and goes back to the employer otherwise. The site follows its own classified ad one step
further, to the works and its time clock. The front page opens on the Recorder, a black enamel and
brass time clock printed as a two-ink engraving, and in its throat sits the time card of a real
order: order 2, one ruled line per on-chain transaction, from 10:28:47 at block 26,204,499 (the rule
fired) to 10:37:35 at block 26,204,543 (settled on proof), total 8 min 48 s, and the stamp the live
desk read earns. Everything else is the classified page in quiet type. The clock is the one loud
thing; the card is the content.

## The files in brand/

| File                                                                                            | What it is                                                                                     | Size               |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------ |
| [`brand/wordmark.svg`](brand/wordmark.svg)                                                      | HELP WANTED in Alfa Slab One as outlines, Enamel on Newsprint                                  | 2.9 kB             |
| [`brand/wordmark-night.svg`](brand/wordmark-night.svg)                                          | The same, Newsprint (day value) on the night ground                                            | 2.9 kB             |
| [`brand/mark.svg`](brand/mark.svg)                                                              | The HW stamp mark, `public/favicon.svg` drawn at 512                                           | 0.7 kB             |
| [`brand/mark-night.svg`](brand/mark-night.svg)                                                  | The mark in its night colours                                                                  | 0.7 kB             |
| [`brand/recorder.svg`](brand/recorder.svg)                                                      | The Recorder's SVG twin at rest (10:37:35), standalone                                         | 14.9 kB            |
| [`brand/recorder-night.svg`](brand/recorder-night.svg)                                          | The same in the night edition                                                                  | 14.9 kB            |
| [`brand/stamps/`](brand/stamps/)                                                                | PROVEN ON CHAIN, RECEIPT ON CHAIN, FILLED, REFUNDED, NO RECEIPT YET; each with a `-night` twin | 2.0 to 4.9 kB each |
| [`brand/stills/recorder-rest-day.webp`](brand/stills/recorder-rest-day.webp) and `.png`         | The WebGL Recorder at rest, 1600 x 1567, transparent                                           | 66.5 / 64.2 kB     |
| [`brand/stills/recorder-rest-night.webp`](brand/stills/recorder-rest-night.webp) and `.png`     | The same, night edition                                                                        | 100.8 / 97.2 kB    |
| [`brand/stills/recorder-strike-day.webp`](brand/stills/recorder-strike-day.webp) and `.png`     | Mid-strike at 10:28:47, the lever at the bottom of its stroke                                  | 62.6 / 61.6 kB     |
| [`brand/stills/recorder-strike-night.webp`](brand/stills/recorder-strike-night.webp) and `.png` | The same, night edition                                                                        | 97.3 / 94.9 kB     |
| [`brand/stills/card-ejected.webp`](brand/stills/card-ejected.webp) and `.png`                   | The share card's page (`/og-card`) at twice its size, 2400 x 1260                              | 98.6 / 94.6 kB     |

Every SVG carries a comment saying what it is and which script made it. The SVGs stand alone: no
font is needed (lettering is outlined), no stylesheet (colours are attributes), and each stamp
carries its own worn-ink filter. The WebP files are lossless; the PNGs are full colour with alpha
(the script reduces a PNG to a 256-colour palette only if it would pass 300 kB). None of these files
is served by the site. The served icons live in `public/` (`favicon.svg`, its PNGs and
`manifest.webmanifest`); `brand/mark.svg` is made from `favicon.svg`, never the other way round.

Alfa Slab One and IBM Plex Mono are under the SIL Open Font License 1.1, which allows their outlines
in a logo or a drawing. On the site the name stays live text.

## Colour

Two papers, two inks, one red, and brass for the clock alone. Every colour is a custom property in
`tokens.css`; components use the names, never a hex. The night edition is drawn, not inverted: it
applies when the reader's system asks for dark and no edition was chosen, or when the night edition
was chosen (the toggle writes `data-theme` on the root and saves `hw-theme`).

| Token          | Property        | Day       | Night     | Role                                                                                                 |
| -------------- | --------------- | --------- | --------- | ---------------------------------------------------------------------------------------------------- |
| Newsprint      | `--newsprint`   | `#f3eee2` | `#15130f` | The page ground.                                                                                     |
| Card stock     | `--card`        | `#e8e1d0` | `#211e18` | The time card, HOUSE ads, the slip's result row, a ghost key's hover. Always with a 1 px Rule edge.  |
| Enamel         | `--enamel`      | `#16130e` | `#ece5d6` | Type, rules, primary keys, hover, the focus ring, the current-page mark; the clock's case and hands. |
| Carbon         | `--carbon`      | `#4a4439` | `#c3baa8` | Decks, notes, captions, column heads, unpunched card lines.                                          |
| Ribbon (marks) | `--ribbon`      | `#c1271a` | `#ff6b57` | Red stamps, the red punch mark, a hash group that differs.                                           |
| Ribbon (type)  | `--ribbon-type` | `#a41e10` | `#ff8571` | Red words: the settled line of a proven card, a warning set in type.                                 |
| Brass          | `--brass`       | `#b8893a` | `#b8893a` | The clock's metal only.                                                                              |
| Meta           | `--meta`        | `#675f51` | `#9a917f` | Placeholders, the `0x` of a hash, waiting states, grey stamps.                                       |
| Rule           | `--rule`        | `#bdb49f` | `#453f34` | Hairlines. Never text, never the only edge of a control.                                             |
| On-ribbon      | `--on-ribbon`   | `#ffffff` | `#15130f` | Type set on Ribbon.                                                                                  |

The names `global.css` was first written with (`--paper`, `--paper-2`, `--ink`, `--ink-2`, `--ink-3`,
`--hair`, `--spot`, `--spot-ink`, `--on-spot`) are aliases of the names above. New rules use the new
names.

**Red is a verdict.** Red appears only where a check against the chain passed: a red stamp
(PROVEN ON CHAIN, RECEIPT ON CHAIN and the other proof stamps below), the "Settled on proof" line of a
time card whose live desk read is Delivered and proven, a hash group that differs from the one it is
compared with, and a warning set in type. Hover, focus, navigation, keys, links and headings are
never red. The first screen of the day edition has no red until the card is paid.

**Brass is a material.** Brass is the clock's metal: the bezel, the throat lip, the lever's arm and
hub, the second hand, its counterweight and centre cap, the sign's frame. It is never type, never a
control, never a background, never a gradient, and it does not appear in HTML at all.

### Contrast

WCAG 2 ratios, computed from the token values by `node apps/web/scripts/brand-kit.mjs` (it prints
this table). Text needs 4.5:1, or 3:1 at 24 px and up; a mark that carries meaning needs 3:1.

| Pairing                                                     | Kind | Day     | Night   |
| ----------------------------------------------------------- | ---- | ------- | ------- |
| Enamel on Newsprint                                         | text | 16.00:1 | 14.79:1 |
| Enamel on Card stock                                        | text | 14.21:1 | 13.25:1 |
| Newsprint on Enamel (primary key label, the sign's letters) | text | 16.00:1 | 14.79:1 |
| Carbon on Newsprint                                         | text | 8.33:1  | 9.64:1  |
| Carbon on Card stock                                        | text | 7.40:1  | 8.63:1  |
| Meta on Newsprint                                           | text | 5.44:1  | 5.95:1  |
| Meta on Card stock                                          | text | 4.83:1  | 5.33:1  |
| Ribbon type on Newsprint                                    | text | 6.54:1  | 7.81:1  |
| Ribbon type on Card stock                                   | text | 5.81:1  | 7.00:1  |
| On-ribbon on Ribbon (a hash group that differs)             | text | 5.88:1  | 6.62:1  |
| Ribbon mark on Newsprint (red stamp)                        | mark | 5.08:1  | 6.62:1  |
| Ribbon mark on Card stock (red stamp on the time card)      | mark | 4.51:1  | 5.93:1  |
| Meta mark on Newsprint (grey stamp)                         | mark | 5.44:1  | 5.95:1  |
| Enamel focus ring on Newsprint                              | mark | 16.00:1 | 14.79:1 |
| Brass on Newsprint (decorative)                             | mark | 2.72:1  | 5.90:1  |
| Brass on Enamel (the clock's metal on its case)             | mark | 5.89:1  | 2.51:1  |
| Rule on Newsprint (hairlines only)                          | mark | 1.78:1  | 1.78:1  |
| Card stock on Newsprint                                     | mark | 1.13:1  | 1.12:1  |
| The night wordmark: Newsprint (day) on Newsprint (night)    | text |         | 16.02:1 |

The lowest text pairing is Meta on Card stock in the day edition, 4.83:1: do not set Meta any
smaller or lighter than it is. Card stock is only 1.13:1 against Newsprint, which is why a card
always has its 1 px Rule edge. Brass falls under 3:1 against Newsprint by day and against the case at
night, which is one more reason it is never used to say anything.

## Type

Three faces, three weights (400, 600, 900), six sizes. Fonts are self-hosted from `@fontsource`; no
font is fetched from another host.

| Face                    | Property  | Weights               | What it sets                                                                                                                                                                     |
| ----------------------- | --------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alfa Slab One           | `--slab`  | 400                   | The name only: the running head, the clock's sign, the share card, the wordmark. And the numerals of a true sequence (the counters of the five steps, the lines of What is new). |
| Source Serif 4 Variable | `--serif` | 400, 600, 900, italic | Everything that is read. Reading 400, labels and keys 600, headlines 900, decks in italic. Optical size follows the size.                                                        |
| IBM Plex Mono           | `--mono`  | 400, 600              | What the clock prints and the chain says: times, blocks, hashes, addresses, amounts, commands, the folio. Never prose: no run of 12 words or more.                               |

The clock prints in Plex Mono for a reason: IBM grew out of the International Time Recording Company
and the punched-card business it was merged with in 1911.

The scale is fluid between a 375 px and a 1440 px screen. These are the only sizes; a new rule uses
one of them, never a number of its own.

| Size   | At 390 px | At 1440 px | Used for                                 |
| ------ | --------- | ---------- | ---------------------------------------- |
| `--s1` | 13.5 px   | 14 px      | Notes, data, card rows, the folio        |
| `--s2` | 15 px     | 16 px      | Keys, tables, ads, the nav               |
| `--s3` | 17 px     | 18.5 px    | Reading, the card's caption, step detail |
| `--s4` | 20 px     | 24 px      | Decks, section heads, step titles        |
| `--s5` | 26 px     | 40 px      | The running-head name, figures           |
| `--s6` | 36.5 px   | 72 px      | The page headline only                   |

Tracking:

- 0 everywhere in content. Labels are never tracked open (the probe's bar is +0.04em).
- Headlines of 28 px and up are set at -0.022em.
- The slab name is set at +0.01em, in capitals. The running head is the one place CSS sets capitals
  (`text-transform: uppercase` on `.runhead__name`).

Figures: old-style in running text, lining in headings and labels, lining and tabular in mono.

## Stamps

A stamp is the final word on a thing that has ended. It is drawn, not typed: an SVG made by
[`src/lib/stamp.ts`](src/lib/stamp.ts), through [`src/components/Stamp.astro`](src/components/Stamp.astro)
on the server and `stampSvg()` in browser scripts. Never draw a stamp by hand, in another face or in
another colour.

| Ink                 | Frame                                    | Words on the site                                                                                                                                                                                                               | When                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proof`: Ribbon red | Double: a 3.2 frame and a 1.1 inner rule | PROVEN ON CHAIN, RECEIPT ON CHAIN, DELIVERED ON CHAIN, OFFICIAL RELEASE                                                                                                                                                         | A check against the chain passed: an order Delivered and proven, a receipt check that matched, a swarm job with its receipt on chain, a question delivered on chain, the report's official release.                           |
| `filled`: Enamel    | Single, 3.2                              | FILLED, DOES NOT MATCH, ANSWERED                                                                                                                                                                                                | The thing ended and no proof was checked (an order Delivered without the proven mark, a swarm job completed without a receipt on chain, a pot delivered, a question answered), or the check ran and the record did not match. |
| `void`: Meta grey   | Dashed, 2                                | REFUNDED, NO RECEIPT YET, COULD NOT CHECK, WITHDRAWN, DISPUTED, REFUNDABLE, BLOCKED, FAILED, NEVER COMPLETED, REFUSED, NO ANSWER, NOT LAUNCHED YET, UNOFFICIAL TALLY, and the page stamps NO SUCH PAGE, STOP PRESS and SPECIMEN | Nothing was proven: the money went back, nothing is there yet, the job stopped, or the check could not run.                                                                                                                   |
| `live`: no stamp    | None                                     | Taken, At work, Delivery claimed, Hiring                                                                                                                                                                                        | A status that is still moving is set in type, in sentence case. Nothing has been stamped yet.                                                                                                                                 |

Red is allowed on a stamp only in the `proof` ink, and the `proof` ink only for the verdicts in its
row. A mismatch is a verdict too, but it is stamped in Enamel: red never means "bad" on this site.

How a stamp is built: the words in IBM Plex Mono SemiBold capitals, 20 units high, spread to a fixed
width (an advance of 0.74em a letter), so a stamp's width follows from its number of letters; a slight
turn (-4 degrees at the card size, -3 at mid and big, +3 for a second stamp beside the first); the
worn-ink filter `#stamp-ink` (defined once in `Layout.astro`). Sizes are set by height: `--h` 1.85rem
on cards (1.75rem on the time card), 2.9rem mid, and a fluid big size up to 5.6rem for verdicts. A
fresh stamp lands once (the thump, below) and its ink never lifts.

The files in `brand/stamps/` are drawn at the mid size (46.4 px tall), turned -3 degrees, with the
filter inside each file. In the HTML the words stay text inside the SVG, so a reader of the raw page
finds "PROVEN ON CHAIN" where a person sees the stamp; in the brand files they are outlines with the
words in the file's title.

## The time card

[`src/components/TimeCard.astro`](src/components/TimeCard.astro) prints an order as the card a time
clock punches. It is an HTML table, whole in the page as sent; the clock around it is theatre.

- **Caption:** "Order N · day" as a link to the order's page, the HOUSE tag, and an italic note in
  Carbon (who fired it and who ran it, in the model's own words).
- **Columns:** When (UTC), Block, Step. Mono for the time and the block only; the step is serif.
- **Lines:** one per on-chain transaction of the order's trail, each with its punch mark in the margin
  (a 0.24rem bar of Enamel) and `data-at`, its UTC second of the day.
- **The settled line:** in Ribbon type, semibold, with a red punch mark, only when the live desk read
  says Delivered and proven. Otherwise it is Enamel like the others.
- **Foot:** "Total" and the duration from opening to settlement (`formatDuration`), and the stamp
  the live desk read earns (`orderStamp`).
- **After-lines:** what happened after settlement (the change withdrawn, the tip paid to a seat's
  owner) under a dashed rule, in Carbon italic, not counted in the total.
- **Blank:** with no order to print, the card is the classified page's hatched slot, "This space
  for hire."
- **Look:** Card stock, a 1 px Rule edge, radius 2 px; a 2 px Enamel rule over the head and under the
  last line.

**Data source.** The lines come from the pinned history, `pinnedOrder()` in
[`src/config/history.ts`](src/config/history.ts): the same trail `/orders/2` and its `.md` and `.json`
twins print. The stamp and the red line come from the live desk read. Never invent a figure: every
time, block, total and label on a card is in the model or the pinned history, and the total is
computed, never typed. With no pinned order (a book that is not mainnet's), print the blank card.

## The Recorder

One geometry, two renderers.

- **[`src/scripts/recorder/geometry.ts`](src/scripts/recorder/geometry.ts)** holds every dimension
  and the one projection: units of one case width, an orthographic camera at a fixed pitch of
  -8 degrees, a yaw of at most 6 degrees either way. It also holds `PARTS` (every piece, its solid,
  material, layer and what turns it), `FRAME` (the viewBox both renderers frame), `handAngles`,
  `leverAngle` and the three easing curves. It is data and arithmetic only: no DOM, no three.js.
- **The SVG twin, [`src/components/Recorder.astro`](src/components/Recorder.astro)**, is drawn on
  the server from those numbers at yaw 0, hands at rest at the time order 2 settled (10:37:35). It is
  printed as the scene prints: flat Enamel, Brass and Newsprint; one 135 degree hatch at an 11-unit
  pitch in three weights that thicken into the shade; gleam lines in the lighter ink on the top edge,
  the bezel and the knob; a 2.5 px outline in the darker ink. At night Enamel and Newsprint swap, and
  the two inks swap with them (`--rc-dark`, `--rc-light` in `clockin.css`), so a gleam is never dark.
- **The WebGL print, [`scene.ts`](src/scripts/recorder/scene.ts) and
  [`print.ts`](src/scripts/recorder/print.ts)**, builds the same parts with three.js 0.186.1: five
  meshes and two outline hulls, seven draw calls, one texture (the sign's lettering). Light comes from
  above, left and in front. Hatch lines are fixed to the screen at a 3 CSS px pitch; the outline is
  1.25 CSS px outside the silhouette. Colours are the tokens' sRGB values written out unchanged, so
  the canvas's Newsprint is the page's Newsprint. A canvas with `data-print="flat"` draws flat
  two-tone shading instead of the engraving.

**Layer order** inside `.recorder`: the rear (the SVG `recorder__rear`, or the canvas over it once the
scene is showing), then the HTML card (`recorder__card`), then the front SVG with the brass throat
lip (`recorder__front`), which covers the card's lower edge and so seats it in the clock. The canvas
never paints the lip. The card's CSS transform follows `planeMatrix(0, yaw)`, so card, lip and clock
stay registered as the clock turns.

**When each runs.**

| Situation                        | What the reader sees                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No JavaScript, or reduced motion | The SVG twin at rest, every line punched, the stage in the flow (not sticky). Every word, figure and stamp is in the server HTML.                                                                                                                                                                                      |
| JavaScript with motion allowed   | The inline script sets `clock-on` before the first paint; [`src/scripts/clockin.ts`](src/scripts/clockin.ts) drives the SVG's hands and lever by the scroll (the 2.5D path). If it has not started within 3 s, `clock-on` is removed and the page is still.                                                            |
| And the device can draw it       | After `load` and an idle moment, the scene is imported lazily, only if motion is allowed, Save-Data is off, `deviceMemory` is at least 2 and cores at least 4 where reported, and WebGL2 opens with `failIfMajorPerformanceCaveat`. It shows after its first frame, near the top of the page, with a 240 ms crossfade. |
| Trouble                          | A median frame over 12 ms drops the pixel ratio to 1.5, over 18 ms to 1; over 28 ms at 1, a lost context, a failed import or `pagehide` crossfades back to the SVG. The scene renders only when told to; an idle page draws nothing.                                                                                   |

The scene runs on the front page only. The development bench, `/dev/recorder`, shows the scene on
its own with `geometry.ts`'s outlines over it (query: `t` UTC seconds, `yaw`, `lever` 0 to 1,
`edition`, `w`, `dpr`, `flat=1`, `overlay=1`, `card=1`, `still=1`); it answers 404 in production.

## Motion

Only `transform` and `opacity` move, on the token curves, and never with `transition: all`. Nothing
runs forever. With reduced motion nothing moves at all.

| Token                          | Value                            | Used for                                                             |
| ------------------------------ | -------------------------------- | -------------------------------------------------------------------- |
| `--ease-out`                   | `cubic-bezier(0.16, 1, 0.3, 1)`  | Arrivals and returns                                                 |
| `--ease-io`                    | `cubic-bezier(0.65, 0, 0.35, 1)` | A stroke that starts and stops: a key going down, the lever striking |
| `--ease-stamp`                 | `cubic-bezier(0.2, 1.5, 0.4, 1)` | One overshoot, as a stamp lands; the card's eject                    |
| `--t-press` / `--t-release`    | 70 ms / 320 ms                   | A key going down / coming back                                       |
| `--t-strike` / `--t-return`    | 90 ms / 380 ms                   | The lever going down / coming back                                   |
| `--t-thump`                    | 420 ms                           | A stamp landing                                                      |
| `--t-eject`                    | 640 ms                           | The card coming out of the clock                                     |
| `--t-reveal` / `--t-stagger`   | 520 ms / 60 ms                   | A section appearing once / between its items                         |
| `--t-page-out` / `--t-page-in` | 160 ms / 320 ms                  | The old page leaving / the new one arriving                          |

**The punch key.** Every `.btn` (React islands included) and every Copy key: pressed, it goes down
2 px and to 0.985 in 70 ms on the in-out curve; let go, it springs back in 320 ms on the expressive
curve, as the lever does. No ledge, no colour flash, no sound. With reduced motion it does not move;
it darkens to Carbon while held. Hover is instant and in Enamel: a primary key's label is underlined,
a ghost key fills with Card stock, a link's underline turns Enamel and doubles to 2 px. Focus is a
2 px Enamel outline 3 px out.

**The one load moment: clocking in.** 120 ms after `load` the lever strikes (90 ms down, 380 ms back)
and line 1 of the card takes its punch: the mark inks in over 180 ms and settles on the stamp curve
over 280 ms. Under half a second, once. It is the only orchestrated entrance on the site.

**The scroll.** On the front page the clock is a function of the scroll position, so it scrubs both
ways: 180 seconds of order time to a screen (`--order-seconds-per-screen`), each step as tall as
order 2 spent on it, so the swarm's 228 s of work is the longest stretch of the page. A line is
punched when the reading line passes its time; lines crossed in one frame take their marks 70 ms
apart; scrolling back lifts the marks without strikes. In the hold after the last line the card comes
out of the clock toward the reader.

**Reveals.** An element marked `data-reveal` (the front page's sections below the hero, the ads on
`/hire`, the order cards) comes up once: opacity and a 16 px rise, 520 ms, 60 ms apart within one
parent. [`src/scripts/site.ts`](src/scripts/site.ts) arms them only after its observer is attached
and the reader has scrolled once, so an unscrolled page, a page without scripts and a page with
reduced motion show everything. A finite CSS failsafe shows anything still waiting after 6 s. Never a
mask. `/judges` and `/questions` have none.

**Page transitions** (native cross-document view transitions, under
`prefers-reduced-motion: no-preference`; a browser without them simply loads the page):

| Name                              | On                                                                 | What it does                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`                            | The page                                                           | The old page fades and rises 8 px in 160 ms; the new one rises from 14 px below in 320 ms after 60 ms. Going back runs it the other way (the `back` type, set at `pagereveal`). |
| `hw-runhead`, `hw-nav`            | The running head and the nav                                       | Held still: the masthead does not blink between pages.                                                                                                                          |
| `hw-nav-mark`                     | The 3 px Enamel bar under the current link                         | Slides from the old section to the new one in 360 ms.                                                                                                                           |
| `verdict-<first 8 of the job id>` | The time card's stamp on `/`, and the big stamp on `/verify/<job>` | The stamp travels into the verdict box, 420 ms (class `hw-stamp`).                                                                                                              |
| `order-<id>-stamp`                | An order card's stamp, and the big stamp on `/orders/<id>`         | The same travel.                                                                                                                                                                |

A name is used at most once on a page, or the browser skips the transition. The edition toggle is a
240 ms cross-fade of the whole page (`edition-turn`), and instant with reduced motion.

## Layout

- The front page is a time card read against a clock; every other page is the classified page in
  ruled columns. One object, one page: no clock on inner pages.
- Corners of at most 4 px: keys 0, the time card 2 px. A stamp's own frame is artwork.
- No shadows. The nav's 3 px rule under a hovered link is drawn with an inset box-shadow; that is a
  rule, and the only one.
- No cards in cards. A card is Card stock with its Rule edge; nothing inside it is boxed again.
- No gradient fills and no gradient text. The one repeating gradient is the 135 degree hatch of a
  blank slot ("This space for hire."), the same angle as the clock's hatch.
- Measure 66ch for reading, a page of 76rem, a fluid gutter. Keys and nav links are at least 44 px
  tall.
- `main` clips sideways with `overflow-x: clip`, never `hidden` (which would stop the sticky stage).

## Voice

The site speaks plainly and exactly, in sentence case. Every sentence a page prints comes from its
model in `src/models`, which the page's `.md` and `.json` twins print too; a figure comes from the
model or the pinned history, never from a design.

- **Capitals** are kept for the name (the running head, the wordmark, the clock's sign) and the
  stamps. Two uses follow from those: the cry at the head of an ad ("HELP WANTED:", "CHIP IN:"), which
  is the name's lettering, drawn as SVG by [`src/components/Cry.astro`](src/components/Cry.astro) with
  the words as its accessible name; and the one-word tags HOUSE and OUTSIDE. A label in capitals is
  never typed into a page.
- **The classified vocabulary:** Situations vacant, This space for hire, the desk, the runner, the
  receipt, the slip, the stamp, payroll, seats, tips, the folio, the Day edition and the Night edition,
  HOUSE and OUTSIDE. The design system's own names (card, punch, recorder, ribbon) are for code and
  this document; the pages use them only to describe a picture, as the share image's alt text does.
- **At most one two-beat line a page** ("Robots wanted. Pay on proof." on `/hire`); the front page's
  headline is one sentence, "HELP WANTED makes the pay wait."
- **No em dash** and no emoji, anywhere: pages, files, comments, commit messages. Use a colon, a
  comma or a full stop.
- **The words the site never uses** are the ten words in `test/helpers.ts` `BANNED` (and the nine of
  them in `scripts/evidence/test/helpers.ts` `REFUSED`, which guards the README and the evidence
  files). Read them there; they are not repeated here, so that this file passes the same check.

## The pre-ship checklist: the design-critic probe

The design-critic probe (`taste.mjs`, taste@1, from IdentityMD's design-critic skill) measures a
running site. It is not part of this repository: keep a copy outside it, and give the probe an output
folder outside it too. Run it on the built server:

```sh
pnpm --filter @help-wanted/web build
PORT=4407 HOST=127.0.0.1 node apps/web/dist/server/entry.mjs     # every variable is optional
node <your copy of taste.mjs> http://127.0.0.1:4407/ --out <a folder outside the repository>
```

It opens the page at 390, 1440 and 320 px wide (and once with reduced motion), prints 16 checks and
writes screenshots. Run it on `/`, `/verify`, `/verify/42f26c64-eea9-46f2-822a-33547ec18abf`,
`/orders/1`, `/orders/2`, `/hire`, `/hire/research`, `/rules/new` and `/judges`, in both editions, with
the GPU on and off. A change ships at 16 of 16 on every one.

| Check       | What it means                                                                                                                             | How this system passes                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| render      | The page draws, with no script error, no missing local file and no external host                                                          | Fonts and three.js are self-hosted; the scene's errors fall back to the SVG                             |
| layout      | No sideways scroll at 320, 390 or 1440; no text box over another; no fixed or sticky control over text; no text cut by `overflow: hidden` | `overflow-x: clip`; the stage holds no links; the card hides behind the clock by layering, not clipping |
| targets     | Controls at least 24 px, or spaced (WCAG 2.5.8)                                                                                           | Keys and nav at 44 px                                                                                   |
| contrast    | Text at least 4.5:1 (3:1 at 24 px and up)                                                                                                 | The table above; nothing under 4.83:1                                                                   |
| casing      | No all-caps text in content (SVG artwork and the header are not counted)                                                                  | Capitals only in the running head, stamps, the sign and the cry, all SVG or chrome                      |
| tracking    | Nothing tracked wider than +0.04em; nothing tighter than -0.04em under 28 px                                                              | 0 in content; -0.022em only on headlines of 28 px and up                                                |
| eyebrows    | No small caps, mono or tracked kicker label above a heading                                                                               | Labels sit beside or under what they name                                                               |
| type-sizes  | At most six sizes used more than once per width, eight counting one-offs                                                                  | `--s1` to `--s6` and nothing else                                                                       |
| type-faces  | At most three families and three weights; no mono prose of 12 words or more                                                               | Slab, serif, mono; 400, 600, 900                                                                        |
| glyphs      | No em dash and no emoji in the site's own words                                                                                           | The voice rules                                                                                         |
| slogans     | At most three two-beat lines                                                                                                              | One a page at most                                                                                      |
| repetition  | No line of five words or more shown twice; no scrolling ticker                                                                            | Each sentence once; no ticker                                                                           |
| copy-budget | At most 60 words of prose on the first phone screen, 90 on the desktop one                                                                | The hero is a headline, a tagline and two keys                                                          |
| chrome      | No border with a shadow, no card in a card, no gradient text                                                                              | The layout rules                                                                                        |
| motion      | No `transition: all`; no endless animation, and none left running with reduced motion                                                     | Named properties; finite animations; the WebGL loop is not a CSS animation and stops when idle          |
| share       | A real title, a favicon, `og:title`, `og:image` and a description                                                                         | Set by `Layout.astro`                                                                                   |

Before shipping also: `pnpm --filter @help-wanted/web typecheck`, `test` and `build`; every route
answers 200 without JavaScript and `/` contains the headline, the five step titles, 26,204,499,
26,204,543, 8 min 48 s and PROVEN ON CHAIN; a reduced-motion run shows every line printed and no
sticky stage; screenshots at 390 and 1440 in both editions.

## Making the files again

From the repository root, after `pnpm install --frozen-lockfile`. The scripts are run by hand and are
not part of the build; they take `fontkitten` and `sharp` from the workspace's pnpm store.

```sh
# Wordmarks, marks and stamps, from tokens.css, public/favicon.svg, src/lib/stamp.ts and the font
# files. It also prints the contrast table above. Nothing has to be running.
node apps/web/scripts/brand-kit.mjs

# The Recorder SVGs, the stills and the card composite need the development server (the stills use
# the /dev/recorder bench) and Playwright driving the machine's Chrome, which draws WebGL on the GPU.
pnpm --filter @help-wanted/web exec astro dev --port 4406
node apps/web/scripts/brand-renders.mjs http://127.0.0.1:4406
# or only some of them:
node apps/web/scripts/brand-renders.mjs http://127.0.0.1:4406 recorder stills card

# Stop the development server by its port when done.
kill $(lsof -ti tcp:4406)
```

`brand-renders.mjs` finds Playwright as the probe does: the module named by `IMD_PLAYWRIGHT`, else an
installed `playwright`, else the newest copy in npx's cache. It prints the GPU each still was drawn on;
it should name the machine's GPU, not SwiftShader. Run `brand-kit.mjs` after a change to the tokens,
the favicon or the stamp drawing, and `brand-renders.mjs` after a change to `geometry.ts`,
`Recorder.astro`, the print or `og-card.astro`. Then open the files and look at them.

The stills: the WebGL canvas from `/dev/recorder?still=1` at 800 CSS px and a pixel ratio of 2 (so the
hatch is the page's own 6 device px), with the SVG throat lip laid over it as the page lays it, then
lossless WebP and PNG. At rest: 10:37:35, lever at rest. Mid-strike: 10:28:47, the order's first punch,
the lever at the bottom of its stroke (90 of 470 ms). `recorder.svg` is the server's own markup of the
SVG twin, taken from `/og-card`, with the classes of `clockin.css` written out as colours, the sign's
lettering outlined and the outline fixed at 5.68 units, which is the page's 2.5 px at the desktop card
width (22rem). `card-ejected` is `/og-card` at twice its size; `public/og.png` is made from the same page
at 1200 x 630, as `og-card.astro` describes.

## Do and don't

Do:

- Use the token names, the six sizes and the two curves; nothing else.
- Put red only where the chain said yes, and say in type what a red mark means.
- Keep every word and figure in the server HTML; motion only shows what is already there.
- Give every moving thing a still state that is complete without JavaScript and with reduced motion.
- Take order data from the model or the pinned history, and stamps from `stamp.ts`.
- Edit `geometry.ts` to change the clock, and change both renderers in the same commit.
- Check new work with the probe in both editions before it ships.

Don't:

- Use red for hover, focus, links, keys, navigation or emphasis.
- Use Brass in HTML, for type or a control, or in a gradient.
- Add a fourth face, a fourth weight, a seventh size or a tracked label.
- Round a corner past 4 px, add a shadow, box a card inside a card, or fill text with a gradient.
- Animate anything but transform and opacity, use `transition: all`, or loop an animation forever.
- Hide content until a script shows it, or mask it on its way in.
- Put the clock on an inner page, or a second loud thing beside it.
- Type capitals into a page, or use an em dash or one of the ten banned words.
- Invent a time, a block, a total or a verdict for a picture.
