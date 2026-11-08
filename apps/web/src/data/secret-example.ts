import type { SecretBot, SecretSeed } from "./secret-standin";

export const SECRET_EXAMPLE_BOTS: SecretBot[] = [{ id: "pib", name: "Pib" }];

export const SECRET_EXAMPLE: SecretSeed = {
  rows: [
    { id: "sec-a1", botId: "alba", name: "GITHUB_TOKEN", savedAt: "2026-11-01T16:10:00-05:00", lastUsedAt: "2026-11-02T09:21:00-05:00", locked: false },
    { id: "sec-a2", botId: "alba", name: "R2_ACCESS_KEY", savedAt: "2026-10-30T14:05:00-04:00", lastUsedAt: null, locked: false },
    { id: "sec-p1", botId: "pib", name: "STAGING_DEPLOY_KEY", savedAt: "2026-10-29T11:30:00-04:00", lastUsedAt: "2026-10-31T09:00:00-04:00", locked: true },
  ],
  requests: [
    { id: "req-a1", botId: "alba", name: "DEPLOY_KEY", reason: "push the Search branch to the staging host", consumerId: "preview-status-only", at: "2026-11-02T09:41:00-05:00", status: "asking" },
    { id: "req-k1", botId: "dr-kivo", name: "NPM_TOKEN", reason: "publish the checks package", consumerId: "preview-status-only", at: "2026-11-01T17:02:00-05:00", status: "declined" },
  ],
  events: [
    { id: "sev-a2", botId: "alba", kind: "saved", name: "R2_ACCESS_KEY", at: "2026-10-30T14:05:00-04:00" },
    { id: "sev-a1", botId: "alba", kind: "saved", name: "GITHUB_TOKEN", at: "2026-11-01T16:10:00-05:00" },
    { id: "sev-k1", botId: "dr-kivo", kind: "declined", name: "NPM_TOKEN", at: "2026-11-01T17:03:00-05:00" },
  ],
  gone: ["pib"],
};
