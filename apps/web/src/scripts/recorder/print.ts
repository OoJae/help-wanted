/**
 * The Recorder's print: the one material every part of the WebGL clock is drawn with, and the ink
 * outline drawn round four of them.
 *
 * The clock is printed, not rendered: a two-ink line engraving worked out per pixel. Every part is a
 * flat token colour. Brass and Newsprint parts take hatch lines in the dark ink where they turn away
 * from the key light (above, to the left, in front), the lines thickening into the shade, and a flat
 * highlight in the light ink where they catch it. Glossy Enamel parts (the case, the knob) take
 * light-ink lines where they gleam, as a white-line engraver cuts a lacquered box, and dark-ink
 * lines in their shade. In the day edition the dark ink is Enamel and the light ink Newsprint; at
 * night the two tokens trade places, and the print follows them, so light stays light: a gleam is
 * never printed dark. Painted parts (the ticks, the hands, the sign's plate) stay flat.
 *
 * There is one hatch, at 135 degrees as on the site's hatched slots, fixed to the screen at a pitch
 * of 3 CSS pixels. A line's width is its coverage of the pitch; a line starts at one device pixel
 * wide, never thinner, so a tone is drawn in whole lines and never greys into a haze, and its edges
 * are antialiased over the pixel's footprint. The outline is an inverted hull: the back faces of a
 * part pushed out by a fixed number of pixels and filled with the dark ink, so only the rim outside
 * the part's silhouette shows.
 *
 * Colours are the tokens' sRGB values as they are (0..1), and the shader writes them out unchanged:
 * no colour management, no tone mapping. Where a part is untouched by line or highlight, its pixel
 * is the CSS token to the bit. `uFlat` set to 1 drops the lines for flat two-tone shading (outlines
 * kept), the fallback if the engraving ever reads as noise on a screen.
 */
import { BackSide, GLSL3, ShaderMaterial, Vector2, Vector3, type IUniform, type Texture } from "three";
import type { RecorderColors } from "./contract";

/**
 * What a vertex is printed as: a token material, with Enamel either glossy (engraved) or painted
 * (flat), or the sign's letters on its painted enamel.
 */
export const INK = { enamel: 0, brass: 1, newsprint: 2, card: 3, lettering: 4, paintedEnamel: 5 } as const;

/** Where the key light hangs, in world space (the camera looks down -z from the front): above, to the left, in front. */
const KEY_LIGHT = [-1.6, 1.9, 2.4] as const;

/** The hatch pitch and the outline's width, in CSS pixels; both are multiplied by the device pixel ratio. */
export const HATCH_PITCH_PX = 3;
export const OUTLINE_PX = 1.25;

/** The uniforms both materials share, so one write recolours or resizes everything. */
export interface PrintUniforms {
  [name: string]: IUniform;
  uEnamel: IUniform<Vector3>;
  uBrass: IUniform<Vector3>;
  uNewsprint: IUniform<Vector3>;
  uCard: IUniform<Vector3>;
  /** The darker and the lighter of Enamel and Newsprint: the two inks the lines are cut in. */
  uInk: IUniform<Vector3>;
  uPaper: IUniform<Vector3>;
  uKey: IUniform<Vector3>;
  /** Hatch pitch in device pixels. */
  uPitch: IUniform<number>;
  /** Outline width in device pixels. */
  uOutline: IUniform<number>;
  /** The drawing buffer's size in device pixels. */
  uViewport: IUniform<Vector2>;
  /** 1 for flat two-tone shading, 0 for the engraving. */
  uFlat: IUniform<number>;
  /** The sign's lettering: coverage in the alpha channel. */
  uSign: IUniform<Texture | null>;
}

export function createPrintUniforms(sign: Texture): PrintUniforms {
  return {
    uEnamel: { value: new Vector3() },
    uBrass: { value: new Vector3() },
    uNewsprint: { value: new Vector3() },
    uCard: { value: new Vector3() },
    uInk: { value: new Vector3() },
    uPaper: { value: new Vector3() },
    uKey: { value: new Vector3(...KEY_LIGHT) },
    uPitch: { value: HATCH_PITCH_PX },
    uOutline: { value: OUTLINE_PX },
    uViewport: { value: new Vector2(1, 1) },
    uFlat: { value: 0 },
    uSign: { value: sign },
  };
}

