import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const PREVIEW = path.resolve("preview");
const CARDS_WITH_PICTURES = ["alba-1", "dale-1", "dr-kivo-2"];

const build = spawnSync(process.execPath, ["tools/build-app.mjs", "--preview"], { encoding: "utf8" });

async function pictureAddresses(preview) {
  const built = await esbuild.build({ entryPoints: ["src/data/example-data.ts"], bundle: true, write: false, format: "esm", define: { __QD_PREVIEW__: String(preview), __QD_FIXTURES__: "false" }, loader: { ".json": "json", ".html": "text" } });
  const { createExampleData } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
  const data = createExampleData({ delay: 0, fail: new Set(), fixtures: "off", empty: false });
  const byCard = {};
  for (const id of CARDS_WITH_PICTURES) {
    const evidence = await data.evidence(id);
    assert.notEqual(evidence, null, id);
    byCard[id] = [...evidence.media.flatMap((item) => [item.src, ...(item.poster ? [item.poster] : [])]), ...evidence.links.map((link) => link.shot)];
  }
  return byCard;
}

test("the preview builds", () => {
  assert.equal(build.status, 0, build.stderr);
});

test("a preview build does not make npm run lint fail on its minified colours", () => {
  const check = spawnSync(process.execPath, ["tools/colour-check.mjs"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout.split("\n").slice(-3).join("\n"));
});

test("opened from its own index.html, the preview finds every evidence picture its cards ask for", async () => {
  const page = pathToFileURL(path.join(PREVIEW, "index.html"));
  const byCard = await pictureAddresses(true);
  for (const [id, addresses] of Object.entries(byCard)) {
    assert.ok(addresses.length > 0, id);
    for (const address of addresses) {
      assert.match(address, /^evidence\/media\/[^/]+$/, id);
      const file = fileURLToPath(new URL(address, page));
      assert.ok(file.startsWith(PREVIEW + path.sep), file);
      assert.ok(fs.existsSync(file), file);
    }
  }
});

test("the preview's app.js keeps no root-absolute evidence folder for the evidence module", () => {
  const code = fs.readFileSync(path.join(PREVIEW, "app.js"), "utf8");
  assert.equal(/["'`]\/evidence\/["'`]/.test(code), false);
});

test("below a site's root, the preview's app.js and index.html name every public stylesheet relatively and nothing from the root", () => {
  const code = fs.readFileSync(path.join(PREVIEW, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(PREVIEW, "index.html"), "utf8");
  const sheets = fs.readdirSync("public").filter((name) => name.endsWith(".css"));
  const named = (slash) => sheets.flatMap((name) => [...code.matchAll(new RegExp("([\"'`])" + slash + name.replaceAll(".", "\\.") + "\\1", "g"))].map(() => slash + name));
  assert.deepEqual(named("/"), [], "root-absolute stylesheet addresses in app.js");
  assert.ok(named("").length > 0, "app.js names no public stylesheet");
  for (const name of new Set(named(""))) assert.ok(fs.existsSync(path.join(PREVIEW, name)), name);
  assert.deepEqual([...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1]), [], "root-absolute addresses in index.html");
});

test("the served build keeps the root path, which deep routes such as /projects/x/lanes need", async () => {
  const byCard = await pictureAddresses(false);
  for (const [id, addresses] of Object.entries(byCard)) {
    for (const address of addresses) {
      assert.match(address, /^\/evidence\/media\/[^/]+$/, id);
      assert.equal(new URL(address, "https://qd.example/projects/x/lanes").pathname, address);
      assert.ok(fs.existsSync("public" + decodeURIComponent(address)), address);
    }
  }
});
