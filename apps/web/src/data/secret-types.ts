import type { SecretEvent, SecretRequest, SecretRow } from "../domain/secrets";

export type SaveTarget = { kind: "request"; requestId: string; key: string } | { kind: "direct"; name: string; key: string };

export type SecretsStatus = "loading" | "ready" | "failed";

export type CaptainSecretsApi = {
  rows: (botId: string) => SecretRow[];
  requests: (botId: string) => SecretRequest[];
  events: (botId: string) => SecretEvent[];
  subscribe: (onChange: () => void) => () => void;
  save: (target: SaveTarget, value: string) => Promise<SecretRow>;
  decline: (requestId: string) => void;
  replace: (secretId: string, value: string, key: string) => Promise<SecretRow>;
  remove: (secretId: string) => Promise<void>;
  status?: () => SecretsStatus;
  reload?: () => void;
};

export type BotSecretsApi = {
  ask: (input: { name: string; reason: string; consumerId: string }) => SecretRequest;
  use: (input: { secretId: string; consumerId: string }) => Promise<void>;
};
