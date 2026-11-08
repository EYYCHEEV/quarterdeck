import fs from "node:fs";
import path from "node:path";

const ROOT = "src";
const FIRST_SCREEN = "queue";
const SCREEN_DATA = new Set(["data/hooks.tsx", "data/session.ts", "data/settings.ts", "data/chat-hooks.ts", "data/chat-types.ts", "data/secret-hooks.ts", "data/secret-types.ts", "data/bots-hooks.ts", "data/source.ts", "data/card-detail.ts", "data/attachment-text.ts"]);
const PACKAGES = { domain: [], platform: ["react"], data: ["react"], ui: ["react"], screens: ["react"], shell: ["react", "react-dom"] };
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const STYLED = new Set(["ui", "screens", "shell"]);
const RETIRED = [
  [/\b(?:accentFill|paintAccent|inkContrast|ACCENT_INK|PRESETS|SECOND_STOP|CustomEditor)\b|--accent-[a-z]+/g, "code of the removed gradient themes (C-15)"],
  [/\b(?:linear|radial|conic)-gradient\(/g, "a gradient in code (C-15: the look is solid)"],
];
const RAW_STYLE = [
  [/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g, "a raw hex colour"],
  [/\btext-\[\d+(?:\.\d+)?(?:px|rem|em)\]/g, "a bracketed font size"],
];
const NETWORK_FILES = new Set(["data/api-client.ts"]);
const BROWSER_ONLY = [
  [/(?<![\w.$])fetch\(|\b(?:window|globalThis|self)\.fetch\(/g, "a direct network call, which only platform/ and data/api-client.ts may make; use fetchText from platform/read-text", NETWORK_FILES],
  [/\bEventSource\b/g, "a direct event-stream call; use watchEvents from platform/events"],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b/g, "browser storage; use readJson and writeJson from platform/storage"],
  [/\bnavigator\.clipboard\b|\bdocument\.execCommand\b/g, "a direct clipboard call; use copyText from platform/copy"],
  [/\b(?:window|globalThis)\.open\(/g, "a direct new-window call; use openOutside from platform/open-link"],
  [/\btarget\s*[=:]\s*\{?\s*["']_blank["']/g, "an inline new-tab link; spread outsideLink(url) from platform/open-link"],
  [/\btype\s*[=:]\s*\{?\s*["']file["']/g, "an inline file input; use useFilePicker from platform/pick-files"],
  [/\b(?:window|globalThis)\.(?:alert|confirm|prompt)\(/g, "a native pop-up; render a Dialog from ui/overlay instead"],
  [/\bNotification\b|\bserviceWorker\b|\bPushManager\b/g, "a browser notification or push call; none is allowed outside platform/"],
  [/\bstartViewTransition\b/g, "a direct screen-change call; only platform/ may start a view transition"],
  [/\.animate\(/g, "a direct animation call on an element; only platform/ may animate by script"],
  [/\bgetAnimations\b/g, "a direct read of the running animations; only platform/ may read them"],
  [/\bmatchMedia\(\s*["'`]\s*\(?\s*prefers-reduced-motion/g, "a script read of the Reduce Motion setting; only platform/ may read it (the CSS media rule in theme.css stays)"],
];
const FULL_HEIGHT = [[/\b100vh\b|\b(?:min-|max-)?h-screen\b/g, "a full-height unit that ignores a phone's toolbars; use dynamic viewport units (dvh)"]];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");

function layerOf(name) {
  const [top, second] = name.split("/");
  if (top === "screens") return { layer: "screens", screen: second };
  return { layer: top };
}

function importsOf(file) {
  const source = fs.readFileSync(file, "utf8");
  const found = [];
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g)) found.push({ spec: match[1], lazy: false, typeOnly: /^\s*(?:import|export)\s+type\s/.test(match[0].trim()) });
  for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push({ spec: match[1], lazy: true, typeOnly: false });
  return found;
}

function matches(name, source, rules, advice) {
  const found = [];
  source.split("\n").forEach((line, at) => {
    for (const [pattern, what] of rules) for (const match of line.matchAll(pattern)) found.push(`${name}:${at + 1}: ${match[0]} is ${what}${advice}`);
  });
  return found;
}

function resolve(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const ext of EXTENSIONS) if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return rel(base + ext);
  return null;
}

const files = walk(ROOT);
const problems = [];
const edges = new Map();

for (const file of files) {
  const name = rel(file);
  const from = layerOf(name);
  if (!(from.layer in PACKAGES)) {
    problems.push(`${name}: lives outside the layers (domain, platform, data, ui, screens, shell)`);
    continue;
  }
  const source = fs.readFileSync(file, "utf8");
  if (STYLED.has(from.layer)) problems.push(...matches(name, source, RAW_STYLE, "; use a token from ui/theme.css"));
  problems.push(...matches(name, source, RETIRED, ""));
  if (STYLED.has(from.layer)) problems.push(...matches(name, source, FULL_HEIGHT, ""));
  if (from.layer !== "platform") problems.push(...matches(name, source, BROWSER_ONLY.filter((rule) => !rule[2]?.has(name)), ""));
  const targets = [];
  for (const item of importsOf(file)) {
    if (!item.spec.startsWith(".")) {
      const pkg = item.spec.split("/")[0];
      if (!PACKAGES[from.layer].includes(pkg)) problems.push(`${name}: imports the package "${item.spec}", which ${from.layer}/ may not use`);
      continue;
    }
    const target = resolve(file, item.spec);
    if (!target) {
      problems.push(`${name}: imports "${item.spec}", which does not resolve`);
      continue;
    }
    if (target.endsWith(".json")) continue;
    targets.push(target);
    const to = layerOf(target);
    const say = (why) => problems.push(`${name} imports ${target}: ${why}`);
    if (from.layer === "domain" && to.layer !== "domain") say("domain/ imports nothing outside domain/");
    if (from.layer === "platform" && to.layer !== "platform") say("platform/ imports nothing of ours outside platform/");
    if (from.layer === "data" && to.layer !== "data" && to.layer !== "domain" && to.layer !== "platform") say("data/ imports only domain/ and platform/");
    if (from.layer === "ui" && to.layer !== "ui" && to.layer !== "platform") say("ui/ imports nothing outside ui/ and platform/");
    if (from.layer === "screens") {
      if (to.layer === "screens" && to.screen !== from.screen) say("a screen never imports another screen");
      if (to.layer === "shell") say("a screen never imports the shell");
      if (to.layer === "data" && !SCREEN_DATA.has(target)) say("a screen uses data hooks only, not a data source");
    }
    if (from.layer === "shell" && to.layer === "screens" && !item.lazy && !item.typeOnly && to.screen !== FIRST_SCREEN) say("the shell loads every screen but the first one lazily");
  }
  edges.set(name, targets);
}

const uiFiles = files.map(rel).filter((name) => name.startsWith("ui/") && !name.endsWith(".css"));
const usedBy = new Map(uiFiles.map((name) => [name, new Set()]));
for (const [name, targets] of edges) {
  const from = layerOf(name);
  if (from.layer !== "screens") continue;
  const seen = new Set();
  const visit = (target) => {
    if (seen.has(target) || !target.startsWith("ui/")) return;
    seen.add(target);
    usedBy.get(target)?.add(from.screen);
    for (const next of edges.get(target) ?? []) visit(next);
  };
  for (const target of targets) visit(target);
}
for (const [name, screens] of usedBy) if (!screens.size) problems.push(`${name}: a ui/ part no screen uses`);
problems.push(...matches("ui/theme.css", fs.readFileSync(path.join(ROOT, "ui/theme.css"), "utf8"), RETIRED.slice(0, 1), ""));

if (process.argv.includes("--reuse")) {
  console.log("UI kit reuse (ui part: screens that use it, directly or through another part)");
  for (const [name, screens] of [...usedBy].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))) console.log(`- ${name}: ${screens.size} (${[...screens].sort().join(", ")})`);
}

if (problems.length) {
  for (const problem of problems) console.log(`FAIL ${problem}`);
  console.log(`arch-check: FAIL, ${problems.length} problems`);
  process.exit(1);
}
console.log(`arch-check: PASS, ${files.length} files in domain, platform, data, ui, screens and shell keep the layer table, no browser-only call sits outside platform/, ui, screens and shell use theme tokens and dynamic viewport units, no raw hex colour or bracketed font size, and no code of the removed gradient themes is left`);
