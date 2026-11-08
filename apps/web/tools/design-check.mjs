import { chromium } from "playwright";
import { chromeLaunchOptions } from "./browser.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { measure, measurePills } from "./layout-measure.mjs";
import { measureUx } from "./ux-measure.mjs";

const OUT = path.join("design-check", "shots");
const FAILED = path.join("design-check", "failed");
const KNOWN_FILE = path.join("design-check", "known.json");
const WRITE_KNOWN = process.argv.includes("--write-known");
const MUTANT = process.argv.includes("--mutant");
const FIRST_SCREEN_ONLY = process.argv.includes("--first-screen");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",") ?? null;
const SIZES = process.argv.find((a) => a.startsWith("--sizes="))?.slice(8).split(",") ?? null;
const LOOKS = process.argv.find((a) => a.startsWith("--looks="))?.slice(8).split(",") ?? ["dark", "light"];
const WHOLE = !ONLY && !SIZES && !FIRST_SCREEN_ONLY;
const PILLS = process.env.DESIGN_CHECK_PILLS || "[data-pill]";
const NOISE_PIXELS = 64;
const NOISE_DELTA = 24;
const FIRST_SCREEN_MS = 2000;
const FIRST_LOAD_BYTES = 120 * 1024;
const FIRST_SCREEN_LOADS = 7;
const FIRST_SCREEN_SLOWER_MS = 40;
const FIRST_LOAD_GROWTH_BYTES = 1024;
const BASE_REF = process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? "origin/main";
const CLOCK_IN_SANDBOX = /^Blocked script execution in 'about:srcdoc'/;
const SLOW_4G = { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1000 * 1000 * 0.9) / 8, uploadThroughput: (750 * 1000 * 0.9) / 8 };
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const mac = (width, height) => ({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: false, isMobile: false });
const ipad = (width, height) => ({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, userAgent: IPAD_UA });
const VIEWPORTS = [
  { name: "phone-390", expect: "phone", shot: true, opts: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } },
  { name: "ipad-1133x744", expect: "sideways", shot: true, opts: ipad(1133, 744) },
  { name: "ipad-744x1133", expect: "phone", shot: true, opts: ipad(744, 1133) },
  { name: "mac-1512", expect: "mac", shot: true, opts: mac(1512, 982) },
  { name: "mac-1280", expect: "sideways", opts: mac(1280, 800) },
  { name: "mac-1024", expect: "sideways", opts: mac(1024, 700) },
  { name: "mac-756", expect: "phone", opts: mac(756, 900) },
  { name: "iphone-440", expect: "phone", opts: { viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true } },
];

const UNKNOWN = SIZES?.filter((name) => !VIEWPORTS.some((vp) => vp.name === name)) ?? [];
if (UNKNOWN.length) {
  console.log(`design-check: unknown size ${UNKNOWN.join(", ")}; sizes are ${VIEWPORTS.map((vp) => vp.name).join(", ")}`);
  process.exit(2);
}
if (!LOOKS.length || LOOKS.some((look) => look !== "dark" && look !== "light")) {
  console.log("design-check: looks are dark and light");
  process.exit(2);
}
const T = (id) => `[data-testid="${id}"]`;
const press = (vp, loc) => (vp.opts.hasTouch ? loc.tap() : loc.click());
const tap = (vp, p, sel) => press(vp, p.locator(sel).first());
const tapAt = (vp, p, point) => (vp.opts.hasTouch ? p.touchscreen.tap(point.x, point.y) : p.mouse.click(point.x, point.y));
const fullScreen = (vp) => vp.opts.viewport.width < 700;
const dialogCloses = (vp) => (fullScreen(vp) ? ["x", "esc"] : ["x", "esc", "outside"]);
const listPop = (name) => (vp) => `[data-pop="${name}-${vp.phone ? "sheet" : "menu"}"]`;
const chatsSettled = (p) => p.waitForFunction(() => !document.querySelector('[data-testid="chats-loading"]'));
const fromSidebar = async (vp, p, id) => {
  if (vp.drawer) await tap(vp, p, T("menu-btn"));
  await chatsSettled(p);
  await tap(vp, p, T(id));
};
const signOutAsked = async (vp, p) => {
  await fromSidebar(vp, p, "account-btn");
  await tap(vp, p, T("account-sign-out"));
  await p.locator('[data-pop="sign-out-confirm"]').waitFor();
};
const signOutTried = async (vp, p) => {
  await signOutAsked(vp, p);
  await tap(vp, p, T("sign-out-btn"));
};
const inviteMade = async (vp, p) => {
  await fromSidebar(vp, p, "add-bot-btn");
  await p.locator(T("bot-name")).fill("Lark");
  await tap(vp, p, '[data-pop="add-bot"] button:has-text("Create invite")');
  await p.locator(T("bot-prompt")).waitFor();
};
const serverInviteMade = async (vp, p) => {
  await tap(vp, p, T("bots-add"));
  await p.locator(T("bot-name")).fill("tarn");
  await tap(vp, p, '[data-pop="add-bot"] button:has-text("Create invite")');
  await p.locator(T("invite-code")).waitFor();
};
const joinAsked = async (vp, p) => {
  await inviteMade(vp, p);
  await tap(vp, p, T("invite-copy"));
  await p.locator(T("join-code")).waitFor({ timeout: 10_000 });
};
const send = async (vp, p, waitFor) => {
  await tap(vp, p, T("send"));
  await p.locator(waitFor).first().waitFor();
};
const chatSend = async (vp, p, waitFor) => {
  await p.locator(T("chat-input")).fill("Please run the build once more.");
  await tap(vp, p, T("chat-send"));
  await p.locator(waitFor).first().waitFor();
};
const pictureFile = (name, file) => ({
  name,
  mimeType: "image/png",
  buffer: fs.readFileSync(path.join("public/chat/media", file)),
});
const BUILD_LOG = { name: "build.log", mimeType: "text/plain", buffer: Buffer.concat([Buffer.from("build: passed\n"), Buffer.alloc(14 * 1024 - 14, "a")]) };
const attachedFiles = async (vp, p) => {
  await p.locator(T("chat-working-quiet")).waitFor();
  await p.locator(T("pick-photos")).setInputFiles([pictureFile("screenshot-1.png", "phone-search-1.png"), pictureFile("screenshot-2.png", "phone-search-keyboard.png")]);
  await p.locator(T("pick-files")).setInputFiles(BUILD_LOG);
  await p.locator(T("draft-file")).nth(2).waitFor();
};
const holdFirstReply = async (vp, p) => {
  const reply = p.locator(T("chat-bot-message")).first();
  await reply.waitFor();
  if (!vp.opts.hasTouch) {
    await reply.hover();
    await p.locator(T("message-actions")).waitFor();
    return;
  }
  await reply.evaluate((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: box.left + 60, clientY: box.top + 12 }));
  });
  await p.locator('[data-pop="message-actions"]').waitFor({ timeout: 3000 });
};
const quoteFirstReply = async (vp, p) => {
  await holdFirstReply(vp, p);
  await press(vp, p.locator(`${vp.opts.hasTouch ? '[data-pop="message-actions"]' : T("message-actions")} button`).filter({ hasText: "Reply" }));
  await p.locator(T("chat-quote")).waitFor();
};
const CHECK_MARK = 'svg path[d="M5 12.5l4.5 4.5L19 7.5"]';
const copyFirstReply = async (vp, p) => {
  await p.context().grantPermissions(["clipboard-write"]);
  await holdFirstReply(vp, p);
  await p.evaluate(() => {
    const later = window.setTimeout.bind(window);
    window.setTimeout = (run, ms, ...rest) => (ms === 700 || ms === 1200 ? 0 : later(run, ms, ...rest));
  });
  const actions = vp.opts.hasTouch ? '[data-pop="message-actions"]' : T("message-actions");
  await press(vp, p.locator(`${actions} button`).filter({ hasText: /^Copy$/ }));
  const copied = p.locator(`${actions} button`).filter({ hasText: /^Copied$/ });
  await copied.waitFor();
  if (vp.opts.hasTouch && !(await copied.locator(CHECK_MARK).count())) throw new Error("the Copied row has no check mark");
};
const returnNewline = async (vp, p) => {
  const input = p.locator(T("chat-input"));
  const mine = p.locator(T("chat-my-message"));
  await input.waitFor();
  const sent = await mine.count();
  await input.fill("Check the retry rule first.");
  await input.press("Enter");
  await input.pressSequentially("Then run the build once more.");
  const value = await input.inputValue();
  if (value !== "Check the retry rule first.\nThen run the build once more.") throw new Error(`Return did not start a new line: ${JSON.stringify(value)}`);
  if ((await mine.count()) !== sent) throw new Error("Return sent the message");
  if (!(await input.evaluate((el) => el.scrollHeight <= el.clientHeight + 1))) throw new Error("the box did not grow to show the second line");
};
const selectInFirstReply = async (vp, p) => {
  const reply = p.locator(T("chat-bot-message")).filter({ hasText: "Two cards need a pick" }).first();
  await reply.waitFor();
  await reply.scrollIntoViewIfNeeded();
  const text = reply.locator("[data-message-text]");
  await text.waitFor();
  await text.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf("Two cards need a pick");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + "Two cards need a pick".length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
  });
  await p.locator(T("selection-quote")).waitFor();
};
const picturesLoaded = async (vp, p) => {
  await p.locator(T("chat-picture")).first().waitFor();
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="chat-picture"]')].every((img) => img.complete && img.naturalWidth > 0));
  await p.evaluate(async () => {
    await Promise.all([...document.querySelectorAll('[data-testid="chat-picture"]')].map((img) => img.decode()));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
};
const openChatPicture = async (vp, p) => {
  await picturesLoaded(vp, p);
  await tap(vp, p, T("chat-picture-open"));
  await p.locator(T("viewer-image")).evaluate((img) => img.decode());
};
const openUnsentPicture = async (vp, p) => {
  await p.locator(T("pick-photos")).setInputFiles(pictureFile("screenshot-1.png", "phone-search-1.png"));
  await p.locator(T("draft-file")).waitFor();
  await tap(vp, p, T("chat-send"));
  await p.locator(T("chat-retry")).waitFor();
  await press(vp, p.locator(T("chat-picture-open")).last());
  await p.locator(T("viewer-image")).evaluate((img) => img.decode());
};
const showCardChanges = async (vp, p) => {
  const line = p.locator(T("chat-card-update")).first();
  await line.waitFor();
  await line.scrollIntoViewIfNeeded();
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="chat-picture"]')].every((img) => img.complete));
};
const refusedDrop = async (vp, p) => {
  const dataTransfer = await p.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(11534336)], "big-screenshot.png", { type: "image/png" }));
    transfer.items.add(new File([new Uint8Array(62914560)], "phone-recording.mov", { type: "video/quicktime" }));
    transfer.items.add(new File(["18:20:41 open search sheet"], "search-run.log", { type: "text/plain" }));
    return transfer;
  });
  await p.locator(T("chat")).dispatchEvent("dragenter", { dataTransfer });
  await p.locator(T("chat")).dispatchEvent("drop", { dataTransfer });
  await p.getByRole("alert").first().waitFor();
};
const shownText = (text) => (vp, p) => p.getByText(text).first().waitFor();
const evidenceShown = async (p) => {
  await p.locator(T("evidence-media")).first().scrollIntoViewIfNeeded();
  await p.waitForFunction(() => [...document.querySelectorAll('[data-testid="evidence"] img')].every((img) => img.complete));
};

