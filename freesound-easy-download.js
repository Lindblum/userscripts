// ==UserScript==
// @author       Lindblum
// @name         Freesound Easy Download
// @namespace    https://github.com/lindblum/userscripts
// @version      1.2
// @description  Makes the download-count link on Freesound search results download the sound file directly (instead of go to a download page), and lets Right/Left arrows play the next/previous sound (moving across results pages)
// @match        https://freesound.org/*
// @run-at       document-idle
// @grant        none
// @copyright    2026, Lindblum
// ==/UserScript==

/*
Each result has a download-count link that opens a "downloaders" modal:
  <a href="javascript:void(0)" data-toggle="modal-default" data-modal-content-url="/people/{user}/sounds/{id}/downloaders/?ajax=1">
The sound page (/people/{user}/sounds/{id}/) carries the real file link:
  <a class="... sound-download-button" href="/people/{user}/sounds/{id}/download/{id}__{user}__{slug}.wav">
The filename slug and extension (wav/flac/aiff/mp3...) can't be derived reliably from the result,
so the sound page is fetched on hover/focus and the link's href is swapped for the file URL.
*/

(function () {
  'use strict';

  const LINK_SELECTOR = 'a[data-modal-content-url*="/downloaders/"]';
  const MARK = 'tmEasyDownload';

  // sound page URL -> Promise<download URL or null>
  const cache = new Map();

  function soundPageUrl(link) {
    const url = link.getAttribute('data-modal-content-url') || '';
    const m = url.match(/^(\/people\/[^/]+\/sounds\/\d+\/)downloaders\//);
    return m ? m[1] : null;
  }

  function resolve(pageUrl) {
    if (!cache.has(pageUrl)) {
      const p = fetch(pageUrl, { credentials: 'same-origin' })
        .then((res) => (res.ok ? res.text() : Promise.reject(new Error(res.status))))
        .then((html) => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const btn = doc.querySelector('a.sound-download-button[href*="/download/"]');
          return btn ? new URL(btn.getAttribute('href'), location.origin).href : null;
        })
        .catch((err) => {
          cache.delete(pageUrl); // allow a retry later
          console.warn('[Freesound Easy Download] failed to resolve', pageUrl, err);
          return null;
        });
      cache.set(pageUrl, p);
    }
    return cache.get(pageUrl);
  }

  function prepare(link) {
    const pageUrl = soundPageUrl(link);
    if (!pageUrl) return null;
    if (link.dataset[MARK] !== 'ready') {
      link.dataset[MARK] = 'pending';
      resolve(pageUrl).then((url) => {
        if (!url) return;
        link.href = url;
        link.title = 'Download ' + decodeURIComponent(url.split('/').pop());
        link.dataset[MARK] = 'ready';
      });
    }
    return pageUrl;
  }

  function onHover(e) {
    const link = e.target.closest && e.target.closest(LINK_SELECTOR);
    if (link) prepare(link);
  }

  // Capture phase on document runs before Freesound's own modal handler on the link
  function onClick(e) {
    if (e.button !== 0) return;
    const link = e.target.closest && e.target.closest(LINK_SELECTOR);
    if (!link) return;
    const pageUrl = prepare(link);
    if (!pageUrl) return;

    e.stopImmediatePropagation();
    // Once the href is the real file, let the browser handle it (keeps ctrl/shift-click behaviour)
    if (link.dataset[MARK] === 'ready') return;
    e.preventDefault();

    resolve(pageUrl).then((url) => {
      // Not logged in or the page changed: fall back to the sound page, which has the normal download button
      location.href = url || pageUrl;
    });
  }

  // Right/Left arrows: pause the current player and play the next/previous one.
  // Players are driven through their own play buttons so Freesound's UI stays in sync.
  function players() {
    return [...document.querySelectorAll('.bw-player[data-sound-id]')].filter((p) => p.offsetParent !== null);
  }

  function isPlaying(player) {
    const audio = player.querySelector('audio');
    return !!audio && !audio.paused && !audio.ended;
  }

  function onKey(e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;

    const list = players();
    if (!list.length) return;
    const current = list.find(isPlaying) || list.find((p) => p.classList.contains('last-played'));
    const i = current ? list.indexOf(current) : -1;
    const forward = e.key === 'ArrowRight';
    const next = list[forward ? i + 1 : (i < 0 ? 0 : i - 1)];

    // Past either end of the list: go to the adjacent results page and resume there
    if (!next) {
      const href = pageHref(forward ? 1 : -1);
      if (!href) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (current && isPlaying(current)) playButton(current)?.click();
      try { sessionStorage.setItem(AUTOPLAY_KEY, forward ? 'first' : 'last'); } catch (_) {}
      location.href = href;
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();
    if (current && isPlaying(current)) playButton(current)?.click();
    play(next);
  }

  function playButton(player) {
    return player.querySelector('.bw-player__play-btn');
  }

  function play(player) {
    playButton(player)?.click();
    player.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // URL of the page `delta` away, taken from a pagination link so we only move to pages that exist
  function pageHref(delta) {
    const target = String(parseInt(new URLSearchParams(location.search).get('page') || '1', 10) + delta);
    const link = [...document.querySelectorAll('a[href*="page="]')].find((a) => {
      const u = new URL(a.href, location.href);
      return u.pathname === location.pathname && u.searchParams.get('page') === target;
    });
    return link ? link.href : null;
  }

  // After an arrow key changed pages, play the first (Right) or last (Left) sound.
  // The browser's autoplay policy may block this; the arrows still work from the start of the list.
  const AUTOPLAY_KEY = 'tmFreesoundAutoplay';
  let pendingAutoplay = null;
  try {
    pendingAutoplay = sessionStorage.getItem(AUTOPLAY_KEY);
    sessionStorage.removeItem(AUTOPLAY_KEY);
  } catch (_) {}
  if (pendingAutoplay) {
    const list = players();
    const target = pendingAutoplay === 'last' ? list[list.length - 1] : list[0];
    if (target) play(target);
  }

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mouseover', onHover, true);
  document.addEventListener('focusin', onHover, true);
  document.addEventListener('click', onClick, true);
})();
