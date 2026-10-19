/**
 * The WebGL Recorder: the front page's time clock, built from geometry.ts and drawn in the print of
 * print.ts. The page script imports this module lazily, with three.js, and calls its default export
 * (a `CreateScene`, see contract.ts); from then on the scene draws one frame each time it is told to
 * and nothing in between.
 *
 * It draws only the clock's rear parts. The page lays the HTML time card over the canvas and the
 * SVG throat lip over the card, so the canvas never paints the lip, and the card hides what the
 * rear parts put behind it. The camera frames geometry.ts's FRAME exactly, as the SVG twin's viewBox
 * does, so the two drawings register when the page crossfades between them.
 *
 * Every part is procedural (no model, texture or environment is fetched) and parts that move
 * together share one mesh, with what each vertex is printed as in an `ink` attribute: the clock is
 * five meshes and two outline hulls, seven draw calls in all. The one texture is the sign's lettering.
 *
 * A canvas whose `data-print` is "flat" is drawn in flat two-tone shading instead of the engraving.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  LinearSRGBColorSpace,
  Mesh,
  NoToneMapping,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  TorusGeometry,
  WebGLRenderer,
  type Material,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { CreateScene, RecorderColors, RecorderScene, RecorderState } from "./contract";
import {
  FRAME,
  LEVER,
  PARTS,
  SIGN,
  handAngles,
  leverAngle,
  viewRotation,
  type Part,
  type PartName,
  type Shape,
  type TickSpec,
  type Vec3,
} from "./geometry";
import {
  INK,
  createOutlineMaterial,
  createPrintMaterial,
  createPrintUniforms,
  setColors,
  setPixelSize,
  type PrintUniforms,
} from "./print";

const DEG = Math.PI / 180;

/** The parts drawn with an ink outline: the case, the bezel, the lever and the sign's frame. */
const OUTLINED: ReadonlySet<PartName> = new Set<PartName>([
  "case",
  "bezel",
  "leverHub",
  "leverArm",
  "leverKnob",
  "signFrameTop",
  "signFrameBottom",
  "signFrameLeft",
  "signFrameRight",
]);

/** The enamel parts painted flat rather than engraved: what sits on the dial, and the sign's plate behind its letters. */
const PAINTED: ReadonlySet<PartName> = new Set<PartName>(["ticks", "hourHand", "minuteHand", "signPlate"]);

/** Facets round the bezel's tube and on the knob; the other counts are geometry.ts's. */
const TUBE_SEGMENTS = 12;
const SPHERE_SEGMENTS = [20, 12] as const;

/** The sign's lettering texture, in pixels; it covers the plate's face exactly. */
const SIGN_TEXTURE = { width: 1024, height: 256 } as const;

const COLOR_NAMES = ["newsprint", "card", "enamel", "carbon", "brass", "ribbon"] as const;

/** What turns a mesh: nothing, or one of the drivers geometry.ts names. */
type Driver = "static" | "hour" | "minute" | "second" | "lever";

/** The solid of a shape, centred on the origin. */
function solid(shape: Shape): BufferGeometry {
  switch (shape.kind) {
    case "roundedBox":
      return new RoundedBoxGeometry(...shape.size, shape.segments, shape.radius);
    case "box":
      return new BoxGeometry(...shape.size);
    case "cylinder": {
      // three's cylinder runs along y.
      const geometry = new CylinderGeometry(shape.radius, shape.radius, shape.length, shape.segments);
      if (shape.axis === "z") geometry.rotateX(Math.PI / 2);
      if (shape.axis === "x") geometry.rotateZ(-Math.PI / 2);
      return geometry;
    }
    case "torus":
      return new TorusGeometry(shape.radius, shape.tube, TUBE_SEGMENTS, shape.segments);
    case "sphere":
      return new SphereGeometry(shape.radius, ...SPHERE_SEGMENTS);
    case "ticks":
      return ticks(shape);
    case "lettering":
      // The letters are painted on a plane over the plate's whole face; the texture places them.
      return new PlaneGeometry(SIGN.plate.size[0], SIGN.plate.size[1]);
  }
}