const STATES = [
  { name: "queue", route: "/queue", shot: true, light: true },
  { name: "queue-empty", route: "/queue?queue=empty", shot: true, light: true },
  { name: "queue-error", route: "/queue?fail=list", shot: true, light: true, open: shownText("Could not load the Queue.") },
  { name: "queue-filter", route: "/queue", shot: true, light: true, open: async (vp, p) => { await tap(vp, p, T("filter-btn")); await p.locator(T("filter-show-row")).waitFor(); }, pop: listPop("filter"), closes: ["esc", "outside"] },
  { name: "queue-sort", route: "/queue", shot: true, light: true, open: (vp, p) => tap(vp, p, T("sort-btn")), pop: listPop("sort"), closes: ["esc", "outside"] },
  { name: "queue-no-match", route: "/queue", shot: true, light: true, open: (vp, p) => p.locator(T("queue-search")).fill("zebra") },
  { name: "queue-loading", route: "/queue?delay=600000", loading: true, shot: true, light: true, open: (vp, p) => p.locator(T("queue-loading")).waitFor() },
  { name: "queue-changed", route: "/queue?changed=2", shot: true, light: true, open: (vp, p) => p.locator(T("queue-changed")).waitFor() },
  {
    name: "queue-answered",
    route: "/queue?answered=1",
    shot: true,
    light: true,
    open: async (vp, p) => {
      await tap(vp, p, T("filter-btn"));
      await press(vp, p.getByRole("radio", { name: "Answered", exact: true }));
      if (vp.phone) await press(vp, p.locator('[data-pop="filter-sheet"]').getByRole("button", { name: "Done" }));
      else await p.keyboard.press("Escape");
      await p.locator("[data-pop]").waitFor({ state: "detached" });
      await p.getByText("You: A").first().waitFor();
    },
  },
  { name: "drawer", route: "/queue", only: "drawer", shot: true, open: (vp, p) => tap(vp, p, T("menu-btn")), pop: () => '[data-pop="drawer"]', closes: ["x", "esc", "outside"] },
  { name: "more-open", route: "/queue", when: (vp) => fullScreen(vp), shot: true, light: true, open: (vp, p) => tap(vp, p, T("float-more")), pop: () => '[data-pop="more"]', closes: ["esc", "outside"] },
  { name: "queue-scrolled", route: "/queue", when: (vp) => fullScreen(vp), shot: true, light: true, open: (vp, p) => p.evaluate(() => window.scrollTo(0, 600)) },
  {
    name: "search",
    route: "/queue",
    shot: true,
    open: async (vp, p) => {
      await fromSidebar(vp, p, "search-btn");
      await p.locator(`${T("search-group")}[data-group="Chats"]`).waitFor();
    },
    pop: () => '[data-pop="search"]',
    closes: dialogCloses,
  },
  { name: "task-card", route: "/queue/alba-1", shot: true, light: true },
  { name: "whole-card", route: "/queue/alba-1", open: (vp, p) => tap(vp, p, T("whole-card")) },
  { name: "sent", route: "/queue/alba-1", shot: true, light: true, open: (vp, p) => send(vp, p, T("got-it")) },
  { name: "send-failed", route: "/queue/alba-1?fail=send", shot: true, light: true, open: async (vp, p) => {
      await tap(vp, p, T("send"));
      await p.getByText("Not sent. Try again.").first().waitFor();
    } },
  { name: "confirm", route: "/queue/fx-oneway-pick?fixtures=now", shot: true, open: (vp, p) => send(vp, p, T("confirm")) },
  { name: "earlier-versions", route: "/queue/fx-history?fixtures=now", open: (vp, p) => tap(vp, p, `${T("earlier-versions")} summary`) },
  { name: "answered", route: "/queue/c10", shot: true, light: true },
  { name: "card-single", route: "/queue/fx-approve?fixtures=card-states", shot: true, light: true, open: (vp, p) => p.locator(T("ask")).waitFor() },
  { name: "card-option-open", route: "/queue/alba-1", shot: true, light: true, open: (vp, p) => tap(vp, p, `${T("option")}[data-letter="B"] button[aria-expanded]`) },
  { name: "card-past-due", route: "/queue/fx-past-due?fixtures=card-states", shot: true, light: true, open: (vp, p) => p.locator(T("past-due")).waitFor() },
  { name: "card-changed", route: "/queue/alba-1?rolled=alba-1", shot: true, light: true, open: (vp, p) => p.locator(T("changed-notice")).waitFor() },
  {
    name: "card-new-version",
    route: "/queue/alba-1?rolled=alba-1",
    shot: true,
    light: true,
    open: async (vp, p) => {
      await tap(vp, p, T("show-new-version"));
      await p.locator(T("changed-notice")).waitFor({ state: "detached" });
    },
  },
  { name: "card-closed", route: "/queue/alba-1?closed=alba-1", shot: true, light: true, open: (vp, p) => p.locator(T("closed-notice")).waitFor() },
  { name: "card-loading", route: "/queue/alba-1?delay=600000", loading: true, shot: true, light: true, open: (vp, p) => p.locator(T("card-loading")).waitFor() },
  {
    name: "card-keys",
    route: "/queue/alba-1",
    only: "wide",
    shot: true,
    open: async (vp, p) => {
      await p.locator(T("talk-to")).first().waitFor();
      await p.keyboard.press("?");
    },
    pop: () => '[data-pop="keys"]',
    closes: ["x", "esc", "outside"],
  },
  { name: "evidence", route: "/queue/fx-ev-overflow?fixtures=evidence", shot: true, open: (vp, p) => evidenceShown(p) },
  { name: "evidence-links", route: "/queue/alba-1", shot: true, open: async (vp, p) => {
      await evidenceShown(p);
      await p.locator(T("evidence-links")).scrollIntoViewIfNeeded();
    } },
  { name: "evidence-unsafe", route: "/queue/fx-ev-unsafe?fixtures=evidence", shot: true, open: async (vp, p) => {
      await evidenceShown(p);
      await p.getByText("Link blocked: not a safe address", { exact: true }).scrollIntoViewIfNeeded();
    } },
  { name: "evidence-link-confirm", route: "/queue/fx-ev-unsafe?fixtures=evidence", shot: true, open: async (vp, p) => {
      await evidenceShown(p);
      await tap(vp, p, T("evidence-link"));
      await p.getByRole("dialog", { name: "Open a link from Alba?", exact: true }).waitFor();
    }, pop: () => '[data-pop="bot-link-confirm"]', closes: dialogCloses },
  {
    name: "evidence-unavailable-video",
    route: "/queue/fx-ev-unsafe?fixtures=evidence",
    shot: true,
    open: async (vp, p) => {
      await evidenceShown(p);
      await press(vp, p.locator(T("evidence-media")).nth(1));
      await p.locator(T("viewer-no-play")).waitFor();
    },
    pop: () => '[data-pop="viewer"]',
    closes: ["x", "esc"],
  },
  {
    name: "evidence-unavailable-picture",
    route: "/queue/fx-ev-unsafe?fixtures=evidence",
    shot: true,
    open: async (vp, p) => {
      await evidenceShown(p);
      await tap(vp, p, T("evidence-media"));
      await p.locator(T("viewer-image")).waitFor();
    },
    pop: () => '[data-pop="viewer"]',
    closes: ["x", "esc"],
  },
  {
    name: "evidence-viewer",
    route: "/queue/alba-1",
    shot: true,
    open: async (vp, p) => {
      await evidenceShown(p);
      await tap(vp, p, T("evidence-media"));
      await p.waitForFunction(() => document.querySelector('[data-testid="viewer-image"]')?.complete);
    },
    pop: () => '[data-pop="viewer"]',
    closes: ["x", "esc"],
  },
  { name: "lane", route: "/lanes/l-set", shot: true, light: true },
  { name: "projects", route: "/projects", shot: true, light: true },
  {
    name: "lane-stages",
    route: "/lanes/l-da1",
    shot: true,
    light: true,
    open: async (vp, p) => {
      await tap(vp, p, T("stages-btn"));
      await p.locator(T("stages-list")).waitFor();
    },
  },
  { name: "lane-done", route: "/lanes/l-da2", shot: true, light: true, open: shownText("Talk to Dale") },
  {
    name: "lane-activity",
    route: "/lanes/l-sea?fixtures=lanes",
    shot: true,
    light: true,
    open: async (vp, p) => {
      const older = p.locator("summary", { hasText: "Show older" });
      await older.waitFor();
      await older.scrollIntoViewIfNeeded();
    },
  },
  { name: "lane-tracker-error", route: "/lanes/l-set?fail=trackers", open: shownText("Could not load the Lane tracker.") },
  { name: "projects-tracker-error", route: "/projects?fail=trackers", open: shownText("Could not load the Lane trackers.") },
  {
    name: "projects-done",
    route: "/projects/quarterdeck",
    open: async (vp, p) => {
      await tap(vp, p, `${T("done-lanes")} summary`);
      await p.locator(`${T("done-lanes")} ${T("lane-row")}`).first().waitFor();
    },
  },
  { name: "project", route: "/projects/heron-forge", shot: true, light: true },
  {
    name: "project-artifacts",
    route: "/projects/quarterdeck",
    shot: true,
    light: true,
    open: async (vp, p) => {
      const fold = p.locator("summary", { hasText: "Artifacts" });
      await fold.waitFor();
      if (!(await p.locator(T("artifact-row")).count())) await press(vp, fold);
      await p.locator(T("artifact-row")).last().scrollIntoViewIfNeeded();
    },
  },
  { name: "pages", route: "/projects/quarterdeck/pages", shot: true, light: true },
  { name: "pages-filter", route: "/projects/quarterdeck/pages", open: (vp, p) => tap(vp, p, T("filter-btn")), pop: listPop("filter"), closes: ["esc", "outside"] },
  { name: "pages-sort", route: "/projects/quarterdeck/pages", open: (vp, p) => tap(vp, p, T("sort-btn")), pop: listPop("sort"), closes: ["esc", "outside"] },
  { name: "pages-no-match", route: "/projects/quarterdeck/pages", open: (vp, p) => p.getByPlaceholder("Search pages").fill("zebra") },
  { name: "pages-error", route: "/projects/quarterdeck/pages?fail=list", open: shownText("Could not load the Pages.") },
  { name: "mail", route: "/mail", shot: true, light: true },
  { name: "mail-thread", route: "/mail/MT-101", shot: true, light: true },
  { name: "mail-thread-cc", route: "/mail/MT-107", shot: true, light: true, open: (vp, p) => p.locator(T("mail-item")).nth(3).waitFor() },
  { name: "mail-forward", route: "/mail/MT-106", shot: true, light: true, open: (vp, p) => p.locator(T("forward-quote")).waitFor() },
  { name: "mail-forwarded-by", route: "/mail/MT-101.2", shot: true, light: true, open: (vp, p) => p.locator(T("forwarded-by")).waitFor() },
  { name: "mail-removed", route: "/mail/MT-105", shot: true, light: true, open: (vp, p) => p.locator(T("mail-removed-note")).waitFor() },
  { name: "mail-forwarded-removed", route: "/mail/MT-920?mailfx=MF-6", shot: true, light: true, open: (vp, p) => p.locator(T("mail-removed-note")).waitFor() },
  { name: "mail-empty", route: "/mail?mailfx=MF-7", shot: true, light: true, open: (vp, p) => p.locator(T("mail-empty")).waitFor() },
  { name: "mail-list-more", route: "/mail", when: (vp) => fullScreen(vp), shot: true, light: true, open: (vp, p) => tap(vp, p, T("float-more")), pop: () => '[data-pop="more"]', closes: ["esc", "outside"] },
  { name: "mail-thread-more", route: "/mail/MT-101", when: (vp) => fullScreen(vp), shot: true, light: true, open: (vp, p) => tap(vp, p, T("float-more")), pop: () => '[data-pop="more"]', closes: ["esc", "outside"] },
  { name: "mail-ask", route: "/mail/MT-101", shot: true, light: true, open: (vp, p) => tap(vp, p, T("ask-MT-101.2")), pop: () => '[data-pop="ask"]', closes: ["esc", "outside"] },
  { name: "mail-ask-thread", route: "/mail/MT-107", open: (vp, p) => tap(vp, p, T("ask-MT-107")), pop: () => '[data-pop="ask"]', closes: ["esc", "outside"] },
  {
    name: "mail-ask-more",
    route: "/mail/MT-107",
    open: async (vp, p) => {
      await tap(vp, p, T("ask-MT-107.3"));
      await tap(vp, p, T("ask-another"));
    },
    pop: () => '[data-pop="ask"]',
    closes: ["esc", "outside"],
  },
  { name: "mail-many-bots", route: "/mail?mailfx=MF-2", open: (vp, p) => p.locator(T("mail-row")).nth(2).waitFor() },
  { name: "mail-long-names", route: "/mail?mailfx=MF-4", open: (vp, p) => p.locator(T("mail-row")).first().waitFor() },
  { name: "mail-long-names-thread", route: "/mail/MT-920?mailfx=MF-4", shot: true, light: true, open: (vp, p) => p.locator(T("mail-item")).first().waitFor() },
  { name: "mail-no-project", route: "/mail/MT-930?mailfx=MF-9", shot: true, light: true, open: (vp, p) => p.locator(T("mail-item")).first().waitFor() },
  { name: "mail-thread-loading", route: "/mail/MT-101?hold=mail-thread", loading: true, shot: true, light: true, open: (vp, p) => p.locator(`${T("mail-thread")} [role="status"]`).waitFor() },
  { name: "mail-thread-failed", route: "/mail/MT-101?fail=mail-thread", shot: true, light: true, open: (vp, p) => p.locator(`${T("mail-thread")} [role="alert"]`).waitFor() },
  { name: "mail-omitted", route: "/mail/MT-940?mailfx=MF-10", shot: true, light: true, open: (vp, p) => p.locator(T("mail-omitted")).waitFor() },
  { name: "page", route: "/projects/quarterdeck/pages/PG-1", shot: true, light: true },
  { name: "page-error", route: "/projects/quarterdeck/pages/PG-1?fail=page", open: shownText("This Page did not load.") },
  { name: "page-ready", route: "/projects/heron-forge/pages/PG-3", shot: true, light: true, open: shownText("Version 2 is ready.") },
  { name: "page-menu", route: "/projects/quarterdeck/pages/PG-2", open: (vp, p) => tap(vp, p, T("page-more")), pop: listPop("page"), closes: ["esc", "outside"] },
  {
    name: "page-make-public",
    route: "/projects/quarterdeck/pages/PG-2",
    shot: true,
    light: true,
    open: async (vp, p) => {
      await tap(vp, p, T("page-more"));
      await tap(vp, p, 'button:has-text("Make public...")');
      await p.locator(T("make-public-confirm")).waitFor();
    },
  },
  { name: "page-no-file", route: "/projects/quarterdeck/pages/PG-9?fixtures=pages", open: (vp, p) => p.locator(T("no-file")).waitFor() },
  { name: "artifact", route: "/projects/quarterdeck/artifacts/AR-1", shot: true, light: true },
  { name: "pages-off", route: "/projects/quarterdeck/pages/PG-1?fail=pages-off", shot: true, light: true, open: (vp, p) => p.locator(T("pages-off")).waitFor() },
  { name: "chat", route: "/chat/iris", shot: true, open: (vp, p) => chatSend(vp, p, `${T("chat-working-note")}:text-is("reading your message")`) },
  { name: "chat-failed", route: "/chat/iris?fail=chat", open: (vp, p) => chatSend(vp, p, T("chat-retry")) },
  { name: "chat-cite", route: "/chat/iris", open: (vp, p) => tap(vp, p, T("cite-btn")), pop: () => '[data-pop="cite"]', closes: ["esc", "outside"] },
  {
    name: "chat-quote",
    route: "/queue/alba-1",
    open: async (vp, p) => {
      await tap(vp, p, T("talk-to"));
      await p.locator(T("chat-quote")).waitFor();
    },
  },
  { name: "chat-working", route: "/chat/dr-kivo", shot: true, open: shownText("reading MT-101.2 and the test log AR-1") },
  { name: "chat-no-word", route: "/chat/iris", shot: true, open: shownText("No word for 10 minutes.") },
  { name: "chat-files", route: "/chat/alba", shot: true, open: async (vp, p) => {
      await picturesLoaded(vp, p);
      await p.locator(T("chat-attachments")).filter({ has: p.locator(T("chat-picture")) }).first().scrollIntoViewIfNeeded();
    } },
  { name: "chat-new-line", route: "/chat/alba", shot: true, light: true, open: async (vp, p) => {
      await picturesLoaded(vp, p);
      await p.locator(T("chat-new")).scrollIntoViewIfNeeded();
    } },
  { name: "chat-quote-unverified", route: "/chat/alba?chatfx=CF-IDENTITY", shot: true, open: async (vp, p) => {
      await p.getByText("Unverified quoted words.", { exact: true }).scrollIntoViewIfNeeded();
      await p.getByText("Quoted by Alba; not found in this chat", { exact: true }).first().waitFor();
    } },
  { name: "chat-security", route: "/chat/alba?chatfx=CF-SEC", shot: true, open: async (vp, p) => {
      await p.locator(T("chat-picture-failed")).waitFor();
      await p.getByText("Link blocked: not a safe address", { exact: true }).scrollIntoViewIfNeeded();
    } },
  { name: "chat-link-confirm", route: "/chat/alba?chatfx=CF-SEC", shot: true, open: async (vp, p) => {
      await tap(vp, p, T("bot-link"));
      await p.getByRole("dialog", { name: "Open a link from Alba?", exact: true }).waitFor();
    }, pop: () => '[data-pop="bot-link-confirm"]', closes: dialogCloses },
  { name: "chat-security-file", route: "/chat/alba?chatfx=CF-SEC", shot: true, open: async (vp, p) => {
      await tap(vp, p, T("chat-file"));
      await p.getByText("Could not open this file.", { exact: true }).waitFor();
    }, pop: () => '[data-pop="file-viewer"]', closes: dialogCloses },
  { name: "chat-card-changes", route: "/chat/alba", shot: true, open: showCardChanges },
  { name: "chat-file-open", route: "/chat/alba", open: async (vp, p) => {
      await tap(vp, p, T("chat-file"));
      await p.locator(T("file-text")).waitFor();
    }, pop: () => '[data-pop="file-viewer"]', closes: dialogCloses },
  { name: "chat-picture-viewer", route: "/chat/alba", shot: true, open: openChatPicture, pop: () => '[data-pop="viewer"]', closes: ["x", "esc"] },
  { name: "chat-unsent-picture-viewer", route: "/chat/iris?fail=chat", open: openUnsentPicture, pop: () => '[data-pop="viewer"]', closes: ["x", "esc"] },
  { name: "chat-picture-failed", route: "/chat/alba?chatfx=CF-4", shot: true, allowErrors: /Failed to load resource/, open: (vp, p) => p.locator(T("chat-picture-failed")).waitFor() },
  { name: "chat-many-pictures", route: "/chat/dale?chatfx=CF-7", shot: true, open: picturesLoaded },
  { name: "chat-no-text", route: "/chat/dale?chatfx=CF-6", shot: true, open: picturesLoaded },
  { name: "chat-actions", route: "/chat/iris", shot: true, open: holdFirstReply, pop: (vp) => (vp.opts.hasTouch ? '[data-pop="message-actions"]' : T("message-actions")), closes: (vp) => (vp.opts.hasTouch ? ["esc", "outside"] : []) },
  { name: "chat-actions-copy", route: "/chat/iris", shot: true, open: copyFirstReply, pop: (vp) => (vp.opts.hasTouch ? '[data-pop="message-actions"]' : T("message-actions")) },
  { name: "chat-message-quote", route: "/chat/iris", shot: true, open: quoteFirstReply },
  { name: "chat-selection", route: "/chat/iris", when: (vp) => !vp.opts.hasTouch, open: selectInFirstReply },
  { name: "chat-return-newline", route: "/chat/iris", shot: true, when: (vp) => vp.opts.hasTouch, open: returnNewline },
  { name: "chat-plus", route: "/chat/iris", open: (vp, p) => tap(vp, p, T("plus-btn")), pop: () => '[data-pop="plus"]', closes: ["esc", "outside"] },
  { name: "chat-strip", route: "/chat/iris", shot: true, open: attachedFiles },
  { name: "chat-refused", route: "/chat/alba", shot: true, open: refusedDrop },
  { name: "chat-secret-request", route: "/chat/alba", shot: true, open: (vp, p) => p.locator(T("secret-request")).scrollIntoViewIfNeeded() },
  {
    name: "chat-secret-box",
    route: "/chat/iris",
    shot: true,
    open: async (vp, p) => {
      await tap(vp, p, T("plus-btn"));
      await tap(vp, p, T("plus-secret"));
      await p.locator(T("secret-box")).waitFor();
    },
  },
  { name: "settings", route: "/settings", shot: true, light: true, open: (vp, p) => p.locator(T("settings-screen")).waitFor() },
  { name: "settings-from-gear", route: "/queue", open: async (vp, p) => { await fromSidebar(vp, p, "settings-btn"); await p.locator(T("settings-screen")).waitFor(); } },
  { name: "settings-bots", route: "/settings/bots", shot: true, light: true, open: (vp, p) => p.locator(T("pending-join")).waitFor() },
  { name: "settings-bots-server", route: "/settings/bots?bots=server", shot: true, light: true, open: (vp, p) => p.locator(T("bots-add")).waitFor() },
  { name: "settings-bots-refused", route: "/settings/bots?bots=refused", shot: true, light: true, open: (vp, p) => p.getByRole("alert").filter({ hasText: "That request is no longer waiting." }).waitFor() },
  { name: "settings-bots-failed", route: "/settings/bots?bots=failed", shot: true, light: true, open: (vp, p) => p.getByRole("alert").filter({ hasText: "Could not load the bots." }).waitFor() },
  { name: "settings-bot", route: "/settings/bots/alba", shot: true, light: true, open: (vp, p) => p.locator(T("remove-bot")).waitFor() },
  { name: "remove-bot", route: "/settings/bots/alba", shot: true, light: true, open: (vp, p) => tap(vp, p, T("remove-bot")), pop: () => '[data-pop="remove-bot"]', closes: ["esc", "outside"] },
  { name: "settings-storage", route: "/settings/storage", shot: true, light: true, open: (vp, p) => p.locator(T("storage-size")).waitFor() },
  { name: "storage-cleanup", route: "/settings/storage", shot: true, light: true, open: (vp, p) => tap(vp, p, T("switch")), pop: () => '[data-pop="cleanup"]', closes: ["esc", "outside"] },
  { name: "settings-account", route: "/settings/account", shot: true, light: true, open: (vp, p) => p.locator(T("sign-out")).waitFor() },
  { name: "add-bot", route: "/queue", shot: true, light: true, open: (vp, p) => fromSidebar(vp, p, "add-bot-btn"), pop: () => '[data-pop="add-bot"]', closes: dialogCloses },
  { name: "add-invite", route: "/queue", shot: true, light: true, open: inviteMade, pop: () => '[data-pop="add-bot"]', closes: dialogCloses },
  { name: "add-bot-invite-server", route: "/settings/bots?bots=server", shot: true, light: true, open: serverInviteMade, pop: () => '[data-pop="add-bot"]', closes: dialogCloses },
  {
    name: "add-waiting",
    route: "/queue",
    shot: true,
    light: true,
    open: async (vp, p) => {
      await inviteMade(vp, p);
      await tap(vp, p, T("invite-copy"));
      await p.locator(T("bot-waiting")).waitFor();
    },
    pop: () => '[data-pop="add-bot"]',
    closes: dialogCloses,
  },
  { name: "join-request", route: "/queue", shot: true, light: true, open: joinAsked, pop: () => '[data-pop="add-bot"]', closes: dialogCloses },
  {
    name: "joined",
    route: "/queue",
    shot: true,
    light: true,
    open: async (vp, p) => {
      await joinAsked(vp, p);
      await tap(vp, p, T("join-approve"));
      await p.locator(T("joined-chat")).waitFor();
    },
    pop: () => '[data-pop="add-bot"]',
    closes: dialogCloses,
  },
  { name: "account-menu", route: "/queue", shot: true, light: true, open: (vp, p) => fromSidebar(vp, p, "account-btn"), pop: () => '[data-pop="account-menu"]', closes: ["esc", "outside"] },
  { name: "sign-out-confirm", route: "/queue", shot: true, light: true, open: signOutAsked, pop: () => '[data-pop="sign-out-confirm"]', closes: ["esc", "outside"] },
  {
    name: "sign-out-failed",
    route: "/queue?fail=sign-out",
    shot: true,
    light: true,
    open: async (vp, p) => {
      await signOutTried(vp, p);
      await p.getByText("Sign-out did not reach Quarterdeck. Try again.").waitFor();
    },
    pop: () => '[data-pop="sign-out-confirm"]',
    closes: ["esc", "outside"],
  },
  {
    name: "signed-out",
    route: "/queue",
    shot: true,
    light: true,
    open: async (vp, p) => {
      await signOutTried(vp, p);
      await p.locator(T("signed-out")).waitFor();
    },
  },
];

