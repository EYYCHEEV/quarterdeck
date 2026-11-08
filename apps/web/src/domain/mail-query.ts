export type MailFilterKey = "project" | "lane" | "bot" | "day";
export type MailQuery = { text: string; filters: Partial<Record<MailFilterKey, string>> };

export const EMPTY_MAIL_QUERY: MailQuery = { text: "", filters: {} };
