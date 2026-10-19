/**
 * The Recorder's geometry: every dimension of the front page's time clock, and the one projection
 * it is drawn with.
 *
 * Two renderers draw this clock and they must agree to the pixel, because the page crossfades from
 * one to the other: `Recorder.astro` draws an SVG on the server (in node) and the WebGL scene builds
 * meshes in the browser. Both read the numbers here, so this module is data and arithmetic only: no
 * DOM and no three.js.
 *
 * Units: one unit is the width of the case. Model space is right-handed with its origin at the
 * centre of the case: x to the right, y up, z toward the viewer. The front face is at z = 0.2, the
 * top face (where the throat is) at y = 0.68, the right flank (where the lever is) at x = 0.5.
 *
 * Projected space is what both renderers draw in: the same units, origin at the centre of the case,
 * x to the right and y DOWN, as SVG and CSS lay out a page. The camera is orthographic, like a
 * catalogue elevation. It looks at the front from 8 degrees above (a fixed pitch, so the top face
 * and its throat show as a thin strip), and the clock may turn about its upright axis by at most 6
 * degrees either way. A positive yaw turns the right flank, the lever's side, toward the viewer.
 *
 * Every angle in this module's interface is in degrees. A turning angle (a hand, the lever) is
 * clockwise as seen on screen, which is how SVG's and CSS's rotate() read it; in three.js the same
 * turn is a rotation about z by minus the angle, in radians.
 */

/** A point or a size in model space: [x, y, z], y up, z toward the viewer. */
export type Vec3 = readonly [x: number, y: number, z: number];

/** A point in projected space: [x, y], y down. */
export type Point = [x: number, y: number];

/** An affine map [a, b, c, d, e, f], in the order of SVG's and CSS's matrix(): (u, v) to (au + cv + e, bu + dv + f). */
export type Matrix2D = [a: number, b: number, c: number, d: number, e: number, f: number];

/** An upright rectangle in projected space: its top-left corner and its size. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The token (in tokens.css) whose colour a part takes; never a hex, so each edition recolours it. */
export type Material = "enamel" | "brass" | "newsprint" | "card";

/** A model-space axis: the one a cylinder runs along. */
export type Axis = "x" | "y" | "z";

/** The solid a part is made of, centred on the part's `at`. */
export type Shape =
  | { readonly kind: "roundedBox"; readonly size: Vec3; readonly radius: number; readonly segments: number }
  | { readonly kind: "box"; readonly size: Vec3 }
  | {
      readonly kind: "cylinder";
      readonly radius: number;
      readonly length: number;
      readonly axis: Axis;
      readonly segments: number;
    }
  | { readonly kind: "torus"; readonly radius: number; readonly tube: number; readonly segments: number }
  | { readonly kind: "sphere"; readonly radius: number }
  | ({ readonly kind: "ticks" } & TickSpec)
  | ({ readonly kind: "lettering" } & LetteringSpec);

/** The minute track: `count` bars round the dial, every `heavyEvery`th one a heavier hour bar. */
export interface TickSpec {
  readonly count: number;
  readonly heavyEvery: number;
  /** Distance from the dial's centre to the outer end of every bar. */
  readonly outer: number;
  readonly minor: { readonly length: number; readonly width: number };
  readonly major: { readonly length: number; readonly width: number };
  readonly thickness: number;
}

/** Words painted on a plate: set at `fontSize`, then stretched or squeezed to exactly `width`, so both renderers agree without measuring the font. */
export interface LetteringSpec {
  readonly text: string;
  readonly fontSize: number;
  readonly width: number;
  /** Letter-spacing in em, as the slab is set everywhere on the site. */
  readonly tracking: number;
}

/** The name both renderers key a part on. */
export type PartName =
  | "case"
  | "throatSlot"
  | "throatLip"
  | "dial"
  | "bezel"
  | "ticks"
  | "hourHand"
  | "minuteHand"
  | "secondHand"
  | "secondCounterweight"
  | "centreCap"
  | "signPlate"
  | "signLettering"
  | "signFrameTop"
  | "signFrameBottom"
  | "signFrameLeft"
  | "signFrameRight"
  | "leverHub"
  | "leverArm"
  | "leverKnob";

