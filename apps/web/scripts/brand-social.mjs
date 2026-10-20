/**
 * The X (Twitter) profile images, made from the brand kit:
 *
 *   brand/social/x-avatar.png, -800.png         the HW mark on Newsprint, for X's round crop
 *   brand/social/x-avatar-clock.png, -800.png   the Recorder's dial at 10:37:35, filling the circle
 *   brand/social/x-banner.png, -3000.png        the header: the headline, the tagline, and the clock
 *                                               handing back order 2's card, stamped PROVEN ON CHAIN
 *   brand/social/x-banner-night.png             the same header in the night edition
 *
 * Each image is a small HTML page drawn here (the brand files, the site's own tokens.css,
 * global.css and timecard.css, the self-hosted fonts) and photographed by Chrome at its exact size,
 * through Playwright. The card's lines and total come from the pinned history that /orders/2
 * prints. Nothing has to be running. From the repository root, after pnpm install:
 *
 *   node apps/web/scripts/brand-social.mjs
 *   node apps/web/scripts/brand-social.mjs --check <a folder outside the repository>
 *
 * With --check it also writes what to look at before uploading: each avatar in X's circle at 400,
 * 128, 48 and 32 px on X's light and dark grounds, and each banner under a stand-in avatar, cropped
 * to its middle 1500 x 360, and at the sizes X shows it (600 and 390 px wide).
 *
 * Playwright is found as brand-renders.mjs finds it: the module named by IMD_PLAYWRIGHT, else an
 * installed `playwright`, else the newest copy in npx's cache. It drives the machine's Chrome
 * (channel "chrome"), or Playwright's own Chromium where there is no Chrome.
 *
 * X's rules this follows: the avatar is shown as a circle, so everything that matters sits well
 * inside the inscribed circle; the banner is 3:1 but some screens crop its top and bottom, so the
 * words, the card, the dial and the clock's sign stay in the middle 360 px of 500 (only the plain
 * foot of the case runs below it, and a crop there cuts through bare enamel); and the round avatar
 * covers its bottom left corner, so nothing is drawn in the left 400 px of the bottom 160 px. One
 * spot colour: the red is the stamp's and nothing else on the banner is red, so the card's settled
 * line is printed in Enamel here, not in the Ribbon type the site gives a proven card.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BRAND, WEB, importStore, write } from "./brand-lib.mjs";

// The site's TypeScript imports its workspace packages with ".js" names for ".ts" files, as its
// bundler allows; Node needs to be told. Only relative names are rewritten, and only when the ".js"
// file is not there.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (/^\.\.?\//.test(specifier) && specifier.endsWith(".js")) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

const { ORDER_HISTORY, pinnedOrder } = await import("../src/config/history.ts");
const { formatDuration, formatInt, formatUtc } = await import("../src/lib/format.ts");
const { BEZEL, planeMatrix } = await import("../src/scripts/recorder/geometry.ts");

const args = process.argv.slice(2);
const checkAt = args.includes("--check") ? args[args.indexOf("--check") + 1] : null;
/** Names after the options make only those images (x-avatar, x-avatar-clock, x-banner, x-banner-night). */
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--check");
if (args.includes("--check") && !checkAt) {
  console.error("Name a folder for the check images: --check <a folder outside the repository>");
  process.exit(1);
}

const OUT = join(BRAND, "social");
const sharp = (await importStore("sharp")).default;

// ---- Order 2's card, from the pinned history -----------------------------------------------------

