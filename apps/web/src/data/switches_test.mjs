import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";

const search = "?delay=5000&fail=world,send&hold=mail-thread&fixtures=now&queue=empty&changed=3&rolled=alba-1&closed=c6&listed=2026-11-01&answered=1&mailfx=x&chatfx=y&pagenext=9";
const neutral = {
  delay: 0,
  fail: new Set(),
  fixtures: "off",
  empty: false,
  chat: null,
  mail: null,
  changed: 0,
  listed: null,
  answered: false,
  pageNext: 0,
};

for (const fixtures of [false, true]) {
  const built = await esbuild.build({
    entryPoints: ["src/data/switches.ts"],
    bundle: true,
    write: false,
    format: "esm",
    minify: true,
    define: { __QD_FIXTURES__: String(fixtures) },
  });
  const code = built.outputFiles[0].text;
  const { readSwitches } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

  test(fixtures ? "fixtures builds read every address switch" : "plain builds ignore every address switch", () => {
    assert.deepEqual(readSwitches(search), fixtures ? {
      delay: 5000,
      fail: new Set(["world", "send"]),
      hold: new Set(["mail-thread"]),
      fixtures: "now",
      empty: true,
      chat: "y",
      mail: "x",
      changed: 3,
      rolled: "alba-1",
      closed: "c6",
      listed: Date.parse("2026-11-01"),
      answered: true,
      pageNext: 9,
    } : neutral);
    assert.deepEqual(readSwitches("?fail=publish,sign-out").fail, new Set(fixtures ? ["publish", "sign-out"] : []));
    assert.deepEqual(readSwitches(""), neutral);
  });

  if (!fixtures) test("plain bundles contain no address switch reader", () => {
    for (const marker of ["URLSearchParams", "mailfx", "chatfx", "pagenext", 'get("rolled")', 'get("closed")', 'get("queue")', 'get("fail")', 'get("hold")']) assert.equal(code.includes(marker), false, marker);
  });
}
