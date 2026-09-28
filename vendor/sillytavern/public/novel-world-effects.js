/* Original Novel World pointer and local refraction; no network or text rasterization. */
(() => {
  'use strict';
  const SVG = 'http://www.w3.org/2000/svg';
  window.NovelWorldEffects = function ({ selector = '.reader p, .chunk-source-reader p', preferences = {}, enabled = () => true, onChange = () => {} } = {}) {
    const prefs = { whale: true, ripple: true, strength: 2, ...preferences };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = document.createElement('div'); pointer.className = 'nw-whale'; pointer.setAttribute('aria-hidden', 'true');
    pointer.innerHTML = '<svg viewBox="0 0 100 65"><g><path d="M8 36C7 16 22 7 41 9C57 10 65 23 69 31C73 36 77 36 80 32C75 27 77 17 81 18C86 19 88 24 88 24C96 20 100 23 97 29C94 35 88 37 88 37C86 53 68 56 45 55C25 55 9 53 8 36Z" fill="#f8fbfd" stroke="#354952" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="22" cy="36" r="2.2" fill="#354952"/><circle cx="43" cy="37" r="2.2" fill="#354952"/><path d="M31 38h5M48 47q13-14 13-2q-1 7-11 8" fill="none" stroke="#354952" stroke-width="2.7" stroke-linecap="round"/></g></svg>';
    document.body.append(pointer);
    const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.classList.add('nw-water-defs'); svg.setAttribute('aria-hidden', 'true');
    const filter = document.createElementNS(SVG, 'filter'); const id = 'nw-water-' + Math.random().toString(36).slice(2); filter.id = id;
    filter.setAttribute('x', '-5%'); filter.setAttribute('y', '-10%'); filter.setAttribute('width', '110%'); filter.setAttribute('height', '120%'); filter.setAttribute('color-interpolation-filters', 'sRGB');
    const source = document.createElementNS(SVG, 'feImage'); source.setAttribute('x', '0'); source.setAttribute('y', '0'); source.setAttribute('width', '100%'); source.setAttribute('height', '100%'); source.setAttribute('preserveAspectRatio', 'none'); source.setAttribute('result', 'water'); source.setAttribute('href', 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path fill="rgb(128,128,128)" d="M0 0h1v1H0z"/></svg>'));
    const displacement = document.createElementNS(SVG, 'feDisplacementMap'); displacement.setAttribute('in', 'SourceGraphic'); displacement.setAttribute('in2', 'water'); displacement.setAttribute('xChannelSelector', 'R'); displacement.setAttribute('yChannelSelector', 'G');
    filter.append(source, displacement); svg.append(filter); document.body.append(svg);
    const map = document.createElement('canvas'); map.width = 160; map.height = 96; const ctx = map.getContext('2d');
    let target = null, originalFilter = '', waves = [], frame = 0, lastFrame = 0, lastDrop = 0, dragging = false;
    const listeners = [];
    function listen(node, type, callback, options) { node.addEventListener(type, callback, options); listeners.push(() => node.removeEventListener(type, callback, options)); }
    function clear() { cancelAnimationFrame(frame); frame = 0; if (target) { target.style.filter = originalFilter; target = null; } waves = []; }
    function hide() { pointer.classList.remove('visible'); document.documentElement.classList.remove('nw-whale-active'); clear(); }
    function suspended() { return reduced.matches || dragging || document.hidden || !enabled() || Boolean(window.getSelection()?.toString()); }
    function draw(now) {
      frame = 0;
      if (!target?.isConnected || suspended() || !prefs.ripple || !ctx) { clear(); return; }
      if (now - lastFrame < 32) { frame = requestAnimationFrame(draw); return; }
      lastFrame = now; waves = waves.filter(w => now - w.time < 1050);
      if (!waves.length) { clear(); return; }
      const rect = target.getBoundingClientRect(); if (rect.bottom < 0 || rect.top > innerHeight) { clear(); return; }
      const image = ctx.createImageData(map.width, map.height), pixels = image.data;
      const prepared = waves.map(w => ({ ...w, age: (now - w.time) / 1000, radius: (now - w.time) * .17 }));
      for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
        let dx = 0, dy = 0;
        for (const w of prepared) {
          const ax = x / map.width * rect.width - w.x, ay = y / map.height * rect.height - w.y, distance = Math.hypot(ax, ay) || 1;
          const edge = distance - w.radius;
          if (Math.abs(edge) > 62) continue;
          const force = Math.sin(edge / 9) * Math.exp(-edge * edge / 1050) * (1 - w.age / 1.05) * 54;
          dx += force * ax / distance; dy += force * ay / distance;
        }
        const i = (y * map.width + x) * 4; pixels[i] = Math.max(0, Math.min(255, 128 + dx)); pixels[i + 1] = Math.max(0, Math.min(255, 128 + dy)); pixels[i + 2] = 128; pixels[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0); source.setAttribute('href', map.toDataURL()); displacement.setAttribute('scale', String(4 + Number(prefs.strength) * 3));
      target.style.filter = 'url(#' + id + ')'; frame = requestAnimationFrame(draw);
    }
    function move(event) {
      if (event.pointerType === 'touch' || !enabled() || document.hidden) { hide(); return; }
      const input = event.target.closest?.('input,textarea,select,[contenteditable="true"],dialog,.popup,.nw-effects-menu');
      const showWhale = prefs.whale && !input;
      pointer.classList.toggle('visible', showWhale); document.documentElement.classList.toggle('nw-whale-active', showWhale);
      if (showWhale) pointer.style.transform = 'translate3d(' + (event.clientX - 4) + 'px,' + (event.clientY - 8) + 'px,0)';
      if (!prefs.ripple || suspended() || input) { clear(); return; }
      const next = event.target.closest?.(selector); if (!next) return;
      if (next !== target) { clear(); target = next; originalFilter = next.style.filter; }
      const now = performance.now(); if (now - lastDrop < 65) return;
      lastDrop = now; const rect = target.getBoundingClientRect(); waves.push({ x: event.clientX - rect.left, y: event.clientY - rect.top, time: now }); waves = waves.slice(-5);
      if (!frame) frame = requestAnimationFrame(draw);
    }
    listen(document, 'pointermove', move, { passive: true });
    listen(document, 'pointerdown', () => { dragging = true; clear(); }); listen(document, 'pointerup', () => { dragging = false; });
    listen(document, 'selectionchange', () => { if (window.getSelection()?.toString()) clear(); });
    listen(document, 'visibilitychange', hide); listen(window, 'blur', hide); listen(document.documentElement, 'pointerleave', hide); listen(window, 'resize', clear); listen(document, 'scroll', clear, true); listen(reduced, 'change', clear);
    return { preferences: prefs, update(changes) { Object.assign(prefs, changes); prefs.strength = Math.max(1, Math.min(5, Number(prefs.strength) || 2)); hide(); onChange({ ...prefs }); }, clear: hide, dispose() { hide(); listeners.forEach(remove => remove()); pointer.remove(); svg.remove(); } };
  };
  if (window.novelCompiler) {
    function start() {
      let preferences = {}; try { preferences = JSON.parse(localStorage.getItem('nw-effects') || '{}'); } catch { /* use defaults */ }
      const effects = window.NovelWorldEffects({ preferences, onChange: value => localStorage.setItem('nw-effects', JSON.stringify(value)) });
      const menu = document.createElement('details'); menu.className = 'nw-effects-menu';
      menu.innerHTML = '<summary aria-label="阅读动效设置" title="阅读动效设置">≈</summary><div><strong>阅读动效</strong><label><input type="checkbox" data-pref="whale">小鲸鱼光标</label><label><input type="checkbox" data-pref="ripple">文字水波纹</label><label>涟漪强度<input aria-label="涟漪强度" type="range" min="1" max="5" data-pref="strength"></label><small>选中文字或编辑时，水波自动暂停。</small></div>';
      menu.querySelectorAll('input').forEach(input => { const key = input.dataset.pref; if (input.type === 'checkbox') input.checked = Boolean(effects.preferences[key]); else input.value = String(effects.preferences[key]); input.addEventListener('input', () => effects.update({ [key]: input.type === 'checkbox' ? input.checked : Number(input.value) })); });
      document.body.append(menu); document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.open = false; });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  }
})();
