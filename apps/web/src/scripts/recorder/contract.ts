/**
 * The interface between the front page's script and the WebGL Recorder.
 *
 * The page script runs eagerly and owns every decision: when the scene may load, what time the
 * hands show, how far the clock has turned, when the lever strikes. The scene (`scene.ts`, loaded
 * lazily with three.js) only draws what it is told. Its module's default export is a `CreateScene`;
 * this file holds types only, so importing it costs the page nothing.
 */

/** Everything one frame of the clock depends on; the scene keeps no clock or tween of its own. */
export interface RecorderState {
  /** The time the hands show, in UTC seconds since midnight; fractions sweep the hands smoothly. */
  utcSecondsOfDay: number;
  /** How far the clock is turned about its upright axis, in degrees; geometry.ts clamps it to plus or minus 6. */
  yaw: number;
  /** Where the lever is in one strike, 0..1, as `leverAngle` in geometry.ts reads it; 0 is at rest. */
  lever: number;
  /** How far the card has come out of the clock toward the viewer, 0..1; 0 is seated in the throat. */
  eject: number;
  /** The edition showing; on a change the scene reads the colour tokens again from the canvas's computed style. */
  edition: "day" | "night";
}

/** A running scene. It draws only when `render` is called; an idle page draws nothing. */
export interface RecorderScene {
  /** Draws one frame of the clock in the given state. */
  render(state: RecorderState): void;
  /** Sizes the drawing buffer to the canvas's CSS box at the given device pixel ratio. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  /** Frees the GL context, its buffers and its texture; the scene is not used again after this. */
  dispose(): void;
}

/** The tokens the scene paints with, as the computed values of the same names in tokens.css. */
export type RecorderColors = Record<"newsprint" | "card" | "enamel" | "carbon" | "brass" | "ribbon", string>;

/**
 * Builds the scene on a canvas the page has already placed. It resolves once the scene can draw
 * its first frame (the sign's lettering needs `signFontFamily` loaded) and rejects if WebGL cannot
 * be used, in which case the page keeps the SVG Recorder.
 */
export type CreateScene = (
  canvas: HTMLCanvasElement,
  options: { colors: RecorderColors; signFontFamily: string },
) => Promise<RecorderScene>;
