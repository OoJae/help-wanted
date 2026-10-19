/**
 * What the brand scripts share: where things are, the tokens as tokens.css defines them, the two
 * faces read from the self-hosted font files, and text set as outlines.
 *
 * The scripts are run by hand (BRAND.md says when); nothing here is part of the site's build. The
 * packages they need that are not the site's own dependencies (fontkitten, which reads the font
 * files, and sharp) are taken from the workspace's pnpm store, where Astro already installs them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** apps/web, the brand folder and the repository root. */
export const WEB = fileURLToPath(new URL("..", import.meta.url));
export const BRAND = join(WEB, "brand");
export const REPO = join(WEB, "..", "..");

/** The self-hosted font files the site serves (latin subsets). */
export const FONT_FILES = {
  slab: join(WEB, "node_modules/@fontsource/alfa-slab-one/files/alfa-slab-one-latin-400-normal.woff2"),
  mono600: join(WEB, "node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2"),
};

/** The folder of a package in the workspace's pnpm store, newest version first. */
export function storePackage(name) {
  const store = join(REPO, "node_modules", ".pnpm");
  const prefix = `${name.replace("/", "+")}@`;
  const found = existsSync(store)
    ? readdirSync(store)
        .filter((dir) => dir.startsWith(prefix))
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    : [];
  for (const dir of found) {
    const path = join(store, dir, "node_modules", name);
    if (existsSync(join(path, "package.json"))) return path;
  }
  throw new Error(
    `${name} is not in node_modules/.pnpm: run pnpm install --frozen-lockfile at the repository root.`,
  );
}

/** Imports a package from the pnpm store by its own entry point. */
export async function importStore(name) {
  const dir = storePackage(name);
  const require = createRequire(join(dir, "package.json"));
  return import(pathToFileURL(require.resolve(name)).href);
}

/** Writes a file under apps/web, making its folder, and says what it wrote. */
export function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  console.log(`${relative(WEB, path)}  ${(size / 1024).toFixed(1)} kB`);
}

// ---- Tokens -------------------------------------------------------------------------------------

function hex(value) {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  return null;
}

function declarations(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    const value = hex(m[2]);
    if (value) out[m[1]] = value;
  }
  return out;
}

/**
 * The colour tokens of both editions, read from tokens.css: the day edition from the first `:root`
 * block, the night edition from the `:root[data-theme="dark"]` block laid over it (Brass is the same
 * in both, so the night block does not repeat it).
 */