/** One piece of the clock: its solid, where it sits, what it is made of, and how it moves. */
export interface Part {
  readonly name: PartName;
  readonly shape: Shape;
  /** The centre of the shape in model space, in the part's zero pose (see `turns`). */
  readonly at: Vec3;
  readonly material: Material;
  /**
   * "rear" parts are drawn under the HTML card, "front" parts over it. Only the throat lip is in
   * front: it covers the card's lower edge, which is what seats the card in the clock.
   */
  readonly layer: "rear" | "front";
  /**
   * A moving part is modelled in a zero pose (a hand pointing at twelve, the lever's arm level and
   * pointing outward) and turned about an axis through `pivot`, parallel to z, by `rest` plus the
   * driver's angle, clockwise on screen. The driver is one of `handAngles` or `leverAngle`.
   */
  readonly turns?: {
    readonly by: "hour" | "minute" | "second" | "lever";
    readonly pivot: Vec3;
    readonly rest: number;
  };
}

/** The camera's pitch in degrees; negative looks down onto the top face. */
export const PITCH = -8;

/** How far the clock may turn either way, in degrees; every function here clamps yaw to it. */
export const MAX_YAW = 6;

/** The case: a rounded box in black enamel, one unit wide, with the faces it carries named. */
export const CASE = {
  size: [1, 1.36, 0.4],
  radius: 0.05,
  segments: 4,
  /** y of the top face, where the throat is. */
  top: 0.68,
  /** z of the front face, where the dial and the sign are. */
  front: 0.2,
  /** x of the right flank, where the lever is. */
  flank: 0.5,
} as const;

/**
 * The throat on the top face: a slot recessed into it, centred on it front to back, and a brass lip
 * standing along the slot's front edge.
 */
export const THROAT = {
  slot: { size: [0.84, 0.02, 0.06], at: [0, 0.67, 0] },
  lip: { size: [0.88, 0.025, 0.012], at: [0, 0.6925, 0.036] },
} as const;

/**
 * The time card stands upright in the slot's centre plane (z = 0), its lower edge on the top face.
 * The card itself is HTML; this is its width in units, which fixes how many CSS pixels a unit is.
 * Draw it with `planeMatrix(CARD.z, yaw)` about its lower-edge centre, which `project` puts at
 * [0, -CASE.top * cos(8 degrees)] whatever the yaw. Seen from the front, the card hides the back
 * half of the top face, so a WebGL scene must leave those pixels clear (a depth-only stand-in for the
 * card does it) for the HTML card behind the canvas to show through.
 */
export const CARD = { width: 0.8, z: 0, material: "card" } as const;

/** The dial: a disc of newsprint on the front face, facing the viewer; the hands turn about its centre. */
export const DIAL = { at: [0, 0.215, 0.204], radius: 0.34, thickness: 0.008, segments: 96 } as const;

/** The brass bezel: a torus round the dial, in the plane of its face. */
export const BEZEL = { at: [0, 0.215, 0.208], radius: 0.355, tube: 0.022, segments: 96 } as const;

/** The minute track: 60 enamel bars, the 12 hour bars heavier; no numerals, an industrial dial. */
export const TICKS: TickSpec & { readonly z: number } = {
  count: 60,
  heavyEvery: 5,
  outer: 0.318,
  minor: { length: 0.03, width: 0.007 },
  major: { length: 0.07, width: 0.02 },
  thickness: 0.002,
  z: 0.209,
};

/**
 * The hands, each a flat bar from `tail` behind the centre to `length` in front of it, stacked in
 * depth over the dial. The second hand is brass, with a counterweight disc on its tail side
 * (`offset` behind the centre) and a brass cap over the centre.
 */