/** Sets the pixel-sized uniforms for a drawing buffer of `width` x `height` device pixels at `dpr`. */
export function setPixelSize(uniforms: PrintUniforms, width: number, height: number, dpr: number): void {
  uniforms.uPitch.value = HATCH_PITCH_PX * dpr;
  uniforms.uOutline.value = OUTLINE_PX * dpr;
  uniforms.uViewport.value.set(Math.max(1, width), Math.max(1, height));
}

/** Writes token colours (any CSS colour a canvas understands; the tokens are hex) into the uniforms. */
export function setColors(uniforms: PrintUniforms, colors: RecorderColors): void {
  rgb(colors.enamel, uniforms.uEnamel.value);
  rgb(colors.brass, uniforms.uBrass.value);
  rgb(colors.newsprint, uniforms.uNewsprint.value);
  rgb(colors.card, uniforms.uCard.value);
  const enamel = uniforms.uEnamel.value;
  const newsprint = uniforms.uNewsprint.value;
  const enamelIsDark = luma(enamel) <= luma(newsprint);
  uniforms.uInk.value.copy(enamelIsDark ? enamel : newsprint);
  uniforms.uPaper.value.copy(enamelIsDark ? newsprint : enamel);
}

function luma(c: Vector3): number {
  return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
}

let normaliser: CanvasRenderingContext2D | null = null;

/**
 * Reads a CSS colour into `out` as sRGB 0..1, leaving `out` as it was if the text is not a colour.
 * Hex and rgb() are read directly; anything else is first spelled out by a 2D canvas, which turns
 * every sRGB colour into one of those two forms.
 */
function rgb(text: string, out: Vector3): void {
  const value = text.trim();
  const parsed = parse(value) ?? parse(spelled(value));
  if (parsed) out.set(parsed[0] / 255, parsed[1] / 255, parsed[2] / 255);
}

function parse(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)?.[1];
  if (hex && (hex.length === 3 || hex.length === 4)) {
    return [0, 1, 2].map((i) => parseInt(hex[i]! + hex[i]!, 16)) as [number, number, number];
  }
  if (hex && (hex.length === 6 || hex.length === 8)) {
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return null;
}

function spelled(value: string): string {
  if (!value || typeof document === "undefined") return "";
  normaliser ??= document.createElement("canvas").getContext("2d");
  if (!normaliser) return "";
  normaliser.fillStyle = "#000";
  normaliser.fillStyle = value;
  return String(normaliser.fillStyle);
}