export function readTokens() {
  const css = readFileSync(join(WEB, "src/styles/tokens.css"), "utf8");
  const day = declarations(css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {"))));
  const at = css.indexOf(':root[data-theme="dark"] {');
  const night = { ...day, ...declarations(css.slice(at, css.indexOf("}", at))) };
  return { day, night };
}

/** WCAG 2 relative luminance and contrast ratio of two hex colours. */
export function contrast(a, b) {
  const lum = (h) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---- Faces --------------------------------------------------------------------------------------

/** Opens a font file with fontkitten (WOFF2 included). */
export async function openFont(file) {
  const { create } = await importStore("fontkitten");
  const font = create(readFileSync(file));
  // Reading any table unpacks a WOFF2, which sets every table's offset in the unpacked data.
  void font.unitsPerEm;
  return font;
}

/**
 * The font's pair kerning (GPOS lookups of the `kern` feature, pair adjustment, formats 1 and 2,
 * directly or through an extension lookup), as a function of two glyph ids returning the change in
 * the first glyph's advance, in font units. This is what a browser applies by default.
 */
export function pairKerning(font) {
  const stream = font._getTableStream("GPOS");
  if (!stream) return () => 0;
  const bytes = stream.buffer;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = stream.pos;
  const u16 = (at) => view.getUint16(at);
  const i16 = (at) => view.getInt16(at);
  const u32 = (at) => view.getUint32(at);
  const bits = (n) => {
    let c = 0;
    for (let v = n; v; v >>= 1) c += v & 1;
    return c;
  };

  const featureList = base + u16(base + 6);
  const lookupList = base + u16(base + 8);
  const kernLookups = new Set();
  for (let i = 0, n = u16(featureList); i < n; i++) {
    const record = featureList + 2 + i * 6;
    const tag = String.fromCharCode(...[0, 1, 2, 3].map((k) => view.getUint8(record + k)));
    if (tag !== "kern") continue;
    const feature = featureList + u16(record + 4);
    for (let k = 0, m = u16(feature + 2); k < m; k++) kernLookups.add(u16(feature + 4 + k * 2));
  }

  const coverageIndex = (table, glyph) => {
    const format = u16(table);
    if (format === 1) {
      for (let i = 0, n = u16(table + 2); i < n; i++) if (u16(table + 4 + i * 2) === glyph) return i;
    } else if (format === 2) {
      for (let i = 0, n = u16(table + 2); i < n; i++) {
        const r = table + 4 + i * 6;
        if (glyph >= u16(r) && glyph <= u16(r + 2)) return u16(r + 4) + glyph - u16(r);
      }
    }
    return -1;
  };
  const classOf = (table, glyph) => {
    const format = u16(table);
    if (format === 1) {
      const start = u16(table + 2);
      const n = u16(table + 4);
      return glyph >= start && glyph < start + n ? u16(table + 6 + (glyph - start) * 2) : 0;
    }
    if (format === 2) {
      for (let i = 0, n = u16(table + 2); i < n; i++) {
        const r = table + 4 + i * 6;
        if (glyph >= u16(r) && glyph <= u16(r + 2)) return u16(r + 4);
      }
    }
    return 0;
  };
  // XAdvance is the third field a value record may hold; it is present when bit 0x0004 is set.
  const xAdvance = (record, format) => (format & 4 ? i16(record + bits(format & 3) * 2) : 0);

  /** One pair-adjustment subtable: the first glyph's advance change, or null when it does not apply. */
  const pairPos = (sub, left, right) => {
    const format = u16(sub);
    const index = coverageIndex(sub + u16(sub + 2), left);
    if (index < 0) return null;
    const f1 = u16(sub + 4);
    const f2 = u16(sub + 6);
    const size1 = bits(f1) * 2;
    const size2 = bits(f2) * 2;
    if (format === 1) {
      const set = sub + u16(sub + 10 + index * 2);
      for (let i = 0, n = u16(set); i < n; i++) {
        const record = set + 2 + i * (2 + size1 + size2);
        if (u16(record) === right) return xAdvance(record + 2, f1);
      }
      return null;
    }
    if (format === 2) {
      const c1 = classOf(sub + u16(sub + 8), left);
      const c2 = classOf(sub + u16(sub + 10), right);
      const class2Count = u16(sub + 14);
      const record = sub + 16 + (c1 * class2Count + c2) * (size1 + size2);
      return xAdvance(record, f1);
    }
    return null;
  };

  return (left, right) => {
    let total = 0;
    for (const index of [...kernLookups].sort((a, b) => a - b)) {
      const lookup = lookupList + u16(lookupList + 2 + index * 2);
      const type = u16(lookup);
      for (let s = 0, n = u16(lookup + 4); s < n; s++) {
        let sub = lookup + u16(lookup + 6 + s * 2);
        let subType = type;
        if (type === 9) {
          subType = u16(sub + 2);
          sub += u32(sub + 4);
        }
        if (subType !== 2) continue;
        const value = pairPos(sub, left, right);
        if (value !== null) {
          total += value;
          break;
        }
      }
    }
    return total;
  };
}

/**
 * Sets a line of text in a font: each glyph with its pen position in font units, kerned, with
 * `tracking` (in em) added between letters as CSS letter-spacing adds it. `width` is the advance of
 * the whole line without spacing after the last letter.
 */
export function setLine(font, text, { tracking = 0, kern = true } = {}) {
  const kerning = kern ? pairKerning(font) : () => 0;
  const glyphs = [...text].map((c) => font.glyphForCodePoint(c.codePointAt(0)));
  const spacing = tracking * font.unitsPerEm;
  let pen = 0;
  const placed = glyphs.map((glyph, i) => {
    const at = pen;
    pen += glyph.advanceWidth + (i < glyphs.length - 1 ? kerning(glyph.id, glyphs[i + 1].id) + spacing : 0);
    return { glyph, x: at };
  });
  return { glyphs: placed, width: pen };
}

const num = (v, digits) => {
  const r = Number(v.toFixed(digits));
  return Object.is(r, -0) ? "0" : String(r);
};

/** A glyph outline as SVG path data, every point passed through `map` (font units in, drawing units out). */
export function glyphPath(glyph, map, digits = 2) {
  let d = "";
  for (const { command, args } of glyph.path.commands) {
    const pts = [];
    for (let i = 0; i < args.length; i += 2) pts.push(map(args[i], args[i + 1]));
    const flat = pts
      .flat()
      .map((v) => num(v, digits))
      .join(" ");
    if (command === "moveTo") d += `M${flat}`;
    else if (command === "lineTo") d += `L${flat}`;
    else if (command === "quadraticCurveTo") d += `Q${flat}`;
    else if (command === "bezierCurveTo") d += `C${flat}`;
    else if (command === "closePath") d += "Z";
  }
  return d;
}

/**
 * A line of text as one SVG path. `size` is the font size in drawing units, (`x`, `y`) the left end
 * of the baseline, and `stretch` scales the line horizontally about that point (as SVG's
 * lengthAdjust="spacingAndGlyphs" does). Returns the path data and the line's width as drawn.
 */
export function outlineLine(font, text, { size, x = 0, y = 0, tracking = 0, stretch = 1, digits = 2 }) {
  const line = setLine(font, text, { tracking });
  const s = size / font.unitsPerEm;
  const d = line.glyphs
    .map(({ glyph, x: pen }) =>
      glyphPath(glyph, (gx, gy) => [x + (pen + gx) * s * stretch, y - gy * s], digits),
    )
    .join("");
  return { d, width: line.width * s * stretch, natural: line.width * s };
}

/** The exact box of a set of glyph paths in font units, for a line set with `setLine`. */
export function lineInk(line) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { glyph, x } of line.glyphs) {
    const b = glyph.path.bbox;
    if (!Number.isFinite(b.minX)) continue;
    minX = Math.min(minX, x + b.minX);
    maxX = Math.max(maxX, x + b.maxX);
    minY = Math.min(minY, b.minY);
    maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}

/** Rounds a number for an SVG attribute. */
export function n(v, digits = 2) {
  return num(v, digits);
}
