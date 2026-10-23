// ==UserScript==
// @author       Lindblum
// @name         Shudder Improvements
// @namespace    https://github.com/lindblum/userscripts
// @version      1.11
// @description  Adds a Trailer button linking to a YouTube trailer on Shudder movie pages that don't have their own trailer, the director in movie pages' details row, the year and director on cards with a runtime (Home, More Like This), sort options (A-Z, Z-A, Year, Director) and each film's year and director on My List, and Year/Director sorting on Shudder's own sort bars
// @match        https://watch.shudder.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      www.youtube.com
// @connect      query.wikidata.org
// @connect      en.wikipedia.org
// @copyright    2026, Lindblum
// ==/UserScript==

/*
How it works
  - Shudder is a React (react-native-web) SPA; /video/<id> pages render their action buttons as
      [data-testid$="mapped-button-list"] > div.composed-button > ... > button[aria-label="Trailer" | "Add to my list" | ...]
    The css-* and r-* classes are hashed atomic styles, so they're only copied for looks, never used to find things.
  - Once that row has rendered, a page with no button[aria-label="Trailer"] gets our own composed-button
    (an <a>, styled by copying the row's native button) prepended in the same spot.
  - The trailer is the best of the top YouTube results for "<title> <year> trailer" (title and year from Shudder's API),
    preferring titles that say "trailer" and name a matching year, and rejecting ones that name a different year. Results
    are parsed out of ytInitialData in the results page HTML. If that fails, the link goes to the search page.
  - Route changes don't reload the page, so a debounced MutationObserver re-checks on every render.

Director
  - Movie pages get the director (looked up as below) added to the end of the details row, matching its delimiters.
  - Cards with a runtime badge (My List, Home page rows, More Like This on movie pages) get the year and director
    after it.

Sorting
  - My List (/mylist) has no sort options, so it gets a bar (Default, A-Z, Z-A, Year, Director) styled after the
    Movies page's, under the heading. The choice is remembered. Its cards also get the year and director after the
    runtime.
  - Pages with Shudder's own sort bar ([data-testid$="buttonList-mapped-button-list"], with an A-Z button) get Year and
    Director buttons cloned from it. Ours only reorders the cards already loaded; picking a native option hands back to
    Shudder's (server-side) order.
  - Cards come in two layouts: My List's li items in ul rows (in one or more .card-list), and the Movies page's flat
    grid of div[role=presentation] items holding [data-testid="card-container-VOD#<id>"]. More load as you scroll.
    React owns those nodes, so they're never moved. Instead, while a sort is active, the cards' closest common ancestor
    becomes a wrapping flex box (unless it already is a flex box or grid), anything between it and the cards gets
    display:contents, and each card gets a CSS order. "Default" just removes the attributes and orders.

Data
  - Year comes from Shudder's own API (releaseYear on /api/v4/vod/<id>), using a guest token. Only films (VOD cards)
    are looked up; series ids are a separate range that can collide with films'.
  - Shudder has no director data. Directors come from Wikidata: one batched SPARQL query matching films by English title
    and year (±2), also trying the title with small words lowercased. Wikidata entries for recent films often lack a
    director, so its misses fall back to the "director" field of English Wikipedia's film infobox, fetched in bulk
    by guessing article titles ("Title (2024 film)", "Title (film)", "Title"), 12 films per request. What's still
    missing is looked up in Wikipedia's "List of horror films of <year>" tables, which cover small releases too.
  - Both are cached with GM_setValue. Films with no director found sort last and are re-tried after a week, or as soon
    as the lookup improves (DIRECTOR_LOOKUP_VERSION).
*/

