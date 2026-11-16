import { createHash } from "node:crypto";

import { expect, it } from "vite-plus/test";

import { checkLock, makeList, pinsFromPnpmLock, readList } from "./versions.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const PNPM_LOCK = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  .:",
  "    devDependencies:",
  "      zeta:",
  "        specifier: 2.0.0",
  "        version: 2.0.0",
  "",
  "packages:",
  "",
  "  zeta@2.0.0:",
  "    resolution: {integrity: sha512-zeta}",
  "",
  "  '@scope/alpha@1.2.3':",
  "    resolution: {integrity: sha512-alpha}",
  "    engines: {node: '>=18'}",
  "",
  "  tarred@3.0.0:",
  "    resolution: {tarball: https://example.com/tarred.tgz}",
  "",
  "  zeta@1.9.0:",
  "    resolution: {integrity: sha512-old}",
  "",
  "snapshots:",
  "",
  "  '@scope/alpha@1.2.3(zeta@2.0.0)':",
  "    dependencies:",
  "      zeta: 2.0.0",
  "",
  "  ghost@9.9.9: {}",
  "",
].join("\n");

const PINS = [
  "@scope/alpha@1.2.3 sha512-alpha",
  "tarred@3.0.0 none",
  "zeta@1.9.0 sha512-old",
  "zeta@2.0.0 sha512-zeta",
];

const LIST = makeList(Buffer.from(PNPM_LOCK), COMMIT);

const fromRegistry = (name, version, integrity) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity,
});

const lockWith = (packages) => ({
  lockfileVersion: 3,
  packages: {
    "": { name: "made-up", workspaces: ["packages/inner"] },
    "packages/inner": { name: "@made-up/inner", version: "0.0.0" },
    "node_modules/@made-up/inner": { resolved: "packages/inner", link: true },
    "node_modules/@scope/alpha": {
      version: "1.2.3",
      resolved: "https://registry.npmjs.org/@scope/alpha/-/alpha-1.2.3.tgz",
      integrity: "sha512-alpha",
    },
    ...packages,
  },
});

const breachesOf = (packages) => checkLock(lockWith(packages), readList(LIST)).breaches;

const carrier = { ...fromRegistry("zeta", "2.0.0", "sha512-zeta"), bundleDependencies: ["inside"] };

const inside = { version: "0.0.1", inBundle: true };

it("reads only the packages part of a pnpm lockfile, sorted, once each, with each sha512", () => {
  expect(pinsFromPnpmLock(PNPM_LOCK)).toEqual(PINS);
});

it("makes the list with the commit and the lockfile's own hash on its first line", () => {
  const digest = createHash("sha256").update(Buffer.from(PNPM_LOCK)).digest("hex");
  expect(LIST).toBe(`t3-code-commit ${COMMIT} pnpm-lock-sha256 ${digest}\n${PINS.join("\n")}\n`);
});

it("refuses to make a list without a whole commit, or from a file that names no package", () => {
  expect(() => makeList(Buffer.from(PNPM_LOCK), "0123abc")).toThrow();
  expect(() => makeList(Buffer.from("lockfileVersion: '9.0'\n"), COMMIT)).toThrow();
});

it("reads the list back with its commit, its hash, its pins and its names", () => {
  const list = readList(LIST);
  expect(list.faults).toEqual([]);
  expect(list.commit).toBe(COMMIT);
  expect(list.lockSha256).toMatch(/^[0-9a-f]{64}$/);
  expect([...list.pins].map(([pair, integrity]) => `${pair} ${integrity}`)).toEqual(PINS);
  expect([...list.names]).toEqual(["@scope/alpha", "tarred", "zeta"]);
});

