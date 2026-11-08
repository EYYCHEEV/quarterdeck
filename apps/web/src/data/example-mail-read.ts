import type { QdData } from "./source";
import type { Switches } from "./switches";

const never = () => new Promise<void>(() => undefined);

const once = (on: boolean) => {
  let left = on;
  return () => {
    const now = left;
    left = false;
    return now;
  };
};

export function withExampleMailRead(make: (switches: Switches) => QdData, switches: Switches): QdData {
  const data = make(switches);
  const held = (name: string) => switches.hold?.has(name) ?? false;
  const knob = (name: string) => held(name) || switches.fail.has(name);
  if (!knob("mail-list") && !knob("mail-thread")) return data;
  const failList = once(switches.fail.has("mail-list"));
  const failThread = once(switches.fail.has("mail-thread"));
  const listeners = new Set<() => void>();
  const read = new Set<string>();
  let listed = !knob("mail-list");
  const told = () => {
    for (const listener of [...listeners]) listener();
  };
  const wrapped: QdData = {
    ...data,
    load: async () => {
      const world = await data.load();
      return { ...world, mail: listed ? world.mail.map((thread) => (read.has(thread.ref) ? { ...thread, omitted: thread.omitted ?? 0 } : thread)) : [] };
    },
    watch: (onChange) => {
      const own = () => onChange();
      listeners.add(own);
      const stop = data.watch(onChange);
      return () => {
        listeners.delete(own);
        stop();
      };
    },
  };
  if (knob("mail-list")) {
    wrapped.openMailList = async () => {
      if (held("mail-list")) return never();
      if (failList()) throw new Error("the example mail list could not be reached");
      listed = true;
      told();
    };
    wrapped.closeMailList = () => undefined;
  }
  if (knob("mail-thread")) {
    wrapped.openMailThread = async (ref) => {
      if (held("mail-thread")) return never();
      if (failThread()) throw new Error("the example thread could not be reached");
      read.add(ref);
      told();
    };
    wrapped.closeMailThread = () => undefined;
  }
  return wrapped;
}
