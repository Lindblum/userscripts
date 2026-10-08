// ==UserScript==
// @author       Lindblum
// @name         YouTube Caption Translation Gloss
// @namespace    https://www.youtube.com/
// @version      1.2
// @description  Shows a small-font translation gloss (in your default language) above each word of foreign-language YouTube captions
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      translate.googleapis.com
// @copyright    2026, Lindblum
// ==/UserScript==

/*
How it works
  - Captions: the player renders each caption line as
      .ytp-caption-window-container > .caption-window > .captions-text > .caption-visual-line > span.ytp-caption-segment
    Each segment's original text nodes are moved (not copied) into a hidden span.cth-orig, so the player can keep
    updating them, and a span.cth-out with one <ruby>word<rt>translation</rt></ruby> per word is shown instead.
  - Source language: the player's current caption track (movie_player.getOption('captions', 'track')),
    falling back to the lang/tlang of the last /api/timedtext request, then to 'auto'.
  - Transcripts: /api/timedtext requests are picked up from resource timing (the player's URL carries the
    proof-of-origin token that a bare caption baseUrl lacks), re-fetched as json3, and every word is translated
    up front so gloss notes are ready before the caption appears.
  - Translations: word lists are sent newline-separated to Google Translate's gtx endpoint and cached per
    language pair in GM storage.
  - Menu: Toggle gloss, Set gloss language
*/

