import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { shortPartPlugin } from "./short-part.mjs";

const preview = process.argv.includes("--preview");
const fixtures = process.argv.includes("--fixtures");
const server = process.argv.includes("--server");
const chat = process.argv.includes("--chat");
const outdir = preview ? "preview" : "dist";
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
const ENTRY = "src/shell/main.tsx";
const options = {
  entryPoints: [{ in: ENTRY, out: "app" }],
  bundle: true,
  outdir,
  splitting: !preview,
  chunkNames: "chunk-[hash]",
  format: preview ? "iife" : "esm",
  jsx: "automatic",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  loader: { ".html": "text" },
  define: { __QD_PREVIEW__: preview ? "true" : "false", __QD_FIXTURES__: fixtures ? "true" : "false", __QD_SOURCE__: server ? '"server"' : '"example"', __QD_CHAT__: server && chat ? '"on"' : '"off"', "process.env.NODE_ENV": '"production"' },
};
const probe = await esbuild.build({ ...options, write: false, plugins: preview ? [] : [shortPartPlugin()] });
const graph = probe.metafile.inputs;
const firstLoad = new Set();
const walkStatic = (file) => {
  if (firstLoad.has(file)) return;
  firstLoad.add(file);
  for (const item of graph[file].imports) if (item.kind === "import-statement" && graph[item.path] && !item.path.endsWith(".json")) walkStatic(item.path);
};
walkStatic(ENTRY);
const lazyRoots = new Set(Object.values(graph).flatMap((input) => input.imports.filter((item) => item.kind === "dynamic-import").map((item) => item.path)));
const firstLoadTogether = {
  name: "first-load-together",
  setup(build) {
    build.onResolve({ filter: /^qd:first-load$/ }, () => ({ path: "first-load", namespace: "qd" }));
    build.onLoad({ filter: /.*/, namespace: "qd" }, () => ({
      contents: [...firstLoad].map((file) => `import ${JSON.stringify(path.resolve(file))};`).join("\n"),
      resolveDir: process.cwd(),
      loader: "js",
    }));
    build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
      const file = path.relative(process.cwd(), args.path).split(path.sep).join("/");
      if (!lazyRoots.has(file)) return undefined;
      return { contents: 'import "qd:first-load";\n' + (await fs.promises.readFile(args.path, "utf8")), loader: path.extname(file).slice(1) };
    });
  },
};
const built = await esbuild.build({ ...options, plugins: preview ? [] : [shortPartPlugin(), firstLoadTogether] });
await esbuild.stop();
const outputs = built.metafile.outputs;
const appKey = Object.keys(outputs).find((key) => path.basename(key) === "app.js");
const eager = new Set();
const collect = (key) => {
  for (const item of outputs[key].imports) {
    if (item.kind !== "import-statement" || eager.has(item.path)) continue;
    eager.add(item.path);
    collect(item.path);
  }
};
collect(appKey);
const prefix = preview ? "" : "/";
const preloads = [...eager].map((key) => `<link rel="modulepreload" href="${prefix}${path.basename(key)}">\n`).join("");
const html = fs
  .readFileSync("index.html", "utf8")
  .replace('href="/app.css"', `href="${prefix}app.css"`)
  .replace("</head>", preloads + "</head>")
  .replace('<script type="module" src="/app.js">', preview ? '<script defer src="app.js">' : `<script type="module" src="${prefix}app.js">`);
fs.writeFileSync(path.join(outdir, "index.html"), html);
if (preview) {
  const sheets = new Set(fs.readdirSync("public").filter((name) => name.endsWith(".css")));
  const appFile = path.join(outdir, "app.js");
  let relative = 0;
  const code = fs.readFileSync(appFile, "utf8").replace(/(["'`])\/([\w.-]+\.css)\1/g, (whole, quote, name) => (sheets.has(name) ? (relative++, quote + name + quote) : whole));
  const left = [...sheets].filter((name) => code.includes("/" + name));
  console.log("preview: " + relative + " stylesheet addresses made relative");
  if (relative === 0 || left.length) {
    console.error("preview: " + (left.length ? "root-absolute stylesheet address left for " + left.join(", ") : "no public stylesheet address found to make relative"));
    process.exit(1);
  }
  fs.writeFileSync(appFile, code);
}

const tailwind = (input) => {
  const out = spawnSync(path.join("node_modules", ".bin", "tailwindcss"), ["-i", input, "--minify"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status) {
    process.stderr.write(out.stderr);
    process.exit(out.status);
  }
  return out.stdout;
};
const css = tailwind("src/ui/theme.css");
fs.writeFileSync(path.join(outdir, "app.css"), css);
fs.writeFileSync(path.join(outdir, "motion.css"), tailwind("src/ui/motion.css"));
fs.cpSync("public", outdir, { recursive: true });
if (fixtures) fs.cpSync("fixtures", outdir, { recursive: true });

if (process.argv.includes("--sizes")) {
  const gz = (file) => zlib.gzipSync(fs.readFileSync(file)).length;
  const screenOf = (key) => {
    const roots = Object.keys(outputs[key].inputs).map((input) => input.match(/^src\/(screens\/[^/]+|shell|ui|domain|data)\//)?.[1]).filter(Boolean);
    return [...new Set(roots)].join(", ");
  };
  const first = new Set([appKey, ...eager]);
  const rows = Object.keys(outputs)
    .filter((key) => key.endsWith(".js"))
    .map((key) => ({ file: path.basename(key), first: first.has(key), raw: outputs[key].bytes, gz: gz(key), holds: screenOf(key) }))
    .sort((a, b) => Number(b.first) - Number(a.first) || b.gz - a.gz);
  rows.push({ file: "app.css", first: true, raw: Buffer.byteLength(css), gz: zlib.gzipSync(css).length, holds: "styles" });
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  console.log("| File | Loads | Size | Gzip | Holds |\n|---|---|---|---|---|");
  for (const row of rows) console.log(`| ${row.file} | ${row.first ? "first" : "lazy"} | ${kb(row.raw)} | ${kb(row.gz)} | ${row.holds} |`);
  const total = rows.filter((row) => row.first).reduce((sum, row) => sum + row.gz, 0);
  console.log(`First load, gzip: ${kb(total)} (index.html not counted)`);
}
