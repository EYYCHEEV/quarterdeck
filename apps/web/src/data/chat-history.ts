import { chatFixture, seedChats, type ChatContent, type ChatFixture, type ChatFixtureFile, type ChatSeed, type RawMessage } from "./chat-content";
import fixtureFile from "./chat-fixtures.json";

type VerifiedHistory = { content: ChatContent; own: ReadonlySet<RawMessage> };
export type FixtureHistory = { fixture: ChatFixture; own: ReadonlySet<RawMessage> };

const APP_OWN: Record<string, true | undefined> = { "alba-m2": true, "alba-m4": true, "alba-m6": true, "alba-m8": true, "alba-m10": true, "iris-m4": true, "dr-kivo-m2": true, "dr-kivo-m3": true, "shelvorn-m2": true, "dale-m2": true };
const APP_HISTORY_SHA256 = "84c317fb941a0683e52e38cf987cfb1633b49730561db7692a5782ab0f710c03";
let verified: Promise<VerifiedHistory> | undefined;

export async function appChatHistory(media: string): Promise<ChatSeed> {
  verified ??= (async () => {
    const { chats, seenAt, working, existingMessageFixes } = (await import("./chat-content.json")).default;
    const content = { chats, seenAt, working, existingMessageFixes } as unknown as ChatContent;
    const bytes = new TextEncoder().encode(JSON.stringify(content));
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== APP_HISTORY_SHA256) throw new Error("Chat history could not be verified.");
    const own = new Set(Object.values(content.chats).flatMap((chat) => chat.messagesAdd.filter((message) => APP_OWN[message.id] === true)));
    return { content, own };
  })();
  const { content, own } = await verified;
  return seedChats(content, media, own);
}

export function appChatFixture(id: string): FixtureHistory | null {
  if (!__QD_FIXTURES__) return null;
  const file = fixtureFile as unknown as ChatFixtureFile;
  const fixture = chatFixture(file, id);
  if (!fixture) return null;
  const ownIds: Record<string, true | undefined> = { "fx-alba-m1": true, "fx-alba-m2": true, "fx-dale-m1": true, "fx-dale-m2": true, "fx-dale-m3": true };
  const messages = [...(fixture.message ? [fixture.message] : []), ...(fixture.messages ?? [])];
  return { fixture, own: new Set(messages.filter((message) => ownIds[message.id] === true)) };
}