function rules() {
  const found = [];
  const text = document.body.innerText;
  if (/\bneeds? you\b|\bawaiting you\b/i.test(text)) found.push("banned wording on screen");
  if (/\bFYI\b/.test(text)) found.push("FYI on screen");
  for (const row of document.querySelectorAll('[data-testid="card-row"]')) {
    if (/\b(our pick|score|rank)\b/i.test(row.innerText)) found.push(`a Queue row shows a pick, score or rank: ${row.innerText.split("\n")[0]}`);
  }
  const pops = document.querySelectorAll("[data-pop]").length;
  if (pops > 1) found.push(`${pops} pop-ups open at once`);
  const main = document.getElementById("main-scroll");
  if (main && main.scrollWidth > main.clientWidth + 1) found.push("the main area scrolls sideways");
  if (document.documentElement.scrollWidth > innerWidth + 1) found.push("the page scrolls sideways");
  return found;
}

function floatKit() {
  const found = [];
  const parts = [...document.querySelectorAll("[data-float]")].filter((el) => el.getClientRects().length);
  if (!parts.length) return found;
  const probe = document.createElement("div");
  probe.className = "frost";
  probe.style.cssText = "position:fixed;visibility:hidden;top:0;left:0;padding:max(8px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) 0 max(12px,env(safe-area-inset-left))";
  document.body.append(probe);
  const kit = getComputedStyle(probe);
  const glass = (s) => [s.backgroundColor, s.backdropFilter, s.borderTopWidth, s.borderTopStyle, s.borderTopColor, s.boxShadow].join(" | ");
  const want = { glass: glass(kit), top: parseFloat(kit.paddingTop), left: parseFloat(kit.paddingLeft), right: parseFloat(kit.paddingRight) };
  probe.remove();
  const SIZE = 44;
  const SIDE = { toggle: "left", back: "left", capsule: "right" };
  for (const el of parts) {
    const part = el.dataset.float;
    const name = `${part} "${el.getAttribute("aria-label") ?? el.innerText.trim().slice(0, 24)}"`;
    if (!(part in SIDE) && part !== "label") {
      found.push(`one floating kit: ${name} is not a kit part`);
      continue;
    }
    const box = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const off = [];
    if (Math.abs(box.height - SIZE) > 0.5) off.push(`height ${Math.round(box.height)} px, kit ${SIZE}`);
    if ((part === "toggle" || part === "back") && Math.abs(box.width - SIZE) > 0.5) off.push(`width ${Math.round(box.width)} px, kit ${SIZE}`);
    if (Math.abs(box.top - want.top) > 0.5) off.push(`${Math.round(box.top)} px from the top, kit ${want.top}`);
    if (SIDE[part] === "left" && Math.abs(box.left - want.left) > 0.5) off.push(`${Math.round(box.left)} px from the left, kit ${want.left}`);
    if (SIDE[part] === "right" && Math.abs(innerWidth - box.right - want.right) > 0.5) off.push(`${Math.round(innerWidth - box.right)} px from the right, kit ${want.right}`);
    if (parseFloat(s.borderTopLeftRadius) + 0.5 < box.height / 2) off.push(`corner ${s.borderTopLeftRadius}, kit fully round`);
    if (glass(s) !== want.glass) off.push(`glass ${glass(s)}, kit ${want.glass}`);
    if (off.length) found.push(`one floating kit: ${name} is off the kit: ${off.join("; ")}`);
  }
  return found;
}

