// ==UserScript==
// @author       Lindblum
// @name         Freesound Easy Download
// @namespace    https://github.com/lindblum/userscripts
// @version      1.0
// @description  Makes the download-count link on Freesound search results (and other sound lists) download the original sound file directly instead of opening the downloaders list
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

  document.addEventListener('mouseover', onHover, true);
  document.addEventListener('focusin', onHover, true);
  document.addEventListener('click', onClick, true);
})();
