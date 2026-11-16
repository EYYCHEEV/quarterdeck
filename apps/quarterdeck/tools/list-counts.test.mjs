import { expect, it } from "vite-plus/test";

import { countList } from "./list-counts.mjs";

const FIRST_LINE = `t3-code-commit ${"0".repeat(40)} pnpm-lock-sha256 ${"0".repeat(64)}`;

it("counts the pairs with a sha512 apart from the pairs with none", () => {
  const list = [
    FIRST_LINE,
    "@scope/alpha@1.2.3 sha512-alpha",
    "none@1.0.0 sha512-named-none",
    "tarred@3.0.0 none",
    "zeta@1.9.0 sha512-old",
    "zeta@2.0.0 sha512-zeta",
    "",
  ].join("\n");
  expect(countList(list)).toEqual({ pairs: 5, sha512: 4, none: 1 });
});

it("counts nothing in a list that holds only its first line", () => {
  expect(countList(`${FIRST_LINE}\n`)).toEqual({ pairs: 0, sha512: 0, none: 0 });
});
