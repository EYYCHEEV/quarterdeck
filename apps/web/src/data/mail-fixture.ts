import type { Bot, ForwardedBy } from "../domain/types";
import { BOTS } from "./example-content";
import type { MailThread } from "./pack-extra";

type FixtureBot = { id: string; name: string; role: string; pinned: boolean; order: number };

export type MailFixture = {
  fixture: string;
  threads?: (Omit<MailThread, "bots"> & { bots?: string[] })[];
  botsAdd?: FixtureBot[];
  forwardedBy?: Record<string, ForwardedBy[]>;
};

export type MailFixtureFile = { fixtures: MailFixture[] };

export type MailSource = { mail: MailThread[]; bots: Bot[] };

export function mailFixture(file: MailFixtureFile, id: string): MailSource | null {
  const entry = file.fixtures.find((item) => item.fixture.split(" ")[0] === id);
  if (!entry?.threads) return null;
  const forwarded = entry.forwardedBy ?? {};
  return {
    mail: entry.threads.map((thread) => ({ ...thread, bots: thread.bots ?? [], mails: thread.mails.map((mail) => (forwarded[mail.ref] ? { ...mail, forwardedBy: forwarded[mail.ref] } : mail)) })),
    bots: (entry.botsAdd ?? []).map((bot, at) => ({ ...bot, color: BOTS[at % BOTS.length].color })),
  };
}
