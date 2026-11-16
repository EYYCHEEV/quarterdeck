import "./styles/index.css";

import { createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import { rootRoute } from "./routes/__root.tsx";
import { indexRoute } from "./routes/index.tsx";

const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const mount = document.getElementById("root");
if (mount === null) throw new Error("the page has no root element");

createRoot(mount).render(<RouterProvider router={router} />);
