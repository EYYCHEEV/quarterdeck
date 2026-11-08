export type Visibility = {
  hidden: () => boolean;
  watch: (onChange: () => void) => () => void;
};

export const pageVisibility: Visibility = {
  hidden: () => globalThis.document?.visibilityState === "hidden",
  watch(onChange) {
    globalThis.document?.addEventListener("visibilitychange", onChange);
    return () => globalThis.document?.removeEventListener("visibilitychange", onChange);
  },
};
