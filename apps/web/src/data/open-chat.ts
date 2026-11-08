export type OpenChat = { id: string; botId: string };

export type OpenChatHolder = { current: () => OpenChat | null; enter: (botId: string) => () => void };

export function createOpenChat(): OpenChatHolder {
  let open: OpenChat | null = null;
  return {
    current: () => (open ? { ...open } : null),
    enter: (botId) => {
      const entered: OpenChat = { id: "chat-" + botId, botId };
      open = entered;
      return () => {
        if (open === entered) open = null;
      };
    },
  };
}
