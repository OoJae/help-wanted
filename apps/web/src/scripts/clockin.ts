/**
 * The front page's clock, in motion: the Recorder performs order 2's time card as the reader scrolls.
 *
 * Everything is a function of scrollY. The script knows nothing of the order but what the server
 * wrote into the page: each card line's `data-at` (its UTC second of the day) and each step's
 * `data-from` and `data-sec`. The step under the reading line gives the order's time; the hands
 * show it, every line whose time has come is punched (the lever strikes as it lands), and in the
 * hold after the last line the card comes out of the clock toward the reader. Scrolling back
 * rewinds the hands and lifts the punch marks, without strikes. The clock opens large and settles
 * into its column over the reader's first scroll.
 *
 * It runs only where the page's inline script set `clock-on` (motion allowed). Without JavaScript,
 * or with reduced motion, nothing here runs: the clock stands at rest, every line is punched and
 * the stage is not sticky. The WebGL Recorder is loaded later, lazily, only where it can run well;
 * until it draws its first frame, and whenever it fails, the SVG drawing stays.
 */
import type { CreateScene, RecorderScene, RecorderState } from "./recorder/contract";
import { EASE, LEVER, STRIKE_DOWN_MS, STRIKE_MS, handAngles, leverAngle, planeMatrix, throatLipOutline } from "./recorder/geometry";

const root = document.documentElement;
const section = document.querySelector<HTMLElement>("[data-clockin]");
if (section && root.classList.contains("clock-on")) start(section);