export const HANDS = {
  hour: { length: 0.18, tail: 0.045, width: 0.036, thickness: 0.004, z: 0.212 },
  minute: { length: 0.285, tail: 0.05, width: 0.024, thickness: 0.004, z: 0.217 },
  second: { length: 0.3, tail: 0.09, width: 0.008, thickness: 0.003, z: 0.2215 },
  counterweight: { radius: 0.028, offset: 0.075, thickness: 0.003, z: 0.2215 },
  cap: { radius: 0.024, thickness: 0.006, z: 0.226 },
} as const;

/** The HELP WANTED sign on the case below the dial: an enamel plate with newsprint letters in a brass frame of four bars. */
export const SIGN = {
  plate: { size: [0.66, 0.12, 0.012], at: [0, -0.42, 0.206] },
  frame: { bar: 0.022, depth: 0.018, z: 0.209 },
  lettering: { text: "HELP WANTED", fontSize: 0.068, width: 0.56, tracking: 0.01, z: 0.2121 },
} as const;

/**
 * The punch lever on the right flank: a brass hub, a brass arm and an enamel knob at the arm's end.
 * At rest the arm points up and outward (`rest`, clockwise on screen, so negative is up); a strike
 * turns it `strike` degrees down and back.
 */
export const LEVER = {
  pivot: [0.535, 0.3, 0],
  hub: { radius: 0.04, length: 0.06 },
  arm: { radius: 0.018, length: 0.34 },
  knob: { radius: 0.05 },
  rest: -28,
  strike: 42,
} as const;

const DEG = Math.PI / 180;