(function () {
  'use strict';

  const LINK_ID = 'tm-shudder-trailer';
  const ROW_SELECTOR = '[data-testid$="mapped-button-list"]';
  const ICON_URL = 'https://content-images.onvesper.com/prod/20x20-webp/dce.shudder/iconStore/trailer_normalpng.ZIkcD.png';

  const cache = new Map(); // Shudder video id -> Promise<{ url, found }>

  const videoId = () => (location.pathname.match(/^\/video\/(\d+)/) || [])[1];

  function movieTitle() {
    const h1 = document.querySelector('#rootMountPoint h1');
    const title = (h1 && h1.textContent.trim()) || document.title;
    return title.replace(/\s*[|\-–]\s*Shudder\s*$/i, '').trim();
  }

  // Title and release year from Shudder's API (shared with the sorting cache), falling back to the page title.
  // The trailer and director lookups both ask at once, so they share one request.
  const infoLookups = new Map(); // Shudder video id -> Promise<{ title, year }>
  function movieInfo(id) {
    if (meta[id]) return Promise.resolve(meta[id]);
    if (!infoLookups.has(id)) {
      const p = fetchVod(id)
        .then((vod) => {
          meta[id] = { title: vod.title || movieTitle(), year: vod.releaseYear || null };
          GM_setValue('meta', meta);
          return meta[id];
        })
        .catch(() => ({ title: movieTitle(), year: null }))
        .finally(() => infoLookups.delete(id));
      infoLookups.set(id, p);
    }
    return infoLookups.get(id);
  }

  const YEAR_RE = /\b(19[2-9]\d|20\d\d)\b/g;

  // Higher is a better match. A year in the video title within one of Shudder's counts for it (release years vary by
  // region and festival vs. general release); a clearly different year usually means a same-named film.
  function scoreVideo(title, year) {
    let score = /trailer/i.test(title) ? 1 : 0;
    const years = (title.match(YEAR_RE) || []).map(Number);
    if (year && years.some((y) => Math.abs(y - year) <= 1)) score += 2;
    else if (year && years.length) score -= 3;
    return score;
  }

  function findVideoRenderers(node, out) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const n of node) findVideoRenderers(n, out);
      return out;
    }
    if (node.videoRenderer && node.videoRenderer.videoId) out.push(node.videoRenderer);
    for (const k in node) if (k !== 'videoRenderer') findVideoRenderers(node[k], out);
    return out;
  }

  function lookupTrailer(id, title, year) {
    if (cache.has(id)) return cache.get(id);
    const query = [title, year, 'trailer'].filter(Boolean).join(' ');
    const searchUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const p = new Promise((resolve) => {
      const fallback = () => resolve({ url: searchUrl, found: false });
      GM_xmlhttpRequest({
        method: 'GET',
        url: searchUrl,
        headers: { 'Accept-Language': 'en-US,en' },
        onerror: fallback,
        ontimeout: fallback,
        onload: (res) => {
          try {
            const html = res.responseText;
            const start = html.indexOf('var ytInitialData = ');
            if (start < 0) return fallback();
            const jsonStart = start + 'var ytInitialData = '.length;
            const end = html.indexOf(';</script>', jsonStart);
            const data = JSON.parse(html.slice(jsonStart, end));
            const titleOf = (v) => ((v.title && v.title.runs) || []).map((r) => r.text).join('');
            // Best score among the top results; ties go to YouTube's ranking.
            let best = null;
            let bestScore = -Infinity;
            for (const v of findVideoRenderers(data, []).slice(0, 10)) {
              const score = scoreVideo(titleOf(v), year);
              if (score > bestScore) [best, bestScore] = [v, score];
            }
            // Every result names some other year: better to show the search than the wrong film's trailer.
            if (!best || bestScore < 0) return fallback();
            resolve({ url: 'https://www.youtube.com/watch?v=' + best.videoId, found: true });
          } catch (e) {
            fallback();
          }
        },
      });
    });
    cache.set(id, p);
    return p;
  }

  function buildLink(row) {
    const native = row.querySelector('button');
    const nativeLabel = native && native.querySelector('div[dir="auto"]');

    const wrap = document.createElement('div');
    wrap.className = 'composed-button';
    wrap.id = LINK_ID;

    const a = document.createElement('a');
    a.target = '_blank';
    a.rel = 'noopener';
    if (native) {
      a.className = native.className;
      a.style.cssText = native.style.cssText;
    }
    a.style.minWidth = '114px';
    a.style.textDecoration = 'none';
    a.style.opacity = '0.5';
    a.style.cursor = 'wait';

    const img = document.createElement('img');
    img.src = ICON_URL;
    img.alt = 'Trailer';
    img.width = img.height = 20;
    if (native && native.querySelector('img')) img.className = native.querySelector('img').className;

    const label = document.createElement('div');
    label.dir = 'auto';
    if (nativeLabel) label.className = nativeLabel.className;
    label.textContent = 'Trailer…';

    a.append(img, label);
    wrap.append(a);
    return wrap;
  }

  function check() {
    const id = videoId();
    const existing = document.getElementById(LINK_ID);
    if (existing && existing.dataset.videoId !== id) existing.remove();
    if (!id) return;

    const row = document.querySelector(ROW_SELECTOR);
    if (!row || !row.querySelector('button')) return;
    if (row.querySelector('button[aria-label="Trailer"]')) return;
    if (document.getElementById(LINK_ID)) return;

    const wrap = buildLink(row);
    wrap.dataset.videoId = id;
    row.prepend(wrap);

    movieInfo(id)
      .then(({ title, year }) => lookupTrailer(id, title, year))
      .then(({ url, found }) => {
        // React may have re-rendered and replaced the row; check() re-injects, so update whichever link is live.
        const live = document.getElementById(LINK_ID);
        if (!live || live.dataset.videoId !== id) return;
        const a = live.querySelector('a');
        a.href = url;
        a.title = found ? 'Watch trailer on YouTube' : 'Search YouTube for a trailer';
        a.style.opacity = '';
        a.style.cursor = '';
        a.querySelector('div').textContent = found ? 'Trailer' : 'Find trailer';
      });
  }

  // ---- Director in the movie page's details row ----

  // The row is [data-testid$="mapped-tag-list"]: tags (rating, year, runtime, genre, language), each followed by an
  // empty ...-tag_separator div that draws the delimiter. We clone the last text tag and a separator, so ours matches.
  const DIRECTOR_ATTR = 'data-tm-director';
  const directorLookups = new Map(); // Shudder video id -> Promise<"Director A, Director B" or ''>

  function movieDirector(id) {
    if (!directorLookups.has(id)) {
      const p = movieInfo(id)
        .then(async ({ title, year }) => {
          if (!year || !meta[id]) return '';
          if (needsMeta(id, true)) {
            const found = await lookupDirectors([{ id, title, year }]);
            if (found[id] !== undefined) {
              Object.assign(meta[id], { director: found[id], directorTime: Date.now(), directorVersion: DIRECTOR_LOOKUP_VERSION });
              GM_setValue('meta', meta);
            }
          }
          return meta[id].director || '';
        })
        .catch(() => '');
      directorLookups.set(id, p);
    }
    return directorLookups.get(id);
  }

  function addDirectorTag(list, id, name) {
    const tags = [...list.querySelectorAll(':scope > [data-testid*="-tag-index-"]')].filter((t) => t.querySelector('[dir="auto"]'));
    const last = tags[tags.length - 1];
    if (!last) return;
    const tag = last.cloneNode(true);
    const text = tag.querySelector('[dir="auto"]');
    text.textContent = name;
    text.removeAttribute('data-testid');
    tag.removeAttribute('data-testid');
    tag.setAttribute(DIRECTOR_ATTR, id);
    tag.title = 'Director';
    const separator = list.querySelector(':scope > [data-testid$="tag_separator"]');
    if (separator) {
      const sep = separator.cloneNode(true);
      sep.removeAttribute('data-testid');
      sep.setAttribute(DIRECTOR_ATTR, id);
      list.append(sep);
    }
    list.append(tag);
  }

  function checkDirector() {
    const id = videoId();
    for (const el of document.querySelectorAll(`[${DIRECTOR_ATTR}]`)) if (el.getAttribute(DIRECTOR_ATTR) !== id) el.remove();
    if (!id) return;
    const list = document.querySelector('[data-testid$="mapped-tag-list"]');
    if (!list || list.querySelector(`[${DIRECTOR_ATTR}]`)) return;
    movieDirector(id).then((name) => {
      // The row may have re-rendered (or we navigated) while looking up; use whatever's live now.
      const live = document.querySelector('[data-testid$="mapped-tag-list"]');
      if (!name || videoId() !== id || !live || live.querySelector(`[${DIRECTOR_ATTR}]`)) return;
      addDirectorTag(live, id, name);
    });
  }

  // ---- Sorting: a sort bar on My List, plus Year and Director on Shudder's own sort bars ----

  const BAR_ID = 'tm-shudder-sort';
  const NATIVE_BAR_SELECTOR = '[data-testid$="buttonList-mapped-button-list"]';
  const API = 'https://dce-frontoffice.imggaming.com/api';
  const API_HEADERS = { 'x-api-key': '857a1e5d-e35e-4fdf-805b-a87b6f8364bf', realm: 'dce.shudder', 'x-app-var': '6.0.0' };
  const DIRECTOR_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
  // Bumped when the director lookup gets better, so films cached as "not found" are tried again straight away.
  const DIRECTOR_LOOKUP_VERSION = 4; // 2: Wikipedia fallback, 3: in bulk by guessed article titles, 4: horror lists
  const MODES = { default: 'Default', title: 'A-Z', titleDesc: 'Z-A', year: 'Year', director: 'Director' };

  const meta = GM_getValue('meta', {}); // card id -> { title, year, director, directorTime }; director '' = not found
  let myListMode = GM_getValue('mylistSort', 'default');
  let pageMode = 'default'; // on pages with a native sort bar; reset on navigation
  let pagePath = location.pathname;
  let loadingMeta = false;
  const attempted = new Set(); // lookups already tried this page load, so failures don't retry on every render

  const style = document.createElement('style');
  style.textContent = `
    [data-tm-sorted="rows"], [data-tm-sorted="block"] { display:flex !important; flex-wrap:wrap; }
    [data-tm-sorted="rows"] [data-tm-row] { display:contents !important; }
    #${BAR_ID} { display:flex; flex-wrap:wrap; align-items:center; gap:24px; margin:-6px 0 22px; }
    #${BAR_ID} button {
      padding:0 0 2px; color:rgba(255,255,255,0.6); background:none; border:0; border-bottom:1px solid transparent;
      border-radius:0; font:500 1rem resident-primary-font, Roboto-Medium, arial, sans-serif; cursor:pointer;
    }
    #${BAR_ID} button:hover, #${BAR_ID} button.tm-selected { color:#fff; }
    #${BAR_ID} button.tm-selected { border-bottom-color:#fff; }
    .tm-status { color:#fff; opacity:0.6; font:13px Roboto-Medium, arial, sans-serif; }
    /* Same as the movie page details row's separator (computed style of its ...-tag_separator div). */
    .tm-dot {
      display:inline-block; width:4.67px; height:4.67px; margin:0 4.67px; border-radius:50%;
      background:rgba(255,255,255,0.27); vertical-align:middle;
    }
  `;
  document.head.append(style);

  let tokenPromise = null;
  function guestToken() {
    if (!tokenPromise) {
      tokenPromise = fetch(`${API}/v2/login/guest/checkin`, { method: 'POST', headers: API_HEADERS })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('checkin ' + r.status))))
        .then((j) => j.authorisationToken);
      tokenPromise.catch(() => (tokenPromise = null));
    }
    return tokenPromise;
  }

  // Guest tokens last about 10 minutes; on a 401 get a fresh one and retry once.
  async function fetchVod(id, retried) {
    const token = await guestToken();
    const r = await fetch(`${API}/v4/vod/${id}`, { headers: { ...API_HEADERS, Authorization: 'Bearer ' + token } });
    if (r.status === 401 && !retried) {
      tokenPromise = null;
      return fetchVod(id, true);
    }
    if (!r.ok) throw new Error('vod ' + r.status);
    return r.json();
  }

  async function pool(items, size, fn) {
    let next = 0;
    const worker = async () => {
      while (next < items.length) await fn(items[next++]).catch(() => {});
    };
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  }

  const sparqlString = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"@en';
  // Shudder capitalizes every word ("In A Violent Nature"); Wikidata labels usually don't ("In a Violent Nature").
  const SMALL_WORDS = /(?!^)\b(A|An|And|As|At|But|By|For|From|In|Into|Of|On|Or|The|To|With)\b/g;
  const titleVariants = (t) => [...new Set([t, t.replace(SMALL_WORDS, (w) => w.toLowerCase())])];

  // films: [{ id, title, year }] -> Promise<{ id: "Director A, Director B" }>
  // Labels must match exactly, so the year window can be loose: Shudder's year is often a later release than Wikidata's.
  function queryDirectors(films) {
    const values = films
      .flatMap((f) => titleVariants(f.title).map((t) => `("${f.id}" ${sparqlString(t)} ${f.year})`))
      .join(' ');
    const query = `SELECT ?key (GROUP_CONCAT(DISTINCT ?name; separator=", ") AS ?directors) WHERE {
      VALUES (?key ?title ?year) { ${values} }
      ?film rdfs:label ?title; wdt:P31/wdt:P279* wd:Q11424; wdt:P57 ?dir; wdt:P577 ?date.
      FILTER(ABS(YEAR(?date) - ?year) <= 2)
      ?dir rdfs:label ?name. FILTER(LANG(?name) = "en")
    } GROUP BY ?key`;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://query.wikidata.org/sparql',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
        data: 'query=' + encodeURIComponent(query),
        onerror: reject,
        ontimeout: reject,
        onload: (res) => {
          try {
            const out = {};
            for (const b of JSON.parse(res.responseText).results.bindings) out[b.key.value] = b.directors.value;
            resolve(out);
          } catch (e) {
            reject(e);
          }
        },
      });
    });
  }

  // Wikidata film entries, especially recent ones, often have no director or date (Frankie Freako's has neither), while
  // the film's Wikipedia article usually does. So films Wikidata misses get a look at English Wikipedia's infobox.

  const WIKI_YEAR_RE = /\b(?:19|20)\d\d\b/g;

  // The value of "| name = ..." in an infobox, up to the next "| key =" line or the infobox's end.
  function infoboxField(wikitext, name) {
    const m = wikitext.match(new RegExp(`\\n\\s*\\|\\s*${name}\\s*=([\\s\\S]*?)(?=\\n\\s*\\|\\s*[\\w ]+=|\\n\\}\\})`));
    return m ? m[1] : '';
  }

  // Names from an infobox value: [[Link]], [[Link|Shown]], {{ill|Target|lang|lt=Shown}}, plain lists or <br>-separated.
  function infoboxNames(value) {
    value = value
      .replace(/<!--[\s\S]*?-->|<ref[^>]*\/>|<ref[\s\S]*?<\/ref>/g, '')
      .replace(/\{\{\s*ill\s*\|([^|}]+)([^}]*)\}\}/gi, (_, target, rest) => {
        const shown = (rest.match(/\|\s*lt\s*=\s*([^|}]+)/) || [])[1];
        return shown ? `[[${target}|${shown}]]` : `[[${target}]]`;
      });
    const links = [...value.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)];
    if (links.length) return links.map((m) => (m[2] || m[1].replace(/\s*\([^)]*\)$/, '')).trim());
    return value
      .replace(/\{\{\s*(?:plain ?list|ubl|unbulleted list|hlist|flatlist)\s*\|?/gi, '')
      .replace(/[{}*]/g, '')
      .split(/<br\s*\/?>|\||\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function wikipediaApi(params) {
    const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', formatversion: 2, ...params });
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        // Wikimedia asks scripts to identify themselves.
        headers: { 'Api-User-Agent': 'ShudderTrailers-userscript (https://github.com/lindblum/userscripts)' },
        onerror: reject,
        ontimeout: reject,
        onload: (res) => {
          try {
            resolve(JSON.parse(res.responseText)); // a rate-limit page isn't JSON, so it rejects
          } catch (e) {
            reject(e);
          }
        },
      });
    });
  }

  // The director in a film article's lead section, or '' if it isn't a film article from around that year.
  function infoboxDirector(wikitext, year, articleTitle) {
    if (!wikitext || !/\{\{\s*Infobox film/i.test(wikitext)) return '';
    // Festival and general releases can be a couple of years apart, as with Wikidata.
    const qualifier = (articleTitle.match(/\(([^)]*)\)$/) || [])[1] || '';
    const years = [...(infoboxField(wikitext, 'released') + ' ' + qualifier).matchAll(WIKI_YEAR_RE)].map((m) => Number(m[0]));
    if (years.length && !years.some((y) => Math.abs(y - year) <= 2)) return '';
    return infoboxNames(infoboxField(wikitext, 'director')).join(', ');
  }

  // Film articles are named "Title (2024 film)", "Title (film)" or just "Title", so rather than searching for each film,
  // guess those titles (most specific first) and fetch them in bulk: one request covers 12 films (the API's limit is
  // 50 titles), with just each article's lead section, where the infobox is. Wrong pages (disambiguations, other
  // subjects, other films of the same name) fail the infobox and year checks.
  const wikiGuesses = (f) => [`${f.title} (${f.year} film)`, `${f.title} (${f.year - 1} film)`, `${f.title} (film)`, f.title];
  const WIKI_FILMS_PER_REQUEST = 12;

  // films: [{ id, title, year }] -> Promise<{ id: "Director A, Director B" | '' }>. Films it couldn't ask about (rate
  // limited, offline) are left out, to be tried again next time rather than cached as not found.
  async function wikipediaDirectors(films) {
    const result = {};
    const askable = films.filter((f) => !/[|#<>[\]{}]/.test(f.title)); // characters that can't be in a page title
    for (let i = 0; i < askable.length; i += WIKI_FILMS_PER_REQUEST) {
      const batch = askable.slice(i, i + WIKI_FILMS_PER_REQUEST);
      let res;
      try {
        res = await wikipediaApi({
          action: 'query',
          titles: batch.flatMap(wikiGuesses).join('|'),
          redirects: 1,
          prop: 'revisions',
          rvprop: 'content',
          rvslots: 'main',
          rvsection: 0,
        });
      } catch (e) {
        break;
      }
      const q = res.query || {};
      // Titles come back normalized ("MadS" -> "Mads (film)" is a redirect); follow both to the article.
      const renamed = new Map([...(q.normalized || []), ...(q.redirects || [])].map((r) => [r.from, r.to]));
      const resolve = (t) => {
        for (let n = 0; n < 3 && renamed.has(t); n++) t = renamed.get(t);
        return t;
      };
      const pages = new Map((q.pages || []).filter((p) => p.revisions).map((p) => [p.title, p.revisions[0].slots.main.content]));
      for (const f of batch) {
        result[f.id] = '';
        for (const guess of wikiGuesses(f)) {
          const article = resolve(guess);
          const names = infoboxDirector(pages.get(article), f.year, article);
          if (names) {
            result[f.id] = names;
            break;
          }
        }
      }
    }
    return result;
  }

  // Wikipedia's "List of horror films of <year>" pages (per decade before 1960) have a table row for nearly every horror
  // release, including small ones with no article of their own: "|'''''Hellcat''''' |Brock Bodell |Dakota Gorman, ...".
  // Shudder is a horror service, so they catch most of what's left. Their tables vary by year, so columns are found by
  // header ("Title", "Director(s)"), and cells may be on their own lines or "||"-separated, with "attrs |" prefixes.

  const normTitle = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const horrorListTitle = (year) =>
    year < 1960 ? `List of horror films of the ${Math.floor(year / 10) * 10}s` : `List of horror films of ${year}`;
  const horrorLists = new Map(); // page title -> Map(normalized film title -> directors), fetched once per page load

  // {{sortname|First|Last|...}} -> [[First Last]], so names read as links do.
  const sortnames = (s) => s.replace(/\{\{\s*sortname\s*\|([^|}]+)\|([^|}]+)[^}]*\}\}/gi, '[[$1 $2]]');

  function cellText(cell) {
    return sortnames(cell)
      .replace(/<!--[\s\S]*?-->|<ref[^>]*\/>|<ref[\s\S]*?<\/ref>/g, '')
      .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1')
      .replace(/\{\{[^}]*\}\}|<[^>]+>|'{2,}/g, '')
      .trim();
  }

  // A cell's content, without any leading "attrs |" (a "|" outside [[...]] and {{...}}).
  function cellContent(cell) {
    let depth = 0;
    for (let i = 0; i < cell.length; i++) {
      const two = cell.slice(i, i + 2);
      if (two === '[[' || two === '{{' || two === ']]' || two === '}}') {
        depth += two[0] === '[' || two[0] === '{' ? 1 : -1;
        i++;
      } else if (cell[i] === '|' && depth === 0) {
        return cell.slice(i + 1);
      }
    }
    return cell;
  }

  function parseHorrorList(wikitext) {
    const directors = new Map();
    for (const table of wikitext.split(/\n\{\|/).slice(1)) {
      let titleCol = -1;
      let directorCol = -1;
      for (const row of table.split(/\n\|\}/)[0].split(/\n\|-[^\n]*/)) {
        const cells = [];
        for (const line of row.split('\n')) {
          if (/^[|!][^-+}]/.test(line) || line === '|' || line === '!') {
            cells.push(...line.slice(1).split(/\|\||!!/).map(cellContent));
          } else if (cells.length) {
            cells[cells.length - 1] += '\n' + line; // a cell continued over several lines (plainlists)
          }
        }
        const headers = cells.map((c) => cellText(c).toLowerCase());
        if (headers.includes('title') && headers.some((h) => h.startsWith('director'))) {
          titleCol = headers.indexOf('title');
          directorCol = headers.findIndex((h) => h.startsWith('director'));
          continue;
        }
        if (titleCol < 0 || cells.length <= Math.max(titleCol, directorCol)) continue; // year headers, captions
        const title = normTitle(cellText(cells[titleCol]));
        const names = infoboxNames(sortnames(cells[directorCol])).join(', ');
        if (title && names && !directors.has(title)) directors.set(title, names);
      }
    }
    return directors;
  }

  // Fetches the lists not fetched yet, several per request. Rejects if Wikipedia can't be asked.
  async function fetchHorrorLists(pageTitles) {
    const todo = [...new Set(pageTitles)].filter((t) => !horrorLists.has(t));
    for (let i = 0; i < todo.length; i += 4) {
      const res = await wikipediaApi({ action: 'query', titles: todo.slice(i, i + 4).join('|'), prop: 'revisions', rvprop: 'content', rvslots: 'main' });
      for (const page of (res.query && res.query.pages) || []) {
        if (page.missing) horrorLists.set(page.title, new Map());
        else if (page.revisions) horrorLists.set(page.title, parseHorrorList(page.revisions[0].slots.main.content));
      }
    }
  }

  // films: [{ id, title, year }] -> Promise<{ id: "Director A, Director B" | '' | undefined (couldn't check) }>.
  // Tries each film's own year first, then the year before (Shudder's year is often a later release).
  async function horrorListDirectors(films) {
    const result = {};
    for (const offset of [0, -1]) {
      const left = films.filter((f) => !result[f.id]);
      if (!left.length) break;
      try {
        await fetchHorrorLists(left.map((f) => horrorListTitle(f.year + offset)));
      } catch (e) {
        for (const f of left) result[f.id] = undefined;
        break;
      }
      for (const f of left) {
        const list = horrorLists.get(horrorListTitle(f.year + offset));
        result[f.id] = (list && list.get(normTitle(f.title))) || '';
      }
    }
    return result;
  }

  // films: [{ id, title, year }] -> Promise<{ id: "Director A, Director B" | '' (not found) | undefined (couldn't check) }>
  // Rejects if Wikidata fails. Wikidata's misses go to Wikipedia's articles, and what's left to its horror film lists.
  async function lookupDirectors(films) {
    // Shudder sometimes adds a year or original title: "The Queen of Black Magic (2019)", "They Came Back (Les Revenants)".
    films = films.map((f) => ({ ...f, title: f.title.replace(/\s*\([^)]*\)$/, '') || f.title }));
    const result = await queryDirectors(films);
    const misses = films.filter((f) => !result[f.id]);
    if (misses.length) Object.assign(result, await wikipediaDirectors(misses));
    const notFound = films.filter((f) => result[f.id] === '');
    if (notFound.length) Object.assign(result, await horrorListDirectors(notFound));
    return result;
  }

  function needsMeta(id, needDirector) {
    const m = meta[id];
    if (!m) return true;
    if (!needDirector || !m.year) return false;
    return (
      m.director === undefined ||
      (m.director === '' && (m.directorVersion !== DIRECTOR_LOOKUP_VERSION || Date.now() - m.directorTime > DIRECTOR_RETRY_MS))
    );
  }

  async function loadMeta(cards, needDirector, setStatus) {
    const missing = cards.filter((c) => !meta[c.id]);
    let done = 0;
    await pool(missing, 6, async (c) => {
      try {
        const vod = await fetchVod(c.id);
        meta[c.id] = { title: vod.title || c.title, year: vod.releaseYear || null };
      } finally {
        setStatus(`Loading ${++done}/${missing.length}…`);
      }
    });
    GM_setValue('meta', meta);

    if (!needDirector) return;
    setStatus('Finding directors…');
    // Only films with a known year (series and failed lookups have no meta) can be matched.
    const lookup = cards.filter((c) => meta[c.id] && needsMeta(c.id, true));
    for (let i = 0; i < lookup.length; i += 50) {
      const batch = lookup.slice(i, i + 50);
      try {
        const found = await lookupDirectors(batch.map((c) => ({ id: c.id, title: meta[c.id].title, year: meta[c.id].year })));
        const now = Date.now();
        for (const c of batch) {
          if (found[c.id] === undefined) continue;
          Object.assign(meta[c.id], { director: found[c.id], directorTime: now, directorVersion: DIRECTOR_LOOKUP_VERSION });
        }
      } catch (e) {
        // Leave these unlooked-up; they'll be tried again on the next page load.
      }
    }
    GM_setValue('meta', meta);
  }

  // The cards inside scope, as { list, wrappers, items }. Items are the per-card elements (the li, on Shudder's card
  // lists), in document order. The list is their closest common ancestor, and wrappers are everything between it and
  // the items: My List renders 2-6 cards per ul row (by screen width), and pages loaded on scroll may arrive in rows
  // or card lists of their own. DOM order never changes (only CSS order does), so the items' order is the original one.
  function findGrid(scope) {
    const found = new Set();
    for (const card of scope.querySelectorAll(CARD_SELECTOR)) {
      const li = card.closest('li');
      if (li && li !== scope && scope.contains(li)) {
        found.add(li);
        continue;
      }
      // No li (the Movies grid): the item is the card's highest ancestor holding no other card. Not used on My List,
      // where a last row with one card would otherwise count as an item itself.
      let item = card;
      while (item.parentElement !== scope && item.parentElement.querySelectorAll(CARD_SELECTOR).length === 1) {
        item = item.parentElement;
      }
      found.add(item);
    }
    const items = [...found];
    if (!items.length) return null;
    let list = items[0].parentElement;
    while (list !== scope && !items.every((i) => list.contains(i))) list = list.parentElement;
    const wrappers = new Set();
    for (const item of items) {
      for (let el = item.parentElement; el !== list && !wrappers.has(el); el = el.parentElement) wrappers.add(el);
    }
    return { list, wrappers: [...wrappers], items };
  }

  // Cards come in two layouts:
  //   My List: li > .card-wrapper[data-card-type] > [data-card-id] > a[aria-label=title]
  //   Movies:  div[role=presentation] > button[aria-label=title] > ... > [data-testid="card-container-<type>#<id>"]
  // Only VOD (film) ids are looked up: other types (VOD_SERIES) have ids of their own that can collide with films'.
  const CARD_SELECTOR = '[data-card-id], [data-testid^="card-container-"]';

  function cardInfo(item) {
    const card = item.matches(CARD_SELECTOR) ? item : item.querySelector(CARD_SELECTOR);
    const named = item.querySelector('a[aria-label], button[aria-label]');
    const testid = card.getAttribute('data-testid') || '';
    const typed = card.closest('[data-card-type]');
    const type = typed ? typed.dataset.cardType : (testid.match(/^card-container-([^#]+)#/) || [])[1];
    return {
      el: item,
      id: card.dataset.cardId || testid.slice(testid.indexOf('#') + 1),
      vod: type === 'VOD',
      title: named ? named.getAttribute('aria-label') : '',
    };
  }

  function setOrder(el, order, fullWidth) {
    el.style.order = order;
    if (fullWidth) el.style.flexBasis = '100%';
    el.setAttribute('data-tm-ordered', '');
  }

  function clearSort() {
    for (const el of document.querySelectorAll('[data-tm-sorted], [data-tm-row], [data-tm-ordered]')) {
      if (el.hasAttribute('data-tm-ordered')) {
        el.style.order = '';
        el.style.flexBasis = '';
      }
      el.removeAttribute('data-tm-sorted');
      el.removeAttribute('data-tm-row');
      el.removeAttribute('data-tm-ordered');
    }
  }

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const titleKey = (t) => t.replace(/^(the|a|an)\s+/i, '');
  // Sort by the first director's surname, then full name.
  const directorKey = (names) => {
    const first = names.split(', ')[0];
    return first.split(' ').pop() + ' ' + first;
  };

  function applySort(grid, mode) {
    if (mode === 'default') return clearSort();
    const { list, wrappers, items } = grid;
    const byTitle = (a, b) => collator.compare(titleKey(a.title), titleKey(b.title));
    const compare = {
      title: byTitle,
      titleDesc: (a, b) => byTitle(b, a),
      year: (a, b) => (a.year == null) - (b.year == null) || a.year - b.year || byTitle(a, b),
      director: (a, b) =>
        !a.director - !b.director || collator.compare(directorKey(a.director || ''), directorKey(b.director || '')) || byTitle(a, b),
    }[mode];
    items
      .map(cardInfo)
      .map((c) => {
        const m = (c.vod && meta[c.id]) || {};
        return { ...c, year: m.year, director: m.director };
      })
      .sort(compare)
      .forEach((c, i) => setOrder(c.el, i + 1));

    // Everything else keeps its place around the cards: what comes before the first card (headings, our bar) goes full
    // width on top; anything after it (portals, loaders, later pages' headings) goes last.
    const itemSet = new Set(items);
    const wrapperSet = new Set(wrappers);
    if (wrappers.length) {
      list.setAttribute('data-tm-sorted', 'rows');
      for (const el of [list, ...wrappers]) {
        if (el !== list) el.setAttribute('data-tm-row', '');
        for (const child of el.children) {
          if (itemSet.has(child) || wrapperSet.has(child)) continue;
          const before = child.compareDocumentPosition(items[0]) & Node.DOCUMENT_POSITION_FOLLOWING;
          setOrder(child, before ? -1 : 1e6, before);
        }
      }
    } else {
      // Only make the list a flex box if it isn't one already (checked before our own CSS changes its display).
      if (!list.hasAttribute('data-tm-sorted')) {
        list.setAttribute('data-tm-sorted', /flex|grid/.test(getComputedStyle(list).display) ? 'flat' : 'block');
      }
      let afterItems = false;
      for (const child of list.children) {
        if (itemSet.has(child)) afterItems = true;
        else setOrder(child, afterItems ? 1e6 : -1);
      }
    }
  }

  function setMode(mode) {
    if (/^\/mylist\/?$/.test(location.pathname)) {
      myListMode = mode;
      GM_setValue('mylistSort', mode);
    } else {
      pageMode = mode;
    }
    checkSort();
  }

  function statusSpan() {
    const status = document.createElement('span');
    status.className = 'tm-status';
    return status;
  }

  // My List has no sort bar of its own, so it gets one styled after the Movies page's.
  function buildMyListBar() {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    for (const [mode, label] of Object.entries(MODES)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.tmMode = mode;
      button.textContent = label;
      button.addEventListener('click', () => setMode(mode));
      bar.append(button);
    }
    bar.append(statusSpan());
    return bar;
  }

  // Shudder's sort bars mark the current choice with "<label> selected" as the aria-label, a white underline
  // (inline border-bottom-color) and a different label class. Our buttons copy those looks from the native ones.
  const barLooks = new WeakMap(); // native bar -> { selected, unselected } looks, captured before we restyle anything
  const savedLooks = new WeakMap(); // native button -> its own look, while ours is selected
  const labelOf = (button) => button.querySelector('div[dir="auto"]') || button;
  const lookOf = (button) => ({ border: button.style.borderBottomColor, labelClass: labelOf(button).className });
  function setLook(button, look) {
    button.style.borderBottomColor = look.border;
    labelOf(button).className = look.labelClass;
  }

  function restoreNativeLooks(bar) {
    for (const b of bar.querySelectorAll('button:not([data-tm-mode])')) {
      if (savedLooks.has(b)) setLook(b, savedLooks.get(b));
      savedLooks.delete(b);
    }
  }

  function injectIntoNativeBar(bar) {
    const natives = [...bar.querySelectorAll('button')];
    const selected = natives.find((b) => / selected$/.test(b.getAttribute('aria-label')));
    const unselected = natives.find((b) => b !== selected);
    if (!selected || !unselected) return false;
    barLooks.set(bar, { selected: lookOf(selected), unselected: lookOf(unselected) });

    for (const mode of ['year', 'director']) {
      const wrap = unselected.parentElement.cloneNode(true); // each button sits in its own wrapper div
      const button = wrap.querySelector('button');
      button.dataset.tmMode = mode;
      button.setAttribute('aria-label', MODES[mode]);
      labelOf(button).textContent = MODES[mode];
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        setMode(mode);
      });
      bar.append(wrap);
    }
    bar.append(statusSpan());

    // Picking a native sort replaces ours. Put the native looks back first (on pointerdown, before React handles the
    // press), so React's own update to the selected button lands on the DOM it expects.
    const pickNative = (e) => {
      if (!e.target.closest('button:not([data-tm-mode])') || pageMode === 'default') return;
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      restoreNativeLooks(bar);
      pageMode = 'default';
      schedule();
    };
    bar.addEventListener('pointerdown', pickNative, true);
    bar.addEventListener('keydown', pickNative, true);
    return true;
  }

  function paintBar(bar, mode) {
    const looks = barLooks.get(bar);
    for (const b of bar.querySelectorAll('button')) {
      const own = b.dataset.tmMode;
      if (own) {
        b.setAttribute('aria-label', MODES[own] + (own === mode ? ' selected' : ''));
        if (looks) setLook(b, own === mode ? looks.selected : looks.unselected);
        else b.classList.toggle('tm-selected', own === mode);
      } else if (mode !== 'default') {
        if (!savedLooks.has(b)) savedLooks.set(b, lookOf(b));
        setLook(b, looks.unselected);
      }
    }
    if (looks && mode === 'default') restoreNativeLooks(bar);
  }

  // Where to sort and the bar that controls it, adding our bar or buttons if they're missing.
  function sortTarget() {
    if (location.pathname !== pagePath) {
      pagePath = location.pathname;
      pageMode = 'default';
      clearSort();
    }
    if (/^\/mylist\/?$/.test(location.pathname)) {
      const title = document.querySelector('.my-list-wrapper .card-list-title');
      if (!title) return null;
      if (!document.getElementById(BAR_ID)) title.after(buildMyListBar());
      // The whole page, not just the first card list: pages loaded on scroll may render as card lists of their own.
      const scope = title.closest('.my-list-wrapper');
      return { mode: myListMode, scope, bar: document.getElementById(BAR_ID) };
    }
    const bar = [...document.querySelectorAll(NATIVE_BAR_SELECTOR)].find((b) => b.querySelector('button[aria-label^="A-Z"]'));
    if (!bar) return null;
    if (!bar.querySelector('[data-tm-mode]') && !injectIntoNativeBar(bar)) return null;
    // The cards are in whatever the bar shares an ancestor with.
    let scope = bar.parentElement;
    while (scope && !scope.querySelector(CARD_SELECTOR)) scope = scope.parentElement;
    return scope && { mode: pageMode, scope, bar };
  }

  // Looks up the films' data in the background (one batch at a time), then re-checks everything.
  // statusEl: returns the element to show progress in, if any (looked up each time: My List's bar may not exist yet).
  function startLoading(films, needDirector, statusEl) {
    const setStatus = (text) => {
      const status = statusEl();
      if (status) status.textContent = text;
    };
    for (const f of films) attempted.add(f.id + ':' + needDirector);
    loadingMeta = true;
    setStatus('Loading…');
    loadMeta(films, needDirector, setStatus).finally(() => {
      loadingMeta = false;
      setStatus('');
      schedule();
    });
  }

  // The year and director go in a card's runtime badge, after dots like the movie page details row's separators.
  function addBadgeDetails(badge, m) {
    const parts = [m.year, m.director].filter(Boolean).map(String);
    const key = parts.join('|');
    // React replaces the badge's children if the runtime ever changes, so check ours are still there too.
    if (badge.getAttribute('data-tm-details') === key && badge.querySelectorAll('.tm-detail').length === parts.length) return;
    badge.querySelectorAll('.tm-dot, .tm-detail').forEach((el) => el.remove());
    badge.setAttribute('data-tm-details', key);
    for (const text of parts) {
      const dot = document.createElement('span');
      dot.className = 'tm-dot';
      const detail = document.createElement('span');
      detail.className = 'tm-detail';
      detail.textContent = text;
      badge.append(dot, detail);
    }
  }

  // Cards like My List's (.card-wrapper[data-card-type] > [data-card-id] ... .card-content__footer > .badge with the
  // runtime) get the year and director in that badge, wherever they are: My List, the Home page's rows, More Like
  // This on movie pages. Each film is looked up once and cached, so busy pages only cost time on the first visit.
  function checkCardDetails() {
    const films = [];
    for (const card of document.querySelectorAll('.card-wrapper[data-card-type="VOD"] [data-card-id]')) {
      const badge = card.querySelector('.card-content__footer .badge');
      if (!badge) continue;
      const id = card.dataset.cardId;
      if (meta[id]) addBadgeDetails(badge, meta[id]);
      const a = card.querySelector('a[aria-label]');
      films.push({ id, title: a ? a.getAttribute('aria-label') : '' });
    }
    if (loadingMeta) return;
    const todo = films.filter((f) => !attempted.has(f.id + ':true') && needsMeta(f.id, true));
    if (todo.length) startLoading(todo, true, () => document.querySelector(`#${BAR_ID} .tm-status`));
  }

  function checkSort() {
    const target = sortTarget();
    if (!target) return;
    const { mode, scope, bar } = target;
    paintBar(bar, mode);
    const grid = findGrid(scope);
    if (!grid) return;

    // While data loads, only sorts that don't need it apply, so cards don't jump around as it arrives.
    const sortNeedsData = mode === 'year' || mode === 'director';
    if (loadingMeta) return sortNeedsData ? undefined : applySort(grid, mode);

    const needDirector = mode === 'director';
    const todo = sortNeedsData
      ? grid.items
          .map(cardInfo)
          .filter((c) => c.vod && !attempted.has(c.id + ':' + needDirector) && needsMeta(c.id, needDirector))
      : [];
    if (!todo.length) return applySort(grid, mode);
    startLoading(todo, needDirector, () => bar.querySelector('.tm-status'));
  }

  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      check();
      checkDirector();
      checkCardDetails();
      checkSort();
    }, 200);
  };

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  schedule();
})();
