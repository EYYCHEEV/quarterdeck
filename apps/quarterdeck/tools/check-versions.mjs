import { readFileSync, writeFileSync } from "node:fs";

import { checkLock, makeList, readList } from "./versions.mjs";

const [mode, ...rest] = process.argv.slice(2);

if (mode === "check" && rest.length === 2) {
  const [lockPath, listPath] = rest;
  const list = readList(readFileSync(listPath, "utf8"));
  const result = checkLock(JSON.parse(readFileSync(lockPath, "utf8")), list);
  console.log(`T3 Code commit: ${list.commit === "" ? "not named" : list.commit}`);
  console.log(`T3 Code lockfile sha256: ${list.lockSha256 === "" ? "not named" : list.lockSha256}`);
  console.log(`T3 Code pins read: ${list.pins.size} name and version pairs, ${list.names.size} names`);
  console.log(`registry packages: ${result.registry}`);
  console.log(`workspace links: ${result.links.length}`);
  for (const line of result.links) console.log(`  link ${line}`);
  console.log(`bundled inside another package: ${result.bundled.length}`);
  for (const line of result.bundled) console.log(`  bundled ${line}`);
  console.log(`breaches: ${result.breaches.length}`);
  for (const line of result.breaches) console.log(`  BREACH ${line}`);
  console.log(result.breaches.length === 0 ? "result: PASS" : "result: STOP");
  process.exitCode = result.breaches.length === 0 ? 0 : 1;
} else if (mode === "list" && rest.length === 3) {
  const [pnpmLockPath, commit, listPath] = rest;
  const text = makeList(readFileSync(pnpmLockPath), commit);
  writeFileSync(listPath, text);
  console.log(`wrote ${listPath}: ${text.split("\n").length - 2} name and version pairs, each with its sha512`);
} else {
  console.error("usage: check-versions.mjs check <package-lock.json> <list file>");
  console.error("       check-versions.mjs list <T3 Code pnpm-lock.yaml> <T3 Code commit> <list file>");
  process.exitCode = 2;
}
