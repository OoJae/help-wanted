/**
 * The brand kit's renders, taken from a running copy of the site:
 *
 *   brand/recorder.svg, recorder-night.svg   the Recorder's SVG twin at rest, as one standalone file
 *   brand/stills/recorder-*.webp, .png       the WebGL Recorder, printed by the live scene
 *   brand/stills/card-ejected.webp, .png     the share card's page at twice its size
 *
 * The stills need the development bench (/dev/recorder answers 404 in production) and a Chrome
 * with a GPU, driven by Playwright. Start the development server, then run this from the
 * repository root with the server's address:
 *
 *   pnpm --filter @help-wanted/web exec astro dev --port 4406
 *   node apps/web/scripts/brand-renders.mjs http://127.0.0.1:4406
 *
 * Add `recorder`, `stills` or `card` after the address to make only those. Playwright is found as
 * the design-critic probe finds it: the module named by IMD_PLAYWRIGHT, else an installed
 * `playwright`, else the newest copy in npx's cache. It drives the machine's Chrome (channel
 * "chrome"), which draws WebGL on the GPU.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FRAME, STRIKE_DOWN_MS, STRIKE_MS } from "../src/scripts/recorder/geometry.ts";
import {
  BRAND,
  FONT_FILES,
  importStore,
  n,
  openFont,
  outlineLine,
  readTokens,
  setLine,
  write,
} from "./brand-lib.mjs";

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? "").replace(/\/$/, "");
if (!base) {
  console.error(
    "Name the running site: node apps/web/scripts/brand-renders.mjs http://127.0.0.1:4406 [recorder|stills|card]",
  );
  process.exit(1);
}
const wanted = args.filter((a) => !a.startsWith("http"));
const want = (part) => wanted.length === 0 || wanted.includes(part);

const { day, night } = readTokens();
const slab = await openFont(FONT_FILES.slab);

// ---- The SVG twin, standalone ------------------------------------------------------------------

/**
 * The outline's width in drawing units. On the page it is 2.5 CSS px whatever the drawing's size
 * (vector-effect: non-scaling-stroke); a file that is scaled freely needs a width of its own, so it
 * takes the page's at the desktop card width (22rem, which draws the clock 655.6 px wide over the
 * frame's 1490 units).
 */
const EDGE_UNITS = 2.5 / (655.6 / (FRAME.width * 1000));

/** clockin.css's Recorder classes, as attributes, for one edition. At night the two inks swap. */
function paints(t, edgeUnits) {
  const dark = t === night ? t.newsprint : t.enamel;
  const light = t === night ? t.enamel : t.newsprint;
  return {
    "rc-enamel": `fill="${t.enamel}"`,
    "rc-brass": `fill="${t.brass}"`,
    "rc-paper": `fill="${t.newsprint}"`,
    "rc-dark": `fill="${dark}"`,
    "rc-light": `fill="${light}"`,
    "rc-edge": `fill="none" stroke="${dark}" stroke-width="${n(edgeUnits)}" stroke-linejoin="round"`,
    "rc-gleam": `fill="none" stroke="${light}" stroke-width="7" stroke-linecap="round"`,
    "rc-gleam rc-gleam--thin": `fill="none" stroke="${light}" stroke-width="4" stroke-linecap="round"`,
  };
}

/** The two drawings Recorder.astro sends (the rear, and the throat lip in front), as the server sent them. */
async function recorderMarkup() {
  const response = await fetch(`${base}/og-card`);
  if (!response.ok) throw new Error(`${base}/og-card answered ${response.status}`);
  const html = await response.text();
  const part = (cls) => {
    const at = html.indexOf(`<svg class="${cls}"`);
    if (at < 0) throw new Error(`the page has no ${cls}`);
    const open = html.indexOf(">", at) + 1;
    return html.slice(open, html.indexOf("</svg>", open));
  };
  const prefix = /<pattern id="([a-z0-9]+)-ink1"/.exec(html)?.[1] ?? "rc";
  const rename = (s) => s.replaceAll(`id="${prefix}-`, 'id="rc-').replaceAll(`url(#${prefix}-`, "url(#rc-");
  return { rear: rename(part("recorder__rear")), front: rename(part("recorder__front")) };
}

