import assert from "node:assert/strict";
import { chromium } from "playwright";
import { chromeLaunchOptions } from "./tools/browser.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { startAppServer } from "./tools/app-server.mjs";
import { animationsOf, blankSeen, frames, motionPair, moveOf, pseudos, QUICK, runningAnimations, SCREEN, settle, STANDARD, viewTransitionCalls, watchBlank } from "./motion-steps.mjs";

const build = spawnSync(process.execPath, ["tools/build-app.mjs", "--fixtures"], { stdio: "inherit" });
if (build.status) process.exit(build.status ?? 1);

const { server, origin } = await startAppServer();

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const MAC = { viewport: { width: 1512, height: 982 } };
const TOUCH_SIDEWAYS = { viewport: { width: 1133, height: 744 }, hasTouch: true, isMobile: true };
const WIDE = [
  [1512, 982],
  [1133, 744],
];
const QUEUE_ORDER = [
  "Run the room list check before the bridge change?",
  "Approve the Settings sections",
  "Pick what a new device shows first",
  "How many results should each Search group show?",
  "Should the bridge retry a failed message?",
  "Room list placeholder",
  "Which columns should the Task Card export have?",
  'Make "Search results layout" public?',
  "CSV export columns",
  "Search result grouping",
];

const cases = [];
const it = (name, size, run, allow) => cases.push({ name, size, run, allow });
const T = (p, id) => p.locator(`[data-testid="${id}"]`);
const shown = (p, text) => p.getByText(text, { exact: true }).first().waitFor();
const gone = (locator) => locator.first().waitFor({ state: "detached" });
const equal = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(what + ": got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};
const titles = (p) => T(p, "card-row").locator("a").allInnerTexts();
const open = async (p, route) => {
  await p.goto(origin + route);
  await p.locator("#stage").waitFor();
};

it("Queue: the ten waiting cards show in the computed order", PHONE, async (p) => {
  await open(p, "/queue");
  await shown(p, "· 10 waiting");
  await T(p, "card-row").nth(9).waitFor();
  equal(await titles(p), QUEUE_ORDER, "row order");
});

it("Queue: a row shows only priority, title, unblocks, due, owner and project", PHONE, async (p) => {
  await open(p, "/queue");
  const row = T(p, "card-row").first();
  await row.waitFor();
  equal((await row.innerText()).split("\n").map((line) => line.trim()).filter(Boolean), ["P0", "Run the room list check before the bridge change?", "Unblocks 4 tasks", "·", "Due Tue 12 PM", "Shelvorn", "·", "heron-forge"], "row 1 text");
});

it("Queue: a search with no match says so and Clear search brings the rows back", PHONE, async (p) => {
  await open(p, "/queue");
  await T(p, "queue-search").fill("zebra");
  await shown(p, "· 0 of 10 waiting");
  await shown(p, "Nothing in the Queue matches.");
  equal(await T(p, "queue-rule").count(), 0, "no ranking line with no rows");
  await p.getByRole("button", { name: "Clear search" }).last().click();
  await T(p, "card-row").nth(9).waitFor();
});

for (const look of ["dark", "light"])
  it("Queue on a phone in the " + look + " look: while a search is on, the count reads N of M waiting", { ...PHONE, colorScheme: look }, async (p) => {
    await open(p, "/queue");
    await T(p, "card-row").nth(9).waitFor();
    await T(p, "queue-search").fill("bridge");
    await T(p, "queue-search").blur();
    const rows = await T(p, "card-row").count();
    equal(await p.locator("h1").first().innerText(), "Queue · " + rows + " of 10 waiting", "count");
  });

it("Queue: a filter narrows the rows and names itself with Clear", PHONE, async (p) => {
  await open(p, "/queue");
  await T(p, "filter-btn").tap();
  await T(p, "filter-project").tap();
  await p.locator('[data-pop="filter-sheet"]').getByRole("radio", { name: "quarterdeck" }).tap();
  await p.locator('[data-pop="filter-sheet"]').getByRole("button", { name: "Done" }).tap();
  await shown(p, "· 5 of 10 waiting");
  await shown(p, "Filter 1");
  await p.getByRole("button", { name: "Remove Project: quarterdeck" }).waitFor();
  await T(p, "queue-filters-on").getByRole("button", { name: "Clear" }).tap();
  await shown(p, "· 10 waiting");
});

it("Queue: with nothing waiting it says the bots are working", PHONE, async (p) => {
  await open(p, "/queue?queue=empty");
  await shown(p, "· 0 waiting");
  await shown(p, "Nothing waiting. The bots are working.");
  await T(p, "see-answered").waitFor();
  for (const id of ["queue-search", "filter-btn", "sort-btn"]) await T(p, id).waitFor();
});

it("Queue on the Mac: with nothing waiting, Search, Filter and Sort stay above the empty line", MAC, async (p) => {
  await open(p, "/queue?queue=empty");
  await shown(p, "Nothing waiting. The bots are working.");
  for (const id of ["queue-search", "filter-btn", "sort-btn"]) await T(p, id).waitFor();
});

it("Queue: a search and a filter that match nothing clear together in one tap", PHONE, async (p) => {
  await open(p, "/queue");
  await T(p, "filter-btn").tap();
  await T(p, "filter-project").tap();
  await p.locator('[data-pop="filter-sheet"]').getByRole("radio", { name: "quarterdeck" }).tap();
  await p.locator('[data-pop="filter-sheet"]').getByRole("button", { name: "Done" }).tap();
  await T(p, "queue-search").fill("zebra");
  await shown(p, "Nothing in the Queue matches.");
  await T(p, "queue-no-match").getByRole("button", { name: "Clear", exact: true }).tap();
  await shown(p, "· 10 waiting");
  await T(p, "card-row").nth(9).waitFor();
});

it("Queue: loading shows the final layout and the rows land where the bars were", PHONE, async (p) => {
  await open(p, "/queue?delay=1500");
  await T(p, "queue-loading").waitFor();
  await shown(p, "Ranked by priority, then unblocked, then due");
  await T(p, "filter-btn").waitFor();
  const bars = await T(p, "queue-loading").boundingBox();
  await T(p, "card-row").first().waitFor();
  const row = await T(p, "card-row").first().boundingBox();
  equal(Math.round(row.y), Math.round(bars.y), "first row top");
});

for (const [size, box] of [["a phone", PHONE], ["a wide phone", { ...PHONE, viewport: { width: 440, height: 956 } }], ["iPad upright", { viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true }], ["iPad sideways", TOUCH_SIDEWAYS], ["the Mac", MAC]])
  it("Queue on " + size + ": every loading bar has the height of the row that lands in it", box, async (p) => {
    await open(p, "/queue?delay=1500");
    const heights = (items) => items.evaluateAll((list) => list.map((item) => Math.round(item.getBoundingClientRect().height)));
    const bars = await heights(T(p, "queue-loading").locator("li"));
    await T(p, "card-row").nth(9).waitFor();
    equal((await heights(T(p, "card-row"))).slice(0, bars.length), bars, "row heights");
  });

it("Queue: changed cards wait behind Show and the rows stay where they are", PHONE, async (p) => {
  await open(p, "/queue?changed=2");
  await T(p, "card-row").nth(9).waitFor();
  const before = Math.round((await T(p, "card-row").first().boundingBox()).y);
  await shown(p, "2 cards changed.");
  equal(Math.round((await T(p, "card-row").first().boundingBox()).y), before, "first row top");
  await T(p, "queue-changed").getByRole("button", { name: "Show" }).tap();
  await gone(T(p, "queue-changed"));
  await shown(p, "Ranked by priority, then unblocked, then due");
});

it("Queue: the Filter sheet has Show, six filters and a button that counts the cards", PHONE, async (p) => {
  await open(p, "/queue");
  await T(p, "filter-btn").tap();
  await T(p, "filter-show-row").waitFor();
  for (const key of ["project", "lane", "bot", "priority", "label", "due"]) await T(p, "filter-" + key).waitFor();
  equal(await T(p, "filter-result").innerText(), "Show 10 Task Cards", "footer button");
});

const recordHeights = (p, pop) =>
  p.evaluate((name) => {
    window.qdHeights = [];
    const step = () => {
      const box = document.querySelector(`[data-pop="${name}"]`);
      if (box) window.qdHeights.push(Math.round(box.getBoundingClientRect().height));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, pop);
const recorded = (p) => p.evaluate(() => window.qdHeights.splice(0));

for (const [name, size, pop, press] of [["Queue: the first Filter open shows the whole sheet", PHONE, "filter-sheet", "tap"], ["Queue on the Mac: the first Filter open shows the whole menu", MAC, "filter-menu", "click"]])
  it(name + " from its first frame, and Filter still answers while its rows load", size, async (p) => {
    const release = await holdPart(p, "filter-show-row");
    await open(p, "/queue");
    await T(p, "card-row").first().waitFor();
    const button = T(p, "filter-btn");
    const sheet = p.locator(`[data-pop="${pop}"]`);
    await recordHeights(p, pop);
    await button[press]();
    await frames(p, 10);
    equal(await recorded(p), [], "frames of the Filter while its rows load");
    await button[press]();
    equal(await button.getAttribute("aria-expanded"), "false", "Filter after a second tap while its rows load");
    await button[press]();
    release();
    await sheet.getByTestId("filter-show-row").waitFor();
    await frames(p, 5);
    equal(await sheet.count(), 1, "Filters open");
    const settled = await sheet.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    equal([...new Set(await recorded(p))], [settled], "heights on the first open");
    await p.keyboard.press("Escape");
    await gone(sheet);
    await button[press]();
    await sheet.getByTestId("filter-show-row").waitFor();
    await frames(p, 5);
    equal([...new Set(await recorded(p))], [settled], "heights on the second open");
  });

it("Queue: a failed first load says so and Retry loads it", PHONE, async (p) => {
  await open(p, "/queue?fail=list");
  await shown(p, "Could not load the Queue.");
  await p.getByRole("button", { name: "Retry" }).tap();
  await T(p, "card-row").nth(9).waitFor();
});

it("Queue: a failed refresh keeps the rows and names the time of the list", PHONE, async (p) => {
  await open(p, "/queue?fail=refresh");
  await shown(p, "Could not refresh the Queue. Showing the list from 10:00 AM.");
  equal((await titles(p)).length, 10, "rows kept");
  await p.getByRole("button", { name: "Retry" }).tap();
  await gone(p.getByText("Could not refresh the Queue.", { exact: false }));
});

it("Queue: cards that arrive while he reads are counted, not moved in", PHONE, async (p) => {
  await open(p, "/queue?fixtures=late");
  await shown(p, "5 cards changed.");
  equal((await titles(p)).length, 10, "rows unchanged");
  await p.getByRole("button", { name: "Show" }).tap();
  await T(p, "card-row").nth(14).waitFor();
});

it("Queue on the Mac: row 1 is selected and its card is open without clearing its dot", MAC, async (p) => {
  await open(p, "/queue");
  await T(p, "card-pane").getByText(QUEUE_ORDER[0], { exact: true }).waitFor();
  await T(p, "card-row").first().locator('a[aria-current="true"]').waitFor();
  await T(p, "card-row").first().locator('[data-testid="changed-dot"]').waitFor();
});

it("Queue on the Mac: after Send the next card opens at its top with Got it", MAC, async (p) => {
  await open(p, "/queue/alba-1");
  const pane = T(p, "card-pane");
  await pane.getByTestId("send").waitFor();
  await pane.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await pane.getByTestId("send").click();
  await shown(p, "Got it: How many results should each Search group show, A, 10:00 AM");
  equal(await pane.evaluate((el) => el.scrollTop), 0, "pane at its top");
});

for (const [size, box] of [["iPad sideways", TOUCH_SIDEWAYS], ["Mac", MAC]])
  it("Queue on " + size + ": after Got it the card pane shows Queue with its count, and it moves focus to the list", box, async (p) => {
    await open(p, "/queue/alba-1");
    const pane = T(p, "card-pane");
    await pane.getByTestId("send").click();
    await shown(p, "Got it: How many results should each Search group show, A, 10:00 AM");
    const back = pane.getByRole("link", { name: "Queue · 9 waiting" });
    await back.click();
    equal(await p.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="queue-list"]'))), true, "focus in the list");
  });

it("Queue on the Mac: after Send from the Answered view the next waiting card opens", MAC, async (p) => {
  await open(p, "/queue");
  await T(p, "filter-btn").click();
  await p.locator('[data-pop="filter-menu"]').getByRole("radio", { name: "Answered" }).click();
  await p.keyboard.press("Escape");
  await p.keyboard.press("Meta+k");
  await T(p, "search-input").fill("How many results");
  await T(p, "search-hit").first().click();
  await T(p, "card-pane").getByTestId("send").click();
  await shown(p, "Got it: How many results should each Search group show, A, 10:00 AM");
  equal(await T(p, "card-pane").getByTestId("card-title").innerText(), "Should the bridge retry a failed message?", "next waiting card");
});

it("Queue on the Mac: a send that ends after he has left does not pull him back", MAC, async (p) => {
  await open(p, "/queue/alba-1?delay=800");
  await T(p, "card-pane").getByTestId("send").click();
  await p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: "Mail" }).click();
  await T(p, "mail-row").first().waitFor();
  await p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: /^Queue/ }).getByText("9", { exact: true }).waitFor();
  equal(new URL(p.url()).pathname, "/mail", "still on Mail");
});

it("Queue on the Mac and sideways: j and k move the selection and the card", MAC, async (p) => {
  for (const width of [1512, 1133]) {
    await p.setViewportSize({ width, height: width === 1512 ? 982 : 744 });
    await open(p, "/queue");
    await T(p, "card-pane").getByText(QUEUE_ORDER[0], { exact: true }).waitFor();
    await p.keyboard.press("j");
    await T(p, "card-pane").getByText(QUEUE_ORDER[1], { exact: true }).waitFor();
    await T(p, "card-row").nth(1).locator('a[aria-current="true"]').waitFor();
    await p.keyboard.press("k");
    await T(p, "card-pane").getByText(QUEUE_ORDER[0], { exact: true }).waitFor();
  }
});

it("Queue on the Mac and sideways: / goes to search, j typed there stays text, and Esc leaves the field", MAC, async (p) => {
  for (const width of [1512, 1133]) {
    await p.setViewportSize({ width, height: width === 1512 ? 982 : 744 });
    await open(p, "/queue");
    await T(p, "card-pane").getByText(QUEUE_ORDER[0], { exact: true }).waitFor();
    await p.keyboard.press("/");
    await p.keyboard.type("j");
    equal(await T(p, "queue-search").inputValue(), "j", "search text at " + width);
    await p.keyboard.press("Escape");
    equal(await p.evaluate(() => document.activeElement?.closest('[data-testid="queue-search"]') === null), true, "Esc left the field at " + width);
  }
});

it("Queue on the Mac and sideways: Esc in the card pane goes back to its row", MAC, async (p) => {
  for (const width of [1512, 1133]) {
    await p.setViewportSize({ width, height: width === 1512 ? 982 : 744 });
    await open(p, "/queue");
    await T(p, "card-pane").getByTestId("talk-to").focus();
    await p.keyboard.press("Escape");
    equal(await p.evaluate(() => document.activeElement?.closest('[data-testid="card-row"]') !== null && document.activeElement?.getAttribute("aria-current") === "true"), true, "focus on the open card's row at " + width);
  }
});

it("Card keys on the Mac and sideways: a letter picks that option, n picks None of these, and Enter sends", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/queue/alba-1");
    const pane = T(p, "card-pane");
    await pane.getByTestId("send").waitFor();
    await p.keyboard.press("b");
    await pane.locator('[data-letter="B"] [role="radio"][aria-checked="true"]').waitFor();
    await p.keyboard.press("n");
    await pane.locator('[data-testid="none-of-these"][aria-checked="true"]').waitFor();
    await p.keyboard.press("a");
    await pane.locator('[data-letter="A"] [role="radio"][aria-checked="true"]').waitFor();
    await p.keyboard.press("Enter");
    await shown(p, "Got it: How many results should each Search group show, A, 10:00 AM");
  }
});

it("Card keys on the Mac and sideways: a held Enter sends one card only", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/queue/alba-1");
    const pane = T(p, "card-pane");
    await pane.getByTestId("send").waitFor();
    await p.keyboard.down("Enter");
    await shown(p, "Got it: How many results should each Search group show, A, 10:00 AM");
    await pane.getByTestId("card-title").getByText("Should the bridge retry a failed message?", { exact: true }).waitFor();
    await p.evaluate(() => {
      for (let n = 0; n < 5; n++) (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }));
    });
    await p.keyboard.up("Enter");
    await p.keyboard.press("n");
    await pane.getByTestId("send").getByText("Send: None of these", { exact: true }).waitFor();
    await shown(p, "· 9 waiting");
  }
});

it("Card keys on the Mac and sideways: Enter on a clicked option sends that option", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/queue/alba-1");
    const pane = T(p, "card-pane");
    await pane.locator('[data-letter="B"] [role="radio"]').click();
    await pane.locator('[data-letter="B"] [role="radio"][aria-checked="true"]').waitFor();
    await p.keyboard.press("Enter");
    await shown(p, "Got it: How many results should each Search group show, B, 10:00 AM");
  }
});

it("Card keys on the Mac and sideways: t opens Talk to the owner bot with the card quoted", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/queue/alba-1");
    await T(p, "card-pane").getByTestId("talk-to").waitFor();
    await p.keyboard.press("t");
    await T(p, "chat-quote").getByText("How many results should each Search group show?").waitFor();
    equal(new URL(p.url()).pathname, "/chat/alba", "chat at " + width);
  }
});

it("Card keys on the Mac and sideways: ? and the Keys button open the key list, and Esc and X close it with focus back", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/queue/alba-1");
    await T(p, "card-pane").getByTestId("talk-to").waitFor();
    await p.keyboard.press("?");
    const list = p.locator('[data-pop="keys"]');
    await list.getByText("Talk to Alba", { exact: true }).waitFor();
    await list.getByText("Letter keys pause while you type a note.").waitFor();
    await p.keyboard.press("Escape");
    await gone(list);
    await T(p, "keys-btn").click();
    await list.waitFor();
    await list.getByRole("button", { name: "Close" }).click();
    await gone(list);
    equal(await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "keys-btn", "focus back at " + width);
  }
});

it("Card keys on the Mac and sideways: no key fires in the note or the search field, and Esc leaves the note, then the card", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/queue/alba-1");
    const pane = T(p, "card-pane");
    await T(p, "note").click();
    await p.keyboard.type("bnt?");
    equal(await T(p, "note").inputValue(), "bnt?", "note text at " + width);
    await pane.locator('[data-letter="A"] [role="radio"][aria-checked="true"]').waitFor();
    equal(await p.locator('[data-pop="keys"]').count(), 0, "no key list at " + width);
    await p.keyboard.press("Escape");
    equal(await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "card-pane", "Esc left the note at " + width);
    await p.keyboard.press("Escape");
    equal(await p.evaluate(() => document.activeElement?.getAttribute("aria-current")), "true", "Esc left the card for its row at " + width);
    await p.keyboard.press("/");
    await p.keyboard.type("bt");
    equal(await T(p, "queue-search").inputValue(), "bt", "search text at " + width);
    equal(new URL(p.url()).pathname, "/queue/alba-1", "still on the card at " + width);
  }
});

it("Card keys on the Mac and sideways: on a one-way pick Enter asks once, and a second Enter goes Back, never Confirm", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/queue/fx-oneway-pick?fixtures=now");
    await T(p, "card-pane").getByTestId("send").waitFor();
    await p.keyboard.press("Enter");
    await T(p, "confirm").waitFor();
    equal(await p.evaluate(() => document.activeElement?.textContent), "Back", "focus on Back at " + width);
    await p.keyboard.press("Enter");
    await gone(T(p, "confirm"));
    equal(await p.getByText(/^Got it/).count(), 0, "nothing sent at " + width);
  }
});

it("Card keys on the Mac and sideways: an approval card ignores letter keys and Enter", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/queue/c2");
    await T(p, "card-pane").getByTestId("approve").waitFor();
    for (const key of ["a", "r", "n", "Enter"]) await p.keyboard.press(key);
    equal(await p.getByText(/^Got it/).count(), 0, "nothing sent at " + width);
    equal(await T(p, "approve").isEnabled(), true, "Approve still offered at " + width);
    equal(new URL(p.url()).pathname, "/queue/c2", "still on the card at " + width);
  }
});

it("Card keys on the Mac and sideways: after a failed send the choice stays and nothing advances", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/queue/alba-1?fail=send");
    const pane = T(p, "card-pane");
    await pane.getByTestId("send").waitFor();
    await p.keyboard.press("b");
    await p.keyboard.press("Enter");
    await shown(p, "Not sent. Try again.");
    await pane.locator('[data-letter="B"] [role="radio"][aria-checked="true"]').waitFor();
    equal(new URL(p.url()).pathname, "/queue/alba-1", "still on the card at " + width);
  }
});

it("Card keys on the Mac: the key list on an approval card leaves out the letter, n and Enter rows", MAC, async (p) => {
  await open(p, "/queue/c2");
  await T(p, "card-pane").getByTestId("talk-to").waitFor();
  await p.keyboard.press("?");
  equal(await p.locator('[data-pop="keys"] kbd').allInnerTexts(), ["j / k", "t", "\u2318K", "Esc"], "keys");
});

it("Card keys: the Keys button is hidden on a touch-only iPad held sideways", TOUCH_SIDEWAYS, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "card-pane").getByTestId("talk-to").waitFor();
  equal(await T(p, "keys-btn").isVisible(), false, "no key hint on touch");
});

it("Task Card: the parts come in the agreed order", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "card-title").waitFor();
  const order = await p.evaluate(() =>
    ["card-title", "recap", "picture", "evidence", "options", "none-of-these", "no-answer", "send", "talk-to", "more", "earlier-versions"].map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? el.getBoundingClientRect().top + scrollY : -1;
    }),
  );
  equal(
    order.every((top, n) => top >= 0 && (n === 0 || top >= order[n - 1])),
    true,
    "tops " + order.join(","),
  );
});

it("Task Card: the owner line names the project and the due", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  const line = (await T(p, "owner-line").innerText()).split("\n").join(" ");
  equal(line, "Alba · quarterdeck Due Wed Nov 4, 5 PM ET, in 2 days", "owner line");
});

it("Task Card: Send A on a two-way pick sends in one tap and the next card opens with Got it", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "send").tap();
  await shown(p, "Got it: How many results should each Search group show, A, 10:00 AM");
  await shown(p, "Should the bridge retry a failed message?");
  await shown(p, "Queue · 9 waiting");
});

it("Task Card: None of these changes the note and Send, and the card shows under Answered", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "none-of-these").tap();
  await p.getByPlaceholder("Your own answer, or what would work instead").fill("Five on the Mac only.");
  await shown(p, "Send: None of these");
  await T(p, "send").tap();
  await shown(p, "Got it: How many results should each Search group show, None of these, 10:00 AM. Waiting on Alba.");
  await p.getByRole("link", { name: "Queue · 9 waiting" }).tap();
  await T(p, "filter-btn").tap();
  await p.locator('[data-pop="filter-sheet"]').getByRole("radio", { name: "Answered" }).tap();
  await p.locator('[data-pop="filter-sheet"]').getByRole("button", { name: "Done" }).tap();
  await shown(p, "Waiting on Alba");
});

it("Task Card: a failed send keeps the choice and note, and Send again works", PHONE, async (p) => {
  await open(p, "/queue/alba-1?fail=send");
  await T(p, "note").fill("Fine for now.");
  await T(p, "send").tap();
  await shown(p, "Not sent. Try again.");
  equal(await T(p, "note").inputValue(), "Fine for now.", "note kept");
  await T(p, "send").tap();
  await shown(p, "Got it: How many results should each Search group show, A, 10:00 AM");
});

it("Task Card: a failed send says Not sent. Try again. and its button reads Try again, not Retry, and sends again", PHONE, async (p) => {
  await open(p, "/queue/alba-1?fail=send");
  await T(p, "send").tap();
  const failed = T(p, "send-failed");
  await failed.getByText("Not sent. Try again.", { exact: true }).waitFor();
  equal([await failed.getByRole("button", { name: "Try again", exact: true }).count(), await failed.getByRole("button", { name: "Retry", exact: true }).count()], [1, 0], "Try again and Retry buttons on the failed send line");
  await failed.getByRole("button", { name: "Try again", exact: true }).tap();
  await shown(p, "Got it: How many results should each Search group show, A, 10:00 AM");
});

it("Task Card: a failed load says so and Retry loads it", PHONE, async (p) => {
  await open(p, "/queue/alba-1?fail=list");
  await shown(p, "Could not load this Task Card.");
  await p.getByRole("button", { name: "Retry" }).tap();
  await T(p, "options").waitFor();
});

it("Task Card: a one-way pick shows its block above the pick and asks once, ignoring a fast second tap", PHONE, async (p) => {
  await p.clock.install();
  await open(p, "/queue/fx-oneway-pick?fixtures=now");
  await T(p, "one-way-block").waitFor();
  await T(p, "send").tap();
  await shown(p, "Send A? This cannot be undone.");
  await T(p, "confirm-send").tap();
  await shown(p, "Send A? This cannot be undone.");
  await p.clock.runFor(600);
  await T(p, "confirm-send").tap();
  await T(p, "got-it").waitFor();
});

it("Task Card: answering A on the Make public card makes the Page public", MAC, async (p) => {
  await p.clock.install();
  await open(p, "/queue/dr-kivo-2");
  const pane = T(p, "card-pane");
  await pane.getByTestId("one-way-block").waitFor();
  await pane.getByTestId("send").click();
  await shown(p, "Send A? This cannot be undone.");
  await p.clock.runFor(600);
  await pane.getByTestId("confirm-send").click();
  await T(p, "got-it").waitFor();
  await p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: "Projects" }).click();
  await projectRow(p, "quarterdeck").click();
  await p.locator('[data-testid="all-pages"][href="/projects/quarterdeck/pages"]').click();
  const cells = p.locator('[data-testid="page-row"][data-id="PG-2"] td');
  await cells.nth(4).getByText("Public", { exact: true }).waitFor();
});

it("Task Card: a two-way pick with a one-way other option asks only when that option is chosen", PHONE, async (p) => {
  await open(p, "/queue/fx-twoway-oneway-other?fixtures=now");
  await T(p, "options").waitFor();
  equal(await T(p, "one-way-block").count(), 0, "no block");
  const other = T(p, "option").filter({ has: p.locator('[aria-checked="false"]') }).first();
  await other.getByRole("button", { name: /^Details for/ }).tap();
  await other.getByText("Cannot be undone.", { exact: true }).waitFor();
  await other.getByRole("radio").tap();
  await T(p, "send").tap();
  await T(p, "confirm").waitFor();
});

it("Task Card: an undoable card labelled high-risk sends in one tap", PHONE, async (p) => {
  await open(p, "/queue/fx-highrisk-undoable?fixtures=now");
  await T(p, "options").waitFor();
  equal(await T(p, "one-way-block").count(), 0, "no one-way block");
  await T(p, "send").tap();
  await T(p, "got-it").waitFor();
});

it("Task Card: Talk to the owner opens the chat with the card quoted and sends nothing", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  const priority = await p.getByRole("img", { name: /^Priority / }).first().innerText();
  await T(p, "talk-to").tap();
  const quote = T(p, "chat-quote");
  await quote.getByText("How many results should each Search group show?").waitFor();
  await quote.getByText("Task Card", { exact: true }).waitFor();
  equal(await quote.getByRole("img", { name: /^Priority / }).innerText(), priority, "priority");
  await quote.getByText(/^About: /).waitFor();
  await quote.getByText(/^In: quarterdeck > Search, /).waitFor();
  equal(await T(p, "chat-input").inputValue(), "", "field empty");
  await p.getByPlaceholder("Message Alba").waitFor();
  equal(await T(p, "chat-my-message").filter({ has: p.locator('[data-testid="chat-quote"]') }).count(), 0, "nothing sent");
  await p.goBack();
  await p.getByRole("link", { name: "Queue · 10 waiting", exact: true }).tap();
  equal((await titles(p)).join(" | "), QUEUE_ORDER.join(" | "), "the card keeps its Queue place");
});

it("Task Card: an answered card is a read-only record with its answer first", PHONE, async (p) => {
  await open(p, "/queue/c10");
  await shown(p, "You answered B. System, Light and Dark");
  const tops = await p.evaluate(() =>
    ["card-title", "answered-record", "recap", "picture", "answered-options", "talk-to"].map((id) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().top ?? -1),
  );
  equal(tops.every((top, n) => top >= 0 && (n === 0 || top > tops[n - 1])), true, "answer first, then recap, picture, options, Talk to: " + tops.join(","));
  await shown(p, "Alba: Set Appearance to System, Light and Dark. · 9:30 PM");
  await p.getByRole("link", { name: "Answered" }).waitFor();
  equal(await T(p, "send").count(), 0, "no Send");
  equal(await p.getByText("Change answer").count(), 0, "no Change answer");
  await T(p, "answered-options").locator("summary").tap();
  await T(p, "read-only-option").first().waitFor();
  equal(await T(p, "answered-options").getByRole("radio").count(), 0, "options not pickable");
});

it("Task Card: Whole card on an answered card opens its other options", PHONE, async (p) => {
  await open(p, "/queue/c10");
  await T(p, "whole-card").tap();
  await T(p, "read-only-option").first().waitFor();
});

it("Task Card: Talk to on an answered card quotes it as answered", PHONE, async (p) => {
  await open(p, "/queue/c10");
  await T(p, "talk-to").tap();
  await T(p, "chat-quote").getByText("Task Card (answered B)").waitFor();
});

const TALK_TO_FOCUS = "nothing";
const focusedNow = (p) => p.evaluate(() => {
  const el = document.activeElement;
  return !el || el === document.body ? "nothing" : el.tagName.toLowerCase() + " " + (el.getAttribute("data-testid") ?? "");
});
const talkTo = async (p, size) => {
  await T(p, "options").waitFor();
  await (size === PHONE ? T(p, "talk-to-top").tap() : T(p, "card-pane").getByTestId("talk-to").click());
};

for (const [name, size] of [["a phone", PHONE], ["the Mac", MAC]])
  it("Task Card on " + name + ": Talk to opens the chat with the card quoted and focuses nothing, so the message box is as it was", size, async (p) => {
    await open(p, "/queue/alba-1");
    await talkTo(p, size);
    await T(p, "chat-quote").getByText("How many results should each Search group show?").waitFor();
    equal(await focusedNow(p), TALK_TO_FOCUS, "focus after Talk to");
  });

it("Task Card: Whole card opens every fold and reads Fold card", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "whole-card").tap();
  await shown(p, "Fold card");
  await T(p, "more").getByText("Labels", { exact: true }).waitFor();
  await T(p, "earlier-versions").getByText("Change trail", { exact: true }).waitFor();
});

it("Task Card: the change line opens Earlier versions each time it is tapped", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "change-line").tap();
  await T(p, "version").first().waitFor();
  await T(p, "earlier-versions").locator("summary").tap();
  await gone(T(p, "version"));
  await T(p, "change-line").tap();
  await T(p, "version").first().waitFor();
});

it("Task Card: a Page with a file gives See all on Page", PHONE, async (p) => {
  await open(p, "/queue/fx-page-file?fixtures=now");
  await T(p, "see-all-page").tap();
  await T(p, "page-viewer").waitFor();
});

const IPAD_UPRIGHT = { viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true };
const boxOf = (locator) => locator.evaluate((el) => {
  const box = el.getBoundingClientRect();
  return [Math.round(box.width), Math.round(box.height)];
});

it("Task Card on a phone: the floating top has the round Back with Queue · N waiting and a capsule with Talk and More, each at least 44 px", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await p.locator('[data-float="capsule"]').waitFor();
  equal(await p.locator('[data-float="label"]').innerText(), "Queue · 10 waiting", "back label");
  for (const [name, part] of [["back", p.locator('[data-float="back"]')], ["talk-to-top", T(p, "talk-to-top")], ["more-top", T(p, "more-top")]]) {
    const [width, height] = await boxOf(part);
    equal(width >= 44 && height >= 44, true, name + " is " + width + " by " + height);
  }
});

it("Task Card on a phone: More in the capsule opens More and brings it into view", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "more-top").tap();
  await T(p, "more").getByText("Labels", { exact: true }).waitFor();
  await p.waitForFunction(() => {
    const box = document.querySelector('[data-testid="more"]').getBoundingClientRect();
    return box.top >= 0 && box.top < innerHeight;
  });
});

it("Task Card on iPad upright and the Mac: the card keeps its header, with no floating top", MAC, async (p) => {
  for (const size of [IPAD_UPRIGHT.viewport, MAC.viewport]) {
    await p.setViewportSize(size);
    await open(p, "/queue/alba-1");
    await T(p, "whole-card").first().waitFor();
    equal(await p.locator("[data-float]").count(), 0, "floating top at " + size.width);
  }
});

it("Task Card: a change while he reads shows the notice and keeps his note, and Show the new version shows its version line", PHONE, async (p) => {
  await open(p, "/queue/alba-1?rolled=alba-1");
  await T(p, "note").fill("Fine for now.");
  await T(p, "changed-notice").waitFor();
  await shown(p, "Alba changed this card at 10:00 AM.");
  equal(await T(p, "note").inputValue(), "Fine for now.", "note kept");
  await T(p, "show-new-version").tap();
  await gone(T(p, "changed-notice"));
  await T(p, "version-line").getByText('Changed on your instruction in chat, 9:55 AM: "Say who checked it."', { exact: true }).waitFor();
  equal(await T(p, "note").inputValue(), "Fine for now.", "note kept on the new version");
});

it("Task Card: a card closed while he reads names who closed it with Nothing to answer, and Next card opens the top of the Queue", PHONE, async (p) => {
  await open(p, "/queue/alba-1?closed=alba-1");
  await T(p, "closed-notice").waitFor();
  await shown(p, 'Alba closed this card at 9:55 AM, on your instruction in chat: "drop it".');
  await shown(p, "Nothing to answer.");
  equal(await T(p, "send").count(), 0, "no Send");
  await T(p, "next-card").tap();
  await T(p, "card-title").getByText(QUEUE_ORDER[0], { exact: true }).waitFor();
});

it("Task Card: a single-action card names what to approve and how to undo it, and Approve answers it", PHONE, async (p) => {
  await open(p, "/queue/fx-approve?fixtures=card-states");
  await T(p, "ask").getByText("Alba asks you to approve: The words for the three Appearance choices in Settings.", { exact: true }).waitFor();
  await T(p, "ask").getByText("Undo: Ask Alba to put the old words back; nothing else changes.", { exact: true }).waitFor();
  await T(p, "approve").tap();
  await T(p, "got-it").waitFor();
});

it("Task Card: past its due time the no-answer line says what happened, and Send still answers", PHONE, async (p) => {
  await open(p, "/queue/fx-past-due?fixtures=card-states");
  const line = await T(p, "past-due").innerText();
  equal(/^No answer by .+, so /.test(line), true, "past due line " + JSON.stringify(line));
  await T(p, "send").tap();
  await T(p, "got-it").waitFor();
});

it("Task Card: while it sends, the button reads Sending A ... and the choice and note are locked", PHONE, async (p) => {
  await open(p, "/queue/alba-1?delay=1500");
  await T(p, "send").tap();
  await T(p, "send").filter({ hasText: /^Sending A \.\.\.$/ }).waitFor();
  equal(await T(p, "note").evaluate((el) => el.readOnly), true, "note locked");
  equal(await T(p, "option").first().locator("[role=radio]").isDisabled(), true, "choice locked");
});

it("Task Card on the Mac: an answered card has its < Answered link, and it opens the Answered list", MAC, async (p) => {
  await open(p, "/queue/c10");
  await T(p, "card-pane").getByRole("link", { name: "Answered" }).click();
  await T(p, "card-row").filter({ hasText: "Which Appearance choices ship at launch?" }).first().waitFor();
});

it("Evidence: iPad sideways shows six thumbnails in one row", TOUCH_SIDEWAYS, async (p) => {
  await open(p, "/queue/fx-ev-overflow?fixtures=evidence");
  await T(p, "evidence-media").first().waitFor();
  const tops = await T(p, "evidence-tiles").locator("> li").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
  equal(tops.length === 6 && tops.every((top) => top === tops[0]), true, "tile tops " + tops.join(","));
});

const labels = (p) => T(p, "evidence-media").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
const place = (p) => T(p, "viewer-count").innerText();
const placeIs = (p, want) => p.waitForFunction((text) => document.querySelector('[data-testid="viewer-count"]')?.textContent === text, want);
const noPlay = (p) => p.addInitScript(() => (HTMLMediaElement.prototype.canPlayType = () => ""));

it("Evidence: the phone shows the first pictures in 3 slots and +6 more", PHONE, async (p) => {
  await open(p, "/queue/fx-ev-overflow?fixtures=evidence");
  await T(p, "evidence-media").nth(1).waitFor();
  equal(await labels(p), ["Picture: Test picture 1 of 8", "Picture: Test picture 2 of 8"], "pictures");
  equal(await T(p, "evidence-tiles").locator("li").count(), 3, "slots");
  await T(p, "evidence-tiles").getByText("+6 more", { exact: true }).waitFor();
});

it("Evidence: the Mac shows the first pictures in 6 slots and +3 more", MAC, async (p) => {
  await open(p, "/queue/fx-ev-overflow?fixtures=evidence");
  await T(p, "evidence-media").nth(4).waitFor();
  equal((await labels(p)).length, 5, "pictures");
  equal(await T(p, "evidence-tiles").locator("li").count(), 6, "slots");
  await T(p, "evidence-tiles").getByText("+3 more", { exact: true }).waitFor();
});

it("Evidence: See all 8 on Page opens the Page that has the file", PHONE, async (p) => {
  await open(p, "/queue/fx-ev-overflow?fixtures=evidence");
  await T(p, "see-all-page").getByText("See all 8 on Page", { exact: true }).tap();
  await T(p, "page-viewer").waitFor();
  equal(new URL(p.url()).pathname.endsWith("/PG-1"), true, "page " + p.url());
});

it("Evidence: alba-1 gives See all 8 on Page now that its Page has a file", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "see-all-page").waitFor();
  equal(await T(p, "see-all-page").innerText(), "See all 8 on Page", "text");
});

it("Evidence: the Make public card gives See all 2 on Page", PHONE, async (p) => {
  await open(p, "/queue/dr-kivo-2");
  await T(p, "see-all-page").waitFor();
  equal(await T(p, "see-all-page").innerText(), "See all 2 on Page", "text");
});

it("Evidence: a built picture sits beside its target, then the video", MAC, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "evidence-media").nth(2).waitFor();
  equal(
    await labels(p),
    ["Build: Search sheet on the phone: 5 per group, keyboard up", "Target: Search sheet, phone, 5 per group", "Video, 0:10: Tap-through: type, see 5 per group, open See all"],
    "order",
  );
});

it("Evidence: the viewer counts its place and steps with Next and the arrow keys", MAC, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "evidence-media").first().click();
  equal(await place(p), "1 of 3", "first");
  await p.locator('[data-pop="viewer"]').getByRole("button", { name: "Next" }).click();
  await placeIs(p, "2 of 3");
  await p.keyboard.press("ArrowRight");
  await placeIs(p, "3 of 3");
  await p.keyboard.press("ArrowLeft");
  await placeIs(p, "2 of 3");
});

it("Evidence: Show target moves the viewer to the target picture", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "evidence-media").first().tap();
  await p.getByRole("button", { name: "Show target" }).tap();
  await placeIs(p, "2 of 3");
  await T(p, "viewer-caption").getByText(/^Target: Search sheet, phone, 5 per group · /).waitFor();
});

it("Evidence: a swipe moves the viewer to the next picture", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "evidence-media").first().tap();
  const stage = await T(p, "viewer-stage").boundingBox();
  const y = stage.y + stage.height / 3;
  await p.mouse.move(stage.x + stage.width - 40, y);
  await p.mouse.down();
  await p.mouse.move(stage.x + 40, y, { steps: 4 });
  await p.mouse.up();
  await placeIs(p, "2 of 3");
});

it("Evidence: Esc closes the viewer and puts focus back on the picture", MAC, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "evidence-media").nth(1).click();
  await p.locator('[data-pop="viewer"]').waitFor();
  await p.keyboard.press("Escape");
  await gone(p.locator('[data-pop="viewer"]'));
  equal(await p.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Target: Search sheet, phone, 5 per group", "focus");
});

it("Evidence: +N more with no Page file shows every item in place", PHONE, async (p) => {
  await open(p, "/queue/ev7-card?fixtures=evidence");
  const tiles = T(p, "evidence-tiles");
  await tiles.getByText("+4 more", { exact: true }).waitFor();
  equal(await tiles.locator("li").count(), 3, "two items and +4 more");
  equal(await T(p, "see-all-page").count(), 0, "no See all without a Page file");
  await tiles.getByText("+4 more", { exact: true }).tap();
  await tiles.locator("li").nth(5).waitFor();
  equal(await tiles.locator("li").count(), 6, "every item");
  equal(await tiles.getByText(/^\+\d+ more$/).count(), 0, "no More tile");
  equal(await p.locator('[data-pop="viewer"]').count(), 0, "no viewer");
  equal(await p.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Picture: Test picture 3 of 8", "focus on the first item shown");
});

it("Evidence: a card without an evidence record counts its items in See all on Page", MAC, async (p) => {
  await open(p, "/queue/fx-page-file?fixtures=now");
  await T(p, "see-all-page").getByText("See all 3 on Page", { exact: true }).waitFor();
  await T(p, "evidence-tiles").locator("li").nth(2).waitFor();
  equal(await T(p, "evidence-tiles").locator("li").count(), 3, "tiles");
});

it("Evidence: loading bars show until the evidence loads, never No evidence attached", PHONE, async (p) => {
  await open(p, "/queue/alba-1?delay=1500");
  const evidence = T(p, "evidence");
  await evidence.getByRole("status", { name: "Loading" }).waitFor();
  equal(await evidence.getByText("No evidence attached").count(), 0, "no empty line while loading");
  await T(p, "evidence-media").first().waitFor();
  await gone(evidence.getByRole("status", { name: "Loading" }));
});

it("Evidence: the video shows its length and plays in the viewer", PHONE, async (p) => {
  await open(p, "/queue/fx-ev-video?fixtures=evidence");
  await T(p, "evidence-media").first().getByText("0:10", { exact: true }).waitFor();
  await T(p, "evidence-media").first().tap();
  const video = T(p, "viewer-video");
  await video.evaluate((el) => {
    el.muted = true;
    return el.play();
  });
  await p.waitForFunction(() => document.querySelector('[data-testid="viewer-video"]').currentTime > 0.2);
  await T(p, "viewer-caption").getByText(/^Tap-through on a phone · Alba/).waitFor();
});

it("Evidence: a browser that cannot play the video shows the poster, says so and offers the file", MAC, async (p) => {
  await noPlay(p);
  await open(p, "/queue/fx-ev-video?fixtures=evidence");
  await T(p, "evidence-media").first().click();
  await T(p, "viewer-no-play").getByText("This browser cannot play this video.", { exact: true }).waitFor();
  equal(await T(p, "viewer-no-play").locator("img").getAttribute("src"), "/evidence/media/alba-1-video-poster.png", "poster");
  await T(p, "viewer-no-play").getByRole("link", { name: "Download the video" }).waitFor();
});

it("Evidence: Open the Page shows in the viewer only when the Page has a file", MAC, async (p) => {
  await open(p, "/queue/fx-ev-overflow?fixtures=evidence");
  await T(p, "evidence-media").first().click();
  await p.locator('[data-pop="viewer"]').getByRole("link", { name: "Open the Page" }).waitFor();
  await open(p, "/queue/ev7-card?fixtures=evidence");
  await T(p, "evidence-media").first().click();
  await T(p, "viewer-caption").waitFor();
  equal(await p.locator('[data-pop="viewer"]').getByRole("link", { name: "Open the Page" }).count(), 0, "no Page link while the Page has no file");
});

it("Evidence: rejected pictures and link shots make no escaped media request", PHONE, async (p) => {
  const escaped = [];
  await p.route("**/*", async (route) => {
    const request = route.request();
    if (["image", "media"].includes(request.resourceType()) && !new URL(request.url()).pathname.startsWith("/evidence/media/")) {
      escaped.push(new URL(request.url()).pathname);
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=", "base64") });
    } else await route.continue();
  });
  await open(p, "/queue/fx-ev-unsafe?fixtures=evidence");
  await T(p, "evidence-media").nth(2).waitFor();
  await T(p, "evidence-media").first().tap();
  await T(p, "viewer-image").waitFor();
  equal(await T(p, "viewer-image").getAttribute("src"), null, "no unsafe picture source");
  equal(escaped, [], "no media request outside the media base");
});

it("Evidence: a rejected video shows the failed state without a download", MAC, async (p) => {
  await open(p, "/queue/fx-ev-unsafe?fixtures=evidence");
  await T(p, "evidence-media").nth(1).click();
  await T(p, "viewer-no-play").waitFor();
  equal(await T(p, "viewer-no-play").getByRole("link", { name: "Download the video" }).count(), 0, "no unsafe download");
  equal(await T(p, "viewer-no-play").locator("img").getAttribute("src"), null, "no unsafe poster source");
});

async function taskCardLearnLinks(p) {
  await open(p, "/queue/fx-ev-unsafe?fixtures=evidence");
  const more = T(p, "more");
  await more.locator("summary").click();
  await more.getByText("Trusted service guide", { exact: true }).waitFor();
  return more;
}

async function taskCardLearnConfirmation(p) {
  const more = await taskCardLearnLinks(p);
  await p.context().route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await p.evaluate(() => {
    window.__botLinkRequests = [];
    window.open = (...args) => { window.__botLinkRequests.push(args); return null; };
  });
  const before = p.url();
  const trigger = more.getByRole("button", { name: /^Trusted port guide/ });
  await trigger.click();
  const dialog = p.getByRole("dialog", { name: "Open a link from Alba?", exact: true });
  await dialog.waitFor();
  return { trigger, dialog, before };
}

for (const [name, size] of [["phone", PHONE], ["Mac", MAC]]) {
  it("Task Card Links on " + name + ": an accepted HTTPS row shows its label and real host", size, async (p) => {
    const more = await taskCardLearnLinks(p);
    const row = more.locator("li").filter({ hasText: "Trusted service guide" });
    equal(await row.getByText("actual.example.com", { exact: true }).count(), 1, "real host shown beside the supplied label");
    equal(await row.getByRole("button", { name: /^Trusted service guide/ }).count(), 1, "accepted link asks before opening");
    if (process.env.QD_TASK_CARD_LINK_SHOTS) await more.screenshot({ path: process.env.QD_TASK_CARD_LINK_SHOTS + "/learn-rows-" + name + ".png" });
  });
  it("Task Card Links on " + name + ": a non-standard port stays visible in the row and confirmation", size, async (p) => {
    const { trigger, dialog } = await taskCardLearnConfirmation(p);
    await trigger.getByText("actual.example.com:8443", { exact: true }).waitFor();
    equal(await dialog.getByTestId("bot-link-origin").innerText(), "https://actual.example.com:8443", "full origin and port");
    await dialog.getByText("Alba supplied this address. Quarterdeck has not checked where it leads.", { exact: true }).waitFor();
    if (process.env.QD_TASK_CARD_LINK_SHOTS) await dialog.screenshot({ path: process.env.QD_TASK_CARD_LINK_SHOTS + "/learn-confirm-" + name + ".png" });
  });
  it("Task Card Links on " + name + ": unsafe addresses are blocked text without an active link", size, async (p) => {
    const more = await taskCardLearnLinks(p);
    const rows = more.getByTestId("learn-blocked");
    equal(await rows.count(), 6, "all unsafe learn addresses blocked");
    for (const label of ["Plaintext learn", "Private learn", "Local learn", "Credential learn", "Script learn", "Malformed learn"]) {
      const row = rows.filter({ hasText: label });
      await row.getByText("Link blocked: not a safe address", { exact: true }).waitFor();
      equal(await row.locator("a,button,[href],[role=link]").count(), 0, "no active destination");
      equal(await row.getAttribute("tabindex"), null, "not a focus target");
    }
  });
  it("Task Card Links on " + name + ": clicking a learn link cannot navigate before Open", size, async (p) => {
    const { trigger, before } = await taskCardLearnConfirmation(p);
    equal(await trigger.getAttribute("href"), null, "no direct address");
    equal(await p.evaluate(() => window.__botLinkRequests), [], "no navigation request");
    equal(p.url(), before, "current page stays");
    equal(p.context().pages().length, 1, "no new tab");
  });
  it("Task Card Links on " + name + ": Open requests the exact full address in a protected new tab", size, async (p) => {
    const { dialog } = await taskCardLearnConfirmation(p);
    await dialog.getByRole("button", { name: "Open", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    equal(await p.evaluate(() => window.__botLinkRequests), [["https://actual.example.com:8443/learn?chapter=2&topic=cards#details", "_blank", "noopener,noreferrer"]], "exact normalized URL including path, query and fragment");
  });
  for (const action of ["Cancel", "Escape"]) {
    it("Task Card Links on " + name + ": " + action + " returns focus to the learn link", size, async (p) => {
      const { trigger, dialog } = await taskCardLearnConfirmation(p);
      if (action === "Escape") await p.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await trigger.locator("..").locator(":focus").waitFor();
      equal(await trigger.evaluate((element) => element === document.activeElement), true, "focus back on the same learn link");
      equal(await p.evaluate(() => window.__botLinkRequests), [], "no navigation request");
    });
  }
  it("Task Card Links on " + name + ": a second click asks again after an earlier Open", size, async (p) => {
    const { trigger, dialog } = await taskCardLearnConfirmation(p);
    await dialog.getByRole("button", { name: "Open", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await trigger.click();
    await dialog.waitFor();
    equal(await p.evaluate(() => window.__botLinkRequests.length), 1, "no remembered navigation approval");
  });
}

async function evidenceLinkConfirmation(p) {
  await open(p, "/queue/fx-ev-unsafe?fixtures=evidence");
  await p.context().route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await p.evaluate(() => {
    window.__botLinkRequests = [];
    window.open = (...args) => { window.__botLinkRequests.push(args); return null; };
  });
  const before = p.url();
  const trigger = T(p, "evidence-link").filter({ hasText: "Trusted service sign-in" });
  await trigger.click();
  const dialog = p.getByRole("dialog", { name: "Open a link from Alba?", exact: true });
  await dialog.waitFor();
  return { trigger, dialog, before };
}

for (const [name, size] of [["phone", PHONE], ["Mac", MAC]]) {
  it("Evidence on " + name + ": confirmation shows the origin and port without claiming a destination check", size, async (p) => {
    const { dialog } = await evidenceLinkConfirmation(p);
    equal(await dialog.getByTestId("bot-link-origin").innerText(), "https://actual.example.com:8443", "normalized origin and port");
    await dialog.getByText("Alba supplied this address. Quarterdeck has not checked where it leads.", { exact: true }).waitFor();
    const box = await dialog.boundingBox();
    equal(box.y > 0 && box.height < size.viewport.height, true, "compact confirmation");
  });
  it("Evidence on " + name + ": clicking the bot link alone cannot navigate", size, async (p) => {
    const { trigger, before } = await evidenceLinkConfirmation(p);
    equal(await trigger.getAttribute("href"), null, "no direct address");
    equal(await p.evaluate(() => window.__botLinkRequests), [], "no navigation request");
    equal(p.url(), before, "page stays");
    equal(p.context().pages().length, 1, "no new tab");
  });
  for (const action of ["Cancel", "Escape"]) {
    it("Evidence on " + name + ": " + action + " closes confirmation with focus back on the link", size, async (p) => {
      const { trigger, dialog } = await evidenceLinkConfirmation(p);
      if (action === "Escape") await p.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await trigger.locator("..").locator(":focus").waitFor();
      equal(await trigger.evaluate((el) => el === document.activeElement), true, "focus back on trigger");
      equal(await p.evaluate(() => window.__botLinkRequests), [], "no navigation request");
    });
  }
  it("Evidence on " + name + ": only Open requests the normalized URL in a protected new tab", size, async (p) => {
    const { dialog } = await evidenceLinkConfirmation(p);
    await dialog.getByRole("button", { name: "Open", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    equal(await p.evaluate(() => window.__botLinkRequests), [["https://actual.example.com:8443/review", "_blank", "noopener,noreferrer"]], "Open request");
  });
  it("Evidence on " + name + ": an earlier Open never suppresses the next confirmation", size, async (p) => {
    const { trigger, dialog } = await evidenceLinkConfirmation(p);
    await dialog.getByRole("button", { name: "Open", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await trigger.click();
    await dialog.waitFor();
    equal(await p.evaluate(() => window.__botLinkRequests.length), 1, "no remembered navigation approval");
  });
}

for (const [name, size] of [["phone", PHONE], ["Mac", MAC]]) {
  it("Evidence on " + name + ": a deceptive title still shows the real hostname", size, async (p) => {
    await open(p, "/queue/fx-ev-unsafe?fixtures=evidence");
    const row = T(p, "evidence-link").filter({ hasText: "Trusted service sign-in" });
    await row.getByText("actual.example.com:8443", { exact: true }).waitFor();
    equal(await row.getAttribute("href"), null, "no direct destination");
    equal(await row.getAttribute("aria-haspopup"), "dialog", "asks before navigation");
  });

  it("Evidence on " + name + ": a rejected link is plain text with the blocked-address line", size, async (p) => {
    await open(p, "/queue/fx-ev-unsafe?fixtures=evidence");
    const row = T(p, "evidence-row").filter({ hasText: "Plaintext preview" });
    await row.getByText("Link blocked: not a safe address", { exact: true }).waitFor();
    equal(await row.locator("a,button,[href],[role=link]").count(), 0, "no active link or confirmation trigger");
    equal(await row.getAttribute("tabindex"), null, "not a link-shaped focus target");
  });
}

it("Evidence: preview and live links both request confirmation before navigation", MAC, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "evidence-link").nth(1).waitFor();
  const links = T(p, "evidence-link");
  for (let n = 0; n < await links.count(); n++) {
    equal(await links.nth(n).getAttribute("href"), null, "no direct address");
    await links.nth(n).click();
    const dialog = p.getByRole("dialog", { name: "Open a link from Alba?" });
    await dialog.getByText("Alba supplied this address. Quarterdeck has not checked where it leads.", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  }
});

it("Evidence: each picture and video shows its caption under it and keeps the whole caption in its name (#69)", MAC, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "evidence-media").nth(2).waitFor();
  const pairs = await T(p, "evidence-tiles")
    .locator("li")
    .evaluateAll((items) =>
      items
        .filter((item) => item.querySelector('[data-testid="evidence-media"]'))
        .map((item) => [item.querySelector('[data-testid="evidence-media"]').getAttribute("aria-label"), item.querySelector('[data-testid="evidence-caption"]')?.textContent ?? ""]),
    );
  equal(pairs.length, 3, "three thumbnails");
  equal(pairs.every(([name, caption]) => caption.length > 0 && name.endsWith(caption)), true, JSON.stringify(pairs));
  equal(await T(p, "evidence-caption").first().isVisible(), true, "the caption is on screen");
});

it("Evidence: a link's name keeps its time and status and says it asks before opening", MAC, async (p) => {
  await open(p, "/queue/fx-ev-live?fixtures=evidence");
  await p.getByRole("button", { name: /Mail sync.*down since 9:20 AM.*delivered Sun 11:00 AM.*\(asks before opening in a new tab\)/ }).waitFor();
  await p.getByRole("button", { name: /up.*delivered Fri 4:00 PM.*\(asks before opening in a new tab\)/ }).waitFor();
});

it("Evidence: a live service shows up or down as the data says", MAC, async (p) => {
  await open(p, "/queue/fx-ev-live?fixtures=evidence");
  await T(p, "link-status").nth(1).waitFor();
  equal(await T(p, "link-status").allInnerTexts(), ["up", "down since 9:20 AM"], "status");
});

it("Evidence: another bot's passing check reads green with the count", PHONE, async (p) => {
  await open(p, "/queue/fx-ev-check-pass?fixtures=evidence");
  await T(p, "evidence-check").getByText("Checked by Shelvorn: 3 of 3 checks pass").waitFor();
  equal(await T(p, "evidence-check").getAttribute("data-tone"), "pass", "tone");
});

it("Evidence: a failing check reads red and names the failed check", PHONE, async (p) => {
  await open(p, "/queue/fx-ev-check-fail?fixtures=evidence");
  await T(p, "evidence-check").getByText("Failed: Every control at least 44 px", { exact: true }).waitFor();
  equal(await T(p, "evidence-check").getAttribute("data-tone"), "fail", "tone");
});

it("Evidence: a check by the bot that did the work reads Not checked by another bot yet", PHONE, async (p) => {
  await open(p, "/queue/fx-ev-check-owner?fixtures=evidence");
  await T(p, "evidence-check").getByText("Not checked by another bot yet", { exact: true }).waitFor();
  equal(await T(p, "evidence-check").getAttribute("data-tone"), "quiet", "tone");
});

it("Evidence: a failed load says so and Retry brings the pictures", PHONE, async (p) => {
  await open(p, "/queue/alba-1?fail=evidence");
  await shown(p, "The pictures and links did not load.");
  await T(p, "evidence").getByRole("button", { name: "Retry" }).tap();
  await T(p, "evidence-media").first().waitFor();
});

it("Task Card: saved versions show with his answer to the first one", PHONE, async (p) => {
  await open(p, "/queue/fx-history?fixtures=now");
  await T(p, "earlier-versions").locator("summary").tap();
  await T(p, "version").first().waitFor();
  await T(p, "earlier-versions").getByText(/^You answered: B\. Friday 5 PM/).waitFor();
  await T(p, "version").last().getByText(/^Risk: /).waitFor();
  const picture = await T(p, "version-picture").first().evaluate((el) => [getComputedStyle(el).fontSize, el.scrollWidth <= el.clientWidth]);
  equal(picture.join(" "), "12.5px true", "picture at the picture size, not cut");
});

it("Lane: the tracker comes first, then the activity, then waiting and answered rows", PHONE, async (p) => {
  await open(p, "/lanes/l-set");
  await shown(p, "2 waiting · 1 answered");
  await T(p, "lane-tracker").waitFor();
  await T(p, "lane-progress").waitFor();
  equal((await titles(p)).length, 2, "waiting rows");
  await p.locator("summary", { hasText: "Answered (1)" }).tap();
  await T(p, "lane").getByText(/^You: B · 9:10 PM · Alba$/).waitFor();
});

it("Lane on the Mac: the sidebar marks Projects, where the Lane belongs", MAC, async (p) => {
  await open(p, "/lanes/l-set");
  await T(p, "lane-progress").waitFor();
  const nav = p.getByRole("navigation", { name: "Quarterdeck" });
  equal(await nav.locator('[aria-current="page"]').allInnerTexts(), ["Projects"], "marked");
});

it("Lane on the Mac: opening an answered row keeps the Queue's search", MAC, async (p) => {
  await open(p, "/queue");
  await T(p, "queue-search").fill("device");
  await T(p, "card-row").getByRole("link", { name: "Pick what a new device shows first" }).click();
  await T(p, "card-pane").getByRole("link", { name: "Settings", exact: true }).first().click();
  await T(p, "lane").locator("summary", { hasText: "Answered (" }).click();
  await T(p, "lane").getByRole("link", { name: "Which Appearance choices ship at launch?" }).click();
  await T(p, "card-pane").getByTestId("card-title").getByText("Which Appearance choices ship at launch?").waitFor();
  equal(await T(p, "queue-search").inputValue(), "device", "Queue search kept");
});

it("Lane: a failed load says so and Retry loads it", PHONE, async (p) => {
  await open(p, "/lanes/l-set?fail=list");
  await shown(p, "Could not load this Lane.");
  await p.getByRole("button", { name: "Retry" }).tap();
  await T(p, "lane-progress").waitFor();
});

it("Projects: three projects with their Lanes, and the totals add up", MAC, async (p) => {
  await open(p, "/projects");
  await T(p, "project-row").nth(2).waitFor();
  equal(await T(p, "totals").innerText().then((text) => text.replace(/\s+/g, " ")), "3 projects · 10 Task Cards · 8 Lanes", "totals");
});

it("Projects: Artifacts stay folded on the phone", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck");
  await p.locator("summary", { hasText: "Artifacts" }).waitFor();
  equal(await T(p, "artifact-row").count(), 0, "folded");
});

it("Projects: a search with no match says so", PHONE, async (p) => {
  await open(p, "/projects");
  await p.getByPlaceholder("Search projects").fill("zebra");
  await shown(p, "No projects match.");
  equal(await T(p, "totals").innerText().then((text) => text.replace(/\s+/g, " ")), "0 of 3 projects · 0 Task Cards · 0 Lanes", "count follows the rows");
});

it("Projects: a failed load says so and Retry loads it", PHONE, async (p) => {
  await open(p, "/projects?fail=list");
  await shown(p, "Could not load the Projects.");
  await p.getByRole("button", { name: "Retry" }).tap();
  await T(p, "project-row").first().waitFor();
});

const textLines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const laneRow = (p, id) => p.locator(`[data-testid="lane-row"][data-id="${id}"]`);
const projectRow = (p, id) => p.locator(`[data-testid="project-row"]:is([href="/projects/${id}"], #project-${id})`);
const kinds = (p) => T(p, "activity-list").locator("> li").evaluateAll((items) => items.map((item) => item.dataset.testid));
const laneLines = (p) => T(p, "lane-progress").locator("li[data-testid]").evaluateAll((items) => items.map((item) => [item.dataset.testid, item.textContent]));

it("Projects: the sidebar item says Projects has something new", MAC, async (p) => {
  await open(p, "/projects");
  const item = p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: "Projects, new activity" });
  await item.waitFor();
  equal(await item.getByTestId("new-dot").count(), 1, "dot");
});

it("Projects: each Project row counts what is new in its Lanes", MAC, async (p) => {
  await open(p, "/projects");
  await T(p, "project-row").nth(2).waitFor();
  const counts = [];
  for (const id of ["quarterdeck", "heron-forge", "dale-tools"]) counts.push(await projectRow(p, id).getByTestId("project-new").innerText());
  equal(counts, ["3 new", "2 new", "2 new"], "project counts");
});

it("Projects: each Active Lane counts what is new in it, and a Lane with nothing new shows none", MAC, async (p) => {
  const counts = {};
  for (const [project, ids] of [["quarterdeck", ["l-set", "l-sea", "l-mai"]], ["heron-forge", ["l-sw1", "l-sw2"]], ["dale-tools", ["l-da1"]]]) {
    await open(p, "/projects/" + project);
    await laneRow(p, ids[0]).waitFor();
    for (const id of ids) counts[id] = await laneRow(p, id).getByTestId("new-mark").allInnerTexts();
  }
  equal(counts, { "l-set": ["2 new"], "l-sea": ["1 new"], "l-mai": [], "l-sw1": ["1 new"], "l-sw2": ["1 new"], "l-da1": ["2 new"] }, "lane counts");
});

it("Projects: a Lane row shows its stage, its mark and what the bots do now", MAC, async (p) => {
  await open(p, "/projects/dale-tools");
  equal(await laneRow(p, "l-da1").getByTestId("lane-stage").innerText(), "Build the export sh… (4 of 7) · step 5 of 12", "stage");
  equal(await laneRow(p, "l-da1").getByTestId("lane-mark").innerText(), "! Waiting on you", "mark");
  await open(p, "/projects/quarterdeck");
  equal(await laneRow(p, "l-mai").getByTestId("lane-mark").innerText(), "No update for 20 hours", "quiet");
  equal((await laneRow(p, "l-sea").getByTestId("lane-now").innerText()).endsWith("Dr. Kivo is testing Search groups on the example data."), true, "now");
});

it("Projects: after he answers alba-1 the Search Lane row no longer says Waiting on you", MAC, async (p) => {
  await open(p, "/queue/alba-1");
  await T(p, "card-pane").getByTestId("send").click();
  await shown(p, "Got it: How many results should each Search group show, A, 10:00 AM");
  await p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: /^Projects/ }).click();
  await projectRow(p, "quarterdeck").click();
  await laneRow(p, "l-sea").waitFor();
  equal(await laneRow(p, "l-sea").getByTestId("lane-mark").count(), 0, "mark gone");
});

it("Projects: Done Lanes fold under Done (1) in their Project and open to their done line", MAC, async (p) => {
  await open(p, "/projects/dale-tools");
  await T(p, "done-lanes").waitFor();
  equal(await T(p, "done-lanes").locator("summary").allInnerTexts(), ["Done (1)"], "dale-tools fold");
  await open(p, "/projects/quarterdeck");
  await T(p, "done-lanes").waitFor();
  equal(await T(p, "done-lanes").locator("summary").allInnerTexts(), ["Done (1)"], "quarterdeck fold");
  await T(p, "done-lanes").locator("summary").click();
  equal((await laneRow(p, "l-sid").getByTestId("lane-stage").innerText()).endsWith("Done Fri 12:41 PM · checked by Shelvorn"), true, "done line");
});

it("Projects: the Done fold shows the new count of its Done Lanes", MAC, async (p) => {
  await open(p, "/projects/fx-lane-tracker?fixtures=lanes");
  await projectRow(p, "fx-lane-tracker").waitFor();
  equal(await projectRow(p, "fx-lane-tracker").getByTestId("done-lanes").locator("summary").getByTestId("done-new").innerText(), "4 new", "Done fold");
});

it("Lane: opening a Lane that has news clears its count and lowers its Project's", MAC, async (p) => {
  await open(p, "/projects/quarterdeck");
  await laneRow(p, "l-set").click();
  await T(p, "last-looked").waitFor();
  await p.getByRole("link", { name: "quarterdeck" }).first().click();
  await gone(T(p, "last-looked"));
  equal(await laneRow(p, "l-set").getByTestId("new-mark").count(), 0, "Settings count gone");
  await p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: /^Projects/ }).click();
  await T(p, "project-row").nth(2).waitFor();
  equal(await projectRow(p, "quarterdeck").getByTestId("project-new").innerText(), "1 new", "project count");
  equal(await projectRow(p, "heron-forge").getByTestId("project-new").innerText(), "2 new", "other Project unchanged");
});

it("Lane: You last looked sits right after the new lines and says when he looked", PHONE, async (p) => {
  await open(p, "/lanes/l-set");
  await T(p, "last-looked").waitFor();
  equal(await T(p, "last-looked").innerText(), "You last looked: 9:00 AM", "line");
  equal((await kinds(p)).indexOf("last-looked"), 2, "right after the two new lines");
});

it("Lane: the first line after You last looked is the newest line he had already seen, across both lists", PHONE, async (p) => {
  await open(p, "/lanes/l-set");
  await T(p, "last-looked").waitFor();
  const lines = await laneLines(p);
  const next = lines[lines.findIndex(([kind]) => kind === "last-looked") + 1];
  equal([next[0], next[1].includes("Listed the Settings sections: Bots, Appearance, Add-ons, Storage, Account.")], ["activity", true], "first seen line");
});

it("Lane: a Lane with nothing new shows no You last looked line", PHONE, async (p) => {
  await open(p, "/lanes/l-mai");
  await T(p, "activity-list").waitFor();
  equal(await T(p, "last-looked").count(), 0, "no line");
});

it("Lane: opened again after he looked, it shows no You last looked line", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck");
  await laneRow(p, "l-set").tap();
  await T(p, "last-looked").waitFor();
  await p.getByRole("link", { name: "quarterdeck" }).first().tap();
  await laneRow(p, "l-set").tap();
  await T(p, "activity-list").waitFor();
  equal(await T(p, "last-looked").count(), 0, "no line");
});

it("Lane: a Lane last looked at more than a week ago says the date", PHONE, async (p) => {
  await open(p, "/lanes/l-sw2");
  await T(p, "last-looked").waitFor();
  equal(await T(p, "last-looked").innerText(), "You last looked: Oct 22, 9:00 AM", "line");
});

it("Lane: the tracker shows the stages, step, goal, now, next, blockers and update as the content wrote them", PHONE, async (p) => {
  await open(p, "/lanes/l-sea");
  await T(p, "lane-tracker").waitFor();
  equal(textLines(await T(p, "lane-tracker").innerText()), [
    "✓",
    "Plan",
    "●",
    "Execute",
    "○",
    "Check",
    "Stages",
    "Execute, step 3 of 4: Build the group rows",
    "Done when",
    "Every Search group shows its rows and a See all row",
    "Now",
    "Dr. Kivo is testing Search groups on the example data.",
    "Next",
    "Shelvorn checks Search on the phone and the Mac.",
    "Blockers (1)",
    "! Waiting on you: How many results should each Search group show?, since 9:05 AM",
    "Updated 9:05 AM by Dr. Kivo",
  ], "tracker");
});

it("Lane on the Mac: seven stages fold into done, current and more, and the count line says where it is", MAC, async (p) => {
  await open(p, "/lanes/l-da1");
  await T(p, "lane-tracker").waitFor();
  equal(textLines(await T(p, "stage-row").innerText()), ["✓ 3 done", "● Build the export sh…", "○ 3 more"], "row");
  equal(await T(p, "count-line").innerText(), "Stage 4 of 7 · step 5 of 12: Add the Owner…", "count");
});

it("Lane: a blocker that waits on him opens its Task Card", PHONE, async (p) => {
  await open(p, "/lanes/l-sea");
  await T(p, "blocker").getByRole("link").tap();
  await T(p, "options").waitFor();
  equal(new URL(p.url()).pathname.endsWith("/alba-1"), true, "card " + p.url());
});

it("Lane: Stages opens the list of every stage and a second tap closes it", PHONE, async (p) => {
  await open(p, "/lanes/l-da1");
  const button = T(p, "stages-btn");
  await button.tap();
  await T(p, "stages-list").waitFor();
  equal(await button.getAttribute("aria-expanded"), "true", "open");
  equal(await T(p, "stages-list").locator("h3").innerText(), "Stages of Task export (7)", "title");
  await button.tap();
  await gone(T(p, "stages-list"));
  equal(await button.getAttribute("aria-expanded"), "false", "closed");
});

it("Lane: in Stages the done stages fold, and the current stage folds its done and later steps", PHONE, async (p) => {
  await open(p, "/lanes/l-da1");
  await T(p, "stages-btn").tap();
  await T(p, "stages-list").waitFor();
  equal(await T(p, "done-stages").locator("summary").innerText(), "✓ Plan, Design the column order, Prototype the CSV file (3 done)", "done fold");
  equal(await T(p, "stage-block").locator("summary").allInnerTexts(), ["✓ 4 steps done", "○ 6 more steps"], "step folds");
});

it("Lane: a Done Lane is a read-only record with its done line, all its activity and Talk to the lead", PHONE, async (p) => {
  await open(p, "/lanes/l-da2");
  await T(p, "done-line").waitFor();
  equal(await T(p, "lane").getAttribute("data-status"), "Done", "status");
  equal(await T(p, "done-line").innerText(), "Done Sun 8:41 PM. Checked by Dr. Kivo. Signed off by you.", "done line");
  equal([await T(p, "tracker-blockers").count(), await p.getByText(/^Earlier activity/).count()], [0, 0], "no blockers, nothing folded");
  equal(await T(p, "talk-to").innerText(), "Talk to Dale", "button");
  await T(p, "talk-to").tap();
  await p.waitForURL((url) => url.pathname.startsWith("/chat/"));
});

it("Queue: the Done Lane's sign-off card is not waiting", PHONE, async (p) => {
  await open(p, "/queue");
  await shown(p, "· 10 waiting");
  equal(await p.locator('[data-testid="card-row"][data-id="dale-1"]').count(), 0, "not in the Queue");
});

it("Lane: a failed tracker load says so and Retry loads it", PHONE, async (p) => {
  await open(p, "/lanes/l-set?fail=trackers");
  await shown(p, "Could not load the Lane tracker.");
  await p.getByRole("button", { name: "Retry" }).tap();
  await T(p, "stage-row").waitFor();
});

it("Lane: a failed tracker load shows its error in the tracker panel and keeps the Activity and You last looked", PHONE, async (p) => {
  await open(p, "/lanes/l-set?fail=trackers");
  await T(p, "lane-tracker").getByText("Could not load the Lane tracker.", { exact: true }).waitFor();
  await T(p, "activity-list").waitFor();
  await T(p, "last-looked").waitFor();
});

it("Projects: a failed tracker load says so and Retry loads it", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck?fail=trackers");
  await shown(p, "Could not load the Lane trackers.");
  await p.getByRole("button", { name: "Retry" }).tap();
  await T(p, "lane-stage").first().waitFor();
  await gone(p.getByText("Could not load the Lane trackers.", { exact: true }));
});

it("Projects: a failed tracker load still shows all three Projects, below the error", PHONE, async (p) => {
  await open(p, "/projects?fail=trackers");
  await shown(p, "Could not load the Lane trackers.");
  await T(p, "project-row").nth(2).waitFor();
  equal(await T(p, "project-row").count(), 3, "rows");
  const [alert, row] = await Promise.all([p.getByRole("alert").boundingBox(), T(p, "project-row").first().boundingBox()]);
  equal(alert.y < row.y, true, "error above the rows");
});

it(
  "Shell: a Lane screen whose script cannot load says so in the screen area, keeps the header and Menu, and Retry shows the Lane",
  PHONE,
  async (p) => {
    let blocked = true;
    await p.route("**/chunk-*.js", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (blocked && body.includes("lane-progress")) await route.abort();
      else await route.fulfill({ response, body });
    });
    await open(p, "/lanes/l-set");
    const area = p.locator("main#main-scroll");
    await area.getByText("Could not load this screen.", { exact: true }).waitFor();
    await area.locator("header").waitFor();
    await T(p, "menu-btn").tap();
    await p.getByRole("navigation", { name: "Quarterdeck" }).waitFor();
    await p.keyboard.press("Escape");
    await gone(p.locator('[data-pop="drawer"]'));
    blocked = false;
    await area.getByRole("button", { name: "Retry" }).tap();
    await T(p, "lane-progress").waitFor();
  },
  /net::ERR_FAILED|Failed to fetch dynamically imported module/,
);

it(
  "Shell on the Mac: a Settings screen whose script cannot load says so in the screen area, keeps the sidebar, and Retry shows Settings",
  MAC,
  async (p) => {
    let blocked = true;
    await p.route("**/chunk-*.js", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (blocked && body.includes("settings-screen")) await route.abort();
      else await route.fulfill({ response, body });
    });
    await open(p, "/queue");
    await T(p, "card-row").first().waitFor();
    await T(p, "settings-btn").click();
    const area = p.locator("main#main-scroll");
    await area.getByText("Could not load this screen.", { exact: true }).waitFor();
    equal([new URL(p.url()).pathname, await p.getByRole("navigation", { name: "Quarterdeck" }).isVisible()], ["/settings", true], "route and sidebar");
    blocked = false;
    await area.getByRole("button", { name: "Retry" }).click();
    await T(p, "settings-screen").waitFor();
  },
  /net::ERR_FAILED|Failed to fetch dynamically imported module/,
);

for (const [kind, opener, marker, shownWhenOpen] of [
  ["Search", "search-btn", "search-hit", "search-input"],
  ["Add bot", "add-bot-btn", "bot-name-step", "bot-name"],
])
  for (const shut of ["Close", "Escape", "scrim"])
    it(
      "Shell on the Mac: when the " + kind + " dialog cannot load, the sidebar is inert, " + shut + " closes it without sidebar navigation and returns focus, sidebar links work again, and Retry opens it",
      MAC,
      async (p) => {
        let blocked = true;
        await p.route("**/chunk-*.js", async (route) => {
          const response = await route.fetch();
          const body = await response.text();
          if (blocked && body.includes(marker)) await route.abort();
          else await route.fulfill({ response, body });
        });
        await open(p, "/queue");
        await T(p, "card-row").first().waitFor();
        await T(p, opener).click();
        const failed = p.locator('[data-pop="dialog-failed"]');
        await failed.getByText("Could not load this screen.", { exact: true }).waitFor();
        equal(await failed.evaluate((el) => el.contains(document.activeElement)), true, "focus on the failed dialog");
        const aside = p.locator("aside");
        const projects = aside.locator('a[href="/projects"]');
        const scrim = p.locator('.fixed.inset-0.z-40.bg-scrim[aria-hidden="true"]');
        if (shut === "scrim") equal(await scrim.count(), 1, "full-screen scrim");
        equal(await aside.getAttribute("inert"), "", "sidebar has inert");
        equal(await p.locator("main#main-scroll").evaluate((el) => el.inert), true, "page inert");
        if (shut === "Escape") await p.keyboard.press("Escape");
        else if (shut === "Close") await failed.getByRole("button", { name: "Close" }).click();
        else {
          equal(await scrim.boundingBox(), { x: 0, y: 0, width: 1512, height: 982 }, "scrim covers the whole window");
          const link = await projects.boundingBox();
          await p.mouse.click(link.x + link.width / 2, link.y + link.height / 2);
        }
        await gone(failed);
        equal(new URL(p.url()).pathname, "/queue", "no sidebar navigation behind the dialog");
        equal(await T(p, opener).evaluate((el) => el === document.activeElement), true, "focus back on its button");
        equal(await aside.getAttribute("inert"), null, "sidebar no longer inert");
        equal(await p.locator("main#main-scroll").evaluate((el) => el.inert), false, "page usable");
        await projects.click();
        await p.waitForURL("**/projects");
        await T(p, "project-row").first().waitFor();
        await T(p, opener).click();
        await failed.waitFor();
        blocked = false;
        await failed.getByRole("button", { name: "Retry" }).click();
        await T(p, shownWhenOpen).waitFor();
        equal(await aside.getAttribute("inert"), "", "sidebar stays inert behind the loaded dialog");
      },
      /net::ERR_FAILED|Failed to fetch dynamically imported module/,
    );

for (const [size, box, drawer] of [["the Mac", MAC, false], ["a phone", PHONE, true]])
  for (const shut of ["Escape", "outside"])
    it("Shell on " + size + ": Account opens with the page inert, " + shut + " closes it and focus returns to its opener", box, async (p) => {
      await open(p, "/queue");
      if (drawer) {
        await T(p, "menu-btn").click();
        await p.locator('[data-pop="drawer"]').waitFor();
      }
      await T(p, "account-btn").click();
      const menu = p.locator('[data-pop="account-menu"]');
      await menu.waitFor();
      if (!drawer) equal(await p.locator("aside").getAttribute("inert"), "", "sidebar inert behind Account");
      equal(await p.locator("main#main-scroll").evaluate((el) => el.inert), true, "page inert behind Account");
      if (shut === "Escape") await p.keyboard.press("Escape");
      else if (drawer) await p.touchscreen.tap(8, 8);
      else await p.mouse.click(8, 8);
      await gone(menu);
      if (!drawer) equal(await p.locator("aside").getAttribute("inert"), null, "sidebar usable after Account closes");
      equal(await p.locator("main#main-scroll").evaluate((el) => el.inert), false, "page usable after Account closes");
      equal(await T(p, drawer ? "menu-btn" : "account-btn").evaluate((el) => el === document.activeElement), true, "focus back on opener");
    });

it("Lane fixtures: a pending sign-off shows the Check line and its blocker links to the card", PHONE, async (p) => {
  await open(p, "/lanes/fx-l-signoff?fixtures=lanes");
  await T(p, "check-line").waitFor();
  equal(await T(p, "check-line").innerText(), "Check done by Dr. Kivo: 3 of 3 pass", "check");
  equal(await T(p, "blocker").innerText(), "! Waiting on you: Sign off: Room map is done?, since 9:05 AM", "blocker");
  equal(await T(p, "blocker").getByRole("link").getAttribute("href"), "/queue/fx-signoff-1", "link");
});

const openApprovedLane = async (p) => {
  await open(p, "/queue/fx-signoff-1?fixtures=lanes");
  await T(p, "card-pane").getByTestId("send").click();
  await p.getByText(/^Got it: Sign off: Room map is done/).first().waitFor();
  await p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: /^Projects/ }).click();
  await projectRow(p, "fx-lane-tracker").click();
  await projectRow(p, "fx-lane-tracker").getByTestId("done-lanes").locator("summary").click();
  await laneRow(p, "fx-l-signoff").click();
  await T(p, "lane").waitFor();
};

it("Lane fixtures: his Approve on the sign-off card makes the Lane Done, with its done line and no blocker", MAC, async (p) => {
  await openApprovedLane(p);
  equal(await T(p, "lane").getAttribute("data-status"), "Done", "status");
  equal(await T(p, "done-line").innerText(), "Done 10:00 AM. Checked by Dr. Kivo. Signed off by you.", "done line");
  equal(await T(p, "tracker-blockers").count(), 0, "no blocker");
});

it("Lane fixtures: after his Approve the Lane's first Activity line is Lane done by Shelvorn at the tracker's Updated time", MAC, async (p) => {
  await openApprovedLane(p);
  const first = T(p, "activity-list").locator("li").first();
  const text = await first.locator("p").last().innerText();
  equal([await first.locator("b").innerText(), await first.locator("time").innerText(), text.startsWith("Lane done.")], ["Shelvorn", "10:00 AM", true], "first line");
  equal(await T(p, "tracker-updated").innerText(), "Updated 10:00 AM by Shelvorn", "updated");
});

it("Lane fixtures: a Lane with no steps shows no step line and no count line", PHONE, async (p) => {
  await open(p, "/lanes/fx-l-nosteps?fixtures=lanes");
  await T(p, "lane-tracker").waitFor();
  equal([await T(p, "step-line").count(), await T(p, "count-line").count()], [0, 0], "no step line");
});

it("Lane fixtures: a stage row of 44 characters fits on one line", PHONE, async (p) => {
  await open(p, "/lanes/fx-l-fit44?fixtures=lanes");
  equal(textLines(await T(p, "stage-row").innerText()), ["✓", "Plan", "●", "Execute", "○", "Check on iPhone and Mac"], "44 fit");
});

it("Lane fixtures: a stage row of 45 characters folds", PHONE, async (p) => {
  await open(p, "/lanes/fx-l-fit45?fixtures=lanes");
  equal(/^✓ \d+ done$/.test(textLines(await T(p, "stage-row").innerText())[0]), true, "45 fold");
});

it("Lane fixtures: a blocker that waits on a bot has no link and the Project row says Blocked", MAC, async (p) => {
  await open(p, "/lanes/fx-l-botblock?fixtures=lanes");
  await T(p, "blocker").waitFor();
  equal(await T(p, "blocker").getByRole("link").count(), 0, "no link");
  await open(p, "/projects/fx-lane-tracker?fixtures=lanes");
  equal(await laneRow(p, "fx-l-botblock").getByTestId("lane-mark").innerText(), "! Blocked: Dale", "mark");
});

it("Catch-up fixtures: the Project says 6 new, and opening Some new drops it to 4", MAC, async (p) => {
  await open(p, "/projects?fixtures=catch-up");
  await projectRow(p, "fx-catch-up").waitFor();
  equal(await projectRow(p, "fx-catch-up").getByTestId("project-new").innerText(), "6 new", "before");
  await projectRow(p, "fx-catch-up").click();
  await laneRow(p, "fx-l-some").click();
  await T(p, "last-looked").waitFor();
  equal(await T(p, "last-looked").innerText(), "You last looked: 8:30 AM", "line");
  await p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: /^Projects/ }).click();
  await projectRow(p, "fx-catch-up").getByTestId("project-new").waitFor();
  equal(await projectRow(p, "fx-catch-up").getByTestId("project-new").innerText(), "4 new", "after");
});

it("Catch-up fixtures: a Lane he never opened counts every line, and a bot update after he looked counts one", MAC, async (p) => {
  await open(p, "/projects/fx-catch-up?fixtures=catch-up");
  await projectRow(p, "fx-catch-up").waitFor();
  equal(await laneRow(p, "fx-l-never").getByTestId("new-mark").innerText(), "3 new", "never opened");
  equal(await laneRow(p, "fx-l-after").getByTestId("new-mark").innerText(), "1 new", "after");
  equal(await laneRow(p, "fx-l-none").getByTestId("new-mark").count(), 0, "nothing new");
});

it("Projects: All Pages opens the project's Pages list", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck");
  await p.locator('[data-testid="all-pages"][href="/projects/quarterdeck/pages"]').tap();
  await T(p, "pages-sub").waitFor();
  equal(new URL(p.url()).pathname, "/projects/quarterdeck/pages", "route");
});

it("Projects on the Mac: Filter by Lead leaves only that lead's projects", MAC, async (p) => {
  await open(p, "/projects");
  await T(p, "project-row").nth(2).waitFor();
  await T(p, "filter-btn").click();
  await p.locator('[data-pop="filter-menu"]').getByRole("radio", { name: "Shelvorn" }).click();
  await p.keyboard.press("Escape");
  await gone(T(p, "project-row").nth(1));
  equal(await T(p, "project-row").getAttribute("href"), "/projects/heron-forge", "row");
});

it("Projects on the Mac: Sort by Name lists the projects by name", MAC, async (p) => {
  await open(p, "/projects");
  await T(p, "project-row").nth(2).waitFor();
  await T(p, "sort-btn").click();
  await p.locator('[data-pop="sort-menu"]').getByRole("radio", { name: "Name" }).click();
  await p.waitForFunction(() => document.querySelector('[data-testid="project-row"]')?.getAttribute("href") === "/projects/dale-tools");
  equal(await T(p, "project-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("href"))), ["/projects/dale-tools", "/projects/heron-forge", "/projects/quarterdeck"], "name order");
});

it("Project: Lanes come grouped With Task Cards, Active and Done, then Pages, then Artifacts", MAC, async (p) => {
  await open(p, "/projects/quarterdeck");
  await T(p, "artifact-row").first().waitFor();
  const heads = await T(p, "project-row").locator("h2, summary").allTextContents();
  const names = ["With Task Cards", "Active", "Done", "Pages", "Artifacts"];
  equal(heads.map((text) => names.find((name) => text.startsWith(name)) ?? text), names, "order");
});

it("Project on a phone: the last Artifact scrolls fully into view", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck");
  await p.locator("summary", { hasText: "Artifacts" }).tap();
  const last = T(p, "artifact-row").last();
  await last.scrollIntoViewIfNeeded();
  const box = await last.boundingBox();
  equal(box.y >= 0 && box.y + box.height <= 844, true, "in view " + JSON.stringify(box));
});

it("Project on the Mac: the head is the crumb Projects > project", MAC, async (p) => {
  await open(p, "/projects/quarterdeck");
  const crumb = T(p, "crumb");
  await crumb.locator('[aria-current="page"]', { hasText: "quarterdeck" }).waitFor();
  equal(await crumb.locator("li:not([aria-hidden])").allInnerTexts(), ["Projects", "quarterdeck"], "crumb");
  equal(await crumb.locator('[aria-current="page"]').innerText(), "quarterdeck", "here");
});

it("Lane on the Mac: the Lane opens beside its project, and both read Projects > project, two levels only", MAC, async (p) => {
  await open(p, "/projects/quarterdeck");
  await laneRow(p, "l-sea").click();
  await T(p, "lane").waitFor();
  const [project, lane] = await Promise.all([T(p, "projects").boundingBox(), T(p, "lane").boundingBox()]);
  equal(lane.x >= project.x + project.width - 1, true, "Lane to the right of its project");
  const crumbs = await T(p, "crumb").evaluateAll((navs) => navs.map((nav) => [...nav.querySelectorAll("li:not([aria-hidden])")].map((item) => item.textContent)));
  equal(crumbs, [["Projects", "quarterdeck"], ["Projects", "quarterdeck"]], "crumbs");
});

it("Lane: Activity shows its latest 20 entries whole, then Show older", PHONE, async (p) => {
  await open(p, "/lanes/l-sea?fixtures=lanes");
  const list = T(p, "activity-list");
  await list.waitFor();
  equal(await list.locator('> [data-testid="activity"]').count(), 20, "latest 20");
  equal(await list.evaluate((el) => el.scrollHeight <= el.clientHeight), true, "nothing cut inside the list");
  await p.locator("summary", { hasText: "Show older" }).waitFor();
});

it("Lane: the Activity entry about a shipped Page shows its Build and Target previews", PHONE, async (p) => {
  await open(p, "/lanes/l-sea?fixtures=lanes");
  const proof = T(p, "activity").filter({ hasText: "Shipped recent searches" }).locator(".activity-proof a");
  await proof.nth(1).waitFor();
  equal(await proof.locator("span").allInnerTexts(), ["Build", "Target"], "previews");
});

it("Lane beside its project on an iPad held sideways: the page holds one Menu, in the project's head", TOUCH_SIDEWAYS, async (p) => {
  await open(p, "/lanes/l-sea");
  await T(p, "projects").waitFor();
  await T(p, "lane").waitFor();
  equal([await T(p, "menu-btn").count(), await T(p, "projects").locator('[data-testid="menu-btn"]').count()], [1, 1], "Menu buttons on the page, and in the project's head");
});

it("Mail: threads come newest first and one opens with its mails and their attachments", PHONE, async (p) => {
  await open(p, "/mail");
  await T(p, "mail-row").nth(6).waitFor();
  equal(
    await T(p, "mail-row").locator("b").allInnerTexts(),
    [
      "Fwd: Search group limit: how many rows per group?",
      "Search group limit: how many rows per group?",
      "Room list check before the bridge change",
      "First export sheet columns",
      "What goes in Account at launch?",
      "Recent searches on a phone",
      "Pib's mail delivery test",
    ],
    "order",
  );
  await T(p, "mail-row").nth(1).tap();
  await T(p, "mail-item").nth(3).waitFor();
  await T(p, "behind-card").waitFor();
  await open(p, "/mail/MT-107");
  await T(p, "mail-item").nth(3).getByRole("link", { name: /search-context\.md/ }).waitFor();
});

it("Mail: Copy reference confirms only after the clipboard takes it", PHONE, async (p) => {
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(p, "/mail/MT-101");
  await T(p, "mail-thread").getByRole("button", { name: "Copy reference" }).first().tap();
  await shown(p, "Copied MT-101");
  equal(await p.evaluate(() => navigator.clipboard.readText()), "MT-101", "clipboard");
});

it("Mail: Back to Mail returns to the same place in the list", { ...PHONE, viewport: { width: 390, height: 420 } }, async (p) => {
  await open(p, "/mail");
  const last = T(p, "mail-row").nth(6);
  await last.scrollIntoViewIfNeeded();
  const place = await p.evaluate(() => window.scrollY);
  equal(place > 0, true, "list scrolled");
  await last.tap();
  await T(p, "mail-item").first().waitFor();
  equal(await p.evaluate(() => window.scrollY), 0, "thread opens at its top");
  await p.getByRole("link", { name: "Back to Mail", exact: true }).tap();
  await last.waitFor();
  equal(await p.evaluate(() => window.scrollY), place, "list place");
});

it("Mail: a search with no match says so", PHONE, async (p) => {
  await open(p, "/mail");
  await T(p, "mail-search").fill("zebra");
  await shown(p, "No mail matches.");
});

it("Mail: the head shows no thread count", PHONE, async (p) => {
  await open(p, "/mail");
  await T(p, "mail-row").nth(6).waitFor();
  equal(await p.getByText(/^(\d+ of )?\d+ threads?$/).count(), 0, "no count");
});

it("Mail: the thread header says Read only. Your inbox and sent mail., above the first mail", PHONE, async (p) => {
  await open(p, "/mail/MT-101");
  const line = T(p, "mail-read-only");
  equal(await line.innerText(), "Read only. Your inbox and sent mail.", "words");
  equal(await line.evaluate((el) => Boolean(el.compareDocumentPosition(document.querySelector('[data-testid="mail-item"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, "before the first mail");
});

it("Mail: a failed load says so and Retry loads it", PHONE, async (p) => {
  await open(p, "/mail?fail=list");
  await shown(p, "Could not load the Mail.");
  await p.getByRole("button", { name: "Retry" }).tap();
  await T(p, "mail-row").first().waitFor();
});

it("Mail: threads sit under day headings, show two bots and a plus count, and carry no marks", PHONE, async (p) => {
  await open(p, "/mail");
  await T(p, "mail-row").nth(6).waitFor();
  equal(await T(p, "mail-day").locator("h3").allTextContents(), ["Today", "Yesterday", "Fri Oct 30"], "headings");
  equal(await T(p, "mail-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-id"))), ["MT-106", "MT-101", "MT-102", "MT-104", "MT-103", "MT-107", "MT-105"], "order");
  equal(await T(p, "mail-row-bots").allInnerTexts(), ["Alba, Iris", "Alba, Dr. Kivo +1", "Shelvorn, Iris", "Dale, Dr. Kivo", "Alba, Shelvorn +1", "Dr. Kivo, Alba +2", "Pib, Dr. Kivo"], "bots");
  equal(await T(p, "mail-row").first().locator("time").innerText(), "9:52 AM", "time under the heading");
  equal(await p.locator('[data-unread],[aria-label*="unread" i]').count(), 0, "no unread marks");
});

it("Mail: every mail says who got it and who was copied, shows no cc line when no one was, and marks a removed bot", PHONE, async (p) => {
  await open(p, "/mail/MT-101");
  await T(p, "mail-item").nth(3).waitFor();
  equal(await T(p, "mail-to").allInnerTexts(), ["Alba to Dr. Kivo", "Dr. Kivo to Alba", "Alba to Iris", "Iris to Alba"], "To lines");
  equal(await T(p, "mail-cc").allInnerTexts(), ["cc Dr. Kivo", "cc Dr. Kivo"], "Cc lines");
  equal(await T(p, "mail-bots").innerText(), "Alba, Dr. Kivo, Iris", "bots in the header");
  await open(p, "/mail/MT-105");
  await T(p, "mail-item").nth(2).waitFor();
  equal(await T(p, "mail-to").allInnerTexts(), ["Pib (removed) to Dr. Kivo", "Dr. Kivo to Pib (removed)", "Pib (removed) to Dr. Kivo"], "removed bot in To");
  equal(await T(p, "mail-item").locator("time").allInnerTexts(), ["Thu 2:00 PM", "Fri 9:00 AM", "Fri 4:20 PM"], "times show the content's labels");
  equal(await T(p, "mail-cc").count(), 0, "no cc line when no one is copied");
  equal(await T(p, "mail-bots").innerText(), "Pib (removed), Dr. Kivo", "removed bot in the header");
  equal(await p.getByText(/bcc/i).count(), 0, "no bcc anywhere");
});

it("Mail: Ask on a mail lists the writer first, never a removed bot, and opens that bot's chat with the mail quoted", PHONE, async (p) => {
  await open(p, "/mail/MT-101");
  await T(p, "ask-MT-101.2").tap();
  const menu = p.locator('[data-pop="ask"]');
  await menu.waitFor();
  equal(await menu.getByRole("heading").innerText(), "Ask about MT-101.2", "title");
  equal(await T(p, "ask-name").allTextContents(), ["Dr. Kivo (wrote it)", "Alba", "Iris", "Another bot..."], "choices");
  await menu.getByRole("button", { name: "Alba" }).tap();
  await p.getByPlaceholder("Message Alba").waitFor();
  equal(new URL(p.url()).pathname, "/chat/alba", "the bot's chat");
  const quote = (await T(p, "chat-quote").innerText()).replace(/\s+/g, " ");
  equal(quote.startsWith("MT-101.2 Dr. Kivo to Alba Five fits the iPhone with the keyboard up."), true, "the mail is quoted: " + quote);
  await open(p, "/mail/MT-105");
  await T(p, "ask-MT-105.1").tap();
  equal(await T(p, "ask-name").allTextContents(), ["Dr. Kivo", "Another bot..."], "a removed writer is not offered");
});

it("Mail: a link to one mail loads its thread when the page is opened fresh, with that mail marked", PHONE, async (p) => {
  await open(p, "/mail/MT-101.2");
  await T(p, "mail-item").nth(3).waitFor();
  equal(await p.locator('[data-testid="mail-item"].bg-control').evaluateAll((items) => items.map((item) => item.getAttribute("data-ref"))), ["MT-101.2"], "the marked mail");
  await T(p, "forwarded-by").waitFor();
});

it("Mail: Another bot lists the bots not offered yet, and Ask on a thread offers every bot in it and quotes the thread", PHONE, async (p) => {
  await open(p, "/mail/MT-107");
  await T(p, "ask-MT-107").tap();
  const menu = p.locator('[data-pop="ask"]');
  equal(await T(p, "ask-name").allTextContents(), ["Dr. Kivo", "Alba", "Shelvorn", "Iris", "Another bot..."], "thread choices");
  await T(p, "ask-another").tap();
  equal(await menu.getByRole("heading").innerText(), "Ask another bot about MT-107", "title");
  equal(await T(p, "ask-name").allTextContents(), ["Dale"], "the other bots");
  await T(p, "ask-bot").tap();
  await p.getByPlaceholder("Message Dale").waitFor();
  const quote = (await T(p, "chat-quote").innerText()).replace(/\s+/g, " ");
  equal(quote.startsWith("MT-107 Recent searches on a phone 4 mails between Dr. Kivo, Alba, Shelvorn, Iris"), true, "the thread is quoted: " + quote);
});

it("Mail: a forward links to the mail it came from and that mail links back", PHONE, async (p) => {
  await open(p, "/mail/MT-106");
  await T(p, "forwarded-from").waitFor();
  equal(await T(p, "forwarded-from").innerText(), "Forwarded from MT-101.2", "line");
  equal((await T(p, "forward-quote").innerText()).replace(/\s+/g, " "), "Dr. Kivo to Alba, 8:20 AM Five fits the iPhone with the keyboard up. Three is too few for Chats.", "quote");
  equal(await T(p, "behind-card").count(), 0, "no card link");
  await T(p, "forwarded-from").tap();
  await T(p, "forwarded-by").waitFor();
  equal(new URL(p.url()).pathname, "/mail/MT-101.2", "lands on the mail");
  equal(await T(p, "forwarded-by").innerText(), "Forwarded by Alba to Iris in MT-106", "back line");
  equal(await T(p, "mail-item").nth(1).getAttribute("data-ref"), "MT-101.2", "the marked mail");
  await T(p, "forwarded-by").tap();
  await T(p, "forwarded-from").waitFor();
  equal(new URL(p.url()).pathname, "/mail/MT-106.1", "lands on the forward");
});

it("Mail on the Mac: no count beside Mail in the sidebar", MAC, async (p) => {
  await open(p, "/mail/MT-101");
  await T(p, "mail-row").nth(6).waitFor();
  equal(await p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: "Mail" }).innerText(), "Mail", "no count beside Mail");
});

it("Mail on the Mac and sideways: j and k step to the next and previous thread", MAC, async (p) => {
  for (const width of [1512, 1133]) {
    await p.setViewportSize({ width, height: width === 1512 ? 982 : 744 });
    await open(p, "/mail/MT-101");
    await T(p, "mail-item").first().waitFor();
    await p.keyboard.press("j");
    await p.locator('[data-testid="mail-row"][aria-current="true"][data-id="MT-102"]').waitFor();
    equal(new URL(p.url()).pathname, "/mail/MT-102", "j at " + width);
    await p.keyboard.press("k");
    await p.locator('[data-testid="mail-row"][aria-current="true"][data-id="MT-101"]').waitFor();
    equal(new URL(p.url()).pathname, "/mail/MT-101", "k at " + width);
  }
});

it("Mail on the iPad upright: j steps no thread", { viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true }, async (p) => {
  await open(p, "/mail/MT-101");
  await T(p, "mail-item").first().waitFor();
  await p.keyboard.press("j");
  equal(new URL(p.url()).pathname, "/mail/MT-101", "no thread step");
});

it("Mail on the Mac: with Ask open, j steps no thread", MAC, async (p) => {
  await open(p, "/mail/MT-101");
  await T(p, "ask-MT-101").click();
  await p.locator('[data-pop="ask"]').waitFor();
  await p.keyboard.press("j");
  equal(new URL(p.url()).pathname, "/mail/MT-101", "no thread step");
});

const copiedByKey = async (p, route, ref, focus = null) => {
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, route);
    await T(p, "mail-item").first().waitFor();
    await p.evaluate(() => navigator.clipboard.writeText(""));
    if (focus) await T(p, focus).focus();
    await p.keyboard.press("c");
    await p.getByText("Copied " + ref, { exact: true }).waitFor();
    equal(await p.evaluate(() => navigator.clipboard.readText()), ref, "clipboard at " + width);
  }
};

it("Mail on the Mac and sideways: c copies the open thread's reference", MAC, (p) => copiedByKey(p, "/mail/MT-101", "MT-101"));

it("Mail on the Mac and sideways: c copies the reference of the mail that has focus", MAC, (p) => copiedByKey(p, "/mail/MT-101", "MT-101.2", "ask-MT-101.2"));

it("Mail on the Mac and sideways: c on the mail a link marked copies that mail's reference", MAC, (p) => copiedByKey(p, "/mail/MT-101.2", "MT-101.2"));

it("Mail on the Mac and sideways: a opens Ask for the open thread", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/mail/MT-101");
    await T(p, "mail-item").first().waitFor();
    await p.keyboard.press("a");
    equal(await p.locator('[data-pop="ask"]').getByRole("heading").innerText(), "Ask about MT-101", "title at " + width);
  }
});

it("Mail in a short Mac window and sideways: after scrolling to the end of the page the reference row stays at the top, and a opens Ask in view", MAC, async (p) => {
  const inView = (locator) => locator.evaluate((el) => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= window.innerHeight);
  for (const [width, height] of [[1512, 640], [1133, 744]]) {
    await p.setViewportSize({ width, height });
    await open(p, "/mail/MT-101");
    await T(p, "mail-item").first().waitFor();
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    equal(await inView(T(p, "mail-item").first()), false, "the first mail is off screen at " + width);
    equal(await inView(T(p, "ask-MT-101")), true, "the thread's Ask stays on screen at " + width);
    equal(await T(p, "ask-MT-101").evaluate((el) => el.getBoundingClientRect().top < 80), true, "the reference row sits at the top at " + width);
    await p.keyboard.press("a");
    const panel = p.locator('[data-pop="ask"]');
    await panel.waitFor();
    equal(await inView(panel), true, "the Ask panel is on screen at " + width);
  }
});

it("Mail on the Mac: Cmd+K opens Search and steps no thread", MAC, async (p) => {
  await open(p, "/mail/MT-101");
  await T(p, "mail-item").first().waitFor();
  await p.keyboard.press("Meta+k");
  await p.locator('[data-pop="search"]').waitFor();
  equal(new URL(p.url()).pathname, "/mail/MT-101", "path after Cmd+K");
});

it("Mail on the Mac and sideways: Esc in the thread goes back to its row", MAC, async (p) => {
  for (const width of [1512, 1133]) {
    await p.setViewportSize({ width, height: width === 1512 ? 982 : 744 });
    await open(p, "/mail/MT-101");
    await T(p, "copy-MT-101.2").focus();
    await p.keyboard.press("Escape");
    equal(await p.evaluate(() => document.activeElement?.getAttribute("data-id")), "MT-101", "focus on the thread's row at " + width);
  }
});

it("Mail on the Mac and sideways: Esc after j moves focus to the new thread's row", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/mail/MT-101");
    await T(p, "mail-item").first().waitFor();
    await p.keyboard.press("j");
    await p.locator('[data-testid="mail-row"][aria-current="true"][data-id="MT-102"]').waitFor();
    await p.keyboard.press("Escape");
    equal(await p.evaluate(() => document.activeElement?.getAttribute("data-id")), "MT-102", "focus on the new row at " + width);
  }
});

it("Mail on the Mac: j typed in Search mail stays text and steps no thread", MAC, async (p) => {
  await open(p, "/mail/MT-101");
  await T(p, "mail-search").focus();
  await p.keyboard.type("j");
  equal(await T(p, "mail-search").inputValue(), "j", "search text");
  equal(new URL(p.url()).pathname, "/mail/MT-101", "no thread step");
});

const mailActions = (p) => p.getByRole("toolbar", { name: "Mail actions" });
const threadActions = (p) => p.getByRole("toolbar", { name: "Thread actions" });
const targets = (p) => p.locator("[data-float] button, button[data-float], a:has(> [data-float])").evaluateAll((items) => items.map((item) => [Math.round(item.getBoundingClientRect().width), Math.round(item.getBoundingClientRect().height)]));

it("Mail on the phone: the list shows the menu toggle with its dot at the left, Search and More in one capsule at the right, and the Mail title below them", PHONE, async (p) => {
  await open(p, "/mail");
  await T(p, "mail-row").first().waitFor();
  const toggle = T(p, "menu-btn");
  equal(await toggle.getAttribute("data-float"), "toggle", "toggle part");
  await p.getByRole("button", { name: "Menu, new activity" }).waitFor();
  equal(await mailActions(p).getByRole("button").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))), ["Search", "More"], "capsule buttons");
  const [left, right, title] = [await toggle.boundingBox(), await mailActions(p).boundingBox(), await p.getByRole("heading", { level: 1, name: "Mail" }).boundingBox()];
  equal([left.x + left.width < 195, right.x > 195], [true, true], "toggle left, capsule right");
  equal(title.y >= right.y + right.height, true, "the title starts below the capsule");
  equal(await p.locator("header").count(), 0, "no solid header");
  equal((await targets(p)).filter(([width, height]) => width < 44 || height < 44), [], "small targets");
});

it("Mail on the phone: More on the list offers Add bot and Settings, and Add bot from More returns focus to More on Esc", PHONE, async (p) => {
  await open(p, "/mail");
  await T(p, "mail-row").first().waitFor();
  await mailActions(p).getByRole("button", { name: "More" }).click();
  const sheet = p.locator('[data-pop="more"]');
  await sheet.waitFor();
  equal(await sheet.getByTestId("more-item").allInnerTexts(), ["Add bot", "Settings"], "items");
  await sheet.getByRole("button", { name: "Add bot" }).click();
  await p.locator('[data-pop="add-bot"]').waitFor();
  await p.keyboard.press("Escape");
  await gone(p.locator('[data-pop="add-bot"]'));
  equal(await focusedId(p), "float-more", "focus");
});

it("Mail on the phone: a thread shows a round Back to Mail at the left, Ask a bot and More in one capsule at the right, and its reference row below them", PHONE, async (p) => {
  await open(p, "/mail/MT-101");
  await T(p, "mail-item").first().waitFor();
  const back = p.getByRole("link", { name: "Back to Mail", exact: true });
  equal(await back.locator("[data-float]").getAttribute("data-float"), "back", "round back");
  equal(await threadActions(p).getByRole("button").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))), ["Ask a bot", "More"], "capsule buttons");
  equal(await threadActions(p).getByRole("button", { name: "Ask a bot" }).innerText(), "Ask a bot", "words on the button");
  equal(await p.getByRole("link", { name: "Mail", exact: true }).count(), 0, "no text back link");
  const [left, right, row] = [await back.boundingBox(), await threadActions(p).boundingBox(), await T(p, "ask-MT-101").boundingBox()];
  equal([left.x + left.width < 195, right.x > 195], [true, true], "back left, capsule right");
  equal(row.y >= right.y + right.height, true, "the reference row starts below the capsule");
  equal((await targets(p)).filter(([width, height]) => width < 44 || height < 44), [], "small targets");
});

it("Mail on the phone: Ask a bot on the thread's top opens Ask about the thread", PHONE, async (p) => {
  await open(p, "/mail/MT-101");
  await threadActions(p).getByRole("button", { name: "Ask a bot" }).tap();
  equal(await p.locator('[data-pop="ask"]').getByRole("heading").innerText(), "Ask about MT-101", "title");
});

it("Mail on the phone: More on a thread offers Copy reference and Settings, and Copy reference says Copied with the thread's reference", PHONE, async (p) => {
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(p, "/mail/MT-101");
  await threadActions(p).getByRole("button", { name: "More" }).tap();
  const sheet = p.locator('[data-pop="more"]');
  await sheet.waitFor();
  equal(await sheet.getByTestId("more-item").allInnerTexts(), ["Copy reference", "Settings"], "items");
  await sheet.getByRole("button", { name: "Copy reference" }).tap();
  await p.getByRole("status").filter({ hasText: "Copied MT-101" }).waitFor();
  equal(await p.evaluate(() => navigator.clipboard.readText()), "MT-101", "clipboard");
});

it("Mail on the phone: More on a thread closes on Esc and returns focus to More", PHONE, async (p) => {
  await open(p, "/mail/MT-101");
  await threadActions(p).getByRole("button", { name: "More" }).click();
  const sheet = p.locator('[data-pop="more"]');
  await sheet.waitFor();
  await p.keyboard.press("Escape");
  await gone(sheet);
  equal(await focusedId(p), "float-more", "focus");
});

for (const size of [{ viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true }, { viewport: { width: 1024, height: 700 } }])
  it("Mail at " + size.viewport.width + " px keeps its header and shows no floating parts", size, async (p) => {
    await open(p, "/mail/MT-101");
    await T(p, "mail-item").first().waitFor();
    equal(await p.locator("header").filter({ hasText: "Mail" }).count(), 1, "Mail's header");
    equal(await p.locator("[data-float]").count(), 0, "floating parts");
  });

it("Mail: a removed bot's note shows once in a thread, on the first mail that has the bot", PHONE, async (p) => {
  await open(p, "/mail/MT-105");
  await T(p, "mail-item").nth(2).waitFor();
  equal(await T(p, "mail-item").evaluateAll((items) => items.map((item) => item.querySelectorAll('[data-testid="mail-removed-note"]').length)), [1, 0, 0], "notes per mail");
  equal(await T(p, "mail-removed-note").innerText(), "Mail kept, read only. Pib gets no new mail until it comes back and claims its name. Ask does not list Pib.", "words");
  await open(p, "/mail/MT-920?mailfx=MF-6");
  await T(p, "mail-item").nth(1).waitFor();
  equal(await T(p, "mail-item").evaluateAll((items) => items.map((item) => item.querySelectorAll('[data-testid="mail-removed-note"]').length)), [1, 0], "notes in a forward of a removed bot's mail");
});

it("Mail: with no mail at all the list says so with no rows", PHONE, async (p) => {
  await open(p, "/mail?mailfx=MF-7");
  equal(await T(p, "mail-empty").innerText(), "No mail yet. Your inbox and sent mail show here.", "words");
  equal(await T(p, "mail-row").count(), 0, "rows");
});

it("Mail on the Mac: with no mail at all the reading side says so once", MAC, async (p) => {
  await open(p, "/mail?mailfx=MF-7");
  equal(await T(p, "mail-empty").innerText(), "No mail yet. Your inbox and sent mail show here.", "words");
  equal(await T(p, "mail-empty").count(), 1, "said once");
  equal(await p.getByRole("region", { name: "Mail threads" }).getByTestId("mail-empty").count(), 0, "not in the list column");
});

it("Mail: a thread with no project shows no place line, in its row or under its subject", PHONE, async (p) => {
  const blanks = (row) => row.evaluate((el) => [...el.querySelectorAll("span")].filter((span) => !span.closest("[aria-hidden]") && span.textContent.trim() === "").length);
  const underSubject = () => p.locator("#mail-subject").evaluate((h) => (h.nextElementSibling?.querySelector('[data-testid="mail-bots"]') ? "the bots line" : (h.nextElementSibling?.textContent ?? "").trim()));
  await open(p, "/mail?mailfx=MF-9");
  await T(p, "mail-row").first().waitFor();
  equal(await blanks(T(p, "mail-row").first()), 0, "empty parts in the phone row");
  await open(p, "/mail/MT-930?mailfx=MF-9");
  await T(p, "mail-item").first().waitFor();
  equal(await underSubject(), "the bots line", "under the subject on the phone");
  await p.setViewportSize({ width: 1133, height: 744 });
  await open(p, "/mail/MT-930?mailfx=MF-9");
  await T(p, "mail-item").first().waitFor();
  equal(await blanks(T(p, "mail-row").first()), 0, "empty parts in the row sideways");
  equal(await underSubject(), "the bots line", "under the subject sideways");
  await open(p, "/mail/MT-101");
  await T(p, "mail-item").first().waitFor();
  equal(await underSubject(), "quarterdeck > Search", "MT-101 keeps its place line");
});

it("Mail: the mail a link opens carries a Linked mail mark, and no other mail does", PHONE, async (p) => {
  await open(p, "/mail/MT-101.2");
  await T(p, "mail-item").nth(3).waitFor();
  equal(await T(p, "mail-marked").evaluateAll((marks) => marks.map((mark) => [mark.closest('[data-testid="mail-item"]').getAttribute("data-ref"), mark.textContent])), [["MT-101.2", "Linked mail"]], "mark");
  await open(p, "/mail/MT-101");
  await T(p, "mail-item").nth(3).waitFor();
  equal(await T(p, "mail-marked").count(), 0, "no mark on a thread link");
});

const mailLoading = (p) => T(p, "mail-thread").getByRole("status", { name: "Loading" });
const threadFailed = (p) => T(p, "mail-thread").getByRole("alert").filter({ hasText: "Could not load this thread." });

it("Mail: while a thread's read is in flight its head and read-only line show, with loading bars in place of its mails", PHONE, async (p) => {
  await open(p, "/mail/MT-101?hold=mail-thread");
  await T(p, "mail-read-only").waitFor();
  equal([await mailLoading(p).count(), await T(p, "mail-item").count(), await p.locator("#mail-subject").count()], [1, 0, 1], "loading bars, mails and subject on the phone");
  await p.setViewportSize({ width: 1133, height: 744 });
  await open(p, "/mail?hold=mail-thread");
  await T(p, "mail-read-only").waitFor();
  equal([await mailLoading(p).count(), await T(p, "mail-item").count(), (await T(p, "mail-row").count()) > 0], [1, 0, true], "loading bars, mails and rows sideways");
});

it(
  "Mail: a failed thread read says Could not load this thread. with Retry, and Retry shows its mails",
  MAC,
  async (p) => {
    await open(p, "/mail/MT-101?fail=mail-thread");
    await p.locator('[data-testid="mail-item"], [data-testid="mail-thread"] [role="alert"]').first().waitFor();
    equal([await threadFailed(p).count(), await T(p, "mail-item").count(), await T(p, "mail-read-only").count()], [1, 0, 1], "failed line, mails and read-only line");
    await threadFailed(p).getByRole("button", { name: "Retry" }).click();
    await T(p, "mail-item").first().waitFor();
    equal([await threadFailed(p).count(), await mailLoading(p).count()], [0, 0], "failed line and loading bars after Retry");
  },
);

it("Mail: a thread with mails left out says so right above its first mail, and a link to a left-out mail scrolls to that line", PHONE, async (p) => {
  const inView = (locator) => locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight;
  });
  await open(p, "/mail/MT-941?mailfx=MF-10");
  await T(p, "mail-item").first().waitFor();
  equal(await T(p, "mail-omitted").allInnerTexts(), ["1 earlier mail not shown."], "one left out");
  await open(p, "/mail/MT-940?mailfx=MF-10");
  await T(p, "mail-item").first().waitFor();
  equal(await T(p, "mail-omitted").allInnerTexts(), ["3 earlier mails not shown."], "three left out");
  equal(await T(p, "mail-omitted").evaluate((line) => line.nextElementSibling?.querySelector('[data-testid="mail-item"]')?.dataset.ref ?? "not above the mails"), "MT-940.4", "the mail right below the line");
  const link = T(p, "mail-item").last().getByRole("link", { name: "MT-940.2" });
  await link.scrollIntoViewIfNeeded();
  equal(await inView(T(p, "mail-omitted")), false, "the line is off screen before the link");
  await link.tap();
  await p.waitForURL("**/mail/MT-940.2");
  await p
    .waitForFunction(() => {
      const box = document.querySelector('[data-testid="mail-omitted"]')?.getBoundingClientRect();
      return box !== undefined && box.top >= 0 && box.bottom <= innerHeight;
    }, null, { timeout: 5000 })
    .catch(() => {
      throw new Error("the left-out line is not on screen after the link to MT-940.2");
    });
  await open(p, "/mail/MT-101");
  await T(p, "mail-item").first().waitFor();
  equal(await T(p, "mail-omitted").count(), 0, "no line on a thread with none left out");
});

it("Mail: while the Mail list's read is in flight the screen shows loading bars and never No mail yet., and a failed list read says Could not load the Mail. with Retry", MAC, async (p) => {
  const nav = (p) => p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: "Mail" });
  const listFailed = (p) => p.locator("#main-scroll").getByRole("alert").filter({ hasText: "Could not load the Mail." });
  await open(p, "/queue?hold=mail-list");
  await T(p, "card-row").first().waitFor();
  await nav(p).click();
  await p.getByRole("heading", { level: 1, name: "Mail" }).waitFor();
  equal([await p.locator('#main-scroll [role="status"][aria-label="Loading"]').count(), await T(p, "mail-row").count(), await T(p, "mail-empty").count()], [1, 0, 0], "loading bars, rows and No mail yet. while the list is read");
  await open(p, "/queue?fail=mail-list");
  await T(p, "card-row").first().waitFor();
  await nav(p).click();
  await p.locator('[data-testid="mail-row"], #main-scroll [role="alert"]').first().waitFor();
  equal([await listFailed(p).count(), await T(p, "mail-row").count(), await T(p, "mail-empty").count()], [1, 0, 0], "failed line, rows and No mail yet.");
  await listFailed(p).getByRole("button", { name: "Retry" }).click();
  await T(p, "mail-row").first().waitFor();
  equal(await listFailed(p).count(), 0, "failed line after Retry");
});

it("Mail on the Mac and sideways: each row starts with the reference then the subject, has the bots and time on the next line, and the project and Lane below", MAC, async (p) => {
  for (const [width, height] of WIDE) {
    await p.setViewportSize({ width, height });
    await open(p, "/mail");
    await T(p, "mail-row").nth(6).waitFor();
    const rows = await T(p, "mail-row").evaluateAll((items) =>
      items.map((row) => {
        const middle = (box) => box.top + box.height / 2;
        const within = (inner, outer) => middle(inner) > outer.top && middle(inner) < outer.bottom;
        const code = row.querySelector("code").getBoundingClientRect();
        const subject = row.querySelector("b").getClientRects()[0];
        const bots = row.querySelector('[data-testid="mail-row-bots"]').getClientRects()[0];
        const time = row.querySelector("time").getBoundingClientRect();
        const place = [...row.querySelectorAll("span")].find((span) => span.childElementCount === 0 && span.textContent.includes(" > ")).getBoundingClientRect();
        return [row.getAttribute("data-id"), within(code, subject) && code.right <= subject.left, within(time, bots) && time.left >= bots.right, place.top >= bots.bottom - 1];
      }),
    );
    equal(rows.filter(([, first, second, third]) => !(first && second && third)), [], "rows out of the sketch at " + width);
  }
});

it("Page: Mission control opens in its frame", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-1");
  await p.frameLocator("iframe").getByText("Mission control: quarterdeck").waitFor();
});

it("Page: a Page that did not load says so and Try again loads it", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-1?fail=page");
  await shown(p, "This Page did not load.");
  await p.getByRole("button", { name: "Try again" }).tap();
  await p.frameLocator("iframe").getByText("Mission control: quarterdeck").waitFor();
});

it("Pages: the phone list shows each Page with its Lane, maker and age, Pinned first", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages");
  await T(p, "page-row").nth(1).waitFor();
  equal(await T(p, "pages-sub").innerText(), "2 Pages · Last updated first", "line");
  const rows = (await T(p, "page-row").allInnerTexts()).map((row) => row.replace(/\s+/g, " "));
  equal(rows, ["Mission control no Lane · Alba · 2m ago Live", "Search results layout Search · Dr. Kivo · 3h ago"], "rows");
});

it("Pages: the Mac table has Title, Lane, Made by, Updated and Visibility", MAC, async (p) => {
  await open(p, "/projects/quarterdeck/pages");
  await T(p, "pages-table").waitFor();
  equal(await T(p, "pages-table").locator("thead th").allInnerTexts(), ["Title", "Lane", "Made by", "Updated", "Visibility"], "columns");
  equal((await T(p, "page-row").first().locator("td").allInnerTexts()).slice(1), ["(no Lane)", "Alba", "2m ago", "Private"], "first row");
});

it("Pages: the Live filter narrows the list and the line says how many", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages");
  await T(p, "page-row").nth(1).waitFor();
  await T(p, "filter-btn").tap();
  await p.locator('[data-pop="filter-sheet"]').getByRole("radio", { name: "Live", exact: true }).tap();
  await p.locator('[data-pop="filter-sheet"]').getByRole("button", { name: "Done" }).tap();
  await shown(p, "1 of 2 Pages · Last updated first");
  equal(await T(p, "page-row").count(), 1, "rows");
});

it("Pages: a search with no match says so and Clear search and filters brings the rows back", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages");
  await p.getByPlaceholder("Search pages").fill("zebra");
  await shown(p, "No Pages match.");
  await p.getByRole("button", { name: "Clear search and filters" }).tap();
  await T(p, "page-row").nth(1).waitFor();
});

it("Pages: a Page with no Lane and no file is a normal row", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages?fixtures=pages");
  const row = p.locator('[data-testid="page-row"][data-id="PG-9"]');
  await row.waitFor();
  equal((await row.innerText()).replace(/\s+/g, " "), "Draft notes no Lane · Shelvorn · 1h ago", "row");
});

it("Pages: a failed load says so and offers Retry", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages?fail=list");
  await shown(p, "Could not load the Pages.");
  await p.getByRole("button", { name: "Retry" }).waitFor();
});

it("Pages: Retry after a failed load shows the list", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages?fail=list");
  await shown(p, "Could not load the Pages.");
  await p.getByRole("button", { name: "Retry" }).tap();
  await T(p, "page-row").nth(1).waitFor();
});

it("Pages: a project with no Pages says so", PHONE, async (p) => {
  await open(p, "/projects/dale-tools/pages");
  await shown(p, "No Pages in this project yet.");
  equal(await T(p, "page-row").count(), 0, "rows");
});

it("Pages: the list keeps its search when he opens a Page and comes back", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages");
  await p.getByPlaceholder("Search pages").fill("kivo");
  await shown(p, "1 of 2 Pages · Last updated first");
  await T(p, "page-row").tap();
  await T(p, "page-viewer").getByRole("link", { name: "Back to Pages", exact: true }).tap();
  await T(p, "pages-sub").waitFor();
  equal(await p.getByPlaceholder("Search pages").inputValue(), "kivo", "search");
});

it("Pages: the list keeps its filter when he opens a Page and comes back", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages");
  await T(p, "page-row").nth(1).waitFor();
  await T(p, "filter-btn").tap();
  await p.locator('[data-pop="filter-sheet"]').getByRole("radio", { name: "Live", exact: true }).tap();
  await p.locator('[data-pop="filter-sheet"]').getByRole("button", { name: "Done" }).tap();
  await shown(p, "1 of 2 Pages · Last updated first");
  await T(p, "page-row").tap();
  await T(p, "page-viewer").getByRole("link", { name: "Back to Pages", exact: true }).tap();
  await shown(p, "1 of 2 Pages · Last updated first");
});

it("Pages: the list keeps its sort when he opens a Page and comes back", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages");
  await T(p, "page-row").nth(1).waitFor();
  await T(p, "sort-btn").tap();
  await p.locator('[data-pop="sort-sheet"]').getByRole("radio", { name: "Title" }).tap();
  await p.locator('[data-pop="sort-sheet"]').getByRole("button", { name: "Done" }).tap();
  await shown(p, "2 Pages · Title, A to Z");
  await T(p, "page-row").first().tap();
  await T(p, "page-viewer").getByRole("link", { name: "Back to Pages", exact: true }).tap();
  await shown(p, "2 Pages · Title, A to Z");
});

it("Pages: a search kept for one project does not show in another project's list", MAC, async (p) => {
  await open(p, "/projects/quarterdeck/pages");
  await p.getByPlaceholder("Search pages").fill("zebra");
  await shown(p, "No Pages match.");
  await p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: "Projects" }).click();
  await projectRow(p, "heron-forge").click();
  await p.locator('[data-testid="all-pages"][href="/projects/heron-forge/pages"]').click();
  await T(p, "page-row").waitFor();
  equal(await p.getByPlaceholder("Search pages").inputValue(), "", "search");
});

it("Page: New tab opens the Page's own address in a new tab without the opener", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-2");
  const link = T(p, "new-tab");
  equal(await link.getAttribute("target"), "_blank", "target");
  equal(await link.getAttribute("rel"), "noopener noreferrer", "rel");
  equal(await link.getAttribute("href"), origin + "/projects/quarterdeck/pages/PG-2", "address");
});

it("Page: the frame is sealed, with no permissions and the file in srcdoc", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-1");
  const frame = T(p, "page-frame").locator("iframe");
  await frame.waitFor();
  equal(await frame.getAttribute("sandbox"), "", "sandbox");
  equal(await frame.getAttribute("allow"), null, "allow");
  equal(await frame.getAttribute("src"), null, "src");
  equal((await frame.getAttribute("srcdoc")) !== null, true, "srcdoc");
});

const PAGE_POLICY_REFUSAL = /violates the following Content Security Policy directive: "(?:default-src 'none'|img-src data:|media-src data:|font-src data:|style-src 'unsafe-inline')"/;
const CLOCK_IN_SEALED_FRAME = /Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set/;

async function hostilePage(p) {
  const requests = [];
  let recording = false;
  await p.context().route("**/*", async (route) => {
    const request = route.request();
    if (!recording && new URL(request.url()).origin === origin) return route.continue();
    requests.push({ url: request.url(), method: request.method(), cookie: Boolean((await request.allHeaders()).cookie) });
    await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Network escape</h1>" });
  });
  await open(p, "/projects/quarterdeck/pages/PG-1?fixtures=pages");
  await p.frameLocator("iframe").getByText("Mission control: quarterdeck").waitFor();
  await p.getByRole("link", { name: "Back to Pages", exact: true }).click();
  const row = p.locator('[data-testid="page-row"][data-id="PG-139"]');
  await row.waitFor();
  recording = true;
  await row.click();
  const iframe = T(p, "page-frame").locator("iframe");
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.waitForLoadState("load");
  return { frame, iframe, requests };
}

it("Page boundary: hostile HTML and CSS make no network requests or refresh navigation", PHONE, async (p) => {
  const { frame, requests } = await hostilePage(p);
  equal(requests, [], "requests reaching the network boundary");
  equal(frame.url(), "about:srcdoc", "frame remains on the Page");
  await frame.locator("#end-marker").waitFor();
}, PAGE_POLICY_REFUSAL);

for (const id of ["same-app-link", "external-link"]) {
  it("Page boundary: clicking " + id + " stays plain text without navigation or ping", PHONE, async (p) => {
    const { frame, requests } = await hostilePage(p);
    const link = frame.locator("#" + id);
    equal(await link.getAttribute("href"), null, "no destination");
    await link.click();
    equal(requests, [], "no clicked-link or ping request");
    equal(frame.url(), "about:srcdoc", "same Page after click");
    await frame.locator("#end-marker").waitFor();
  }, PAGE_POLICY_REFUSAL);
}

it("Page boundary: a hostile form is removed before it can be submitted", PHONE, async (p) => {
  const { frame, requests } = await hostilePage(p);
  equal(await frame.locator("form, [action], [formaction]").count(), 0, "no form or submission target");
  await frame.evaluate(() => document.querySelector("form")?.requestSubmit());
  equal(requests, [], "no form request");
  equal(frame.url(), "about:srcdoc", "same Page after submission attempt");
}, PAGE_POLICY_REFUSAL);

it("Page boundary: safe text, inline styles and a data image still render", PHONE, async (p) => {
  const { frame } = await hostilePage(p);
  const text = frame.locator("#safe-text");
  await text.waitFor({ state: "visible" });
  equal(await text.innerText(), "Self-contained content still renders.", "safe words");
  equal(await text.evaluate((el) => [getComputedStyle(el).fontWeight, getComputedStyle(el).fontStyle]), ["700", "italic"], "inline styles");
  equal(await frame.locator("#safe-image").evaluate(async (img) => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; }), [1, 1], "data image decoded");
}, PAGE_POLICY_REFUSAL);

it("Page boundary: the wrapper owns the first policy and suppresses referrers", PHONE, async (p) => {
  const { iframe, frame } = await hostilePage(p);
  equal(await iframe.getAttribute("referrerpolicy"), "no-referrer", "frame referrer policy");
  equal(await frame.locator("head > meta").first().getAttribute("http-equiv"), "Content-Security-Policy", "trusted policy first");
  equal(await frame.locator("meta[http-equiv]").count(), 1, "bot refresh and policy removed");
  equal(await frame.locator("meta[name=referrer]").first().getAttribute("content"), "no-referrer", "document referrer policy");
  equal(await frame.locator("base, iframe, frame, object, embed, portal, link, [href], [xlink\\:href], [ping], [srcset]").count(), 0, "navigation-bearing markup removed");
}, PAGE_POLICY_REFUSAL);

const SVG_ANIMATION_REFUSAL = new RegExp(PAGE_POLICY_REFUSAL.source + "|^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set[.]$");

async function animatedPage(p) {
  const opened = await hostilePage(p);
  await opened.frame.waitForFunction(() => {
    if (document.readyState !== "complete") return false;
    const svgs = [document.querySelector("#smil-probe"), document.querySelector("#smil-template-host")?.shadowRoot?.querySelector("svg")].filter(Boolean);
    return svgs.every((svg) => [...svg.querySelectorAll("set, animate")].every((animation) => {
      try {
        return svg.getCurrentTime() > animation.getStartTime();
      } catch (error) {
        if (error.name === "InvalidStateError") return false;
        throw error;
      }
    }));
  });
  return opened;
}

async function clickAnimatedLink(frame, requests, id) {
  const link = frame.locator("#" + id);
  const restored = await link.evaluate((el) => el.href?.animVal || el.getAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href") || null);
  const anyDestination = await frame.locator("a").evaluateAll((links) => links.some((el) => Boolean(el.href?.animVal || el.getAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href"))));
  await link.click();
  equal(requests, [], "no navigation after animated destination " + JSON.stringify(restored));
  equal(frame.url(), "about:srcdoc", "same Page after animated-link click");
  equal(anyDestination, false, "no static or animated link destination");
  await frame.locator("#end-marker").waitFor();
}

for (const id of ["smil-set-href", "smil-set-xlink", "smil-animate"]) {
  it("Page SVG animation: " + id + " cannot restore a clicked destination", PHONE, async (p) => {
    const { frame, requests } = await animatedPage(p);
    await clickAnimatedLink(frame, requests, id);
  }, SVG_ANIMATION_REFUSAL);
}

it("Page SVG animation: a rendered template cannot restore a clicked destination", PHONE, async (p) => {
  const { frame, requests } = await animatedPage(p);
  const link = frame.locator("#smil-template-link");
  if (await link.isVisible()) {
    console.log("info Page SVG animation: the declarative-shadow template renders normally");
    await clickAnimatedLink(frame, requests, "smil-template-link");
  } else {
    console.log("info Page SVG animation: the template is not rendered by the normal Page frame");
    equal(requests, [], "no request from the inert template");
    equal(frame.url(), "about:srcdoc", "inert template leaves the Page in place");
  }
}, SVG_ANIMATION_REFUSAL);

it("Page SVG animation: all five animation element names are absent, including template contents", PHONE, async (p) => {
  const { frame } = await animatedPage(p);
  const names = await frame.locator("svg *").evaluateAll((elements) => elements.map((el) => el.localName.toLowerCase()));
  const templateNames = await frame.locator("template").evaluateAll((templates) => templates.flatMap((template) => [...template.content.querySelectorAll("*")].map((el) => el.localName.toLowerCase())));
  equal([...names, ...templateNames].filter((name) => ["animate", "set", "animatemotion", "animatetransform", "discard"].includes(name)), [], "no declarative SVG animation in any root");
}, SVG_ANIMATION_REFUSAL);

it("Page: the failure line and Try again sit outside the frame", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-1?fail=page");
  await shown(p, "This Page did not load.");
  equal(await T(p, "page-frame").getByRole("button").count(), 0, "no button in the frame");
  equal(await T(p, "page-frame").getByText("This Page did not load.").count(), 0, "no message in the frame");
});

it("Page: a missing version says This Page did not load with the head in place", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-8?fixtures=pages");
  await shown(p, "This Page did not load.");
  equal((await T(p, "page-line").innerText()).replace(/\s+/g, " "), "Search · Dr. Kivo · updated 8:00 AM", "head line");
  await shown(p, "Bot-made Page");
});

it("Page: a Page with no file says No file yet and shows no frame", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-9?fixtures=pages");
  await T(p, "no-file").waitFor();
  equal(await T(p, "page-frame").count(), 0, "no frame");
});

it("Page: More on a Page with no file offers only Copy link", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-9?fixtures=pages");
  await T(p, "page-more").tap();
  await p.locator('[data-pop="page-sheet"]').getByRole("button", { name: "Copy link (Quarterdeck sign-in)" }).waitFor();
  equal(await T(p, "page-menu-items").locator("li").count(), 1, "items");
});

it("Page: More lists Copy link, Open in browser and Make public for a private Page", MAC, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-2");
  await T(p, "page-more").click();
  const menu = p.locator('[data-pop="page-menu"]');
  await menu.getByRole("button", { name: "Copy link (Quarterdeck sign-in)" }).waitFor();
  await menu.getByRole("link", { name: /^Open in browser/ }).waitFor();
  await menu.getByRole("button", { name: "Make public..." }).waitFor();
  equal(await T(p, "page-menu-items").locator("li").count(), 3, "items");
});

it("Page: More lists Copy public link and Make private for a public Page, and no Make public", MAC, async (p) => {
  await open(p, "/projects/heron-forge/pages/PG-3");
  await T(p, "page-more").click();
  const menu = p.locator('[data-pop="page-menu"]');
  await menu.getByRole("button", { name: "Copy public link" }).waitFor();
  await menu.getByRole("button", { name: "Make private" }).waitFor();
  equal(await T(p, "page-menu-items").locator("li").count(), 4, "items");
  equal(await menu.getByRole("button", { name: "Make public..." }).count(), 0, "no Make public");
});

it("Page: Make public shows the warnings and the private-data check, and Back changes nothing", MAC, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-2");
  await T(p, "page-more").click();
  await p.locator('[data-pop="page-menu"]').getByRole("button", { name: "Make public..." }).click();
  const confirm = T(p, "make-public-confirm");
  await confirm.getByText("Make version 2 public?", { exact: true }).waitFor();
  equal(await confirm.locator("li").allInnerTexts(), ["Anyone with the link can read and copy this exact version, without signing in.", "Not sent to search engines.", "Copies cannot be recalled."], "warnings");
  await confirm.getByText("No passwords, keys or private data found", { exact: true }).waitFor();
  await confirm.getByRole("button", { name: "Back" }).click();
  await gone(confirm);
  equal(await T(p, "public-panel").count(), 0, "still private");
});

it("Page: Make public publishes the current version and shows the public address", MAC, async (p) => {
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(p, "/projects/quarterdeck/pages/PG-2");
  await T(p, "page-more").click();
  await p.locator('[data-pop="page-menu"]').getByRole("button", { name: "Make public..." }).click();
  await T(p, "make-public").click();
  const panel = T(p, "public-panel");
  await panel.getByText("Public, version 2", { exact: true }).waitFor();
  const address = await panel.locator("code").innerText();
  equal(/^https:\/\/pages-public\.example\.com\/p\/[a-z2-7]{25}[aeimquy4]$/.test(address), true, "full random capability address");
  await panel.getByRole("button", { name: "Copy public link" }).click();
  await shown(p, "Copied public link");
  equal(await p.evaluate(() => navigator.clipboard.readText()), address, "copies exactly the shown address");
});

it("Page: Copy public link copies the public address", MAC, async (p) => {
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(p, "/projects/heron-forge/pages/PG-3");
  const address = await T(p, "public-panel").locator("code").innerText();
  equal(address, "https://pages-public.example.com/p/aaaqeayeaudaocajbifqydiob4", "public example's fixed sample");
  await T(p, "public-panel").getByRole("button", { name: "Copy public link" }).click();
  await shown(p, "Copied public link");
  equal(await p.evaluate(() => navigator.clipboard.readText()), address, "copies exactly the shown address");
});

it("Page: Make private says removal pending until the host confirms, then the Page is private", MAC, async (p) => {
  await p.clock.install();
  await open(p, "/projects/heron-forge/pages/PG-3");
  await T(p, "make-private").click();
  await T(p, "public-panel").getByText("Public, removal pending", { exact: true }).waitFor();
  await p.clock.runFor(3000);
  await gone(T(p, "public-panel"));
  await T(p, "page-more").click();
  await p.locator('[data-pop="page-menu"]').getByRole("button", { name: "Make public..." }).waitFor();
  await p.keyboard.press("Escape");
  await gone(p.locator('[data-pop="page-menu"]'));
  await T(p, "page-viewer").getByRole("link", { name: "Back to Pages", exact: true }).click();
  await T(p, "pages-table").waitFor();
  equal((await p.locator('[data-testid="page-row"][data-id="PG-3"] td').allInnerTexts()).slice(4), ["Private"], "visibility");
}, CLOCK_IN_SEALED_FRAME);

it("Page: a newer private version offers Update public version, which asks for that version", MAC, async (p) => {
  await open(p, "/projects/heron-forge/pages/PG-3");
  await T(p, "public-newer").getByText("Version 2 is newer and still private.", { exact: true }).waitFor();
  await T(p, "update-public").click();
  await T(p, "make-public-confirm").getByText("Make version 2 public?", { exact: true }).waitFor();
});

it("Page: confirming Update public version makes the public line read version 2", MAC, async (p) => {
  await open(p, "/projects/heron-forge/pages/PG-3");
  await T(p, "update-public").click();
  await T(p, "make-public").click();
  await T(p, "public-panel").getByText("Public, version 2", { exact: true }).waitFor();
  equal(await T(p, "public-newer").count(), 0, "newer line gone");
});

it("Page: a newer version shows Version 2 is ready while the text stays at version 1", PHONE, async (p) => {
  await open(p, "/projects/heron-forge/pages/PG-3");
  await T(p, "version-ready").getByText("Version 2 is ready.", { exact: true }).waitFor();
  await p.frameLocator("iframe").getByText("Version 1 · Shelvorn · Sun Nov 1, 3:00 PM ET · example data").waitFor();
});

it("Page: Show switches the frame to the newer version and the line goes", PHONE, async (p) => {
  await open(p, "/projects/heron-forge/pages/PG-3");
  await T(p, "version-ready").getByRole("button", { name: "Show" }).tap();
  await p.frameLocator("iframe").getByText("Version 2 · Shelvorn · Mon Nov 2, 9:35 AM ET · example data").waitFor();
  await gone(T(p, "version-ready"));
});

it("Page: after Show the Page opens at the newer version with no ready line", PHONE, async (p) => {
  await open(p, "/projects/heron-forge/pages/PG-3");
  await T(p, "version-ready").getByRole("button", { name: "Show" }).tap();
  await gone(T(p, "version-ready"));
  await T(p, "page-viewer").getByRole("link", { name: "Back to Pages", exact: true }).tap();
  await p.locator('[data-testid="page-row"][data-id="PG-3"]').tap();
  await p.frameLocator("iframe").getByText("Version 2 · Shelvorn · Mon Nov 2, 9:35 AM ET · example data").waitFor();
  equal(await T(p, "version-ready").count(), 0, "no ready line");
});

const focusOn = async (p, want) => {
  const nameOf = () => {
    const el = document.activeElement;
    return el === document.body ? "nothing" : (el.getAttribute("data-testid") ?? el.textContent.trim().slice(0, 40));
  };
  try {
    await p.waitForFunction((name) => {
      const el = document.activeElement;
      return el !== document.body && (el.getAttribute("data-testid") ?? el.textContent.trim().slice(0, 40)) === name;
    }, want);
  } catch {
    throw new Error("focus: got " + (await p.evaluate(nameOf)) + ", want " + want);
  }
};

const confirmFromMore = async (p, route) => {
  await open(p, route);
  await T(p, "page-more").click();
  await p.locator('[data-pop="page-menu"]').getByRole("button", { name: "Make public..." }).click();
  await T(p, "make-public-confirm").waitFor();
};

const confirmFromUpdate = async (p, route = "/projects/heron-forge/pages/PG-3") => {
  await open(p, route);
  await T(p, "update-public").click();
  await T(p, "make-public-confirm").waitFor();
};

const confirmBack = (p) => T(p, "make-public-confirm").getByRole("button", { name: "Back" });

it("Page: Make public from More moves focus to Back", MAC, async (p) => {
  await confirmFromMore(p, "/projects/quarterdeck/pages/PG-2");
  await focusOn(p, "Back");
});

it("Page: Update public version moves focus to Back", MAC, async (p) => {
  await confirmFromUpdate(p);
  await focusOn(p, "Back");
});

it("Page: Back on the Make public confirm returns focus to More", MAC, async (p) => {
  await confirmFromMore(p, "/projects/quarterdeck/pages/PG-2");
  await confirmBack(p).click();
  await gone(T(p, "make-public-confirm"));
  await focusOn(p, "page-more");
});

it("Page: Back on the Update public version confirm returns focus to Update public version", MAC, async (p) => {
  await confirmFromUpdate(p);
  await confirmBack(p).click();
  await gone(T(p, "make-public-confirm"));
  await focusOn(p, "update-public");
});

it("Page: Make public from More returns focus to More once the Page is public", MAC, async (p) => {
  await confirmFromMore(p, "/projects/quarterdeck/pages/PG-2");
  await T(p, "make-public").click();
  await T(p, "public-panel").getByText("Public, version 2", { exact: true }).waitFor();
  await focusOn(p, "page-more");
});

it("Page: a confirmed Update public version moves focus to the public panel", MAC, async (p) => {
  await confirmFromUpdate(p);
  await T(p, "make-public").click();
  await T(p, "public-panel").getByText("Public, version 2", { exact: true }).waitFor();
  await focusOn(p, "public-panel");
});

it("Page: Make private on the public panel moves focus to the public panel", MAC, async (p) => {
  await open(p, "/projects/heron-forge/pages/PG-3");
  await T(p, "make-private").click();
  await T(p, "public-panel").getByText("Public, removal pending", { exact: true }).waitFor();
  await focusOn(p, "public-panel");
});

it("Page: Make private from More moves focus to the public panel", MAC, async (p) => {
  await open(p, "/projects/heron-forge/pages/PG-3");
  await T(p, "page-more").click();
  await p.locator('[data-pop="page-menu"]').getByRole("button", { name: "Make private" }).click();
  await T(p, "public-panel").getByText("Public, removal pending", { exact: true }).waitFor();
  await focusOn(p, "public-panel");
});

const newerArrives = async (p) => {
  await p.clock.install();
  await open(p, "/projects/heron-forge/pages/PG-3?pagenext=60000");
  await T(p, "update-public").click();
  await T(p, "make-public-confirm").getByText("Make version 2 public?", { exact: true }).waitFor();
  await p.clock.runFor(60000);
};

it("Page: a newer version arriving while the confirm is open leaves it asking about the version it opened with", MAC, async (p) => {
  await newerArrives(p);
  const confirm = T(p, "make-public-confirm");
  await confirm.getByText("Version 3 is newer and still private.", { exact: true }).waitFor();
  equal(await confirm.getByText(/^Make version \d public\?$/).allInnerTexts(), ["Make version 2 public?"], "heading");
}, CLOCK_IN_SEALED_FRAME);

it("Page: Make public publishes the version the confirm asked about even when a newer one has arrived", MAC, async (p) => {
  await newerArrives(p);
  await T(p, "make-public-confirm").getByText("Version 3 is newer and still private.", { exact: true }).waitFor();
  await T(p, "make-public").click();
  await T(p, "public-panel").getByText("Public, version 2", { exact: true }).waitFor();
}, CLOCK_IN_SEALED_FRAME);

it("Page: Make version 3 public... asks again, this time about the newer version", MAC, async (p) => {
  await newerArrives(p);
  const confirm = T(p, "make-public-confirm");
  await confirm.getByRole("button", { name: "Make version 3 public..." }).click();
  await confirm.getByText("Make version 3 public?", { exact: true }).waitFor();
  equal(await confirm.getByText("Version 3 is newer and still private.", { exact: true }).count(), 0, "newer line gone");
}, CLOCK_IN_SEALED_FRAME);

it("Page: Make private closes the Make public confirm", MAC, async (p) => {
  await confirmFromUpdate(p);
  await T(p, "make-private").click();
  await gone(T(p, "make-public-confirm"));
});

it("Page: Make public refused while the public copy is being removed says why", MAC, async (p) => {
  await confirmFromUpdate(p, "/projects/heron-forge/pages/PG-3?delay=800");
  await T(p, "make-private").click();
  await T(p, "make-public").click();
  await T(p, "page-notice").waitFor();
  equal(await T(p, "page-notice").innerText(), "The public copy is still being removed.", "notice");
});

it("Page: Back on the Make public confirm clears the message about a failed publish", MAC, async (p) => {
  await confirmFromMore(p, "/projects/quarterdeck/pages/PG-2?fail=publish");
  await T(p, "make-public").click();
  await shown(p, "Not made public. Try again.");
  await confirmBack(p).click();
  await gone(T(p, "page-notice"));
});

it("Page: a Page does not open under another project's address", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-3");
  await shown(p, "This Page is not in the example data.");
  equal(await T(p, "page-viewer").count(), 0, "no viewer");
});

const topOf = (locator) => locator.first().evaluate((el) => el.getBoundingClientRect().top);

it("Page: the facts and marks sit above the frame, and New tab and More stay in the top", MAC, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-1");
  await T(p, "page-frame").waitFor();
  const frame = await topOf(T(p, "page-frame"));
  for (const id of ["page-line", "new-tab", "page-more"]) {
    const top = await topOf(T(p, id));
    equal(top < frame, true, id + " at " + top + ", frame at " + frame);
  }
  equal(await T(p, "page-frame").locator('[data-testid="page-line"]').count(), 0, "facts outside the frame");
});

it("Pages: with the Pages Add-on off a Page says Pages isn't set up, outside any frame", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages/PG-1?fail=pages-off");
  await T(p, "pages-off").getByText("This Quarterdeck has the Pages Add-on turned off.", { exact: true }).waitFor();
  equal(await T(p, "page-frame").count(), 0, "no frame");
});

it("Pages on a phone: Search opens from the top and Escape gives focus back to it", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/pages");
  await T(p, "page-row").first().waitFor();
  const search = p.getByRole("button", { name: "Search", exact: true });
  await search.tap();
  await p.locator('[data-pop="search"]').waitFor();
  await p.keyboard.press("Escape");
  await gone(p.locator('[data-pop="search"]'));
  equal(await search.evaluate((el) => el === document.activeElement), true, "focus back on Search");
});

const artifactParts = (p) =>
  p.evaluate(() => ["Artifacts", "Open Artifact"].map((name) => {
    const box = document.querySelector(`section[aria-label="${name}"]`).getBoundingClientRect();
    return { left: Math.round(box.left), top: Math.round(box.top) };
  }));

it("Artifacts on the Mac: the file list sits beside the open Artifact", MAC, async (p) => {
  await open(p, "/projects/quarterdeck/artifacts/AR-1");
  await T(p, "artifact-box").waitFor();
  const [list, reader] = await artifactParts(p);
  equal(list.left < reader.left && list.top < reader.top + 40 && reader.top < list.top + 40, true, JSON.stringify({ list, reader }));
});

it("Artifacts on a phone: the file list sits above the open Artifact", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/artifacts/AR-1");
  await T(p, "artifact-box").waitFor();
  const [list, reader] = await artifactParts(p);
  equal(list.top < reader.top, true, JSON.stringify({ list, reader }));
});

it("Artifact: the log shows with where it is stored and what uses it", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/artifacts/AR-1");
  await shown(p, "search-groups-test.log");
  await shown(p, "R2 bucket, key quarterdeck/logs/search-groups-test.log");
  await p.getByRole("link", { name: "How many results should each Search group show?", exact: true }).waitFor();
  await shown(p, "Read-only");
});

it("Artifact: a failed load says so and Retry loads it", PHONE, async (p) => {
  await open(p, "/projects/quarterdeck/artifacts/AR-1?fail=list");
  await shown(p, "Could not load this Artifact.");
  await p.getByRole("button", { name: "Retry" }).tap();
  await shown(p, "search-groups-test.log");
});

it("Frame: the phone menu opens the drawer, Esc closes it and focus returns to Menu", PHONE, async (p) => {
  await open(p, "/queue");
  await T(p, "menu-btn").tap();
  await p.locator('[data-pop="drawer"]').getByRole("button", { name: "Close the menu" }).waitFor();
  await p.keyboard.press("Escape");
  await gone(p.locator('[data-pop="drawer"]'));
  equal(await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "menu-btn", "focus");
});

for (const [where, size, menu] of [
  ["the Mac", MAC, false],
  ["a phone", PHONE, true],
  ["an iPad 1024 wide", { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true }, true],
])
  it("Frame on " + where + ": scrolling over the sidebar" + (menu ? " in the menu" : "") + " never moves the page behind it, at either end of the list", size, async (p) => {
    await open(p, "/chat/iris");
    await T(p, "chat-bot-message").first().waitFor();
    await frames(p, 3);
    if (menu) {
      await T(p, "menu-btn").click();
      await p.locator('[data-pop="drawer"]').waitFor();
    }
    const nav = p.locator(menu ? '[data-pop="drawer"]' : "aside").getByRole("navigation", { name: "Quarterdeck" });
    const box = await nav.boundingBox();
    const [start, long] = await p.evaluate(() => [Math.round(window.scrollY), document.documentElement.scrollHeight > window.innerHeight + 400]);
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (const step of [-1500, 1500, 1500, -1500]) {
      await p.mouse.wheel(0, step);
      await frames(p, 4);
    }
    equal([long, start > 0, await p.evaluate(() => Math.round(window.scrollY))], [true, true, start], "the page is long and starts below its top; after scrolling up and down over the sidebar it is where it was");
  });

it("Frame: Cmd+K opens Search, results come grouped, Esc closes it", MAC, async (p) => {
  await open(p, "/queue");
  await T(p, "card-row").first().waitFor();
  await p.keyboard.press("Meta+k");
  await T(p, "search-input").fill("search");
  await p.locator('[data-testid="search-group"][data-group="Task Cards"]').waitFor();
  await p.keyboard.press("Escape");
  await gone(p.locator('[data-pop="search"]'));
});

it("Search: a group with more than it shows offers See all, which shows the rest", MAC, async (p) => {
  await open(p, "/queue");
  await T(p, "card-row").first().waitFor();
  await p.keyboard.press("Meta+k");
  const chats = p.locator('[data-testid="search-group"][data-group="Chats"]');
  await chats.getByRole("button", { name: "See all, 3 more" }).click();
  equal(await chats.getByTestId("search-hit").count(), 5, "every chat");
});

it("Search: a Page comes up under Pages and opens in its project", MAC, async (p) => {
  await open(p, "/queue");
  await T(p, "card-row").first().waitFor();
  await p.keyboard.press("Meta+k");
  await T(p, "search-input").fill("runbook");
  await p.locator('[data-testid="search-group"][data-group="Pages"]').getByTestId("search-hit").first().click();
  await T(p, "page-viewer").waitFor();
  equal(new URL(p.url()).pathname, "/projects/heron-forge/pages/PG-3", "route");
});

it("Search: an Artifact comes up under Artifacts and opens in its project", MAC, async (p) => {
  await open(p, "/queue");
  await T(p, "card-row").first().waitFor();
  await p.keyboard.press("Meta+k");
  await T(p, "search-input").fill("search-groups-test");
  await p.locator('[data-testid="search-group"][data-group="Artifacts"]').getByTestId("search-hit").first().click();
  await shown(p, "search-groups-test.log");
  equal(new URL(p.url()).pathname, "/projects/quarterdeck/artifacts/AR-1", "route");
});

const BRASS = "rgb(232, 179, 93)";
const BRASS_INK = "rgb(28, 20, 8)";
const radios = (p) => T(p, "settings-appearance").getByRole("radio").evaluateAll((items) => items.map((item) => [item.textContent, item.getAttribute("aria-checked"), item.disabled]));

it("Settings on the Mac: the gear opens the Settings screen with its five sections, and Appearance offers System, Light and Dark", MAC, async (p) => {
  await open(p, "/queue");
  await T(p, "settings-btn").click();
  await T(p, "settings-appearance").waitFor();
  equal(new URL(p.url()).pathname, "/settings", "route");
  equal(await T(p, "settings-sections").getByRole("link").evaluateAll((links) => links.map((link) => link.firstElementChild.textContent)), ["Bots", "Appearance", "Add-ons", "Storage", "Account"], "sections");
  equal(
    await radios(p),
    [
      ["Systemfollows your device", "true", false],
      ["Light", "false", false],
      ["Dark", "false", false],
    ],
    "choices",
  );
});

it("Settings: Light applies at once with a toast and turns the screen light", MAC, async (p) => {
  await open(p, "/queue");
  await T(p, "settings-btn").click();
  await T(p, "settings-appearance").getByRole("radio", { name: /^Light$/ }).click();
  await shown(p, "Appearance: Light");
  equal((await radios(p)).map(([, checked]) => checked), ["false", "true", "false"], "checked");
  await p.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === "light");
});

const ACCOUNT = "Account: Captain";
const SIGNED_OUT = ["Signed out", "This device only.", "Sign in with Google"];
const accountMenu = (p) => p.locator('[data-pop="account-menu"]');
const signOutBox = (p) => p.locator('[data-pop="sign-out-confirm"]');
const focusedId = (p) => p.evaluate(() => document.activeElement?.getAttribute("data-testid"));
const pageLines = async (p) => (await p.locator("body").innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
const openDrawer = async (p, phone) => {
  if (!phone) return;
  await T(p, "menu-btn").click();
  await p.locator('[data-pop="drawer"]').waitFor();
};
const openAccountMenu = async (p, phone) => {
  await openDrawer(p, phone);
  await p.getByRole("button", { name: ACCOUNT }).click();
  await accountMenu(p).waitFor();
};
const signOutFromMenu = async (p, phone) => {
  await openAccountMenu(p, phone);
  await accountMenu(p).getByRole("button", { name: "Sign out" }).click();
  await signOutBox(p).getByRole("button", { name: "Sign out" }).click();
  await T(p, "signed-out").waitFor();
};
const SIGN_OUT_SIZES = [
  ["the Mac", MAC, false],
  ["a phone", PHONE, true],
];

for (const [name, size, phone] of SIGN_OUT_SIZES)
  it("Account on " + name + ": the Account row opens a menu with Settings and Sign out as the only pop-up, and Esc closes it with focus back on " + (phone ? "Menu" : "the row"), size, async (p) => {
    await open(p, "/queue");
    await openAccountMenu(p, phone);
    equal(await accountMenu(p).getByRole("button").allInnerTexts(), ["Settings", "Sign out"], "menu");
    equal(await p.locator("[data-pop]").count(), 1, "pop-ups open");
    await p.keyboard.press("Escape");
    await gone(accountMenu(p));
    equal(await focusedId(p), phone ? "menu-btn" : "account-btn", "focus");
  });

it("Account: Settings in the Account menu opens the Settings screen", MAC, async (p) => {
  await open(p, "/queue");
  await openAccountMenu(p, false);
  await accountMenu(p).getByRole("button", { name: "Settings" }).click();
  await T(p, "settings-screen").waitFor();
  equal([new URL(p.url()).pathname, await accountMenu(p).count()], ["/settings", 0], "route and menu");
});

it("Sign out: Settings > Account > Sign out opens the confirm, and Cancel changes nothing and returns focus to it", MAC, async (p) => {
  await open(p, "/settings/account");
  await T(p, "sign-out").click();
  equal(await signOutBox(p).getByRole("heading").innerText(), "Sign out of Quarterdeck?", "title");
  await signOutBox(p).getByText("Unsent drafts on this device are removed.", { exact: true }).waitFor();
  await signOutBox(p).getByRole("button", { name: "Cancel" }).click();
  await gone(signOutBox(p));
  equal([await focusedId(p), await T(p, "settings-screen").isVisible(), await T(p, "signed-out").count()], ["sign-out", true, 0], "focus, Settings open, still signed in");
});

for (const [name, size, phone] of SIGN_OUT_SIZES)
  it("Sign out on " + name + ": Esc on the confirm changes nothing and returns focus to " + (phone ? "Menu" : "the Account row"), size, async (p) => {
    await open(p, "/queue");
    await openAccountMenu(p, phone);
    await accountMenu(p).getByRole("button", { name: "Sign out" }).click();
    await signOutBox(p).waitFor();
    await p.keyboard.press("Escape");
    await gone(signOutBox(p));
    equal([await focusedId(p), await T(p, "signed-out").count()], [phone ? "menu-btn" : "account-btn", 0], "focus, still signed in");
  });

for (const [name, size, phone] of SIGN_OUT_SIZES)
  it("Sign out on " + name + ": Sign out from the Account menu leaves only Signed out on the page, with no sidebar, Queue, chat or Mail", size, async (p) => {
    await open(p, "/queue");
    await T(p, "card-row").first().waitFor();
    await signOutFromMenu(p, phone);
    equal([await pageLines(p), await p.getByRole("navigation").count()], [SIGNED_OUT, 0], "page");
  });

it("Sign out: Sign out from Settings leaves only Signed out on the page, with no sidebar, Queue, chat or Mail", PHONE, async (p) => {
  await open(p, "/mail");
  await T(p, "mail-row").first().waitFor();
  await openDrawer(p, true);
  await T(p, "settings-btn").click();
  await T(p, "sign-out").click();
  await signOutBox(p).getByRole("button", { name: "Sign out" }).click();
  await T(p, "signed-out").waitFor();
  equal([await pageLines(p), await p.getByRole("navigation").count()], [SIGNED_OUT, 0], "page");
});

it("Sign out: a chat draft typed before Sign out is gone after Sign in", PHONE, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-input").fill("Unsent words for Iris");
  await signOutFromMenu(p, true);
  await p.getByRole("button", { name: "Sign in with Google" }).click();
  await openDrawer(p, true);
  await T(p, "pinned-bot").and(p.locator('[data-id="iris"]')).click();
  await T(p, "chat-input").waitFor();
  equal(await T(p, "chat-input").inputValue(), "", "draft");
});

it("Sign out: Back after Sign out still shows only Signed out", PHONE, async (p) => {
  await open(p, "/projects");
  await openDrawer(p, true);
  await p.getByRole("navigation", { name: "Quarterdeck" }).getByRole("link", { name: "Mail" }).click();
  await T(p, "mail-row").first().waitFor();
  await signOutFromMenu(p, true);
  await p.goBack();
  await p.waitForFunction(() => location.pathname === "/projects");
  equal(await pageLines(p), SIGNED_OUT, "page after Back");
});

it("Sign out: Sign in with Google returns to the Queue", MAC, async (p) => {
  await open(p, "/mail");
  await signOutFromMenu(p, false);
  await p.getByRole("button", { name: "Sign in with Google" }).click();
  await shown(p, "· 10 waiting");
  equal(new URL(p.url()).pathname, "/queue", "route");
});

it("Sign out on a phone: the Queue opens at the top after Sign in, not where it was before Sign out", PHONE, async (p) => {
  await open(p, "/queue");
  await T(p, "card-row").first().waitFor();
  const last = T(p, "card-row").last();
  await last.scrollIntoViewIfNeeded();
  equal((await p.evaluate(() => window.scrollY)) > 0, true, "Queue scrolled");
  await signOutFromMenu(p, true);
  await p.getByRole("button", { name: "Sign in with Google" }).click();
  await T(p, "card-row").first().waitFor();
  await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  equal(await p.evaluate(() => window.scrollY), 0, "scroll");
});

it("Sign out: nothing the app stored is left, Appearance included", { ...MAC, colorScheme: "light" }, async (p) => {
  await open(p, "/queue");
  await T(p, "settings-btn").click();
  await p.getByRole("radio", { name: /^Dark$/ }).click();
  await p.waitForFunction(() => document.documentElement.getAttribute("data-appearance") === "dark");
  await signOutFromMenu(p, false);
  const stored = await p.evaluate(() => [localStorage, sessionStorage].flatMap((store) => Object.keys(store).filter((key) => key.startsWith("qd."))));
  equal([stored, await look(p)], [[], "light"], "stored keys and look");
});

it("Sign out: when Sign out fails the confirm stays open with its line, and Sign out again signs out", MAC, async (p) => {
  await open(p, "/queue?fail=sign-out");
  await openAccountMenu(p, false);
  await accountMenu(p).getByRole("button", { name: "Sign out" }).click();
  await signOutBox(p).getByRole("button", { name: "Sign out" }).click();
  await signOutBox(p).getByText("Sign-out did not reach Quarterdeck. Try again.", { exact: true }).waitFor();
  await signOutBox(p).getByRole("button", { name: "Sign out" }).click();
  equal(await T(p, "signed-out").getByRole("heading").innerText(), "Signed out", "signed out");
});

for (const [name, size, phone] of SIGN_OUT_SIZES)
  it("Sign out on " + name + ": every new target is at least 44 by 44 px", size, async (p) => {
    const small = async (locator) =>
      locator.evaluateAll((items) => items.filter((item) => item.getBoundingClientRect().width < 44 || item.getBoundingClientRect().height < 44).map((item) => item.textContent));
    await open(p, "/queue");
    await openAccountMenu(p, phone);
    const found = [...(await small(p.getByRole("button", { name: ACCOUNT }))), ...(await small(accountMenu(p).getByRole("button")))];
    await accountMenu(p).getByRole("button", { name: "Sign out" }).click();
    found.push(...(await small(signOutBox(p).getByRole("button"))));
    await signOutBox(p).getByRole("button", { name: "Sign out" }).click();
    await T(p, "signed-out").waitFor();
    found.push(...(await small(T(p, "signed-out").getByRole("button"))));
    equal(found, [], "targets under 44 px");
  });

it("Brass: the answer path is solid brass, and its ink reads at least 4.5 to 1", PHONE, async (p) => {
  await open(p, "/queue/alba-1");
  const send = await T(p, "send").evaluate((el) => {
    const style = getComputedStyle(el);
    return { fill: style.backgroundColor, image: style.backgroundImage, ink: style.color };
  });
  equal(send, { fill: BRASS, image: "none", ink: BRASS_INK }, "Send");
  const ratio = await p.evaluate(([a, b]) => {
    const lum = (rgb) => {
      const [r, g, bl] = rgb.match(/\d+/g).map((v) => {
        const c = Number(v) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }, [BRASS, BRASS_INK]);
  equal(ratio >= 4.5, true, "contrast " + ratio.toFixed(2) + " to 1");
});

it("Brass: the focus ring and the chat unread dot are the same solid brass", MAC, async (p) => {
  await open(p, "/queue");
  const dot = p.getByRole("img", { name: "Unread" }).first();
  equal(await dot.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage]), [BRASS, "none"], "unread dot");
  await T(p, "settings-btn").focus();
  await p.keyboard.press("Shift+Tab");
  await p.keyboard.press("Tab");
  equal(await p.evaluate(() => getComputedStyle(document.activeElement).outlineColor), BRASS, "focus ring");
});

const look = (p) => p.evaluate(() => document.documentElement.getAttribute("data-appearance"));

it("Look: with Appearance on System, the default, a light device shows the light look", { ...MAC, colorScheme: "light" }, async (p) => {
  await open(p, "/queue");
  equal(await look(p), "light", "light device");
});

it("Look: with Appearance on System, the look follows the device when it changes", { ...MAC, colorScheme: "light" }, async (p) => {
  await open(p, "/queue");
  await p.emulateMedia({ colorScheme: "dark" });
  await p.waitForFunction(() => document.documentElement.getAttribute("data-appearance") === "dark");
});

it("Look: Dark in Settings stays dark on a light device, after a reload too", { ...MAC, colorScheme: "light" }, async (p) => {
  await open(p, "/queue");
  await T(p, "settings-btn").click();
  await p.getByRole("radio", { name: /^Dark$/ }).click();
  await p.waitForFunction(() => document.documentElement.getAttribute("data-appearance") === "dark");
  await open(p, "/queue");
  equal(await look(p), "dark", "after reload");
});

const homeScreen = (p) =>
  p.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "standalone", { configurable: true, get: () => true });
    window.qdStandaloneAtBody = null;
    new MutationObserver((_, watch) => {
      if (!document.body) return;
      window.qdStandaloneAtBody = document.documentElement.hasAttribute("data-standalone");
      watch.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
const stripOf = (p) =>
  p.evaluate(() => {
    const strip = document.querySelector(".status-strip");
    if (!strip) return null;
    const style = getComputedStyle(strip);
    const box = strip.getBoundingClientRect();
    return {
      display: style.display,
      position: style.position,
      box: [box.left, box.top, box.width, box.height],
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      clip: style.backgroundClip,
      colour: style.backgroundColor === getComputedStyle(document.body).backgroundColor,
      above: Number(style.zIndex) > Number(getComputedStyle(document.querySelector('[data-testid="menu-btn"]').parentElement).zIndex),
    };
  });

const bubbleTones = (p) =>
  p.evaluate(() => {
    const read = (value) => value.match(/[\d.]+/g).map(Number);
    const light = ([r, g, b]) => {
      const part = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * part(r) + 0.7152 * part(g) + 0.0722 * part(b);
    };
    const ratio = (a, b) => {
      const [high, low] = [light(a), light(b)].sort((x, y) => y - x);
      return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100;
    };
    const tone = (name) => {
      const el = document.createElement("i");
      el.style.color = "var(--" + name + ")";
      document.body.append(el);
      const value = getComputedStyle(el).color;
      el.remove();
      return value;
    };
    const style = getComputedStyle(document.querySelector(".chat-bot-bubble"));
    const [back, ink, muted, inset, link] = [style.backgroundColor, style.color, tone("color-chat-bot-muted"), tone("color-chat-bot-inset"), tone("color-chat-bot-link")];
    return {
      colours: [back, ink, link],
      ratios: { ink: ratio(read(ink), read(back)), muted: ratio(read(muted), read(back)), link: ratio(read(link), read(back)), inkOnInset: ratio(read(ink), read(inset)), mutedOnInset: ratio(read(muted), read(inset)) },
    };
  });

it("Chat in the dark look: the bot bubble is dark with white text, brass links and muted words that stay readable", { ...MAC, colorScheme: "dark" }, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-bot-message").first().waitFor();
  const tones = await bubbleTones(p);
  equal(tones.colours, ["rgb(38, 38, 43)", "rgb(236, 236, 239)", "rgb(232, 179, 93)"], "bubble, text and link");
  const { ink, muted, link, inkOnInset, mutedOnInset } = tones.ratios;
  equal([ink >= 12, muted >= 6, link >= 7, inkOnInset >= 14, mutedOnInset >= 7], [true, true, true, true, true], JSON.stringify(tones.ratios));
});

it("Chat in the light look: the bot bubble keeps its pale colours and contrast", { ...MAC, colorScheme: "light" }, async (p) => {
  await open(p, "/chat/iris");
  await T(p, "chat-bot-message").first().waitFor();
  const tones = await bubbleTones(p);
  equal(tones.colours, ["rgb(232, 232, 227)", "rgb(37, 38, 42)", "rgb(101, 70, 0)"], "bubble, text and link");
  const { ink, muted, link } = tones.ratios;
  equal([ink >= 10, muted >= 5, link >= 5], [true, true, true], JSON.stringify(tones.ratios));
});

for (const look of ["dark", "light"])
  it("Chat in the " + look + " look: a keyboard focus ring inside a bot bubble is the bubble's link colour", { ...MAC, colorScheme: look }, async (p) => {
    await open(p, "/chat/iris");
    await T(p, "chat-bot-message").first().waitFor();
    let inside = false;
    for (let n = 0; n < 40 && !inside; n += 1) {
      await p.keyboard.press("Tab");
      inside = await p.evaluate(() => Boolean(document.activeElement?.closest(".chat-bot-bubble")));
    }
    equal(inside, true, "a Tab stop inside the bubble");
    const [ring, link] = await p.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(--color-chat-bot-link)";
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(document.activeElement).outlineColor, colour];
    });
    equal(ring, link, "the ring colour and the bubble's link colour");
  });

for (const look of ["dark", "light"])
  it("Home screen (" + look + "): in home-screen mode a full-width strip gives iOS the page colour at the top edge; it is set before the first paint, sits above the buttons, paints nothing and lets taps through", { ...PHONE, colorScheme: look }, async (p) => {
    await homeScreen(p);
    await open(p, "/queue");
    await T(p, "card-row").first().waitFor();
    equal(await p.evaluate(() => window.qdStandaloneAtBody), true, "home-screen flag when the body starts");
    equal(await stripOf(p), { display: "block", position: "fixed", box: [0, 0, 390, 11], opacity: "1", pointerEvents: "none", clip: "text", colour: true, above: true }, "strip");
    const top = { x: 0, y: 0, width: 390, height: 11 };
    const withStrip = await p.screenshot({ clip: top, animations: "disabled" });
    await p.evaluate(() => document.documentElement.removeAttribute("data-standalone"));
    equal((await stripOf(p)).display, "none", "strip without the flag");
    equal(Buffer.compare(withStrip, await p.screenshot({ clip: top, animations: "disabled" })), 0, "top of the screen with and without the strip");
    await p.evaluate(() => document.documentElement.setAttribute("data-standalone", ""));
    const menu = await T(p, "menu-btn").boundingBox();
    await p.touchscreen.tap(menu.x + menu.width / 2, 10);
    await p.locator('[data-pop="drawer"]').waitFor();
  });

it("Home screen: in a browser tab there is no home-screen flag and no strip", PHONE, async (p) => {
  await open(p, "/queue");
  await T(p, "card-row").first().waitFor();
  equal([await p.evaluate(() => document.documentElement.hasAttribute("data-standalone")), (await stripOf(p))?.display ?? "none"], [false, "none"], "flag and strip");
});

for (const [look, iris, alba] of [
  ["dark", "rgb(95, 207, 196)", "rgb(183, 156, 255)"],
  ["light", "rgb(13, 107, 99)", "rgb(106, 63, 192)"],
])
  it("Sidebar in the " + look + " look: each pinned bot's avatar shows its palette colour", { ...MAC, colorScheme: look }, async (p) => {
    await open(p, "/queue");
    const colour = (id) => T(p, "pinned-bot").and(p.locator(`[data-id="${id}"]`)).locator('span[aria-hidden="true"]').first().evaluate((el) => getComputedStyle(el).color);
    equal([await colour("iris"), await colour("alba")], [iris, alba], "avatar colours");
  });

const AVATAR = 'span[aria-hidden="true"].rounded-full';
const AVATAR_SIZES = { 18: "xs", 22: "sm", 28: "md", 36: "lg", 46: "xl" };
const AVATAR_ROUTES = ["/chat/dr-kivo", "/lanes/l-sea", "/lanes/l-set", "/chat/iris"];

const inkCentre = (p, inked, blank) =>
  p.evaluate(
    async ([inked, blank]) => {
      const pixels = async (png) => {
        const image = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0))], { type: "image/png" }));
        const pen = new OffscreenCanvas(image.width, image.height).getContext("2d");
        pen.drawImage(image, 0, 0);
        return { width: image.width, data: pen.getImageData(0, 0, image.width, image.height).data };
      };
      const [a, b] = [await pixels(inked), await pixels(blank)];
      const change = new Float32Array(a.data.length / 4);
      let most = 0;
      for (let i = 0; i < change.length; i++) {
        const j = i * 4;
        change[i] = Math.max(Math.abs(a.data[j] - b.data[j]), Math.abs(a.data[j + 1] - b.data[j + 1]), Math.abs(a.data[j + 2] - b.data[j + 2]));
        most = Math.max(most, change[i]);
      }
      if (!most) return null;
      let [left, right, top, bottom] = [Infinity, -Infinity, Infinity, -Infinity];
      for (let i = 0; i < change.length; i++) {
        if (change[i] < most / 2) continue;
        const [x, y] = [i % a.width, Math.floor(i / a.width)];
        [left, right, top, bottom] = [Math.min(left, x), Math.max(right, x + 1), Math.min(top, y), Math.max(bottom, y + 1)];
      }
      return { x: (left + right) / 2 / devicePixelRatio, y: (top + bottom) / 2 / devicePixelRatio };
    },
    [inked.toString("base64"), blank.toString("base64")],
  );

const avatarLetters = async (p) => {
  const measured = new Map();
  const measureShown = async () => {
    const avatars = p.locator(AVATAR);
    for (let i = 0, n = await avatars.count(); i < n; i++) {
      const avatar = avatars.nth(i);
      const { size, text, spill } = await avatar.evaluate((el, sizes) => {
        const size = el.checkVisibility() ? sizes[Math.round(el.getBoundingClientRect().width)] : undefined;
        const letters = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
        if (!size || !letters) return { text: el.textContent };
        const range = document.createRange();
        range.selectNodeContents(letters);
        const [laid, holder] = [range.getBoundingClientRect(), letters.parentElement.getBoundingClientRect()];
        return { size, text: el.textContent, spill: Math.max(holder.left - laid.left, laid.right - holder.right, 0) };
      }, AVATAR_SIZES);
      if (!size || measured.has(size + " " + text)) continue;
      await avatar.scrollIntoViewIfNeeded();
      const frame = await avatar.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit && (el.contains(hit) || hit.contains(el)) ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      });
      if (!frame) continue;
      const clip = { x: Math.floor(frame.x) - 2, y: Math.floor(frame.y) - 2, width: Math.ceil(frame.width) + 4, height: Math.ceil(frame.height) + 4 };
      const inked = await p.screenshot({ clip });
      await avatar.evaluate((el) => el.style.setProperty("-webkit-text-fill-color", "transparent"));
      const blank = await p.screenshot({ clip });
      await avatar.evaluate((el) => el.style.removeProperty("-webkit-text-fill-color"));
      const ink = await inkCentre(p, inked, blank);
      const hundredths = (value) => Math.round(value * 100) / 100;
      measured.set(size + " " + text, {
        size,
        text,
        across: ink && hundredths(clip.x + ink.x - frame.x - frame.width / 2),
        down: ink && hundredths(clip.y + ink.y - frame.y - frame.height / 2),
        spill: hundredths(spill),
      });
    }
  };
  for (const route of AVATAR_ROUTES) {
    await open(p, route);
    await p.locator(AVATAR).first().waitFor();
    await p.waitForFunction(() => !document.querySelector('[role="status"][aria-label="Loading"]') && !document.querySelector('[data-testid="chats-loading"]'));
    await p.waitForLoadState("networkidle");
    await measureShown();
    if (route !== AVATAR_ROUTES[0] || !(await T(p, "menu-btn").isVisible())) continue;
    await T(p, "menu-btn").tap();
    await p.locator('[data-pop="drawer"]').waitFor();
    await T(p, "pinned-bot").first().waitFor();
    await measureShown();
  }
  return [...measured.values()];
};

for (const [device, box] of [["a phone", PHONE], ["the Mac", MAC]])
  for (const look of ["dark", "light"])
    it("Avatar on " + device + " in the " + look + " look: one letter at every size and two letters at sm and lg sit within half a pixel of the frame's centre and inside the box that holds them", { ...box, deviceScaleFactor: 2, colorScheme: look }, async (p) => {
      const letters = await avatarLetters(p);
      const shown = (size, count) => letters.some((item) => item.size === size && item.text.length === count);
      equal(["xs", "sm", "md", "lg", "xl"].filter((size) => !shown(size, 1)), [], "sizes with no one-letter avatar measured");
      equal(["sm", "lg"].filter((size) => !shown(size, 2)), [], "sizes with no two-letter avatar measured");
      equal(letters.filter(({ across, down }) => across === null || Math.abs(across) > 0.5 || Math.abs(down) > 0.5), [], "letters more than half a pixel off the frame's centre");
      equal(letters.filter(({ spill }) => spill > 0.5), [], "letters laid out more than half a pixel outside the box that holds them");
    });

it("Look: the address cannot pick the look", { ...MAC, colorScheme: "dark" }, async (p) => {
  await open(p, "/queue?look=light");
  equal(await look(p), "dark", "look");
});

const INVITE_TEXT = "Join Quarterdeck: install the QD MCP 1.4.2 (checked by its sha256), then run qd join and give it the invite qd-example-7F3K-92QM.";
const addBot = (p) => p.locator('[data-pop="add-bot"]');
const inviteMade = async (p, name) => {
  await open(p, "/queue");
  await T(p, "add-bot-btn").click();
  await T(p, "bot-name").fill(name);
  await addBot(p).getByRole("button", { name: "Create invite" }).click();
  await T(p, "bot-prompt").waitFor();
};
const joinAsked = async (p, name) => {
  await p.clock.install();
  await inviteMade(p, name);
  await T(p, "invite-copy").click();
  await T(p, "bot-waiting").waitFor();
  await p.clock.runFor(4000);
  await T(p, "join-code").waitFor();
};

it("Add bot: Create invite is only ever a button, and once the invite is made the name step leaves", MAC, async (p) => {
  await open(p, "/queue");
  await T(p, "add-bot-btn").click();
  await T(p, "bot-name").waitFor();
  equal(await addBot(p).getByRole("button", { name: "Create invite" }).count(), 1, "Create invite before");
  await T(p, "bot-name").fill("Finch");
  await addBot(p).getByRole("button", { name: "Create invite" }).click();
  await T(p, "bot-prompt").waitFor();
  equal([await T(p, "bot-name-step").count(), await addBot(p).getByText("Create invite").count(), await addBot(p).getByText("Invite created").count()], [0, 0, 0], "name step, Create invite and a done line after");
});

it("Add bot: the made invite shows once as the flow draws it: Copy this invite now, the invite text, Copy and the waiting line", MAC, async (p) => {
  await inviteMade(p, "Finch");
  equal(await addBot(p).getByRole("heading").innerText(), "Copy this invite now", "title");
  await addBot(p).getByText("Works once, for 24 hours. Shown only now.", { exact: true }).waitFor();
  equal(await T(p, "bot-prompt").innerText(), INVITE_TEXT, "invite");
  equal(await T(p, "bot-waiting-line").innerText(), "Waiting for Finch to ask to join...", "waiting line");
});

it("Add bot: Copy puts the invite text on the clipboard, and the window waits for the bot", MAC, async (p) => {
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await inviteMade(p, "Finch");
  await T(p, "invite-copy").click();
  equal(await T(p, "bot-waiting").getByRole("heading").innerText(), "Waiting for Finch to ask to join...", "title");
  equal(await p.evaluate(() => navigator.clipboard.readText()), INVITE_TEXT, "clipboard");
  equal(await T(p, "bot-prompt").count(), 0, "invite text after Copy");
});

it("Add bot: once the bot asks, the window shows its request with the code to check", MAC, async (p) => {
  await joinAsked(p, "Finch");
  equal(await addBot(p).getByRole("heading").innerText(), "Finch wants to join", "title");
  equal(await T(p, "join-code").innerText(), "K7P4 2Q9M", "code");
  await addBot(p).getByText("Check your bot shows the same code.", { exact: true }).waitFor();
});

it("Add bot: Approve says the bot joined and offers Chat with it", MAC, async (p) => {
  await joinAsked(p, "Finch");
  await T(p, "join-approve").click();
  equal(await addBot(p).getByRole("heading").innerText(), "Finch joined.", "title");
  equal(await T(p, "joined-chat").innerText(), "Chat with Finch", "chat link");
  await T(p, "chat-row").and(p.locator('[data-id="finch"]')).waitFor();
});

it("Add bot: Refuse says the bot was not added", MAC, async (p) => {
  await joinAsked(p, "Finch");
  await T(p, "join-refuse").click();
  equal(await addBot(p).getByRole("heading").innerText(), "Refused. Finch was not added.", "title");
  equal(await T(p, "chat-row").and(p.locator('[data-id="finch"]')).count(), 0, "sidebar row");
});

it("Add bot: with Password to approve a bot on, Approve waits for the approval password", MAC, async (p) => {
  await p.clock.install();
  await open(p, "/settings/bots");
  await p.getByRole("switch", { name: "Password to approve a bot" }).click();
  await T(p, "add-bot-btn").click();
  await T(p, "bot-name").fill("Finch");
  await addBot(p).getByRole("button", { name: "Create invite" }).click();
  await T(p, "invite-copy").click();
  await p.clock.runFor(4000);
  const field = addBot(p).getByLabel("Approval password");
  await field.waitFor();
  equal(await T(p, "join-approve").isDisabled(), true, "Approve before the password");
  await field.fill("harbour-light");
  equal(await T(p, "join-approve").isDisabled(), false, "Approve with the password");
});

const queueActions = (p) => p.getByRole("toolbar", { name: "Queue actions" });
const floatingParts = (p) => p.locator("[data-float]");
const queueShown = async (p) => {
  await open(p, "/queue");
  await T(p, "card-row").first().waitFor();
};

it("Floating top: the phone Queue shows the menu toggle at the left, and Search and More in one capsule at the right", PHONE, async (p) => {
  await queueShown(p);
  const toggle = T(p, "menu-btn");
  equal(await toggle.getAttribute("data-float"), "toggle", "toggle part");
  equal(await queueActions(p).getByRole("button").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))), ["Search", "More"], "capsule buttons");
  const [left, right] = [await toggle.boundingBox(), await queueActions(p).boundingBox()];
  equal([left.x + left.width < 195, right.x > 195], [true, true], "toggle left, capsule right");
  equal(await p.locator("header").count(), 0, "no solid header");
});

it("Floating top: the toggle opens the menu, and Esc returns focus to the toggle", PHONE, async (p) => {
  await queueShown(p);
  await T(p, "menu-btn").click();
  await p.locator('[data-pop="drawer"]').waitFor();
  await p.keyboard.press("Escape");
  await gone(p.locator('[data-pop="drawer"]'));
  equal(await focusedId(p), "menu-btn", "focus");
});

it("Floating top: Search in the capsule opens Search, and Esc returns focus to Search", PHONE, async (p) => {
  await queueShown(p);
  await queueActions(p).getByRole("button", { name: "Search" }).click();
  await p.locator('[data-pop="search"]').waitFor();
  await p.keyboard.press("Escape");
  await gone(p.locator('[data-pop="search"]'));
  equal(await focusedId(p), "float-search", "focus");
});

it("Floating top: More offers Add bot and Settings, and Esc returns focus to More", PHONE, async (p) => {
  await queueShown(p);
  await queueActions(p).getByRole("button", { name: "More" }).click();
  const sheet = p.locator('[data-pop="more"]');
  await sheet.waitFor();
  equal(await sheet.getByTestId("more-item").allInnerTexts(), ["Add bot", "Settings"], "items");
  await p.keyboard.press("Escape");
  await gone(sheet);
  equal(await focusedId(p), "float-more", "focus");
});

it("Floating top: Add bot from More opens Add bot, and Esc returns focus to More", PHONE, async (p) => {
  await queueShown(p);
  await queueActions(p).getByRole("button", { name: "More" }).click();
  await p.locator('[data-pop="more"]').getByRole("button", { name: "Add bot" }).click();
  await addBot(p).waitFor();
  await p.keyboard.press("Escape");
  await gone(addBot(p));
  equal(await focusedId(p), "float-more", "focus");
});

it("Floating top: Settings from More opens the Settings screen, and Back returns to the Queue", PHONE, async (p) => {
  await queueShown(p);
  await queueActions(p).getByRole("button", { name: "More" }).click();
  await p.locator('[data-pop="more"]').getByRole("button", { name: "Settings" }).click();
  await T(p, "settings-screen").waitFor();
  equal(new URL(p.url()).pathname, "/settings", "route");
  await T(p, "float-back").click();
  await T(p, "card-row").first().waitFor();
  equal(new URL(p.url()).pathname, "/queue", "route after Back");
});

it("Floating top: every target on the phone Queue's floating top is at least 44 by 44 px", PHONE, async (p) => {
  await queueShown(p);
  const sizes = await p.locator("[data-float] button, button[data-float]").evaluateAll((items) => items.map((item) => [Math.round(item.getBoundingClientRect().width), Math.round(item.getBoundingClientRect().height)]));
  equal(sizes.length, 3, "targets");
  equal(sizes.filter(([width, height]) => width < 44 || height < 44), [], "small targets");
});

it("Floating top: while something is new the toggle shows its dot and says new activity", PHONE, async (p) => {
  await queueShown(p);
  await p.getByRole("button", { name: "Menu, new activity" }).waitFor();
  equal(await T(p, "menu-dot").count(), 1, "dot");
});

for (const size of [{ viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true }, { viewport: { width: 1024, height: 700 } }])
  it("Floating top: at " + size.viewport.width + " px the Queue keeps its header and shows no floating parts", size, async (p) => {
    await queueShown(p);
    equal(await p.locator("header").filter({ hasText: "Queue" }).count(), 1, "the Queue's header");
    equal(await floatingParts(p).count(), 0, "floating parts");
  });

const settingsShown = async (p, route) => {
  await open(p, route);
  await T(p, "settings-screen").waitFor();
};
const botIds = (p) => T(p, "bot-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-id")));
const pendingJoin = (p) => T(p, "pending-join");
const settingsSection = (p, name) => T(p, "settings-sections").getByRole("link", { name: new RegExp("^" + name) });

it("Settings on a phone: the gear in the menu opens the Settings screen, and Back returns to the Queue", PHONE, async (p) => {
  await queueShown(p);
  await openDrawer(p, true);
  await T(p, "settings-btn").click();
  await T(p, "settings-screen").waitFor();
  equal(await T(p, "float-back").getAttribute("aria-label"), "Back to Queue", "Back");
  await T(p, "float-back").click();
  await T(p, "card-row").first().waitFor();
  equal(new URL(p.url()).pathname, "/queue", "route after Back");
});

it("Settings on a phone: the floating top holds Back, Search and More, and More offers Add bot", PHONE, async (p) => {
  await settingsShown(p, "/settings");
  const actions = p.getByRole("toolbar", { name: "Settings actions" });
  equal(await actions.getByRole("button").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))), ["Search", "More"], "capsule buttons");
  await actions.getByRole("button", { name: "More" }).click();
  const sheet = p.locator('[data-pop="more"]');
  await sheet.waitFor();
  equal(await sheet.getByTestId("more-item").allInnerTexts(), ["Add bot"], "items");
});

const mailShown = async (p) => {
  await open(p, "/mail");
  await T(p, "mail-row").first().waitFor();
};
const settingsLeft = async (p, leave) => {
  await T(p, "settings-screen").waitFor();
  await p.evaluate(() => {
    window.settingsLeft = new Promise((done) => {
      const watch = new MutationObserver(() => {
        if (document.querySelector('[data-testid="settings-screen"]')) return;
        watch.disconnect();
        done([location.pathname, document.activeElement?.getAttribute("data-testid") ?? null]);
      });
      watch.observe(document.body, { childList: true, subtree: true });
    });
  });
  await leave();
  await gone(T(p, "settings-screen"));
  return p.evaluate(() => window.settingsLeft);
};

it("Settings on the Mac: Esc after the gear returns to the screen he came from, with focus on the gear", MAC, async (p) => {
  await mailShown(p);
  await T(p, "settings-btn").click();
  equal(await settingsLeft(p, () => p.keyboard.press("Escape")), ["/mail", "settings-btn"], "route and focus");
});

it("Settings on the Mac: Esc after Account > Settings returns to the screen he came from, with focus on the Account row", MAC, async (p) => {
  await mailShown(p);
  await openAccountMenu(p, false);
  await accountMenu(p).getByRole("button", { name: "Settings" }).click();
  equal(await settingsLeft(p, () => p.keyboard.press("Escape")), ["/mail", "account-btn"], "route and focus");
});

it("Settings on the Mac: Esc on a typed Settings address goes to the Queue, with focus on the gear", MAC, async (p) => {
  await settingsShown(p, "/settings/bots");
  equal(await settingsLeft(p, () => p.keyboard.press("Escape")), ["/queue", "settings-btn"], "route and focus");
});

it("Settings on the Mac: Esc on the Remove bot confirm closes only the confirm", MAC, async (p) => {
  await settingsShown(p, "/settings/bots/alba");
  await T(p, "remove-bot").click();
  const box = p.locator('[data-pop="remove-bot"]');
  await box.waitFor();
  await p.keyboard.press("Escape");
  await gone(box);
  equal([new URL(p.url()).pathname, await T(p, "settings-screen").count(), await focusedId(p)], ["/settings/bots/alba", 1, "remove-bot"], "route, screen and focus");
});

it("Settings on a phone: Back after the menu's gear is named for the screen he came from, returns there, and puts focus on Menu", PHONE, async (p) => {
  await mailShown(p);
  await openDrawer(p, true);
  await T(p, "settings-btn").click();
  await T(p, "settings-screen").waitFor();
  equal(await T(p, "float-back").getAttribute("aria-label"), "Back to Mail", "Back");
  equal(await settingsLeft(p, () => T(p, "float-back").click()), ["/mail", "menu-btn"], "route and focus");
});

it("Settings on a phone: Back after More > Settings returns to the Queue, with focus on Menu", PHONE, async (p) => {
  await queueShown(p);
  await queueActions(p).getByRole("button", { name: "More" }).click();
  await p.locator('[data-pop="more"]').getByRole("button", { name: "Settings" }).click();
  equal(await settingsLeft(p, () => T(p, "float-back").click()), ["/queue", "menu-btn"], "route and focus");
});

it("Settings on an iPad upright: Esc returns to the screen he came from, with focus on Menu", IPAD_UPRIGHT, async (p) => {
  await mailShown(p);
  await openDrawer(p, true);
  await T(p, "settings-btn").click();
  equal(await settingsLeft(p, () => p.keyboard.press("Escape")), ["/mail", "menu-btn"], "route and focus");
});

it("Settings on the Mac: Esc on a bot's page, after the gear from Mail, then Bots, then the bot, returns to Mail with focus on the gear", MAC, async (p) => {
  await mailShown(p);
  await T(p, "settings-btn").click();
  await T(p, "settings-screen").waitFor();
  await settingsSection(p, "Bots").click();
  await T(p, "bot-row").first().click();
  await T(p, "remove-bot").waitFor();
  equal(await settingsLeft(p, () => p.keyboard.press("Escape")), ["/mail", "settings-btn"], "route and focus");
});

it("Settings on a phone: after Bots, a bot and Back twice, the overview's Back still names the screen he came from", PHONE, async (p) => {
  await mailShown(p);
  await openDrawer(p, true);
  await T(p, "settings-btn").click();
  await T(p, "settings-screen").waitFor();
  await p.getByRole("link", { name: /^All bots/ }).click();
  await T(p, "bot-row").first().click();
  await T(p, "remove-bot").waitFor();
  await T(p, "float-back").click();
  await T(p, "bot-row").first().waitFor();
  await T(p, "float-back").click();
  await p.getByRole("link", { name: /^All bots/ }).waitFor();
  equal(await T(p, "float-back").getAttribute("aria-label"), "Back to Mail", "Back");
});

it("Settings: turning Password to approve a bot off and on again clears what was typed", MAC, async (p) => {
  await settingsShown(p, "/settings/bots");
  const password = p.getByRole("switch", { name: "Password to approve a bot" });
  await password.click();
  await pendingJoin(p).getByLabel("Approval password").fill("harbour-light");
  await password.click();
  await gone(pendingJoin(p).getByLabel("Approval password"));
  await password.click();
  equal(await pendingJoin(p).getByLabel("Approval password").inputValue(), "", "field after off and on");
});

it("Settings: the overview's All bots count is the count the Bots page shows", MAC, async (p) => {
  await settingsShown(p, "/settings");
  const overview = (await p.getByRole("link", { name: /^All bots/ }).innerText()).replace(/\D+/g, "");
  await settingsSection(p, "Bots").click();
  await T(p, "bot-row").first().waitFor();
  equal(overview, String(await T(p, "bot-row").count()), "All bots");
});

it("Settings: Approve on a pending join adds the bot to All bots and to the sidebar", MAC, async (p) => {
  await settingsShown(p, "/settings/bots");
  await pendingJoin(p).getByText("Quorl wants to join", { exact: true }).waitFor();
  await pendingJoin(p).getByRole("button", { name: "Approve" }).click();
  await shown(p, "No joins waiting.");
  equal((await botIds(p)).includes("quorl"), true, "All bots");
  await T(p, "chat-row").and(p.locator('[data-id="quorl"]')).waitFor();
});

it("Settings: Refuse on a pending join says Refused. Quorl was not added., and Quorl stays out of All bots", MAC, async (p) => {
  await settingsShown(p, "/settings/bots");
  await pendingJoin(p).getByRole("button", { name: "Refuse" }).click();
  await shown(p, "No joins waiting.");
  await shown(p, "Refused. Quorl was not added.");
  equal((await botIds(p)).includes("quorl"), false, "All bots");
});

it("Settings: with Password to approve a bot on, Approve waits for the approval password", MAC, async (p) => {
  await settingsShown(p, "/settings/bots");
  await p.getByRole("switch", { name: "Password to approve a bot" }).click();
  const field = pendingJoin(p).getByLabel("Approval password");
  await field.waitFor();
  const approve = pendingJoin(p).getByRole("button", { name: "Approve" });
  equal(await approve.isDisabled(), true, "Approve before the password");
  await field.fill("harbour-light");
  equal(await approve.isDisabled(), false, "Approve with the password");
});

it("Settings: the approval password is masked, not filled in by the browser, and kept nowhere in the page's storage", MAC, async (p) => {
  await settingsShown(p, "/settings/bots");
  await p.getByRole("switch", { name: "Password to approve a bot" }).click();
  const field = pendingJoin(p).getByLabel("Approval password");
  await field.fill("harbour-light");
  equal([await field.getAttribute("type"), await field.getAttribute("autocomplete")], ["password", "off"], "field");
  const kept = await p.evaluate(() => [localStorage, sessionStorage].flatMap((store) => Object.keys(store).map((key) => store.getItem(key) ?? "")).filter((value) => value.includes("harbour-light")));
  equal(kept, [], "stored values holding the password");
});

it("Settings: Remove bot asks first, and Cancel keeps the bot with focus back on Remove bot", MAC, async (p) => {
  await settingsShown(p, "/settings/bots/alba");
  await T(p, "remove-bot").click();
  const box = p.locator('[data-pop="remove-bot"]');
  equal(await box.getByRole("heading").innerText(), "Remove Alba?", "title");
  await box.getByText("Its mail is kept, read only. Only you can do this.", { exact: true }).waitFor();
  await box.getByRole("button", { name: "Cancel" }).click();
  await gone(box);
  equal(await focusedId(p), "remove-bot", "focus");
  await settingsSection(p, "Bots").click();
  await T(p, "bot-row").first().waitFor();
  equal((await botIds(p)).includes("alba"), true, "All bots");
});

it("Settings: Remove bot puts the bot under Removed, with its mail kept", MAC, async (p) => {
  await settingsShown(p, "/settings/bots/alba");
  await T(p, "remove-bot").click();
  await p.locator('[data-pop="remove-bot"]').getByRole("button", { name: "Remove bot" }).click();
  await p.waitForURL("**/settings/bots");
  await T(p, "removed-bot").filter({ hasText: "Alba" }).getByText(/mail kept, read only$/).first().waitFor();
  equal((await botIds(p)).includes("alba"), false, "All bots");
});

it("Settings: Cancel on an open invite ends it, and the joins history says so", MAC, async (p) => {
  await settingsShown(p, "/settings/bots");
  const lark = T(p, "open-invite").filter({ hasText: "for Lark" });
  await lark.getByRole("button", { name: "Cancel" }).click();
  await gone(lark);
  await shown(p, "Invite for Lark ended");
});

const cleanupBox = (p) => p.locator('[data-pop="cleanup"]');
const cleanupAsked = async (p) => {
  await settingsShown(p, "/settings/storage");
  await p.getByRole("switch", { name: "Remove files nobody opened for 30 days" }).click();
  await cleanupBox(p).waitFor();
};

it("Settings: turning on cleanup asks first, with what it would remove today", MAC, async (p) => {
  await cleanupAsked(p);
  equal(await cleanupBox(p).getByRole("heading").innerText(), "Turn on cleanup?", "title");
  equal(await T(p, "cleanup-count").innerText(), "Today this would remove 214 files, 1.1 GB, none opened since Oct 4.", "count");
});

it("Settings: See the list in the cleanup confirm lists the files it would remove", MAC, async (p) => {
  await cleanupAsked(p);
  await T(p, "cleanup-list").click();
  const items = T(p, "cleanup-files").locator("li");
  equal([await items.count(), await items.last().innerText()], [5, "and 210 more"], "list");
});

it("Settings: Turn on in the cleanup confirm turns cleanup on", MAC, async (p) => {
  await cleanupAsked(p);
  await cleanupBox(p).getByRole("button", { name: "Turn on" }).click();
  await gone(cleanupBox(p));
  equal(await p.getByRole("switch", { name: "Remove files nobody opened for 30 days" }).getAttribute("aria-checked"), "true", "switch");
});

const holdPart = async (p, marker) => {
  let release;
  const released = new Promise((resolve) => (release = resolve));
  await p.route("**/*.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes(marker)) await released;
    await route.fulfill({ response, body });
  });
  return release;
};

it("Sidebar on the phone: the menu opened before the sidebar's part arrives shows its frame and loading row with focus in the menu, then the rows", PHONE, async (p) => {
  const release = await holdPart(p, "pinned-bot");
  await queueShown(p);
  await T(p, "menu-btn").click();
  const drawer = p.locator('[data-pop="drawer"]');
  await drawer.getByTestId("sidebar-waiting").getByTestId("chats-loading").waitFor();
  equal(await drawer.evaluate((el) => el === document.activeElement), true, "focus on the menu while it waits");
  release();
  await drawer.getByTestId("pinned-bot").first().waitFor();
  equal(await drawer.evaluate((el) => el === document.activeElement), true, "focus on the menu after the rows");
});

it("Sidebar on the Mac: while the sidebar's part loads its frame holds the column, and the Queue's left edge stays put when the rows arrive", MAC, async (p) => {
  const release = await holdPart(p, "pinned-bot");
  await queueShown(p);
  const queueLeft = () => T(p, "card-row").first().evaluate((el) => el.getBoundingClientRect().left);
  const frame = p.locator("aside").getByTestId("sidebar-waiting");
  await frame.waitFor();
  const before = await queueLeft();
  const frameWidth = await frame.evaluate((el) => el.getBoundingClientRect().width);
  release();
  await p.locator("aside").getByTestId("pinned-bot").first().waitFor();
  equal(await queueLeft(), before, "the Queue's left edge");
  equal(await p.locator("aside nav").evaluate((el) => el.getBoundingClientRect().width), frameWidth, "the sidebar's width");
});

const failSidebar = async (p) => {
  let failing = true;
  await p.route("**/*.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (failing && body.includes("pinned-bot")) await route.abort();
    else await route.fulfill({ response, body });
  });
  return () => {
    failing = false;
  };
};

it(
  "Sidebar on the Mac: when the sidebar's part cannot load, its frame says so with Retry, the Queue's first row stays, and Retry shows the rows",
  MAC,
  async (p) => {
    const heal = await failSidebar(p);
    await queueShown(p);
    const failed = p.locator("aside").getByTestId("sidebar-failed");
    await failed.getByRole("button", { name: "Retry" }).waitFor();
    equal(await T(p, "card-row").first().isVisible(), true, "the Queue's first row");
    heal();
    await failed.getByRole("button", { name: "Retry" }).click();
    await p.locator("aside").getByTestId("pinned-bot").first().waitFor();
  },
  /net::ERR_FAILED|Failed to fetch dynamically imported module/,
);

it(
  "Sidebar on the phone: when the sidebar's part cannot load, the menu's frame says so with Retry, the Queue's first row stays, and Retry shows the rows",
  PHONE,
  async (p) => {
    const heal = await failSidebar(p);
    await queueShown(p);
    await T(p, "menu-btn").click();
    const drawer = p.locator('[data-pop="drawer"]');
    const failed = drawer.getByTestId("sidebar-failed");
    await failed.getByRole("button", { name: "Retry" }).waitFor();
    equal(await T(p, "card-row").first().isVisible(), true, "the Queue's first row");
    heal();
    await failed.getByRole("button", { name: "Retry" }).click();
    await drawer.getByTestId("pinned-bot").first().waitFor();
  },
  /net::ERR_FAILED|Failed to fetch dynamically imported module/,
);

const motionPage = () => ({
  prepare: (context) => context.route((url) => MAIL_PATH.test(url.pathname), (route) => route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not found"}' })),
  ignore: mailRefusal,
});
const motionCase = (name, size, steps) => it("Motion: " + name, size, (p) => motionPair(p, size, steps, motionPage()));
const shapesOf = (list) => [...new Set(list.map((one) => one.duration + " " + one.properties.join("+")))].sort();

motionCase("on a phone the leaving screen slides forward and back while the arriving screen fades in where it lands, a first visit never slides a blank, a tap during it lands as it would with Reduce Motion, and a system back does not move", PHONE, async (p, m) => {
  const places = () => Promise.all([T(p, "menu-btn").boundingBox(), T(p, "card-row").first().boundingBox()]);
  await open(p, "/queue");
  await T(p, "card-row").nth(9).waitFor();
  const still = await places();
  await watchBlank(p);
  await T(p, "card-row").nth(0).locator("a").tap();
  await T(p, "card-title").waitFor();
  await settle(p);
  const resume = await m.hold();
  await p.getByRole("link", { name: "Queue · 10 waiting", exact: true }).tap();
  await m.during("back to the Queue", "view-transition", async (running) => {
    equal([await moveOf(p), pseudos(running)], ["screen back live", ["::view-transition-old(root)"]], "only the leaving screen is a picture");
    equal(shapesOf(running.filter((one) => one.pseudo === "::view-transition-old(root)")), [STANDARD + " opacity+translate"], "the leaving screen slides back and fades at the standard speed");
    equal(running.filter((one) => !one.pseudo).map((one) => one.target + " " + one.duration + " " + one.properties.join("+")), ["main#main-scroll " + SCREEN + " opacity"], "the arriving screen only fades in where it lands, at the screen speed");
    const start = await places();
    await p.evaluate((at) => document.getAnimations().forEach((one) => (one.currentTime = at)), SCREEN / 2);
    equal([start, await places()], [still, still], "the arriving screen's top buttons and first row sit where they land, at the start and the middle of the change");
  });
  await T(p, "card-row").nth(1).locator("a").tap();
  await m.during("forward to the next card", "view-transition", async () => {
    equal([await moveOf(p), await p.locator("[data-motion-wait]").count()], ["screen forward live", 0], "forward, with the card in the new page, not the code-loading fallback");
  });
  await resume();
  await settle(p);
  equal([new URL(p.url()).pathname, await T(p, "card-title").innerText()], ["/queue/c2", QUEUE_ORDER[1]], "the tap during the change opened the second card");
  equal(await blankSeen(p), false, "no frame slid in the code-loading fallback");
  const starts = await viewTransitionCalls(p);
  await p.goBack();
  await T(p, "card-row").nth(9).waitFor();
  await frames(p);
  equal([await viewTransitionCalls(p), await runningAnimations(p)], [starts, []], "a system back starts no change and moves nothing");
  equal(await places(), still, "the Queue's top buttons and first row end where they started");
});

it("Motion: before the late motion part arrives, a screen change and a tap right after it are today's instant ones", PHONE, (page) =>
  motionPair(
    page,
    PHONE,
    async (p) => {
      await open(p, "/queue");
      await T(p, "card-row").nth(9).waitFor();
      await T(p, "card-row").nth(1).locator("a").tap();
      await T(p, "card-title").waitFor();
      equal([await viewTransitionCalls(p), await moveOf(p), await T(p, "card-title").innerText()], [0, null, QUEUE_ORDER[1]], "the card opens at once, with no screen change started and the page not marked");
      await p.getByRole("link", { name: "Queue · 10 waiting", exact: true }).tap();
      await T(p, "card-row").nth(2).locator("a").tap();
      await T(p, "card-title").getByText(QUEUE_ORDER[2], { exact: true }).waitFor();
      equal([new URL(p.url()).pathname, await viewTransitionCalls(p)], ["/queue/c1", 0], "a tap right after Back opened the third card at once");
    },
    { ...motionPage(), late: "held" },
  ),
);

for (const [where, size] of [["the Mac", MAC], ["an iPad sideways", TOUCH_SIDEWAYS]])
  motionCase("on " + where + " only the card pane moves when the card changes, a press in the list during it lands, and a section change only fades", size, async (p, m) => {
    const press = (locator) => (size === MAC ? locator.click() : locator.tap());
    await open(p, "/queue");
    await T(p, "card-pane").getByTestId("card-title").waitFor();
    await settle(p);
    const resume = await m.hold();
    await press(T(p, "card-row").nth(1).locator("a"));
    await m.during("the pane changes", "view-transition", async (running) => {
      equal([await moveOf(p), pseudos(running)], ["pane forward live", ["::view-transition-old(pane)"]], "only the leaving card is a picture");
      equal(running.filter((one) => !one.pseudo).map((one) => one.target + " " + one.duration + " " + one.properties.join("+")), ['div[data-testid="card-pane"] ' + SCREEN + " opacity"], "the arriving card fades in where it lands, and nothing in the list or the sidebar moves");
    });
    await press(T(p, "card-row").nth(2).locator("a"));
    await resume();
    await settle(p);
    equal([new URL(p.url()).pathname, await T(p, "card-row").nth(2).locator("a").getAttribute("aria-current")], ["/queue/c1", "true"], "the press during the change opened the third card");
    await T(p, "card-pane").getByText("No evidence attached", { exact: true }).waitFor();
    if (size !== MAC) return;
    const nav = p.getByRole("navigation", { name: "Quarterdeck" });
    await watchBlank(p);
    await nav.getByRole("link", { name: /^Mail/ }).click();
    await T(p, "mail-row").first().waitFor();
    await settle(p);
    await nav.getByRole("link", { name: /^Queue/ }).click();
    await T(p, "card-row").first().waitFor();
    await settle(p);
    const again = await m.hold();
    await nav.getByRole("link", { name: /^Mail/ }).click();
    await m.during("a section change", "view-transition", async (running) => {
      equal([await moveOf(p), pseudos(running)], ["screen fade live", ["::view-transition-old(root)"]], "the leaving screen fades, and the sidebar stays live and still");
      equal([...new Set(running.flatMap((one) => one.properties))], ["opacity"], "a section change only fades");
    });
    await again();
    await settle(p);
    equal(await blankSeen(p), false, "the first visit to Mail never slid in the code-loading fallback");
  });

for (const [where, size, leave, focus] of [
  ["the Mac", MAC, async (p) => {
    await T(p, "settings-sections").getByRole("link").first().focus();
    await p.keyboard.press("Escape");
  }, "settings-btn"],
  ["a phone", PHONE, (p) => T(p, "float-back").click(), "menu-btn"],
])
  motionCase("on " + where + " a screen change with motion keeps the Settings focus arrival: leaving Settings puts focus on " + focus + " while the screen changes, as with Reduce Motion", size, async (p, m) => {
    await mailShown(p);
    await openDrawer(p, size === PHONE);
    await T(p, "settings-btn").click();
    await T(p, "settings-screen").waitFor();
    await settle(p);
    const resume = await m.hold();
    await leave(p);
    await m.during("leaving Settings", "view-transition", async () => {
      equal([await moveOf(p), await focusedId(p)], ["screen fade live", focus], "focus has landed while the screen changes");
    });
    await resume();
    await settle(p);
    equal([new URL(p.url()).pathname, await focusedId(p)], ["/mail", focus], "route and focus once it settles");
  });

motionCase("loading to content: the bars go at once and the Queue list fades in once, at the standard speed", PHONE, async (p, m) => {
  await open(p, "/queue?delay=1500");
  await T(p, "queue-loading").waitFor();
  const resume = await m.hold();
  await T(p, "card-row").first().waitFor();
  await m.during("the rows land", '[data-testid="queue-list"]', async () => {
    equal(shapesOf(await animationsOf(T(p, "queue-list"))), [STANDARD + " opacity"], "the list fades in once, with no row moving on its own");
    equal(await T(p, "queue-loading").count(), 0, "the bars are gone at once, with nothing left fading over the rows");
  });
  await resume();
  await settle(p);
});

motionCase("on a phone an answer lands as a receipt that fades in on the next card while the answered card slides away to the left", PHONE, async (p, m) => {
  await open(p, "/queue");
  await T(p, "card-row").getByRole("link", { name: "How many results should each Search group show?" }).tap();
  await T(p, "option").nth(2).waitFor();
  await settle(p);
  await T(p, "option").first().tap();
  const resume = await m.hold();
  await T(p, "send").tap();
  await m.during("the answer lands", "view-transition", async () => {
    equal([await moveOf(p), await T(p, "got-it").count()], ["screen forward live", 1], "the answered card slides away and the next card is live with the receipt on it");
    equal(shapesOf(await animationsOf(T(p, "got-it"))), [STANDARD + " opacity"], "the receipt fades in at the standard speed");
  });
  await resume();
  await settle(p);
  await shown(p, "Got it: How many results should each Search group show, A, 10:00 AM");
});

motionCase("on the Mac the Send button presses in, the answered row folds out of the list, and the next card comes into the pane", MAC, async (p, m) => {
  await open(p, "/queue/alba-1");
  const pane = T(p, "card-pane");
  await pane.getByTestId("option").nth(2).waitFor();
  await settle(p);
  await pane.getByTestId("option").first().click();
  const resume = await m.hold();
  await pane.getByTestId("send").hover();
  await p.mouse.down();
  await m.during("the press", '[data-testid="send"]', async () => {
    equal(shapesOf(await animationsOf(pane.getByTestId("send"))), [QUICK + " scale"], "Send presses in at the quick speed");
  });
  await p.mouse.up();
  await m.during("the answer lands", "view-transition", async () => {
    equal(await moveOf(p), "pane forward live", "the next card comes into the pane");
    const row = await animationsOf(p.locator('[data-testid="card-row"][data-id="alba-1"]'));
    equal([row.length > 0, row.every((one) => one.duration === QUICK && one.properties.includes("height") && one.properties.includes("opacity"))], [true, true], "the answered row folds out at the quick speed");
  });
  await resume();
  await settle(p);
  equal(await p.locator('[data-testid="card-row"][data-id="alba-1"]').count(), 0, "the answered row has left the list");
});

motionCase("a refusal line shows within the quick speed, only fades, and never moves", PHONE, async (p, m) => {
  await open(p, "/queue/alba-1?fail=send");
  await T(p, "option").nth(2).waitFor();
  await settle(p);
  await T(p, "option").first().tap();
  const resume = await m.hold();
  await T(p, "send").tap();
  const line = T(p, "send-failed").getByRole("alert");
  await line.waitFor();
  const first = await line.boundingBox();
  await m.during("the refusal line", '[data-testid="send-failed"]', async () => {
    equal(shapesOf(await animationsOf(line)), [QUICK + " opacity"], "the line only fades, at the quick speed");
  });
  await resume();
  await settle(p);
  equal(await line.boundingBox(), first, "the line never moved");
});

motionCase("a sheet rises and fades in at the standard speed, a tap in it during that lands, and it leaves faster", PHONE, async (p, m) => {
  await open(p, "/queue");
  await T(p, "card-row").nth(9).waitFor();
  await settle(p);
  const resume = await m.hold();
  await T(p, "filter-btn").tap();
  const sheet = p.locator('[data-pop="filter-sheet"]');
  await sheet.waitFor();
  await m.during("the sheet opens", '[data-pop="filter-sheet"]', async () => {
    equal(shapesOf(await animationsOf(sheet)), [STANDARD + " opacity", STANDARD + " translate"], "the sheet rises and fades in");
  });
  await sheet.getByRole("button", { name: "Done" }).tap();
  await m.during("the sheet leaves", "[data-leaving]", async () => {
    equal(shapesOf(await animationsOf(p.locator("[data-leaving]"))), [QUICK + " opacity+translate"], "it leaves at the quick speed, with nothing in it fading back in");
  });
  await resume();
  await settle(p);
  equal(await sheet.count(), 0, "the sheet is gone");
});

motionCase("the Settings Sign out sheet rises and fades in at the standard speed like every sheet, and Cancel lets it leave faster", PHONE, async (p, m) => {
  await open(p, "/settings/account");
  await T(p, "sign-out").waitFor();
  await settle(p);
  const resume = await m.hold();
  await T(p, "sign-out").tap();
  const sheet = p.locator('[data-pop="sign-out-confirm"]');
  await sheet.waitFor();
  await m.during("the sheet opens", '[data-pop="sign-out-confirm"]', async () => {
    equal(shapesOf(await animationsOf(sheet)), [STANDARD + " opacity", STANDARD + " translate"], "the sheet rises and fades in");
  });
  await sheet.getByRole("button", { name: "Cancel" }).tap();
  await m.during("the sheet leaves", "[data-leaving]", async () => {
    equal(shapesOf(await animationsOf(p.locator("[data-leaving]"))), [QUICK + " opacity+translate"], "it leaves at the quick speed, with nothing in it fading back in");
  });
  await resume();
  await settle(p);
  equal([await sheet.count(), await T(p, "signed-out").count()], [0, 0], "the sheet is gone and he is still signed in");
});

motionCase("Whole card opens its parts with a fade and a small rise, the arrows turn at the quick speed, and Fold card closes at once", PHONE, async (p, m) => {
  await open(p, "/queue/alba-1");
  await T(p, "option").nth(2).waitFor();
  await settle(p);
  const resume = await m.hold();
  await T(p, "whole-card").tap();
  await m.during("Whole card opens", '[data-testid="task-card"] details', async () => {
    const shapes = shapesOf(await animationsOf(T(p, "task-card").locator("details")));
    equal(shapes, [QUICK + " rotate", STANDARD + " opacity", STANDARD + " translate"], "the parts fade and rise; the arrows turn");
  });
  await resume();
  await settle(p);
  await T(p, "whole-card").tap();
  await frames(p);
  equal(await animationsOf(T(p, "task-card").locator("details")), [], "Fold card closes at once");
});

motionCase("cards that arrive behind Show fade in where they land, with no slide, and only they move", PHONE, async (p, m) => {
  await open(p, "/queue?fixtures=late");
  await shown(p, "5 cards changed.");
  await settle(p);
  const resume = await m.hold();
  await T(p, "queue-changed").getByRole("button", { name: "Show" }).tap();
  await m.during("the rows arrive", '[data-testid="queue-list"]', async () => {
    const rows = await T(p, "card-row").evaluateAll((items) => items.map((item) => item.getAnimations().length));
    equal(rows.filter(Boolean).length, 5, "the five new rows move, and no other row");
    equal(shapesOf(await animationsOf(T(p, "queue-list"))), [STANDARD + " opacity"], "they only fade in, at the standard speed");
  });
  await resume();
  await settle(p);
  equal((await titles(p)).length, 15, "fifteen rows");
});

motionCase("a card closed elsewhere folds out of the Queue after Show, and no row slides", PHONE, async (p, m) => {
  await open(p, "/queue?closed=alba-1");
  await shown(p, "1 card changed.");
  await settle(p);
  const resume = await m.hold();
  await T(p, "queue-changed").getByRole("button", { name: "Show" }).tap();
  await m.during("the row leaves", '[data-testid="queue-list"]', async () => {
    const row = await animationsOf(p.locator('[data-testid="card-row"][data-id="alba-1"]'));
    equal([row.length > 0, row.every((one) => one.duration === QUICK && one.properties.includes("height") && one.properties.includes("opacity"))], [true, true], "the closed row folds out at the quick speed");
    equal((await animationsOf(T(p, "queue-list"))).filter((one) => one.properties.some((name) => ["translate", "transform"].includes(name))), [], "no row slides");
  });
  await resume();
  await settle(p);
  equal([(await titles(p)).length, await p.locator('[data-testid="card-row"][data-id="alba-1"]').count()], [9, 0], "nine rows, the closed one gone");
});

motionCase("on the Mac the card he reads never moves when the list changes under it", MAC, async (p) => {
  await open(p, "/queue?changed=2");
  const title = T(p, "card-pane").getByTestId("card-title");
  await title.waitFor();
  await shown(p, "2 cards changed.");
  await settle(p);
  const before = await title.boundingBox();
  await T(p, "queue-changed").getByRole("button", { name: "Show" }).click();
  await gone(T(p, "queue-changed"));
  await frames(p);
  equal([await moveOf(p), await animationsOf(T(p, "card-pane"))], [null, []], "no screen change, and nothing in the pane moves");
  await settle(p);
  equal(await title.boundingBox(), before, "the card's title stays where it was");
});

motionCase("on the Mac a bot that joins fades into the sidebar's Chats where it lands with no slide, and when it is removed its row folds out", MAC, async (p, m) => {
  const chats = T(p, "chats");
  const moving = () => chats.locator(":scope > li").evaluateAll((items) => items.map((item) => item.getAnimations({ subtree: true }).length));
  const finch = chats.locator(":scope > li").filter({ has: p.locator('[data-id="finch"]') });
  await joinAsked(p, "Finch");
  await settle(p);
  let resume = await m.hold();
  await T(p, "join-approve").click();
  await m.during("the new chat row lands", '[data-testid="chats"]', async () => {
    equal((await moving()).filter(Boolean).length, 1, "only the new row moves");
    equal(shapesOf(await animationsOf(chats)), [STANDARD + " opacity"], "it only fades in, at the standard speed");
  });
  await resume();
  await settle(p);
  await p.keyboard.press("Escape");
  await gone(addBot(p));
  await T(p, "settings-btn").click();
  await settingsSection(p, "Bots").click();
  await T(p, "bot-row").filter({ hasText: "Finch" }).click();
  await T(p, "remove-bot").click();
  const box = p.locator('[data-pop="remove-bot"]');
  await box.waitFor();
  await settle(p);
  resume = await m.hold();
  await box.getByRole("button", { name: "Remove bot" }).click();
  await m.during("the row leaves", '[data-testid="chats"]', async () => {
    const row = await animationsOf(finch);
    equal([row.length > 0, row.every((one) => one.duration === QUICK && one.properties.includes("height") && one.properties.includes("opacity"))], [true, true], "the removed bot's row folds out at the quick speed");
    equal((await animationsOf(chats)).filter((one) => one.properties.some((name) => ["translate", "transform"].includes(name))), [], "no row slides");
  });
  await resume();
  await settle(p);
  equal(await finch.count(), 0, "the removed bot's row is gone");
});

it("Preview: opening a card shows its loading bars, then the card", PHONE, async (p) => {
  const built = spawnSync(process.execPath, ["tools/build-app.mjs", "--preview"], { stdio: "inherit", timeout: 60_000 });
  if (built.status !== 0) throw new Error("preview build failed: " + (built.error?.message ?? built.status));
  await p.goto(new URL("./preview/index.html", import.meta.url).href + "#/queue");
  await T(p, "card-row").first().waitFor();
  await p.evaluate(() => {
    window.__qdBars = false;
    const look = () => {
      if (document.querySelector('[data-testid="card-loading"]')) window.__qdBars = true;
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await T(p, "card-row").first().locator("a").tap();
  await T(p, "option").first().waitFor();
  equal([await p.evaluate(() => window.__qdBars), await T(p, "card-loading").count()], [true, 0], "the loading bars showed, then the card replaced them");
});

const installSessionClock = (p) => p.clock.install({ time: new Date("2026-11-05T12:00:00Z") });

const tabVisibility = (p) =>
  p.addInitScript(() => {
    let state = "visible";
    Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => state });
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => state === "hidden" });
    window.qdVisibility = (next) => {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });

it("Server Queue: an expired session hides old cards, keeps local data, and Sign in goes to the sign-in page and comes back to a fresh list", PHONE, async (p) => {
  const built = spawnSync(process.execPath, ["tools/build-app.mjs", "--server"], { stdio: "inherit", timeout: 60_000 });
  if (built.status !== 0) throw new Error("server build failed: " + (built.error?.message ?? built.status));
  const body = JSON.parse(readFileSync(new URL("./src/data/server-payloads/list-added.json", import.meta.url), "utf8"));
  const oldTitle = body.projects[0].lanes[0].cards[0].title;
  let requests = 0;
  const headers = [];
  let logins = 0;
  await p.route("**/captain/login", (route) => {
    logins += 1;
    return route.fulfill({ status: 303, headers: { Location: "/" } });
  });
  await p.route("**/captain/cards", async (route) => {
    headers.push(route.request().headers());
    requests += 1;
    if (requests === 2) return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"sign in required"}' });
    if (requests > 2) body.projects[0].lanes[0].cards[0].title = "A fresh session's card";
    await route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: '"session-list"' }, body: JSON.stringify(body) });
  });
  await p.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() { super(); window.qdServerEvents = this; }
      close() {}
    };
    localStorage.setItem("qd.seen", '{"alba-1":"2026-11-02T15:00:00.000Z"}');
    localStorage.setItem("qd.settings", '{"appearance":"dark"}');
  });
  await installSessionClock(p);
  await open(p, "/queue");
  await shown(p, oldTitle);
  const kept = await p.evaluate(() => [localStorage.getItem("qd.seen"), localStorage.getItem("qd.settings")]);
  await p.evaluate(() => window.qdServerEvents.dispatchEvent(new MessageEvent("refresh", { data: '{"cards":true}' })));
  await p.clock.runFor(5_000);
  await shown(p, "Signed out");
  equal(await p.getByText(oldTitle, { exact: true }).count(), 0, "old title removed");
  equal(await T(p, "card-row").count(), 0, "old Queue removed");
  equal(await p.evaluate(() => [localStorage.getItem("qd.seen"), localStorage.getItem("qd.settings")]), kept, "local storage kept");
  await p.getByRole("button", { name: "Sign in with Google" }).click();
  await shown(p, "A fresh session's card");
  equal([logins, new URL(p.url()).pathname], [1, "/"], "the sign-in page, then back to the app");
  equal("if-none-match" in headers[2], false, "fresh sign-in has no old ETag");
  equal(await p.getByText(oldTitle, { exact: true }).count(), 0, "old title absent after sign-in");
}, /401 \(Unauthorized\)/);

it("Server Sign out: the confirm posts the list's token as the one field, csrf, to /captain/logout, and the page lands on /captain/signed-out", MAC, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const posts = [];
  await p.route("**/captain/logout", async (route) => {
    const request = route.request();
    posts.push([request.method(), request.headers()["content-type"], request.postData()]);
    await route.fulfill({ status: 303, headers: { Location: "/captain/signed-out" } });
  });
  await p.route("**/captain/signed-out", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Signed out</title>" }));
  await queueShown(p);
  await openAccountMenu(p, false);
  await accountMenu(p).getByRole("button", { name: "Sign out" }).click();
  await signOutBox(p).getByRole("button", { name: "Sign out" }).click();
  await p.waitForURL("**/captain/signed-out");
  equal(posts, [["POST", "application/x-www-form-urlencoded", "csrf=sample-csrf-token-not-real"]], "the sign-out form");
});

it("Server Queue: a refused native event stream checks the list and removes the expired session's cards", PHONE, async (p) => {
  const built = spawnSync(process.execPath, ["tools/build-app.mjs", "--server"], { stdio: "inherit", timeout: 60_000 });
  if (built.status !== 0) throw new Error("server build failed: " + (built.error?.message ?? built.status));
  const body = readFileSync(new URL("./src/data/server-payloads/list-added.json", import.meta.url), "utf8");
  const oldTitle = JSON.parse(body).projects[0].lanes[0].cards[0].title;
  let requests = 0;
  let refuseStream;
  const refused = new Promise((resolve) => { refuseStream = resolve; });
  await p.route("**/captain/events", async (route) => {
    await refused;
    await route.fulfill({ status: 401, contentType: "text/event-stream", body: "" });
  });
  await p.route("**/captain/cards", async (route) => {
    requests += 1;
    await route.fulfill(requests === 1
      ? { status: 200, contentType: "application/json", body }
      : { status: 401, contentType: "application/json", body: '{"error":"sign in required"}' });
  });
  await p.addInitScript(() => {
    window.EventSource = class extends EventSource {
      constructor(url) {
        super(url);
        this.addEventListener("error", () => console.log("qd-refused-native-error-" + this.readyState));
      }
    };
    localStorage.setItem("qd.seen", '{"alba-1":"2026-11-02T15:00:00.000Z"}');
    localStorage.setItem("qd.settings", '{"appearance":"dark"}');
  });
  await installSessionClock(p);
  await open(p, "/queue");
  await shown(p, oldTitle);
  const kept = await p.evaluate(() => [localStorage.getItem("qd.seen"), localStorage.getItem("qd.settings")]);
  const terminal = p.waitForEvent("console", { predicate: (message) => message.text() === "qd-refused-native-error-2" });
  refuseStream();
  await terminal;
  await p.clock.runFor(5_000);
  await shown(p, "Signed out");
  equal(requests, 2, "one list check after the stream error");
  equal(await p.getByText(oldTitle, { exact: true }).count(), 0, "old title removed");
  equal(await T(p, "card-row").count(), 0, "old Queue removed");
  equal(await p.evaluate(() => [localStorage.getItem("qd.seen"), localStorage.getItem("qd.settings")]), kept, "local storage kept");
}, /401 \(Unauthorized\)/);

const serverBuild = async (p, list) => {
  const built = spawnSync(process.execPath, ["tools/build-app.mjs", "--server"], { stdio: "inherit", timeout: 60_000 });
  if (built.status !== 0) throw new Error("server build failed: " + (built.error?.message ?? built.status));
  const body = readFileSync(new URL("./src/data/server-payloads/" + list, import.meta.url), "utf8");
  await p.route("**/captain/cards", (route) => route.fulfill({ status: 200, contentType: "application/json", body }));
  await p.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      close() {}
    };
  });
};
const rowLineParts = (p) =>
  T(p, "card-row").evaluateAll((rows) => rows.flatMap((row) => [...row.querySelectorAll("span.flex-wrap")].map((line) => [...line.children].map((part) => (part.getAttribute("aria-hidden") ? "·" : part.textContent.trim())))));

it("Server Queue with no priority: the rule reads by due then newest change, Sort has no Ranked entry, and rows show no empty pill, no Unblocks and no empty poster", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  await open(p, "/queue");
  await shown(p, "How many results should each Search group show?");
  equal(await T(p, "queue-rule").innerText(), "Ranked by due, then newest change", "rule line");
  equal(await T(p, "card-row").locator("[data-pill]").count(), 0, "priority pills in the rows");
  const lines = await rowLineParts(p);
  equal(lines.filter((parts) => parts.some((part) => part.startsWith("Unblocks"))), [], "row lines with Unblocks");
  equal(lines.filter((parts) => parts.includes("") || parts[0] === "·" || parts.at(-1) === "·"), [], "row lines with an empty part or a loose dot");
  await T(p, "sort-btn").click();
  const sheet = p.locator('[data-pop="sort-sheet"]');
  await sheet.waitFor();
  const sorts = await sheet.innerText();
  equal([sorts.includes("Ranked"), sorts.includes("Due soonest")], [false, true], "Sort entries: Ranked shown, Due soonest shown");
});

const cardRead = async (p, id, replies) => {
  const body = readFileSync(new URL("./src/data/server-payloads/card-open.json", import.meta.url), "utf8");
  const reads = [];
  await p.route("**/captain/cards/" + id, (route) => {
    const status = replies[reads.length] ?? 200;
    reads.push(status);
    return route.fulfill({ status, contentType: "application/json", body: status === 200 ? body : '{"error":"no"}' });
  });
  return reads;
};

it("Server Task Card: opening a card reads it once, its options show, and its head has no empty pill", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const reads = await cardRead(p, "alba-1", []);
  await open(p, "/queue/alba-1");
  await T(p, "option").nth(2).waitFor();
  equal(await T(p, "option").evaluateAll((rows) => rows.map((row) => row.dataset.letter)), ["A", "B", "C"], "option letters");
  equal(await T(p, "task-card").locator("[data-pill]").count(), 0, "priority pills on the Task Card");
  equal(reads, [200], "card reads");
});

it("Server Task Card: while its read is in flight the card shows the loading skeleton, with no Approve, Reject or options, and the options when it lands", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const body = readFileSync(new URL("./src/data/server-payloads/card-open.json", import.meta.url), "utf8");
  let land;
  const landed = new Promise((resolve) => (land = resolve));
  await p.route("**/captain/cards/alba-1", async (route) => {
    await landed;
    await route.fulfill({ status: 200, contentType: "application/json", body });
  });
  const asked = p.waitForRequest("**/captain/cards/alba-1");
  await open(p, "/queue/alba-1");
  await asked;
  await T(p, "card-loading").waitFor();
  equal([await T(p, "approve").count(), await T(p, "reject").count(), await T(p, "option").count(), await T(p, "ask").count()], [0, 0, 0, 0], "Approve, Reject, options and the approval ask while the read is in flight");
  land();
  await T(p, "option").nth(2).waitFor();
  equal([await T(p, "card-loading").count(), await T(p, "approve").count()], [0, 0], "skeleton and Approve once the read landed");
});

it(
  "Server Task Card: a failed read shows Could not load this Task Card. with Retry, and Retry reads it again and shows it",
  MAC,
  async (p) => {
    await serverBuild(p, "list-fixed-only.json");
    const reads = await cardRead(p, "alba-1", [503]);
    await open(p, "/queue/alba-1");
    const failed = p.getByRole("alert").filter({ hasText: "Could not load this Task Card." });
    await failed.waitFor();
    equal([await T(p, "option").count(), await T(p, "approve").count()], [0, 0], "options and Approve while the read failed");
    await failed.getByRole("button", { name: "Retry" }).click();
    await T(p, "option").nth(2).waitFor();
    equal(await failed.count(), 0, "failed line after Retry");
    equal(reads, [503, 200], "card reads");
  },
  /503 \(Service Unavailable\)/,
);

it("Server Task Card: when the list check its read starts fails, by a 503 or a dropped connection, the card shows Could not load this Task Card. with Retry, never the list's copy with Approve, and Retry checks the list again and shows it", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const reads = await cardRead(p, "alba-1", []);
  const list = readFileSync(new URL("./src/data/server-payloads/list-fixed-only.json", import.meta.url), "utf8");
  const failures = [];
  let fail = null;
  let after = 0;
  await p.route("**/captain/cards", (route) => {
    if (!fail || reads.length <= after) return route.fulfill({ status: 200, contentType: "application/json", body: list });
    failures.push(fail);
    const form = fail;
    fail = null;
    return form === "dropped" ? route.abort() : route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"no"}' });
  });
  for (const form of ["503", "dropped"]) {
    fail = form;
    after = reads.length;
    await open(p, "/queue/alba-1");
    const failed = p.getByRole("alert").filter({ hasText: "Could not load this Task Card." });
    await failed.or(T(p, "approve")).first().waitFor();
    equal([await T(p, "approve").count(), await T(p, "reject").count(), await failed.count()], [0, 0, 1], form + ": Approve, Reject and the failed line once the list check failed");
    await failed.getByRole("button", { name: "Retry" }).click();
    await T(p, "option").nth(2).waitFor();
    equal([await failed.count(), await T(p, "approve").count()], [0, 0], form + ": failed line and Approve after Retry");
  }
  equal([reads, failures], [[200, 200], ["503", "dropped"]], "card reads (one per open; Retry checks the list, the card is already read) and failed list checks");
}, /503 \(Service Unavailable\)|net::ERR_FAILED/);

it("Server Task Card: a 403 on the card's read signs out", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const reads = await cardRead(p, "alba-1", [403]);
  await open(p, "/queue/alba-1");
  await shown(p, "Signed out");
  equal(await p.getByText("Could not load this Task Card.", { exact: true }).count(), 0, "failed line");
  equal(reads, [403], "card reads");
}, /403 \(Forbidden\)/);

it("Server Settings: the Bots page says Approve new bots in the approval app for now. as a plain line, with no alert, no button and no link, until the server has a bots API", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  await open(p, "/settings/bots");
  const line = p.getByText("Approve new bots in the approval app for now.", { exact: true });
  await line.waitFor();
  equal([await p.getByRole("alert").count(), await line.locator("xpath=..").getByRole("button").count(), await line.locator("xpath=..").getByRole("link").count(), await p.getByText("Could not load the bots.").count()], [0, 0, 0, 0], "alerts, buttons and links around the line, and the old words");
});

const BOTS_FRESH = Date.parse("2026-11-05T12:00:00Z") / 1000 + 3600;
const botsSample = (name) => JSON.parse(readFileSync(new URL("./src/data/server-payloads/bots/" + name, import.meta.url), "utf8"));
const botsList = (csrf = "t-list-1", change = (raw) => raw) => change({ ...botsSample("list-200.json"), csrf, freshUntil: BOTS_FRESH });
const BOTS_NAME_WORDS = "A bot name starts with a letter and uses a to z, 0 to 9 and hyphens, up to 32 characters.";
const serverBots = async (p, { lists = [botsList()], posts = {} } = {}) => {
  const asked = { reads: 0, posts: [] };
  await p.route((url) => url.pathname === "/captain/api/bots", (route) => {
    const answer = lists[Math.min(asked.reads, lists.length - 1)];
    asked.reads += 1;
    return typeof answer === "function" ? answer(route) : chatReply(route, 200, answer);
  });
  await p.route((url) => url.pathname.startsWith("/captain/api/bots/"), (route) => {
    const path = new URL(route.request().url()).pathname.slice("/captain/api/bots/".length);
    asked.posts.push([path, JSON.parse(route.request().postData())]);
    const answer = posts[path]?.[asked.posts.filter(([one]) => one === path).length - 1];
    return answer ? answer(route) : chatReply(route, 200, { csrf: "t-done-" + asked.posts.length, freshUntil: BOTS_FRESH });
  });
  return asked;
};
const stepUpPage = (p) => p.route((url) => url.pathname === "/captain/step-up", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>Fresh sign-in</p>" }));

for (const [where, size] of [["a phone", PHONE], ["the Mac", MAC]])
  it("Server Bots on " + where + ": a join request shows who invited it, when it asked, its code in two parts and its time left, with Refuse and the words Approve in the approval app for now. and no Approve, password field or link; the history and the password row stay in the approval app", size, async (p) => {
    await serverBuild(p, "list-fixed-only.json");
    await serverBots(p);
    await installSessionClock(p);
    await open(p, "/settings/bots");
    const join = T(p, "pending-join").filter({ hasText: "tarn wants to join" });
    await join.waitFor();
    equal([await join.getByRole("button", { name: "Refuse", exact: true }).count(), await join.getByRole("button", { name: "Approve", exact: true }).count(), await join.locator("input").count(), await join.getByText("Approve in the approval app for now.", { exact: true }).count(), await join.getByRole("link").count()], [1, 0, 0, 1, 0], "Refuse, Approve, a password field, the words and a link in the request");
    const said = await join.innerText();
    equal(["invited by you", "6:58 AM", "K7P4 2Q9M", "ends in 8 min"].filter((part) => !said.includes(part)), [], "parts missing from the request");
    equal(await T(p, "pending-join").count(), 2, "requests");
    const invite = await T(p, "open-invite").first().innerText();
    equal(["for tarn", "by you", "ends in 23 h"].filter((part) => !invite.includes(part)), [], "parts missing from the first invite");
    equal([await p.getByText("Password to approve a bot").count(), await p.getByText("Joins history is in the approval app for now.", { exact: true }).count(), await T(p, "bots-add").count()], [0, 1, 1], "the password row, the history line and Add bot");
    equal(await T(p, "bot-row").evaluateAll((rows) => rows.map((row) => row.dataset.id)), ["iris", "alba", "dale"], "bots");
  });

it("Server Bots with chat on: All bots lists each bot once, by the chat list's name when it has one and by the bots list's name otherwise", MAC, async (p) => {
  await serverBuildChat(p, { rows: () => chatPayload("rows.json").map((row) => (row.bot.id === "iris" ? { ...row, bot: { ...row.bot, name: "Iris" } } : row)) });
  await serverBots(p, { lists: [botsList("t-list-1", (raw) => ({ ...raw, joined: [{ id: "iris", name: "iris-from-bots" }, { id: "alba", name: "alba" }, { id: "nova", name: "Nova" }] }))] });
  await installSessionClock(p);
  await open(p, "/settings/bots");
  await T(p, "bot-row").nth(3).waitFor();
  const rows = await T(p, "bot-row").evaluateAll((list) => list.map((row) => [row.dataset.id, row.querySelector("b")?.firstChild?.textContent ?? ""]));
  equal([...rows].sort(), [["alba", "alba"], ["dale", "dale"], ["iris", "Iris"], ["nova", "Nova"]], "bots and their names");
});

it("Server Bots: a bots list that answers 404 shows only Approve new bots in the approval app for now.", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  await serverBots(p, { lists: [(route) => chatReply(route, 404, { error: "not found" })] });
  await open(p, "/settings/bots");
  await shown(p, "Approve new bots in the approval app for now.");
  equal([await p.getByRole("alert").count(), await T(p, "pending-join").count(), await T(p, "bots-add").count()], [0, 0, 0], "alerts, requests and Add bot");
}, /404 \(Not Found\)/);

it("Server Bots: a bots list that fails says Could not load the bots. with Try again, and Try again brings the list", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const asked = await serverBots(p, { lists: [(route) => chatReply(route, 503, { error: "request unavailable" }), botsList()] });
  await installSessionClock(p);
  await open(p, "/settings/bots");
  const line = p.getByRole("alert").filter({ hasText: "Could not load the bots." });
  await line.waitFor();
  equal(await p.getByText("Approve new bots in the approval app for now.").count(), 0, "the the approval app line");
  await line.getByRole("button", { name: "Try again" }).click();
  await T(p, "pending-join").first().waitFor();
  equal([asked.reads, await p.getByRole("alert").count()], [2, 0], "reads and alerts");
}, /503 \(Service Unavailable\)/);

it("Server Bots: Refuse reads the list after the tap, sends one POST with the code and that read's token, then reads the list once more; a request that is gone says so and the new list shows", MAC, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const withoutTarn = (raw) => ({ ...raw, pending: raw.pending.slice(1) });
  const asked = await serverBots(p, {
    lists: [botsList("t-list-1"), botsList("t-list-2"), botsList("t-list-3", withoutTarn), botsList("t-list-4", withoutTarn), botsList("t-list-5", (raw) => ({ ...raw, pending: [] }))],
    posts: { refuse: [undefined, (route) => chatReply(route, 404, { error: "gone" })] },
  });
  await installSessionClock(p);
  await open(p, "/settings/bots");
  const tarn = T(p, "pending-join").filter({ hasText: "tarn wants to join" });
  await tarn.getByRole("button", { name: "Refuse", exact: true }).click();
  await gone(tarn);
  equal([asked.posts, asked.reads], [[["refuse", { code: "K7P42Q9M", csrf: "t-list-2" }]], 3], "POSTs and reads after Refuse");
  await T(p, "pending-join").filter({ hasText: "quorl wants to join" }).getByRole("button", { name: "Refuse", exact: true }).click();
  await p.getByRole("alert").filter({ hasText: "That request is no longer waiting." }).waitFor();
  equal([asked.posts.at(-1), asked.reads, await T(p, "pending-join").count()], [["refuse", { code: "M3X85T2R", csrf: "t-list-4" }], 5, 0], "the second POST, reads and requests");
}, /404 \(Not Found\)/);

it("Server Bots: a 303 on Refuse takes him to the fresh sign-in, which brings him back to /settings/bots", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const asked = await serverBots(p, { posts: { refuse: [(route) => route.fulfill({ status: 303, headers: { Location: "/captain/step-up?next=%2Fsettings%2Fbots" } })] } });
  await stepUpPage(p);
  await installSessionClock(p);
  await open(p, "/settings/bots");
  await T(p, "pending-join").first().getByRole("button", { name: "Refuse", exact: true }).click();
  await p.waitForURL((url) => url.pathname === "/captain/step-up");
  equal([new URL(p.url()).searchParams.get("next"), asked.posts.length, asked.reads], ["/settings/bots", 1, 2], "the way back, POSTs and reads");
});

it("Server Bots: with under 30 s of fresh sign-in left, Refuse sends nothing and goes to the fresh sign-in first", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const asked = await serverBots(p, { lists: [botsList("t-list-1", (raw) => ({ ...raw, freshUntil: Date.parse("2026-11-05T12:00:20Z") / 1000 }))] });
  await stepUpPage(p);
  await installSessionClock(p);
  await open(p, "/settings/bots");
  await T(p, "pending-join").first().getByRole("button", { name: "Refuse", exact: true }).click();
  await p.waitForURL((url) => url.pathname === "/captain/step-up");
  equal([new URL(p.url()).searchParams.get("next"), asked.posts.length], ["/settings/bots", 0], "the way back and POSTs");
});

it("Server Bots: Add bot on the Bots screen checks the name before sending, then shows the prompt and its invite code once with Copy, and closing drops them", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const made = botsSample("invite-200.json");
  const asked = await serverBots(p, { lists: [botsList("t-list-1"), botsList("t-list-2")], posts: { invites: [(route) => chatReply(route, 200, { ...made, csrf: "t-done-1", freshUntil: BOTS_FRESH })] } });
  await installSessionClock(p);
  await open(p, "/settings/bots");
  await T(p, "bots-add").click();
  const dialog = p.locator('[data-pop="add-bot"]');
  await T(p, "bot-name").fill("Tarn");
  await dialog.getByRole("button", { name: "Create invite" }).click();
  await dialog.getByRole("alert").filter({ hasText: BOTS_NAME_WORDS }).waitFor();
  equal(asked.posts.length, 0, "POSTs after a name that breaks the rule");
  await T(p, "bot-name").fill("tarn");
  await dialog.getByRole("button", { name: "Create invite" }).click();
  await T(p, "bot-prompt").getByText(made.prompt, { exact: true }).waitFor();
  equal([await T(p, "invite-code").innerText(), await T(p, "invite-copy").count(), asked.posts, asked.reads], ["Invite code: QD7F3K92QM", 1, [["invites", { forName: "tarn", csrf: "t-list-2" }]], 3], "the code line, Copy, POSTs and reads");
  await T(p, "add-bot-close").click();
  await gone(dialog);
  await T(p, "bots-add").click();
  await T(p, "bot-name-step").waitFor();
  equal([await p.getByText("QD7F3K92QM").count(), await p.getByText(made.prompt).count()], [0, 0], "the code and the prompt after closing");
});

it("Server Bots: Create invite shows the name words on a 422 and the wait words on a 429", MAC, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const asked = await serverBots(p, { posts: { invites: [(route) => chatReply(route, 422, { error: "name" }), (route) => chatReply(route, 429, { error: "rate" })] } });
  await installSessionClock(p);
  await open(p, "/settings/bots");
  await T(p, "bots-add").click();
  const dialog = p.locator('[data-pop="add-bot"]');
  await T(p, "bot-name").fill("tarn");
  await dialog.getByRole("button", { name: "Create invite" }).click();
  await dialog.getByRole("alert").filter({ hasText: BOTS_NAME_WORDS }).waitFor();
  await dialog.getByRole("button", { name: "Create invite" }).click();
  await dialog.getByRole("alert").filter({ hasText: "Too many tries. Wait up to a minute, then try again." }).waitFor();
  equal([asked.posts.map(([path]) => path), asked.reads, await T(p, "bot-prompt").count()], [["invites", "invites"], 5, 0], "POSTs, reads and a prompt");
}, /(422 \(Unprocessable Entity\)|429 \(Too Many Requests\))/);

it("Server Bots: a cards check between the bots list and Refuse does not sign him out: Refuse posts the token of a list read made after the tap, which a server that takes only the newest token accepts", MAC, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const cards = JSON.parse(readFileSync(new URL("./src/data/server-payloads/list-fixed-only.json", import.meta.url), "utf8"));
  const seen = { given: 0, newest: null, cards: 0, refused: false, posts: [] };
  const give = () => (seen.newest = "t-" + (seen.given += 1));
  await p.route("**/captain/cards", (route) => {
    seen.cards += 1;
    return chatReply(route, 200, { ...cards, csrf: give() });
  });
  await p.route((url) => url.pathname === "/captain/api/bots", (route) => chatReply(route, 200, botsList(give(), (raw) => (seen.refused ? { ...raw, pending: raw.pending.slice(1) } : raw))));
  await p.route((url) => url.pathname.startsWith("/captain/api/bots/"), (route) => {
    const { csrf } = JSON.parse(route.request().postData());
    const taken = csrf === seen.newest;
    seen.posts.push(taken ? 200 : 403);
    if (!taken) return chatReply(route, 403, { error: "request refused" });
    seen.newest = null;
    seen.refused = true;
    return chatReply(route, 200, { csrf: give(), freshUntil: BOTS_FRESH });
  });
  await installSessionClock(p);
  await open(p, "/settings/bots");
  const tarn = T(p, "pending-join").filter({ hasText: "tarn wants to join" });
  await tarn.waitFor();
  const before = seen.cards;
  for (let step = 0; step < 60 && seen.cards === before; step += 1) {
    await p.clock.runFor(1_000);
    await p.waitForTimeout(25);
  }
  equal(seen.cards > before, true, "a cards check ran while the Bots screen was open");
  await tarn.getByRole("button", { name: "Refuse", exact: true }).click();
  await gone(tarn);
  equal([seen.posts, await p.getByText("Signed out", { exact: true }).count(), new URL(p.url()).pathname], [[200], 0, "/settings/bots"], "the POST's answer, the signed-out page and the screen");
});

it("Server Bots: with Settings > Bots on screen, a session that lapses while the tab is hidden brings the list back when he returns, with no tap and no leaving the screen", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const asked = await serverBots(p);
  await tabVisibility(p);
  await installSessionClock(p);
  await open(p, "/settings/bots");
  await T(p, "pending-join").first().waitFor();
  await p.evaluate(() => window.qdVisibility("hidden"));
  await p.clock.runFor(300_000);
  await T(p, "pending-join").first().waitFor({ state: "detached" });
  const before = asked.reads;
  await p.clock.resume();
  await p.evaluate(() => window.qdVisibility("visible"));
  await T(p, "pending-join").filter({ hasText: "tarn wants to join" }).waitFor();
  equal([asked.reads - before, new URL(p.url()).pathname], [1, "/settings/bots"], "bots reads on his return and the screen");
});

it("Server Task Card: Got it drops the Queue's waiting count at once, and the Queue that follows still holds the answered card out of Waiting", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  await cardRead(p, "alba-1", []);
  const receipt = readFileSync(new URL("./src/data/server-payloads/answer/answer-200-current.json", import.meta.url), "utf8");
  const posts = [];
  await p.route("**/captain/cards/alba-1/answer", (route) => {
    posts.push(route.request().method());
    return route.fulfill({ status: 200, contentType: "application/json", body: receipt });
  });
  await open(p, "/queue/alba-1");
  await T(p, "option").nth(2).waitFor();
  await shown(p, "Queue · 6 waiting");
  await T(p, "send").tap();
  await T(p, "got-it").waitFor();
  await shown(p, "Queue · 5 waiting");
  await p.getByRole("link", { name: "Queue · 5 waiting" }).tap();
  await T(p, "card-row").first().waitFor();
  const rows = await titles(p);
  equal([rows.length, rows.includes("How many results should each Search group show?")], [5, false], "Waiting rows after Got it: count, answered card listed");
  equal(posts, ["POST"], "answer posts");
});

it("Server Task Card: a send refused for the rate and an open refused for the rate each offer Try again, not Retry", MAC, async (p) => {
  const buttons = async (line) => [await line.getByRole("button", { name: "Try again", exact: true }).count(), await line.getByRole("button", { name: "Retry", exact: true }).count()];
  await serverBuild(p, "list-fixed-only.json");
  await cardRead(p, "alba-1", []);
  await p.route("**/captain/cards/alba-1/answer", (route) => route.fulfill({ status: 429, contentType: "application/json", body: "" }));
  await open(p, "/queue/alba-1");
  await T(p, "option").nth(2).waitFor();
  await T(p, "send").click();
  const refusedSend = T(p, "send-failed");
  await refusedSend.getByText("Not sent: too many sends this minute. Wait up to a minute, then Try again.", { exact: true }).waitFor();
  const sendButtons = await buttons(refusedSend);
  const reads = await cardRead(p, "alba-2", Array(60).fill(503));
  await open(p, "/queue/alba-2");
  const failedOpen = p.getByRole("alert").filter({ hasText: "Could not load this Task Card." });
  const refusedOpen = p.getByRole("alert").filter({ hasText: "Too many opens this minute. Wait up to a minute, then Try again." });
  await failedOpen.or(refusedOpen).waitFor();
  for (let press = 0; press < 40 && !(await refusedOpen.count()); press += 1) {
    await failedOpen.getByRole("button").click();
    await failedOpen.or(refusedOpen).waitFor();
  }
  equal([sendButtons, await buttons(refusedOpen)], [[1, 0], [1, 0]], "Try again and Retry buttons on the refused send line, then on the refused open line after " + reads.length + " card reads");
}, /429 \(Too Many Requests\)|503 \(Service Unavailable\)/);

it("Server Add bot on the Mac: the sidebar offers no Add bot", MAC, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  await queueShown(p);
  equal(await p.getByRole("button", { name: "Add bot" }).count(), 0, "Add bot buttons");
});

it("Server Add bot on a phone: the Menu drawer, the Queue's More and the Settings top offer no Add bot", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  await queueShown(p);
  await openDrawer(p, true);
  const drawer = await p.locator('[data-pop="drawer"]').getByRole("button", { name: "Add bot" }).count();
  await queueShown(p);
  await queueActions(p).getByRole("button", { name: "More" }).click();
  const sheet = p.locator('[data-pop="more"]');
  await sheet.getByRole("button", { name: "Settings" }).waitFor();
  const more = await sheet.getByRole("button", { name: "Add bot" }).count();
  await open(p, "/settings");
  await T(p, "settings-screen").waitFor();
  equal([drawer, more, await T(p, "float-more").count()], [0, 0, 0], "Add bot in the drawer, in the Queue's More, and Settings' More");
});

for (const [name, size, more] of [["a phone", PHONE, "float-more"], ["the Mac", MAC, "chat-more"]])
  it("Server Add bot in a chat on " + name + ": More offers no Add bot", size, async (p) => {
    await serverBuild(p, "list-fixed-only.json");
    await open(p, "/chat/iris");
    await T(p, more).click();
    const sheet = p.locator('[data-pop="more"]');
    await sheet.getByRole("button", { name: "Settings" }).waitFor();
    equal(await sheet.getByRole("button", { name: "Add bot" }).count(), 0, "Add bot in the chat's More");
  });

const chatPayload = (name) => JSON.parse(readFileSync(new URL("./src/data/server-payloads/chat/" + name, import.meta.url), "utf8"));
const chatReply = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const chatSent = (body, n) => ({ ...chatPayload("send-200.json"), id: "iris-m" + (30 + n), text: body.text, clientId: body.clientId });
const CHAT_LAST = "Answer 30: the export sheet is on its way.";
const SEND_CAP = Number(/const SEND_CAP = ([\d_]+);/.exec(readFileSync(new URL("./src/data/server-chat.ts", import.meta.url), "utf8"))[1].replaceAll("_", ""));
const sendSettles = (locator) => locator.waitFor({ timeout: SEND_CAP });
const serverBuildChat = async (p, { post, older, rows, "iris": iris, shape, read, list = "list-fixed-only.json" } = {}) => {
  const built = spawnSync(process.execPath, ["tools/build-app.mjs", "--server", "--chat"], { stdio: "inherit", timeout: 60_000 });
  if (built.status !== 0) throw new Error("server chat build failed: " + (built.error?.message ?? built.status));
  const listing = readFileSync(new URL("./src/data/server-payloads/" + list, import.meta.url), "utf8");
  const asked = { threads: [], posts: [], kept: [], reads: [] };
  await p.route("**/captain/cards", (route) => route.fulfill({ status: 200, contentType: "application/json", body: listing }));
  await p.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      close() {}
    };
  });
  await p.route((url) => url.pathname === "/captain/api/chats", (route) => chatReply(route, 200, typeof rows === "function" ? rows() : (rows ?? chatPayload("rows.json"))));
  await p.route((url) => url.pathname === "/captain/api/chat/read", (route) => {
    asked.reads.push(JSON.parse(route.request().postData()));
    return read ? read(route, asked.reads.length) : chatReply(route, 200, { csrf: "csrf-placeholder", freshUntil: 0 });
  });
  await p.route((url) => url.pathname === "/captain/api/chat", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = JSON.parse(request.postData());
      asked.posts.push(body);
      return post ? post(route, body, asked.posts.length) : chatReply(route, 200, chatSent(body, asked.posts.length));
    }
    const query = new URL(request.url()).searchParams;
    const [bot, before, after] = [query.get("bot"), query.get("before"), query.get("after")];
    asked.threads.push(before ? bot + " before " + before : after ? bot + " after " + after : bot);
    if (before) return older ? older(route) : chatReply(route, 200, chatPayload("thread-iris-older.json"));
    const thread = chatPayload({ "iris": "thread-iris-newest.json", "alba": "thread-alba.json" }[bot] ?? "thread-dale-empty.json");
    if (bot === "iris") thread.messages = [...(iris ? iris(thread.messages) : thread.messages), ...asked.kept].slice(-15);
    const shaped = shape ? shape(thread, bot) : thread;
    if (!after) return chatReply(route, 200, shaped);
    const at = shaped.messages.findIndex((one) => one.id === after);
    return at < 0 ? chatReply(route, 409, { error: "cursor" }) : chatReply(route, 200, { ...shaped, messages: shaped.messages.slice(at + 1) });
  });
  return asked;
};
const chatOpened = async (p) => {
  await open(p, "/chat/iris");
  await p.locator('[data-message-id="iris-m30"] [data-message-text]').getByText(CHAT_LAST, { exact: true }).waitFor();
};
const bubble = (p, text) => T(p, "chat-my-message").filter({ has: p.getByText(text, { exact: true }) });
const beforeOf = (list, item) => list.slice(Math.max(0, list.indexOf(item) - 2), list.indexOf(item) + 1);

for (const [name, size] of [["the Mac", MAC], ["a phone", PHONE]])
  it("Server Chat on " + name + ": the chat list shows the server's bots in its order, and a bot with no messages comes last with no time and No messages yet.", size, async (p) => {
    await serverBuildChat(p);
    await open(p, "/queue");
    await openDrawer(p, size === PHONE);
    const rows = T(p, "chat-row");
    await rows.nth(2).waitFor();
    const read = await rows.evaluateAll((items) => items.map((row) => [row.dataset.id, row.querySelectorAll("time").length, row.textContent.includes("No messages yet.")]));
    equal(read, [["iris", 1, false], ["alba", 1, false], ["dale", 0, true]], "rows: id, times, No messages yet.");
  });

const WIDE_TABLE = "Export columns:\n\n| Card | Title | Owner | Project | Lane | Due | Priority | State |\n|---|---|---|---|---|---|---|---|\n| alba-1 | How many results should each Search group show? | Alba | quarterdeck | Search | Tue 5 PM | P1 | open |\n| shelvorn-2 | Run the room list check before the bridge change? | Shelvorn | heron-forge | Rooms | Tue 12 PM | P0 | open |";
it("Server Chat on a phone: a wide Markdown table keeps short columns such as Owner and Due on one line, wraps a long title within 15rem, and scrolls sideways inside its own region", PHONE, async (p) => {
  await serverBuildChat(p, { "iris": (messages) => [...messages, { id: "iris-md-table", from: "bot", text: WIDE_TABLE, at: "2026-11-06T00:31:00-05:00", refs: [] }] });
  await open(p, "/chat/iris");
  const message = p.locator('[data-message-id="iris-md-table"]');
  const region = message.locator('[role="region"]');
  await region.waitFor();
  const cell = (n) => region.locator("tbody tr").first().locator("td").nth(n);
  const lines = (n) => cell(n).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode());
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  equal([await lines(2), await lines(5)], [1, 1], "lines in the Owner cell Alba and the Due cell Tue 5 PM");
  const title = await cell(1).evaluate((el) => (el.firstElementChild ?? el).getBoundingClientRect().width);
  equal([(await lines(1)) > 1, title <= 240], [true, true], "the long title wraps, within 15rem (" + title + " px wide)");
  const sideways = await region.evaluate((el) => {
    const wider = el.scrollWidth > el.clientWidth;
    el.scrollLeft = 120;
    return [wider, el.scrollLeft > 0, getComputedStyle(el).overflowX];
  });
  equal(sideways, [true, true, "auto"], "the table is wider than its region, the region scrolls sideways, overflow-x");
  const bubble = await message.locator(".chat-bot-bubble").boundingBox();
  equal(bubble.x + bubble.width <= 390, true, "the bubble stays inside the phone's 390 px");
});

it("Server Chat: the newest 15 show; Show older loads the 15 before, keeps his place, says so when it fails, and goes once the server has no older", MAC, async (p) => {
  let fail = true;
  const { promise: held, resolve: release } = Promise.withResolvers();
  const asked = await serverBuildChat(p, {
    older: async (route) => {
      if (fail) {
        fail = false;
        return chatReply(route, 503, { error: "unavailable" });
      }
      await held;
      return chatReply(route, 200, chatPayload("thread-iris-older.json"));
    },
  });
  await chatOpened(p);
  const texts = T(p, "chat-thread").locator("[data-message-text]");
  equal(await texts.count(), 15, "messages at first");
  const more = T(p, "chat-older");
  await more.scrollIntoViewIfNeeded();
  await more.click();
  const failed = T(p, "chat-thread").getByRole("alert").filter({ hasText: "Could not load older messages." });
  await failed.waitFor();
  const anchor = p.getByText("Answer 16: the export sheet is on its way.", { exact: true });
  const place = (await anchor.boundingBox()).y;
  await failed.getByRole("button", { name: "Retry" }).click();
  const loading = T(p, "chat-thread").getByRole("button", { name: "Loading older" });
  await loading.waitFor();
  equal(await loading.isDisabled(), true, "Loading older can be pressed");
  release();
  await shown(p, "Iris, question 1: is the export sheet ready?");
  equal(await texts.count(), 30, "messages after Show older");
  equal(Math.round((await anchor.boundingBox()).y), Math.round(place), "his place");
  equal(asked.threads, ["iris", "iris before iris-m16", "iris before iris-m16"], "thread reads");
  equal(await T(p, "chat-older").count(), 0, "Show older once older is false");
}, /503/);

it("Server Chat: two of his messages with one send id, as when the server kept a send and its retry, both show, and after Show older every message shows once", MAC, async (p) => {
  await serverBuildChat(p, { "iris": (messages) => messages.map((m) => (m.id === "iris-m19" ? { ...m, clientId: "client-iris-17" } : m)) });
  await chatOpened(p);
  const texts = T(p, "chat-thread").locator("[data-message-text]");
  equal(await texts.count(), 15, "messages at first");
  await T(p, "chat-older").click();
  await shown(p, "Iris, question 1: is the export sheet ready?");
  const all = await texts.allInnerTexts();
  equal([all.length, new Set(all).size], [30, 30], "messages after Show older, and different ones");
});

it("Server Chat on the Mac: no + button, no Quote by hover or by selection, and Copy stays", MAC, async (p) => {
  await serverBuildChat(p);
  await chatOpened(p);
  equal([await T(p, "plus-btn").count(), await T(p, "cite-btn").count()], [0, 1], "+ and cite buttons");
  await p.locator('[data-message-id="iris-m30"]').hover();
  equal(await T(p, "message-actions").getByRole("button").allInnerTexts(), ["Copy"], "hover actions");
  await p.locator('[data-message-id="iris-m30"] [data-message-text]').evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
  await p.waitForTimeout(400);
  equal(await T(p, "selection-quote").count(), 0, "selection Quote");
});

it("Server Chat on a phone: no + button, a held message offers Copy and no Quote, and a pasted or dropped file attaches nothing", PHONE, async (p) => {
  await serverBuildChat(p);
  await chatOpened(p);
  equal(await T(p, "plus-btn").count(), 0, "+ button");
  await p.locator('[data-message-id="iris-m30"]').evaluate((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: box.left + 60, clientY: box.top + 12 }));
  });
  const sheet = p.locator('[data-pop="message-actions"]');
  await sheet.waitFor();
  equal(await sheet.getByRole("button").allInnerTexts(), ["Done", "Copy"], "held message actions");
  await sheet.getByRole("button", { name: "Done" }).tap();
  await sheet.waitFor({ state: "detached" });
  const before = p.url();
  await T(p, "chat-input").evaluate((el) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["log line"], "run.log", { type: "text/plain" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await T(p, "chat").evaluate((el) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["log line"], "run.log", { type: "text/plain" }));
    for (const kind of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(kind, { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await p.waitForTimeout(400);
  equal([await T(p, "draft-file").count(), await T(p, "drop-hint").count(), p.url()], [0, 0, before], "files attached, drop hint, address");
});

for (const [name, size, coarse, select] of [["a phone", PHONE, true, "none"], ["an iPad upright", IPAD_UPRIGHT, true, "none"], ["the Mac", MAC, false, "auto"]])
  it("Server Chat on " + name + ": " + (coarse ? "a finger cannot start a text selection anywhere in the thread, so a long press can only open the message menu" : "the thread keeps its text selection"), size, async (p) => {
    await serverBuildChat(p);
    await chatOpened(p);
    equal(await p.evaluate(() => matchMedia("(pointer: coarse)").matches), coarse, "the pointer this context has");
    equal(await T(p, "chat-thread").evaluate((el) => getComputedStyle(el).userSelect), select, "user-select of the thread list");
  });

const holdBubble = (p, id) =>
  p.locator('[data-message-id="' + id + '"]').evaluate((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: box.left + 60, clientY: box.top + 12 }));
  });

for (const [name, features, rows] of [["lists quote", ["quote"], ["Reply", "Copy"]], ["lists no quote", [], ["Copy"]]])
  it("Server Chat on a phone: when the thread " + name + ", a held message opens the menu with " + rows.join(" then ") + " as icon rows", PHONE, async (p) => {
    await serverBuildChat(p, { shape: (body) => ({ ...body, features }) });
    await chatOpened(p);
    await holdBubble(p, "iris-m30");
    const sheet = p.locator('[data-pop="message-actions"]');
    await sheet.waitFor();
    equal(await sheet.getByRole("button").allInnerTexts(), ["Done", ...rows], "the menu's buttons in order");
    const shown = await sheet.getByRole("button").evaluateAll((list) => list.filter((el) => el.textContent !== "Done").map((el) => [el.textContent, el.querySelector("svg") !== null, el.getBoundingClientRect().height >= 48]));
    equal(shown, rows.map((row) => [row, true, true]), "each row: its words, an icon, at least 48 px tall");
  });

it("Server Chat on the Mac: when the thread lists quote, hovering a message offers Reply then Copy", MAC, async (p) => {
  await serverBuildChat(p, { shape: (body) => ({ ...body, features: ["quote"] }) });
  await chatOpened(p);
  await p.locator('[data-message-id="iris-m30"]').hover();
  equal(await T(p, "message-actions").getByRole("button").allInnerTexts(), ["Reply", "Copy"], "hover actions with quote listed");
});

it("Server Chat on a phone: Copy in the menu writes a bot message as plain text, with no Markdown marks", PHONE, async (p) => {
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await serverBuildChat(p, { "iris": (messages) => messages.map((m) => (m.id === "iris-m26" ? { ...m, text: "**Done.** All three passed:\n\n- one\n- two" } : m)) });
  await chatOpened(p);
  await holdBubble(p, "iris-m26");
  const sheet = p.locator('[data-pop="message-actions"]');
  await sheet.getByRole("button", { name: "Copy" }).tap();
  await sheet.getByRole("button", { name: "Copied" }).waitFor();
  equal(await p.evaluate(() => navigator.clipboard.readText()), "Done. All three passed:\n\n- one\n- two", "what Copy put on the clipboard");
});

for (const [name, size] of [["a phone", PHONE], ["an iPad upright", IPAD_UPRIGHT]])
  it("Server Chat on " + name + ": a long press opens the message menu, the menu stays open when the finger lifts, and Copy then works", size, async (p) => {
    await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await serverBuildChat(p);
    await chatOpened(p);
    const row = p.locator('[data-message-id="iris-m30"]');
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    const point = { x: Math.round(box.x + 60), y: Math.round(box.y + 12) };
    const touch = await p.context().newCDPSession(p);
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    const sheet = p.locator('[data-pop="message-actions"]');
    await sheet.waitFor();
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    equal(await sheet.isVisible(), true, "the menu after the finger lifts");
    await sheet.getByRole("button", { name: "Copy" }).tap();
    await sheet.getByRole("button", { name: "Copied" }).waitFor();
  });

const sentWords = (asked) => asked.posts.map((body) => body.text);
const boxReads = (p, text) => p.waitForFunction((want) => document.querySelector('[data-testid="chat-input"]').value === want, text);
const boxEmpty = (p) => boxReads(p, "");

for (const [name, size] of [["a phone", PHONE], ["an iPad upright", IPAD_UPRIGHT]])
  it("Server Chat on " + name + ": Return in the message box starts a new line and sends nothing, Send sends it, and Cmd or Ctrl plus Return sends", size, async (p) => {
    const asked = await serverBuildChat(p);
    await chatOpened(p);
    equal(await T(p, "chat-input").getAttribute("enterkeyhint"), "enter", "the Return key's hint");
    await T(p, "chat-input").click();
    await p.keyboard.type("a");
    await p.keyboard.press("Enter");
    await p.keyboard.type("b");
    await boxReads(p, "a\nb");
    equal([await T(p, "chat-input").inputValue(), sentWords(asked)], ["a\nb", []], "the box and the POSTs after Return");
    await T(p, "chat-send").tap();
    await boxEmpty(p);
    await p.keyboard.type("c");
    await p.keyboard.press("Control+Enter");
    await boxEmpty(p);
    await p.keyboard.type("d");
    await p.keyboard.press("Meta+Enter");
    await boxEmpty(p);
    await p.locator('[data-message-id="iris-m33"]').waitFor();
    equal(sentWords(asked), ["a\nb", "c", "d"], "what was sent, in order");
  });

it("Server Chat on the Mac: Enter sends, Shift+Enter starts a new line, and the box asks for the Return key as enter", MAC, async (p) => {
  const asked = await serverBuildChat(p);
  await chatOpened(p);
  equal(await T(p, "chat-input").getAttribute("enterkeyhint"), "enter", "the Return key's hint");
  await T(p, "chat-input").click();
  await p.keyboard.type("a");
  await p.keyboard.press("Shift+Enter");
  await p.keyboard.type("b");
  await boxReads(p, "a\nb");
  equal([await T(p, "chat-input").inputValue(), sentWords(asked)], ["a\nb", []], "after Shift+Enter");
  await p.keyboard.press("Enter");
  await boxEmpty(p);
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal(sentWords(asked), ["a\nb"], "Enter sent it");
});

for (const [name, size] of [["a phone", PHONE], ["the Mac", MAC]])
  it("Server Chat on " + name + ": Send keeps the focus in the message box, so the keyboard stays open and the next words go straight in", size, async (p) => {
    const asked = await serverBuildChat(p);
    await chatOpened(p);
    await T(p, "chat-input").click();
    await p.keyboard.type("one");
    if (size === PHONE) await T(p, "chat-send").tap();
    else await T(p, "chat-send").click();
    await boxEmpty(p);
    equal(await p.evaluate(() => document.activeElement?.getAttribute("data-testid")), "chat-input", "where the focus is after Send");
    await p.keyboard.type("next");
    equal(await T(p, "chat-input").inputValue(), "next", "typing goes into the box with no second tap on it");
    await p.locator('[data-message-id="iris-m31"]').waitFor();
    equal(sentWords(asked), ["one"], "one POST");
  });

it("Server Chat on a phone: two quick taps on Send send the message once", PHONE, async (p) => {
  const asked = await serverBuildChat(p);
  await chatOpened(p);
  await T(p, "chat-input").click();
  await p.keyboard.type("one");
  const box = await T(p, "chat-send").boundingBox();
  await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal([sentWords(asked), await bubble(p, "one").count()], [["one"], 1], "POSTs and rows after two taps");
});

it("Server Chat on a phone: while the first send is still out, the next message shows as Sending on its first tap, both turn sent in order, and only the second says Delivered", PHONE, async (p) => {
  const gate = Promise.withResolvers();
  const asked = await serverBuildChat(p, {
    post: async (route, body, n) => {
      if (n === 1) await gate.promise;
      return chatReply(route, 200, chatSent(body, n));
    },
  });
  await chatOpened(p);
  await T(p, "chat-input").click();
  await p.keyboard.type("one");
  await T(p, "chat-send").tap();
  await bubble(p, "one").getByText("Sending...", { exact: true }).waitFor();
  await T(p, "chat-input").click();
  await p.keyboard.type("two");
  await T(p, "chat-send").tap();
  await bubble(p, "two").getByText("Sending...", { exact: true }).waitFor();
  equal([await T(p, "chat-input").inputValue(), sentWords(asked)], ["", ["one"]], "the box is empty and only the first POST is out");
  gate.resolve();
  await bubble(p, "two").getByText("Delivered", { exact: true }).waitFor();
  equal([sentWords(asked), await bubble(p, "one").getAttribute("data-message-id"), await bubble(p, "two").getAttribute("data-message-id"), await T(p, "chat-delivered").count()], [["one", "two"], "iris-m31", "iris-m32", 1], "both sent, in order, Delivered once");
});

it("Server Chat on a phone: Send empties the box at once and shows his words as Sending, the same row then says Delivered with the server's id and time, and one POST carried bot, text and clientId", PHONE, async (p) => {
  const { promise: held, resolve: release } = Promise.withResolvers();
  const asked = await serverBuildChat(p, {
    post: async (route, body, n) => {
      await held;
      return chatReply(route, 200, chatSent(body, n));
    },
  });
  await chatOpened(p);
  await T(p, "chat-input").fill("Please send the sheet.");
  await T(p, "chat-send").click();
  const row = bubble(p, "Please send the sheet.");
  await row.getByText("Sending...", { exact: true }).waitFor();
  equal(
    [await T(p, "chat-input").inputValue(), await T(p, "chat-input").evaluate((el) => el.readOnly), await p.getByRole("button", { name: "Send", exact: true }).count(), await p.getByRole("button", { name: "Sending" }).count(), await row.count()],
    ["", false, 1, 0, 1],
    "while sending: the box empty and open, Send as it always is, one row",
  );
  const kept = await row.elementHandle();
  release();
  const sent = p.locator('[data-message-id="iris-m31"]');
  await sent.waitFor();
  equal(
    [await kept.evaluate((el) => [el.isConnected, el.getAttribute("data-message-id")]), await sent.getByText("Please send the sheet.", { exact: true }).count(), await sent.getByText("Delivered", { exact: true }).count(), await T(p, "chat-thread").getByText("Sent", { exact: true }).count(), await sent.locator("time").last().innerText(), await T(p, "chat-input").inputValue()],
    [[true, "iris-m31"], 1, 1, 0, "12:40 AM", ""],
    "the row that was Sending is the sent message: its words, Delivered, no Sent anywhere, its time, the box",
  );
  equal(asked.posts.map((body) => [Object.keys(body).sort(), body.bot, body.text, /^[A-Za-z0-9_-]{1,80}$/.test(body.clientId)]), [[["bot", "clientId", "csrf", "text"], "iris", "Please send the sheet.", true]], "POSTs");
});

const barMotion = (locator) =>
  locator.evaluate((element) =>
    element.getAnimations({ subtree: true }).map((one) => {
      const timing = one.effect.getComputedTiming();
      const moved = [...new Set(one.effect.getKeyframes().flatMap((frame) => Object.keys(frame).filter((key) => !["offset", "computedOffset", "easing", "composite"].includes(key))))].sort();
      return [one.animationName ?? null, timing.duration, timing.iterations === Infinity ? "endless" : timing.iterations, moved];
    }),
  );

for (const [where, size] of [["a phone", PHONE], ["the Mac", MAC]])
  it("Server Chat on " + where + ": while a send is out, a thin bar runs where its time will show and Sending... is said to a screen reader only; with Reduce Motion the bar stands still; when it lands, its time takes the bar's place at the same height", size, async (p) => {
    const { promise: held, resolve: release } = Promise.withResolvers();
    await serverBuildChat(p, {
      post: async (route, body, n) => {
        await held;
        return chatReply(route, 200, chatSent(body, n));
      },
    });
    await chatOpened(p);
    await p.waitForFunction(() => document.querySelector('link[href$="motion.css"]')?.sheet);
    await T(p, "chat-input").fill("Please send the sheet.");
    await T(p, "chat-send").click();
    const row = bubble(p, "Please send the sheet.");
    await row.getByText("Sending...", { exact: true }).waitFor();
    const bar = row.getByTestId("chat-sending-bar");
    equal(await bar.count(), 1, "a bar in the status line's place");
    const hidden = await row.getByText("Sending...", { exact: true }).evaluate((el) => el.getBoundingClientRect().width <= 1 && el.getBoundingClientRect().height <= 1);
    equal([hidden, (await row.ariaSnapshot()).includes("Sending..."), await row.locator("time").count()], [true, true, 0], "Sending... is there for a screen reader and not on screen, and no time shows yet");
    equal(await barMotion(bar), [], "with Reduce Motion the bar stands still");
    await p.emulateMedia({ reducedMotion: "no-preference" });
    await p.waitForFunction(() => document.querySelector('[data-testid="chat-sending-bar"]')?.getAnimations({ subtree: true }).length > 0, null, { polling: "raf" });
    equal(await barMotion(bar), [["sending", 1200, "endless", ["translate"]]], "with motion the bar runs until the send lands, 1.2 s each way, moving only sideways");
    const [slot, box] = [await bar.boundingBox(), await row.boundingBox()];
    release();
    const sent = p.locator('[data-message-id="iris-m31"]');
    const time = sent.locator("time");
    await time.waitFor();
    const [line, now] = [await time.locator("xpath=..").boundingBox(), await sent.boundingBox()];
    const endless = (await barMotion(sent)).filter(([, , iterations]) => iterations === "endless");
    equal(
      [await sent.getByTestId("chat-sending-bar").count(), await sent.getByText("Sending...", { exact: true }).count(), line.height, line.y - now.y, endless],
      [0, 0, slot.height, slot.y - box.y, []],
      "once it lands: no bar and no Sending..., its time's line as tall as the bar's and in the bar's place in the row, nothing left running",
    );
  });

it("Server Chat: two sends out together show two Sending rows, each turns sent in its own row in the order he sent them with no row shown twice, and only the latest says Delivered", MAC, async (p) => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const asked = await serverBuildChat(p, {
    post: async (route, body, n) => {
      await gates[n - 1].promise;
      return chatReply(route, 200, chatSent(body, n));
    },
  });
  await chatOpened(p);
  for (const text of ["First one", "Second one"]) {
    await T(p, "chat-input").fill(text);
    await T(p, "chat-send").click();
    await bubble(p, text).getByText("Sending...", { exact: true }).waitFor();
  }
  const [first, second] = [bubble(p, "First one"), bubble(p, "Second one")];
  const kept = [await first.elementHandle(), await second.elementHandle()];
  const once = (text) => T(p, "chat-thread").getByText(text, { exact: true }).count();
  equal([await T(p, "chat-input").inputValue(), await once("First one"), await once("Second one"), await T(p, "chat-thread").getByText("Sending...", { exact: true }).count()], ["", 1, 1, 2], "the box, each row once, two Sending");
  gates[0].resolve();
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal([await first.getAttribute("data-message-id"), await first.getByText("Delivered", { exact: true }).count(), await second.getByText("Sending...", { exact: true }).count(), await once("First one"), await once("Second one")], ["iris-m31", 0, 1, 1, 1], "the first is sent with no word, the second, his latest, is still Sending, no row twice");
  gates[1].resolve();
  await p.locator('[data-message-id="iris-m32"]').waitFor();
  equal([await T(p, "chat-delivered").count(), await p.locator('[data-message-id="iris-m32"] [data-testid="chat-delivered"]').count()], [1, 1], "Delivered once, under the second");
  const list = (await chatTimeline(p)).filter((item) => item !== "day");
  equal(
    [await kept[0].evaluate((el) => [el.isConnected, el.getAttribute("data-message-id")]), await kept[1].evaluate((el) => [el.isConnected, el.getAttribute("data-message-id")]), beforeOf(list, "iris-m32"), await once("First one"), await once("Second one")],
    [[true, "iris-m31"], [true, "iris-m32"], ["iris-m30", "iris-m31", "iris-m32"], 1, 1],
    "each row is its own sent message, in order, once",
  );
  equal([asked.posts.map((body) => body.text), new Set(asked.posts.map((body) => body.clientId)).size], [["First one", "Second one"], 2], "POSTs in order, two clientIds");
});

it("Server Chat: with two sends out, when the first lands it stays above the second, which is still Sending, so his rows keep the order he sent them in", MAC, async (p) => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  await serverBuildChat(p, {
    post: async (route, body, n) => {
      await gates[n - 1].promise;
      return chatReply(route, 200, chatSent(body, n));
    },
  });
  await chatOpened(p);
  for (const text of ["First one", "Second one"]) {
    await T(p, "chat-input").fill(text);
    await T(p, "chat-send").click();
    await bubble(p, text).getByText("Sending...", { exact: true }).waitFor();
  }
  gates[0].resolve();
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  const order = await T(p, "chat-thread").locator('[data-testid="chat-my-message"] [data-message-text]').allInnerTexts();
  equal([order.slice(-2), await bubble(p, "Second one").getByText("Sending...", { exact: true }).count()], [["First one", "Second one"], 1], "the first, landed, above the second, still Sending");
  gates[1].resolve();
  await p.locator('[data-message-id="iris-m32"]').waitFor();
  equal((await T(p, "chat-thread").locator('[data-testid="chat-my-message"] [data-message-text]').allInnerTexts()).slice(-2), ["First one", "Second one"], "the same order once both land");
});

it("Server Chat: a bot message that lands while his send is out shows below his Sending row, and once his send lands the server's time order puts his message below it, so his row moves once (today's behaviour, pinned)", MAC, async (p) => {
  const { promise: held, resolve: release } = Promise.withResolvers();
  const asked = await serverBuildChat(p, {
    post: async (route, body, n) => {
      await held;
      return chatReply(route, 200, chatSent(body, n));
    },
  });
  await chatOpened(p);
  await T(p, "chat-input").fill("Please send the sheet.");
  await T(p, "chat-send").click();
  const row = bubble(p, "Please send the sheet.");
  await row.getByText("Sending...", { exact: true }).waitFor();
  asked.kept.push({ id: "iris-m40", from: "bot", text: "A reply while he sends", at: "2026-11-06T00:35:00-05:00", refs: [] });
  await p.locator('[data-testid="chat-row"][data-id="alba"]').click();
  await p.locator('[aria-label="Chat with alba"]').waitFor();
  await p.locator('[data-testid="chat-row"][data-id="iris"]').click();
  await T(p, "chat-bot-message").filter({ hasText: "A reply while he sends" }).waitFor();
  const kept = await row.elementHandle();
  const texts = () => T(p, "chat-thread").locator("[data-message-text]").allInnerTexts();
  equal([(await texts()).slice(-2), await row.getByText("Sending...", { exact: true }).count()], [["Please send the sheet.", "A reply while he sends"], 1], "while his send is out: his Sending row, then the bot's message");
  release();
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal([(await texts()).slice(-2), await kept.evaluate((el) => [el.isConnected, el.getAttribute("data-message-id")])], [["A reply while he sends", "Please send the sheet."], [true, "iris-m31"]], "once it lands: the bot's message, then his, in the same row");
});

for (const [status, error, words, again] of [
  [429, "rate", "Not sent: too many sends this minute. Wait up to a minute, then Try again.", true],
  [422, "bot", "This bot is not in your chat list.", false],
  [400, "text", "Message is empty or too long.", false],
  [502, "mail", "Not Delivered", true],
])
  it("Server Chat: a " + status + " " + error + " refusal shows Not Delivered" + (error === "mail" ? " after one quiet retry with the same clientId" : " over " + JSON.stringify(words)) + " on his row, never puts his words back in the box, and " + (again ? "Try Again resends the same clientId" : "offers no Try Again, so his next message goes out as a new send"), MAC, async (p) => {
    let refuse = true;
    const asked = await serverBuildChat(p, { post: (route, body) => (refuse ? chatReply(route, status, { error }) : chatReply(route, 200, chatSent(body, 1))) });
    await chatOpened(p);
    await T(p, "chat-input").fill("Please send the sheet.");
    await T(p, "chat-send").click();
    const row = bubble(p, "Please send the sheet.");
    const line = row.getByRole("alert").filter({ hasText: words });
    await sendSettles(line);
    const tries = asked.posts.length;
    equal([await T(p, "chat-input").inputValue(), await line.getByText("Not Delivered", { exact: true }).count(), await row.getByRole("button", { name: "Try Again", exact: true }).count(), await row.getByText("Sending...", { exact: true }).count(), tries, new Set(asked.posts.map((body) => body.clientId)).size], ["", 1, again ? 1 : 0, 0, error === "mail" ? 2 : 1, 1], "after the refusal: the box, Not Delivered, Try Again, Sending, POSTs, clientIds");
    refuse = false;
    if (again) {
      await row.getByRole("button", { name: "Try Again", exact: true }).click();
      await p.locator('[data-message-id="iris-m31"]').waitFor();
      equal([asked.posts.length, new Set(asked.posts.map((body) => body.clientId)).size, await T(p, "chat-input").inputValue(), await line.count(), await T(p, "chat-thread").getByText("Please send the sheet.", { exact: true }).count()], [tries + 1, 1, "", 0, 1], "POSTs, one clientId, the box, the refusal, his words shown once");
    } else {
      await T(p, "chat-input").fill("A second message.");
      await T(p, "chat-send").click();
      await p.locator('[data-message-id="iris-m31"]').waitFor();
      const list = (await chatTimeline(p)).filter((item) => item !== "day");
      equal([asked.posts.length, asked.posts[1].clientId !== asked.posts[0].clientId, await line.count(), beforeOf(list, "iris-m31")], [2, true, 1, ["iris-m30", "other", "iris-m31"]], "POSTs, a new clientId, the refusal still on its row, and that row stays above the sent one");
    }
  }, new RegExp(String(status)));

for (const [size, where, under] of [[PHONE, "a phone", true], [MAC, "a Mac", false]])
  it("Server Chat: on " + where + " a failed send with Try again keeps its words at the row's width, with Try again " + (under ? "on its own line under them" : "beside them"), size, async (p) => {
    await serverBuildChat(p, { post: (route) => chatReply(route, 429, { error: "rate" }) });
    await chatOpened(p);
    await T(p, "chat-input").fill("Please send the sheet.");
    await T(p, "chat-send").click();
    const line = bubble(p, "Please send the sheet.").getByRole("alert");
    await line.getByRole("button", { name: "Try again" }).waitFor();
    const [row, words, again] = await line.evaluate((el) =>
      [el, el.querySelector("p"), el.querySelector("button")].map((part) => {
        const box = part.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      }),
    );
    equal(again.top >= words.bottom, under, "Try again under the words");
    if (under) equal([Math.abs(again.right - words.right) < 1, words.right - words.left >= row.right - row.left - 50], [true, true], "Try again at the words' right edge, the words across the row");
  }, /429/);

it("Server Chat: past the app's own cap Send shows the rate words on his row with no POST, and Try again on that row sends no POST and shows them again", MAC, async (p) => {
  const asked = await serverBuildChat(p);
  await chatOpened(p);
  const line = T(p, "chat-thread").getByRole("alert").filter({ hasText: "Not sent: too many sends this minute. Wait up to a minute, then Try again." });
  let refused = null;
  for (let n = 1; n <= 12 && refused === null; n++) {
    const before = asked.posts.length;
    await T(p, "chat-input").fill("Send number " + n);
    await T(p, "chat-send").click();
    await Promise.race([p.locator('[data-message-id="iris-m' + (30 + before + 1) + '"]').waitFor().catch(() => null), line.waitFor().catch(() => null)]);
    if (await line.count()) refused = { posts: before, text: "Send number " + n };
  }
  equal([refused?.posts > 0, asked.posts.length, await T(p, "chat-input").inputValue(), await bubble(p, refused?.text ?? "").getByRole("alert").count()], [true, refused?.posts, "", 1], "refused by the app's cap after some sends: POSTs, the box, the words on that row");
  await bubble(p, refused.text).getByRole("button", { name: "Try again" }).click();
  await p.waitForTimeout(400);
  await line.waitFor();
  equal(asked.posts.length, refused.posts, "POSTs after Try again");
});

it("Server Chat: a message over 4,000 characters stays in the box with the words Not sent: the message is over 4,000 characters. and no POST or row, and trimmed to 4,000 it sends", MAC, async (p) => {
  const asked = await serverBuildChat(p);
  await chatOpened(p);
  const rows = await T(p, "chat-my-message").count();
  await T(p, "chat-input").fill("x".repeat(4001));
  await T(p, "chat-send").click();
  const line = p.getByRole("alert").filter({ hasText: "Not sent: the message is over 4,000 characters." });
  await line.waitFor();
  await boxReads(p, "x".repeat(4001));
  equal([asked.posts.length, (await T(p, "chat-input").inputValue()).length, await T(p, "chat-my-message").count()], [0, 4001, rows], "POSTs, the box keeps his text, rows");
  await T(p, "chat-input").fill("x".repeat(4000));
  await T(p, "chat-send").click();
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal([asked.posts.length, asked.posts[0].text.length, await line.count(), await T(p, "chat-input").inputValue()], [1, 4000, 0, ""], "POSTs, the text sent, the words, the box");
});

for (const [found, name] of [[true, "the re-read holds the clientId, so his row reads Sent after one POST and no failure line ever shows"], [false, "the re-read does not hold it, so five seconds later the app reads again and sends once more by itself with the same clientId, one message shows, and no failure line ever shows"]])
  it("Server Chat: when a POST's answer is lost, " + name, MAC, async (p) => {
    let lose = true;
    const asked = await serverBuildChat(p, {
      post: (route, body, n) => {
        if (!lose) return chatReply(route, 200, chatSent(body, 1));
        lose = false;
        if (found) asked.kept.push(Object.fromEntries(Object.entries(chatSent(body, n)).filter(([key]) => ["id", "from", "text", "at", "refs", "clientId"].includes(key))));
        return route.abort();
      },
    });
    await chatOpened(p);
    await p.evaluate(() => {
      window.qdFailureLines = 0;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="chat-thread"] [role="alert"]')) window.qdFailureLines += 1;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await T(p, "chat-input").fill("Please send the sheet.");
    await T(p, "chat-send").click();
    await sendSettles(p.locator('[data-message-id="iris-m31"]'));
    equal(
      [asked.posts.length, new Set(asked.posts.map((body) => body.clientId)).size, await T(p, "chat-thread").getByText("Please send the sheet.", { exact: true }).count(), await T(p, "chat-input").inputValue(), await p.evaluate(() => window.qdFailureLines)],
      [found ? 1 : 2, 1, 1, "", 0],
      "POSTs, clientIds, messages shown, the box, failure lines seen at any time",
    );
  }, /ERR_FAILED/);

it("Server Chat: when every POST's answer is lost and no read holds it, Not Delivered shows after one quiet retry with the same clientId, and when the thread holds it on his return his row reads Sent with no third POST", MAC, async (p) => {
  const asked = await serverBuildChat(p, { post: (route) => route.abort() });
  await chatOpened(p);
  await T(p, "chat-input").fill("Please send the sheet.");
  await T(p, "chat-send").click();
  await sendSettles(bubble(p, "Please send the sheet.").getByRole("alert").filter({ hasText: "Not Delivered" }));
  equal([asked.posts.length, new Set(asked.posts.map((body) => body.clientId)).size], [2, 1], "POSTs and clientIds when Not Delivered shows");
  asked.kept.push(Object.fromEntries(Object.entries(chatSent(asked.posts[0], 1)).filter(([key]) => ["id", "from", "text", "at", "refs", "clientId"].includes(key))));
  await p.locator('[data-testid="chat-row"][data-id="alba"]').click();
  await p.locator('[aria-label="Chat with alba"]').waitFor();
  await p.locator('[data-testid="chat-row"][data-id="iris"]').click();
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal([asked.posts.length, await T(p, "chat-thread").getByText("Please send the sheet.", { exact: true }).count(), await T(p, "chat-thread").getByRole("alert").count()], [2, 1, 0], "POSTs, his words shown once, failure lines");
}, /ERR_FAILED/);

it("Server Chat: a send whose sign-in token read fails because the phone is offline shows no failure, and when the network is back the app tries once more by itself after its pause, so his message lands with one POST", MAC, async (p) => {
  await p.clock.install({ time: new Date("2026-11-06T06:00:00Z") });
  let offline = false;
  const asked = await serverBuildChat(p);
  await p.route((url) => url.pathname === "/captain/cards" || url.pathname === "/captain/api/chat", (route) => (offline ? route.abort() : route.fallback()));
  await chatOpened(p);
  await p.evaluate(() => {
    window.qdFailureLines = 0;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="chat-thread"] [role="alert"]')) window.qdFailureLines += 1;
    }).observe(document.body, { childList: true, subtree: true });
  });
  offline = true;
  const failed = p.waitForEvent("requestfailed", (request) => new URL(request.url()).pathname === "/captain/cards");
  await T(p, "chat-input").fill("Sent while offline.");
  await T(p, "chat-send").click();
  await failed;
  offline = false;
  const landed = p.locator('[data-message-id="iris-m31"]');
  for (let step = 0; step < 10 && !(await landed.count()); step += 1) await p.clock.runFor(1_000);
  await landed.waitFor();
  equal([asked.posts.length, await p.evaluate(() => window.qdFailureLines), await T(p, "chat-thread").getByText("Sent while offline.", { exact: true }).count()], [1, 0, 1], "POSTs, failure lines seen at any time, his message shown once");
}, /ERR_FAILED/);

for (const [name, size] of [["a phone", PHONE], ["the Mac", MAC]])
  it("Server Chat on " + name + ": offline past 61 s the chat shows its own hidden line, and when the network is back it confirms by itself within 50 s and brings the thread, his draft with its quote and his unsent message back", size, async (p) => {
    await p.clock.install({ time: new Date("2026-11-06T06:00:00Z") });
    let offline = false;
    await serverBuildChat(p, quoting());
    await p.route((url) => url.pathname.startsWith("/captain/"), (route) => (offline ? route.abort() : route.fallback()));
    await chatOpened(p);
    offline = true;
    await T(p, "chat-input").fill("An unsent message.");
    await T(p, "chat-send").click();
    const failed = T(p, "chat-thread").getByText("Not Delivered", { exact: true });
    for (let step = 0; step < 20 && !(await failed.count()); step += 1) await p.clock.runFor(1_000);
    await failed.waitFor();
    if (size === PHONE) {
      await holdBubble(p, "iris-m30");
      await p.clock.runFor(600);
      await p.locator('[data-pop="message-actions"]').getByRole("button", { name: "Reply" }).tap();
    } else {
      await p.locator('[data-message-id="iris-m30"]').hover();
      await T(p, "message-actions").getByRole("button", { name: "Reply" }).click();
    }
    await T(p, "chat-quote").getByText(CHAT_LAST, { exact: false }).waitFor();
    await T(p, "chat-input").fill("A draft he is still typing.");
    const hidden = p.getByText("Your chat is hidden until we can confirm it is still you.", { exact: true });
    for (let step = 0; step < 70 && !(await hidden.count()); step += 1) await p.clock.runFor(1_000);
    equal([await hidden.count(), await T(p, "chat-thread").count(), await T(p, "chat-input").count()], [1, 0, 0], "the chat's own hidden line, with no thread and no box");
    offline = false;
    const thread = T(p, "chat-thread");
    for (let step = 0; step < 50 && !(await thread.count()); step += 1) await p.clock.runFor(1_000);
    equal(await thread.count(), 1, "the thread is back within 50 s of the network returning, with no tap");
    await p.locator('[data-message-id="iris-m30"] [data-message-text]').getByText(CHAT_LAST, { exact: true }).waitFor();
    equal([await T(p, "chat-input").inputValue(), await T(p, "chat-quote").getByText(CHAT_LAST, { exact: false }).count(), await thread.getByText("An unsent message.", { exact: true }).count(), await thread.getByText("Not Delivered", { exact: true }).count()], ["A draft he is still typing.", 1, 1, 1], "his draft, its quote and his unsent message are back, unchanged");
  }, /ERR_FAILED/);

const HOSTILE = '<img src="x" onerror="window.qdChatHtmlRan = true"><script>window.qdChatHtmlRan = true</script>';
const hostileMade = (p) => p.evaluate(() => [document.querySelectorAll('img[src="x"], img[onerror], a[href^="javascript:"]').length + [...document.querySelectorAll("script")].filter((item) => item.textContent.includes("qdChatHtmlRan")).length, window.qdChatHtmlRan ?? null]);
const BAD_BOT = "bad/id?x#y z";

it("Server Chat guard: HTML and a script in a message, a row preview and a bot note show as literal text, no img or script element is made, and a javascript: link is blocked", MAC, async (p) => {
  const rows = chatPayload("rows.json");
  rows[0].bot.note = "Export lead " + HOSTILE;
  rows[1].preview = "Preview " + HOSTILE;
  await serverBuildChat(p, { rows, "iris": (messages) => messages.map((m) => (m.id === "iris-m28" ? { ...m, text: m.text + " " + HOSTILE + " [open](javascript:alert(1))" } : m)) });
  await chatOpened(p);
  const message = p.locator('[data-message-id="iris-m28"] [data-message-text]');
  await message.getByText("Link blocked: not a safe address", { exact: true }).waitFor();
  const shownText = await p.locator("body").innerText();
  equal(
    [(await message.innerText()).includes('The build log says <img src="x" onerror="window.qdChatHtmlRan = true"> and <b>bold</b>, as plain text. ' + HOSTILE), await message.locator("img, b, script").count(), shownText.includes("Export lead " + HOSTILE), shownText.includes("Preview " + HOSTILE), await hostileMade(p)],
    [true, 0, true, true, [0, null]],
    "message text, its elements, the note, the preview, elements made in the page",
  );
});

it("Server Chat guard: a chat list row whose bot id holds /, ?, # or a space shows the list failure, and nothing is made from that id", MAC, async (p) => {
  const rows = chatPayload("rows.json");
  rows.splice(1, 0, { bot: { id: BAD_BOT, note: "Bad bot" }, preview: "Bad row", at: rows[0].at, last: "bad-m1", unread: false });
  await serverBuildChat(p, { rows });
  await open(p, "/queue");
  await shown(p, "Could not load the chats.");
  equal([await T(p, "chat-row").count(), await p.locator('[href*="bad"], [data-id*="bad"]').count(), await p.getByText("Bad row").count(), await p.getByText("Bad bot").count()], [0, 0, 0, 0], "rows, links, preview, note");
});

it("Server Chat on the Mac: a bot's display name shows in the chat list, the chat header, the thread and the tab title, and a name that is not 1 to 40 code points of plain text shows the bot's id", MAC, async (p) => {
  const rows = chatPayload("rows.json");
  rows[0].bot.name = "Iris Export Lead";
  rows[1].bot.name = "Lead\u0007";
  await serverBuildChat(p, { rows, shape: (body, bot) => (bot === "iris" ? { ...body, bot: { ...body.bot, name: "Iris Export Lead" } } : body) });
  await chatOpened(p);
  const listed = await T(p, "chat-row").evaluateAll((items) => items.map((row) => [row.dataset.id, row.querySelector("b")?.textContent]));
  equal(listed, [["iris", "Iris Export Lead"], ["alba", "alba"], ["dale", "dale"]], "chat list: id, name");
  equal(
    [await p.locator("h1:visible").allInnerTexts(), await T(p, "chat-thread").getAttribute("aria-label"), await p.title()],
    [["Iris Export Lead"], "Chat with Iris Export Lead", "Iris Export Lead · Quarterdeck"],
    "header, thread label, tab title",
  );
});

const LONG_BOT = "Export and release lead for the squad";
for (const [where, size, path, phone] of [["the Mac's Queue", MAC, "/queue", false], ["a Mac chat", MAC, "/chat/iris", false], ["a phone's Menu drawer", PHONE, "/queue", true]])
  it("Server Chat list in " + where + ": each row shows a whole Bot tag before the bot's name and reads Bot then the name, a long name ends in ... inside the row, and every row's time shows whole", size, async (p) => {
    const long = { bot: { id: "squad-export", name: LONG_BOT, note: "Builder" }, preview: "The release notes are ready for a look.", at: "2026-11-05T18:00:00-05:00", last: "squad-export-m1", unread: false };
    await serverBuildChat(p, { rows: [...chatPayload("rows.json"), long] });
    await open(p, path);
    await openDrawer(p, phone);
    const rows = p.locator('[data-testid="chat-row"]:visible');
    await rows.nth(3).waitFor();
    const seen = await rows.evaluateAll((items) =>
      items.map((row) => {
        const nav = row.closest("nav").getBoundingClientRect();
        const edge = Math.min(row.getBoundingClientRect().right, nav.left + row.closest("nav").clientLeft + row.closest("nav").clientWidth) + 0.5;
        const name = row.querySelector("b");
        const tag = name.previousElementSibling;
        const time = row.querySelector("time");
        const box = (one) => one.getBoundingClientRect();
        return [
          row.dataset.id,
          tag?.textContent ?? null,
          tag ? box(tag).right <= box(name).left && tag.scrollWidth <= tag.clientWidth && box(tag).right <= edge : false,
          name.scrollWidth > name.clientWidth ? getComputedStyle(name).textOverflow === "ellipsis" && box(name).right <= edge : "whole",
          time ? time.scrollWidth <= time.clientWidth && box(time).right <= edge : "no time",
        ];
      }),
    );
    const read = await Promise.all(["iris", "alba", "dale", LONG_BOT].map((name) => p.getByRole("link", { name: new RegExp("^Bot " + name + " ") }).count()));
    equal(
      [seen, read],
      [
        [
          ["iris", "Bot", true, "whole", true],
          ["alba", "Bot", true, "whole", true],
          ["dale", "Bot", true, "whole", "no time"],
          ["squad-export", "Bot", true, true, true],
        ],
        [1, 1, 1, 1],
      ],
      "per row: id, the tag, the tag whole and left of the name inside the row, the name whole or cut with ... inside the row, the time whole inside the row; then links whose name starts Bot then the bot's name",
    );
  });

const MARKED = "**L7 check reply** from the stand-in bot.\n\n- first item with `code`\n- second item and a [link](https://example.com/notes) to the release notes for the whole squad";
const MARKED_WORDS = "L7 check reply from the stand-in bot. first item with code second item and a link to the release notes for the whole squad";
for (const [where, size, path, phone] of [["the Mac's Queue", MAC, "/queue", false], ["a Mac chat", MAC, "/chat/iris", false], ["a phone's Menu drawer", PHONE, "/queue", true]])
  it("Server Chat list in " + where + ": a Markdown preview reads as its plain words, and a long one ends in ... inside its row", size, async (p) => {
    const marked = { bot: { id: "stand-in", note: "Stand-in" }, preview: MARKED, at: "2026-11-05T18:00:00-05:00", last: "stand-in-m1", unread: false };
    await serverBuildChat(p, { rows: [...chatPayload("rows.json"), marked] });
    await open(p, path);
    await openDrawer(p, phone);
    const row = p.locator('[data-testid="chat-row"][data-id="stand-in"]:visible');
    await row.waitFor();
    const seen = await row.evaluate((el) => {
      const nav = el.closest("nav");
      const edge = Math.min(el.getBoundingClientRect().right, nav.getBoundingClientRect().left + nav.clientLeft + nav.clientWidth) + 0.5;
      const preview = [...el.querySelectorAll("span.truncate")].at(-1);
      return [preview.textContent, preview.scrollWidth > preview.clientWidth, getComputedStyle(preview).textOverflow, preview.getBoundingClientRect().right <= edge, el.getBoundingClientRect().right <= edge];
    });
    equal(seen, [MARKED_WORDS, true, "ellipsis", true, true], "the preview's words, cut, with ..., its right edge inside the row and the row inside the list");
  });

it("Server Chat guard: opening a chat whose bot id holds /, ?, # or a space reads no thread and sends nothing", PHONE, async (p) => {
  const asked = await serverBuildChat(p);
  await open(p, "/chat/" + encodeURIComponent(BAD_BOT));
  await shown(p, "No chat with this bot.");
  await p.waitForTimeout(400);
  equal([asked.threads, asked.posts.length], [[], 0], "thread reads and sends");
});

const ALBA_1_LINE = 'About Task Card alba-1, version 3: "How many results should each Search group show?"';
const ALBA_2_LINE = 'About Task Card alba-2, version 1: "Pick what a new device shows first"';
const serverCardReads = async (p) => {
  const read = JSON.parse(readFileSync(new URL("./src/data/server-payloads/card-open.json", import.meta.url), "utf8"));
  const [first] = read.thread;
  const fresh = (id, title, sender) => ({ ...read, card: { ...read.card, id, title }, rev: 1, thread: [{ ...first, sender, document: { ...first.document, card: id, id } }] });
  const reads = {
    "alba-1": read,
    "alba-2": fresh("alba-2", "Pick what a new device shows first", "alba"),
    "kivo-3": fresh("kivo-3", "Search result grouping", "kivo"),
  };
  await p.route((url) => url.pathname.startsWith("/captain/cards/"), (route) => {
    const body = reads[new URL(route.request().url()).pathname.slice("/captain/cards/".length)];
    return route.fulfill(body ? { status: 200, contentType: "application/json", body: JSON.stringify(body) } : { status: 404, contentType: "application/json", body: '{"error":"not found"}' });
  });
};
const draftReads = async (p, want) => {
  await p.waitForFunction((text) => document.querySelector('[data-testid="chat-input"]')?.value === text, want, { timeout: 5_000 }).catch(() => null);
  return T(p, "chat-input").inputValue();
};

it("Server Chat on a phone: Talk to on a fresh load needs no chat list read, puts one line naming the card, its version and title in the box, focuses nothing, and Send posts it as plain text with no quote", PHONE, async (p) => {
  const asked = await serverBuildChat(p, { list: "list-added.json" });
  await serverCardReads(p);
  const listReads = [];
  p.on("request", (request) => { if (new URL(request.url()).pathname === "/captain/api/chats") listReads.push(request.url()); });
  await open(p, "/queue/alba-1");
  await T(p, "options").waitFor();
  const readsFirst = listReads.length;
  await talkTo(p, PHONE);
  await p.waitForURL("**/chat/alba").catch(() => null);
  equal([readsFirst, new URL(p.url()).pathname], [0, "/chat/alba"], "chat list reads before Talk to, and Talk to opens the chat");
  equal(await draftReads(p, ALBA_1_LINE + "\n"), ALBA_1_LINE + "\n", "the box after Talk to");
  equal([await focusedNow(p), await T(p, "chat-quote").count()], [TALK_TO_FOCUS, 0], "focus after Talk to, as the example build; no quote box");
  const box = T(p, "chat-input");
  await box.focus();
  await box.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
  await p.keyboard.type("Why five?");
  await T(p, "chat-send").tap();
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal(asked.posts.map((body) => [Object.keys(body).sort(), body.bot, body.text]), [[["bot", "clientId", "csrf", "text"], "alba", ALBA_1_LINE + "\nWhy five?"]], "POSTs");
  equal([await p.locator('[data-message-id="iris-m31"] [data-message-text]').innerText(), await box.inputValue()], [ALBA_1_LINE + "\nWhy five?", ""], "the sent message, the box");
});

const quoting = (extra = {}) => ({ shape: (body) => ({ ...body, features: ["quote"] }), ...extra });

it("Server Chat on a phone: with quote listed, Reply in the held menu puts the message above the box, Send posts its id and words with his text, and the sent row shows the quote", PHONE, async (p) => {
  const asked = await serverBuildChat(p, quoting());
  await chatOpened(p);
  await holdBubble(p, "iris-m30");
  const sheet = p.locator('[data-pop="message-actions"]');
  await sheet.getByRole("button", { name: "Reply" }).tap();
  await sheet.waitFor({ state: "detached" });
  await T(p, "chat-quote").getByText(CHAT_LAST, { exact: false }).waitFor();
  await T(p, "chat-input").fill("Thanks.");
  await T(p, "chat-send").tap();
  const sent = p.locator('[data-message-id="iris-m31"]');
  await sent.waitFor();
  equal(asked.posts.map((body) => [Object.keys(body).sort(), body.text, body.quote]), [[["bot", "clientId", "csrf", "quote", "text"], "Thanks.", { id: "iris-m30", text: CHAT_LAST }]], "POSTs");
  equal([await T(p, "chat-quote").count(), await sent.getByTestId("chat-sent-quote").count()], [0, 1], "the box's quote is gone and the sent row shows it");
});

it("Server Chat on the Mac: with quote listed, selected words offer Reply and Send posts only those words", MAC, async (p) => {
  const asked = await serverBuildChat(p, quoting());
  await chatOpened(p);
  await p.locator('[data-message-id="iris-m30"] [data-message-text]').evaluate((root, words) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(words);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + words.length);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      return;
    }
  }, "the export sheet");
  const bar = T(p, "selection-quote");
  await bar.waitFor();
  await bar.getByRole("button", { name: "Reply" }).click();
  await T(p, "chat-quote").waitFor();
  await T(p, "chat-input").fill("Yes.");
  await p.keyboard.press("Enter");
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal(asked.posts.map((body) => body.quote), [{ id: "iris-m30", text: "the export sheet" }], "the quote that was posted");
});

it("Server Chat on the Mac: with quote listed, Talk to quotes the card above the box with no card line in it, and Send posts the card's id and version as the quote", MAC, async (p) => {
  const asked = await serverBuildChat(p, quoting({ list: "list-added.json" }));
  await serverCardReads(p);
  await open(p, "/queue/alba-1");
  await talkTo(p, MAC);
  await p.waitForURL("**/chat/alba");
  await T(p, "chat-quote").waitFor();
  equal(await T(p, "chat-input").inputValue(), "", "the box holds no card line");
  await T(p, "chat-input").fill("Why five?");
  await p.keyboard.press("Enter");
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal(asked.posts.map((body) => [body.text, body.quote]), [["Why five?", { cardId: "alba-1", version: 3 }]], "the POST");
});

it("Server Chat on the Mac: a 422 quote refusal shows Not sent: that message is no longer in this chat. on his row, with no Try again", MAC, async (p) => {
  await serverBuildChat(p, quoting({ post: (route) => chatReply(route, 422, { error: "quote" }) }));
  await chatOpened(p);
  await p.locator('[data-message-id="iris-m30"]').hover();
  await T(p, "message-actions").getByRole("button", { name: "Reply" }).click();
  await T(p, "chat-input").fill("Thanks.");
  await p.keyboard.press("Enter");
  const row = bubble(p, "Thanks.");
  await row.getByText("Not sent: that message is no longer in this chat.", { exact: true }).waitFor();
  equal([await row.getByRole("button", { name: "Try again" }).count(), await T(p, "chat-input").inputValue()], [0, ""], "Try again, and the box");
}, /422/);

it("Server Chat on the Mac: Talk to before the chat list read lands still opens the chat with the card line", MAC, async (p) => {
  await serverBuildChat(p, { list: "list-added.json" });
  await serverCardReads(p);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let answered = false;
  await p.route((url) => url.pathname === "/captain/api/chats", async (route) => {
    await held;
    answered = true;
    return chatReply(route, 200, chatPayload("rows.json"));
  });
  await open(p, "/queue/alba-1");
  await talkTo(p, MAC);
  await p.waitForURL("**/chat/alba").catch(() => null);
  equal([answered, new URL(p.url()).pathname], [false, "/chat/alba"], "the chat list read still held, and Talk to opens the chat");
  equal(await draftReads(p, ALBA_1_LINE + "\n"), ALBA_1_LINE + "\n", "the box after Talk to");
  release();
});

it("Server Chat: Talk to on a card whose owner is not in the chat list opens the no-chat state and sends nothing", MAC, async (p) => {
  const asked = await serverBuildChat(p, { list: "list-added.json" });
  await serverCardReads(p);
  await p.route((url) => url.pathname === "/captain/api/chat" && url.searchParams.get("bot") === "kivo", (route) => {
    asked.threads.push("kivo");
    return chatReply(route, 422, { error: "bot" });
  });
  const listed = p.waitForResponse((response) => new URL(response.url()).pathname === "/captain/api/chats");
  await open(p, "/queue/kivo-3");
  await listed;
  await talkTo(p, MAC);
  await p.waitForURL("**/chat/kivo").catch(() => null);
  equal(new URL(p.url()).pathname, "/chat/kivo", "Talk to opens the owner's chat path");
  await shown(p, "No chat with this bot.");
  await p.waitForTimeout(400);
  equal([asked.threads.filter((bot) => bot === "kivo").length > 0, asked.posts.length, await T(p, "chat-input").count()], [true, 0, 0], "a thread read for kivo, no send, no message box");
}, /422/);

it("Server Chat on the Mac: Talk to keeps his unsent words under the card line, a second Talk to adds no second line, and another card's Talk to replaces the line", MAC, async (p) => {
  await serverBuildChat(p, { list: "list-added.json" });
  await serverCardReads(p);
  await open(p, "/queue/alba-1");
  await talkTo(p, MAC);
  await p.waitForURL("**/chat/alba");
  await T(p, "chat-input").fill("Half a thought");
  await p.goBack();
  await talkTo(p, MAC);
  await p.waitForURL("**/chat/alba");
  equal(await draftReads(p, ALBA_1_LINE + "\nHalf a thought"), ALBA_1_LINE + "\nHalf a thought", "the box after Talk to");
  equal(await focusedNow(p), TALK_TO_FOCUS, "focus after Talk to, as the example build");
  await p.goBack();
  await talkTo(p, MAC);
  await p.waitForURL("**/chat/alba");
  equal(await draftReads(p, ALBA_1_LINE + "\nHalf a thought"), ALBA_1_LINE + "\nHalf a thought", "the box after a second Talk to");
  await p.goBack();
  await T(p, "card-row").getByRole("link", { name: "Pick what a new device shows first" }).click();
  await T(p, "card-pane").getByText("Pick what a new device shows first").first().waitFor();
  await talkTo(p, MAC);
  await p.waitForURL("**/chat/alba");
  equal(await draftReads(p, ALBA_2_LINE + "\nHalf a thought"), ALBA_2_LINE + "\nHalf a thought", "the box after another card's Talk to");
});

it("Server Chat: Talk to while a send is on its way puts the card line in the box at once, nothing he typed is lost, and his words show once in the thread at Sent", MAC, async (p) => {
  let land;
  const landed = new Promise((resolve) => { land = resolve; });
  const sent = [];
  const asked = await serverBuildChat(p, { list: "list-added.json", post: async (route, body, n) => { await landed; const receipt = chatSent(body, n); sent.push(receipt); return chatReply(route, 200, receipt); } });
  await p.route((url) => url.pathname === "/captain/api/chat" && url.searchParams.get("bot") === "alba" && !url.searchParams.has("before"), (route) => {
    const thread = chatPayload("thread-alba.json");
    return chatReply(route, 200, { ...thread, messages: [...thread.messages, ...sent.map(({ id, from, text, at, refs, clientId }) => ({ id, from, text, at, refs, clientId }))] });
  });
  await serverCardReads(p);
  await open(p, "/queue/alba-1");
  await talkTo(p, MAC);
  await p.waitForURL("**/chat/alba");
  await T(p, "chat-input").fill("Please send the sheet.");
  await T(p, "chat-send").click();
  await bubble(p, "Please send the sheet.").getByText("Sending...", { exact: true }).waitFor();
  await p.goBack();
  await talkTo(p, MAC);
  await p.waitForURL("**/chat/alba");
  equal(await draftReads(p, ALBA_1_LINE + "\n"), ALBA_1_LINE + "\n", "the box while the send is on its way");
  await bubble(p, "Please send the sheet.").getByText("Sending...", { exact: true }).waitFor();
  land();
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal(await draftReads(p, ALBA_1_LINE + "\n"), ALBA_1_LINE + "\n", "the box at Sent");
  equal([asked.posts.length, await T(p, "chat-thread").getByText("Please send the sheet.", { exact: true }).count()], [1, 1], "POSTs, his words in the thread");
});

for (const [status, error, words] of [
  [429, "rate", "Not sent: too many sends this minute. Wait up to a minute, then Try again."],
  [502, "mail", "Not Delivered"],
])
  it("Server Chat: a failed send (" + status + ") keeps its row and its Try Again while he types a new message and taps Talk to, and Try Again sends the same clientId", MAC, async (p) => {
    let refuse = true;
    const asked = await serverBuildChat(p, { list: "list-added.json", post: (route, body) => (refuse ? chatReply(route, status, { error }) : chatReply(route, 200, chatSent(body, 1))) });
    await serverCardReads(p);
    await open(p, "/queue/alba-1");
    await talkTo(p, MAC);
    await p.waitForURL("**/chat/alba");
    await T(p, "chat-input").fill("First try.");
    await T(p, "chat-send").click();
    const row = bubble(p, "First try.");
    await sendSettles(row.getByRole("alert").filter({ hasText: words }));
    await T(p, "chat-input").fill("Next thought.");
    equal([await row.getByRole("button", { name: "Try Again", exact: true }).count(), await T(p, "chat-input").inputValue()], [1, "Next thought."], "his failed row and its Try Again stay while he types");
    await p.goBack();
    await talkTo(p, MAC);
    await p.waitForURL("**/chat/alba");
    equal(await draftReads(p, ALBA_1_LINE + "\nNext thought."), ALBA_1_LINE + "\nNext thought.", "the box after Talk to: the card line above what he typed");
    equal([await row.getByRole("alert").filter({ hasText: words }).count(), await row.getByRole("button", { name: "Try Again", exact: true }).count()], [1, 1], "his failed row and its Try Again after Talk to");
    refuse = false;
    await row.getByRole("button", { name: "Try Again", exact: true }).click();
    await p.locator('[data-message-id="iris-m31"]').waitFor();
    equal([asked.posts.length, new Set(asked.posts.map((body) => body.clientId)).size, await T(p, "chat-input").inputValue()], [error === "mail" ? 3 : 2, 1, ALBA_1_LINE + "\nNext thought."], "POSTs, one clientId, the box left as it was");
  }, new RegExp(String(status)));

it("Server Chat: a failed send among good ones keeps its row, words and Try Again where it was, the next send turns Sent in its own row below it, and Try Again later lands as its own row", MAC, async (p) => {
  await p.clock.install({ time: new Date("2026-11-06T06:00:00Z") });
  const asked = await serverBuildChat(p, { post: (route, body, n) => (n <= 2 ? chatReply(route, 502, { error: "mail" }) : chatReply(route, 200, chatSent(body, n - 2))) });
  await chatOpened(p);
  const whole = await chatTimeline(p);
  const at = whole.lastIndexOf("iris-m30") + 1;
  const withRows = (...rows) => [...whole.slice(0, at), ...rows, ...whole.slice(at)];
  await T(p, "chat-input").fill("Send A");
  await T(p, "chat-send").click();
  const failed = bubble(p, "Send A");
  await sendSettles(failed.getByRole("alert").filter({ hasText: "Not Delivered" }));
  const kept = await failed.elementHandle();
  await T(p, "chat-input").fill("Send B");
  await T(p, "chat-send").click();
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal(
    [await kept.evaluate((el) => el.isConnected), await failed.getByRole("button", { name: "Try Again", exact: true }).count(), await bubble(p, "Send B").getAttribute("data-message-id"), await chatTimeline(p), asked.posts.length],
    [true, 1, "iris-m31", withRows("other", "iris-m31"), 3],
    "A stays a failed row with its Try Again above B, B is the sent message, the whole list in order with its day labels, three POSTs (A and its quiet retry, then B)",
  );
  await failed.getByRole("button", { name: "Try Again", exact: true }).click();
  await p.locator('[data-message-id="iris-m32"]').waitFor();
  equal([await failed.getAttribute("data-message-id"), asked.posts[1].clientId === asked.posts[0].clientId, asked.posts[3].clientId === asked.posts[0].clientId, asked.posts[2].clientId !== asked.posts[0].clientId, await T(p, "chat-thread").getByText("Send A", { exact: true }).count(), await chatTimeline(p)], ["iris-m32", true, true, true, 1, withRows("iris-m31", "iris-m32")], "A lands as its own row below B with its own clientId, once, and the whole list is in order");
}, /502/);

it("Server Chat: a reopened thread read that answers after a newer read never takes back the bot reply the newer read showed, and his next message lands after it, each row once in time order", MAC, async (p) => {
  let arrived = false;
  const REPLY = { id: "iris-reply", from: "bot", text: "A reply after answer 30.", at: "2026-11-06T00:35:00-05:00", refs: [] };
  await serverBuildChat(p, {
    rows: () => chatPayload("rows.json").map((row) => (row.bot.id === "iris" && arrived ? { ...row, last: REPLY.id, at: REPLY.at, preview: REPLY.text } : row)),
    "iris": (messages) => (arrived ? [...messages, REPLY] : messages),
  });
  const gate = { armed: false };
  const started = new Promise((resolve) => (gate.started = resolve));
  const released = new Promise((resolve) => (gate.release = resolve));
  await p.route((url) => url.pathname === "/captain/api/chat", async (route) => {
    const request = route.request();
    if (!gate.armed || request.method() !== "GET" || new URL(request.url()).searchParams.get("bot") !== "iris") return route.fallback();
    gate.armed = false;
    gate.started();
    await released;
    return chatReply(route, 200, chatPayload("thread-iris-newest.json"));
  });
  await p.addInitScript(() => {
    const Quiet = window.EventSource;
    window.EventSource = class extends Quiet {
      constructor(...args) {
        super(...args);
        window.qdStream = this;
      }
    };
  });
  await chatOpened(p);
  await p.locator('[data-testid="chat-row"][data-id="alba"]').click();
  await p.locator('[aria-label="Chat with alba"]').waitFor();
  gate.armed = true;
  await p.locator('[data-testid="chat-row"][data-id="iris"]').click();
  await started;
  arrived = true;
  await p.evaluate(() => window.qdStream.dispatchEvent(new MessageEvent("refresh", { data: '{"cards":false,"mail":false,"chats":true}' })));
  const reply = p.locator('[data-message-id="iris-reply"]');
  await reply.waitFor({ timeout: 15_000 });
  await p.evaluate(() => {
    window.qdReplyGone = 0;
    new MutationObserver(() => {
      if (!document.querySelector('[data-message-id="iris-reply"]')) window.qdReplyGone += 1;
    }).observe(document.body, { childList: true, subtree: true });
  });
  gate.release();
  await T(p, "chat-input").fill("After the reply.");
  await T(p, "chat-send").click();
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  const ids = (await chatTimeline(p)).filter((item) => item.startsWith("iris-"));
  equal([await reply.count(), await p.evaluate(() => window.qdReplyGone), ids.slice(-3), ids.length === new Set(ids).size], [1, 0, ["iris-m30", "iris-reply", "iris-m31"], true], "the reply on screen, times it left the screen, the last rows in order, each row once");
});

it("Server Chat: with cursor listed, a bot reply that arrives on the refresh is asked for after the newest message on screen and shows once, below it", MAC, async (p) => {
  let arrived = false;
  const REPLY = { id: "iris-reply", from: "bot", text: "A reply after answer 30.", at: "2026-11-06T00:35:00-05:00", refs: [] };
  const asked = await serverBuildChat(p, {
    rows: () => chatPayload("rows.json").map((row) => (row.bot.id === "iris" && arrived ? { ...row, last: REPLY.id, at: REPLY.at, preview: REPLY.text } : row)),
    "iris": (messages) => (arrived ? [...messages, REPLY] : messages),
    shape: (body) => ({ ...body, features: ["cursor"] }),
  });
  await p.addInitScript(() => {
    const Quiet = window.EventSource;
    window.EventSource = class extends Quiet {
      constructor(...args) {
        super(...args);
        window.qdStream = this;
      }
    };
  });
  await chatOpened(p);
  arrived = true;
  await p.evaluate(() => window.qdStream.dispatchEvent(new MessageEvent("refresh", { data: '{"cards":false,"mail":false,"chats":true}' })));
  await p.locator('[data-message-id="iris-reply"]').waitFor({ timeout: 15_000 });
  const ids = (await chatTimeline(p)).filter((item) => item.startsWith("iris-"));
  equal([asked.threads.filter((one) => one.startsWith("iris")), ids.slice(-2), ids.length === new Set(ids).size], [["iris", "iris after iris-m30"], ["iris-m30", "iris-reply"], true], "the iris reads, the last rows in order, each row once");
});

it("Server Chat: leaving the chat while a send is out and coming back shows the same Sending row, and it turns Sent once when the answer lands", MAC, async (p) => {
  const { promise: held, resolve: release } = Promise.withResolvers();
  const asked = await serverBuildChat(p, {
    post: async (route, body, n) => {
      await held;
      return chatReply(route, 200, chatSent(body, n));
    },
  });
  await chatOpened(p);
  await T(p, "chat-input").fill("Please send the sheet.");
  await T(p, "chat-send").click();
  await bubble(p, "Please send the sheet.").getByText("Sending...", { exact: true }).waitFor();
  await p.locator('[data-testid="chat-row"][data-id="alba"]').click();
  await p.locator('[aria-label="Chat with alba"]').waitFor();
  equal(await bubble(p, "Please send the sheet.").count(), 0, "his row is not in another bot's chat");
  await p.locator('[data-testid="chat-row"][data-id="iris"]').click();
  await p.locator('[data-message-id="iris-m30"] [data-message-text]').getByText(CHAT_LAST, { exact: true }).waitFor();
  await bubble(p, "Please send the sheet.").getByText("Sending...", { exact: true }).waitFor();
  release();
  await p.locator('[data-message-id="iris-m31"]').waitFor();
  equal([asked.posts.length, await T(p, "chat-thread").getByText("Please send the sheet.", { exact: true }).count(), await T(p, "chat-thread").getByText("Sending...", { exact: true }).count()], [1, 1, 0], "POSTs, his words once, rows still Sending");
});

const chatTimeline = (p) =>
  T(p, "chat-thread").evaluate((ol) =>
    [...ol.children].map((li) => {
      if (li.dataset.testid === "chat-new") return "new";
      if (li.classList.contains("chat-day")) return "day";
      if (li.querySelector('[data-testid="chat-older"]')) return "older";
      return li.dataset.messageId ?? li.querySelector("[data-message-id]")?.dataset.messageId ?? "other";
    }),
  );
const around = (list, item) => list.slice(Math.max(0, list.indexOf(item) - 1), list.indexOf(item) + 2);
const markPosted = (p) => p.waitForRequest((request) => new URL(request.url()).pathname === "/captain/api/chat/read");

it("Server Chat: the New line sits between the last read message and the first unread one, once, with no day label between them on the same day", MAC, async (p) => {
  await serverBuildChat(p, { shape: (body) => ({ ...body, firstUnread: "iris-m26", features: [] }) });
  await chatOpened(p);
  const list = await chatTimeline(p);
  equal([list.filter((item) => item === "new").length, around(list, "new")], [1, ["iris-m25", "new", "iris-m26"]], "New lines, and its neighbours");
  equal(await T(p, "chat-new").innerText(), "New", "its words");
});

it("Server Chat: when the first unread message starts a new day the day label comes first, then New, then the message", MAC, async (p) => {
  await serverBuildChat(p, {
    "iris": (messages) => messages.map((m) => (Number(m.id.slice(6)) >= 26 ? { ...m, at: m.at.replace("2026-11-06", "2026-11-07") } : m)),
    shape: (body) => ({ ...body, firstUnread: "iris-m26", features: [] }),
  });
  await chatOpened(p);
  const list = await chatTimeline(p);
  equal([list.filter((item) => item === "day").length, around(list, "new")], [2, ["day", "new", "iris-m26"]], "day labels, and the neighbours of New");
});

it("Server Chat: a first unread message older than the loaded page puts New at the top, it moves above that message when Show older loads it, and it stays after the thread is marked read", MAC, async (p) => {
  const asked = await serverBuildChat(p, { shape: (body) => ({ ...body, firstUnread: "iris-m10", features: ["read"] }) });
  const posted = markPosted(p);
  await chatOpened(p);
  await posted;
  equal((await chatTimeline(p)).slice(0, 3), ["older", "new", "day"], "the top of the thread");
  await T(p, "chat-older").click();
  await shown(p, "Iris, question 1: is the export sheet ready?");
  const list = await chatTimeline(p);
  equal([list.filter((item) => item === "new").length, around(list, "new"), asked.reads.length], [1, ["iris-m9", "new", "iris-m10"], 1], "New lines, its neighbours, and mark-read POSTs");
});

for (const [name, shape] of [["missing, as r5 sends it", undefined], ["null", (body) => ({ ...body, firstUnread: null, features: ["read", "quote"] })]])
  it("Server Chat: no New line and no mark-read POST when firstUnread is " + name, MAC, async (p) => {
    const asked = await serverBuildChat(p, { shape });
    await chatOpened(p);
    await p.waitForTimeout(400);
    equal([await T(p, "chat-new").count(), asked.reads.length], [0, 0], "New lines, mark-read POSTs");
  });

it("Server Chat: the New line stays where the thread opened after mark-read succeeds and the held firstUnread turns null, and when he leaves and comes back there is no line", MAC, async (p) => {
  const asked = await serverBuildChat(p, { shape: (body) => ({ ...body, firstUnread: asked.reads.length ? null : "iris-m26", features: ["read"] }) });
  const marked = p.waitForResponse((response) => new URL(response.url()).pathname === "/captain/api/chat/read");
  await chatOpened(p);
  await marked;
  await p.waitForTimeout(300);
  equal(around(await chatTimeline(p), "new"), ["iris-m25", "new", "iris-m26"], "New and its neighbours after mark-read");
  await p.locator('[data-testid="chat-row"][data-id="alba"]').click();
  await p.locator('[aria-label="Chat with alba"]').waitFor();
  await p.locator('[data-testid="chat-row"][data-id="iris"]').click();
  await p.locator('[data-message-id="iris-m30"] [data-message-text]').getByText(CHAT_LAST, { exact: true }).waitFor();
  equal([await T(p, "chat-new").count(), asked.reads.length], [0, 1], "New lines on the second visit, and mark-read POSTs in all");
});

it("Server Chat: a thread with firstUnread and read on is marked read with one POST naming his newest bot message and the sign-in token", MAC, async (p) => {
  const asked = await serverBuildChat(p, { shape: (body) => ({ ...body, firstUnread: "iris-m26", features: ["quote", "read"] }) });
  const posted = markPosted(p);
  await chatOpened(p);
  await posted;
  await p.waitForTimeout(400);
  equal([asked.reads.length, Object.keys(asked.reads[0]), asked.reads[0].bot, asked.reads[0].upTo, typeof asked.reads[0].csrf], [1, ["bot", "upTo", "csrf"], "iris", "iris-m30", "string"], "mark-read POSTs, body keys, bot, upTo, token");
});

it("Server Chat: a reply that arrives while the tab is hidden is read and marked read once when the tab returns, and not before", MAC, async (p) => {
  const asked = await serverBuildChat(p, {
    rows: () => chatPayload("rows.json").map((row) => (row.bot.id === "iris" && asked.kept.length ? { ...row, last: "iris-m31", preview: "A reply while away", unread: true } : row)),
    shape: (body) => ({ ...body, firstUnread: asked.kept.length ? "iris-m31" : null, features: ["read"] }),
  });
  await tabVisibility(p);
  await installSessionClock(p);
  await chatOpened(p);
  await p.evaluate(() => window.qdVisibility("hidden"));
  asked.kept.push({ id: "iris-m31", from: "bot", text: "A reply while away", at: "2026-11-06T00:31:00-05:00", refs: [] });
  await p.clock.runFor(30_000);
  equal(asked.reads.length, 0, "mark-read POSTs while hidden");
  const posted = markPosted(p);
  await p.evaluate(() => window.qdVisibility("visible"));
  for (let step = 0; step < 40 && !asked.reads.length; step += 1) {
    await p.clock.runFor(1_000);
    await p.waitForTimeout(25);
  }
  await posted;
  await p.clock.runFor(30_000);
  equal(asked.reads.map(({ bot, upTo }) => [bot, upTo]), [["iris", "iris-m31"]], "mark-read POSTs after the tab returned");
});

it("Server Chat: a row with unread true shows its dot, and a newer message from another bot shows New message from that bot", MAC, async (p) => {
  let later = false;
  await serverBuildChat(p, {
    rows: () => chatPayload("rows.json").map((row) => (row.bot.id === "alba" ? { ...row, unread: true, ...(later ? { preview: "A newer reply", at: "2026-11-06T00:40:00-05:00", last: "alba-m2" } : {}) } : row)),
  });
  await tabVisibility(p);
  await installSessionClock(p);
  await chatOpened(p);
  const dot = (bot) => p.locator('[data-testid="chat-row"][data-id="' + bot + '"] [aria-label="Unread"]').count();
  await p.locator('[data-testid="chat-row"][data-id="alba"] [aria-label="Unread"]').waitFor();
  equal([await dot("alba"), await dot("iris"), await T(p, "chat-new-message").count()], [1, 0, 0], "dots on Alba and Iris, and arrival cards, at first");
  later = true;
  await p.evaluate(() => window.qdVisibility("hidden"));
  await p.evaluate(() => window.qdVisibility("visible"));
  for (let step = 0; step < 40 && !(await T(p, "chat-new-message").count()); step += 1) {
    await p.clock.runFor(1_000);
    await p.waitForTimeout(25);
  }
  await T(p, "chat-new-message").getByText("New message from alba", { exact: true }).waitFor();
  equal([await dot("alba"), await dot("iris")], [1, 0], "dots on Alba and Iris after the new message");
});

for (const [quiet, words] of [[11, "No word for 10 minutes."], [2, ""]])
  it("Server Chat: seenUpTo and working from the thread show Read under his latest message, which the seen mark covers, and the working line with its note, and " + (words ? "No word for 10 minutes. after eleven quiet minutes" : "no quiet line after two quiet minutes"), MAC, async (p) => {
    const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
    await serverBuildChat(p, { shape: (body) => ({ ...body, seenUpTo: "iris-m29", seenAt: "2026-11-06T00:29:30-05:00", working: { note: "reading the sheet", since: ago(25), updatedAt: ago(quiet) }, firstUnread: null, features: ["seen", "working"] }) });
    await chatOpened(p);
    equal([await T(p, "chat-seen").count(), await p.locator('[data-message-id="iris-m29"] [data-testid="chat-seen"]').count(), (await T(p, "chat-seen").innerText()).startsWith("Read "), await T(p, "chat-delivered").count()], [1, 1, true, 0], "Read lines, on his message 29, its words, no Delivered");
    equal([await T(p, "chat-working-note").innerText(), await T(p, "chat-working-quiet").innerText()], ["reading the sheet", words], "working note and quiet line");
  });

it("Server Chat: with no seen mark from the server, only his latest message says Delivered, his earlier messages show only their time, and nothing says Sent or Seen", MAC, async (p) => {
  await serverBuildChat(p);
  await chatOpened(p);
  const thread = T(p, "chat-thread");
  equal(
    [await T(p, "chat-delivered").count(), await p.locator('[data-message-id="iris-m29"] [data-testid="chat-delivered"]').count(), await p.locator('[data-message-id="iris-m27"] time').count(), await T(p, "chat-seen").count(), await thread.getByText("Sent", { exact: true }).count(), await thread.getByText(/^Seen/).count()],
    [1, 1, 1, 0, 0, 0],
    "Delivered once, under his latest (29); his message 27 keeps its time; no Read, no Sent, no Seen",
  );
});

it("Server Chat off: with --server alone the chat screen is as today and no chat request goes out", MAC, async (p) => {
  const chats = [];
  await p.route((url) => url.pathname.startsWith("/captain/api/chat"), (route) => {
    chats.push(route.request().url());
    return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not found"}' });
  });
  await serverBuild(p, "list-fixed-only.json");
  await open(p, "/chat/iris");
  await shown(p, "No chat with this bot.");
  await p.waitForTimeout(400);
  equal([chats, await T(p, "chat-older").count()], [[], 0], "chat requests, Show older");
});

it("Server Session: a terminal native stream gets exactly one replacement after list 200, then list 403 clears it", PHONE, async (p) => {
  const built = spawnSync(process.execPath, ["tools/build-app.mjs", "--server"], { stdio: "inherit", timeout: 60_000 });
  if (built.status !== 0) throw new Error("server build failed: " + (built.error?.message ?? built.status));
  const body = readFileSync(new URL("./src/data/server-payloads/list-added.json", import.meta.url), "utf8");
  const oldTitle = JSON.parse(body).projects[0].lanes[0].cards[0].title;
  let lists = 0;
  let streams = 0;
  const { promise: refusal, resolve: refuseReplacement } = Promise.withResolvers();
  await p.route("**/captain/cards", (route) => {
    lists += 1;
    return route.fulfill(lists <= 2 ? { status: 200, contentType: "application/json", body } : { status: 403, contentType: "application/json", body: '{"error":"refused"}' });
  });
  await p.route("**/captain/events", async (route) => {
    streams += 1;
    if (streams === 2) await p.evaluate(() => console.log("qd-session-replacement-handled"));
    if (streams > 1) await refusal;
    await route.fulfill({ status: 401, contentType: "text/event-stream", body: "" });
  });
  await p.addInitScript(() => {
    window["qdNativeStates"] = [];
    window.qdNativeCloses = 0;
    window.EventSource = class extends EventSource {
      constructor(url) {
        super(url);
        this.addEventListener("error", () => {
          window["qdNativeStates"].push(this.readyState);
          console.log("qd-session-native-error-" + window["qdNativeStates"].length);
        });
      }
      close() { window.qdNativeCloses += 1; super.close(); }
    };
  });
  await installSessionClock(p);
  const terminal = p.waitForEvent("console", { predicate: (message) => message.text() === "qd-session-native-error-1" });
  await open(p, "/queue");
  await shown(p, oldTitle);
  await terminal;
  equal(await p.evaluate(() => window["qdNativeStates"]), [2], "native terminal readyState");
  const replacement = p.waitForEvent("console", { predicate: (message) => message.text() === "qd-session-replacement-handled" });
  await p.clock.runFor(5_000);
  await replacement;
  equal([lists, streams], [2, 2], "one successful list and exactly one replacement");
  equal(await p.evaluate(() => window.qdNativeCloses), 1, "first native handle disposed once");
  const nextTerminal = p.waitForEvent("console", { predicate: (message) => message.text() === "qd-session-native-error-2" });
  refuseReplacement();
  await nextTerminal;
  await p.clock.runFor(10_000);
  await shown(p, "Signed out");
  equal([lists, streams], [3, 2], "refused classification stops stream recovery");
  equal(await T(p, "card-row").count(), 0, "no old Queue");
  equal(await p.getByText(oldTitle, { exact: true }).count(), 0, "no old private title");
}, /401 \(Unauthorized\)|403 \(Forbidden\)/);

const hiddenSpills = (p) => p.evaluate(() => {
  const spills = [];
  const width = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > width) spills.push("sideways scroll");
  for (const el of document.querySelectorAll("#stage *")) {
    if (!(el instanceof HTMLElement) || !el.checkVisibility()) continue;
    const box = el.getBoundingClientRect();
    const parent = el.parentElement.getBoundingClientRect();
    if (box.left < -0.5 || box.right > width + 0.5 || box.left < parent.left - 0.5 || box.right > parent.right + 0.5) spills.push(el.tagName + " outside its box");
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const text of range.getClientRects()) if (text.left < box.left - 0.5 || text.right > box.right + 0.5 || text.top < box.top - 0.5 || text.bottom > box.bottom + 0.5) spills.push(el.tagName + " clipped text");
    }
  }
  return spills;
});
const assertHiddenFits = async (p) => equal(await hiddenSpills(p), [], "hidden state has overflow or clipped text");

for (const [name, size] of [["phone", PHONE], ["Mac", MAC], ["iPad-upright", { viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true }], ["iPad-sideways", TOUCH_SIDEWAYS]]) {
  it("Server Session on " + name + ": expiry unmounts private screens, keeps local data and Retry restores only a fresh list", size, async (p) => {
    await serverBuild(p, "list-added.json");
    const listing = JSON.parse(readFileSync(new URL("./src/data/server-payloads/list-added.json", import.meta.url), "utf8"));
    const detail = JSON.parse(readFileSync(new URL("./src/data/server-payloads/card-open.json", import.meta.url), "utf8"));
    const oldTitle = listing.projects[0].lanes[0].cards[0].title;
    const headers = [];
    const detailResponses = [];
    p.on("response", (response) => {
      if (new URL(response.url()).pathname === "/captain/cards/alba-1") detailResponses.push(response.json().then((body) => ({ status: response.status(), title: body.card?.title })));
    });
    let offline = false;
    let fresh = false;
    await p.route("**/captain/cards", (route) => {
      headers.push(route.request().headers());
      if (offline) return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline"}' });
      if (fresh) listing.projects[0].lanes[0].cards[0].title = "Only the freshly confirmed Queue";
      return route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: '"hidden-list"' }, body: JSON.stringify(listing) });
    });
    await p.route("**/captain/cards/alba-1", (route) => {
      if (fresh) detail.card.title = "Only the freshly confirmed Queue";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail) });
    });
    await p.addInitScript(() => {
      window.qdConfirmation = 0;
      window.qdRequestTrace = [];
      const send = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const sent = Date.now();
        const entry = { path: String(args[0]), sent, status: null, received: null };
        if (entry.path.startsWith("/captain/")) window.qdRequestTrace.push(entry);
        const response = await send(...args);
        entry.status = response.status;
        entry.received = Date.now();
        if (String(args[0]).startsWith("/captain/") && (response.status === 200 || response.status === 304)) window.qdConfirmation = Math.max(window.qdConfirmation, sent);
        return response;
      };
      window.EventSource = class extends EventTarget {
        readyState = 1;
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
        close() { this.readyState = 2; }
      };
      localStorage.setItem("qd.seen", '{"alba-1":"2026-11-02T15:00:00.000Z"}');
      localStorage.setItem("qd.settings", '{"appearance":"dark"}');
    });
    await installSessionClock(p);
    await p.clock.setFixedTime(new Date("2026-11-05T12:00:01Z"));
    const cardRequest = p.waitForRequest("**/captain/cards/alba-1");
    await open(p, "/queue/alba-1");
    await cardRequest;
    await T(p, "option").nth(2).waitFor();
    const kept = await p.evaluate(() => [localStorage.getItem("qd.seen"), localStorage.getItem("qd.settings")]);
    offline = true;
    const frozen = await p.evaluate(() => Date.now());
    const firstLoad = await p.evaluate(() => window.qdRequestTrace);
    equal(firstLoad.length > 0, true, "the first load sent requests");
    equal(firstLoad.map((request) => request.sent - frozen), firstLoad.map(() => 0), "every request of the first load is stamped at the one frozen time, so the app's bound and the case's bound are one instant");
    await p.clock.pauseAt(new Date(frozen));
    await p.clock.setSystemTime(new Date(frozen));
    const untilBound = await p.evaluate(() => window.qdConfirmation + 60_999 - Date.now());
    equal(untilBound > 0, true, "ready view is still inside its confirmation bound");
    await p.clock.runFor(untilBound);
    equal(await T(p, "option").count(), 3, "same-session detail remains inside the bound");
    await p.clock.runFor(1);
    await shown(p, "Could not load this screen.");
    equal(await p.locator('[data-testid="card-row"],[data-testid="task-card"],aside,[data-pop]').count(), 0, "all private consumers unmounted");
    equal(await p.getByText(oldTitle, { exact: true }).count(), 0, "old title removed");
    equal(await p.getByRole("button", { name: "Sign in with Google" }).count(), 0, "expiry is not a sign-in refusal");
    equal(await p.evaluate(() => [localStorage.getItem("qd.seen"), localStorage.getItem("qd.settings")]), kept, "local data preserved");
    const injected = await p.getByRole("alert").evaluate((el) => {
      const spill = document.createElement("span");
      spill.dataset.sessionSpill = "";
      spill.style.cssText = "display:block;flex:none;width:200vw;min-width:200vw";
      spill.textContent = "A real overflowing test row";
      el.append(spill);
      return { width: spill.getBoundingClientRect().width, viewport: document.documentElement.clientWidth };
    });
    equal(injected.width > injected.viewport, true, "negative control really exceeds the viewport");
    await assert.rejects(() => assertHiddenFits(p), /hidden state has overflow or clipped text/);
    console.log("red overflow control rejected at " + size.viewport.width + "x" + size.viewport.height);
    await p.locator("[data-session-spill]").evaluate((el) => el.remove());
    await assertHiddenFits(p);
    if (process.env.QD_SESSION_SHOTS) await p.screenshot({ path: process.env.QD_SESSION_SHOTS + "/hidden-" + name + ".png", fullPage: true });
    offline = false;
    fresh = true;
    const recovery = headers.length;
    await p.getByRole("button", { name: "Retry" }).evaluate((button) => {
      window.qdRetryAt = null;
      button.addEventListener("click", () => { window.qdRetryAt = Date.now(); }, { once: true, capture: true });
    });
    await p.clock.resume();
    await p.getByRole("button", { name: "Retry" }).click();
    await T(p, "option").nth(2).waitFor();
    await shown(p, "Only the freshly confirmed Queue");
    equal("if-none-match" in headers[recovery], false, "Retry has no pre-hide ETag");
    equal(await p.getByText(oldTitle, { exact: true }).count(), 0, "old title never returns");
    const trace = await p.evaluate(() => ({ click: window.qdRetryAt, requests: window.qdRequestTrace }));
    const after = trace.requests.filter((request) => request.path === "/captain/cards/alba-1" && request.sent >= trace.click);
    equal(after.map((request) => request.status), [200], "one actual post-Retry detail GET");
    equal(await Promise.all(detailResponses), [{ status: 200, title: oldTitle }, { status: 200, title: "Only the freshly confirmed Queue" }], "fresh current detail comes from the new HTTP response");
    console.log("Retry fresh transport " + size.viewport.width + "x" + size.viewport.height + ": " + JSON.stringify({ click: trace.click, detail: after }));
  }, /503 \(Service Unavailable\)/);
}

for (const [name, size, status] of [["phone", PHONE, 401], ["Mac", MAC, 403], ["iPad-upright", { viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true }, 401], ["iPad-sideways", TOUCH_SIDEWAYS, 403]]) {
  for (const aborted of [false, true]) it("Server Session 229 on " + name + (aborted ? ": a held answer that is aborted after another channel ends the session restores nothing and navigates nowhere" : ": a held answer cannot restore an old receipt or navigate after another channel ends the session"), size, async (p) => {
    const detailReads = [];
    p.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path === "/captain/cards/alba-1") detailReads.push(response.json().then((body) => ({ status: response.status(), title: body.card?.title }), () => ({ status: response.status(), unreadable: true })));
    });
    await serverBuild(p, "list-added.json");
    const listing = JSON.parse(readFileSync(new URL("./src/data/server-payloads/list-added.json", import.meta.url), "utf8"));
    const detail = JSON.parse(readFileSync(new URL("./src/data/server-payloads/card-open.json", import.meta.url), "utf8"));
    const receipt = readFileSync(new URL("./src/data/server-payloads/answer/answer-200-current.json", import.meta.url), "utf8");
    const oldTitle = detail.card.title;
    const freshTitle = "Only the new account's card";
    for (const project of listing.projects) for (const lane of project.lanes) lane.cards = lane.cards.filter((card) => card.id === "alba-1");
    let refuse = false;
    let fresh = false;
    let posts = 0;
    await p.route("**/captain/cards", (route) => {
      if (refuse) return route.fulfill({ status, contentType: "application/json", body: '{"error":"session ended"}' });
      if (fresh) for (const project of listing.projects) for (const lane of project.lanes) for (const card of lane.cards) card.title = freshTitle;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(listing) });
    });
    await p.route("**/captain/cards/alba-1", (route) => {
      if (fresh) detail.card.title = freshTitle;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail) });
    });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await p.route("**/captain/cards/alba-1/answer", async (route) => {
      posts += 1;
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: receipt });
    });
    await tabVisibility(p);
    await installSessionClock(p);
    await open(p, "/queue/alba-1");
    await T(p, "option").nth(2).waitFor();
    await T(p, "note").fill("A private answer from the old account");
    await T(p, "option").first().click();
    const asked = p.waitForRequest("**/captain/cards/alba-1/answer");
    await T(p, "send").click();
    await asked;
    refuse = true;
    const exited = p.waitForResponse((response) => new URL(response.url()).pathname === "/captain/cards" && response.status() === status);
    await p.evaluate(() => window.qdVisibility("hidden"));
    await p.evaluate(() => window.qdVisibility("visible"));
    await p.clock.runFor(5_000);
    await exited;
    await shown(p, "Signed out");
    equal(await T(p, "task-card").count(), 0, "session exit closes the private Task Card");
    equal(await p.getByText(oldTitle, { exact: true }).count(), 0, "old title hidden on exit");
    await assertHiddenFits(p);
    await p.waitForURL("**/queue");
    const atExit = new URL(p.url()).pathname;
    if (aborted) {
      const cancelled = p.waitForEvent("requestfailed", (request) => new URL(request.url()).pathname === "/captain/cards/alba-1/answer");
      await p.clock.runFor(16_000);
      await cancelled;
    } else {
      const answered = p.waitForResponse("**/captain/cards/alba-1/answer");
      release();
      const response = await answered;
      equal(response.status(), 200, "the held old answer really receives a successful response");
      await response.finished();
    }
    refuse = false;
    fresh = true;
    await p.clock.runFor(61_000);
    await shown(p, freshTitle);
    equal(await p.getByText(/^Got it:/).count(), 0, "fresh recovery never shows the old private answer receipt");
    equal(new URL(p.url()).pathname, atExit, "the old completion cannot navigate the closed Task Card");
    if (size.viewport.width < 1000) await T(p, "card-row").getByRole("link", { name: freshTitle, exact: true }).click();
    await T(p, "option").nth(2).waitFor();
    equal((await Promise.all(detailReads)).some((read) => read.status === 200 && read.title === freshTitle), true, "the recovered card comes from an actual fresh detail response");
    equal(await p.getByText(oldTitle, { exact: true }).count(), 0, "the fresh Task Card carries no old private title");
    equal(await T(p, "note").inputValue(), "", "the old failure continuation cannot restore the private answer draft");
    equal(await T(p, "send-failed").count(), 0, "the closed answer cannot leave a failed step in the fresh account");
    equal(posts, 1, "session recovery does not replay the old answer");
    console.log("229 held POST -> " + status + " exit -> " + (aborted ? "abort at 20 s" : "200") + " -> fresh recovery: no receipt, draft or navigation at " + size.viewport.width + "x" + size.viewport.height);
  }, /40[13] \((Unauthorized|Forbidden)\)/);
}

it(
  "Server Mail: when the session can't be confirmed on Mail, the screen says Your Mail is hidden until we can confirm it is still you. with Retry, and Retry with a fresh list brings Mail back with his search kept",
  PHONE,
  async (p) => {
    await serverBuild(p, "list-fixed-only.json");
    const body = readFileSync(new URL("./src/data/server-payloads/list-fixed-only.json", import.meta.url), "utf8");
    let offline = false;
    await p.route("**/captain/cards", (route) => (offline ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline"}' }) : route.fulfill({ status: 200, contentType: "application/json", body })));
    const mail = JSON.parse(readFileSync(new URL("./src/data/server-payloads/mail/list-5-threads.json", import.meta.url), "utf8"));
    await p.route("**/captain/mail", (route) => (offline ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline"}' }) : route.fulfill({ status: mail.status, headers: { "Content-Type": mail.headers["Content-Type"], ETag: mail.headers.ETag }, body: JSON.stringify(mail.body) })));
    await installSessionClock(p);
    await open(p, "/mail");
    await T(p, "mail-search").fill("zebra");
    offline = true;
    await p.clock.runFor(62_000);
    await p.getByRole("alert").first().waitFor();
    const hidden = p.getByRole("alert").filter({ hasText: "Your Mail is hidden until we can confirm it is still you." });
    equal([await hidden.count(), await T(p, "mail-search").count()], [1, 0], "the hidden words, and Mail gone");
    offline = false;
    await p.clock.resume();
    await hidden.getByRole("button", { name: "Retry" }).click();
    await T(p, "mail-search").waitFor();
    equal(await T(p, "mail-search").inputValue(), "zebra", "his search kept");
  },
  /503 \(Service Unavailable\)/,
);

it("Server Session: a hidden tab sends nothing for five minutes, its private data leaves quietly at the bound, and on return one list read brings it back with no tap", PHONE, async (p) => {
  await serverBuild(p, "list-fixed-only.json");
  const body = readFileSync(new URL("./src/data/server-payloads/list-fixed-only.json", import.meta.url), "utf8");
  let lists = 0;
  await p.route("**/captain/cards", (route) => {
    lists += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body });
  });
  await tabVisibility(p);
  await p.addInitScript(() => {
    window.qdStreams = [];
    window.EventSource = class extends EventTarget {
      readyState = 0;
      constructor() {
        super();
        window.qdStreams.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        });
      }
      close() { this.readyState = 2; }
    };
  });
  await installSessionClock(p);
  await open(p, "/queue");
  await T(p, "card-row").first().waitFor();
  const before = lists;
  await p.evaluate(() => window.qdVisibility("hidden"));
  await p.clock.runFor(300_000);
  equal([lists - before, await p.evaluate(() => window.qdStreams.filter((stream) => stream.readyState !== 2).length)], [0, 0], "lists sent and streams open while hidden");
  await T(p, "card-row").first().waitFor({ state: "detached" });
  equal([(await p.getByRole("status", { name: "Loading" }).count()) > 0, await p.getByRole("alert").count(), await p.getByRole("button", { name: "Sign in with Google" }).count()], [true, 0, 0], "past the bound: rows gone, loading bars, no error or hidden state, no sign-in");
  await p.clock.resume();
  await p.evaluate(() => window.qdVisibility("visible"));
  await T(p, "card-row").first().waitFor();
  equal(lists - before, 1, "one list read on return");
});

const serverMotionCase = (name, size, steps) =>
  it("Motion on a server build: " + name, size, async (p) => {
    await serverBuild(p, "list-fixed-only.json");
    const list = readFileSync(new URL("./src/data/server-payloads/list-fixed-only.json", import.meta.url), "utf8");
    await motionPair(
      p,
      size,
      async (page, m) => {
        await page.route("**/captain/cards", (route) => route.fulfill({ status: 200, contentType: "application/json", body: list }));
        await page.addInitScript(() => {
          window.EventSource = class extends EventTarget {
            close() {}
          };
        });
        await installSessionClock(page);
        await steps(page, m);
      },
      motionPage(),
    );
  });

serverMotionCase("a card read shows its loading state as the Queue slides away, the read leaves before the change ends, and content that lands during it cross-fades only the body", PHONE, async (p, m) => {
  const body = readFileSync(new URL("./src/data/server-payloads/card-open.json", import.meta.url), "utf8");
  const reads = [];
  let held = null;
  await p.route("**/captain/cards/alba-1", async (route) => {
    reads.push(route.request().method());
    if (held) await held.promise;
    await route.fulfill({ status: 200, contentType: "application/json", body });
  });
  const row = p.locator('[data-testid="card-row"][data-id="alba-1"] a');
  await open(p, "/queue");
  await row.tap();
  await T(p, "option").nth(2).waitFor();
  await settle(p);
  await p.getByRole("link", { name: /^Queue · \d+ waiting$/ }).tap();
  await row.waitFor();
  await settle(p);
  held = Promise.withResolvers();
  const resume = await m.hold();
  await row.tap();
  await m.during("the card read starts", "view-transition", async () => {
    equal([await moveOf(p), await T(p, "card-loading").count(), reads.length], ["screen forward live", 1, 2], "the loading card is live as the Queue slides away, and its read has already left");
  });
  held.resolve();
  await T(p, "option").nth(2).waitFor();
  await m.during("the content lands during the slide", '[data-testid="task-card"] article', async () => {
    equal(shapesOf(await animationsOf(T(p, "task-card").locator("article"))), [STANDARD + " opacity"], "the body cross-fades in at the standard speed");
    equal(await animationsOf(p.getByRole("link", { name: /^Queue · \d+ waiting$/ })), [], "the head and its Back link stay still");
  });
  await resume();
  await settle(p);
});

serverMotionCase("an answer's request leaves before any motion, and the screen change follows its receipt", PHONE, async (p, m) => {
  await cardRead(p, "alba-1", []);
  const receipt = readFileSync(new URL("./src/data/server-payloads/answer/answer-200-current.json", import.meta.url), "utf8");
  const held = Promise.withResolvers();
  await p.route("**/captain/cards/alba-1/answer", async (route) => {
    await held.promise;
    await route.fulfill({ status: 200, contentType: "application/json", body: receipt });
  });
  await open(p, "/queue");
  await p.locator('[data-testid="card-row"][data-id="alba-1"] a').tap();
  await T(p, "option").nth(2).waitFor();
  await settle(p);
  const starts = await viewTransitionCalls(p);
  const asked = p.waitForRequest("**/captain/cards/alba-1/answer");
  await T(p, "send").tap();
  await asked;
  equal([await viewTransitionCalls(p), await moveOf(p)], [starts, null], "the answer left with no screen change started");
  held.resolve();
  await T(p, "got-it").waitFor();
  await settle(p);
  if (!m.still) equal((await viewTransitionCalls(p)) > starts, true, "the screen change runs once the receipt is in");
});

serverMotionCase("Mail threads that arrive by the live stream fade in where they land with no slide, and a thread that goes folds out", PHONE, async (p, m) => {
  const mail = JSON.parse(readFileSync(new URL("./src/data/server-payloads/mail/list-5-threads.json", import.meta.url), "utf8"));
  const lists = [mail.body.threads.filter((one) => one.ref !== "MT-4"), mail.body.threads, mail.body.threads.filter((one) => one.ref !== "MT-5")];
  let phase = 0;
  await p.route("**/captain/mail", (route) => route.fulfill({ status: 200, headers: { "Content-Type": mail.headers["Content-Type"], ETag: '"phase-' + phase + '"' }, body: JSON.stringify({ ...mail.body, threads: lists[phase] }) }));
  await p.addInitScript(() => {
    const Quiet = window.EventSource;
    window.EventSource = class extends Quiet {
      constructor(...args) {
        super(...args);
        window.qdStream = this;
      }
    };
  });
  await open(p, "/mail");
  await T(p, "mail-row").nth(3).waitFor();
  await settle(p);
  const list = T(p, "mail-list");
  const moving = () => list.locator("li").evaluateAll((items) => items.map((item) => item.getAnimations({ subtree: true }).length));
  const refresh = async (next) => {
    phase = next;
    await p.evaluate(() => window.qdStream.dispatchEvent(new MessageEvent("refresh", { data: '{"cards":false,"mail":true}' })));
    await p.clock.runFor(6_000);
  };
  let resume = await m.hold();
  await refresh(1);
  await p.locator('[data-testid="mail-row"][data-id="MT-4"]').waitFor();
  await m.during("the new thread lands", '[data-testid="mail-list"]', async () => {
    equal((await moving()).filter(Boolean).length, 1, "only the new row moves");
    equal(shapesOf(await animationsOf(list)), [STANDARD + " opacity"], "it only fades in, at the standard speed");
  });
  await resume();
  await settle(p);
  equal(await T(p, "mail-row").count(), 5, "five threads");
  resume = await m.hold();
  await refresh(2);
  const went = list.locator("li").filter({ has: p.locator('[data-id="MT-5"]') });
  await m.during("the thread leaves", '[data-testid="mail-list"]', async () => {
    const row = await animationsOf(went);
    equal([row.length > 0, row.every((one) => one.duration === QUICK && one.properties.includes("height") && one.properties.includes("opacity"))], [true, true], "the thread that went folds out at the quick speed");
    equal((await animationsOf(list)).filter((one) => one.properties.some((name) => ["translate", "transform"].includes(name))), [], "no row slides");
  });
  await resume();
  await settle(p);
  equal([await T(p, "mail-row").count(), await went.count()], [4, 0], "four threads, and the one that went is out");
});

it("Motion on a server build with chat on: his message rises from the box at once as Sending and keeps rising when it reads Sent, once at the standard speed, and Show older keeps every row already shown with nothing moving", PHONE, (p) =>
  motionPair(
    p,
    PHONE,
    async (page, m) => {
      await installSessionClock(page);
      const { promise: held, resolve: release } = Promise.withResolvers();
      await serverBuildChat(page, {
        post: async (route, body, n) => {
          await held;
          return chatReply(route, 200, chatSent(body, n));
        },
      });
      await chatOpened(page);
      await settle(page);
      const kept = await page.locator('[data-message-id="iris-m30"]').elementHandle();
      const moving = (rows) => rows.evaluateAll((items) => items.map((item) => item.getAnimations().length > 0));
      const before = await T(page, "chat-my-message").count();
      await T(page, "chat-input").fill("Please send the sheet.");
      const resume = await m.hold();
      await T(page, "chat-send").tap();
      const row = bubble(page, "Please send the sheet.");
      await row.getByText("Sending...", { exact: true }).waitFor();
      const rising = await row.elementHandle();
      await m.during("his Sending message", '[data-testid="chat-my-message"]', async () => {
        equal(shapesOf(await animationsOf(row)), [STANDARD + " opacity", STANDARD + " translate"], "it rises and fades in at the standard speed");
        equal(await moving(T(page, "chat-my-message")), [...Array(before).fill(false), true], "only his new message moves");
        equal(await animationsOf(T(page, "chat-bot-message")), [], "no bot message already there moves");
      });
      release();
      const sent = page.locator('[data-message-id="iris-m31"]');
      await sent.waitFor();
      equal(await rising.evaluate((el) => [el.isConnected, el.getAttribute("data-message-id")]), [true, "iris-m31"], "the row that was Sending is the row that reads Sent");
      await m.during("his confirmed message", '[data-message-id="iris-m31"]', async () => {
        equal(shapesOf(await animationsOf(sent)), [STANDARD + " opacity", STANDARD + " translate"], "it is still rising, at the standard speed");
        equal(await animationsOf(T(page, "chat-thread").locator(':scope > li:not([data-message-id="iris-m31"])')), [], "nothing already there moves");
      });
      await resume();
      await settle(page);
      const freed = await m.hold();
      await T(page, "chat-older").tap();
      await shown(page, "Iris, question 1: is the export sheet ready?");
      await frames(page);
      equal([await kept.evaluate((el) => el.isConnected), await animationsOf(T(page, "chat-thread").locator(":scope > li"))], [true, []], "after Show older: the rows already shown are the same rows, and nothing moves");
      await freed();
    },
    motionPage(),
  ),
);

const MAIL_PATH = /^\/captain\/mail(?:\/MT-[1-9][0-9]{0,8})?$/;

const mailRefusal = (message) => {
  const { url } = message.location();
  return message.text() === "Failed to load resource: the server responded with a status of 404 (Not Found)" && url !== "" && MAIL_PATH.test(new URL(url).pathname);
};

const requested = process.argv.slice(2);
const selected = cases.filter(({ name }) => !requested.length || requested.some((filter) => name.includes(filter)));
if (!selected.length) {
  server.kill();
  throw new Error("No app behaviours match the requested filters.");
}

const browser = await chromium.launch(chromeLaunchOptions({ args: ["--no-sandbox"] }));
const failed = [];
const runCase = async (item) => {
  const context = await browser.newContext({ colorScheme: "dark", ...item.size, reducedMotion: "reduce" });
  await context.route((url) => MAIL_PATH.test(url.pathname), (route) => route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not found"}' }));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && !mailRefusal(message) && !(item.allow && item.allow.test(message.text())) && errors.push(message.text()));
  try {
    await item.run(page);
    const unexpected = errors.filter((message) => !item.allow?.test(message));
    if (unexpected.length) throw new Error("console errors: " + unexpected.join(" | "));
    console.log("ok   " + item.name);
  } catch (error) {
    failed.push(item.name);
    console.log("FAIL " + item.name + "\n     " + String(error?.message ?? error).split("\n").slice(0, 8).join("\n     "));
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
};
const workers = Math.max(1, Number.parseInt(process.env.QD_APP_WORKERS ?? "", 10) || 1);
const alone = selected.filter((item) => /clipboard|copiedByKey|serverBuild|build-app/.test(item.run.toString()));
const together = workers > 1 ? selected.filter((item) => !alone.includes(item)) : [];
if (workers > 1) console.log(`app: ${together.length} behaviours in ${workers} parallel contexts, then ${alone.length} one at a time: ${alone.map(({ name }) => name).join(" | ")}`);
try {
  await Promise.all(Array.from({ length: workers }, async () => {
    for (let item = together.shift(); item; item = together.shift()) await runCase(item);
  }));
  for (const item of workers > 1 ? alone : selected) await runCase(item);
} finally {
  await browser.close();
  server.kill();
}
console.log(`app: ${selected.length - failed.length} of ${selected.length} behaviours pass`);
process.exit(failed.length ? 1 : 0);
