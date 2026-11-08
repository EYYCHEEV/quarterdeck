import type { Activity, Answer, Page, World } from "../domain/types";
import { fileOfVersion, makePrivate, publicAddress, publish, publishRefusal, type PageRandomSource } from "../domain/page-public";
import type { CardThread } from "./card";
import type { CardApi } from "./card-api";
import { createStandInCardApi } from "./card-standin";
import { toEvidence, type EvidenceFile, type EvidenceFixtureFile } from "./evidence";
import { exampleCardThreads } from "./example-cards";
import { ANSWERED_EXTRA, EXAMPLE_NOW, SHORT_CARDS } from "./example-content";
import type { ExampleParts } from "./example-parts";
import type { LaneFixtureSources } from "./lane-fixtures";
import { laneStateWorld } from "./lane-state-fixtures";
import { SIGN_OFFS, threadSources } from "./lanes";
import { evidence as laneEvidence } from "./lanes-addendum.json";
import { lazyChat, lazySecrets } from "./lazy-parts";
import { fixturePages, pageCardThreads, pageEvidence, PUBLISHES, rollPages, type PageChange, type RawPage } from "./pages";
import { Refused, type AnswerInput, type QdData } from "./source";
import type { Switches } from "./switches";
import { buildWorld, type Session, type ThreadExtra } from "./world";

type FixtureFile = { fixtures: { taskCard: CardThread & ThreadExtra & { laneId: string }; versions?: ThreadExtra["versions"]; pages?: RawPage[] }[] };
type Fixtures = { threads: CardThread[]; extras: Map<string, ThreadExtra>; pages: RawPage[]; added?: LaneFixtureSources["added"] };
type PublicPageResolution = { ref: string; version: number; file: string };
type ExampleData = QdData & { resolvePublicPage: (address: string) => PublicPageResolution | null };

const HOST_CONFIRMS_MS = 3000;
const PREVIEW_READ_MS = 400;

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function failsOnce(on: boolean): () => boolean {
  let left = on;
  return () => {
    const now = left;
    left = false;
    return now;
  };
}

function fixtureSources(files: FixtureFile[]): Fixtures {
  const entries = files.flatMap((file) => file.fixtures);
  return { ...threadSources(entries), pages: entries.flatMap((entry) => entry.pages ?? []) };
}

function evidenceFixtures<File>(): Promise<File[]> {
  return __QD_FIXTURES__ ? Promise.all([import("./evidence-fixtures.json"), import("./evidence-fixture-ev7.json")]).then((files) => files.map((m) => m.default as unknown as File)) : Promise.resolve([]);
}

function fixtureFile(fixtures: Switches["fixtures"]): Promise<Fixtures> | null {
  if (__QD_FIXTURES__) {
    if (fixtures === "evidence") return evidenceFixtures<FixtureFile>().then(fixtureSources);
    if (fixtures === "pages") return import("./pages-fixtures.json").then((m) => ({ threads: [], extras: new Map(), pages: fixturePages(m.default as unknown as Parameters<typeof fixturePages>[0]) }));
    if (fixtures === "lanes") return import("./lane-fixtures").then((m) => ({ ...m.laneFixtureSources(), pages: [] }));
    if (fixtures === "catch-up") return import("./lane-fixtures").then((m) => ({ ...m.catchUpSources(), pages: [] }));
    if (fixtures === "card-states") return import("./card-states-fixtures.json").then((m) => fixtureSources([m.default as unknown as FixtureFile]));
    if (fixtures !== "off") return import("./test-fixtures.json").then((m) => fixtureSources([m.default as unknown as FixtureFile]));
  }
  return null;
}

const ROLLED_CARDS = ["c1", "c6"];

function rollUp(world: World, count: number): World {
  const targets = new Set(ROLLED_CARDS.slice(0, count));
  return {
    ...world,
    cards: world.cards.map((card) =>
      targets.has(card.id) ? { ...card, version: card.version + 1, changes: [...card.changes, { by: card.owner, at: EXAMPLE_NOW, following: null, what: "Rolled up to a new version" }] } : card,
    ),
  };
}