const order = pinnedOrder(ORDER_HISTORY.workOrders, 2);
if (!order) throw new Error("order 2 is not in the pinned history");
const opened = order.trail.find((x) => x.key === "opened");
const settled = order.trail.find((x) => x.key === "settled");
const CARD = {
  id: order.id,
  day: formatUtc(opened.tx.at).split(", ")[0],
  lines: order.trail.map((x) => ({
    label: x.label,
    at: x.tx.at.slice(11, 19),
    block: formatInt(x.tx.block),
  })),
  total: formatDuration(Date.parse(settled.tx.at) - Date.parse(opened.tx.at)),
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** TimeCard.astro's markup for order 2, with the share card's stamp under the total. */
function timeCard(edition) {
  const rows = CARD.lines
    .map(
      (l) =>
        `<tr class="timecard__line"><td class="timecard__when"><span class="timecard__punch"></span>${l.at}</td>` +
        `<td class="timecard__block">${l.block}</td><td class="timecard__step">${esc(l.label)}</td></tr>`,
    )
    .join("");
  const stamp = edition === "night" ? "proven-on-chain-night.svg" : "proven-on-chain.svg";
  return `<div class="timecard"><table class="timecard__table">
<caption><span class="timecard__title"><span>Order ${CARD.id} · ${esc(CARD.day)}</span> <span class="tag tag--solid">HOUSE</span></span></caption>
<thead><tr><th scope="col">When (UTC)</th><th scope="col">Block</th><th scope="col">Step</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr class="timecard__total"><th scope="row">Total</th><td class="timecard__sum">${esc(CARD.total)}</td><td class="timecard__stampcell"></td></tr></tfoot>
</table><img class="x-card-stamp" src="/web/brand/stamps/${stamp}" alt=""></div>`;
}

// ---- The Recorder, from brand/recorder.svg ---------------------------------------------------------

/** What is inside a brand file's <svg>, without its comments and title, to draw inline. */
function svgBody(name) {
  const file = readFileSync(join(BRAND, name), "utf8");
  return file
    .slice(file.indexOf(">", file.indexOf("<svg")) + 1, file.lastIndexOf("</svg>"))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title[\s\S]*?<\/title>/, "");
}

/** The file's drawing split as the page splits it: the rear, and the brass throat lip in front of the card. */
function recorderParts(edition) {
  const name = edition === "night" ? "recorder-night.svg" : "recorder.svg";
  const viewBox = /viewBox="([^"]+)"/.exec(readFileSync(join(BRAND, name), "utf8"))[1];
  const body = svgBody(name);
  const cut = body.indexOf('<defs><clipPath id="rc-lipshade">');
  if (cut < 0) throw new Error("recorder.svg has no throat lip where this script expects it");
  return { viewBox, rear: body.slice(0, cut), front: body.slice(cut) };
}

/** The dial's centre in the drawing's units: the bezel's centre in its own plane, projected. */
function dialCentre() {
  const [a, b, c, d, e, f] = planeMatrix(BEZEL.at[2], 0);
  const x = BEZEL.at[0] * 1000;
  const y = -BEZEL.at[1] * 1000;
  return {
    cx: a * x + c * y + e * 1000,
    cy: b * x + d * y + f * 1000,
    r: (BEZEL.radius + BEZEL.tube) * 1000,
  };
}

// ---- The pages -----------------------------------------------------------------------------------

const FONTS = `
@font-face { font-family: "Source Serif 4 Variable"; font-style: normal; font-weight: 200 900;
  src: url(/web/node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2) format("woff2-variations"); }
@font-face { font-family: "Source Serif 4 Variable"; font-style: italic; font-weight: 200 900;
  src: url(/web/node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-italic.woff2) format("woff2-variations"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 400;
  src: url(/web/node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2) format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 600;
  src: url(/web/node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2) format("woff2"); }
@font-face { font-family: "Alfa Slab One"; font-style: normal; font-weight: 400;
  src: url(/web/node_modules/@fontsource/alfa-slab-one/files/alfa-slab-one-latin-400-normal.woff2) format("woff2"); }`;

function page({ width, height, edition = "day", css, body }) {
  return `<!doctype html>
<html lang="en" data-theme="${edition === "night" ? "dark" : "light"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}">
<link rel="stylesheet" href="/web/src/styles/global.css">
<link rel="stylesheet" href="/web/src/styles/timecard.css">
<style>${FONTS}
html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; background: var(--newsprint); }
${css}
</style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * The HW mark, as brand/mark.svg draws it, centred on Newsprint. Its frame is a rounded square; the
 * point of it farthest from the centre is on a corner's arc, at (h - r) * sqrt 2 + r for a half-side
 * h and a corner radius r (in mark.svg, h = 240 and r = 48 of 512). That point is put at MARK_REACH of
 * the circle's radius.
 */
const MARK_REACH = 0.9;
function avatarMarkPage() {
  const S = 400;
  const reach = ((240 - 48) * Math.SQRT2 + 48) / 512; // of the image's width
  const w = Math.round(((S / 2) * MARK_REACH) / reach);
  // Inline, flat, as the file draws it (an <img> of the file can show a seam where Chrome tiles it).
  // The site's worn-ink filter was tried: at this size its grain reads as noise, it softens the mark
  // at 48 px and X's recompression would smear it.
  return page({
    width: S,
    height: S,
    css: `body { display: grid; place-items: center; }
.x-mark { display: block; width: ${w}px; height: ${w}px; }`,
    body: `<svg class="x-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" aria-hidden="true">${svgBody("mark.svg").replace(/<rect width="512" height="512"[^>]*\/>/, "")}</svg>`,
  });
}

/** The dial filling the circle: the bezel's outer edge at DIAL_REACH of the radius, the case's enamel round it. */
const DIAL_REACH = 0.93;
function avatarClockPage() {
  const S = 400;
  const { cx, cy, r } = dialCentre();
  const half = r / DIAL_REACH;
  const { rear, front } = recorderParts("day");
  const vb = `${(cx - half).toFixed(1)} ${(cy - half).toFixed(1)} ${(2 * half).toFixed(1)} ${(2 * half).toFixed(1)}`;
  return page({
    width: S,
    height: S,
    css: `body { background: var(--enamel); }
svg { display: block; width: ${S}px; height: ${S}px; }`,
    body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" aria-hidden="true">${rear}${front}</svg>`,
  });
}