function start(section: HTMLElement) {
  const q = <T extends Element>(sel: string, from: ParentNode = section) => from.querySelector<T>(sel);
  const stage = q<HTMLElement>("[data-stage]");
  const rec = q<HTMLElement>("[data-recorder]");
  const rear = q<SVGSVGElement>("[data-recorder-rear]");
  const card = q<HTMLElement>(".recorder__card");
  const intro = q<HTMLElement>(".clockin__intro");
  if (!stage || !rec || !rear || !card || !intro) return;
  const lips = rec.querySelectorAll<SVGPolygonElement>("[data-lip]");
  const hands = ["hour", "minute", "second"].map((h) => q<SVGGElement>(`[data-hand=${h}]`));
  const lever = q<SVGGElement>("[data-lever]");
  const lines = [...rec.querySelectorAll<HTMLElement>("tbody tr[data-at]")].map((el) => ({ el, at: +el.dataset.at! }));
  const steps = [...section.querySelectorAll<HTMLElement>("[data-steps] > li[data-from]")].map((el) => ({
    el,
    from: +el.dataset.from!,
    sec: +el.dataset.sec!,
    top: 0,
    h: 1,
  }));
  const media = (m: string) => matchMedia(m);
  const wide = media("(min-width: 64rem)");
  const fine = media("(hover: hover) and (pointer: fine)");
  const last = lines.length ? lines[lines.length - 1]!.at : 0;
  const first = steps.length ? steps[0]!.from : 0;
  const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const mix = (a: number, b: number, p: number) => a + (b - a) * p;

  let frame = 0;
  let t = first; // the order's time, UTC seconds of the day; past the last line in the hold
  let strikeAt = -1e9; // when the lever began its last strike
  let pending: typeof lines = []; // lines waiting for the lever to come down on them
  let eject = 0;
  let yaw = 0;
  let aim = 0;
  let lipYaw = 0;
  let scene: RecorderScene | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let shown = false;
  let paused = false;
  let dpr = Math.min(devicePixelRatio || 1, 2);
  let samples: number[] = [];
  // The clock's two poses, open and settled, and where the settling happens.
  let g = { u: 1, h: 1, top: 0, row: 0, s0: 1, x0: 0, y0: 0, s1: 1, x1: 0, y1: 0 };

  /** Where everything is: the steps on the page, and the clock's two poses in its stage. */
  function measure() {
    const main = document.querySelector("main");
    const bleed = main ? Math.max(0, root.clientWidth - main.getBoundingClientRect().right) : 0;
    section.style.setProperty("--bleed", `${bleed}px`);
    for (const s of steps) {
      const r = s.el.getBoundingClientRect();
      s.top = r.top + scrollY;
      s.h = Math.max(1, r.height);
    }
    const isWide = wide.matches;
    const sw = stage!.clientWidth;
    const w = rec!.offsetWidth;
    const h = rec!.offsetHeight;
    const u = w / 1.49;
    const pad = 16;
    const box = intro!.getBoundingClientRect();
    const top = (isWide ? box.top : box.bottom) + scrollY;
    // On a phone the stage's row is as tall as the open clock, so nothing lies under it before it settles.
    if (!isWide) section.style.setProperty("--stage-row", `${Math.ceil(h + pad)}px`);
    const band = isWide ? innerHeight : stage!.clientHeight;
    // The card's centre is the clock's, 0.54 of a case width from the drawing's left edge.
    const centre = isWide ? (sw - bleed) / 2 + bleed * 0.15 : sw / 2;
    const s0 = isWide ? clamp((innerHeight - top - 2 * pad) / h, 0.3) : 1;
    const s1 = clamp(Math.min((band - 2 * pad) / h, (sw - pad) / w), 0.3);
    g = {
      u,
      h,
      top,
      row: h + pad,
      s0,
      x0: centre - 0.54 * u * s0,
      y0: isWide ? pad : pad / 2,
      s1,
      x1: isWide ? centre - 0.54 * u * s1 : (sw - w * s1) / 2,
      y1: pad + (band - 2 * pad - h * s1) / 2,
    };
    if (scene) scene.resize(rear!.clientWidth, rear!.clientHeight, dpr);
    paint();
  }

  /** The clock's pose at this scroll: open at the top, settled once the stage has stuck. */
  function pose(y: number) {
    let s: number;
    let p: number;
    if (wide.matches) {
      p = EASE.io(clamp(y / Math.max(1, g.top)));
      s = mix(g.s0, g.s1, p);
    } else {
      // The clock shrinks as the steps rise to meet it, its foot on their head.
      s = clamp((g.top + g.row - y - 16) / g.h, g.s1);
      p = g.s1 < 1 ? (1 - s) / (1 - g.s1) : 1;
    }
    // Once settled, the band the steps pass under is ruled off.
    section.toggleAttribute("data-settled", p > 0.999);
    return `translate(${mix(g.x0, g.x1, p)}px,${mix(g.y0, g.y1, p)}px) scale(${s})`;
  }

  /** The order's time under the reading line. */
  function orderTime() {
    const line = scrollY + innerHeight * (wide.matches ? 0.5 : 0.82);
    let at = first;
    for (const s of steps) {
      if (line < s.top) break;
      at = s.from + clamp((line - s.top) / s.h) * s.sec;
    }
    return at;
  }

  function strike(now: number, punch: typeof lines) {
    strikeAt = now;
    pending = pending.concat(punch);
    paint();
  }

  function draw(now: number) {
    frame = 0;
    const next = orderTime();
    if (next > t) {
      const crossed = lines.filter((l) => l.at > t && l.at <= next && !l.el.hasAttribute("data-punched") && !pending.includes(l));
      if (crossed.length) strike(now, crossed);
    } else if (next < t) {
      for (const l of lines) if (l.at > next) l.el.removeAttribute("data-punched");
      pending = pending.filter((l) => l.at <= next);
    }
    t = next;
    eject = last && steps.length ? EASE.stamp(clamp((t - last) / (steps[steps.length - 1]!.sec * 0.55))) : 0;
    const since = now - strikeAt;
    // The lever comes down on the line: each waiting line takes its mark at the bottom of the
    // stroke, 70 ms after the one before it.
    if (pending.length && since >= STRIKE_DOWN_MS) {
      pending.splice(0, Math.floor((since - STRIKE_DOWN_MS) / 70) + 1).forEach((l) => l.el.setAttribute("data-punched", ""));
    }
    const angles = handAngles(Math.min(t, last || t));
    hands[0]?.setAttribute("transform", `rotate(${angles.hour})`);
    hands[1]?.setAttribute("transform", `rotate(${angles.minute})`);
    hands[2]?.setAttribute("transform", `rotate(${angles.second})`);
    const phase = since / STRIKE_MS;
    lever?.setAttribute("transform", `rotate(${LEVER.rest + leverAngle(phase)})`);
    rec!.style.transform = pose(scrollY);
    // Yaw only where the WebGL clock is showing, toward a fine pointer, damped.
    yaw = Math.abs(aim - yaw) < 0.01 ? aim : yaw + (aim - yaw) * 0.08;
    const [a, b, c, d] = planeMatrix(0, yaw);
    card!.style.transform = `matrix(${a},${b},${c},${d},0,0) translateY(${-0.1 * g.u * eject}px) scale(${1 + 0.06 * eject})`;
    if (yaw !== lipYaw) {
      lipYaw = yaw;
      const lip = throatLipOutline(yaw)
        .map(([x, y]) => `${Math.round(x * 1e4) / 10},${Math.round(y * 1e4) / 10}`)
        .join(" ");
      lips.forEach((p) => p.setAttribute("points", lip));
    }
    if (scene && !paused) {
      const began = performance.now();
      scene.render({
        utcSecondsOfDay: Math.min(t, last || t),
        yaw,
        lever: clamp(phase),
        eject: clamp(eject, 0, 1.2),
        edition: (root.dataset.theme ? root.dataset.theme === "dark" : media("(prefers-color-scheme: dark)").matches) ? "night" : "day",
      } satisfies RecorderState);
      watch(performance.now() - began);
      // The scene shows only once it has drawn a frame, and only near the top of the page:
      // the drawing crossfades to it in 240 ms.
      if (!shown && scrollY < 50) {
        shown = true;
        rec!.classList.add("is-gl");
      }
    }
    if (phase < 1 || pending.length || yaw !== aim) paint();
  }

  function paint() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  // ---- Start: lines already reached are printed at once; the first is the load moment's. ----
  measure();
  t = orderTime();
  for (const l of lines) if (l.at <= t && (l.at > first || t > first + 1)) l.el.setAttribute("data-punched", "");
  root.classList.add("clock-ready");
  const clockIn = () =>
    setTimeout(() => {
      const one = lines[0];
      if (one && !one.el.hasAttribute("data-punched")) strike(performance.now(), [one]);
    }, 120);
  const onLoad = (fn: () => void) =>
    document.readyState === "complete" ? fn() : addEventListener("load", fn, { once: true });
  onLoad(clockIn);
  addEventListener("scroll", paint, { passive: true });
  addEventListener("resize", measure);
  new ResizeObserver(measure).observe(rec);
  document.fonts?.ready.then(measure);
  addEventListener("pageshow", (e) => {
    measure();
    if (e.persisted) boot();
  });

  // ---- The WebGL Recorder: lazy, gated, and given up at the first sign of trouble. ----
  const loader = Object.values(import.meta.glob<{ default: CreateScene }>("./recorder/scene.ts"))[0];

  function boot() {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
    if (!loader || scene || canvas || !media("(prefers-reduced-motion: no-preference)").matches) return;
    if (nav.connection?.saveData || (nav.deviceMemory ?? 8) < 2 || (nav.hardwareConcurrency || 8) < 4) return;
    const probe = document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    if (!probe) return;
    probe.getExtension("WEBGL_lose_context")?.loseContext();
    const c = (canvas = document.createElement("canvas"));
    c.className = "recorder__canvas";
    c.setAttribute("aria-hidden", "true");
    rear!.after(c);
    const css = getComputedStyle(c);
    const colors = Object.fromEntries(
      ["newsprint", "card", "enamel", "carbon", "brass", "ribbon"].map((k) => [k, css.getPropertyValue(`--${k}`).trim()]),
    ) as Parameters<CreateScene>[1]["colors"];
    c.addEventListener("webglcontextlost", fallBack);
    loader()
      .then((mod) => mod.default(c, { colors, signFontFamily: "Alfa Slab One" }))
      .then((made) => {
        if (canvas !== c) return made.dispose();
        scene = made;
        // resize() does not draw; the next frame does.
        scene.resize(rear!.clientWidth, rear!.clientHeight, dpr);
        paint();
      })
      .catch(fallBack);
  }

  function fallBack() {
    const s = scene;
    const c = canvas;
    shown = false;
    aim = yaw = 0;
    scene = canvas = null;
    rec!.classList.remove("is-gl");
    s?.dispose();
    // The canvas leaves after the 240 ms crossfade back to the drawing.
    if (c) setTimeout(() => c.remove(), 260);
    paint();
  }

  /** The DPR ladder and the watchdog, on the median of 60 frames. */
  function watch(ms: number) {
    samples.push(ms);
    if (samples.length < 60) return;
    const median = samples.sort((x, y) => x - y)[30]!;
    samples = [];
    if (median <= (dpr > 1.5 ? 12 : dpr > 1 ? 18 : 28)) return;
    if (dpr <= 1) return fallBack();
    dpr = dpr > 1.5 ? 1.5 : 1;
    scene?.resize(rear!.clientWidth, rear!.clientHeight, dpr);
    paint();
  }

  new IntersectionObserver(
    ([seen]) => {
      paused = !seen?.isIntersecting;
      paint();
    },
    { rootMargin: "200px" },
  ).observe(stage);
  document.addEventListener("visibilitychange", () => {
    paused = document.hidden;
    paint();
  });
  addEventListener("pagehide", fallBack);
  // An edition change recolours the scene: it reads the tokens again on its next frame.
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  media("(prefers-color-scheme: dark)").addEventListener("change", paint);
  addEventListener("pointermove", (e) => {
    if (!shown || !fine.matches || e.pointerType !== "mouse") return;
    const r = stage.getBoundingClientRect();
    aim = clamp((e.clientX - r.left - r.width / 2) / (r.width / 2), -1, 1) * 3;
    paint();
  });
  document.addEventListener("mouseleave", () => {
    aim = 0;
    paint();
  });
  onLoad(() => ("requestIdleCallback" in window ? requestIdleCallback(boot, { timeout: 1200 }) : setTimeout(boot, 600)));
}