function vec(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

const dialY = DIAL.at[1];
const { z: ticksZ, ...tickSpec } = TICKS;
const frameOuterX = SIGN.plate.size[0] / 2 + SIGN.frame.bar;
const frameOuterY = SIGN.plate.size[1] / 2 + SIGN.frame.bar;

function hand(which: "hour" | "minute" | "second", material: Material): Part {
  const h = HANDS[which];
  return {
    name: `${which}Hand`,
    shape: { kind: "box", size: [h.width, h.length + h.tail, h.thickness] },
    at: vec(0, dialY + (h.length - h.tail) / 2, h.z),
    material,
    layer: "rear",
    turns: { by: which, pivot: vec(0, dialY, h.z), rest: 0 },
  };
}

/** Every part of the clock, in the order a painter would lay them down (back to front). */
export const PARTS: readonly Part[] = [
  {
    name: "case",
    shape: { kind: "roundedBox", size: CASE.size, radius: CASE.radius, segments: CASE.segments },
    at: vec(0, 0, 0),
    material: "enamel",
    layer: "rear",
  },
  {
    name: "throatSlot",
    shape: { kind: "box", size: THROAT.slot.size },
    at: THROAT.slot.at,
    material: "enamel",
    layer: "rear",
  },
  {
    name: "throatLip",
    shape: { kind: "box", size: THROAT.lip.size },
    at: THROAT.lip.at,
    material: "brass",
    layer: "front",
  },
  {
    name: "dial",
    shape: {
      kind: "cylinder",
      radius: DIAL.radius,
      length: DIAL.thickness,
      axis: "z",
      segments: DIAL.segments,
    },
    at: DIAL.at,
    material: "newsprint",
    layer: "rear",
  },
  {
    name: "ticks",
    shape: { kind: "ticks", ...tickSpec },
    at: vec(0, dialY, ticksZ),
    material: "enamel",
    layer: "rear",
  },
  hand("hour", "enamel"),
  hand("minute", "enamel"),
  hand("second", "brass"),
  {
    name: "secondCounterweight",
    shape: {
      kind: "cylinder",
      radius: HANDS.counterweight.radius,
      length: HANDS.counterweight.thickness,
      axis: "z",
      segments: 24,
    },
    at: vec(0, dialY - HANDS.counterweight.offset, HANDS.counterweight.z),
    material: "brass",
    layer: "rear",
    turns: { by: "second", pivot: vec(0, dialY, HANDS.counterweight.z), rest: 0 },
  },
  {
    name: "centreCap",
    shape: {
      kind: "cylinder",
      radius: HANDS.cap.radius,
      length: HANDS.cap.thickness,
      axis: "z",
      segments: 24,
    },
    at: vec(0, dialY, HANDS.cap.z),
    material: "brass",
    layer: "rear",
  },
  {
    name: "bezel",
    shape: { kind: "torus", radius: BEZEL.radius, tube: BEZEL.tube, segments: BEZEL.segments },
    at: BEZEL.at,
    material: "brass",
    layer: "rear",
  },
  {
    name: "signPlate",
    shape: { kind: "box", size: SIGN.plate.size },
    at: SIGN.plate.at,
    material: "enamel",
    layer: "rear",
  },
  {
    name: "signLettering",
    shape: {
      kind: "lettering",
      text: SIGN.lettering.text,
      fontSize: SIGN.lettering.fontSize,
      width: SIGN.lettering.width,
      tracking: SIGN.lettering.tracking,
    },
    at: vec(SIGN.plate.at[0], SIGN.plate.at[1], SIGN.lettering.z),
    material: "newsprint",
    layer: "rear",
  },
  {
    name: "signFrameTop",
    shape: { kind: "box", size: [frameOuterX * 2, SIGN.frame.bar, SIGN.frame.depth] },
    at: vec(0, SIGN.plate.at[1] + frameOuterY - SIGN.frame.bar / 2, SIGN.frame.z),
    material: "brass",
    layer: "rear",
  },
  {
    name: "signFrameBottom",
    shape: { kind: "box", size: [frameOuterX * 2, SIGN.frame.bar, SIGN.frame.depth] },
    at: vec(0, SIGN.plate.at[1] - frameOuterY + SIGN.frame.bar / 2, SIGN.frame.z),
    material: "brass",
    layer: "rear",
  },
  {
    name: "signFrameLeft",
    shape: { kind: "box", size: [SIGN.frame.bar, SIGN.plate.size[1], SIGN.frame.depth] },
    at: vec(-frameOuterX + SIGN.frame.bar / 2, SIGN.plate.at[1], SIGN.frame.z),
    material: "brass",
    layer: "rear",
  },
  {
    name: "signFrameRight",
    shape: { kind: "box", size: [SIGN.frame.bar, SIGN.plate.size[1], SIGN.frame.depth] },
    at: vec(frameOuterX - SIGN.frame.bar / 2, SIGN.plate.at[1], SIGN.frame.z),
    material: "brass",
    layer: "rear",
  },
  {
    name: "leverHub",
    shape: { kind: "cylinder", radius: LEVER.hub.radius, length: LEVER.hub.length, axis: "z", segments: 24 },
    at: LEVER.pivot,
    material: "brass",
    layer: "rear",
  },
  {
    name: "leverArm",
    shape: { kind: "cylinder", radius: LEVER.arm.radius, length: LEVER.arm.length, axis: "x", segments: 12 },
    at: vec(LEVER.pivot[0] + LEVER.arm.length / 2, LEVER.pivot[1], LEVER.pivot[2]),
    material: "brass",
    layer: "rear",
    turns: { by: "lever", pivot: LEVER.pivot, rest: LEVER.rest },
  },
  {
    name: "leverKnob",
    shape: { kind: "sphere", radius: LEVER.knob.radius },
    at: vec(LEVER.pivot[0] + LEVER.arm.length, LEVER.pivot[1], LEVER.pivot[2]),
    material: "enamel",
    layer: "rear",
    turns: { by: "lever", pivot: LEVER.pivot, rest: LEVER.rest },
  },
];

/**
 * The part of projected space both renderers frame: the whole clock at any yaw and any lever angle,
 * with room for an outline. It is the SVG's viewBox; a three.js OrthographicCamera takes left = x,
 * right = x + width, top = -y, bottom = -(y + height), since three's y points up. The HTML card
 * stands above the frame's top edge, outside both drawings.
 */
export const FRAME: Readonly<Rect> = { x: -0.54, y: -0.73, width: 1.49, height: 1.46 };

/** Clamps a yaw in degrees to plus or minus MAX_YAW; anything that is not a number is 0. */
export function clampYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  return Math.min(MAX_YAW, Math.max(-MAX_YAW, yaw));
}