function closedState() {
  const pops = document.querySelectorAll("[data-pop]").length;
  const main = document.getElementById("main-scroll");
  return { pops, inert: !!(main && main.inert) };
}

async function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitUp(url) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("the app server did not start");
}

async function modeOf(vp) {
  const context = await browser.newContext({ ...vp.opts, colorScheme: "dark" });
  const p = await context.newPage();
  await p.goto(origin + "/queue");
  const mode = await p.locator("#stage[data-mode]").getAttribute("data-mode");
  await context.close();
  return mode;
}

function pixelDiff([a, b, skip]) {
  const load = (src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = src;
  });
  const pixels = (img) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height).data;
  };
  return Promise.all([load(a), load(b)]).then(([ia, ib]) => {
    if (ia.width !== ib.width || ia.height !== ib.height) return { changed: Infinity, delta: 255 };
    const da = pixels(ia);
    const db = pixels(ib);
    let changed = 0;
    let delta = 0;
    for (let i = 0; i < da.length; i += 4) {
      const x = (i / 4) % ia.width;
      const y = Math.floor(i / 4 / ia.width);
      if (skip.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) continue;
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d) {
        changed++;
        delta = Math.max(delta, d);
      }
    }
    return { changed, delta };
  });
}

async function frameCorners(p, vp) {
  const frame = p.locator(T("page-frame"));
  if (!(await frame.count())) return [];
  const box = await frame.boundingBox();
  const scale = vp.opts.deviceScaleFactor;
  return [box.x - 1, box.x + box.width - 17].map((x) => ({ x: Math.floor(x * scale), y: Math.floor((box.y - 1) * scale), w: 18 * scale, h: 18 * scale }));
}

