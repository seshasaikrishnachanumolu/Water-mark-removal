import { describe, expect, it } from "vitest";
import {
  animState,
  curveMean,
  resolveFreeStart,
  sliceCurve,
  snapStart,
  sourceTime,
  speedAt,
  trackAccepts,
  trimLeftPatch,
  trimRightPatch,
} from "./timeline";

const clip = (o = {}) => ({ id: "c", trackId: "t", kind: "video", start: 0, duration: 10, in: 0, speed: 1, curve: null, ...o });

describe("sourceTime", () => {
  it("maps linearly at constant speed", () => {
    const c = clip({ start: 5, in: 2, speed: 2 });
    expect(sourceTime(c, 5)).toBe(2);
    expect(sourceTime(c, 8)).toBe(8); // 2 + 3*2
  });

  it("integrates a speed ramp exactly", () => {
    // 0.5x -> 2x over 10s: mean 1.25, so 10s of timeline covers 12.5s of source.
    const c = clip({ curve: [{ t: 0, v: 0.5 }, { t: 1, v: 2 }] });
    expect(curveMean(c.curve)).toBeCloseTo(1.25);
    expect(sourceTime(c, 10)).toBeCloseTo(12.5);
    // halfway: area under v(u)=0.5+1.5u over u in [0, 0.5] times 10
    expect(sourceTime(c, 5)).toBeCloseTo(10 * (0.5 * 0.5 + 0.75 * 0.25));
  });

  it("is monotonic (never plays backwards)", () => {
    const c = clip({ curve: [{ t: 0, v: 1 }, { t: 0.4, v: 3 }, { t: 0.7, v: 0.25 }, { t: 1, v: 1 }] });
    let prev = -1;
    for (let t = 0; t <= 10; t += 0.1) {
      const s = sourceTime(c, t);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});

describe("speedAt", () => {
  it("interpolates the curve and falls back to constant speed", () => {
    expect(speedAt(clip({ speed: 1.5 }), 3)).toBe(1.5);
    const c = clip({ curve: [{ t: 0, v: 1 }, { t: 1, v: 3 }] });
    expect(speedAt(c, 5)).toBeCloseTo(2);
  });
});

describe("curve slicing and trimming", () => {
  const curve = [{ t: 0, v: 1 }, { t: 0.5, v: 3 }, { t: 1, v: 1 }];

  it("keeps the source position continuous across a split", () => {
    const c = clip({ curve });
    const x = 0.3;
    const left = sliceCurve(curve, 0, x), right = sliceCurve(curve, x, 1);
    const splitAt = 3;
    const leftClip = clip({ duration: splitAt, curve: left });
    const rightClip = clip({ start: splitAt, duration: 7, in: sourceTime(c, splitAt), curve: right });
    // End of left half == start of right half, and the right half ends where the original did.
    expect(sourceTime(leftClip, splitAt)).toBeCloseTo(sourceTime(c, splitAt));
    expect(sourceTime(rightClip, 10)).toBeCloseTo(sourceTime(c, 10));
    expect(sourceTime(rightClip, 6)).toBeCloseTo(sourceTime(c, 6));
  });

  it("trimLeft keeps later frames in sync", () => {
    const c = clip({ curve });
    const patch = trimLeftPatch(c, 2, true);
    const trimmed = { ...c, ...patch };
    expect(trimmed.start).toBe(2);
    expect(trimmed.duration).toBe(8);
    for (const t of [2, 4, 7, 10]) expect(sourceTime(trimmed, t)).toBeCloseTo(sourceTime(c, t));
  });

  it("trimRight keeps the same frames and only shortens", () => {
    const c = clip({ curve });
    const trimmed = { ...c, ...trimRightPatch(c, 6) };
    for (const t of [0, 2, 6]) expect(sourceTime(trimmed, t)).toBeCloseTo(sourceTime(c, t));
  });

  it("constant-speed trim moves `in` by d * speed", () => {
    const c = clip({ speed: 2, in: 1 });
    expect(trimLeftPatch(c, 1.5, true).in).toBe(4);
    expect(trimLeftPatch(c, 1.5, false).in).toBe(0); // generated clips have no source
  });
});

describe("resolveFreeStart", () => {
  const clips = {
    a: clip({ id: "a", start: 0, duration: 4 }),
    b: clip({ id: "b", start: 4, duration: 3 }),
    other: clip({ id: "o", trackId: "other", start: 0, duration: 99 }),
  };
  it("pushes past colliding clips on the same track", () => {
    expect(resolveFreeStart(clips, "t", null, 1, 2)).toBe(7);
    expect(resolveFreeStart(clips, "t", null, 8, 2)).toBe(8);
  });
  it("ignores other tracks and the clip itself", () => {
    expect(resolveFreeStart(clips, "t", "a", 0, 4)).toBe(0);
  });
});

describe("snapStart", () => {
  it("snaps the start or the end to a nearby edge", () => {
    expect(snapStart(4.95, 2, [5], 0.2)).toBe(5);
    expect(snapStart(2.9, 2, [5], 0.2)).toBeCloseTo(3); // end 4.9 -> 5
    expect(snapStart(1, 2, [5], 0.2)).toBe(1); // too far
  });
});

describe("trackAccepts", () => {
  it("routes clip kinds to the right track types", () => {
    expect(trackAccepts("video", "video")).toBe(true);
    expect(trackAccepts("overlay", "image")).toBe(true);
    expect(trackAccepts("audio", "video")).toBe(false);
    expect(trackAccepts("text", "text")).toBe(true);
    expect(trackAccepts("overlay", "shape")).toBe(true);
    expect(trackAccepts("video", "text")).toBe(false);
  });
});


describe("animState", () => {
  const c = (props) => ({ start: 2, duration: 4, props });
  it("is neutral with no animation or mid-clip", () => {
    expect(animState(c({}), 3)).toEqual({ alpha: 1, scale: 1, dy: 0 });
    expect(animState(c({ animIn: { type: "fade", dur: 0.5 } }), 3).alpha).toBe(1);
  });
  it("fades in from 0 and out to 0", () => {
    const p = { animIn: { type: "fade", dur: 1 }, animOut: { type: "fade", dur: 1 } };
    expect(animState(c(p), 2).alpha).toBe(0);
    expect(animState(c(p), 2.5).alpha).toBeCloseTo(0.5);
    expect(animState(c(p), 6).alpha).toBe(0);
    expect(animState(c(p), 5.5).alpha).toBeCloseTo(0.5);
  });
  it("zoom, slide and pop modify scale/offset", () => {
    expect(animState(c({ animIn: { type: "zoom", dur: 1 } }), 2).scale).toBeCloseTo(0.6);
    expect(animState(c({ animIn: { type: "slide", dur: 1 } }), 2).dy).toBeCloseTo(0.12);
    expect(animState(c({ animOut: { type: "slide", dur: 1 } }), 6).dy).toBeCloseTo(-0.12);
    expect(animState(c({ animIn: { type: "pop", dur: 1 } }), 2).scale).toBeCloseTo(0);
  });
  it("clamps animation length to half the clip so in and out never collide", () => {
    const p = { animIn: { type: "fade", dur: 99 }, animOut: { type: "fade", dur: 99 } };
    expect(animState(c(p), 4).alpha).toBeCloseTo(1); // exactly mid-clip
  });
});
