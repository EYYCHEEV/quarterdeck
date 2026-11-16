import { createHash } from "node:crypto";

const REGISTRY = "https://registry.npmjs.org/";
const MODULES = "node_modules/";
const NONE = "none";
const COMMIT = /^[0-9a-f]{40}$/;
const HEADER = /^t3-code-commit ([0-9a-f]{40}) pnpm-lock-sha256 ([0-9a-f]{64})$/;
const PNPM_KEY = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s'(]+)@([^(:'\s]+)/;
const PNPM_INTEGRITY = /^ {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)/;
const PIN = /^(\S+@[^@\s]+) (sha512-[A-Za-z0-9+/=]+|none)$/;
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function pinsFromPnpmLock(text) {
  const pins = new Map();
  let section = "";
  let current = null;
  for (const line of text.split("\n")) {
    if (line !== "" && !line.startsWith(" ")) {
      section = line.replace(/:+$/, "");
      current = null;
      continue;
    }
    if (section !== "packages") continue;
    const key = PNPM_KEY.exec(line);
    if (key !== null) {
      current = `${key[1]}@${key[2]}`;
      if (!pins.has(current)) pins.set(current, NONE);
      continue;
    }
    const integrity = PNPM_INTEGRITY.exec(line);
    if (integrity !== null && current !== null) {
      pins.set(current, integrity[1]);
      current = null;
    }
  }
  return [...pins.keys()].sort().map((pair) => `${pair} ${pins.get(pair)}`);
}

export function makeList(lockBytes, commit) {
  if (!COMMIT.test(commit)) throw new Error("the commit must be 40 lowercase hex characters");
  const pins = pinsFromPnpmLock(new TextDecoder().decode(lockBytes));
  if (pins.length === 0) throw new Error("no package was found in the lockfile");
  const digest = createHash("sha256").update(lockBytes).digest("hex");
  return `t3-code-commit ${commit} pnpm-lock-sha256 ${digest}\n${pins.join("\n")}\n`;
}

export function readList(text) {
  const [first = "", ...rest] = text.split("\n");
  const header = HEADER.exec(first);
  const faults = [];
  if (header === null) faults.push("the list's first line does not name a commit and a lockfile hash");
  const pins = new Map();
  const names = new Set();
  for (const line of rest) {
    if (line === "") continue;
    const pin = PIN.exec(line);
    if (pin === null) {
      faults.push(`not a name, a version and a sha512: ${line}`);
      continue;
    }
    pins.set(pin[1], pin[2]);
    names.add(pin[1].slice(0, pin[1].lastIndexOf("@")));
  }
  if (pins.size === 0) faults.push("the list names no package");
  return { commit: header?.[1] ?? "", lockSha256: header?.[2] ?? "", pins, names, faults };
}

const isInside = (path) =>
  !path.includes("\\") &&
  !path.includes(":") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

function isWorkspace(packages, path) {
  const declared = packages[""]?.workspaces;
  return isInside(path) && Array.isArray(declared) && declared.includes(path);
}

function isPinned(pins, key, entry) {
  const name = entry.name ?? key.slice(key.lastIndexOf(MODULES) + MODULES.length);
  const integrity = entry.integrity ?? "";
  return (
    entry.link !== true &&
    entry.inBundle !== true &&
    (entry.resolved ?? "").startsWith(REGISTRY) &&
    integrity.startsWith("sha512-") &&
    pins.get(`${name}@${entry.version ?? ""}`) === integrity
  );
}

function folderFault(packages, key, entry) {
  if (key !== "" && !isWorkspace(packages, key)) return "folder that is not a declared workspace";
  if (entry.resolved !== undefined || entry.integrity !== undefined) {
    return "folder with a source of its own";
  }
  return "";
}

function linkFault(packages, key, resolved) {
  if (!isInside(resolved)) return "link to an outside source";
  if (!isWorkspace(packages, resolved)) return "link to a folder that is not a declared workspace";
  if (key !== `${MODULES}${packages[resolved]?.name ?? ""}`) {
    return "link under another name than its workspace's own";
  }
  return "";
}

function bundledFault(packages, pins, key, entry) {
  const cut = key.lastIndexOf(`/${MODULES}`);
  const parentKey = key.slice(0, Math.max(cut, 0));
  const parent = packages[parentKey];
  if (entry.resolved !== undefined || entry.integrity !== undefined) {
    return "bundled part with a source of its own";
  }
  if (parent === undefined || !parentKey.includes(MODULES) || !isPinned(pins, parentKey, parent)) {
    return "bundled part under a parent that is not a pinned registry package";
  }
  const carried = parent.bundleDependencies;
  if (!Array.isArray(carried) || !carried.includes(key.slice(cut + 1 + MODULES.length))) {
    return "bundled part that its parent does not list";
  }
  return "";
}

export function checkLock(lock, list) {
  const breaches = [...list.faults];
  const links = [];
  const bundled = [];
  let registry = 0;
  const packages = lock.packages ?? {};
  const entries = Object.entries(packages).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [key, entry] of entries) {
    const cut = key.lastIndexOf(MODULES);
    if (cut === -1) {
      const fault = folderFault(packages, key, entry);
      if (fault !== "") breaches.push(`${fault}: ${key}`);
      continue;
    }
    const name = entry.name ?? key.slice(cut + MODULES.length);
    const version = entry.version ?? "";
    const resolved = entry.resolved ?? "";
    if (entry.link === true) {
      links.push(`${key} -> ${resolved}`);
      const fault = linkFault(packages, key, resolved);
      if (fault !== "") breaches.push(`${fault}: ${key} -> ${resolved}`);
      continue;
    }
    if (entry.inBundle === true) {
      bundled.push(`${name}@${version} (${key})`);
      const fault = bundledFault(packages, list.pins, key, entry);
      if (fault !== "") breaches.push(`${fault}: ${name}@${version} (${key})`);
      continue;
    }
    registry += 1;
    const integrity = entry.integrity ?? "";
    const hashed = integrity.startsWith("sha512-");
    const pinned = list.pins.get(`${name}@${version}`);
    if (!resolved.startsWith(REGISTRY)) {
      breaches.push(
        `not from registry.npmjs.org: ${name}@${version} resolved ${resolved === "" ? "missing" : resolved}`,
      );
    }
    if (!hashed) breaches.push(`no sha512 integrity: ${name}@${version} (${key})`);
    if (!EXACT.test(version)) breaches.push(`not an exact version: ${name}@${version} (${key})`);
    if (pinned === undefined) {
      breaches.push(
        list.names.has(name)
          ? `T3 Code pins another version: ${name}@${version} (${key})`
          : `name not in T3 Code's list: ${name}@${version} (${key})`,
      );
    } else if (pinned === NONE) {
      breaches.push(`T3 Code's list holds no sha512 for: ${name}@${version} (${key})`);
    } else if (hashed && pinned !== integrity) {
      breaches.push(`integrity differs from T3 Code's: ${name}@${version} (${key})`);
    }
  }
  if (registry === 0) breaches.push("the lockfile holds no registry package");
  return { registry, links, bundled, breaches };
}