/** The minute track as one geometry: each bar's outer end at `outer` from the centre, turned clockwise from twelve. */
function ticks(spec: TickSpec): BufferGeometry {
  const bars: BufferGeometry[] = [];
  for (let i = 0; i < spec.count; i++) {
    const bar = i % spec.heavyEvery === 0 ? spec.major : spec.minor;
    const geometry = new BoxGeometry(bar.width, bar.length, spec.thickness);
    geometry.translate(0, spec.outer - bar.length / 2, 0);
    geometry.rotateZ((-i * 360 * DEG) / spec.count);
    bars.push(geometry);
  }
  return merge(bars, ["position", "normal", "uv"]);
}

/** Joins geometries into one indexed geometry with the named attributes, which each of them must have. */
function merge(geometries: readonly BufferGeometry[], names: readonly string[]): BufferGeometry {
  let vertices = 0;
  let indices = 0;
  for (const geometry of geometries) {
    const count = geometry.getAttribute("position").count;
    vertices += count;
    indices += geometry.index?.count ?? count;
  }
  const merged = new BufferGeometry();
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  let at = 0;
  let base = 0;
  for (const geometry of geometries) {
    const count = geometry.getAttribute("position").count;
    const source = geometry.index;
    for (let i = 0; i < (source?.count ?? count); i++) index[at++] = base + (source ? source.getX(i) : i);
    base += count;
  }
  merged.setIndex(new BufferAttribute(index, 1));
  for (const name of names) {
    const size = geometries[0]!.getAttribute(name).itemSize;
    const data = new Float32Array(vertices * size);
    let offset = 0;
    for (const geometry of geometries) {
      const attribute = geometry.getAttribute(name);
      for (let i = 0; i < attribute.count; i++) {
        for (let k = 0; k < size; k++) data[offset++] = attribute.getComponent(i, k);
      }
    }
    merged.setAttribute(name, new BufferAttribute(data, size));
  }
  return merged;
}

/**
 * Normals for the outline hull that do not split at hard edges: at each place, the sum of the
 * different normals the faces meeting there have (a box's corner gets the diagonal), so the pushed
 * out hull stays closed.
 */
function hullNormals(geometry: BufferGeometry): BufferAttribute {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const at = new Map<string, number[][]>();
  const key = (i: number) =>
    `${Math.round(position.getX(i) * 1e5)},${Math.round(position.getY(i) * 1e5)},${Math.round(position.getZ(i) * 1e5)}`;
  for (let i = 0; i < position.count; i++) {
    const n = [normal.getX(i), normal.getY(i), normal.getZ(i)];
    const list = at.get(key(i)) ?? [];
    if (!list.some((m) => m[0]! * n[0]! + m[1]! * n[1]! + m[2]! * n[2]! > 0.999)) list.push(n);
    at.set(key(i), list);
  }
  const out = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const n of at.get(key(i))!) {
      x += n[0]!;
      y += n[1]!;
      z += n[2]!;
    }
    const length = Math.hypot(x, y, z) || 1;
    out.set([x / length, y / length, z / length], i * 3);
  }
  return new BufferAttribute(out, 3);
}

function driverOf(part: Part): Driver {
  if (part.turns) return part.turns.by;
  // The hub does not turn, but it is round about the lever's pivot, so it rides in the lever's mesh.
  return part.name === "leverHub" ? "lever" : "static";
}

function inkOf(part: Part): number {
  if (part.shape.kind === "lettering") return INK.lettering;
  if (part.material === "enamel" && PAINTED.has(part.name)) return INK.paintedEnamel;
  return INK[part.material];
}