/** Projects a model-space point to projected space (y down) with the clock turned by `yaw` degrees. */
export function project(point: Vec3, yaw: number): Point {
  const t = clampYaw(yaw) * DEG;
  const p = -PITCH * DEG;
  const [x, y, z] = point;
  // Turn about the upright axis first (positive brings the right flank forward), then tip the top
  // toward the viewer by the pitch; an orthographic camera then drops depth.
  const x1 = x * Math.cos(t) - z * Math.sin(t);
  const z1 = x * Math.sin(t) + z * Math.cos(t);
  const y2 = y * Math.cos(p) - z1 * Math.sin(p);
  return [x1, -y2];
}

/**
 * The affine map from a plane parallel to the front face at depth `z` to projected space, for SVG's
 * transform="matrix(...)" or CSS's matrix() (scale e and f to pixels). The plane's own coordinates
 * are model x and minus model y, so a flat drawing made with y down lands where `project` puts it.
 */
export function planeMatrix(z: number, yaw: number): Matrix2D {
  const t = clampYaw(yaw) * DEG;
  const p = -PITCH * DEG;
  return [
    Math.cos(t),
    Math.sin(t) * Math.sin(p),
    0,
    Math.cos(p),
    -z * Math.sin(t),
    z * Math.cos(t) * Math.sin(p),
  ];
}

/**
 * The rotation [x, y, z] in radians, Euler order "XYZ" (three.js's default), that turns the clock's
 * group so that a default orthographic camera looking down -z sees exactly what `project` draws.
 */
export function viewRotation(yaw: number): [x: number, y: number, z: number] {
  return [-PITCH * DEG, -clampYaw(yaw) * DEG, 0];
}

function bounds(points: readonly Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** The convex hull of some points, without repeated or collinear vertices (Andrew's monotone chain). */
function hull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Point[] = [];
  const upper: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 1e-12) {
      lower.pop();
    }
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 1e-12) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function corners(at: Vec3, size: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        out.push([at[0] + (sx * size[0]) / 2, at[1] + (sy * size[1]) / 2, at[2] + (sz * size[2]) / 2]);
      }
    }
  }
  return out;
}

/** The silhouette of an unturned box (centre `at`, size `size`) in projected space: a convex polygon, clockwise on screen. */
export function boxOutline(at: Vec3, size: Vec3, yaw: number): Point[] {
  return hull(corners(at, size).map((c) => project(c, yaw)));
}

/**
 * The silhouette of the case in projected space, clockwise on screen. A rounded box is a smaller
 * box swept by a ball, and an orthographic camera draws a ball as a disc of the same radius, so the
 * outline is the smaller box's outline grown by the radius, its corners rounded in steps no wider
 * than a quarter turn divided by CASE.segments (the WebGL case's own facets).
 */
export function caseOutline(yaw: number): Point[] {
  const r = CASE.radius;
  const inner = vec(CASE.size[0] - 2 * r, CASE.size[1] - 2 * r, CASE.size[2] - 2 * r);
  const poly = boxOutline(vec(0, 0, 0), inner, yaw);
  const step = Math.PI / 2 / CASE.segments;
  const out: Point[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const prev = poly[(i + n - 1) % n]!;
    const here = poly[i]!;
    const next = poly[(i + 1) % n]!;
    // The hull runs with positive cross products, so the outward normal of an edge d is (d.y, -d.x).
    const from = Math.atan2(-(here[0] - prev[0]), here[1] - prev[1]);
    let to = Math.atan2(-(next[0] - here[0]), next[1] - here[1]);
    while (to < from) to += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil((to - from) / step - 1e-9));
    for (let k = 0; k <= steps; k++) {
      const a = from + ((to - from) * k) / steps;
      out.push([here[0] + r * Math.cos(a), here[1] + r * Math.sin(a)]);
    }
  }
  return out;
}

