// ==UserScript==
// @name         YouTube → Watch With Friends
// @namespace    watch-with-friends
// @version      1.0
// @description  Beim Hover über ein YouTube-Thumbnail erscheint unter "Später ansehen"/"Zur Wiedergabeliste" ein Button, der das Video in die Queue eines Watch-With-Friends-Raums legt.
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  // Server und Raum werden über das Tampermonkey-Menü gesetzt (oder beim ersten Klick abgefragt).
  const settings = {
    get url() { return GM_getValue('wwfUrl', ''); },
    set url(v) { GM_setValue('wwfUrl', v); },
    get roomId() { return GM_getValue('roomId', ''); },
    set roomId(v) { GM_setValue('roomId', v); },
    get roomName() { return GM_getValue('roomName', ''); },
    set roomName(v) { GM_setValue('roomName', v); },
  };

  const HOST_SEL = 'ytd-thumbnail, yt-thumbnail-view-model, ytd-video-preview';
  const ITEM_SEL = [
    'yt-lockup-view-model', 'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer',
    'ytd-grid-video-renderer', 'ytd-playlist-video-renderer', 'ytd-playlist-panel-video-renderer', 'ytd-reel-item-renderer',
  ].join(', ');
  const VIDEO_LINK_SEL = 'a[href*="/watch?v="], a[href*="/shorts/"]';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    idle: 'M21 3H3c-1.11 0-2 .89-2 2v12c0 1.1.89 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.11-.9-2-2-2zm0 14H3V5h18v12zm-5-7v2h-3v3h-2v-3H8v-2h3V7h2v3h3z',
    done: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    error: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  };

  const added = new Set(); // in dieser Sitzung bereits eingereihte Video-IDs

  // ---------- Styles (kein innerHTML wegen YouTubes Trusted Types) ----------

  const style = document.createElement('style');
  style.textContent = `
    .wwf-btn {
      position: absolute; top: 72px; right: 4px; z-index: 1000;
      width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, .6); color: #fff; cursor: pointer;
      opacity: 0; pointer-events: none; transition: opacity .15s, background-color .15s;
    }
    :hover > .wwf-btn, .wwf-btn.wwf-busy { opacity: 1; pointer-events: auto; }
    .wwf-btn:hover { background: rgba(0, 0, 0, .85); }
    .wwf-btn.wwf-done { background: #2e7d32; }
    .wwf-btn.wwf-error { background: #c62828; }
    .wwf-btn svg { width: 18px; height: 18px; fill: currentColor; pointer-events: none; }
    .wwf-spin {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, .35); border-top-color: #fff;
      animation: wwf-rot .8s linear infinite;
    }
    @keyframes wwf-rot { to { transform: rotate(360deg); } }
    .wwf-label {
      position: absolute; right: calc(100% + 4px); top: 50%; transform: translateY(-50%);
      padding: 4px 8px; border-radius: 4px; white-space: nowrap;
      background: rgba(0, 0, 0, .85); color: #fff; font: 500 12px/16px Roboto, Arial, sans-serif;
      opacity: 0; pointer-events: none; transition: opacity .15s;
    }
    .wwf-btn:hover .wwf-label, .wwf-btn.wwf-busy .wwf-label { opacity: 1; }
    .wwf-toast {
      position: fixed; left: 24px; bottom: 24px; z-index: 99999; max-width: 420px;
      padding: 12px 16px; border-radius: 8px; background: #212121; color: #fff;
      font: 400 14px/20px Roboto, Arial, sans-serif; box-shadow: 0 4px 12px rgba(0, 0, 0, .4);
      opacity: 0; transform: translateY(8px); transition: opacity .2s, transform .2s; pointer-events: none;
    }
    .wwf-toast.wwf-show { opacity: 1; transform: none; }
    .wwf-toast.wwf-error { background: #b71c1c; }
  `;
  document.head.append(style);

  // ---------- Button ----------

  function icon(d) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  function idleLabel() {
    return settings.roomName ? `In „${settings.roomName}“ einreihen (⇧ = als Nächstes)` : 'In Watch With Friends einreihen';
  }

  function setState(btn, state, text) {
    btn.classList.remove('wwf-busy', 'wwf-done', 'wwf-error');
    if (state !== 'idle') btn.classList.add(`wwf-${state}`);
    let visual;
    if (state === 'busy') {
      visual = document.createElement('div');
      visual.className = 'wwf-spin';
    } else {
      visual = icon(ICONS[state]);
    }
    const label = document.createElement('span');
    label.className = 'wwf-label';
    label.textContent = text || {
      idle: idleLabel(),
      busy: 'Wird eingereiht…',
      done: 'In der Queue',
      error: 'Fehler – nochmal klicken',
    }[state];
    btn.replaceChildren(visual, label);
    btn.setAttribute('aria-label', label.textContent);
  }

  function makeButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wwf-btn';
    // Klicks dürfen nicht beim Thumbnail-Link ankommen (sonst öffnet sich das Video)
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'dblclick']) {
      btn.addEventListener(type, (e) => e.stopPropagation());
    }
    btn.addEventListener('click', onClick, true);
    return btn;
  }

  async function onClick(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const btn = e.currentTarget;
    const vid = btn.dataset.vid;
    if (!vid || btn.classList.contains('wwf-busy')) return;

    setState(btn, 'busy');
    try {
      const result = await queueVideo(vid, e.shiftKey);
      added.add(vid);
      const exists = result.status === 'exists';
      if (btn.dataset.vid === vid) setState(btn, 'done', exists ? 'Schon in der Queue' : 'Eingereiht');
      toast(exists ? `Schon in der Queue von „${result.room}“` : `„${result.title}“ → ${result.room}`);
    } catch (err) {
      console.error('[Watch With Friends]', err);
      if (btn.dataset.vid === vid) setState(btn, err.cancelled ? 'idle' : 'error');
      if (!err.cancelled) toast(`Fehler: ${err.message}`, true);
    }
  }

  // ---------- Hover-Erkennung ----------

  let currentHost = null;

  document.addEventListener('mouseover', (e) => {
    const host = e.target.closest?.(HOST_SEL) || null;
    if (host === currentHost) return;
    currentHost = host;
    if (host) onEnter(host);
  }, true);

  function onEnter(host) {
    const vid = videoIdFor(host);
    if (!vid) return;

    // Die Inline-Vorschau hat Rand um das Video – Button in den Video-Container setzen
    const parent = host.matches('ytd-video-preview')
      ? host.querySelector('video')?.closest('ytd-video-preview > *') || host
      : host;
    let btn = parent.querySelector(':scope > .wwf-btn');
    if (!btn) {
      btn = makeButton();
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.append(btn);
    }
    // YouTube recycelt Elemente – deshalb bei jedem Hover die aktuelle Video-ID prüfen
    if (btn.dataset.vid !== vid) {
      btn.dataset.vid = vid;
      setState(btn, added.has(vid) ? 'done' : 'idle');
    }
    // Die YouTube-Hover-Buttons werden animiert eingeblendet, also mehrmals nachjustieren
    for (const delay of [0, 120, 350, 800]) setTimeout(() => position(parent, btn), delay);
  }

  function parseVideoId(href) {
    try {
      const url = new URL(href, location.origin);
      if (url.pathname === '/watch') return url.searchParams.get('v');
      return url.pathname.match(/^\/shorts\/([\w-]{11})/)?.[1] || null;
    } catch {
      return null;
    }
  }

  function videoIdFor(host) {
    const candidates = [
      host.closest('a[href]'),
      host.querySelector(VIDEO_LINK_SEL),
      host.closest(ITEM_SEL)?.querySelector(VIDEO_LINK_SEL),
    ];
    for (const a of candidates) {
      const vid = a && parseVideoId(a.getAttribute('href'));
      if (vid) return vid;
    }
    return null;
  }

  // Sucht den untersten YouTube-Button oben rechts im Thumbnail und setzt unseren direkt darunter.
  function position(host, btn) {
    if (!host.isConnected) return;
    const hr = host.getBoundingClientRect();
    if (!hr.width || !hr.height) return;

    const scope = host.closest(ITEM_SEL) || host;
    let lowest = null;
    let lowestRect = null;
    for (const el of scope.querySelectorAll('button, ytd-thumbnail-overlay-toggle-button-renderer')) {
      if (el === btn || btn.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.height > 60) continue;
      if (r.right < hr.right - 80 || r.right > hr.right + 1) continue;
      if (r.top < hr.top - 1 || r.top > hr.top + hr.height / 2) continue;
      if (!lowestRect || r.bottom > lowestRect.bottom) {
        lowest = el;
        lowestRect = r;
      }
    }

    if (lowestRect) {
      btn.style.top = `${Math.round(lowestRect.bottom - hr.top + 4)}px`;
      btn.style.right = `${Math.round(hr.right - lowestRect.right)}px`;
      const size = Math.round(lowestRect.height);
      if (size >= 20 && size <= 48) {
        btn.style.width = btn.style.height = `${size}px`;
      }
      const radius = getComputedStyle(lowest).borderRadius;
      if (radius && radius !== '0px') btn.style.borderRadius = radius;
    }
  }

  // ---------- Watch With Friends API ----------

  function cancelled() {
    const err = new Error('Abgebrochen');
    err.cancelled = true;
    return err;
  }

  // GM_xmlhttpRequest umgeht CORS und schickt das wwf_session-Cookie mit
  function wwf(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: settings.url + path,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        data: body ? JSON.stringify(body) : undefined,
        timeout: 30000,
        onload: (r) => {
          let data = null;
          try {
            data = JSON.parse(r.responseText);
          } catch {
            /* z. B. HTML einer Login-Seite vor dem Server */
          }
          if (r.status === 401) {
            const err = new Error('Nicht bei Watch With Friends eingeloggt');
            err.status = 401;
            reject(err);
          } else if (r.status < 200 || r.status >= 300) {
            reject(new Error(data?.error || `HTTP ${r.status}`));
          } else if (!data || typeof data !== 'object') {
            reject(new Error('Unerwartete Antwort vom Server – Adresse prüfen'));
          } else {
            resolve(data);
          }
        },
        onerror: () => reject(new Error(`${settings.url} nicht erreichbar`)),
        ontimeout: () => reject(new Error('Zeitüberschreitung')),
      });
    });
  }

  function askServerUrl() {
    const input = prompt(
      'Adresse deines Watch-With-Friends-Servers (z. B. https://wwf.example.de oder http://localhost:8080):',
      settings.url || 'http://localhost:8080'
    );
    if (input === null) return false;
    const url = input.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+/i.test(url)) {
      alert('Bitte eine Adresse mit http:// oder https:// angeben.');
      return false;
    }
    settings.url = url;
    settings.roomId = settings.roomName = '';
    return true;
  }

  async function chooseRoom() {
    if (!settings.url && !askServerUrl()) return false;
    const { rooms } = await wwf('GET', '/api/rooms');
    const usable = (rooms || []).filter((r) => r.myRole || r.isPublic);
    if (!usable.length) throw new Error('Keine Räume gefunden – erst einen Raum in Watch With Friends betreten');
    const list = usable.map((r, i) => `${i + 1}) ${r.name}${r.queueCount ? ` (${r.queueCount} in der Queue)` : ''}`).join('\n');
    const current = usable.findIndex((r) => r.id === settings.roomId);
    const input = prompt(`In welchen Raum sollen Videos?\n\n${list}\n\nNummer eingeben:`, String(current >= 0 ? current + 1 : 1));
    if (input === null) return false;
    const room = usable[Number(input) - 1];
    if (!room) {
      alert('Ungültige Nummer.');
      return false;
    }
    settings.roomId = room.id;
    settings.roomName = room.name;
    return true;
  }

  async function queueVideo(videoId, atTop) {
    if (!settings.url && !askServerUrl()) throw cancelled();
    if (!settings.roomId && !(await chooseRoom())) throw cancelled();
    try {
      return await wwf('POST', `/api/rooms/${encodeURIComponent(settings.roomId)}/queue`, {
        url: `https://www.youtube.com/watch?v=${videoId}`,
        atTop,
      });
    } catch (err) {
      if (err.status === 401 && confirm(`${err.message}.\n\nLogin-Seite jetzt in neuem Tab öffnen?`)) {
        GM_openInTab(`${settings.url}/login`, { active: true });
      }
      throw err;
    }
  }

  GM_registerMenuCommand('Raum auswählen', () => {
    chooseRoom()
      .then((ok) => ok && toast(`Videos landen jetzt in „${settings.roomName}“`))
      .catch((err) => toast(`Fehler: ${err.message}`, true));
  });
  GM_registerMenuCommand('Server-Adresse ändern', () => {
    if (askServerUrl()) toast(`Server: ${settings.url} – beim nächsten Klick Raum wählen`);
  });

  // ---------- Toast ----------

  let toastEl = null;
  let toastTimer = 0;

  function toast(text, isError = false) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'wwf-toast';
      document.body.append(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.toggle('wwf-error', isError);
    requestAnimationFrame(() => toastEl.classList.add('wwf-show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('wwf-show'), isError ? 5000 : 2500);
  }
})();
