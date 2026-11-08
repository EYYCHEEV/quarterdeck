export function measureUx({ phone, state }) {
  const issues = [];
  const de = document.documentElement;
  const vh = window.innerHeight;
  const css = (el, pseudo) => getComputedStyle(el, pseudo);
  const short = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > 40 ? `${t.slice(0, 37)}...` : t; };
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    const id = el.getAttribute('data-testid');
    if (id) s += `[${id}]`;
    else {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => /^[a-z][\w-]*$/i.test(c)).slice(0, 2) : [];
      if (cls.length) s += `.${cls.join('.')}`;
    }
    const t = short(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
    return t ? `${s} "${t}"` : s;
  };
  const add = (kind, el, what) => {
    issues.push({ kind, el: typeof el === 'string' ? el : name(el), what });
    if (typeof el !== 'string') { el.style.setProperty('outline', '3px solid #ff2d55', 'important'); el.style.setProperty('outline-offset', '-2px', 'important'); }
  };
  const shown = (el) => {
    if (!el.getClientRects().length || el.closest('[inert],[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const cs = css(p);
      if (cs.display === 'none' || Number(cs.opacity) === 0 || cs.visibility !== 'visible') return false;
    }
    return true;
  };
  const top = document.querySelectorAll('[data-pop]');
  const scope = top.length ? [...top].filter((el) => !el.classList.contains('sub')).pop() || document.body : document.body;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
  const lum = ([r, g, b]) => {
    const c = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const backdrop = (el) => {
    const layers = [];
    let fade = 1;
    for (let p = el; p; p = p.parentElement) {
      const cs = css(p);
      if (p !== el) fade *= Number(cs.opacity);
      if (cs.backgroundImage !== 'none') return null;
      const bg = rgba(cs.backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    let base = [255, 255, 255, 1];
    for (const layer of layers.reverse()) base = over(layer, base);
    return { bg: base, fade };
  };
  const texts = new Set();
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.trim() && n.parentElement) texts.add(n.parentElement);
  for (const el of texts) {
    if (!shown(el) || el.closest('button:disabled,[aria-disabled="true"],svg')) continue;
    const cs = css(el);
    const under = backdrop(el);
    if (!under) continue;
    const fg = rgba(cs.color);
    if (fg[3] === 0) continue;
    fg[3] *= Number(cs.opacity) * under.fade;
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(over(fg, under.bg), under.bg);
    if (got < need - 0.05) add('contrast', el, `text contrast ${got.toFixed(2)}:1, under ${need}:1 for ${large ? 'large' : 'body'} text (${cs.color} on rgb(${under.bg.slice(0, 3).map(Math.round).join(', ')}))`);
  }

  const CONTROLS = 'button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"]';
  const controls = [...scope.querySelectorAll(CONTROLS)].filter((el) => shown(el) && !el.disabled);
  const named = (el) => {
    if ((el.getAttribute('aria-label') || '').trim()) return true;
    const by = el.getAttribute('aria-labelledby');
    if (by && by.split(/\s+/).some((id) => (document.getElementById(id)?.textContent || '').trim())) return true;
    if ((el.innerText || '').trim() || (el.getAttribute('title') || '').trim()) return true;
    if (el.querySelector('img[alt]:not([alt=""]),svg title')) return true;
    if (el.labels && [...el.labels].some((l) => l.textContent.trim())) return true;
    return Boolean((el.getAttribute('placeholder') || '').trim());
  };
  for (const el of controls) if (!named(el)) add('no-name', el, 'has no name a screen reader can read (no text, aria-label or label)');

  if (matchMedia('(pointer: coarse)').matches) {
    for (const el of controls) {
      if (el.matches('a') && css(el).display === 'inline' && (el.parentElement?.innerText || '').trim().length > (el.innerText || '').trim().length + 1) continue;
      const r = el.getBoundingClientRect();
      const after = css(el, '::after');
      const hitW = after.position === 'absolute' ? Math.max(r.width, parseFloat(after.width) || 0) : r.width;
      const hitH = after.position === 'absolute' ? Math.max(r.height, parseFloat(after.height) || 0) : r.height;
      const field = el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="color"]),textarea,select');
      const minH = field ? 36 : 44;
      if (hitW < 43.5 || hitH < minH - 0.5) add('small-target', el, `tap area ${Math.round(hitW)}x${Math.round(hitH)}px, under ${field ? '44 wide and 36 tall for a text field' : '44x44'} on a touch screen`);
    }
  }
  if (phone && scope === document.body) {
    const rows = state.startsWith('queue') ? '[data-testid="card-row"]' : '[data-testid="project-row"],[data-testid="mail-row"]';
    const row = [...document.querySelectorAll(rows)].find(shown);
    if (row && row.getBoundingClientRect().top > vh * 0.6) add('first-row-low', row, `first list row starts ${Math.round(row.getBoundingClientRect().top)}px down, below 60% of the ${vh}px screen`);
  }

  const BAD = /\b(NaN|undefined|null|Infinity)\b|\[object Object\]|^\s*--\s*$|lorem ipsum/i;
  const walker2 = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker2.nextNode(); n; n = walker2.nextNode()) {
    const el = n.parentElement;
    if (el && BAD.test(n.textContent) && shown(el) && !el.closest('pre,code')) add('dishonest-value', el, `shows "${short(n.textContent)}" where a real value, a zero or a grey dash belongs`);
  }

  const num = (text, re) => { const m = text.replace(/\s+/g, ' ').match(re); return m ? Number(m[1]) : null; };
  if (state === 'projects') {
    const totals = document.querySelector('[data-testid="totals"]');
    const rows = [...document.querySelectorAll('[data-testid="project-row"]')];
    if (totals && rows.length) {
      const t = totals.innerText;
      const want = { projects: num(t, /(\d+)\s*projects?\b/i), cards: num(t, /(\d+)\s*task cards?\b/i), lanes: num(t, /(\d+)\s*lanes?\b/i) };
      const sum = (re) => rows.reduce((s, r) => s + (num(r.innerText, re) ?? 0), 0);
      const got = { projects: rows.length, cards: sum(/(\d+)\s*task cards?\b/i), lanes: sum(/(\d+)\s*lanes?\b/i) };
      for (const key of Object.keys(want)) if (want[key] !== null && want[key] !== got[key]) add('totals', totals, `says ${want[key]} ${key}, but the rows on screen add up to ${got[key]}`);
    }
  }
  if (state === 'queue') {
    const title = document.querySelector('h1');
    const rows = document.querySelectorAll('[data-testid="card-row"]').length;
    const said = title ? num(title.innerText, /(\d+)\s*waiting\b/i) : null;
    if (said !== null && said !== rows) add('totals', title, `says ${said} waiting, but ${rows} rows are on screen`);
  }
  if (state === 'pages') {
    const sub = document.querySelector('[data-testid="pages-sub"]');
    const rows = [...document.querySelectorAll('[data-testid="page-row"]')];
    const said = sub ? num(sub.innerText, /(\d+)\s*(?:of\s*\d+\s*)?pages?\b/i) : null;
    if (said !== null && said !== rows.length) add('totals', sub, `says ${said} Pages, but ${rows.length} rows are on screen`);
  }

  if (phone) {
    const vw = window.innerWidth;
    const reachable = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = css(p);
        if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) return true;
      }
      return document.scrollingElement.scrollHeight > vh + 1;
    };
    const srOnly = (el, r, cs) => r.width <= 1 && r.height <= 1 && (cs.position === 'absolute' || cs.position === 'fixed');
    const clipped = (el, r) => {
      let box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = css(p);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const b = p.getBoundingClientRect();
        const scrollX = /(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1;
        const scrollY = /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1;
        if (!scrollX && cs.overflowX !== 'visible' && (box.right <= b.left || box.left >= b.right)) return true;
        if (!scrollY && cs.overflowY !== 'visible' && (box.bottom <= b.top || box.top >= b.bottom)) return true;
        if (scrollX) box = { ...box, left: b.left, right: b.right };
        if (scrollY) box = { ...box, top: b.top, bottom: b.bottom };
      }
      return false;
    };
    const fadedOut = (el) => {
      for (let p = el; p && p.nodeType === 1; p = p.parentElement) if (Number(css(p).opacity) === 0) return true;
      return false;
    };
    const revealedOnFocus = (el) => {
      const before = document.activeElement;
      const still = document.createElement('style');
      still.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
      document.head.append(still);
      el.focus({ preventScroll: true, focusVisible: true });
      const seen = document.activeElement === el && !fadedOut(el);
      if (before && before !== el && typeof before.focus === 'function') before.focus({ preventScroll: true });
      else el.blur();
      still.remove();
      return seen;
    };
    const FOCUSABLE = 'a[href],button,input:not([type="hidden"]),select,textarea,[tabindex],[contenteditable="true"]';
    const active = new Set([...document.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.tabIndex >= 0));
    for (const el of document.querySelectorAll('[aria-current]:not([aria-current="false"])')) active.add(el);
    for (const el of active) {
      if (el.closest('[inert],[aria-hidden="true"]') || !el.getClientRects().length) continue;
      const cs = css(el);
      if (cs.visibility !== 'visible') continue;
      const r = el.getBoundingClientRect();
      if (srOnly(el, r, cs)) continue;
      const faded = fadedOut(el) && !revealedOnFocus(el);
      const off = r.right <= 0 || r.left >= vw || (r.bottom <= 0 && !reachable(el)) || (r.top >= vh && !reachable(el));
      if (!faded && !off && !clipped(el, r)) continue;
      const current = el.hasAttribute('aria-current') && el.getAttribute('aria-current') !== 'false';
      add('hidden-active', el, `${current ? 'is marked current' : 'can take focus'} but is not on screen (${faded ? 'fully transparent' : off ? 'outside the screen' : 'clipped away'})`);
    }
  }
  return { issues };
}