export function createExampleData(
  switches: Switches,
  cardApi: CardApi = createStandInCardApi({ latency: () => switches.delay, clock: () => EXAMPLE_NOW, threads: [...exampleCardThreads(), ...pageCardThreads()] }),
): ExampleData {
  const now = () => Date.parse(EXAMPLE_NOW);
  let partsLoad: Promise<ExampleParts> | null = null;
  const parts = () =>
    (partsLoad ??= import("./example-parts")
      .then((module) => module.createExampleParts(switches, now, failsOnce))
      .catch((error: unknown) => {
        partsLoad = null;
        throw error;
      }));
  const chat = lazyChat(() => parts().then((loaded) => loaded.chat));
  const secrets = lazySecrets(() => parts().then((loaded) => loaded.secrets));
  const pageChanges = new Map<string, PageChange>();
  const issuedAddresses = new Set<string>();
  let pageRandom: PageRandomSource | undefined;
  if (__QD_FIXTURES__) {
    const sequence = new Uint8Array(16);
    pageRandom = (bytes) => {
      for (let at = sequence.length - 1; at >= 0; at -= 1) {
        sequence[at] = (sequence[at] + 1) & 255;
        if (sequence[at]) break;
      }
      bytes.set(sequence);
    };
  }
  const session: Session = { seen: new Map(), answers: new Map(), looked: new Map(), pages: pageChanges };
  const listeners = new Set<() => void>();
  const failList = failsOnce(switches.fail.has("list"));
  const failRefresh = failsOnce(switches.fail.has("refresh"));
  const failSend = failsOnce(switches.fail.has("send"));
  const failPage = failsOnce(switches.fail.has("page"));
  const failEvidence = failsOnce(switches.fail.has("evidence"));
  const failTrackers = failsOnce(switches.fail.has("trackers"));
  const failPublish = failsOnce(switches.fail.has("publish"));
  let trackersDown = switches.fail.has("trackers");
  let pushing = false;
  const recorded = new Map<string, Activity[]>();
  const fixtures = fixtureFile(switches.fixtures);
  let fixturesIn = switches.fixtures !== "off" && switches.fixtures !== "late";
  let rolledUp = false;
  let closedNow = false;
  let pagesRolled = false;
  let loads = 0;
  let latest: World | null = null;
  let fixtureIds = new Set<string>();

  const currentPublic = (page: Page) => {
    const change = pageChanges.get(page.ref);
    return change ? change.public : page.public;
  };

  const notify = () => {
    pushing = true;
    try {
      for (const listener of [...listeners]) listener();
    } finally {
      pushing = false;
    }
  };

  const afterFirstLoad = () => {
    if (switches.fixtures === "late") {
      fixturesIn = true;
      setTimeout(notify, 0);
    }
    if (switches.changed || (__QD_FIXTURES__ && switches.rolled)) {
      rolledUp = true;
      setTimeout(notify, 400);
    }
    if (__QD_FIXTURES__ && switches.closed) {
      closedNow = true;
      setTimeout(notify, 400);
    }
    if (switches.fail.has("refresh")) setTimeout(notify, 0);
    if (__QD_FIXTURES__ && switches.pageNext) {
      setTimeout(() => {
        pagesRolled = true;
        notify();
      }, switches.pageNext);
    }
  };

  const load = async (): Promise<World> => {
    loads += 1;
    const first = loads === 1;
    const summaries = await cardApi.listCards();
    if (failList() || (!first && failRefresh())) throw new Error("the example server could not be reached");
    const threads = await Promise.all(summaries.map((summary) => cardApi.openCard(summary.id)));
    const extra = fixtures && fixturesIn ? await fixtures : null;
    const fixtureParts = __QD_FIXTURES__ && (switches.chat || switches.mail) ? await parts() : null;
    const saved = (await fixtureParts?.chatFixtureEntry)?.fixture.artifactAdd;
    const mailSource = await fixtureParts?.mailFixtureEntry;
    fixtureIds = new Set(extra?.extras.keys());
    const built = buildWorld({
      threads: [...threads, ...SIGN_OFFS.threads, ...(extra?.threads ?? [])],
      extras: new Map([...SIGN_OFFS.extras, ...(extra?.extras ?? [])]),
      short: switches.answered ? [...SHORT_CARDS, ANSWERED_EXTRA] : SHORT_CARDS,
      session,
      added: extra?.added,
      artifacts: saved ? [saved] : [],
      mail: mailSource?.mail,
      bots: mailSource?.bots,
      pages: extra?.pages ?? [],
    });
    const world = { ...built, lanes: built.lanes.map((lane) => (recorded.has(lane.id) ? { ...lane, activity: [...(recorded.get(lane.id) ?? []), ...lane.activity] } : lane)) };
    const states = __QD_FIXTURES__ && (switches.rolled || switches.closed) ? await import("./card-states") : null;
    const rolled = rolledUp ? (__QD_FIXTURES__ && states && switches.rolled ? states.rollOne(world, switches.rolled) : rollUp(world, switches.changed ?? 0)) : world;
    const shut = __QD_FIXTURES__ && closedNow && states && switches.closed ? states.closeOut(rolled, switches.closed) : rolled;
    const state = __QD_FIXTURES__ && switches.fixtures === "lanes" ? laneStateWorld(shut) : shut;
    latest = switches.empty ? { ...state, cards: [] } : state;
    if (__QD_FIXTURES__ && pagesRolled) latest = { ...latest, pages: rollPages(latest.pages, EXAMPLE_NOW) };
    for (const page of latest.pages) if (page.public) issuedAddresses.add(page.public.link);
    if (first) afterFirstLoad();
    return latest;
  };

  const publishNow = (ref: string, version: number): string | null => {
    const loaded = latest?.pages.find((item) => item.ref === ref);
    if (!loaded) return "That Page is not loaded.";
    const page = { ...loaded, public: currentPublic(loaded) };
    const refusal = publishRefusal(page, version);
    if (refusal) return refusal;
    const mint = () => {
      for (let draw = 0; draw < 16; draw += 1) {
        const address = publicAddress(pageRandom);
        if (!issuedAddresses.has(address)) {
          issuedAddresses.add(address);
          return address;
        }
      }
      throw new Refused("Could not create a public address.");
    };
    pageChanges.set(ref, { public: publish(page, version, new Date(now()).toISOString(), mint) });
    return null;
  };

  const answer = async (cardId: string, input: AnswerInput): Promise<Answer> => {
    const card = latest?.cards.find((item) => item.id === cardId);
    if (!card) throw new Error("that Task Card is not loaded");
    if (switches.delay) await pause(switches.delay);
    if (failSend()) throw new Error("the example server could not be reached");
    const isWire = SHORT_CARDS.every((short) => short.id !== cardId) && (input.choice.kind === "option" || input.choice.kind === "none");
    if (isWire && !fixtureIds.has(cardId)) await cardApi.postAnswer(cardId, { rev: input.version, pick: input.choice.kind === "option" ? (input.choice.letter as "A") : "none", note: input.note || undefined });
    const given: Answer = {
      choice: input.choice,
      at: new Date(now()).toISOString(),
      note: input.note,
      version: input.version,
      waitingOn: input.choice.kind === "none" ? card.owner : null,
      outcome: null,
    };
    const line = __QD_FIXTURES__ && switches.fixtures === "lanes" ? (await import("./lane-fixtures")).signOffLine({ ...card, answer: given }) : null;
    session.answers.set(cardId, given);
    if (line) recorded.set(card.laneId, [{ at: given.at, bot: line.bot, text: line.text, refs: [] }, ...(recorded.get(card.laneId) ?? [])]);
    const publishes = PUBLISHES.get(cardId);
    if (publishes && input.choice.kind === "option" && input.choice.letter === card.options.find((option) => option.pick && option.door === "one-way")?.letter) publishNow(publishes.pageRef, publishes.version);
    notify();
    return given;
  };

  return {
    now,
    loadedAt: () => switches.listed ?? now(),
    load,
    answer,
    openCard: __QD_PREVIEW__
      ? async () => {
          await pause(PREVIEW_READ_MS);
          notify();
        }
      : undefined,
    chat,
    secrets,
    watch: (onChange) => {
      listeners.add(onChange);
      const stop = cardApi.watch(onChange);
      return () => {
        listeners.delete(onChange);
        stop();
      };
    },
    markSeen: (cardId) => {
      session.seen.set(cardId, EXAMPLE_NOW);
      notify();
    },
    publishPage: async (ref, version) => {
      if (switches.delay) await pause(switches.delay);
      if (failPublish()) throw new Error("the example server could not be reached");
      const refusal = publishNow(ref, version);
      if (refusal) throw new Refused(refusal);
      notify();
    },
    unpublishPage: async (ref) => {
      if (switches.delay) await pause(switches.delay);
      const loaded = latest?.pages.find((item) => item.ref === ref);
      const page = loaded ? { ...loaded, public: currentPublic(loaded) } : null;
      const pending = page?.public?.removal === "none" ? makePrivate(page) : null;
      if (!pending) throw new Refused("That Page is not public.");
      pageChanges.set(ref, { public: pending });
      notify();
      setTimeout(() => {
        if (pageChanges.get(ref)?.public !== pending) return;
        pageChanges.set(ref, { public: null });
        notify();
      }, HOST_CONFIRMS_MS);
    },
    resolvePublicPage: (address) => {
      for (const page of latest?.pages ?? []) {
        const publication = currentPublic(page);
        if (!publication || publication.link !== address || publication.removal !== "none") continue;
        const file = fileOfVersion(page, publication.version);
        return file ? { ref: page.ref, version: publication.version, file } : null;
      }
      return null;
    },
    markLooked: (laneId) => {
      session.looked.set(laneId, new Date(now()).toISOString());
      notify();
    },
    trackers: async () => {
      const pushed = pushing;
      if (switches.delay) await pause(switches.delay);
      if (failTrackers() || (pushed && trackersDown)) throw new Error("the Lane trackers could not be reached");
      trackersDown = false;
      return (await import("./trackers")).loadTrackers(switches.fixtures);
    },
    openPage: async (file) => {
      if (switches.delay) await pause(switches.delay);
      if (failPage()) throw new Error("the Page could not be reached");
      const html = (await import("./page-files")).PAGE_FILES[file];
      if (!html) throw new Error("the Page has no file");
      return html;
    },
    evidence: async (cardId) => {
      if (switches.delay) await pause(switches.delay);
      if (failEvidence()) throw new Error("the evidence could not be reached");
      const shipped = (await import("./evidence.json")).default as unknown as EvidenceFile;
      const own = shipped.cards[cardId] ?? pageEvidence(cardId) ?? (laneEvidence.cards as unknown as EvidenceFile["cards"])[cardId];
      if (own) return toEvidence(own);
      if (__QD_FIXTURES__ && switches.fixtures === "evidence") {
        const files = await evidenceFixtures<EvidenceFixtureFile>();
        const entry = files.flatMap((file) => file.fixtures).find((item) => item.taskCard.card.id === cardId);
        if (entry) return toEvidence(entry.evidence);
      }
      if (__QD_FIXTURES__ && switches.fixtures === "lanes") {
        const signedOff = (await import("./lane-fixtures")).signOffEvidence(cardId);
        if (signedOff) return toEvidence(signedOff);
      }
      return null;
    },
    signOut: async () => {
      await (await import("./example-sign-out")).signOutExample(switches);
      session.looked.clear();
      notify();
    },
    bots: () => import("./example-bots-admin").then((module) => module.createExampleBots()),
  };
}