async function onlyNoise(file, skip) {
  const shown = spawnSync("git", ["show", `HEAD:${file.split(path.sep).join("/")}`], { maxBuffer: 64 * 1024 * 1024 });
  if (shown.status || !shown.stdout.length) return false;
  const fresh = fs.readFileSync(file);
  if (shown.stdout.equals(fresh)) return false;
  const url = (buf) => "data:image/png;base64," + buf.toString("base64");
  const diff = await diffPage.evaluate(pixelDiff, [url(shown.stdout), url(fresh), skip]);
  if (diff.changed > NOISE_PIXELS || diff.delta > NOISE_DELTA) return false;
  fs.writeFileSync(file, shown.stdout);
  return true;
}

async function firstScreen(at) {
  const context = await browser.newContext({ ...VIEWPORTS[0].opts, colorScheme: "dark" });
  const p = await context.newPage();
  const cdp = await context.newCDPSession(p);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", SLOW_4G);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  let bytes = 0;
  cdp.on("Network.loadingFinished", (e) => {
    bytes += e.encodedDataLength;
  });
  await p.addInitScript((sel) => {
    const seen = () => {
      const row = document.querySelector(sel);
      if (!row || !row.getClientRects().length || !row.checkVisibility({ visibilityProperty: true })) return false;
      requestAnimationFrame(() => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => (window.__qdFirstRow = performance.now());
        ch.port2.postMessage(0);
      });
      return true;
    };
    new MutationObserver((_, obs) => seen() && obs.disconnect()).observe(document, { childList: true, subtree: true, attributes: true });
  }, T("card-row"));
  const started = Date.now();
  await p.goto(at + "/queue", { waitUntil: "commit" });
  await p.locator(T("card-row")).first().waitFor({ state: "visible", timeout: 20000 });
  const polled = Date.now() - started;
  const painted = await p.waitForFunction(() => window.__qdFirstRow, null, { timeout: 5000 }).then((h) => h.jsonValue(), () => 0);
  const ms = painted ? Math.round(painted) : polled;
  await p.waitForLoadState("load");
  await context.close();
  return { ms, polled, inPage: Boolean(painted), bytes };
}

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const spreadOf = (list) => Math.max(...list) - Math.min(...list);
const signed = (n) => (n > 0 ? "+" : "") + n;
const roundGaps = (mine, base) => mine.ms.map((x, i) => x - base.ms[i]);