/** The opening of the card slot on the top face, as the upright rectangle that holds it in projected space. */
export function cardSlotRect(yaw: number): Rect {
  const { size, at } = THROAT.slot;
  const halfX = size[0] / 2;
  const halfZ = size[2] / 2;
  const opening: Vec3[] = [
    [at[0] - halfX, CASE.top, at[2] - halfZ],
    [at[0] + halfX, CASE.top, at[2] - halfZ],
    [at[0] + halfX, CASE.top, at[2] + halfZ],
    [at[0] - halfX, CASE.top, at[2] + halfZ],
  ];
  return bounds(opening.map((c) => project(c, yaw)));
}

/** The brass throat lip's silhouette in projected space, clockwise on screen: the shape that covers the card's lower edge. */
export function throatLipOutline(yaw: number): Point[] {
  return boxOutline(THROAT.lip.at, THROAT.lip.size, yaw);
}

/** The three hands' angles in degrees clockwise from twelve. */
export interface HandAngles {
  hour: number;
  minute: number;
  second: number;
}

/** The hands' angles for a time of day in UTC seconds (fractions sweep smoothly; any number wraps into one day). */
export function handAngles(utcSecondsOfDay: number): HandAngles {
  const day = 24 * 3600;
  const s = Number.isFinite(utcSecondsOfDay) ? ((utcSecondsOfDay % day) + day) % day : 0;
  return {
    hour: ((s % 43200) / 43200) * 360,
    minute: ((s % 3600) / 3600) * 360,
    second: ((s % 60) / 60) * 360,
  };
}

/**
 * The cubic Bezier easing CSS's cubic-bezier(x1, y1, x2, y2) draws, as a function of progress 0..1,
 * so a script's tween matches the same curve in tokens.css.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (x: number) => {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    // Newton's method converges in a few steps on these curves; bisection catches the rest.
    let u = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(u) - x;
      if (Math.abs(err) < 1e-7) return sampleY(u);
      const d = slopeX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      u = (lo + hi) / 2;
      if (sampleX(u) < x) lo = u;
      else hi = u;
    }
    return sampleY((lo + hi) / 2);
  };
}

/** The site's three curves, the same as --ease-out, --ease-io and --ease-stamp in tokens.css. */
export const EASE = {
  out: cubicBezier(0.16, 1, 0.3, 1),
  io: cubicBezier(0.65, 0, 0.35, 1),
  stamp: cubicBezier(0.2, 1.5, 0.4, 1),
} as const;

/** How long the lever takes to go down, in ms (--t-strike in tokens.css). */
export const STRIKE_DOWN_MS = 90;

/** How long the lever takes to come back, in ms (--t-return in tokens.css). */
export const STRIKE_RETURN_MS = 380;

/** A whole strike, in ms: callers set the phase to the time since the strike began divided by this. */
export const STRIKE_MS = STRIKE_DOWN_MS + STRIKE_RETURN_MS;

/**
 * How far the lever has turned from rest, in degrees clockwise on screen, at a phase 0..1 of one
 * strike: down to LEVER.strike on the in-out curve over the first 90 of 470 ms, back to 0 on the
 * expressive-out curve over the rest. Add it to LEVER.rest to place the arm.
 */
export function leverAngle(phase: number): number {
  const at = Number.isFinite(phase) ? Math.min(1, Math.max(0, phase)) : 0;
  const down = STRIKE_DOWN_MS / STRIKE_MS;
  if (at <= down) return LEVER.strike * EASE.io(at / down);
  return LEVER.strike * (1 - EASE.out((at - down) / (1 - down)));
}