/**
 * The banner. The Recorder is laid out as clockin.css lays it out on the front page (one unit is the
 * case's width, the card 0.8 of it; the card stands in the throat and the lip covers its lower edge),
 * at the desktop card width (22rem), then scaled as a whole, as og-card.astro does.
 */
const BANNER = {
  width: 1500,
  height: 500,
  /** The scale of the whole Recorder (the site's desktop size is 1). */
  scale: 0.39,
  /**
   * Where the Recorder's box sits, in banner pixels. The card's top edge is at 80 and the sign's
   * frame ends at 421, inside the middle 360; the knob ends 96 px from the right edge, as the words
   * start 96 px from the left.
   */
  stageLeft: 1159,
  stageTop: 80,
  /** The words: the headline's capitals stand at 79, level with the card's top edge. */
  wordsLeft: 96,
  wordsTop: 64,
  wordsWidth: 860,
  headline: 90,
  tagline: 31,
};

function bannerPage(edition) {
  const { viewBox, rear, front } = recorderParts(edition);
  const b = BANNER;
  return page({
    width: b.width,
    height: b.height,
    edition,
    css: `
.x-words { position: absolute; left: ${b.wordsLeft}px; top: ${b.wordsTop}px; width: ${b.wordsWidth}px; }
.x-headline { font-family: var(--serif); font-size: ${b.headline}px; font-weight: 900; line-height: 0.98;
  letter-spacing: -0.022em; margin: 0; max-width: none; text-wrap: balance; color: var(--enamel);
  font-variant-numeric: lining-nums; }
.x-tagline { font-family: var(--serif); font-style: italic; font-size: ${b.tagline}px; line-height: 1.22;
  color: var(--carbon); margin: 0.6em 0 0; max-width: none; }

.x-stage { position: absolute; left: ${b.stageLeft}px; top: ${b.stageTop}px; transform-origin: 0 0;
  transform: scale(${b.scale}); font-size: 16px; }
.recorder { --card-w: 22rem; --u: calc(var(--card-w) / 0.8); display: grid;
  grid-template-columns: calc(var(--u) * 0.14) var(--card-w) calc(var(--u) * 0.55);
  grid-template-rows: auto calc(var(--u) * 0.0566) calc(var(--u) * 1.4034);
  width: calc(var(--u) * 1.49); isolation: isolate; }
.recorder__rear, .recorder__front { grid-column: 1 / -1; grid-row: 2 / 4; display: block; width: 100%; height: 100%; }
.recorder__rear { z-index: 0; }
.recorder__card { grid-column: 2; grid-row: 1 / 3; align-self: end; z-index: 1; min-width: 0;
  transform-origin: 50% 100%; }
.recorder__front { z-index: 2; }
.recorder__card .timecard { position: relative; padding-bottom: calc(var(--u) * 0.05 + 3.9rem); }
/* The share card's stamp, struck large under the total, centred between the total's rule and the
   lip (the lip's top edge is 0.0206 of a unit above the card's foot). The file is 304 by 70 with the
   stamp, 46.4 tall, turned -3 degrees about its centre. */
.x-card-stamp { position: absolute; left: calc(50% + 0.1rem); transform: translateX(-50%);
  bottom: calc(var(--u) * 0.0353 - 0.15rem); height: 4.2rem; width: auto; }
`,
    body: `<div class="x-words"><h1 class="x-headline">HELP WANTED makes the pay wait.</h1>
<p class="x-tagline">The job board where the employers are smart contracts.</p></div>
<div class="x-stage"><div class="recorder">
<svg class="recorder__rear" xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${rear}</svg>
<div class="recorder__card">${timeCard(edition)}</div>
<svg class="recorder__front" xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${front}</svg>
</div></div>`,
  });
}

