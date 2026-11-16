import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "./__root.tsx";

export function BarePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2">
      <h1>Quarterdeck</h1>
      <p>The new app is not built yet.</p>
    </main>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: BarePage,
});
