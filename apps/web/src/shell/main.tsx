import { createRoot } from "react-dom/client";
import { createExampleData } from "../data/example-data";
import { withExampleMailRead } from "../data/example-mail-read";
import { DataProvider } from "../data/hooks";
import { readSwitches } from "../data/switches";
import { App } from "./app";
import { Look } from "./look";

const root = document.getElementById("root");
if (root) {
  if (__QD_SOURCE__ === "server") {
    void Promise.all([import("../data/server-source"), import("../data/api-client")]).then(([source, api]) => {
      createRoot(root).render(
        <DataProvider data={source.createServerSource(api.createApiClient())}>
          <Look />
          <App />
        </DataProvider>,
      );
    });
  } else {
    createRoot(root).render(
      <DataProvider data={__QD_FIXTURES__ ? withExampleMailRead(createExampleData, readSwitches(location.search)) : createExampleData(readSwitches(location.search))}>
        <Look />
        <App />
      </DataProvider>,
    );
  }
}
