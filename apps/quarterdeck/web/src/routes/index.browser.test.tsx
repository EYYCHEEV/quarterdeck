import "../styles/index.css";

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";

import { BarePage } from "./index.tsx";

const mounted: Array<{ readonly root: Root; readonly host: HTMLElement }> = [];

const mount = (): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<BarePage />));
  mounted.push({ root, host });
  return host;
};

const look = (): { readonly scheme: string; readonly ground: string } => {
  const style = getComputedStyle(document.documentElement);
  return { scheme: style.colorScheme, ground: style.getPropertyValue("--bg").trim() };
};

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    root.unmount();
    host.remove();
  }
  document.documentElement.removeAttribute("data-look");
});

it("shows the bare page laid out by the layout classes", () => {
  const host = mount();
  expect(host.querySelector("h1")?.textContent).toBe("Quarterdeck");
  const main = host.querySelector("main");
  if (main === null) throw new Error("the page did not render");
  expect(getComputedStyle(main).display).toBe("flex");
  expect(getComputedStyle(main).flexDirection).toBe("column");
});

it("takes the pack's tokens in the dark look and in the light look", () => {
  document.documentElement.setAttribute("data-look", "dark");
  const dark = look();
  document.documentElement.setAttribute("data-look", "light");
  const light = look();
  expect(dark.scheme).toBe("dark");
  expect(light.scheme).toBe("light");
  expect(dark.ground).not.toBe("");
  expect(light.ground).not.toBe("");
  expect(light.ground).not.toBe(dark.ground);
});

it("loads the pack's four font files", async () => {
  for (const font of ['400 16px "Plex Sans"', '600 16px "Plex Sans"', '400 16px "Plex Mono"', '600 16px "Plex Mono"']) {
    const faces = await document.fonts.load(font);
    expect(faces).toHaveLength(1);
    expect(document.fonts.check(font)).toBe(true);
  }
});
