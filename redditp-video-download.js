// ==UserScript==
// @author       Lindblum
// @name         Redditp Video Download
// @namespace    https://github.com/lindblum/userscripts
// @version      1.0
// @description  Adds a download button for the video on the current redditp.com slide. Reddit-hosted (v.redd.it) videos save as separate video and audio files
// @match        https://redditp.com/*
// @match        https://*.redditp.com/*
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @copyright    2026, Lindblum
// ==/UserScript==

/*
redditp renders videos two ways (js/EmbedIt.js):
  imgur .gifv / gfycat   <video> with <source> children pointing at real .mp4/.webm files -> currentSrc is downloadable
  v.redd.it              empty <video> fed by dash.js from photo.dashUrl -> src is a MediaSource blob: URL, not downloadable
For v.redd.it we read the DASH manifest and pick the highest-bandwidth video and audio representations,
which are plain .mp4 files (e.g. DASH_1080.mp4, DASH_AUDIO_128.mp4). Reddit stores them separately, so we save two files.
*/

(function () {
  'use strict';

  const BUTTON_ID = 'tm-redditp-download';

  const CSS = `
    #${BUTTON_ID} {
      position:fixed; right:16px; bottom:16px; z-index:10000; display:none;
      padding:6px 12px; font:13px sans-serif; cursor:pointer;
      color:#fff; background:rgba(0,0,0,0.6); border:1px solid rgba(255,255,255,0.4); border-radius:4px;
    }
    #${BUTTON_ID}:hover { background:rgba(0,0,0,0.85); }
    #${BUTTON_ID}[disabled] { opacity:0.5; cursor:wait; }
  `;

  const rp = () => unsafeWindow.rp;

  function activePhoto() {
    const r = rp();
    if (!r || !r.photos || !r.session) return null;
    return r.photos[r.session.activeIndex] || null;
  }

  // Slides are prepended to #pictureSlider, so the first video is the active one
  // (redditp's own initDash makes the same assumption).
  function activeVideo() {
    return document.querySelector('#pictureSlider video');
  }

  function isRedditVideo(photo) {
    return !!(photo && (photo.dashUrl || /v\.redd\.it/.test(photo.url || '')));
  }

  function baseName(photo) {
    const title = (photo && photo.title ? photo.title : 'video')
      .replace(/<[^>]*>/g, '')
      .replace(/[\\/:*?"<>|\s]+/g, ' ')
      .trim()
      .slice(0, 80);
    const id = (photo && photo.commentsLink || '').match(/comments\/([a-z0-9]+)/i);
    return id ? `${title} [${id[1]}]` : title;
  }

  function extOf(url, fallback) {
    const m = new URL(url, location.href).pathname.match(/\.(\w{2,4})$/);
    return m ? m[1] : fallback;
  }

  // Returns the highest-bandwidth representation URL for the given content type, or null.
  function bestRepresentation(mpd, mpdUrl, type) {
    let best = null;
    for (const set of mpd.querySelectorAll('AdaptationSet')) {
      const setType = set.getAttribute('contentType') || (set.getAttribute('mimeType') || '').split('/')[0];
      for (const rep of set.querySelectorAll('Representation')) {
        const repType = setType || (rep.getAttribute('mimeType') || '').split('/')[0];
        if (repType !== type) continue;
        const baseUrl = rep.querySelector('BaseURL');
        if (!baseUrl) continue;
        const bandwidth = Number(rep.getAttribute('bandwidth')) || 0;
        if (!best || bandwidth > best.bandwidth) {
          best = { bandwidth, url: new URL(baseUrl.textContent.trim(), mpdUrl).href };
        }
      }
    }
    return best && best.url;
  }

  async function redditVideoUrls(photo) {
    const mpdUrl = photo.dashUrl || photo.url.replace(/\/DASH_[^/]*$/, '') + '/DASHPlaylist.mpd';
    try {
      const res = await fetch(mpdUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mpd = new DOMParser().parseFromString(await res.text(), 'application/xml');
      return {
        video: bestRepresentation(mpd, mpdUrl, 'video') || photo.url,
        audio: bestRepresentation(mpd, mpdUrl, 'audio')
      };
    } catch (err) {
      // Fall back to fallback_url (video only, no sound).
      console.warn('[redditp-video-download] manifest failed, using fallback_url', err);
      return { video: photo.url, audio: null };
    }
  }

  function download(url, name) {
    return new Promise((resolve) => {
      GM_download({
        url,
        name,
        onload: resolve,
        onerror: (e) => { console.error('[redditp-video-download] download failed', name, e); resolve(); },
        ontimeout: resolve
      });
    });
  }

  async function downloadActive() {
    const photo = activePhoto();
    const video = activeVideo();
    const name = baseName(photo);

    if (isRedditVideo(photo)) {
      const urls = await redditVideoUrls(photo);
      const jobs = [download(urls.video, `${name} - video.${extOf(urls.video, 'mp4')}`)];
      if (urls.audio) jobs.push(download(urls.audio, `${name} - audio.${extOf(urls.audio, 'mp4')}`));
      await Promise.all(jobs);
      return;
    }

    const src = video && (video.currentSrc || video.src);
    if (src && !src.startsWith('blob:')) {
      await download(src, `${name}.${extOf(src, 'mp4')}`);
    } else {
      alert('No downloadable video found on this slide.');
    }
  }

  function updateButton() {
    const button = document.getElementById(BUTTON_ID);
    if (button) button.style.display = activeVideo() ? 'block' : 'none';
  }

  function init() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '⬇ Download video';
    button.title = 'Download the video on this slide (Reddit videos save as separate video + audio files)';
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      button.disabled = true;
      try { await downloadActive(); } finally { button.disabled = false; }
    });
    document.body.appendChild(button);

    const slider = document.getElementById('pictureSlider');
    if (slider) new MutationObserver(updateButton).observe(slider, { childList: true, subtree: true });
    updateButton();

    GM_registerMenuCommand('Download current video', downloadActive);
  }

  init();
})();