it("passes pinned registry packages, a declared workspace's link and a bundled part its parent lists", () => {
  const result = checkLock(
    lockWith({
      "node_modules/zeta": carrier,
      "node_modules/@scope/alpha/node_modules/zeta": fromRegistry("zeta", "1.9.0", "sha512-old"),
      "node_modules/other-name": { name: "zeta", ...fromRegistry("zeta", "2.0.0", "sha512-zeta") },
      "node_modules/zeta/node_modules/inside": inside,
    }),
    readList(LIST),
  );
  expect(result.breaches).toEqual([]);
  expect(result.registry).toBe(4);
  expect(result.links).toEqual(["node_modules/@made-up/inner -> packages/inner"]);
  expect(result.bundled).toEqual(["inside@0.0.1 (node_modules/zeta/node_modules/inside)"]);
});

it("stops on a planted version that the list does not pin", () => {
  expect(breachesOf({ "node_modules/zeta": fromRegistry("zeta", "2.0.1", "sha512-zeta") })).toEqual([
    "T3 Code pins another version: zeta@2.0.1 (node_modules/zeta)",
  ]);
});

it("stops on the right version with a planted, changed sha512", () => {
  expect(breachesOf({ "node_modules/zeta": fromRegistry("zeta", "2.0.0", "sha512-swapped") })).toEqual([
    "integrity differs from T3 Code's: zeta@2.0.0 (node_modules/zeta)",
  ]);
});

it("stops on a package for which the list holds no sha512", () => {
  expect(breachesOf({ "node_modules/tarred": fromRegistry("tarred", "3.0.0", "sha512-any") })).toEqual([
    "T3 Code's list holds no sha512 for: tarred@3.0.0 (node_modules/tarred)",
  ]);
});

it("stops on a name that the list does not hold", () => {
  expect(breachesOf({ "node_modules/omega": fromRegistry("omega", "1.0.0", "sha512-omega") })).toEqual([
    "name not in T3 Code's list: omega@1.0.0 (node_modules/omega)",
  ]);
});

it("stops on a package from another source, without a sha512, or with a loose version", () => {
  expect(
    breachesOf({
      "node_modules/zeta": {
        ...fromRegistry("zeta", "2.0.0", "sha512-zeta"),
        resolved: "https://example.com/zeta.tgz",
      },
    }),
  ).toEqual(["not from registry.npmjs.org: zeta@2.0.0 resolved https://example.com/zeta.tgz"]);
  expect(breachesOf({ "node_modules/zeta": fromRegistry("zeta", "2.0.0", "sha1-made-up") })).toEqual([
    "no sha512 integrity: zeta@2.0.0 (node_modules/zeta)",
  ]);
  expect(breachesOf({ "node_modules/zeta": fromRegistry("zeta", "^2.0.0", "sha512-zeta") })).toContain(
    "not an exact version: zeta@^2.0.0 (node_modules/zeta)",
  );
});

it("stops on a link that leaves the folder", () => {
  expect(breachesOf({ "node_modules/far": { resolved: "file:../far", link: true } })).toEqual([
    "link to an outside source: node_modules/far -> file:../far",
  ]);
});

it("stops on a link that climbs out of the folder, or starts at the root", () => {
  for (const resolved of ["../far", "packages/inner/../../../far", "/far"]) {
    expect(breachesOf({ "node_modules/far": { resolved, link: true } })).toEqual([
      `link to an outside source: node_modules/far -> ${resolved}`,
    ]);
  }
});

it("stops on a link to a folder that is not a declared workspace", () => {
  expect(
    breachesOf({
      "packages/other": { name: "@made-up/other", version: "0.0.0" },
      "node_modules/@made-up/other": { resolved: "packages/other", link: true },
    }),
  ).toEqual([
    "link to a folder that is not a declared workspace: node_modules/@made-up/other -> packages/other",
    "folder that is not a declared workspace: packages/other",
  ]);
});

it("stops on a link under another name than its workspace's own", () => {
  expect(breachesOf({ "node_modules/zeta": { resolved: "packages/inner", link: true } })).toEqual([
    "link under another name than its workspace's own: node_modules/zeta -> packages/inner",
  ]);
});