/** Recolours one drawing for an edition and sets the sign's lettering as outlines. */
function standalone(markup, t, edgeUnits) {
  const map = paints(t, edgeUnits);
  let out = markup
    .replace(/<(\w+)([^>]*?)\sclass="([^"]+)"([^>]*?)(\/?)>/g, (whole, tag, before, cls, after, close) => {
      const paint = map[cls];
      if (cls === "recorder__sign") return whole;
      if (!paint) throw new Error(`no paint for class "${cls}"`);
      return `<${tag}${before} ${paint}${after}${close}>`;
    })
    // The page script's hooks become ids, for anyone who animates the file: the lever and the hands.
    .replace(/\sdata-lever(?=[\s>])/g, ' id="rc-lever"')
    .replace(/\sdata-hand="(\w+)"/g, ' id="rc-hand-$1"')
    .replace(/\s(data-lip|aria-hidden="true"|focusable="false")(?=[\s>/])/g, "")
    .replace(/<\/(rect|circle|polygon|path)>/g, "")
    .replace(/<(rect|circle|polygon|path)([^>]*?)>/g, "<$1$2/>")
    .replace(/\/\/>/g, "/>");
  // The sign: Alfa Slab One at +0.01em, kerned, stretched to the lettering's width about its centre
  // (lengthAdjust="spacingAndGlyphs"), as the browser sets the <text> on the page. Chrome counts the
  // letter-spacing after the last letter in the length it stretches, so it is counted here too.
  out = out.replace(/<text class="recorder__sign"([^>]*)>([^<]*)<\/text\s*>/, (_, attrs, text) => {
    const get = (name) => Number(new RegExp(`\\s${name}="([^"]+)"`).exec(attrs)[1]);
    const size = get("font-size");
    const width = get("textLength");
    const natural =
      ((setLine(slab, text, { tracking: 0.01 }).width + 0.01 * slab.unitsPerEm) * size) / slab.unitsPerEm;
    const { d } = outlineLine(slab, text, {
      size,
      x: get("x") - width / 2,
      y: get("y"),
      tracking: 0.01,
      stretch: width / natural,
      digits: 1,
    });
    return `<path fill="${t.newsprint}" d="${d}"/>`;
  });
  return out
    .replace(/>\s+</g, "><")
    .replace(/<!--\s*/g, "\n<!-- ")
    .replace(/\s*-->/g, " -->\n");
}

const view = `${n(FRAME.x * 1000)} ${n(FRAME.y * 1000)} ${n(FRAME.width * 1000)} ${n(FRAME.height * 1000)}`;

function recorderSvg(markup, t, edition) {
  const W = n(FRAME.width * 1000);
  const H = n(FRAME.height * 1000);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" width="${W}" height="${H}" role="img" aria-labelledby="title">`,
    `<!-- The Recorder at rest, ${edition} edition: the SVG twin that Recorder.astro draws from geometry.ts, hands at 10:37:35 (order 2 settled on proof), lever at rest, yaw 0. The rear drawing and then the brass throat lip, which on the page sits over the time card's lower edge. Colours are the tokens of tokens.css; the outline is ${n(EDGE_UNITS)} units, the page's 2.5 px at the desktop card width; the sign's lettering is Alfa Slab One (SIL Open Font License 1.1) as outlines. Made by apps/web/scripts/brand-renders.mjs from the server's own markup. -->`,
    `<title id="title">The HELP WANTED time clock</title>`,
    standalone(markup.rear, t, EDGE_UNITS),
    standalone(markup.front, t, EDGE_UNITS),
    `</svg>`,
    "",
  ].join("\n");
}

let markup = null;
if (want("recorder") || want("stills")) markup = await recorderMarkup();
if (want("recorder")) {
  write(join(BRAND, "recorder.svg"), recorderSvg(markup, day, "day"));
  write(join(BRAND, "recorder-night.svg"), recorderSvg(markup, night, "night"));
}

