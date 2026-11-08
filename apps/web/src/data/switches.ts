export type Fixtures = "off" | "now" | "late" | "evidence" | "pages" | "lanes" | "catch-up" | "card-states";

export type Switches = { delay: number; fail: Set<string>; hold?: Set<string>; fixtures: Fixtures; empty: boolean; chat: string | null; mail: string | null; changed?: number; rolled?: string | null; closed?: string | null; listed?: number | null; answered?: boolean; pageNext?: number };

const NAMED: Fixtures[] = ["late", "evidence", "pages", "lanes", "catch-up", "card-states"];

const NEUTRAL: Switches = { delay: 0, fail: new Set(), fixtures: "off", empty: false, chat: null, mail: null, changed: 0, listed: null, answered: false, pageNext: 0 };

function readFixtureSwitches(search: string): Switches {
  const params = new URLSearchParams(search);
  const fixtures = params.get("fixtures");
  const listed = Date.parse(params.get("listed") ?? "");
  return {
    delay: Math.max(0, Number(params.get("delay")) || 0),
    fail: new Set((params.get("fail") ?? "").split(",").filter(Boolean)),
    ...(params.get("hold") && { hold: new Set((params.get("hold") ?? "").split(",").filter(Boolean)) }),
    fixtures: NAMED.find((name) => name === fixtures) ?? (fixtures === "1" || fixtures === "now" ? "now" : "off"),
    empty: params.get("queue") === "empty",
    changed: Math.max(0, Number(params.get("changed")) || 0),
    ...(params.get("rolled") && { rolled: params.get("rolled") }),
    ...(params.get("closed") && { closed: params.get("closed") }),
    listed: Number.isNaN(listed) ? null : listed,
    answered: params.get("answered") === "1",
    pageNext: Math.max(0, Number(params.get("pagenext")) || 0),
    chat: params.get("chatfx"),
    mail: params.get("mailfx"),
  };
}

export function readSwitches(search: string): Switches {
  return __QD_FIXTURES__ ? readFixtureSwitches(search) : NEUTRAL;
}