it("stops on a bundled part that its parent does not list", () => {
  expect(
    breachesOf({
      "node_modules/zeta": fromRegistry("zeta", "2.0.0", "sha512-zeta"),
      "node_modules/zeta/node_modules/inside": inside,
    }),
  ).toEqual(["bundled part that its parent does not list: inside@0.0.1 (node_modules/zeta/node_modules/inside)"]);
  expect(
    breachesOf({
      "node_modules/zeta": carrier,
      "node_modules/zeta/node_modules/other": inside,
    }),
  ).toEqual(["bundled part that its parent does not list: other@0.0.1 (node_modules/zeta/node_modules/other)"]);
});

it("stops on a bundled part under a parent that is not a pinned registry package", () => {
  const fault = "bundled part under a parent that is not a pinned registry package";
  expect(
    breachesOf({
      "node_modules/omega": { ...fromRegistry("omega", "1.0.0", "sha512-omega"), bundleDependencies: ["inside"] },
      "node_modules/omega/node_modules/inside": inside,
    }),
  ).toEqual([
    "name not in T3 Code's list: omega@1.0.0 (node_modules/omega)",
    `${fault}: inside@0.0.1 (node_modules/omega/node_modules/inside)`,
  ]);
  expect(
    breachesOf({
      "node_modules/zeta": { ...carrier, integrity: "sha512-swapped" },
      "node_modules/zeta/node_modules/inside": inside,
    }),
  ).toEqual([
    "integrity differs from T3 Code's: zeta@2.0.0 (node_modules/zeta)",
    `${fault}: inside@0.0.1 (node_modules/zeta/node_modules/inside)`,
  ]);
  expect(breachesOf({ "node_modules/inside": inside })).toEqual([
    `${fault}: inside@0.0.1 (node_modules/inside)`,
  ]);
  expect(
    breachesOf({
      "node_modules/zeta": carrier,
      "node_modules/zeta/node_modules/inside": inside,
      "node_modules/zeta/node_modules/inside/node_modules/deeper": inside,
    }),
  ).toEqual([`${fault}: deeper@0.0.1 (node_modules/zeta/node_modules/inside/node_modules/deeper)`]);
});

it("stops on a bundled part or a workspace folder that names a source of its own", () => {
  expect(
    breachesOf({
      "node_modules/zeta": carrier,
      "node_modules/zeta/node_modules/inside": { ...inside, resolved: "https://example.com/inside.tgz" },
    }),
  ).toEqual(["bundled part with a source of its own: inside@0.0.1 (node_modules/zeta/node_modules/inside)"]);
  expect(
    breachesOf({ "packages/inner": { name: "@made-up/inner", resolved: "https://example.com/inner.tgz" } }),
  ).toEqual(["folder with a source of its own: packages/inner"]);
});

it("stops on a folder outside node_modules that is not a declared workspace", () => {
  expect(breachesOf({ "vendor/thing": { resolved: "https://example.com/thing.tgz" } })).toEqual([
    "folder that is not a declared workspace: vendor/thing",
  ]);
});

it("stops on a lockfile with no registry package, so an empty file never passes", () => {
  expect(checkLock({ packages: {} }, readList(LIST)).breaches).toEqual([
    "the lockfile holds no registry package",
  ]);
});

it("stops when the list itself is out of shape", () => {
  const good = lockWith({ "node_modules/zeta": fromRegistry("zeta", "2.0.0", "sha512-zeta") });
  const withoutHeader = `made from somewhere\n${PINS.join("\n")}\n`;
  expect(checkLock(good, readList(withoutHeader)).breaches).toEqual([
    "the list's first line does not name a commit and a lockfile hash",
  ]);
  expect(readList(`${LIST}zeta@2.0.0\n`).faults).toEqual(["not a name, a version and a sha512: zeta@2.0.0"]);
  expect(readList(LIST.split("\n")[0] ?? "").faults).toEqual(["the list names no package"]);
});
