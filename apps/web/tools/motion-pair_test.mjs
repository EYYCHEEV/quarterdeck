import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePictures } from "../motion-steps.mjs";

const WIDTH = 20;
const HEIGHT = 10;
const BASE = [17, 27, 38];

function picture(width = WIDTH, height = HEIGHT) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < data.length; at += 4) data.set([...BASE, 255], at);
  return { width, height, data };
}

function nudged(spots, shades) {
  const one = picture();
  for (const spot of spots) shades.forEach((shade, channel) => { one.data[spot * 4 + channel] += shade; });
  return one;
}

const firstPixels = (count) => Array.from({ length: count }, (_, at) => at);

test("8 pixels one shade apart on one channel count as the same picture", () => {
  const spots = firstPixels(8).map((at) => at * 3 + 1);
  assert.equal(comparePictures(picture(), nudged(spots, [0, 1, 0])), null);
});

test("pixels one shade apart on all three channels count as the same picture", () => {
  assert.equal(comparePictures(picture(), nudged([4, 9], [1, 1, 1])), null);
});

test("64 pixels one shade apart count as the same picture", () => {
  assert.equal(comparePictures(picture(), nudged(firstPixels(64), [0, 1, 0])), null);
});

test("one pixel 2 shades apart is a miss and says where", () => {
  assert.equal(comparePictures(picture(), nudged([5], [2, 0, 0])), "1 pixels differ, first at 5,0 17/27/38 vs 19/27/38");
});

test("65 pixels one shade apart are a miss, and the message lists the first 6", () => {
  const first = Array.from({ length: 6 }, (_, x) => x + ",0 17/27/38 vs 17/28/38").join("; ");
  assert.equal(comparePictures(picture(), nudged(firstPixels(65), [0, 1, 0])), "65 pixels differ, first at " + first);
});

test("pictures of different sizes are a miss", () => {
  assert.equal(comparePictures(picture(20, 10), picture(10, 20)), "the sizes differ");
});

test("an exact-equal pair counts as the same picture", () => {
  assert.equal(comparePictures(picture(), picture()), null);
});
