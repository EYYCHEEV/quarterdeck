export function measure() {
  const TOL = 1;
  const de = document.documentElement;
  const vw = de.clientWidth;
  const vh = window.innerHeight;
  const issues = [];
  const touchAreas = document.createElement('style');
  touchAreas.textContent = '[class*="pointer-coarse:after:min-"]::after{min-width:0!important;min-height:0!important}';
  document.head.appendChild(touchAreas);
  const folds = [];
  const hits = new Set();
  const clipHits = new Set();
  const css = (el) => getComputedStyle(el);
  const px = (n) => `${Math.round(n)}px`;
  const short = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > 48 ? `${t.slice(0, 45)}...` : t; };
  const name = (el, text) => {
    if (!el || el.nodeType !== 1) return '?';
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => c && !c.startsWith('layout-gate')).slice(0, 3) : [];
    if (cls.length) s += `.${cls.join('.')}`;
    const t = short(text !== undefined ? text : (el.innerText || el.getAttribute('aria-label') || ''));
    return t ? `${s} "${t}"` : s;
  };
  const add = (kind, el, what, text) => { issues.push({ kind, el: name(el, text), what }); hits.add(el); };
  const isInline = (el) => ['inline', 'contents'].includes(css(el).display);
  const boxOf = (el) => { let p = el; while (p && p !== de && isInline(p)) p = p.parentElement; return p; };
  const clipsX = (el) => el !== de && el !== document.body && css(el).overflowX !== 'visible';
  const clipsY = (el) => el !== de && el !== document.body && css(el).overflowY !== 'visible';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'WBR', 'OPTION', 'OPTGROUP', 'DATALIST']);
  const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  const srOnly = (cs, r) => (r.width <= 1 && r.height <= 1) || /^rect\(0px,? 0px,? 0px,? 0px\)$/.test(cs.clip) || /inset\(50%\)/.test(cs.clipPath);
  const containing = (el) => { let p = el.parentElement; while (p && p !== de && css(p).position === 'static' && css(p).transform === 'none') p = p.parentElement; return p || de; };
  const foldOpener = (el) => el.id && [...document.querySelectorAll('[aria-expanded="false"][aria-controls]')]
    .some((b) => b.getAttribute('aria-controls').split(/\s+/).includes(el.id) && b.getClientRects().length && css(b).visibility === 'visible');

  const winOverflow = (axis) => { const h = css(de)[axis]; return h !== 'visible' ? h : css(document.body)[axis]; };
  const pageClipsX = winOverflow('overflowX') !== 'visible';
  const modalOpen = Boolean(document.querySelector('dialog:modal, [aria-modal="true"]:not([hidden])'));
  const pageStuckY = !modalOpen && ['hidden', 'clip'].includes(winOverflow('overflowY'));
  const stuck = [];
  if (de.scrollWidth > vw + TOL) {
    issues.push({ kind: 'page-wide', el: 'the page', what: pageClipsX ? `is ${px(de.scrollWidth - vw)} wider than the screen and that part is cut off` : `is ${px(de.scrollWidth - vw)} wider than the screen (sideways scroll)` });
  }

  function culprits(box, axis) {
    const pr = box.getBoundingClientRect();
    const right = pr.left + box.clientLeft + box.clientWidth;
    const bottom = pr.top + box.clientTop + box.clientHeight;
    const out = [];
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < 6; n = walker.nextNode()) {
      let r;
      let el = n;
      if (n.nodeType === 3) {
        if (!/\S/.test(n.data)) continue;
        const range = document.createRange(); range.selectNodeContents(n); r = range.getBoundingClientRect(); el = n.parentElement;
      } else {
        if (SKIP.has(n.tagName) || n instanceof SVGElement && n.tagName.toLowerCase() !== 'svg') continue;
        r = n.getBoundingClientRect();
      }
      if (!r.width || !r.height) continue;
      const past = axis === 'x' ? r.right - right : r.bottom - bottom;
      if (past > TOL && !(n.nodeType === 1 && [...n.children].some((c) => { const q = c.getBoundingClientRect(); return (axis === 'x' ? q.right - right : q.bottom - bottom) > TOL; }))) {
        out.push(`${name(el, n.nodeType === 3 ? n.data : undefined)} (${px(past)} out of view)`);
        hits.add(el);
      }
    }
    return out;
  }

  function checkClip(el, cs) {
    const sw = el.scrollWidth; const cw = el.clientWidth; const sh = el.scrollHeight; const ch = el.clientHeight;
    if ((!cw && !ch) || el.closest('[inert]')) return;
    const ox = cs.overflowX; const oy = cs.overflowY;
    if (ox !== 'visible' && sw > cw + TOL && !(cs.textOverflow === 'ellipsis' && el.closest('[data-truncates]'))) {
      const how = ['auto', 'scroll'].includes(ox) ? 'scrolls sideways inside itself' : cs.textOverflow === 'ellipsis' ? 'cuts its text off with "..."' : 'cuts off its content on the side';
      issues.push({ kind: 'cut-off', el: name(el), what: `${how}: ${px(sw - cw)} hidden`, hidden: culprits(el, 'x') });
      clipHits.add(el);
    }
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    if (['hidden', 'clip'].includes(oy) && sh > ch + Math.max(TOL, line / 2)) {
      const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none' ? ` (text clamped to ${cs.webkitLineClamp} lines)` : '';
      if (foldOpener(el)) { folds.push({ el: name(el), what: `folded: ${px(sh - ch)} below the fold, opened by its button` }); return; }
      if (clamp && el.closest('[data-truncates]')) return;
      issues.push({ kind: 'cut-off', el: name(el), what: `cuts off its content at the bottom${clamp}: ${px(sh - ch)} hidden`, hidden: culprits(el, 'y') });
      clipHits.add(el);
    }
  }

  function checkBox(el, cs, r, clips, fixed) {
    if (!clips.some((c) => c.x)) {
      if (r.right > vw + TOL) add('off-screen', el, `sticks out past the right edge of the screen by ${px(r.right - vw)}`);
      if (r.left < -TOL) add('off-screen', el, `sticks out past the left edge of the screen by ${px(-r.left)}`);
    }
    if (fixed && !clips.some((c) => c.y)) {
      if (r.bottom > vh + TOL) add('off-screen', el, `goes below the bottom of the screen by ${px(r.bottom - vh)}`);
      if (r.top < -TOL) add('off-screen', el, `goes above the top of the screen by ${px(-r.top)}`);
    }
    if (['absolute', 'fixed'].includes(cs.position) || el.tagName === 'DIALOG') return;
    const p = boxOf(el.parentElement);
    if (!p || p === de) return;
    const pr = p.getBoundingClientRect();
    if (!pr.width && !pr.height) return;
    const m = cs.transform && cs.transform !== 'none' ? new DOMMatrixReadOnly(cs.transform) : null;
    const [tx = '0px', ty = '0px'] = cs.translate && cs.translate !== 'none' ? cs.translate.split(' ') : [];
    const len = (v, size) => (v.endsWith('%') ? (parseFloat(v) / 100) * size : parseFloat(v) || 0);
    const dx = len(tx, r.width) + (m ? m.m41 : 0);
    const dy = len(ty, r.height) + (m ? m.m42 : 0);
    if (!clipsX(p)) {
      const overR = Math.max(0, -parseFloat(cs.marginRight) || 0) + Math.max(0, dx);
      const overL = Math.max(0, -parseFloat(cs.marginLeft) || 0) + Math.max(0, -dx);
      if (r.right > pr.right + TOL + overR) add('spills-out', el, `sticks out of ${name(p)} on the right by ${px(r.right - pr.right)}`);
      if (r.left < pr.left - TOL - overL) add('spills-out', el, `sticks out of ${name(p)} on the left by ${px(pr.left - r.left)}`);
    }
    if (!clipsY(p) && cs.display !== 'inline') {
      const overB = Math.max(0, -parseFloat(cs.marginBottom) || 0) + Math.max(0, dy);
      const overT = Math.max(0, -parseFloat(cs.marginTop) || 0) + Math.max(0, -dy);
      if (r.bottom > pr.bottom + TOL + overB) add('spills-out', el, `sticks out of ${name(p)} at the bottom by ${px(r.bottom - pr.bottom)}`);
      if (r.top < pr.top - TOL - overT) add('spills-out', el, `sticks out of ${name(p)} at the top by ${px(pr.top - r.top)}`);
    }
  }

  function checkText(n, el, clips) {
    const range = document.createRange();
    range.selectNodeContents(n);
    const rs = [...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0);
    if (!rs.length) return;
    const L = Math.min(...rs.map((q) => q.left)); const R = Math.max(...rs.map((q) => q.right));
    const T = Math.min(...rs.map((q) => q.top)); const B = Math.max(...rs.map((q) => q.bottom));
    const box = boxOf(el);
    if (!clips.some((c) => c.x) && !clipsX(box)) {
      if (R > vw + TOL) add('off-screen', el, `text runs past the right edge of the screen by ${px(R - vw)}`, n.data);
      if (L < -TOL) add('off-screen', el, `text runs past the left edge of the screen by ${px(-L)}`, n.data);
    }
    if (!box || box === de) return;
    const br = box.getBoundingClientRect();
    if (!clipsX(box)) {
      if (R > br.right + TOL) add('spills-out', el, `text sticks out of ${box === el ? 'its box' : name(box)} on the right by ${px(R - br.right)}`, n.data);
      if (L < br.left - TOL) add('spills-out', el, `text sticks out of ${box === el ? 'its box' : name(box)} on the left by ${px(br.left - L)}`, n.data);
    }
    const vt = Math.max(TOL, parseFloat(css(el).fontSize) * 0.5);
    if (!clipsY(box)) {
      if (B > br.bottom + vt) add('spills-out', el, `text sticks out of ${box === el ? 'its box' : name(box)} at the bottom by ${px(B - br.bottom)}`, n.data);
      if (T < br.top - vt) add('spills-out', el, `text sticks out of ${box === el ? 'its box' : name(box)} at the top by ${px(br.top - T)}`, n.data);
    }
  }

  function checkPlaceholder(el, cs) {
    if (el.tagName !== 'INPUT' || el.value || !el.placeholder) return;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const need = ctx.measureText(el.placeholder).width;
    const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (need > room + TOL) add('placeholder', el, `placeholder "${short(el.placeholder)}" needs ${px(need)} but the input has ${px(room)}`, '');
  }

  function visit(el, clips, fixed) {
    if (SKIP.has(el.tagName)) return;
    if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') return;
    if (el.parentElement && el.parentElement.tagName === 'DETAILS' && !el.parentElement.open && el.tagName !== 'SUMMARY') return;
    const cs = css(el);
    if (cs.display === 'none') return;
    const r = el.getBoundingClientRect();
    const boxed = cs.display !== 'contents';
    if (boxed && !el.getClientRects().length) return;
    if (cs.position === 'fixed' || (el.tagName === 'DIALOG' && el.matches(':modal'))) { clips = []; fixed = true; }
    else if (cs.position === 'absolute') { const cb = containing(el); clips = clips.filter((c) => c.el === cb || c.el.contains(cb)); }
    if (pageStuckY && boxed && !fixed && !clips.some((c) => c.y) && (r.width || r.height) && r.bottom + window.scrollY > vh + TOL) stuck.push(el);
    if (Number(cs.opacity) === 0) return;
    if (boxed && srOnly(cs, r)) return;
    const shown = cs.visibility === 'visible';
    if (shown && boxed && r.width > 0 && r.height > 0) checkBox(el, cs, r, clips, fixed);
    if (FIELDS.has(el.tagName)) { if (shown) checkPlaceholder(el, cs); return; }
    if (shown) for (const n of el.childNodes) if (n.nodeType === 3 && /\S/.test(n.data)) checkText(n, el, clips);
    let next = clips;
    if (clipsX(el) || clipsY(el)) {
      if (shown) checkClip(el, cs);
      next = clips.concat([{ el, x: clipsX(el), y: clipsY(el) }]);
    }
    for (const c of el.children) visit(c, next, fixed);
  }
  visit(document.body, [], false);
  if (pageStuckY && window.scrollY > TOL) {
    issues.push({ kind: 'page-wide', el: 'the page', what: `the window got scrolled down by ${px(window.scrollY)} though the page cannot scroll, so the top ${px(window.scrollY)} is out of reach until a reload` });
  }
  if (pageStuckY && de.scrollHeight > vh + TOL) {
    const deepest = stuck.filter((a) => !stuck.some((b) => b !== a && a.contains(b)));
    for (const el of deepest) hits.add(el);
    issues.push({ kind: 'page-wide', el: 'the page', what: `is ${px(de.scrollHeight - vh)} taller than the window, but the page cannot scroll: tapping or focusing something down there shifts the whole page up with no way back`,
      hidden: deepest.slice(0, 6).map((el) => `${name(el)} (bottom ${px(el.getBoundingClientRect().bottom + window.scrollY - vh)} below the window)`) });
  }
  for (const el of clipHits) el.style.setProperty('outline', '3px dashed #ffb000', 'important');
  for (const el of hits) { el.style.setProperty('outline', '3px solid #ff2d55', 'important'); el.style.setProperty('outline-offset', '-2px', 'important'); }
  touchAreas.remove();
  return { issues, folds, viewport: `${vw}x${vh}` };
}