// ---- Stills from the live scene ------------------------------------------------------------------

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

/** UTC seconds of the day. */
const at = (hh, mm, ss) => hh * 3600 + mm * 60 + ss;

/**
 * The poses: at rest when order 2 settled on proof (10:37:35), and mid-strike at the order's first
 * punch (10:28:47, the load moment), with the lever at the bottom of its stroke (90 of 470 ms).
 */
const POSES = [
  { name: "rest", t: at(10, 37, 35), lever: 0 },
  { name: "strike", t: at(10, 28, 47), lever: STRIKE_DOWN_MS / STRIKE_MS },
];
/** 800 CSS px at a device pixel ratio of 2: 1600 px wide, with the hatch at the page's own 6 device px. */
const CSS_WIDTH = 800;
const DPR = 2;
const BUDGET = 300 * 1024;

const sharp = want("stills") || want("card") ? (await importStore("sharp")).default : null;

/** Lossless WebP and a PNG, each under the budget (the PNG reduced to a palette if it must be). */
async function encode(png, name) {
  const webp = await sharp(png).webp({ lossless: true, effort: 6 }).toBuffer();
  let out = await sharp(png).png({ compressionLevel: 9, effort: 10 }).toBuffer();
  if (out.length > BUDGET)
    out = await sharp(png).png({ palette: true, colours: 256, dither: 0, effort: 10 }).toBuffer();
  for (const [ext, data] of [
    ["webp", webp],
    ["png", out],
  ]) {
    if (data.length > BUDGET)
      console.warn(`  ${name}.${ext} is ${(data.length / 1024).toFixed(1)} kB, over 300 kB`);
    write(join(BRAND, "stills", `${name}.${ext}`), data);
  }
}

if (want("stills") || want("card")) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    if (want("stills")) {
      const context = await browser.newContext({
        viewport: { width: 1000, height: 1000 },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => console.error(`  page error: ${e.message}`));
      for (const edition of ["day", "night"]) {
        const t = edition === "night" ? night : day;
        for (const pose of POSES) {
          const url = `${base}/dev/recorder?t=${pose.t}&yaw=0&lever=${pose.lever.toFixed(4)}&edition=${edition}&still=1&w=${CSS_WIDTH}&dpr=${DPR}`;
          await page.goto(url, { waitUntil: "load" });
          await page.waitForFunction(() => document.documentElement.dataset.bench, null, { timeout: 30_000 });
          const state = await page.evaluate(() => {
            const gl = document.createElement("canvas").getContext("webgl2");
            const info = gl?.getExtension("WEBGL_debug_renderer_info");
            return {
              bench: document.documentElement.dataset.bench,
              still: window.__still ?? null,
              gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown",
            };
          });
          if (state.bench !== "ready" || !state.still) throw new Error(`the bench did not draw ${url}`);
          const canvas = Buffer.from(state.still.split(",")[1], "base64");
          const { width, height } = await sharp(canvas).metadata();
          // The canvas draws the rear parts only; the page lays the SVG throat lip over the card. The
          // still has no card, so the lip is laid straight over the clock, at the page's outline width.
          const edge = (2.5 * DPR * FRAME.width * 1000) / width;
          const defs = /<defs>[\s\S]*?<\/defs>/.exec(standalone(markup.rear, t, edge))[0];
          const lip = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet">${defs}${standalone(markup.front, t, edge)}</svg>`;
          const still = await sharp(canvas)
            .composite([{ input: Buffer.from(lip), top: 0, left: 0 }])
            .png()
            .toBuffer();
          console.log(`  ${edition} ${pose.name}: ${width} x ${height} on ${state.gpu}`);
          await encode(still, `recorder-${pose.name}-${edition}`);
        }
      }
      await context.close();
    }
    if (want("card")) {
      const context = await browser.newContext({
        viewport: { width: 1200, height: 630 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(`${base}/og-card`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready.then(() => true));
      const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } });
      await encode(shot, "card-ejected");
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
