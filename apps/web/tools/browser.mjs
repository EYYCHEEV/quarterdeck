export function chromeLaunchOptions(extra = {}) {
  const executablePath = process.env.QD_CHROME;
  if (!executablePath) {
    throw new Error("QD_CHROME is not set: point it at the pinned Chrome for Testing headless shell (see docs/operations/CI.md)");
  }
  return { executablePath, ...extra };
}
