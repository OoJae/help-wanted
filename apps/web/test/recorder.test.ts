/** The Recorder's geometry: the one projection both renderers draw with, the hands and the lever. */
import { describe, expect, it } from "vitest";
import {
  CARD,
  CASE,
  FRAME,
  LEVER,
  MAX_YAW,
  PARTS,
  PITCH,
  cardSlotRect,
  caseOutline,
  clampYaw,
  handAngles,
  leverAngle,
  planeMatrix,
  project,
  STRIKE_DOWN_MS,
  STRIKE_MS,
  throatLipOutline,
  viewRotation,
  type Part,
  type Point,
  type Vec3,
} from "~/scripts/recorder/geometry";

const DEG = Math.PI / 180;
const PITCH_RAD = -PITCH * DEG;

/** True when p lies inside (or on) a convex polygon listed clockwise on screen, as the outlines are. */
function insideConvex(p: Point, poly: Point[]): boolean {
  return poly.every((a, i) => {
    const b = poly[(i + 1) % poly.length]!;
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-12;
  });
}

describe("the projection", () => {
  it("at yaw 0 is an orthographic front view tipped by the pitch", () => {
    expect(PITCH).toBe(-8);
    const [x, y] = project([0.3, 0.5, 0.2], 0);
    expect(x).toBeCloseTo(0.3, 12);
    expect(y).toBeCloseTo(-(0.5 * Math.cos(PITCH_RAD) - 0.2 * Math.sin(PITCH_RAD)), 12);
    // Orthographic: depth never scales a point toward the centre, and every point on a line along
    // the camera's view direction lands in the same place.
    expect(project([0.3, 0, 5], 0)[0]).toBeCloseTo(0.3, 12);
    const along: Vec3 = [0.3, 0.5 + 2 * Math.sin(PITCH_RAD), 0.2 + 2 * Math.cos(PITCH_RAD)];
    expect(project(along, 0)[0]).toBeCloseTo(x, 12);
    expect(project(along, 0)[1]).toBeCloseTo(y, 12);
    // Looking down: the top face's back edge is drawn above its front edge (y points down).
    expect(project([0, CASE.top, -0.2], 0)[1]).toBeLessThan(project([0, CASE.top, 0.2], 0)[1]);
  });

  it("clamps yaw to plus or minus 6 degrees everywhere", () => {
    expect(MAX_YAW).toBe(6);
    const p: Vec3 = [0.4, 0.3, 0.2];
    expect(project(p, 20)).toEqual(project(p, 6));
    expect(project(p, -90)).toEqual(project(p, -6));
    expect(project(p, 6)).not.toEqual(project(p, 5));
    expect(clampYaw(Number.NaN)).toBe(0);
    expect(planeMatrix(0.2, 45)).toEqual(planeMatrix(0.2, 6));
    expect(viewRotation(-45)).toEqual(viewRotation(-6));
    // A positive yaw brings the right flank, the lever's side, toward the viewer.
    const flankWidth = (yaw: number) => project([0.5, 0, -0.2], yaw)[0] - project([0.5, 0, 0.2], yaw)[0];
    expect(flankWidth(6)).toBeGreaterThan(0);
    expect(flankWidth(-6)).toBeLessThan(0);
  });

  it("is the same map as planeMatrix and as viewRotation in three.js's conventions", () => {
    for (const yaw of [-6, -2.5, 0, 4, 6]) {
      for (const [u, v, z] of [
        [0.1, -0.3, 0.2],
        [-0.42, -0.68, 0],
        [0.8, 0.1, 0.06],
      ] as const) {
        const [a, b, c, d, e, f] = planeMatrix(z, yaw);
        const [px, py] = project([u, -v, z], yaw);
        expect(a * u + c * v + e).toBeCloseTo(px, 12);
        expect(b * u + d * v + f).toBeCloseTo(py, 12);
        // three.js: Euler "XYZ" applies Rz, then Ry, then Rx to a point; its screen y points up.
        const [rx, ry] = viewRotation(yaw);
        const [x, y] = [u, -v];
        const x1 = x * Math.cos(ry) + z * Math.sin(ry);
        const z1 = -x * Math.sin(ry) + z * Math.cos(ry);
        const y2 = y * Math.cos(rx) - z1 * Math.sin(rx);
        expect(x1).toBeCloseTo(px, 12);
        expect(-y2).toBeCloseTo(py, 12);
      }
    }
  });
});