async function baseBuild() {
  const archive = spawnSync("git", ["archive", "--format=tar", BASE_REF], { maxBuffer: 512 * 1024 * 1024 });
  if (archive.status) return { why: `git cannot read ${BASE_REF}` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-check-base-"));
  const unpacked = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });
  if (unpacked.status) return { why: `${BASE_REF} did not unpack`, dir };
  fs.symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"));
  const built = spawnSync(process.execPath, ["tools/build-app.mjs", "--fixtures"], { cwd: dir, stdio: "ignore" });
  if (built.status) return { why: `${BASE_REF} did not build`, dir };
  const basePort = await freePort();
  const baseServer = spawn(process.execPath, ["tools/serve-app.mjs"], { cwd: dir, env: { ...process.env, PORT: String(basePort) }, stdio: "ignore" });
  const at = `http://127.0.0.1:${basePort}`;
  try {
    await waitUp(at + "/queue");
  } catch {
    baseServer.kill();
    return { why: `${BASE_REF} did not start`, dir };
  }
  const rev = spawnSync("git", ["rev-parse", "--short", BASE_REF], { encoding: "utf8" }).stdout.trim();
  return { at, dir, server: baseServer, name: `${BASE_REF} ${rev}` };
}

async function firstScreenTurn() {
  const base = await baseBuild();
  const sides = [{ name: "this build", at: origin, ms: [], bytes: [], inPage: [] }];
  if (base.at) sides.push({ name: base.name, at: base.at, ms: [], bytes: [], inPage: [] });
  const before = os.loadavg()[0].toFixed(1);
  try {
    for (const side of sides) await firstScreen(side.at);
    for (let n = 0; n < FIRST_SCREEN_LOADS; n += 1) {
      for (const side of n % 2 ? [...sides].reverse() : sides) {
        const got = await firstScreen(side.at);
        side.ms.push(got.ms);
        side.bytes.push(got.bytes);
        side.inPage.push(got.inPage);
      }
    }
  } finally {
    base.server?.kill();
    if (base.dir) fs.rmSync(base.dir, { recursive: true, force: true });
  }
  return { sides, why: base.why, before, after: os.loadavg()[0].toFixed(1) };
}

