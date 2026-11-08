import esbuild from "esbuild";

export async function loadTs(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent", loader: { ".html": "text" } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}
