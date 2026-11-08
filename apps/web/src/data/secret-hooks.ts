import { useCallback, useEffect, useState } from "react";
import type { SecretEvent, SecretRequest, SecretRow } from "../domain/secrets";
import { useQd } from "./hooks";

export type BotSecrets = { rows: SecretRow[]; requests: SecretRequest[]; events: SecretEvent[]; loading: boolean; failed: boolean; retry: () => void };

export function useSecrets(botId: string): BotSecrets {
  const { secrets } = useQd();
  const [, setVersion] = useState(0);
  const status = secrets.status?.() ?? "ready";
  useEffect(() => {
    const changed = () => setVersion((n) => n + 1);
    const stop = secrets.subscribe(changed);
    if ((secrets.status?.() ?? "ready") !== status) changed();
    return stop;
  }, [secrets]);
  const retry = useCallback(() => secrets.reload?.(), [secrets]);
  return { rows: secrets.rows(botId), requests: secrets.requests(botId), events: secrets.events(botId), loading: status === "loading", failed: status === "failed", retry };
}