/** The quoted family name for a CSS font shorthand, unless it is already quoted or a list. */
function family(name: string): string {
  return /["',]/.test(name) ? name : `"${name}"`;
}

/**
 * Paints HELP WANTED onto the sign's texture as coverage (white on clear; the shader colours it):
 * set at the lettering's size, tracked, stretched or squeezed to exactly its width, and centred on
 * the plate with the capitals' height centred vertically.
 */
function paintSign(context: CanvasRenderingContext2D, fontFamily: string): void {
  const { width, height } = SIGN_TEXTURE;
  const [plateWidth, plateHeight] = SIGN.plate.size;
  const { text, fontSize, tracking } = SIGN.lettering;
  const xScale = width / plateWidth;
  const yScale = height / plateHeight;
  const px = fontSize * yScale;
  context.clearRect(0, 0, width, height);
  context.font = `400 ${px}px ${family(fontFamily)}`;
  context.textBaseline = "alphabetic";
  context.fillStyle = "#fff";
  // Each letter goes where the run up to it ends, so the face's kerning is kept.
  const track = tracking * px;
  const starts = [...text].map((_, i) => context.measureText(text.slice(0, i)).width + i * track);
  const run = context.measureText(text);
  const natural = run.width + (text.length - 1) * track;
  const target = SIGN.lettering.width * xScale;
  const baseline = height / 2 + (run.actualBoundingBoxAscent - run.actualBoundingBoxDescent) / 2;
  context.setTransform(target / natural, 0, 0, 1, width / 2 - target / 2, baseline);
  [...text].forEach((letter, i) => context.fillText(letter, starts[i]!, 0));
  context.setTransform(1, 0, 0, 1, 0, 0);
}

/** The token colours as the canvas inherits them now; a name the page does not define keeps its old value. */
function readColors(canvas: HTMLCanvasElement, previous: RecorderColors): RecorderColors {
  const style = getComputedStyle(canvas);
  const colors = { ...previous };
  for (const name of COLOR_NAMES) {
    const value = style.getPropertyValue(`--${name}`).trim();
    if (value) colors[name] = value;
  }
  return colors;
}

/**
 * Builds the scene. `still` is for the development bench only: it keeps the drawing buffer for a
 * capture and accepts a software renderer, which the page never wants.
 */
const createScene = async (
  canvas: HTMLCanvasElement,
  options: { colors: RecorderColors; signFontFamily: string; still?: boolean },
): Promise<RecorderScene> => {
  const still = options.still === true;
  // three.js r186 draws with WebGL2 only and throws if it cannot get it, which rejects this promise.
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: true,
    stencil: false,
    failIfMajorPerformanceCaveat: !still,
    preserveDrawingBuffer: still,
  });
  const gl = renderer.getContext();
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  let texture: CanvasTexture | null = null;
  /** Frees every geometry, material and texture, then the renderer, and loses the context. */
  const release = () => {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    texture?.dispose();
    try {
      renderer.dispose();
      // A context that is already lost has nothing left to free (and three would warn).
      if (!gl.isContextLost()) renderer.forceContextLoss();
    } catch {
      // Never fully made: there is nothing left to free.
    }
  };
  try {
    // The shader writes the tokens' sRGB values as they are; three converts and maps nothing.
    renderer.outputColorSpace = LinearSRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.setClearColor(0x000000, 0);

    const signCanvas = document.createElement("canvas");
    signCanvas.width = SIGN_TEXTURE.width;
    signCanvas.height = SIGN_TEXTURE.height;
    const signContext = signCanvas.getContext("2d");
    if (!signContext) throw new Error("The sign's lettering cannot be painted: no 2D canvas.");
    // A face that will not load is no reason to keep the clock off the page; the fallback letters it.
    await document.fonts
      .load(`400 64px ${family(options.signFontFamily)}`, SIGN.lettering.text)
      .catch(() => []);
    paintSign(signContext, options.signFontFamily);
    texture = new CanvasTexture(signCanvas);

    const uniforms: PrintUniforms = createPrintUniforms(texture);
    let colors = options.colors;
    setColors(uniforms, colors);
    const print = createPrintMaterial(uniforms);
    const outline = createOutlineMaterial(uniforms);
    materials.push(print, outline);

    // The clock's parts, grouped by what turns them. Each group is modelled about its pivot, and its
    // mesh is placed at the pivot, so turning the mesh about z turns the group as geometry.ts says.
    const groups = new Map<
      Driver,
      { pivot: Vec3; rest: number; fill: BufferGeometry[]; hull: BufferGeometry[] }
    >();
    for (const part of PARTS) {
      if (part.layer !== "rear") continue;
      const driver = driverOf(part);
      let group = groups.get(driver);
      if (!group) {
        const pivot: Vec3 =
          driver === "static" ? [0, 0, 0] : driver === "lever" ? LEVER.pivot : part.turns!.pivot;
        group = { pivot, rest: 0, fill: [], hull: [] };
        groups.set(driver, group);
      }
      if (part.turns) group.rest = part.turns.rest;
      const geometry = solid(part.shape);
      geometry.translate(
        part.at[0] - group.pivot[0],
        part.at[1] - group.pivot[1],
        part.at[2] - group.pivot[2],
      );
      const count = geometry.getAttribute("position").count;
      geometry.setAttribute("ink", new BufferAttribute(new Float32Array(count).fill(inkOf(part)), 1));
      group.fill.push(geometry);
      if (OUTLINED.has(part.name)) {
        geometry.setAttribute("hullNormal", hullNormals(geometry));
        group.hull.push(geometry);
      }
    }

    const scene = new Scene();
    const clock = new Group();
    scene.add(clock);
    const turning: { mesh: Group; driver: Driver; rest: number }[] = [];
    for (const [driver, group] of groups) {
      const holder = new Group();
      holder.position.set(...group.pivot);
      const fill = merge(group.fill, ["position", "normal", "uv", "ink"]);
      geometries.push(fill);
      holder.add(new Mesh(fill, print));
      if (group.hull.length > 0) {
        const hull = merge(group.hull, ["position", "hullNormal"]);
        geometries.push(hull);
        holder.add(new Mesh(hull, outline));
      }
      for (const source of group.fill) source.dispose();
      clock.add(holder);
      if (driver !== "static") turning.push({ mesh: holder, driver, rest: group.rest });
    }

    // Orthographic, looking down -z from in front of the clock; the frame is set by `resize`.
    const camera = new OrthographicCamera(
      FRAME.x,
      FRAME.x + FRAME.width,
      -FRAME.y,
      -(FRAME.y + FRAME.height),
      8,
      12,
    );
    camera.position.set(0, 0, 10);

    /** Fits FRAME to a canvas of this shape as an SVG's viewBox fits (centred, nothing cropped). */
    const frame = (width: number, height: number) => {
      const scale = Math.min(width / FRAME.width, height / FRAME.height) || 1;
      const w = width / scale;
      const h = height / scale;
      const left = FRAME.x - (w - FRAME.width) / 2;
      const top = FRAME.y - (h - FRAME.height) / 2;
      camera.left = left;
      camera.right = left + w;
      camera.top = -top;
      camera.bottom = -(top + h);
      camera.updateProjectionMatrix();
    };

    let edition: RecorderState["edition"] | null = null;
    let disposed = false;
    const lost = () => disposed || gl.isContextLost();

    const resize = (cssWidth: number, cssHeight: number, dpr: number) => {
      if (lost() || !(cssWidth > 0) || !(cssHeight > 0)) return;
      const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
      renderer.setPixelRatio(ratio);
      renderer.setSize(cssWidth, cssHeight, false);
      setPixelSize(uniforms, gl.drawingBufferWidth, gl.drawingBufferHeight, ratio);
      frame(cssWidth, cssHeight);
    };

    const pose = (state: RecorderState) => {
      clock.rotation.set(...viewRotation(state.yaw));
      const hands = handAngles(state.utcSecondsOfDay);
      for (const { mesh, driver, rest } of turning) {
        const angle = driver === "lever" ? leverAngle(state.lever) : driver === "static" ? 0 : hands[driver];
        // geometry.ts turns clockwise on screen; three turns counter-clockwise about +z.
        mesh.rotation.z = -(rest + angle) * DEG;
      }
    };

    resize(
      canvas.clientWidth || canvas.width,
      canvas.clientHeight || canvas.height,
      Math.min(devicePixelRatio || 1, 2),
    );
    pose({ utcSecondsOfDay: 0, yaw: 0, lever: 0, eject: 0, edition: "day" });
    // Compile both programs now (in parallel where the browser can), so the first frame does not
    // stall; a context lost meanwhile would keep three waiting, so the wait is capped.
    await Promise.race([renderer.compileAsync(scene, camera), new Promise((done) => setTimeout(done, 3000))]);
    if (gl.isContextLost()) throw new Error("The WebGL context was lost while the Recorder was being built.");

    return {
      render(state) {
        if (lost()) return;
        if (state.edition !== edition) {
          edition = state.edition;
          colors = readColors(canvas, colors);
          setColors(uniforms, colors);
        }
        uniforms.uFlat.value = canvas.dataset.print === "flat" ? 1 : 0;
        pose(state);
        renderer.render(scene, camera);
      },
      resize,
      dispose() {
        if (disposed) return;
        disposed = true;
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
};

export default createScene satisfies CreateScene;
