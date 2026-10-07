// ==UserScript==
// @author       Lindblum
// @name         GitHub Alt Links
// @namespace    https://github.com/
// @version      1.1.1
// @description  Adds an "Open in" dropdown (styled like GitHub's "Create new" menu) with links to the current page on github.dev, gitingest.com, gitdiagram.com and more
// @match        https://github.com/*
// @run-at       document-idle
// @grant        none
// @copyright    2026, Lindblum
// ==/UserScript==

(function () {
  'use strict';

  const CONTAINER_ID = 'tm-alt-domain-links';
  const MENU_ID = 'tm-alt-domain-menu';

  const TARGETS = [
    { label: 'GithubPages', url: 'https://{user}.github.io/{repo}/' },
    { label: 'VSCodeDev',   url: 'https://vscode.dev/github/{user}/{repo}/{after}' },
    { label: 'Github1s',    url: 'https://github1s.com/{user}/{repo}' },
    { label: 'GithubBox',   url: 'https://githubbox.com/{user}/{repo}' },
    { label: 'GitIngest',   url: 'https://gitingest.com/{user}/{repo}' },
    { label: 'GitDiagram',  url: 'https://gitdiagram.com/{user}/{repo}' },
    { label: 'GitHistory',  url: 'https://github.githistory.xyz/{user}/{repo}/{after}' }
  ];

  // Octicons (16px)
  const ICON_LINK_EXTERNAL = '<svg aria-hidden="true" height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"></path></svg>';
  const ICON_TRIANGLE_DOWN = '<svg aria-hidden="true" height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><path d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"></path></svg>';

  const CSS = `
    #${CONTAINER_ID} { display:inline-flex; align-items:center; margin-left:8px; list-style:none; }
    #${CONTAINER_ID} .tm-btn {
      display:inline-flex; align-items:center; gap:4px; height:28px; padding:0 6px 0 8px;
      font:inherit; font-size:12px; font-weight:500; line-height:20px; white-space:nowrap; cursor:pointer;
      color:var(--fgColor-default, #1f2328);
      background:transparent;
      border:1px solid var(--borderColor-default, #d1d9e0);
      border-radius:6px; box-shadow:none;
    }
    #${CONTAINER_ID} .tm-btn:hover { background:var(--control-transparent-bgColor-hover, #818b981a); }
    #${CONTAINER_ID} .tm-btn[aria-expanded="true"] { background:var(--control-transparent-bgColor-active, #818b9826); }
    #${CONTAINER_ID} .tm-btn:focus-visible { outline:2px solid var(--focus-outlineColor, #0969da); outline-offset:-2px; }
    #${CONTAINER_ID} .tm-btn svg { color:var(--fgColor-muted, #59636e); }

    #${MENU_ID} {
      position:fixed; z-index:9999; min-width:192px; max-width:320px; padding:8px 0; margin:0;
      list-style:none; font-size:14px;
      background:var(--overlay-bgColor, #fff);
      border-radius:12px;
      box-shadow:var(--shadow-floating-small, 0 0 0 1px #d1d9e080, 0 6px 12px -3px #25292e0a, 0 6px 18px 0 #25292e1f);
      animation:tm-menu-in 200ms cubic-bezier(0.33,1,0.68,1);
    }
    #${MENU_ID}[hidden] { display:none; }
    #${MENU_ID} a {
      display:flex; align-items:center; gap:8px; margin:0 8px; padding:6px 8px;
      border-radius:6px; line-height:20px; text-decoration:none;
      color:var(--fgColor-default, #1f2328);
    }
    #${MENU_ID} a:hover, #${MENU_ID} a:focus {
      background:var(--control-transparent-bgColor-hover, #818b981a); outline:none; text-decoration:none;
    }
    #${MENU_ID} a:focus-visible { outline:2px solid var(--focus-outlineColor, #0969da); outline-offset:-2px; }
    #${MENU_ID} a svg { flex-shrink:0; color:var(--fgColor-muted, #59636e); }
    #${MENU_ID} .tm-host { margin-left:auto; padding-left:16px; font-size:12px; color:var(--fgColor-muted, #59636e); }
    @keyframes tm-menu-in { from { opacity:0; transform:scale(0.95); } to { opacity:1; transform:scale(1); } }
  `;

  function buildUrl(t) {
    const pathname = new URL(window.location.href).pathname;
    const [, user, repo] = pathname.split('/');
    const after = pathname.split('/').slice(3).join('/');
    return new URL(t.url.replace('{user}',user).replace('{repo}',repo).replace('{after}',after)).href;
  }

  function ensureStyle() {
    if (document.getElementById(CONTAINER_ID + '-style')) return;
    const style = document.createElement('style');
    style.id = CONTAINER_ID + '-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // The menu lives on <body> (position:fixed) so the header can't clip it
  function getMenu() {
    let menu = document.getElementById(MENU_ID);
    if (menu) return menu;
    menu = document.createElement('ul');
    menu.id = MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    TARGETS.forEach((t) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const a = document.createElement('a');
      a.setAttribute('role', 'menuitem');

      const pathname = new URL(window.location.href).pathname;
      const [, user, repo] = pathname.split('/');
      const after = pathname.split('/').slice(3).join('/');
      const newHost = new URL(t.url.replace('{user}',user).replace('{repo}',repo).replace('{after}',after)).hostname;
      a.dataset.host = newHost;

      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.innerHTML = ICON_LINK_EXTERNAL;
      const spanLbl = document.createElement('span');
      spanLbl.textContent = t.label;
      const spanHost = document.createElement('span');
      spanHost.className = 'tm-host';
      spanHost.textContent = newHost;

      a.append(spanLbl, spanHost);
      a.addEventListener('click', () => closeMenu());
      li.appendChild(a);
      menu.appendChild(li);
    });
    menu.addEventListener('keydown', onMenuKey);
    document.body.appendChild(menu);
    return menu;
  }

  function refreshHrefs() {
    const pathname = new URL(window.location.href).pathname;
    const [, user, repo] = pathname.split('/');
    const after = pathname.split('/').slice(3).join('/');
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    menu.querySelectorAll('a').forEach((a) => {
      const t = TARGETS.find((x) => new URL(x.url.replace('{user}',user).replace('{repo}',repo).replace('{after}',after)).hostname === a.dataset.host);
      if(t)
        a.href = buildUrl(t);
    });
  }

  function openMenu(focusFirst) {
    const btn = document.querySelector(`#${CONTAINER_ID} .tm-btn`);
    const menu = getMenu();
    refreshHrefs();
    menu.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    btn.setAttribute('aria-expanded', 'true');
    if (focusFirst) menu.querySelector('a').focus();
  }

  function closeMenu(returnFocus) {
    const menu = document.getElementById(MENU_ID);
    const btn = document.querySelector(`#${CONTAINER_ID} .tm-btn`);
    if (menu) menu.hidden = true;
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      if (returnFocus) btn.focus();
    }
  }

  function isOpen() {
    const menu = document.getElementById(MENU_ID);
    return menu && !menu.hidden;
  }

  function onMenuKey(e) {
    const items = [...document.querySelectorAll(`#${MENU_ID} a`)];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { closeMenu(e.key === 'Escape'); }
  }

  function render() {
    const nav = document.querySelector('nav[data-component="Breadcrumbs"]');
    if (!nav)
      return;

    ensureStyle();
    let box = document.getElementById(CONTAINER_ID);
    if (!box) {
      box = document.createElement('div');
      box.id = CONTAINER_ID;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tm-btn';
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = `${ICON_LINK_EXTERNAL}<span>Open in</span>${ICON_TRIANGLE_DOWN}`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        isOpen() ? closeMenu() : openMenu(e.detail === 0); // detail 0 = keyboard activation
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(true); }
      });
      box.appendChild(btn);
    }
    if (box.parentNode !== nav) nav.appendChild(box);
    refreshHrefs();
  }

  // Close on outside click, scroll, resize, or navigation
  document.addEventListener('click', (e) => {
    if (isOpen() && !e.target.closest(`#${MENU_ID}, #${CONTAINER_ID}`)) closeMenu();
  });
  window.addEventListener('resize', () => closeMenu());
  window.addEventListener('scroll', () => { if (isOpen()) closeMenu(); }, { passive: true });

  render();
  ['turbo:load', 'turbo:render', 'pjax:end'].forEach((ev) =>
    document.addEventListener(ev, () => { closeMenu(); render(); })
  );
  window.addEventListener('popstate', () => { closeMenu(); render(); });

  // Catch React/SPA navigations and header re-renders
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl || !document.getElementById(CONTAINER_ID)) {
      if (location.href !== lastUrl) closeMenu();
      lastUrl = location.href;
      render();
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
