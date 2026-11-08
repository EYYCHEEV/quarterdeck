export const readJson = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
};

export const writeJson = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

export const removeJson = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {}
};
