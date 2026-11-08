import { useEffect } from "react";
import { useSettings, type Appearance } from "../data/settings";

const LIGHT_DEVICE = "(prefers-color-scheme: light)";

function pickLook(appearance: Appearance): "light" | "dark" {
  if (appearance !== "system") return appearance;
  return window.matchMedia(LIGHT_DEVICE).matches ? "light" : "dark";
}

export function Look() {
  const { appearance } = useSettings();
  useEffect(() => {
    const show = () => document.documentElement.setAttribute("data-appearance", pickLook(appearance));
    show();
    const device = window.matchMedia(LIGHT_DEVICE);
    device.addEventListener("change", show);
    return () => device.removeEventListener("change", show);
  }, [appearance]);
  return null;
}
