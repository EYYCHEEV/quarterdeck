import { FIXTURE_SCRIPTS } from "./chat-content";
import { createExampleChat } from "./chat-example";
import { appChatFixture, type FixtureHistory } from "./chat-history";
import type { BrowserChatApi } from "./chat-types";
import { BOTS } from "./example-content";
import { mailFixture, type MailFixtureFile, type MailSource } from "./mail-fixture";
import { createOpenChat } from "./open-chat";
import { SECRET_EXAMPLE, SECRET_EXAMPLE_BOTS } from "./secret-example";
import { createSecretStandIn } from "./secret-standin";
import type { CaptainSecretsApi } from "./secret-types";
import type { Switches } from "./switches";

export type ExampleParts = {
  chat: BrowserChatApi;
  secrets: CaptainSecretsApi;
  chatFixtureEntry: Promise<FixtureHistory | null> | undefined;
  mailFixtureEntry: Promise<MailSource | null> | undefined;
};

export function createExampleParts(switches: Switches, now: () => number, failsOnce: (on: boolean) => () => boolean): ExampleParts {
  const chatFixtureEntry = __QD_FIXTURES__ && switches.chat ? Promise.resolve(appChatFixture(switches.chat)) : undefined;
  const mailFixtureEntry = __QD_FIXTURES__ && switches.mail ? import("./mail-fixtures.json").then((module) => mailFixture(module.default as unknown as MailFixtureFile, switches.mail ?? "")) : undefined;
  const media = __QD_PREVIEW__ ? "" : "/";
  const openChat = createOpenChat();
  const chat = createExampleChat({ now, media, openChat, fixture: chatFixtureEntry, script: __QD_FIXTURES__ ? FIXTURE_SCRIPTS[switches.chat ?? ""] : undefined, failSend: failsOnce(switches.fail.has("chat")), holdUpload: __QD_FIXTURES__ && (switches.hold?.has("upload") ?? false) });
  const secrets = createSecretStandIn({ now, bots: () => [...BOTS, ...SECRET_EXAMPLE_BOTS], accountId: "preview-captain", session: () => ({ accountId: "preview-captain", activeChat: openChat.current() }), consumers: { "preview-status-only": async () => "refused" }, latency: () => switches.delay, failWrite: failsOnce(switches.fail.has("secret")), seed: SECRET_EXAMPLE }).captain;
  return { chat, secrets, chatFixtureEntry, mailFixtureEntry };
}