export function measurePills(sel) {
  const issues = [];
  const css = (el) => getComputedStyle(el);
  const hidden = (el) => {
    if (!el.getClientRects().length) return true;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const cs = css(p);
      if (cs.display === 'none' || Number(cs.opacity) === 0) return true;
      const d = p.parentElement;
      if (d && d.tagName === 'DETAILS' && !d.open && p.tagName !== 'SUMMARY') return true;
    }
    return css(el).visibility !== 'visible';
  };
  const label = (el) => {
    let s = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => c && !c.startsWith('layout-gate')).slice(0, 2) : [];
    if (cls.length) s += `.${cls.join('.')}`;
    const t = String(el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return t ? `${s} "${t.length > 30 ? `${t.slice(0, 27)}...` : t}"` : s;
  };
  const lines = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = [];
    for (const q of range.getClientRects()) if (q.width > 0 && q.height > 0 && !tops.some((t) => Math.abs(t - q.top) < q.height / 2)) tops.push(q.top);
    return Math.max(1, tops.length);
  };
  const pills = [...document.querySelectorAll(sel)].filter((el) => !hidden(el)).map((el) => ({
    el, height: el.getBoundingClientRect().height, font: parseFloat(css(el).fontSize), lines: lines(el),
  }));
  const compare = (list, key, unit, what, tol) => {
    const values = list.map((p) => p[key]);
    if (!values.length || Math.max(...values) - Math.min(...values) <= tol) return;
    const groups = new Map();
    for (const p of list) {
      const k = Math.round(p[key] * 10) / 10;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
    for (const [, ps] of sorted.slice(1)) for (const p of ps) { p.el.style.setProperty('outline', '3px solid #ff2d55', 'important'); p.el.style.setProperty('outline-offset', '-2px', 'important'); }
    issues.push({ kind: 'pill-size', el: `pills (${sel})`, what: `${what} differ: ${sorted.map(([v, ps]) => `${v}${unit} x${ps.length} (${ps.slice(0, 3).map((p) => label(p.el)).join(', ')})`).join('; ')}` });
  };
  compare(pills, 'font', 'px', 'font sizes', 0.1);
  compare(pills.filter((p) => p.lines === 1), 'height', 'px', 'one-line heights', 0.5);
  return { issues, pills: pills.length };
}