// ---- Playwright ----------------------------------------------------------------------------------

async function loadPlaywright() {
  if (process.env.IMD_PLAYWRIGHT) return import(pathToFileURL(process.env.IMD_PLAYWRIGHT).href);
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return await import(name);
    } catch {
      // not installed here
    }
  }
  const cache = join(homedir(), ".npm", "_npx");
  const dirs = existsSync(cache)
    ? readdirSync(cache)
        .map((dir) => ({ dir, at: statSync(join(cache, dir)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
    : [];
  for (const { dir } of dirs) {
    for (const name of ["playwright", "playwright-core"]) {
      const entry = join(cache, dir, "node_modules", name, "index.mjs");
      if (existsSync(entry)) return import(pathToFileURL(entry).href);
    }
  }
  throw new Error(
    "Playwright is not installed where this script can find it; set IMD_PLAYWRIGHT to its index.mjs.",
  );
}

const ORIGIN = "http://brand.social.invalid";
const TYPES = {
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".webp": "image/webp",
  ".html": "text/html",
};

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch());

/** The pages by name, served with the files under apps/web from one made-up origin (so the fonts load). */
const pages = new Map();
async function serve(context) {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pages.has(path)) return route.fulfill({ body: pages.get(path), contentType: "text/html" });
    if (path.startsWith("/web/")) {
      const file = resolve(WEB, path.slice(5));
      if (file.startsWith(WEB) && existsSync(file)) {
        return route.fulfill({
          body: readFileSync(file),
          contentType: TYPES[extname(file)] ?? "application/octet-stream",
        });
      }
    }
    console.error(`  not found: ${path}`);
    return route.fulfill({ status: 404, body: "" });
  });
}

