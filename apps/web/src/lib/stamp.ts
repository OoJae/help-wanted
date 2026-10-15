/**
 * The rubber stamp, drawn as a small SVG.
 *
 * A stamp is artwork, not running text: a frame, a few capital letters, a slight turn and worn ink.
 * Drawing it as SVG keeps its proportions exact at every size and lets the same picture be made on
 * the server (in the page as sent, so it is there without JavaScript) and in the browser (when the
 * visitor's own check finishes). The words are still plain text inside the SVG, so a reader of the
 * raw HTML finds "PROVEN ON CHAIN" where a person sees the stamp.
 *
 * The lettering is the monospace face, in which every capital is equally wide, so the width of a
 * stamp follows from the number of letters and no measuring is needed.
 */

/** Which ink and frame. `proof` is the only red one: it marks a check against the chain that passed. */
export type StampInk = "proof" | "filled" | "void";

export type StampSize = "card" | "mid" | "big";

const FONT = 20;
/** One monospace capital with its share of letter-spacing, in the SVG's own units. */
const ADVANCE = FONT * 0.6 + FONT * 0.14;
const PAD_X: Record<StampInk, number> = { proof: 17, filled: 13, void: 13 };
const HEIGHT = 40;

export interface StampBox {
  width: number;
  height: number;
  /** How wide the lettering is made, whatever font the browser ends up with. */
  textWidth: number;
}

export function stampBox(text: string, ink: StampInk): StampBox {
  const letters = Math.max(1, [...text].length);
  const textWidth = Math.round(letters * ADVANCE - FONT * 0.14);
  return { width: textWidth + PAD_X[ink] * 2, height: HEIGHT, textWidth };
}

/**
 * The stamp's proportions, handed to the stylesheet. A stamp is sized by the height of its
 * lettering, so two stamps with different words carry letters of one size; `--r` lets the
 * stylesheet work the width out and shrink the whole stamp where a column is narrower than that.
 */
export function stampStyle(text: string, ink: StampInk): string {
  const { width, height } = stampBox(text, ink);
  return `--r:${(width / height).toFixed(3)}`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface StampOptions {
  ink: StampInk;
  size?: StampSize;
  /** Turned the other way, for a second stamp beside the first. */
  tilt?: boolean;
  /** Plays the landing once when the stamp is put on the page (the browser's own check). */
  fresh?: boolean;
}

/** The frame and lettering of a stamp, as the children of an `<svg>`. */
export function stampInner(text: string, ink: StampInk): string {
  const { width, height, textWidth } = stampBox(text, ink);
  const frame =
    ink === "void"
      ? `<rect x="1.5" y="1.5" width="${width - 3}" height="${height - 3}" rx="3" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="6 3.5"/>`
      : `<rect x="2" y="2" width="${width - 4}" height="${height - 4}" rx="3.5" fill="none" stroke="currentColor" stroke-width="3.2"/>`;
  const inner =
    ink === "proof"
      ? `<rect x="6.6" y="6.6" width="${width - 13.2}" height="${height - 13.2}" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.1"/>`
      : "";
  return (
    frame +
    inner +
    `<text x="${width / 2}" y="${height / 2 + 7}" text-anchor="middle" textLength="${textWidth}" lengthAdjust="spacing" fill="currentColor" font-size="${FONT}" font-weight="600">${escapeXml(text)}</text>`
  );
}

export function stampClass(options: StampOptions): string {
  return [
    "stamp",
    `stamp--${options.ink}`,
    options.size && options.size !== "card" ? `stamp--${options.size}` : "",
    options.tilt ? "stamp--tilt" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** A whole stamp as an SVG string, for the browser script (which has no Astro component). */
export function stampSvg(text: string, options: StampOptions): string {
  const { width, height } = stampBox(text, options.ink);
  return (
    `<svg class="${stampClass(options)}" viewBox="0 0 ${width} ${height}" style="${stampStyle(text, options.ink)}" role="img" aria-label="Stamped: ${escapeXml(text)}"${options.fresh ? " data-fresh" : ""}>` +
    stampInner(text, options.ink) +
    "</svg>"
  );
}

/** A status that is still moving ("AT WORK", "DELIVERY CLAIMED") is set in type, in sentence case. */
export function sentenceCase(text: string): string {
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Which ink a receipt check's verdict is stamped in. Red is for the one verdict that is a proof;
 * a mismatch is stamped in black, and the two "nothing proven" verdicts in grey.
 */
export const VERDICT_INK: Record<"proven" | "no_receipt" | "mismatch" | "unchecked", StampInk> = {
  proven: "proof",
  mismatch: "filled",
  no_receipt: "void",
  unchecked: "void",
};
