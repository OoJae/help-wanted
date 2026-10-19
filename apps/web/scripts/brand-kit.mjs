/**
 * The brand kit's drawn files, made from the site's own sources, with nothing to start first:
 *
 *   brand/wordmark.svg, wordmark-night.svg   HELP WANTED in Alfa Slab One, as outlines
 *   brand/mark.svg, mark-night.svg           the HW stamp mark, as public/favicon.svg draws it
 *   brand/stamps/*.svg                       stamps from stampSvg() in src/lib/stamp.ts
 *
 * and it prints the contrast table of the colour tokens (the one in BRAND.md). Run it from the
 * repository root after a change to tokens.css, the favicon or the stamp drawing:
 *
 *   node apps/web/scripts/brand-kit.mjs
 *
 * Alfa Slab One and IBM Plex Mono are under the SIL Open Font License 1.1, which allows their
 * outlines in a logo or a drawing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stampBox, stampSvg } from "../src/lib/stamp.ts";
import {
  BRAND,
  FONT_FILES,
  WEB,
  contrast,
  glyphPath,
  lineInk,
  n,
  openFont,
  outlineLine,
  readTokens,
  setLine,
  write,
} from "./brand-lib.mjs";

const { day, night } = readTokens();
const slab = await openFont(FONT_FILES.slab);
const mono = await openFont(FONT_FILES.mono600);

// ---- The wordmark -------------------------------------------------------------------------------

/**
 * The name as the running head sets it: capitals, +0.01em, the font's own kerning. Set at 200 units
 * to the em; the clear space round it is 0.4 em (80 units), about half the height of a capital.
 */
function wordmark(ink, ground, edition) {
  const size = 200;
  const tracking = 0.01;
  const clear = 0.4 * size;
  const line = setLine(slab, "HELP WANTED", { tracking });
  const s = size / slab.unitsPerEm;
  const ink0 = lineInk(line);
  const width = (ink0.maxX - ink0.minX) * s + 2 * clear;
  const height = (ink0.maxY - ink0.minY) * s + 2 * clear;
  const x = clear - ink0.minX * s;
  const y = clear + ink0.maxY * s;
  const { d } = outlineLine(slab, "HELP WANTED", { size, x, y, tracking });
  const W = n(width, 1);
  const H = n(height, 1);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="title">`,
    `<!-- HELP WANTED, ${edition} edition: Alfa Slab One (SIL Open Font License 1.1) in capitals at +0.01em with the font's kerning, as outlines. The first rect is the ground; delete it to set the name on another paper. Made by apps/web/scripts/brand-kit.mjs. -->`,
    `<title id="title">HELP WANTED</title>`,
    `<rect id="ground" width="${W}" height="${H}" fill="${ground}"/>`,
    `<path id="name" fill="${ink}" d="${d}"/>`,
    `</svg>`,
    "",
  ].join("\n");
}

write(join(BRAND, "wordmark.svg"), wordmark(day.enamel, day.newsprint, "day"));
write(join(BRAND, "wordmark-night.svg"), wordmark(day.newsprint, night.newsprint, "night"));

// ---- The mark -----------------------------------------------------------------------------------

/**
 * public/favicon.svg at eight times its size: the same rects and the same path, every number
 * multiplied by 8 (the path holds only moves, lines and closes, so every number in it is a length).
 * Its colours are the favicon's own, read from its style block: the plain rule for the day mark,
 * the prefers-color-scheme rule for the night one.
 */
