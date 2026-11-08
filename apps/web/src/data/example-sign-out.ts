import { forgetLocal } from "./forget-local";
import type { Switches } from "./switches";

let failed = false;

export async function signOutExample(switches: Switches) {
  if (switches.delay) await new Promise((done) => setTimeout(done, switches.delay));
  if (switches.fail.has("sign-out") && !failed) {
    failed = true;
    throw new Error("sign-out failed");
  }
  forgetLocal();
}