/** One photograph of a page, at its CSS size times `scale`. */
async function shoot(name, html, width, height, scale) {
  pages.set(`/${name}.html`, html);
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  await serve(context);
  const tab = await context.newPage();
  tab.on("pageerror", (e) => console.error(`  page error: ${e.message}`));
  await tab.goto(`${ORIGIN}/${name}.html`, { waitUntil: "load" });
  const fonts = await tab.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.style}`);
  });
  const boxes = await tab.evaluate(() =>
    Object.fromEntries(
      [".x-headline", ".x-tagline", ".recorder", ".timecard", ".x-card-stamp", ".recorder__rear"]
        .map((s) => [s, document.querySelector(s)?.getBoundingClientRect()])
        .filter(([, r]) => r)
        .map(([s, r]) => [s, [r.left, r.top, r.right, r.bottom].map(Math.round)]),
    ),
  );
  const shot = await tab.screenshot({ clip: { x: 0, y: 0, width, height } });
  await context.close();
  return { shot, fonts, boxes };
}

const AVATAR_BUDGET = 1024 * 1024;
const BANNER_BUDGET = 2 * 1024 * 1024;

/** A PNG under its budget: full colour if it fits, else a 256-colour palette. */
async function encode(png, budget) {
  let out = await sharp(png).png({ compressionLevel: 9, effort: 10 }).toBuffer();
  if (out.length > budget)
    out = await sharp(png).png({ palette: true, colours: 256, dither: 0.5, effort: 10 }).toBuffer();
  if (out.length > budget) throw new Error(`a PNG is ${(out.length / 1024).toFixed(0)} kB, over its budget`);
  return out;
}

const made = {};
try {
  // Each page is photographed once at twice its size. The large file is that photograph; the small
  // one is made from it (lanczos3), which keeps the engraving's fine hatch from aliasing at 1x.
  const jobs = [
    { name: "x-avatar", html: avatarMarkPage(), w: 400, h: 400, big: "x-avatar-800", budget: AVATAR_BUDGET },
    {
      name: "x-avatar-clock",
      html: avatarClockPage(),
      w: 400,
      h: 400,
      big: "x-avatar-clock-800",
      budget: AVATAR_BUDGET,
    },
    {
      name: "x-banner",
      html: bannerPage("day"),
      w: 1500,
      h: 500,
      big: "x-banner-3000",
      budget: BANNER_BUDGET,
    },
    { name: "x-banner-night", html: bannerPage("night"), w: 1500, h: 500, big: null, budget: BANNER_BUDGET },
  ];
  for (const job of jobs.filter((j) => only.length === 0 || only.includes(j.name))) {
    const { shot, fonts, boxes } = await shoot(job.name, job.html, job.w, job.h, 2);
    if (job.name.startsWith("x-banner")) {
      console.log(`  ${job.name}: fonts ${fonts.join(", ") || "none"}`);
      console.log(`  ${job.name}: ${JSON.stringify(boxes)}`);
    }
    const small = await sharp(shot).resize(job.w, job.h, { kernel: "lanczos3" }).png().toBuffer();
    for (const [file, png] of [
      [job.name, small],
      [job.big, shot],
    ]) {
      if (!file) continue;
      const out = await encode(png, job.budget);
      write(join(OUT, `${file}.png`), out);
      made[file] = out;
    }
  }
} finally {
  await browser.close();
}

// ---- What to look at before uploading ------------------------------------------------------------

if (checkAt) {
  const dir = resolve(checkAt);
  const circle = (s) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}"/></svg>`,
    );
  /** The avatar as X shows it: a circle, at each size, on X's light and dark grounds. */
  async function avatarSheet(name) {
    const sizes = [400, 128, 48, 32];
    const tiles = [];
    for (const [g, ground] of [
      [0, "#ffffff"],
      [1, "#000000"],
    ]) {
      let x = 24;
      for (const s of sizes) {
        const round = await sharp(made[name])
          .resize(s, s, { kernel: "lanczos3" })
          .composite([{ input: circle(s), blend: "dest-in" }])
          .png()
          .toBuffer();
        tiles.push({ input: round, left: x, top: 24 + g * 448 + (400 - s) / 2 });
        x += s + 32;
      }
      tiles.unshift({
        input: { create: { width: 1000, height: 448, channels: 4, background: ground } },
        left: 0,
        top: g * 448,
      });
    }
    // The 48 px avatar blown up four times, square pixels, to see what it is made of.
    const small = await sharp(made[name]).resize(48, 48, { kernel: "lanczos3" }).png().toBuffer();
    const big = await sharp(small).resize(192, 192, { kernel: "nearest" }).png().toBuffer();
    tiles.push({ input: big, left: 760, top: 24 + 104 });
    const sheet = await sharp({ create: { width: 1000, height: 896, channels: 4, background: "#ffffff" } })
      .composite(tiles)
      .png()
      .toBuffer();
    write(join(dir, `${name}-check.png`), sheet);
    write(join(dir, `${name}-48.png`), small);
  }
  for (const name of ["x-avatar", "x-avatar-clock"]) if (made[name]) await avatarSheet(name);

  /** The banner under a stand-in avatar where X puts it, cropped to its middle, and at X's sizes. */
  async function bannerChecks(name) {
    const d = 335; // X's 134 px avatar on a 600 px header, at 1500
    const avatar = await sharp(made["x-avatar"])
      .resize(d - 16, d - 16)
      .composite([{ input: circle(d - 16), blend: "dest-in" }])
      .png()
      .toBuffer();
    const ring = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#ffffff"/></svg>`,
    );
    const withAvatar = await sharp({
      create: { width: 1500, height: 500 + Math.round(d / 2) + 40, channels: 4, background: "#ffffff" },
    })
      .composite([
        { input: made[name], left: 0, top: 0 },
        { input: ring, left: 40, top: 500 - Math.round(d / 2) },
        { input: avatar, left: 48, top: 500 - Math.round(d / 2) + 8 },
      ])
      .png()
      .toBuffer();
    write(join(dir, `${name}-avatar.png`), withAvatar);
    write(
      join(dir, `${name}-crop360.png`),
      await sharp(made[name]).extract({ left: 0, top: 70, width: 1500, height: 360 }).png().toBuffer(),
    );
    write(
      join(dir, `${name}-600.png`),
      await sharp(made[name]).resize(600, 200, { kernel: "lanczos3" }).png().toBuffer(),
    );
    write(
      join(dir, `${name}-390.png`),
      await sharp(made[name]).resize(390, 130, { kernel: "lanczos3" }).png().toBuffer(),
    );
    // The safe zones drawn over the banner.
    const zones = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500">
<rect x="0" y="0" width="1500" height="70" fill="#ff00ff" fill-opacity="0.18"/>
<rect x="0" y="430" width="1500" height="70" fill="#ff00ff" fill-opacity="0.18"/>
<rect x="0" y="340" width="400" height="160" fill="#00aaff" fill-opacity="0.25"/></svg>`);
    write(
      join(dir, `${name}-zones.png`),
      await sharp(made[name])
        .composite([{ input: zones }])
        .png()
        .toBuffer(),
    );
  }
  made["x-avatar"] ??= readFileSync(join(OUT, "x-avatar.png"));
  for (const name of ["x-banner", "x-banner-night"]) if (made[name]) await bannerChecks(name);
}