const VERTEX = /* glsl */ `
in float ink;

out vec3 vPos;
out vec3 vNormal;
out vec2 vUv;
flat out float vInk;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPos = world.xyz;
  // The clock is only ever turned, never scaled, so the model matrix turns normals as it turns points.
  vNormal = mat3(modelMatrix) * normal;
  vUv = uv;
  vInk = ink;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uEnamel;
uniform vec3 uBrass;
uniform vec3 uNewsprint;
uniform vec3 uCard;
uniform vec3 uInk;
uniform vec3 uPaper;
uniform vec3 uKey;
uniform float uPitch;
uniform float uFlat;
uniform sampler2D uSign;

in vec3 vPos;
in vec3 vNormal;
in vec2 vUv;
flat in float vInk;

out highp vec4 fragColor;

// A hard step from 0 to 1 at 'edge', softened over one pixel's change in 'x' ('fw').
float cut(float edge, float x, float fw) {
  return smoothstep(edge - fw, edge + fw, x);
}

// How much of this pixel the nearest hatch line covers. 'tone' runs 0..1; at 0 there is no line, and
// above it the line is one device pixel wide at the least and 'most' of the pitch at the full tone.
// The lines run at 135 degrees on screen (up and to the right), 'uPitch' apart; 'u' is the distance
// across them and 'foot' the pixel's footprint across them.
float hatch(float tone, float most, float u, float foot) {
  float width = tone > 0.0 ? mix(max(1.0, 0.18 * uPitch), most * uPitch, tone) : 0.0;
  float d = abs(fract(u / uPitch + 0.5) - 0.5) * uPitch;
  float hw = 0.5 * width;
  return clamp((min(d + 0.5 * foot, hw) - max(d - 0.5 * foot, -hw)) / foot, 0.0, 1.0);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(uKey - vPos);
  // An orthographic camera looks along -z everywhere, so the view vector is constant.
  vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
  float shade = 1.0 - max(dot(n, l), 0.0);
  float gleam = pow(max(dot(n, h), 0.0), 24.0);

  // Everything that needs derivatives is worked out here, before any branch.
  float u = (gl_FragCoord.x - gl_FragCoord.y) * 0.70710678;
  float foot = max(fwidth(u) * 0.70710678, 1e-3);
  float fwGleam = fwidth(gleam) + 1e-4;
  float fwShade = fwidth(shade) + 1e-4;
  // The letters' coverage, re-cut at its middle to a one-pixel edge: the texture is minified, and a
  // mipmap alone would print the slab soft.
  float coverage = texture(uSign, vUv, -0.5).a;
  float letter = clamp((coverage - 0.5) / max(fwidth(coverage), 1e-3) + 0.5, 0.0, 1.0);

  int ink = int(vInk + 0.5);
  vec3 color;
  if (ink == 4 || ink == 5) {
    // Painted enamel stays flat; the sign's letters are painted on it.
    color = uEnamel;
    if (ink == 4) color = mix(color, uNewsprint, letter);
  } else if (ink == 0) {
    // Glossy enamel: light-ink lines on the gleam, dark-ink lines in the shade (one of the two inks is
    // Enamel itself, so only the other shows).
    float lit = cut(0.2, gleam, fwGleam);
    float dark = cut(0.6, shade, fwShade);
    color = uEnamel;
    if (uFlat > 0.5) {
      color = mix(color, uPaper, 0.2 * cut(0.3, gleam, fwGleam));
      color = mix(color, uInk, 0.3 * cut(0.62, shade, fwShade));
    } else {
      color = mix(color, uPaper, lit * hatch(smoothstep(0.2, 0.85, gleam), 0.8, u, foot));
      color = mix(color, uInk, dark * hatch(smoothstep(0.6, 1.0, shade), 0.65, u, foot));
    }
  } else {
    // Brass, Newsprint and Card: dark-ink lines into the shade, a flat light-ink highlight. The lines
    // stop short of the silhouette, where a turned surface catches light from behind it, so a brass
    // edge stays clean against the enamel round it.
    vec3 base = ink == 1 ? uBrass : ink == 2 ? uNewsprint : uCard;
    float tone = smoothstep(0.6, 1.0, shade) * smoothstep(0.3, 0.6, n.z);
    color = uFlat > 0.5
      ? mix(base, uInk, 0.3 * cut(0.66, shade, fwShade))
      : mix(base, uInk, cut(0.6, shade, fwShade) * hatch(tone, 0.65, u, foot));
    color = mix(color, uPaper, cut(0.5, gleam, fwGleam));
  }
  fragColor = vec4(color, 1.0);
}
`;

const OUTLINE_VERTEX = /* glsl */ `
in vec3 hullNormal;

uniform vec2 uViewport;
uniform float uOutline;

void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Push the vertex out along its normal as the screen sees it, by the outline's width in pixels.
  vec2 pixels = (projectionMatrix * vec4(normalMatrix * hullNormal, 0.0)).xy * uViewport;
  float length2 = dot(pixels, pixels);
  vec2 dir = length2 > 1e-12 ? pixels * inversesqrt(length2) : vec2(0.0);
  clip.xy += dir * uOutline * 2.0 / uViewport * clip.w;
  // A hair further from the camera, so the hull never shows through the faces it outlines.
  clip.z += 2e-4 * clip.w;
  gl_Position = clip;
}
`;

const OUTLINE_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uInk;

out highp vec4 fragColor;

void main() {
  fragColor = vec4(uInk, 1.0);
}
`;

/** The print: one material for every part, with the token colours in `uniforms`. */
export function createPrintMaterial(uniforms: PrintUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: "print",
    glslVersion: GLSL3,
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });
}

/** The ink outline: an inverted hull, drawn from a geometry whose `hullNormal` is smooth across hard edges. */
export function createOutlineMaterial(uniforms: PrintUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: "outline",
    glslVersion: GLSL3,
    uniforms,
    vertexShader: OUTLINE_VERTEX,
    fragmentShader: OUTLINE_FRAGMENT,
    side: BackSide,
  });
}
