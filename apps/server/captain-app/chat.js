(() => {
  "use strict";

  const botSelect = document.getElementById("bot");
  const composer = document.getElementById("composer");
  const messageInput = document.getElementById("message");
  const reloadButton = document.getElementById("reload");
  const status = document.getElementById("status");
  const thread = document.getElementById("thread");
  const typing = document.getElementById("typing");
  const note = document.getElementById("note");
  const newer = document.getElementById("newer");
  const freshness = document.getElementById("freshness");
  const alertLine = document.getElementById("alert");
  const soundButton = document.getElementById("sound");
  const baseTitle = document.title || "Quarterdeck chat";
  const easternClock = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
  });
  let freshUntil = 0;
  let freshnessTimer = null;

  function renderFreshness(until) {
    clearTimeout(freshnessTimer);
    freshUntil = Number.isFinite(until) ? until : 0;
    const remaining = freshUntil * 1000 - Date.now();
    if (remaining > 0) {
      freshness.textContent = `Fresh sign-in until ${easternClock.format(new Date(freshUntil * 1000))} ET`;
      freshnessTimer = setTimeout(() => renderFreshness(freshUntil), remaining + 10);
    } else {
      const link = document.createElement("a");
      link.href = "/captain/step-up?next=%2Fcaptain%2Fchat";
      link.textContent = "Sign in again";
      freshness.replaceChildren(link);
    }
  }

  const optimistic = new Map();
  let selectedBot = "";
  let csrf = "";
  let currentThread = null;
  const PAGE = 15;
  const NEAR_BOTTOM = 120;
  let visible = PAGE;
  let renderedCount = 0;

  const CHIME_GAP_MS = 5000;
  const SOUND_KEY = "qd-chat-sound";
  const UNLOCK_EVENTS = ["click", "touchend", "keydown"];
  const lastSeen = new Map();
  const knownAt = new Map();
  const peeking = new Set();
  let unread = [];
  let listReady = false;
  let soundOn = true;
  let audio = null;
  let lastChimeAt = -Infinity;

  function storedSound() {
    try {
      return localStorage.getItem(SOUND_KEY) !== "off";
    } catch (_error) {
      return true;
    }
  }

  function remember(on) {
    try {
      localStorage.setItem(SOUND_KEY, on ? "on" : "off");
    } catch (_error) {
      return false;
    }
    return true;
  }

  function renderSound() {
    if (!soundButton) {
      return;
    }
    soundButton.textContent = soundOn ? "Sound on" : "Sound off";
    soundButton.setAttribute("aria-pressed", String(soundOn));
  }

  function unlockAudio() {
    for (const name of UNLOCK_EVENTS) {
      document.removeEventListener(name, unlockAudio, true);
    }
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof Context !== "function") {
      return;
    }
    try {
      audio = new Context();
      audio.resume();
      const silence = audio.createBufferSource();
      silence.buffer = audio.createBuffer(1, 1, 22050);
      silence.connect(audio.destination);
      silence.start(0);
    } catch (_error) {
      audio = null;
    }
  }

  function playChime() {
    if (!audio) {
      return false;
    }
    if (audio.state !== "running") {
      audio.resume();
      return false;
    }
    try {
      const start = audio.currentTime;
      const gain = audio.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
      gain.connect(audio.destination);
      const tone = audio.createOscillator();
      tone.type = "sine";
      tone.frequency.value = 880;
      tone.connect(gain);
      tone.start(start);
      tone.stop(start + 0.5);
    } catch (_error) {
      return false;
    }
    return true;
  }

  function renderAlert() {
    const bot = unread[unread.length - 1];
    document.title = bot === undefined ? baseTitle : `\u25cf ${baseTitle}`;
    if (!alertLine) {
      return;
    }
    alertLine.hidden = bot === undefined;
    alertLine.textContent = bot === undefined ? "" : `New message from ${bot}`;
  }

  function acknowledge(bot) {
    if (unread.includes(bot)) {
      unread = unread.filter((item) => item !== bot);
      renderAlert();
    }
  }

  function announce(bot) {
    const now = Date.now();
    if (soundOn && now - lastChimeAt >= CHIME_GAP_MS && playChime()) {
      lastChimeAt = now;
    }
    if (bot !== selectedBot || document.hidden) {
      unread = unread.filter((item) => item !== bot);
      unread.push(bot);
    }
    renderAlert();
  }

  function observe(bot, messages, armed, marker) {
    const latest = messages[messages.length - 1];
    if (!latest) {
      return;
    }
    const previous = lastSeen.get(bot);
    lastSeen.set(bot, latest.id);
    let arrived = [];
    if (previous !== undefined) {
      const index = messages.findIndex((item) => item.id === previous);
      arrived = index < 0 ? [] : messages.slice(index + 1);
    } else if (armed) {
      if (!marker) {
        arrived = messages;
      } else {
        const index = messages.map((item) => item.at).lastIndexOf(marker);
        arrived = index < 0 ? [latest] : messages.slice(index + 1);
      }
    }
    if (arrived.some((item) => item.from === "bot")) {
      announce(bot);
    }
  }

  async function peek(bot, marker) {
    if (peeking.has(bot)) {
      return;
    }
    peeking.add(bot);
    try {
      const body = await requestJson(`/captain/api/chat?with=${encodeURIComponent(bot)}`);
      observe(bot, body.messages, true, marker);
      const latest = body.messages[body.messages.length - 1];
      knownAt.set(bot, latest ? latest.at : "");
    } catch (_error) {
      return;
    } finally {
      peeking.delete(bot);
    }
  }

  function noteList(rows) {
    const baseline = !listReady;
    listReady = true;
    for (const row of rows) {
      const before = knownAt.get(row.id);
      if (baseline || row.id === selectedBot) {
        knownAt.set(row.id, row.at);
        if (baseline && row.last) {
          lastSeen.set(row.id, row.last);
        }
      } else if ((row.at && row.at !== before) || (row.last && row.last !== lastSeen.get(row.id))) {
        peek(row.id, before);
      }
    }
  }

  function startsBotRun(items, index) {
    return items[index].from === "bot" && (index === 0 || items[index - 1].from !== "bot");
  }

  function clientId() {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }

  function inlineMarkdown(text) {
    const fragment = document.createDocumentFragment();
    const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    for (const part of parts) {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
        const code = document.createElement("code");
        code.textContent = part.slice(1, -1);
        fragment.append(code);
      } else if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        const strong = document.createElement("strong");
        strong.textContent = part.slice(2, -2);
        fragment.append(strong);
      } else {
        fragment.append(document.createTextNode(part));
      }
    }
    return fragment;
  }

  function markdown(text) {
    const fragment = document.createDocumentFragment();
    const lines = text.split("\n");
    let codeLines = null;
    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        if (codeLines === null) {
          codeLines = [];
        } else {
          const pre = document.createElement("pre");
          const code = document.createElement("code");
          code.textContent = codeLines.join("\n");
          pre.append(code);
          fragment.append(pre);
          codeLines = null;
        }
      } else if (codeLines !== null) {
        codeLines.push(line);
      } else {
        const paragraph = document.createElement("p");
        paragraph.append(inlineMarkdown(line));
        fragment.append(paragraph);
      }
    }
    if (codeLines !== null) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
    }
    return fragment;
  }

  function messageRow(message, pending = false, name = "") {
    const article = document.createElement("article");
    article.className = `message ${message.from}`;
    if (pending) {
      article.classList.add(message.failed ? "failed" : "pending");
    }
    if (name) {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = name;
      article.append(who);
    }
    article.append(markdown(message.text));
    const meta = document.createElement("div");
    meta.className = "meta";
    if (message.failed) {
      meta.textContent = "Not sent";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => sendPending(message));
      meta.append(" ", retry);
    } else if (pending) {
      meta.textContent = "Sending…";
    } else if (message.from === "account") {
      meta.textContent = currentThread?.seenUpTo === message.id ? "Seen" : "Sent";
    } else {
      meta.textContent = message.at;
    }
    article.append(meta);
    return article;
  }

  function distanceFromBottom() {
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  }

  function scrollToBottom() {
    thread.scrollTop = thread.scrollHeight;
    newer.hidden = true;
  }

  function olderButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "older";
    button.textContent = "Show older";
    button.addEventListener("click", () => {
      visible += PAGE;
      renderThread("older");
    });
    return button;
  }

  function renderNote() {
    const text = currentThread?.bot?.note;
    note.textContent = typeof text === "string" ? text : "";
    note.hidden = note.textContent === "";
  }

  function renderThread(mode = "keep") {
    if (!currentThread) {
      thread.replaceChildren();
      typing.hidden = true;
      newer.hidden = true;
      renderedCount = 0;
      renderNote();
      return;
    }
    const canonical = currentThread.messages;
    const following = mode === "bottom" || distanceFromBottom() <= NEAR_BOTTOM;
    const arrived = canonical.length - renderedCount;
    if (mode === "keep" && !following && arrived > 0) {
      visible += arrived;
    }
    const start = Math.max(0, canonical.length - visible);
    const clientIds = new Set(canonical.map((item) => item.clientId).filter(Boolean));
    const botName = currentThread.bot?.id || selectedBot;
    const shown = canonical.slice(start);
    const rows = shown.map((item, index) => messageRow(item, false, startsBotRun(shown, index) ? botName : ""));
    for (const item of optimistic.values()) {
      if (item.bot === selectedBot && !clientIds.has(item.clientId)) {
        rows.push(messageRow(item, true));
      }
    }
    if (start > 0) {
      rows.unshift(olderButton());
    }
    const heightBefore = thread.scrollHeight;
    const topBefore = thread.scrollTop;
    thread.replaceChildren(...rows);
    if (mode === "older") {
      thread.scrollTop = topBefore + thread.scrollHeight - heightBefore;
    } else if (following) {
      scrollToBottom();
    } else {
      thread.scrollTop = topBefore;
      if (arrived > 0) {
        newer.hidden = false;
      }
    }
    renderedCount = canonical.length;
    typing.hidden = !currentThread.writing;
    renderNote();
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      if (response.status === 401 ||
          (response.status === 403 && (!options || options.method === "GET"))) {
        renderFreshness(0);
      }
      const failure = new Error("request refused");
      failure.status = response.status;
      throw failure;
    }
    return response.json();
  }

  async function loadChats() {
    try {
      const body = await requestJson("/captain/api/chats");
      renderFreshness(body.freshUntil);
      const previous = selectedBot;
      const options = [new Option("Select a bot", "")];
      for (const row of body.chats) {
        options.push(new Option(row.id, row.id));
      }
      botSelect.replaceChildren(...options);
      if (body.chats.some((row) => row.id === previous)) {
        botSelect.value = previous;
      }
      noteList(body.chats);
      status.textContent = body.chats.length ? "Chats ready" : "No active bots";
    } catch (_error) {
      status.textContent = "Could not refresh chats. Last good list kept.";
    }
  }

  async function loadThread() {
    if (!selectedBot) {
      currentThread = null;
      renderThread();
      return false;
    }
    try {
      const body = await requestJson(`/captain/api/chat?with=${encodeURIComponent(selectedBot)}`);
      csrf = body.csrf;
      renderFreshness(body.freshUntil);
      delete body.csrf;
      currentThread = body;
      observe(selectedBot, body.messages, false);
      for (const message of body.messages) {
        if (message.clientId) {
          optimistic.delete(message.clientId);
        }
      }
      status.textContent = "Thread up to date";
      renderThread();
      return true;
    } catch (_error) {
      status.textContent = "Could not refresh this thread. Last good messages kept.";
      return false;
    }
  }

  async function sendPending(item, retried = false) {
    item.failed = false;
    optimistic.set(item.clientId, item);
    renderThread();
    try {
      const body = await requestJson(`/captain/api/chat?with=${encodeURIComponent(item.bot)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: item.text,
          requestId: item.clientId,
          csrf,
        }),
      });
      csrf = body.csrf;
      renderFreshness(body.freshUntil);
      if (selectedBot === item.bot && currentThread) {
        const messages = currentThread.messages.filter(
          (message) => message.id !== body.message.id && message.clientId !== body.message.clientId,
        );
        currentThread = {...currentThread, messages: [...messages, body.message]};
      }
      optimistic.delete(item.clientId);
      status.textContent = "Sent";
      renderThread();
    } catch (error) {
      let refreshed = false;
      if (selectedBot === item.bot) {
        refreshed = await loadThread();
      }
      if (!optimistic.has(item.clientId)) {
        status.textContent = "Sent";
        return;
      }
      if (!retried && refreshed && error.status === 403) {
        await sendPending(item, true);
        return;
      }
      item.failed = true;
      optimistic.set(item.clientId, item);
      status.textContent = "Message was not sent. Retry when ready.";
      renderThread();
    }
  }

  function selectBot(value) {
    selectedBot = value;
    currentThread = null;
    visible = PAGE;
    lastSeen.delete(value);
    acknowledge(value);
    renderThread();
    loadThread();
  }

  botSelect.addEventListener("change", () => selectBot(botSelect.value));

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!selectedBot || !text || !csrf) {
      status.textContent = "Select a bot and enter a message.";
      return;
    }
    const requestId = clientId();
    const item = {
      id: `pending-${requestId}`,
      clientId: requestId,
      bot: selectedBot,
      from: "account",
      text,
      at: new Date().toISOString(),
      failed: false,
    };
    messageInput.value = "";
    optimistic.set(item.clientId, item);
    renderThread("bottom");
    sendPending(item);
  });

  reloadButton.addEventListener("click", () => {
    loadChats();
    loadThread();
  });

  thread.addEventListener("scroll", () => {
    if (distanceFromBottom() <= NEAR_BOTTOM) {
      newer.hidden = true;
    }
  });

  newer.addEventListener("click", scrollToBottom);

  const updates = new EventSource("/captain/events");
  updates.addEventListener("refresh", () => {
    loadChats();
    loadThread();
  });
  updates.addEventListener("open", () => {
    status.textContent = "Live updates connected";
  });
  updates.addEventListener("error", () => {
    status.textContent = "Live updates reconnecting. Last good messages kept.";
  });

  soundOn = storedSound();
  renderSound();

  soundButton?.addEventListener("click", () => {
    soundOn = !soundOn;
    remember(soundOn);
    renderSound();
  });

  alertLine?.addEventListener("click", () => {
    const bot = unread[unread.length - 1];
    botSelect.value = bot;
    if (botSelect.value === bot) {
      selectBot(bot);
    }
  });

  document.addEventListener?.("visibilitychange", () => {
    if (!document.hidden) {
      acknowledge(selectedBot);
    }
  });

  for (const name of UNLOCK_EVENTS) {
    document.addEventListener?.(name, unlockAudio, true);
  }

  loadChats();
})();