function judgeFirstScreen({ sides, why }) {
  const [mine, base] = sides;
  const ms = median(mine.ms);
  const bytes = median(mine.bytes);
  const problems = [];
  if (bytes > FIRST_LOAD_BYTES) problems.push(`downloaded ${bytes} bytes, over ${FIRST_LOAD_BYTES}`);
  if (!base) {
    if (ms > FIRST_SCREEN_MS) problems.push(`took ${ms} ms on a slow 4G phone, over ${FIRST_SCREEN_MS} ms (no ${BASE_REF} build to compare with: ${why})`);
    return problems;
  }
  const slower = median(roundGaps(mine, base));
  const grew = bytes - median(base.bytes);
  if (slower > FIRST_SCREEN_SLOWER_MS) problems.push(`took ${ms} ms on a slow 4G phone, ${slower} ms slower than ${base.name} (${median(base.ms)} ms) in the same turn (median of the round-by-round gaps), over the ${FIRST_SCREEN_SLOWER_MS} ms margin`);
  if (grew > FIRST_LOAD_GROWTH_BYTES) problems.push(`downloads ${grew} bytes more than ${base.name}, over ${FIRST_LOAD_GROWTH_BYTES}`);
  return problems;
}

function firstScreenLines({ sides, why, before, after }) {
  const [mine, base] = sides;
  const show = (s) => `${s.name} ${median(s.ms)} ms (spread ${spreadOf(s.ms)}, ${(median(s.bytes) / 1024).toFixed(1)} KB)`;
  const polling = sides.reduce((n, s) => n + s.inPage.filter((seen) => !seen).length, 0);
  const lines = [`design-check: first screen on a slow 4G phone (4x slower CPU), median of ${FIRST_SCREEN_LOADS} loads${base ? " each, taken in turn" : ""}: ${sides.map(show).join(" against ")}`];
  if (base) lines.push(`design-check: against ${base.name}: ${signed(median(roundGaps(mine, base)))} ms (median of the ${FIRST_SCREEN_LOADS} round-by-round gaps) and ${signed(median(mine.bytes) - median(base.bytes))} bytes; it fails over +${FIRST_SCREEN_SLOWER_MS} ms or +${FIRST_LOAD_GROWTH_BYTES} bytes; the absolute ${FIRST_SCREEN_MS} ms is reported (this build ${median(mine.ms)} ms), not a limit`);
  else lines.push(`design-check: no ${BASE_REF} build to compare with (${why}), so the absolute ${FIRST_SCREEN_MS} ms limit applies`);
  lines.push(`design-check: load average ${before} before and ${after} after${polling ? `; ${polling} loads were timed by Playwright's polling because the in-page timer did not fire` : ""}`);
  return lines;
}

const build = spawnSync(process.execPath, ["tools/build-app.mjs", "--fixtures"], { stdio: "inherit" });
if (build.status) process.exit(build.status ?? 1);
const port = await freePort();
const server = spawn(process.execPath, ["tools/serve-app.mjs"], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
const origin = `http://127.0.0.1:${port}`;
const failures = [];
const shots = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(FAILED, { recursive: true, force: true });
let speed = null;
let steadied = 0;
const known = new Set(fs.existsSync(KNOWN_FILE) ? JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8")).known : []);
const seenKnown = new Set();
const layoutKeys = [];

const browser = await chromium.launch(chromeLaunchOptions({ args: ["--no-sandbox"] }));
const diffPage = await browser.newPage();
try {
  await waitUp(origin + "/queue");
  for (const base of FIRST_SCREEN_ONLY ? [] : VIEWPORTS) {
    if (SIZES && !SIZES.includes(base.name)) continue;
    const mode = await modeOf(base);
    if (base.expect && mode !== base.expect) fail(base.name, `layout is ${mode}, expected ${base.expect}`);
    const vp = { ...base, phone: mode === "phone", drawer: mode !== "mac" };
    const stageAt = async (p, dx, dy) => {
      const box = await p.locator("#stage").boundingBox();
      return { x: box.x + (dx < 0 ? box.width + dx : dx), y: Math.max(box.y, 0) + dy };
    };
    for (const look of LOOKS) for (const st of STATES) {
      if (ONLY && !ONLY.includes(st.name)) continue;
      if (st.only === "drawer" && !vp.drawer) continue;
      if (st.when && !st.when(vp)) continue;
      if (st.only === "wide" && vp.phone) continue;
      const where = `${st.name} ${vp.name}${look === "dark" ? "" : " " + look}`;
      const context = await browser.newContext({ ...vp.opts, colorScheme: look, reducedMotion: "reduce" });
      if (MUTANT) await context.addInitScript(() => window.addEventListener("keydown", (e) => e.key === "Escape" && e.stopImmediatePropagation(), true));
      const p = await context.newPage();
      await p.clock.setFixedTime(new Date("2026-11-02T14:05:00Z"));
      const errors = [];
      p.on("pageerror", (err) => errors.push(err.message));
      p.on("console", (msg) => msg.type() === "error" && !CLOCK_IN_SANDBOX.test(msg.text()) && !st.allowErrors?.test(msg.text()) && errors.push(msg.text()));
      p.setDefaultTimeout(4000);
      const load = async (page = p) => {
        await page.goto(origin + st.route);
        await page.locator("#stage[data-mode]").waitFor();
        await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
        if (st.open) await st.open(vp, page);
        if (st.pop) await page.locator(st.pop(vp)).first().waitFor();
        if (!st.loading) await page.waitForFunction(() => !document.querySelector('[role="status"][aria-label="Loading"]'), null, { timeout: 20000 });
        await chatsSettled(page);
        if (MUTANT)
          await page.evaluate(() => {
            document.getElementById("main-scroll")?.insertAdjacentHTML("afterbegin", '<div style="width:4000px;height:1px"></div>');
            document.body.insertAdjacentHTML("beforeend", '<button type="button" data-testid="mutant-offscreen" style="position:fixed;left:-400px;top:40px;width:120px;height:44px">Gone</button><a href="#x" aria-current="page" data-testid="mutant-faded" style="position:fixed;left:40px;top:40px;width:120px;height:44px;opacity:0">Faded</a><button type="button" data-testid="mutant-tiny" style="position:fixed;left:40px;top:100px;width:20px;height:20px">t</button><button type="button" data-float="toggle" aria-label="Off-kit menu" data-testid="mutant-off-kit" style="position:fixed;left:16px;top:160px;width:40px;height:40px;border-radius:8px">m</button>');
          });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(250);
      };
      try {
        await load();
        const now = await p.locator("#stage").getAttribute("data-mode");
        if (now !== mode) fail(where, `layout is ${now}`);
        const sel = st.pop ? st.pop(vp) : null;
        if (sel && !(await p.locator(sel).first().isVisible())) fail(where, "the pop-up did not open");
        for (const f of [...(await p.evaluate(rules)), ...(await p.evaluate(floatKit))]) fail(where, f);
        if (vp.shot && st.shot && (look === "dark" || st.light)) {
          const file = path.join(OUT, `${st.name}-${vp.name}${look === "dark" ? "" : "-" + look}.png`);
          if (!MUTANT) {
            await p.screenshot({ path: file });
            if (await onlyNoise(file, await frameCorners(p, vp))) steadied++;
          }
          shots.push(file);
        }
        const ux = await p.evaluate(measureUx, { phone: vp.phone, state: st.name });
        const pills = await p.evaluate(measurePills, PILLS);
        const layout = await p.evaluate(measure);

        const issues = [...ux.issues, ...pills.issues, ...layout.issues];
        for (const issue of issues) {
          const key = `${where}: ${issue.kind}: ${issue.el}`;
          layoutKeys.push(key);
          if (known.has(key) && !WRITE_KNOWN) seenKnown.add(key);
          else fail(where, `${issue.kind}: ${issue.el} ${issue.what}${issue.hidden && issue.hidden.length ? ` (${issue.hidden.join("; ")})` : ""}`);
        }
        if (issues.length && !MUTANT) {
          fs.mkdirSync(FAILED, { recursive: true });
          await p.screenshot({ path: path.join(FAILED, `${st.name}-${vp.name}${look === "dark" ? "" : "-" + look}.png`) });
        }
        const closes = typeof st.closes === "function" ? st.closes(vp) : st.closes || [];
        for (const how of closes) {
          await load();
          if (how === "x") await press(vp, p.locator(sel).first().locator(`${T("pop-close")},${T("settings-close")},[aria-label^="Close"]`).first());
          if (how === "esc") await p.keyboard.press("Escape");
          if (how === "outside") await tapAt(vp, p, st.name === "drawer" ? await stageAt(p, -20, 400) : vp.phone ? await stageAt(p, 40, 24) : await stageAt(p, 8, 8));
          await p.waitForTimeout(300);
          const after = await p.evaluate(closedState);
          if (after.pops || after.inert) fail(where, `${how} left it open or stuck ${JSON.stringify(after)}`);
        }
      } catch (err) {
        fail(where, `a step could not run (${String(err.message).split("\n")[0]})`);
      }
      if (errors.length) fail(where, `console errors: ${errors.join(" | ")}`);
      await context.close();
    }
  }
  if (FIRST_SCREEN_ONLY || (!ONLY && (!SIZES || SIZES.includes("phone-390")))) {
    speed = await firstScreenTurn();
    for (const problem of judgeFirstScreen(speed)) fail("first screen phone-390", problem);
  }
} finally {
  await browser.close();
  server.kill();
}

const index = [
  "# Design check screenshots",
  "",
  "Written by `npm run design:check`. Screenshots of the main states at phone 390 px, iPad sideways 1133x744, iPad upright 744x1133 and Mac 1512x982.",
  "Every state in tools/design-check.mjs is checked at all eight sizes, in the dark and the light look; the other four (Mac 1280x800, 1024x700 and 756x900, iPhone 440x956) have no screenshots. Light shots, named -light, cover the Queue and Task Card states.",
  "",
];
for (const vp of VIEWPORTS.filter((v) => v.shot)) {
  index.push(`## ${vp.name}`, "");
  for (const file of shots.filter((f) => f.endsWith(`-${vp.name}.png`) || f.endsWith(`-${vp.name}-light.png`))) index.push(`- [${path.basename(file, ".png")}](shots/${path.basename(file)})`);
  index.push("");
}
if (!MUTANT && WHOLE) fs.writeFileSync(path.join("design-check", "SHOTS.md"), index.join("\n"));
const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", OUT], { encoding: "utf8" }).stdout.trimEnd();
const taken = new Set(shots.map((f) => f.split(path.sep).join("/")));
const changed = status ? [...new Set(status.split("\n").map((l) => l.slice(3)))].filter((f) => taken.has(f)) : [];
if (!MUTANT && !FIRST_SCREEN_ONLY) console.log(`design-check: ${shots.length} screenshots; ${shots.length - changed.length} byte-identical to the last commit, ${changed.length} changed or new${changed.length ? ": " + changed.map((f) => path.basename(f)).join(", ") : ""}`);
if (speed) for (const line of firstScreenLines(speed)) console.log(line);
if (WRITE_KNOWN && !MUTANT) {
  fs.writeFileSync(KNOWN_FILE, JSON.stringify({ why: "Layout and UX problems already on main when each check landed. Fix one, then delete its line. New problems fail the check.", known: [...new Set(layoutKeys)].sort() }, null, 1) + "\n");
  console.log(`design-check: wrote ${new Set(layoutKeys).size} known layout problems to ${KNOWN_FILE}`);
}
if (steadied) console.log(`design-check: ${steadied} screenshots differed from the last commit only by rendering noise (at most ${NOISE_PIXELS} pixels, colour steps up to ${NOISE_DELTA}); kept the committed file`);
if (seenKnown.size) console.log(`design-check: ${seenKnown.size} known layout problems still there (${KNOWN_FILE})`);
const gone = [...known].filter((k) => !layoutKeys.includes(k));
if (gone.length && !WRITE_KNOWN && WHOLE) console.log(`design-check: ${gone.length} known layout problems are fixed; delete their lines from ${KNOWN_FILE}: ${gone.join(" | ")}`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`design-check: FAIL, ${failures.length} problems${fs.existsSync(FAILED) ? `; outlined screenshots in ${FAILED}/` : ""}`);
  process.exit(1);
}
if (FIRST_SCREEN_ONLY) {
  console.log("design-check: PASS, first screen only");
  process.exit(0);
}
console.log(`design-check: PASS, ${SIZES ? SIZES.join(" and ") : VIEWPORTS.length + " sizes"}, ${LOOKS.join(" and ")} looks, ${STATES.length} states: locked rules, close paths, layout (spill, cut text, off-screen, pill sizes), UX rules (counts from rows, honest values, named controls, text contrast, touch tap areas, first row, nothing hidden takes focus or is marked current on a phone)${speed ? " and the first screen" : ""}`);
