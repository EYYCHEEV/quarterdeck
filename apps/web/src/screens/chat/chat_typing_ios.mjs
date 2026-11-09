import { readFileSync } from "node:fs";

const PROBE = readFileSync(new URL("./typing_probe.js", import.meta.url), "utf8");
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const ENTER = "\uE007";
const KEYBOARD_MS = 20000;
const LOAD_MS = 30000;
const CALL_MS = 120000;

const need = (name) => {
  const value = process.env[name];
  if (value) return value;
  console.log(name + " is not set");
  process.exit(1);
};
const ORIGIN = need("QD_ORIGIN").replace(/\/+$/, "");
const DRIVER = need("QD_WEBDRIVER").replace(/\/+$/, "");
const UDID = need("QD_UDID");
const RUNTIME = need("QD_RUNTIME");
const EXPECT = process.env.QD_EXPECT ?? "";
if (EXPECT !== "" && EXPECT !== "shrink") {
  console.log("QD_EXPECT is either unset or shrink, not " + JSON.stringify(EXPECT));
  process.exit(1);
}

const call = async (method, path, body) => {
  const response = await fetch(DRIVER + path, {
    method,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_MS),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path}: HTTP ${response.status}, not JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok || data?.value?.error) throw new Error(`${method} ${path}: ${data?.value?.error ?? "HTTP " + response.status}: ${data?.value?.message ?? ""}`);
  return data.value;
};

const CASES = [
  {
    name: "at the end of the chat: typing 40 keys and a Return after a two-line draft keeps the newest message just above the composer and the composer's bottom still in every painted frame, and nothing gets shorter while the box measures",
    mode: "end",
    tapFirst: true,
  },
  {
    name: "the box tapped, then scrolled up to read older messages: typing 40 keys and a Return after a two-line draft never moves the message being read in any painted frame, and nothing gets shorter while the box measures",
    mode: "reading",
    tapFirst: true,
  },
  {
    name: "scrolled up to read older messages, then the box tapped: typing 40 keys and a Return after a two-line draft never moves the message being read in any painted frame, and nothing gets shorter while the box measures",
    mode: "reading",
    tapFirst: false,
  },
];

let session;
try {
  session = await call("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "safari", platformName: "iOS", "safari:useSimulator": true, "safari:deviceUDID": UDID } },
  });
} catch (error) {
  console.log(`FAIL [iOS ${RUNTIME}] no WebDriver session: ${error.message}`);
  process.exit(1);
}
const S = "/session/" + session.sessionId;
const run = (script, args = []) => call("POST", S + "/execute/sync", { script, args });
const wait = (script, args = []) => call("POST", S + "/execute/async", { script, args });
const settled = () => wait("window.qdProbe.settled().then(() => arguments[0](true));");

const ready = async ({ mode, tapFirst }) => {
  await call("POST", S + "/url", { url: ORIGIN + "/chat/iris" });
  const shown = await wait(
    "const [css, ms, done] = arguments; const until = performance.now() + ms; const look = () => (document.querySelector(css) ? done(true) : performance.now() > until ? done(false) : requestAnimationFrame(look)); look();",
    ['[data-testid="chat-bot-message"]', LOAD_MS],
  );
  if (!shown) throw new Error(`the chat showed no message within ${LOAD_MS / 1000} s`);
  await run(PROBE + "\nreturn true;");
  if (!(await wait("window.qdProbe.draft().then(arguments[0]);"))) throw new Error("the two-line draft did not reach the box");
  const input = (await call("POST", S + "/element", { using: "css selector", value: '[data-testid="chat-input"]' }))[ELEMENT];
  const state = () => run(
    "const box = arguments[0]; return { focused: document.activeElement === box, visible: Math.round(window.visualViewport ? window.visualViewport.height : -1), inner: window.innerHeight };",
    [{ [ELEMENT]: input }],
  );
  const tap = async () => {
    const before = await state();
    await call("POST", S + "/actions", {
      actions: [{
        type: "pointer",
        id: "finger",
        parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, origin: { [ELEMENT]: input }, x: 0, y: 0 },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 80 },
          { type: "pointerUp", button: 0 },
        ],
      }],
    });
    await call("DELETE", S + "/actions");
    const raised = await wait("window.qdProbe.keyboard(arguments[0]).then(arguments[1]);", [KEYBOARD_MS]);
    const after = await state();
    const seen = `box focused ${after.focused}, visible height ${before.visible} then ${after.visible} of ${after.inner}`;
    console.log("     tap: " + seen);
    if (!raised) throw new Error(`no on-screen keyboard: the visible height did not drop within ${KEYBOARD_MS / 1000} s of tapping the box (${seen})`);
  };
  if (tapFirst) await tap();
  await run("window.qdProbe.toEnd(); return true;");
  await settled();
  if (mode === "reading") {
    const place = await run("return window.qdProbe.upBy(400);");
    if (!(place.top > 0 && place.top < place.max - 100)) throw new Error(`could not scroll up into older messages (${place.top} of ${place.max})`);
    await settled();
  }
  if (!tapFirst) await tap();
  await settled();
  await run("return window.qdProbe.start(arguments[0]);", [mode]);
  return input;
};

let passed = 0;
try {
  for (const item of CASES) {
    const label = `[iOS ${RUNTIME}] ${item.name}`;
    let result;
    try {
      const input = await ready(item);
      for (const key of await run("return window.qdProbe.KEYS;")) {
        await call("POST", S + "/element/" + input + "/value", { text: key === "\n" ? ENTER : key });
        await wait("window.qdProbe.settled().then(() => arguments[1](window.qdProbe.take(arguments[0])));", [key]);
      }
      result = await run("return window.qdProbe.verdict();");
    } catch (error) {
      console.log(`FAIL ${label}: ${error.message}`);
      continue;
    }
    const shrink = result.fails.find((f) => f.rule === "shrink");
    const good = EXPECT === "shrink" ? Boolean(shrink) : result.fails.length === 0;
    const detail = EXPECT === "shrink" ? (shrink ? ": red on the shrink rule, as planted: " + shrink.line : ": the planted shrink was not seen") : good ? "" : `: ${result.fails.length} jumps, first ${result.fails[0].line}`;
    if (good) passed += 1;
    console.log(`${good ? "ok  " : "FAIL"} ${label}${detail}`);
    console.log("     " + JSON.stringify(result.env));
    for (const f of result.fails.slice(0, 40)) console.log("     fail " + f.rule + ": " + f.line);
    for (const line of result.rows) console.log("       " + line);
  }
} finally {
  await call("DELETE", S).catch((error) => console.log("could not end the WebDriver session: " + error.message));
}

console.log(`chat typing (iOS ${RUNTIME}${EXPECT ? ", the planted shrink expected" : ""}): ${passed} of ${CASES.length} pass`);
process.exit(passed === CASES.length ? 0 : 1);
