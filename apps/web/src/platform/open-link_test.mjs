import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { openOutside, outsideLink } = await loadTs("src/platform/open-link.ts");

test("opening a link outside the app asks the browser for a new tab with no opener and no referrer", () => {
  const calls = [];
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { open: (...args) => calls.push(args) }, configurable: true, writable: true });
  try {
    openOutside("https://actual.example.com:8443/review");
  } finally {
    if (before) Object.defineProperty(globalThis, "window", before);
    else delete globalThis.window;
  }
  assert.deepEqual(calls, [["https://actual.example.com:8443/review", "_blank", "noopener,noreferrer"]]);
});

test("a link that stays a link carries the address, a new tab and no opener or referrer", () => {
  assert.deepEqual(outsideLink("https://example.com/page"), { href: "https://example.com/page", target: "_blank", rel: "noopener noreferrer" });
});