describe("the hands", () => {
  it("show 10:28:47, the time order 2 clocked in", () => {
    const angles = handAngles(10 * 3600 + 28 * 60 + 47);
    expect(angles.hour).toBeCloseTo(10 * 30 + (28 * 60 + 47) / 120, 9); // 314.39 degrees
    expect(angles.minute).toBeCloseTo(28 * 6 + 47 / 10, 9); // 172.7 degrees
    expect(angles.second).toBeCloseTo(47 * 6, 9); // 282 degrees
  });

  it("wrap into one day", () => {
    expect(handAngles(0)).toEqual({ hour: 0, minute: 0, second: 0 });
    expect(handAngles(86400 + 30).second).toBeCloseTo(180, 9);
    expect(handAngles(-30).second).toBeCloseTo(180, 9);
    expect(handAngles(12 * 3600).hour).toBe(0);
  });
});

describe("the lever", () => {
  it("strikes 42 degrees down in the first 90 of 470 ms and comes back to rest", () => {
    expect(STRIKE_MS).toBe(470);
    expect(leverAngle(0)).toBe(0);
    expect(leverAngle(STRIKE_DOWN_MS / STRIKE_MS)).toBeCloseTo(LEVER.strike, 9);
    expect(leverAngle(1)).toBeCloseTo(0, 9);
    expect(leverAngle(-1)).toBe(0);
    expect(leverAngle(2)).toBeCloseTo(0, 9);
    let last = 0;
    for (let ms = 10; ms <= STRIKE_DOWN_MS; ms += 10) {
      const a = leverAngle(ms / STRIKE_MS);
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
    for (let ms = STRIKE_DOWN_MS + 10; ms <= STRIKE_MS; ms += 10) {
      const a = leverAngle(ms / STRIKE_MS);
      expect(a).toBeLessThanOrEqual(last + 1e-9);
      last = a;
    }
  });
});

describe("the throat", () => {
  it("holds the card slot inside the case's outline at every yaw", () => {
    for (const yaw of [-6, -3, 0, 3, 6]) {
      const outline = caseOutline(yaw);
      const slot = cardSlotRect(yaw);
      expect(slot.width).toBeGreaterThan(CARD.width * Math.cos(MAX_YAW * DEG));
      for (const corner of [
        [slot.x, slot.y],
        [slot.x + slot.width, slot.y],
        [slot.x + slot.width, slot.y + slot.height],
        [slot.x, slot.y + slot.height],
      ] as Point[]) {
        expect(insideConvex(corner, outline)).toBe(true);
      }
    }
  });

  it("lets the lip cover the card's lower edge from end to end", () => {
    for (const yaw of [-6, 0, 6]) {
      const lip = throatLipOutline(yaw);
      for (const x of [-CARD.width / 2, 0, CARD.width / 2]) {
        expect(insideConvex(project([x, CASE.top, CARD.z], yaw), lip)).toBe(true);
      }
    }
    // The card's lower-edge centre does not move as the clock turns.
    expect(project([0, CASE.top, CARD.z], 6)).toEqual(project([0, CASE.top, CARD.z], -6));
  });
});

describe("the frame", () => {
  /** Points on a part's surface, enough to bound its silhouette, in its zero pose. */
  function surface(part: Part): Vec3[] {
    const [cx, cy, cz] = part.at;
    const ring = (r: number, z: number, n = 48): Vec3[] =>
      Array.from({ length: n }, (_, i) => [
        cx + r * Math.cos((2 * Math.PI * i) / n),
        cy + r * Math.sin((2 * Math.PI * i) / n),
        z,
      ]);
    const s = part.shape;
    switch (s.kind) {
      case "roundedBox":
      case "box": {
        const out: Vec3[] = [];
        for (const sx of [-1, 1])
          for (const sy of [-1, 1])
            for (const sz of [-1, 1])
              out.push([cx + (sx * s.size[0]) / 2, cy + (sy * s.size[1]) / 2, cz + (sz * s.size[2]) / 2]);
        return out;
      }
      case "cylinder":
        if (s.axis === "z")
          return [...ring(s.radius, cz - s.length / 2), ...ring(s.radius, cz + s.length / 2)];
        // The lever's arm runs along x; its sides are within a box of its radius.
        return [-1, 1].flatMap((sx) =>
          [-1, 1].flatMap((sy) =>
            [-1, 1].map((sz): Vec3 => [cx + (sx * s.length) / 2, cy + sy * s.radius, cz + sz * s.radius]),
          ),
        );
      case "torus":
        return ring(s.radius + s.tube, cz);
      case "sphere":
        return [-1, 1].flatMap((sx) =>
          [-1, 1].flatMap((sy) =>
            [-1, 1].map((sz): Vec3 => [cx + sx * s.radius, cy + sy * s.radius, cz + sz * s.radius]),
          ),
        );
      case "ticks":
        return ring(s.outer, cz);
      case "lettering":
        return [-1, 1].map((sx): Vec3 => [cx + (sx * s.width) / 2, cy, cz]);
    }
  }

  /** Turns a model-space point about an axis parallel to z, clockwise on screen. */
  function turn(p: Vec3, pivot: Vec3, degrees: number): Vec3 {
    const a = degrees * DEG;
    const dx = p[0] - pivot[0];
    const dy = p[1] - pivot[1];
    return [
      pivot[0] + dx * Math.cos(a) + dy * Math.sin(a),
      pivot[1] - dx * Math.sin(a) + dy * Math.cos(a),
      p[2],
    ];
  }

  it("holds every part at every yaw, every hand angle and every lever angle", () => {
    const right = FRAME.x + FRAME.width;
    const bottom = FRAME.y + FRAME.height;
    for (const part of PARTS) {
      const angles = !part.turns
        ? [0]
        : part.turns.by === "lever"
          ? Array.from({ length: 22 }, (_, i) => part.turns!.rest + (LEVER.strike * i) / 21)
          : Array.from({ length: 24 }, (_, i) => i * 15);
      for (const yaw of [-6, -3, 0, 3, 6]) {
        for (const angle of angles) {
          for (const p of surface(part)) {
            const [x, y] = project(part.turns ? turn(p, part.turns.pivot, angle) : p, yaw);
            expect(x, part.name).toBeGreaterThan(FRAME.x);
            expect(x, part.name).toBeLessThan(right);
            expect(y, part.name).toBeGreaterThan(FRAME.y);
            expect(y, part.name).toBeLessThan(bottom);
          }
        }
      }
    }
    for (const yaw of [-6, 0, 6]) {
      for (const [x, y] of caseOutline(yaw)) {
        expect(x).toBeGreaterThan(FRAME.x);
        expect(x).toBeLessThan(right);
        expect(y).toBeGreaterThan(FRAME.y);
        expect(y).toBeLessThan(bottom);
      }
    }
  });

  it("turns the lever's knob up at rest and down at the bottom of a strike", () => {
    const knob = PARTS.find((p) => p.name === "leverKnob")!;
    const atRest = turn(knob.at, LEVER.pivot, LEVER.rest);
    const struck = turn(knob.at, LEVER.pivot, LEVER.rest + LEVER.strike);
    expect(atRest[1]).toBeGreaterThan(LEVER.pivot[1]);
    expect(struck[1]).toBeLessThan(LEVER.pivot[1]);
  });
});
