import { spawn } from "node:child_process";
import net from "node:net";

const LIMIT_MS = 15000;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export async function startAppServer(script = "tools/serve-app.mjs") {
  const port = await freePort();
  const origin = "http://127.0.0.1:" + port;
  const server = spawn(process.execPath, [script], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  let errors = "";
  server.stderr.on("data", (chunk) => (errors += chunk));
  await new Promise((resolve, reject) => {
    let timer = null;
    const fail = (why) => {
      clearTimeout(timer);
      server.kill();
      reject(new Error(script + " " + why + (errors.trim() ? ":\n" + errors.trim() : "")));
    };
    timer = setTimeout(() => fail("did not say it was listening on " + origin + " within " + LIMIT_MS / 1000 + " s"), LIMIT_MS);
    server.stdout.on("data", (chunk) => {
      said += chunk;
      if (!said.includes(origin)) return;
      clearTimeout(timer);
      resolve();
    });
    server.once("exit", (code, signal) => fail("exited (" + (signal ?? "code " + code) + ") before it was listening"));
  });
  return { server, origin };
}