(function () {
  'use strict';

  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t';
  const BATCH_CHARS = 1500;   // max characters of words per translation request
  const CACHE_MAX = 20000;    // max cached words per language pair
  const SCAN_INTERVAL = 1000; // ms between checks for a (new) caption container

  let enabled = GM_getValue('enabled', true);
  let targetLang = normLang(GM_getValue('targetLang', '') || navigator.language || 'en');

  const transcripts = new Map(); // "videoId-lang" -> { videoId, lang, lines: [text] }
  let lastTrack = null;          // { videoId, lang } of the most recent timedtext request

  //-------------------------------------------------------------------------- languages

  // YouTube codes (es-419, zh-Hans, pt-BR, ...) -> codes Google Translate accepts
  function normLang(code) {
    if (!code) return 'auto';
    code = String(code).replace('_', '-');
    const base = code.split('-')[0].toLowerCase();
    if (base === 'zh') return /TW|HK|MO|Hant/i.test(code) ? 'zh-TW' : 'zh-CN';
    if (base === 'fil') return 'tl';
    return base;
  } //normLang

  function sameLang(a, b) {
    return a !== 'auto' && a.split('-')[0] === b.split('-')[0] && (a.split('-')[0] !== 'zh' || a === b);
  } //sameLang

  function getPlayer() {
    try {
      return PAGE.document.getElementById('movie_player');
    } catch (e) {
      return null;
    }
  } //getPlayer

  function currentVideoId() {
    try {
      const data = getPlayer().getVideoData();
      if (data && data.video_id) return data.video_id;
    } catch (e) {}
    const url = new URL(location.href);
    const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
    return url.searchParams.get('v') || (m && m[1]) || '';
  } //currentVideoId

  let loggedLang = '';

  function currentSourceLang() {
    const lang = detectSourceLang();
    if (lang !== loggedLang) console.info('[Caption Gloss] caption language:', (loggedLang = lang));
    return lang;
  } //currentSourceLang

  function detectSourceLang() {
    const last = lastTrack && lastTrack.videoId === currentVideoId() ? lastTrack : null;
    try {
      const track = getPlayer().getOption('captions', 'track');
      if (track && track.languageCode) {
        const tl = track.translationLanguage;
        if (tl && tl.languageCode) return normLang(tl.languageCode);
        // For auto-translated captions the player's track can report only the original language; the
        // timedtext request for that same track carries the translation target as tlang
        if (last && normLang(last.origLang) === normLang(track.languageCode)) return normLang(last.lang);
        return normLang(track.languageCode);
      }
    } catch (e) {}
    if (last) return normLang(last.lang);
    return 'auto';
  } //currentSourceLang

  //-------------------------------------------------------------------------- words

  const segmenters = {};

  // -> [{ text, word }] covering the whole string; word=true for translatable tokens
  function tokenize(text, lang) {
    if (typeof Intl.Segmenter === 'function') {
      const loc = lang === 'auto' ? undefined : lang;
      const seg = segmenters[lang] || (segmenters[lang] = new Intl.Segmenter(loc, { granularity: 'word' }));
      return Array.from(seg.segment(text), s => ({ text: s.segment, word: !!s.isWordLike && /\p{L}/u.test(s.segment) }));
    }
    return text.split(/([\p{L}\p{M}\p{N}'’-]+)/u).filter(Boolean)
      .map(t => ({ text: t, word: /\p{L}/u.test(t) }));
  } //tokenize

  function wordKey(word) {
    return word.toLocaleLowerCase();
  } //wordKey

  //-------------------------------------------------------------------------- translation cache

  const caches = {};       // pair -> { key: translation }
  const dirtyPairs = new Set();
  let saveTimer = 0;

  function getCache(pair) {
    if (!caches[pair]) caches[pair] = GM_getValue('cache:' + pair, {}) || {};
    return caches[pair];
  } //getCache

  function saveCaches() {
    for (const pair of dirtyPairs) {
      let cache = caches[pair];
      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX) {
        cache = caches[pair] = Object.fromEntries(keys.slice(-CACHE_MAX).map(k => [k, cache[k]]));
      }
      GM_setValue('cache:' + pair, cache);
    }
    dirtyPairs.clear();
  } //saveCaches

  function scheduleSave(pair) {
    dirtyPairs.add(pair);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCaches, 2000);
  } //scheduleSave

  //-------------------------------------------------------------------------- translation requests

  const pending = new Map();  // pair -> Set of keys waiting for translation
  const inflight = new Set(); // "pair|key"
  let flushing = false;

  function gmPost(url, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST',
      url,
      data: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      timeout: 15000,
      onload: r => (r.status === 200 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timeout'))
    }));
  } //gmPost

  async function translateLines(src, tgt, lines) {
    const url = `${TRANSLATE_URL}&sl=${encodeURIComponent(src)}&tl=${encodeURIComponent(tgt)}`;
    const data = JSON.parse(await gmPost(url, 'q=' + encodeURIComponent(lines.join('\n'))));
    return (data[0] || []).map(s => s[0] || '').join('').split('\n').map(s => s.trim());
  } //translateLines

  async function translateWords(src, tgt, words) {
    const out = await translateLines(src, tgt, words);
    if (out.length === words.length) return out;
    // Google merged or split lines; fall back to one request per word
    const single = [];
    for (const w of words) single.push((await translateLines(src, tgt, [w]))[0] || '');
    return single;
  } //translateWords

  function requestTranslations(pair, keys) {
    const cache = getCache(pair);
    let set = pending.get(pair);
    for (const k of keys) {
      if (k in cache || inflight.has(pair + '|' + k)) continue;
      if (!set) pending.set(pair, set = new Set());
      set.add(k);
    }
    if (set && set.size && !flushing) flush();
  } //requestTranslations

  async function flush() {
    flushing = true;
    try {
      while (pending.size) {
        const [pair, set] = pending.entries().next().value;
        const batch = [];
        let chars = 0;
        for (const k of set) {
          if (batch.length && chars + k.length + 1 > BATCH_CHARS) break;
          batch.push(k);
          chars += k.length + 1;
        }
        for (const k of batch) {
          set.delete(k);
          inflight.add(pair + '|' + k);
        }
        if (!set.size) pending.delete(pair);

        const [src, tgt] = pair.split('>');
        try {
          const result = await translateWords(src, tgt, batch);
          const cache = getCache(pair);
          batch.forEach((k, i) => { cache[k] = result[i]; });
          scheduleSave(pair);
          refreshGlosses(pair);
        } catch (e) {
          console.warn('[Caption Gloss] Translation failed:', e);
          await new Promise(r => setTimeout(r, 5000));
        } finally {
          for (const k of batch) inflight.delete(pair + '|' + k);
        }
      }
    } finally {
      flushing = false;
    }
  } //flush

  //-------------------------------------------------------------------------- caption rendering

  const CSS = `
    .ytp-caption-segment .cth-orig { display: none; }
    .ytp-caption-segment ruby.cth-w { ruby-position: over; ruby-align: center; }
    .ytp-caption-segment rt.cth-t {
      font-size: 0.5em; line-height: 1.1; font-weight: normal; font-style: normal;
      letter-spacing: 0; text-transform: none; color: #ffe27a; opacity: 0.9; padding-bottom: 0.05em;
    }
    .ytp-caption-segment rt.cth-t:empty::before { content: '\\00a0'; }
    .ytp-caption-window-container .caption-window { overflow: visible; }
  `;

  function currentContext() {
    const src = currentSourceLang();
    const pair = src + '>' + targetLang;
    return { src, pair, active: enabled && !sameLang(src, targetLang) };
  } //currentContext

  // Moves any nodes the player added straight into the segment into .cth-orig; returns the original text
  function adoptOriginal(seg) {
    let orig = seg.querySelector(':scope > .cth-orig');
    for (const n of Array.from(seg.childNodes)) {
      if (n === orig || (n.classList && n.classList.contains('cth-out'))) continue;
      if (!orig) {
        orig = document.createElement('span');
        orig.className = 'cth-orig';
        seg.prepend(orig);
      }
      orig.append(n);
    }
    return orig;
  } //adoptOriginal

  function restoreSegment(seg) {
    const orig = seg.querySelector(':scope > .cth-orig');
    if (!orig) return;
    seg.querySelector(':scope > .cth-out')?.remove();
    seg.replaceChildren(...orig.childNodes);
    delete seg.dataset.cthRaw;
    delete seg.dataset.cthPair;
  } //restoreSegment

  function fillGloss(rt, cache) {
    const t = cache[rt.dataset.key];
    // hide glosses that just repeat the word (names, cognates, same-language captions)
    rt.textContent = t && wordKey(t) !== rt.dataset.key ? t : '';
  } //fillGloss

  function processSegment(seg, ctx) {
    if (!ctx.active) {
      restoreSegment(seg);
      return;
    }
    const orig = adoptOriginal(seg);
    const raw = orig ? orig.textContent : '';
    if (seg.dataset.cthRaw === raw && seg.dataset.cthPair === ctx.pair && seg.querySelector(':scope > .cth-out')) return;
    seg.dataset.cthRaw = raw;
    seg.dataset.cthPair = ctx.pair;

    const cache = getCache(ctx.pair);
    const out = document.createElement('span');
    out.className = 'cth-out';
    const missing = [];
    for (const tok of tokenize(raw, ctx.src)) {
      if (!tok.word) {
        out.append(tok.text);
        continue;
      }
      const key = wordKey(tok.text);
      const ruby = document.createElement('ruby');
      ruby.className = 'cth-w';
      const rt = document.createElement('rt');
      rt.className = 'cth-t';
      rt.dataset.key = key;
      ruby.append(tok.text, rt);
      out.append(ruby);
      if (key in cache) fillGloss(rt, cache);
      else missing.push(key);
    }
    seg.querySelector(':scope > .cth-out')?.remove();
    seg.append(out);
    if (missing.length) requestTranslations(ctx.pair, missing);
  } //processSegment

  function refreshGlosses(pair) {
    const cache = getCache(pair);
    for (const seg of document.querySelectorAll('.ytp-caption-segment')) {
      if (seg.dataset.cthPair !== pair) continue;
      for (const rt of seg.querySelectorAll('rt.cth-t')) fillGloss(rt, cache);
    }
  } //refreshGlosses

  function scanCaptions() {
    const ctx = currentContext();
    for (const seg of document.querySelectorAll('.ytp-caption-segment')) processSegment(seg, ctx);
  } //scanCaptions

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scanCaptions();
    });
  } //queueScan

  const observed = new WeakSet();
  const observer = new MutationObserver(queueScan);

  function attachObservers() {
    for (const c of document.querySelectorAll('.ytp-caption-window-container')) {
      if (observed.has(c)) continue;
      observed.add(c);
      observer.observe(c, { childList: true, subtree: true, characterData: true });
      queueScan();
    }
  } //attachObservers

  //-------------------------------------------------------------------------- transcripts

  async function loadTranscript(resourceUrl) {
    let url;
    try {
      url = new URL(resourceUrl, location.href);
    } catch (e) {
      return;
    }
    const videoId = url.searchParams.get('v');
    const origLang = url.searchParams.get('lang');
    const lang = url.searchParams.get('tlang') || origLang;
    if (!videoId || !lang) return;
    lastTrack = { videoId, origLang, lang };
    queueScan();

    const id = `${videoId}-${lang}`;
    if (transcripts.has(id)) return;
    url.searchParams.set('fmt', 'json3');
    transcripts.set(id, null); // claim it so the same track isn't fetched twice
    try {
      const res = await fetch(url.href, { credentials: 'include' });
      const data = JSON.parse(await res.text());
      const lines = [];
      for (const e of data.events || []) {
        if (!e.segs) continue;
        const text = e.segs.map(s => s.utf8 || '').join('').replace(/\s*\n\s*/g, ' ').trim();
        if (text) lines.push(text);
      }
      transcripts.set(id, { videoId, lang, lines });
      pretranslate(transcripts.get(id));
    } catch (e) {
      transcripts.delete(id);
      console.warn('[Caption Gloss] Could not load transcript', id, e);
    }
  } //loadTranscript

  function pretranslate(transcript) {
    const src = normLang(transcript.lang);
    if (!enabled || sameLang(src, targetLang)) return;
    const keys = new Set();
    for (const line of transcript.lines) {
      for (const tok of tokenize(line, src)) if (tok.word) keys.add(wordKey(tok.text));
    }
    requestTranslations(src + '>' + targetLang, keys);
  } //pretranslate

  function watchTimedText() {
    const handle = entries => {
      for (const e of entries) if (e.name.includes('/api/timedtext')) loadTranscript(e.name);
    };
    try {
      new PerformanceObserver(list => handle(list.getEntries())).observe({ type: 'resource', buffered: true });
    } catch (e) {
      handle(performance.getEntriesByType('resource'));
    }
  } //watchTimedText

  function currentTranscript() {
    const videoId = currentVideoId();
    const src = currentSourceLang();
    let match = null;
    for (const t of transcripts.values()) {
      if (!t || t.videoId !== videoId) continue;
      if (normLang(t.lang) === src) return t;
      match = t;
    }
    return match;
  } //currentTranscript

  //-------------------------------------------------------------------------- menu & init

  function rerenderAll() {
    for (const seg of document.querySelectorAll('.ytp-caption-segment')) delete seg.dataset.cthPair;
    queueScan();
    const t = currentTranscript();
    if (t) pretranslate(t);
  } //rerenderAll

  GM_registerMenuCommand('Toggle caption translation gloss', () => {
    enabled = !enabled;
    GM_setValue('enabled', enabled);
    rerenderAll();
  });

  GM_registerMenuCommand('Set gloss language…', () => {
    const v = prompt('Translate caption words into which language? (e.g. en, es, de, ja, zh-CN)\nLeave empty to use the browser default.', targetLang);
    if (v === null) return;
    GM_setValue('targetLang', v.trim());
    targetLang = normLang(v.trim() || navigator.language || 'en');
    rerenderAll();
  });

  function init() {
    const style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
    watchTimedText();
    attachObservers();
    setInterval(attachObservers, SCAN_INTERVAL);
  } //init

  init();
})();