function mark(edition) {
  const svg = readFileSync(join(WEB, "public/favicon.svg"), "utf8");
  const k = 512 / Number(/viewBox="0 0 (\d+(?:\.\d+)?) /.exec(svg)[1]);
  const style = /<style>([\s\S]*?)<\/style>/.exec(svg)[1];
  const dark = /@media \(prefers-color-scheme:\s*dark\)\{([\s\S]*)\}$/.exec(style)?.[1] ?? "";
  const plain = style.slice(0, style.indexOf("@media"));
  const rule = (css, cls, prop) => new RegExp(`\\.${cls}\\{[^}]*${prop}:(#[0-9a-fA-F]{3,6})`).exec(css)?.[1];
  const colour = (cls, prop) =>
    (edition === "night" ? rule(dark, cls, prop) : null) ?? rule(plain, cls, prop);
  const scale = (v) => n(Number(v) * k, 2);
  const shapes = [...svg.matchAll(/<(rect|path)\s([^>]*?)\/>/g)].map(([, tag, attrs]) => {
    const get = (name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
    const cls = get("class");
    const paint =
      cls === "p"
        ? `fill="${colour("p", "fill")}"`
        : cls === "s"
          ? `fill="${colour("s", "fill")}"`
          : `fill="none" stroke="${colour("f", "stroke")}"`;
    if (tag === "path") {
      const d = get("d").replace(/-?\d*\.?\d+/g, (v) => scale(v));
      return `<path ${paint} d="${d}"/>`;
    }
    const geometry = ["x", "y", "width", "height", "rx", "stroke-width"]
      .filter((a) => get(a) !== undefined)
      .map((a) => `${a}="${scale(get(a))}"`)
      .join(" ");
    return `<rect ${geometry} ${paint}/>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-labelledby="title">`,
    `<!-- The HW stamp mark, ${edition} edition: public/favicon.svg drawn at 512. Made by apps/web/scripts/brand-kit.mjs. -->`,
    `<title id="title">HELP WANTED</title>`,
    ...shapes,
    `</svg>`,
    "",
  ].join("\n");
}

write(join(BRAND, "mark.svg"), mark("day"));
write(join(BRAND, "mark-night.svg"), mark("night"));

// ---- Stamps -------------------------------------------------------------------------------------

/** The worn-ink filter, exactly as Layout.astro defines #stamp-ink for the site. */
function inkFilter() {
  const layout = readFileSync(join(WEB, "src/layouts/Layout.astro"), "utf8");
  const found = /<filter id="stamp-ink"[\s\S]*?<\/filter>/.exec(layout);
  if (!found) throw new Error("Layout.astro no longer defines the #stamp-ink filter.");
  return found[0]
    .replace(/><\/(feTurbulence|feDisplacementMap|feColorMatrix|feComposite)>/g, "/>")
    .replace(/\n\s*/g, " ")
    .replace(/\s+\/>/g, "/>")
    .replace(/\s+>/g, ">");
}

/** Where each stamp is printed, and in which ink. Red is for a check against the chain that passed. */
const STAMPS = [
  { text: "PROVEN ON CHAIN", ink: "proof" },
  { text: "RECEIPT ON CHAIN", ink: "proof" },
  { text: "FILLED", ink: "filled" },
  { text: "REFUNDED", ink: "void" },
  { text: "NO RECEIPT YET", ink: "void" },
];

/** The token each ink is printed in, as global.css colours .stamp, .stamp--proof and .stamp--void. */
const INK_TOKEN = { proof: "ribbon", filled: "enamel", void: "meta" };

/**
 * The size the files are drawn at: the site's mid stamp (--h: 2.9rem, 46.4 px tall), turned -3
 * degrees as the mid and big stamps are. The site applies the filter in CSS pixels, so the file
 * draws the stamp in pixels of that size and the wear looks as it does on the page at that size.
 */
const STAMP_HEIGHT_PX = 46.4;
const STAMP_TURN = -3;

function stamp({ text, ink }, edition) {
  const colour = (edition === "night" ? night : day)[INK_TOKEN[ink]];
  // The drawing itself is stampSvg()'s, for the site's own browser script; only its lettering is set as outlines here.
  const svg = stampSvg(text, { ink, size: "mid" });
  const inner = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
  const { width, height } = stampBox(text, ink);
  const lettering = /<text ([^>]*)>([^<]*)<\/text>/.exec(inner);
  if (!lettering) throw new Error("stampSvg() no longer draws its lettering as one <text>.");
  const attr = (name) => Number(new RegExp(`${name}="([^"]+)"`).exec(lettering[1])[1]);
  const cx = attr("x");
  const baseline = attr("y");
  const size = attr("font-size");
  const textLength = attr("textLength");
  // lengthAdjust="spacing": the letters keep their shapes and the room left over is shared
  // equally between them, so the line is exactly textLength wide, centred on x.
  const letters = [...text];
  const s = size / mono.unitsPerEm;
  const advances = letters.map((c) => mono.glyphForCodePoint(c.codePointAt(0)).advanceWidth * s);
  const natural = advances.reduce((a, b) => a + b, 0);
  const gap = letters.length > 1 ? (textLength - natural) / (letters.length - 1) : 0;
  let pen = cx - textLength / 2;
  let d = "";
  letters.forEach((c, i) => {
    const glyph = mono.glyphForCodePoint(c.codePointAt(0));
    const at = pen;
    d += glyphPath(glyph, (gx, gy) => [at + gx * s, baseline - gy * s], 2);
    pen += advances[i] + gap;
  });
  const frame = inner
    .replace(lettering[0], `<path fill="currentColor" d="${d}"/>`)
    .replaceAll("currentColor", colour);

  const k = STAMP_HEIGHT_PX / height;
  const w = width * k;
  const h = height * k;
  const t = (Math.abs(STAMP_TURN) * Math.PI) / 180;
  // Room for the turn and for the wear, which moves the ink up to 2.4 px.
  const margin = 4;
  const boxW = Math.ceil(w * Math.cos(t) + h * Math.sin(t) + 2 * margin);
  const boxH = Math.ceil(w * Math.sin(t) + h * Math.cos(t) + 2 * margin);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${boxW} ${boxH}" width="${boxW}" height="${boxH}" role="img" aria-labelledby="title">`,
    `<!-- The ${text} stamp, ${edition} edition, in ${INK_TOKEN[ink]} ${colour}: stampSvg() from apps/web/src/lib/stamp.ts with its lettering (IBM Plex Mono SemiBold, SIL Open Font License 1.1) as outlines and the site's #stamp-ink wear, at the mid size (${STAMP_HEIGHT_PX} px tall) turned ${STAMP_TURN} degrees. Made by apps/web/scripts/brand-kit.mjs. -->`,
    `<title id="title">Stamped: ${text}</title>`,
    `<defs>${inkFilter()}</defs>`,
    `<g transform="translate(${n(boxW / 2)} ${n(boxH / 2)}) rotate(${STAMP_TURN}) translate(${n(-w / 2)} ${n(-h / 2)})">`,
    `<g filter="url(#stamp-ink)">`,
    `<g transform="scale(${n(k, 4)})">${frame}</g>`,
    `</g>`,
    `</g>`,
    `</svg>`,
    "",
  ].join("\n");
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
for (const item of STAMPS) {
  write(join(BRAND, "stamps", `${slug(item.text)}.svg`), stamp(item, "day"));
  write(join(BRAND, "stamps", `${slug(item.text)}-night.svg`), stamp(item, "night"));
}

// ---- The contrast table -------------------------------------------------------------------------

/** Every pairing the site sets, foreground on background, WCAG 2 ratios in both editions. */
const PAIRS = [
  ["Enamel on Newsprint", "enamel", "newsprint", "text"],
  ["Enamel on Card stock", "enamel", "card", "text"],
  ["Newsprint on Enamel (primary key label, the sign's letters)", "newsprint", "enamel", "text"],
  ["Carbon on Newsprint", "carbon", "newsprint", "text"],
  ["Carbon on Card stock", "carbon", "card", "text"],
  ["Meta on Newsprint", "meta", "newsprint", "text"],
  ["Meta on Card stock", "meta", "card", "text"],
  ["Ribbon type on Newsprint", "ribbon-type", "newsprint", "text"],
  ["Ribbon type on Card stock", "ribbon-type", "card", "text"],
  ["On-ribbon on Ribbon (a hash group that differs)", "on-ribbon", "ribbon", "text"],
  ["Ribbon mark on Newsprint (red stamp)", "ribbon", "newsprint", "mark"],
  ["Ribbon mark on Card stock (red stamp on the time card)", "ribbon", "card", "mark"],
  ["Meta mark on Newsprint (grey stamp)", "meta", "newsprint", "mark"],
  ["Enamel focus ring on Newsprint", "enamel", "newsprint", "mark"],
  ["Brass on Newsprint (decorative)", "brass", "newsprint", "mark"],
  ["Brass on Enamel (the clock's metal on its case)", "brass", "enamel", "mark"],
  ["Rule on Newsprint (hairlines only)", "rule", "newsprint", "mark"],
  ["Card stock on Newsprint (why the card needs its Rule edge)", "card", "newsprint", "mark"],
];

console.log("\n| Pairing | Kind | Day | Night |\n|---|---|---|---|");
for (const [name, fg, bg, kind] of PAIRS) {
  const ratio = (t) => `${contrast(t[fg], t[bg]).toFixed(2)}:1`;
  console.log(`| ${name} | ${kind} | ${ratio(day)} | ${ratio(night)} |`);
}
console.log(
  `| Wordmark night: Newsprint (day) on Newsprint (night) | text | | ${contrast(day.newsprint, night.newsprint).toFixed(2)}:1 |`,
);
