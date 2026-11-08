(() => {
  if (window.qdProbe) return;
  const DRAFT = "First line of the draft\nsecond line ";
  const KEYS = [..."and it keeps on going", "\n", ..."then the line ends"];
  const real = {
    height: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight").get,
    top: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
    scrollTo: window.scrollTo,
  };
  const round = (value) => Math.round(value * 10) / 10;
  const list = () => document.querySelector('[data-testid="chat-thread"]');
  const box = () => document.querySelector('[data-testid="chat-input"]');
  const dock = () => document.querySelector(".chat-composer-dock");
  const items = () => [...(list()?.children ?? [])];
  const scroller = () => {
    for (let node = list(); node && node !== document.body; node = node.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(node).overflowY) && real.height.call(node) > node.clientHeight + 1) return node;
    }
    return null;
  };
  const listTop = () => {
    const pane = scroller();
    return pane ? real.top.get.call(pane) : 0;
  };
  const shift = () => (window.visualViewport ? window.visualViewport.offsetTop : 0);
  const where = () => ({ window: window.scrollY, list: listTop() });
  const fresh = () => ({ dock: Infinity, page: Infinity, list: Infinity });
  const painted = () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));
  const settled = async () => {
    await painted();
    await painted();
  };
  let seen = where();
  let lows = fresh();
  let mode = "";
  let first = null;
  let records = [];
  let frames = [];
  let moves = [];
  let recording = false;

  const note = (by, before) => {
    const now = where();
    for (const part of ["window", "list"]) if (now[part] !== before[part]) moves.push({ by, part, from: round(before[part]), to: round(now[part]) });
    seen = now;
  };
  for (const [owner, name] of [
    [Element.prototype, "scrollIntoView"],
    [Element.prototype, "scrollTo"],
    [Element.prototype, "scrollBy"],
    [window, "scrollTo"],
    [window, "scrollBy"],
  ]) {
    const call = owner[name];
    owner[name] = function (...args) {
      const before = where();
      const result = call.apply(this, args);
      note(name, before);
      return result;
    };
  }
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get() {
      return real.top.get.call(this);
    },
    set(value) {
      const before = where();
      real.top.set.call(this, value);
      note("scrollTop", before);
    },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get() {
      const value = real.height.call(this);
      if (this instanceof HTMLTextAreaElement && this.dataset.testid === "chat-input") {
        const composer = dock();
        const thread = list();
        if (composer) lows.dock = Math.min(lows.dock, composer.getBoundingClientRect().height);
        lows.page = Math.min(lows.page, real.height.call(document.documentElement));
        if (thread) lows.list = Math.min(lows.list, real.height.call(thread));
      }
      return value;
    },
  });
  addEventListener(
    "scroll",
    () => {
      const now = where();
      for (const part of ["window", "list"]) if (now[part] !== seen[part]) moves.push({ by: "browser", part, from: round(seen[part]), to: round(now[part]) });
      seen = now;
    },
    { capture: true, passive: true },
  );

  const read = (key) => {
    const view = window.visualViewport;
    const offset = shift();
    const thread = list();
    const pane = scroller();
    const last = items().at(-1)?.getBoundingClientRect();
    const composer = dock()?.getBoundingClientRect();
    const mark = document.querySelector("[data-qd-mark]")?.getBoundingClientRect();
    return {
      key,
      y: round(window.scrollY),
      list: round(listTop()),
      end: pane ? round(real.height.call(pane) - pane.clientHeight - real.top.get.call(pane)) : null,
      newest: last ? round(last.bottom - offset) : null,
      top: composer ? round(composer.top - offset) : null,
      bottom: composer ? round(composer.bottom - offset) : null,
      read: mark ? round(mark.top - offset) : null,
      vh: round(view ? view.height : window.innerHeight),
      vtop: round(offset),
      dock: composer ? round(composer.height) : null,
      page: real.height.call(document.documentElement),
      height: thread ? real.height.call(thread) : null,
    };
  };

  const loop = async () => {
    while (recording) {
      await painted();
      if (recording) frames.push(read(""));
    }
  };

  const line = (s) =>
    [
      JSON.stringify(s.key),
      "y " + s.y,
      "list " + s.list,
      "to end " + s.end,
      "newest " + s.newest,
      "composer " + s.top + " to " + s.bottom,
      ...(s.read === null ? [] : ["read " + s.read]),
      "vv " + s.vh + "@" + s.vtop,
      "dock " + s.dock,
      "page " + s.page,
      "list height " + s.height,
    ].join("  ");

  window.qdProbe = Object.freeze({
    DRAFT,
    KEYS,
    settled,
    async draft() {
      const input = box();
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, DRAFT);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settled();
      return box()?.value === DRAFT;
    },
    toEnd() {
      const thread = scroller();
      if (thread) real.top.set.call(thread, real.height.call(thread));
      else real.scrollTo.call(window, 0, real.height.call(document.documentElement));
      seen = where();
    },
    upBy(px) {
      const thread = scroller();
      if (thread) real.top.set.call(thread, real.top.get.call(thread) - px);
      else real.scrollTo.call(window, 0, window.scrollY - px);
      seen = where();
      return thread ? { top: real.top.get.call(thread), max: real.height.call(thread) - thread.clientHeight } : { top: window.scrollY, max: real.height.call(document.documentElement) - window.innerHeight };
    },
    keyboard(ms) {
      return new Promise((done) => {
        const until = performance.now() + ms;
        const look = () => {
          const full = Math.max(window.innerHeight, document.documentElement.clientHeight);
          const height = window.visualViewport ? window.visualViewport.height : full;
          if (height < full - 100) return done(true);
          if (performance.now() > until) return done(false);
          requestAnimationFrame(look);
        };
        look();
      });
    },
    start(next) {
      mode = next;
      const input = box();
      if (input && document.activeElement === input) input.setSelectionRange(input.value.length, input.value.length);
      for (const old of document.querySelectorAll("[data-qd-mark]")) old.removeAttribute("data-qd-mark");
      if (mode === "reading") {
        const thread = list();
        const floor = Math.max(0, (thread ? thread.getBoundingClientRect().top : 0) - shift());
        const row = items().find((item) => item.getBoundingClientRect().top - shift() >= floor);
        if (row) row.dataset.qdMark = "1";
      }
      lows = fresh();
      frames = [];
      moves = [];
      seen = where();
      first = { ...read(""), low: null, frames: [], moves: [], count: items().length, text: input ? input.value : "", scroller: scroller() ? "list" : "window" };
      records = [first];
      if (!recording) {
        recording = true;
        loop();
      }
      const { frames: _frames, moves: _moves, ...shown } = first;
      return shown;
    },
    take(key) {
      const at = (value) => (value === Infinity ? null : round(value));
      const now = { ...read(key), low: { dock: at(lows.dock), page: at(lows.page), list: at(lows.list) }, frames: frames.map((f) => ({ ...f, key })), moves: moves.map((m) => ({ ...m, key })) };
      lows = fresh();
      frames = [];
      moves = [];
      records.push(now);
      return { ...now, frames: now.frames.length, moves: now.moves.length };
    },
    records: () => records,
    verdict() {
      recording = false;
      const fails = [];
      const said = new Set();
      const say = (rule, n, kind, text) => {
        if (said.has(n + " " + kind)) return;
        said.add(n + " " + kind);
        fails.push({ rule, line: (n ? JSON.stringify(records[n].key) + ", key " + n + ": " : "") + text });
      };
      for (let n = 1; n < records.length; n++) {
        const before = records[n - 1];
        const after = records[n];
        for (const [low, field, name] of [
          ["dock", "dock", "composer"],
          ["page", "page", "page"],
          ["list", "height", "thread list"],
        ]) {
          const value = after.low[low];
          if (value === null || before[field] === null || after[field] === null) continue;
          if (value < Math.min(before[field], after[field]) - 0.5) say("shrink", n, low, `the ${name} was ${value} px while the box measured, ${before[field]} before the key and ${after[field]} after`);
        }
        for (const s of [...after.frames, after]) {
          const at = s === after ? "after the key" : "in a painted frame";
          if (mode === "end") {
            if (Math.abs(s.bottom - before.bottom) > 8) say("move", n, "bottom", `the composer's bottom went from ${before.bottom} to ${s.bottom} ${at}`);
            const was = round(before.top - before.newest);
            const gap = round(s.top - s.newest);
            if (Math.abs(gap - was) > 8) say("move", n, "gap", `the newest message moved off the composer, gap ${was} to ${gap} ${at}`);
          }
          if (mode === "reading" && (s.read === null || first.read === null || Math.abs(s.read - first.read) > 1)) say("move", n, "read", `the message being read went from ${first.read} to ${s.read} ${at}`);
        }
      }
      const input = box();
      const typed = first.text + KEYS.join("");
      if (records.length - 1 !== KEYS.length) say("text", 0, "count", `${records.length - 1} keys were taken, not ${KEYS.length}`);
      if (!input || input.value !== typed) say("text", 0, "value", `the box holds ${JSON.stringify(input ? input.value : null)}, not the draft and the keys`);
      if (items().length !== first.count) say("text", 0, "sent", `the thread went from ${first.count} rows to ${items().length}: a key sent the message`);
      const rows = [];
      for (const record of records) {
        let last = "";
        for (const f of record.frames) {
          const text = "  frame " + line(f);
          if (text !== last) rows.push(text);
          last = text;
        }
        for (const m of record.moves) rows.push(`  scroll ${m.part} by ${m.by}: ${m.from} to ${m.to}`);
        rows.push("key " + line(record) + (record.low ? `  while measuring: composer ${record.low.dock}, page ${record.low.page}, list ${record.low.list}` : ""));
      }
      const env = {
        mode,
        scroller: first.scroller,
        size: window.innerWidth + " x " + window.innerHeight,
        anchoring: CSS.supports("overflow-anchor", "auto"),
        agent: navigator.userAgent,
      };
      return { fails, rows, env };
    },
  });
})();
