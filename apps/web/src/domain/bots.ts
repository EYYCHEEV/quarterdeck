import type { Bot } from "./types";

export const botCalled = <T extends Pick<Bot, "id" | "name">>(bots: T[], name: string): T | undefined => bots.find((bot) => bot.id === name) ?? bots.find((bot) => bot.name === name);
