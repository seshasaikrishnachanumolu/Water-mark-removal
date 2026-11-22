import { beforeEach, describe, expect, it } from "vitest";
import { useEditor } from "./useEditor";

const s = () => useEditor.getState();
const videoAsset = { id: "a1", kind: "video", name: "v.mp4", url: "blob:x", duration: 10, width: 1280, height: 720 };

beforeEach(() => {
  s().reset();
  s().addAsset(videoAsset);
});

describe("adding clips", () => {
  it("places video on the video track and matches the canvas to the first video", () => {
    const id = s().addAssetClip("a1");
    const c = s().clips[id];
    expect(s().tracks.find((t) => t.id === c.trackId).type).toBe("video");
    expect(c.duration).toBe(10);
    expect(s().project).toMatchObject({ width: 1280, height: 720 });
  });

  it("appends consecutive videos with no overlap", () => {
    s().addAssetClip("a1");
    const second = s().addAssetClip("a1");
    expect(s().clips[second].start).toBe(10);
  });
});

describe("split / duplicate / delete / undo", () => {
  it("splits at the playhead with continuous source time", () => {
    const id = s().addAssetClip("a1");
    s().setTime(4);
    s().splitAtPlayhead();
    const [left, right] = Object.values(s().clips).sort((a, b) => a.start - b.start);
    expect(left.duration).toBe(4);
    expect(right.start).toBe(4);
    expect(right.in).toBe(4);
    expect(right.duration).toBe(6);
    expect(s().clips[id]).toBeDefined();
  });

  it("ignores a split too close to an edge", () => {
    s().addAssetClip("a1");
    s().setTime(0.01);
    s().splitAtPlayhead();
    expect(Object.keys(s().clips)).toHaveLength(1);
  });

  it("undo and redo restore the timeline", () => {
    const id = s().addAssetClip("a1");
    s().deleteClip(id);
    expect(Object.keys(s().clips)).toHaveLength(0);
    s().undo();
    expect(Object.keys(s().clips)).toHaveLength(1);
    s().redo();
    expect(Object.keys(s().clips)).toHaveLength(0);
  });

  it("duplicate lands after the original", () => {
    const id = s().addAssetClip("a1");
    s().duplicateClip(id);
    const starts = Object.values(s().clips).map((c) => c.start).sort((a, b) => a - b);
    expect(starts).toEqual([0, 10]);
  });
});

describe("moving clips", () => {
  it("won't overlap on a sequential track and refuses incompatible tracks", () => {
    const a = s().addAssetClip("a1");
    const b = s().addAssetClip("a1"); // starts at 10
    s().moveClip(b, 3, null);
    expect(s().clips[b].start).toBe(10); // pushed behind clip a
    const audioTrack = s().tracks.find((t) => t.type === "audio");
    s().moveClip(a, 0, audioTrack.id);
    expect(s().clips[a].trackId).not.toBe(audioTrack.id); // video clip can't go on an audio track
  });
});

describe("speed", () => {
  it("constant speed keeps the same source span (2x halves the length)", () => {
    const id = s().addAssetClip("a1");
    s().setSpeed(id, 2);
    expect(s().clips[id].duration).toBe(5);
  });

  it("a curve preserves the source span and going back restores the length", () => {
    const id = s().addAssetClip("a1");
    s().setSpeedCurve(id, [{ t: 0, v: 0.5 }, { t: 1, v: 2 }]); // mean 1.25
    expect(s().clips[id].duration).toBeCloseTo(8);
    s().setSpeedCurve(id, null);
    expect(s().clips[id].duration).toBeCloseTo(8); // unchanged; speed is now the old mean
    expect(s().clips[id].speed).toBeCloseTo(1.25);
  });

  it("splitting a curved clip keeps total source coverage", () => {
    const id = s().addAssetClip("a1");
    s().setSpeedCurve(id, [{ t: 0, v: 0.5 }, { t: 1, v: 2 }]);
    const total = (cs) => cs.reduce((n, c) => n + c.duration * c.speed, 0);
    const before = total(Object.values(s().clips));
    s().setTime(3);
    s().splitAtPlayhead();
    expect(total(Object.values(s().clips))).toBeCloseTo(before);
  });
});


describe("layers, clipboard, tracks", () => {
  const text = (t) => s().addClip({ kind: "text", trackType: "text", name: t, duration: 3, props: { text: t } });

  it("arrange reorders within a track", () => {
    const a = text("a"), b = text("b"), c = text("c");
    s().arrange(a, "front");
    const z = (id) => s().clips[id].props.z;
    expect(z(a)).toBeGreaterThan(Math.max(z(b), z(c)));
    s().arrange(a, "back");
    expect(z(a)).toBeLessThan(Math.min(z(b), z(c)));
    s().arrange(b, "up");
    expect(z(b)).toBeGreaterThan(z(c));
  });

  it("copy then paste lands at the playhead on the same track, as a new clip", () => {
    const a = text("a");
    s().select(a);
    s().copyClip();
    s().setTime(7);
    s().pasteClip();
    const clips = Object.values(s().clips);
    expect(clips).toHaveLength(2);
    const copy = clips.find((c) => c.id !== a);
    expect(copy.start).toBe(7);
    expect(copy.trackId).toBe(s().clips[a].trackId);
    expect(copy.props.text).toBe("a");
  });

  it("paste is a no-op without a copy", () => {
    s().pasteClip();
    expect(Object.keys(s().clips)).toHaveLength(0);
  });

  it("moveTrack swaps stacking order and undo restores it", () => {
    const before = s().tracks.map((t) => t.id);
    s().moveTrack(before[1], -1);
    expect(s().tracks.map((t) => t.id).slice(0, 2)).toEqual([before[1], before[0]]);
    s().moveTrack(before[0], -1); // already? index 1 now -> goes to 0
    s().undo();
    s().undo();
    expect(s().tracks.map((t) => t.id)).toEqual(before);
  });

  it("hydrate fills new properties for projects saved before they existed", () => {
    const a = text("old");
    const { z, animIn, sepia, ...legacy } = s().clips[a].props;
    s().hydrate({ project: { width: 1280, height: 720, fps: 30 }, tracks: s().tracks, assets: {},
      clips: { [a]: { ...s().clips[a], props: legacy } } });
    expect(s().clips[a].props.animIn.type).toBe("none");
    expect(s().project.background).toBe("#000000");
  });
});
