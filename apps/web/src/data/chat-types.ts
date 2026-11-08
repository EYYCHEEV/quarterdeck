import type { Quote, SentQuote, WireQuote } from "../domain/chat";
import type { InspectedFile } from "../domain/file-inspection";
import type { Bot } from "../domain/types";

export type { Quote, SentQuote } from "../domain/chat";

export type Attachment = { id: string; name: string; size: number; type: string; url: string; alt?: string };

export type CardUpdate = { cardId: string; version: number; line: string };

export type ChatMessage = {
  id: string;
  clientId?: string;
  from: "captain" | "bot";
  text: string;
  at: string;
  refs: string[];
  cardRefs?: string[];
  cardUpdate?: CardUpdate;
  quote?: SentQuote;
  attachments?: Attachment[];
};

export type Working = { note: string; since: string; updatedAt: string };

export type ChatFeature = "quote" | "read" | "seen" | "working" | "files" | "cursor";

export type ChatThread = {
  bot: Bot;
  messages: ChatMessage[];
  seenUpTo: string | null;
  seenAt: string | null;
  working: Working | null;
  older?: boolean;
  firstUnread: string | null;
  features: ChatFeature[];
};

export type ChatRow = {
  bot: Bot;
  preview: string;
  at: string;
  unread: boolean;
};

export type Outgoing = { text: string; clientId: string; quote?: Quote; files?: InspectedFile[] };

export type WireOutgoing = { text: string; clientId: string; quote?: WireQuote; files?: InspectedFile[] };

export type BrowserUploadVerdict = { filename: string; detectedType: string; checkedBy: "browser-stand-in"; serverRecheckRequired: true };
export type ServerUploadVerdict = { filename: string; detectedType: string; checkedBy: "server"; uploadId: string };
export type SentChatMessage<V extends BrowserUploadVerdict | ServerUploadVerdict> = ChatMessage & { uploadVerdicts: V[] };

type ChatReads = {
  listChats: () => Promise<ChatRow[]>;
  watchChats: (onChange: () => void) => () => void;
  openThread: (botId: string) => Promise<ChatThread>;
  subscribe: (botId: string, onChange: (thread: ChatThread) => void) => () => void;
};

export type BrowserChatApi = ChatReads & { uploadBoundary: "browser-stand-in"; send: (botId: string, message: Outgoing) => Promise<SentChatMessage<BrowserUploadVerdict>> };
export type ServerChatApi = ChatReads & { uploadBoundary: "server"; older: (botId: string) => Promise<ChatThread>; send: (botId: string, message: Outgoing) => Promise<SentChatMessage<ServerUploadVerdict>> };
export type ChatApi = BrowserChatApi | ServerChatApi;
