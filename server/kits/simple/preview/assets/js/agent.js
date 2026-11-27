/* The site agent: a small chat helper in the corner of the page, set up by the Twinstack web app
   (site.config.json → agent). It notices, in batches, which page is open, which links, buttons and
   sections the pointer rests on or clicks (by their label and link only), how far the page is
   scrolled, how long it's open and when the pointer leaves the window, and sends that to the
   web app, which may answer with a suggestion of where to go ("Looking to donate?"). Visitors can
   also type a question, answered from the site's own pages.

   It never reads what is typed into the site's forms, form values or any other text on the page,
   sets no cookies, and keeps only a random id for this visit (sessionStorage) and this visit's chat.
   Visitors who ask browsers not to track them (Do Not Track, Global Privacy Control) get the chat
   but nothing is noticed or sent unless they ask a question. When anything fails, it quietly does
   nothing: it never shows an error on the page. Keep the event fields in step with the web app
   (server/src/site-agent-rules.js). */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script || !window.JSON || !window.fetch || !document.body || !document.body.attachShadow) return;
  var endpoint = script.getAttribute('data-endpoint');
  var key = script.getAttribute('data-key');
  if (!endpoint || !key) return;
  var name = (script.getAttribute('data-name') || 'Site helper').slice(0, 40);
  var greeting = (script.getAttribute('data-greeting') || 'Hi! Can I help you find something?').slice(0, 200);
  var api = endpoint.replace(/\/+$/, '') + '/' + encodeURIComponent(key) + '/';

  // The site's base path (/<repo> on a GitHub Pages project site): this script's src carries it.
  var src = script.getAttribute('src') || '';
  var base = src.slice(0, Math.max(0, src.indexOf('/assets/js/agent.js')));
  function sitePath(pathname) {
    var p = base && pathname.indexOf(base) === 0 ? pathname.slice(base.length) || '/' : pathname;
    return p.replace(/\/index\.html$/, '/');
  }
  function siteHref(path) {
    return base + path;
  }
  var page = sitePath(location.pathname);

  var tracking = !(navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true);
  // The owner offers to remember returning visitors for this many days (site.config.json → agent.remember).
  var rememberDays = Math.min(Math.max(parseInt(script.getAttribute('data-remember') || '0', 10) || 0, 0), 30);
  // "banner": remember only once the site's cookie banner says yes (window.TwinstackAgent.remember(true)).
  var waitForBanner = script.getAttribute('data-remember-consent') === 'banner';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------ this visit */

  function randomId(length) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    var bytes = new Uint8Array(length);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < length; i++) out += chars[bytes[i] & 63];
    return out;
  }

  var STORE = 'twinstack-agent';
  var state = { sid: null, open: false, log: [], suggested: 0 };
  try {
    var saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved.sid)) state = saved;
  } catch (e) {
    // Storage blocked: this page alone.
  }
  if (!state.sid) state.sid = randomId(22);
  if (!Array.isArray(state.log)) state.log = [];

  /* Remembering a returning visitor: only when the owner turned it on and the browser doesn't ask
     not to be tracked; with waitForBanner, only once the site's cookie banner said yes. The visitor
     isn't asked in the chat. `memory` is { choice: 'yes'|'no', vid, until, log }: a 'yes' keeps a
     random id (and this chat) for rememberDays after the last visit; a 'no' (the banner saying no)
     is kept so they aren't remembered again. The owner forgets visitors from the Site agent screen,
     so there's nothing about it in the chat. */
  var MEMORY = 'twinstack-agent-memory';
  var DAY = 24 * 60 * 60 * 1000;
  var memory = null;
  try {
    memory = JSON.parse(localStorage.getItem(MEMORY) || 'null');
    if (!memory || !(memory.until > Date.now()) || (memory.choice === 'yes' && !/^[A-Za-z0-9_-]{16,64}$/.test(memory.vid))) memory = null;
    // The owner stopped offering it, or the browser now asks not to be tracked: forget it here.
    if (memory && memory.choice === 'yes' && (!rememberDays || !tracking)) memory = null;
    if (!memory) localStorage.removeItem(MEMORY);
  } catch (e) {
    memory = null;
  }
  var remembered = function () {
    return Boolean(memory && memory.choice === 'yes');
  };
  function keepMemory() {
    if (!memory) return;
    if (remembered()) {
      memory.until = Date.now() + rememberDays * DAY;
      memory.log = state.log.slice(-12);
    }
    try {
      localStorage.setItem(MEMORY, JSON.stringify(memory));
    } catch (e) {}
  }
  if (!memory && rememberDays && tracking && !waitForBanner) {
    memory = { choice: 'yes', vid: randomId(22), until: 0, log: [] };
    keepMemory();
  }
  // A new visit of a remembered visitor carries on their chat.
  if (remembered() && !state.log.length && Array.isArray(memory.log)) state.log = memory.log.slice(-12);

  function save() {
    state.log = state.log.slice(-12);
    try {
      sessionStorage.setItem(STORE, JSON.stringify(state));
    } catch (e) {}
    if (remembered()) keepMemory();
  }
  save();

  function post(action, data, wantReply) {
    if (remembered() && action !== 'forget') data.v = memory.vid;
    var body = JSON.stringify(data);
    var url = api + action;
    // text/plain: a simple request, so no preflight.
    if (!wantReply && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return Promise.resolve(null);
      } catch (e) {}
    }
    return fetch(url, { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain' }, credentials: 'omit', keepalive: !wantReply })
      .then(function (res) {
        return res.status === 200 ? res.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  /* ------------------------------------------------------------ the widget */

  var host = document.createElement('div');
  host.setAttribute('data-twinstack-agent', '');
  host.style.cssText = 'position:fixed;right:0;bottom:0;z-index:2147483000;width:0;height:0;';
  var root = host.attachShadow({ mode: 'open' });

  function brandColour() {
    var value = '';
    try {
      value = getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim();
    } catch (e) {}
    return value || '#18181b';
  }
  // Black or white text, whichever reads better on the brand colour.
  function inkOn(colour) {
    var probe = document.createElement('span');
    probe.style.color = colour;
    document.body.appendChild(probe);
    var computed = getComputedStyle(probe).color;
    probe.remove();
    var parts = (computed.match(/-?\d+(\.\d+)?%?/g) || ['0', '0', '0']).map(parseFloat);
    // oklch()/oklab() give lightness first (0–1, or a percentage); rgb() gives the channels.
    var lum = /^ok/.test(computed) ? (parts[0] > 1 ? parts[0] / 100 : parts[0]) : (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
    return lum > 0.6 ? '#111111' : '#ffffff';
  }
  // The owner's look for the button (site.config.json → agent: color, position, icon, label).
  var customColour = (script.getAttribute('data-color') || '').trim();
  var brand = /^#[0-9a-fA-F]{6}$/.test(customColour) ? customColour : brandColour();
  var ink = inkOn(brand);
  var onLeft = script.getAttribute('data-position') === 'left';
  var iconName = script.getAttribute('data-icon') || 'chat';
  // How the button catches the eye (on arrival and when the agent speaks); never with reduced motion.
  var animation = /^(pulse|bounce|wiggle|glow)$/.test(script.getAttribute('data-animation') || '') ? script.getAttribute('data-animation') : '';
  var buttonLabel = (script.getAttribute('data-label') || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  var logo = (script.getAttribute('data-logo') || '').trim();
  // A picture the owner uploaded for the agent (a mascot, a face): it fills the round button.
  var picture = (script.getAttribute('data-icon-image') || '').trim();
  var SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICONS = {
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/>',
    question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/>',
    wave: '<path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M10 10.5v-6a1.5 1.5 0 0 1 3 0v6"/><path d="M13 10.5v-5a1.5 1.5 0 0 1 3 0V13"/><path d="M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a7 7 0 0 1-5.6-2.8L3.6 15a1.6 1.6 0 0 1 2.4-2.1L7 14"/>',
    heart: '<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9Z"/>',
  };
  function siteImage(value) {
    return /^https?:/.test(value) ? value : base + '/' + value.replace(/^\/+/, '');
  }
  function iconHtml() {
    // The owner's picture fills the circle, cropped to its middle whatever its shape (set below).
    if (iconName === 'image' && picture && /^[\w./-]+$/.test(picture)) return '<span class="pic" aria-hidden="true"></span>';
    if (iconName === 'logo' && logo && /^[\w./:-]+$/.test(logo)) return '<img class="logo" alt="" src="' + siteImage(logo) + '">';
    return SVG + (ICONS[iconName] || ICONS.chat) + '</svg>';
  }

  var css =
    ':host{all:initial}' +
    '*{box-sizing:border-box}' +
    '.wrap{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:calc(var(--lift,0px) + max(16px,env(safe-area-inset-bottom)));display:flex;flex-direction:column;align-items:flex-end;gap:10px;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#18181b}' +
    '.launch{width:56px;height:56px;border-radius:50%;border:0;background:var(--brand);color:var(--ink);display:grid;place-items:center;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.22)}' +
    '.launch svg{width:26px;height:26px;flex:none}' +
    '.launch .logo{width:34px;height:34px;border-radius:50%;object-fit:contain;background:#fff;flex:none}' +
    '.launch.pill{width:auto;padding:0 20px 0 15px;gap:9px;display:flex;align-items:center;border-radius:999px;font:600 15px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.launch.pill svg{width:22px;height:22px}.launch.pill .logo{width:28px;height:28px}' +
    '.launch{position:relative;padding:0}' +
    '.launch .pic{display:block;flex:none;border-radius:50%;background:#fff center/cover no-repeat}' +
    '.launch:not(.pill) .pic{position:absolute;inset:0}' +
    '.launch.pill .pic{width:30px;height:30px}' +
    '.wrap.left{right:auto;left:max(16px,env(safe-area-inset-left));align-items:flex-start}' +
    'button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #2563eb;outline-offset:2px}' +
    '.card{width:min(360px,calc(100vw - 32px));background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);border:1px solid rgba(0,0,0,.08);overflow:hidden}' +
    '.nudge{padding:14px 14px 12px;position:relative}' +
    '.nudge p{margin:0 24px 10px 0}' +
    '.row{display:flex;flex-wrap:wrap;gap:8px}' +
    '.go{display:inline-block;background:var(--brand);color:var(--ink);text-decoration:none;border-radius:999px;padding:7px 14px;font-weight:600;font-size:14px;border:0;cursor:pointer}' +
    '.no{background:transparent;border:1px solid #d4d4d8;color:#3f3f46;border-radius:999px;padding:6px 13px;font-size:14px;cursor:pointer}' +
    '.x{position:absolute;top:8px;right:8px;width:28px;height:28px;border:0;background:transparent;border-radius:50%;cursor:pointer;color:#52525b;font-size:18px;line-height:1}' +
    '.panel{display:flex;flex-direction:column;max-height:min(560px,calc(100vh - 120px))}' +
    '.head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 12px 12px 16px;background:var(--brand);color:var(--ink)}' +
    '.head h2{margin:0;font-size:16px;font-weight:650}' +
    '.head button{width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer;font-size:20px;line-height:1}' +
    '.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;min-height:120px}' +
    '.msg{max-width:88%;padding:9px 12px;border-radius:14px;background:#f4f4f5;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.msg.me{align-self:flex-end;background:var(--brand);color:var(--ink)}' +
    '.msg .row{margin-top:8px}' +
    '.form{display:flex;gap:8px;padding:10px;border-top:1px solid #e4e4e7}' +
    '.form input{flex:1;min-width:0;font:inherit;padding:9px 12px;border:1px solid #d4d4d8;border-radius:999px;color:#18181b;background:#fff}' +
    '.form button{border:0;border-radius:999px;padding:0 14px;background:var(--brand);color:var(--ink);font-weight:600;cursor:pointer}' +
    '.form button:disabled{opacity:.5;cursor:default}' +
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
    '[hidden]{display:none!important}' +
    '@media (prefers-color-scheme:dark){.card{background:#18181b;color:#f4f4f5;border-color:rgba(255,255,255,.12)}.msg{background:#27272a}.no{color:#e4e4e7;border-color:#52525b}.x{color:#a1a1aa}.form{border-color:#3f3f46}.form input{background:#09090b;color:#f4f4f5;border-color:#3f3f46}.wrap{color:#f4f4f5}}' +
    '@media (max-width:480px){.wrap.left{left:12px;right:auto}.wrap{right:12px}.card{width:calc(100vw - 24px)}.panel{max-height:70vh}.launch{width:52px;height:52px}}' +
    (reduceMotion
      ? ''
      : '@media (prefers-reduced-motion:no-preference){.card{animation:in .18s ease-out}@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
        '.launch{position:relative}' +
        '.launch.play-pulse::after{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--brand);z-index:-1;animation:ts-ring 1.6s ease-out 3}' +
        '@keyframes ts-ring{from{transform:scale(1);opacity:.55}to{transform:scale(1.7);opacity:0}}' +
        '.launch.play-bounce{animation:ts-bounce 1s ease 2}' +
        '@keyframes ts-bounce{0%,100%{transform:translateY(0)}25%{transform:translateY(-10px)}50%{transform:translateY(0)}70%{transform:translateY(-4px)}}' +
        '.launch.play-wiggle{animation:ts-wiggle .9s ease-in-out 2}' +
        '@keyframes ts-wiggle{0%,100%{transform:rotate(0)}20%{transform:rotate(-12deg)}40%{transform:rotate(10deg)}60%{transform:rotate(-6deg)}80%{transform:rotate(4deg)}}' +
        '.launch.play-glow{animation:ts-glow 1.4s ease-in-out 3}' +
        '@keyframes ts-glow{50%{box-shadow:0 6px 20px rgba(0,0,0,.22),0 0 0 6px rgba(255,255,255,.6),0 0 26px 8px var(--brand)}}' +
        '}');

  root.innerHTML =
    '<style>' + css + '</style>' +
    '<div class="wrap">' +
    '<div class="card nudge" hidden role="status"><button type="button" class="x" aria-label="Close">×</button><p></p><div class="row"></div></div>' +
    '<div class="card panel" id="ts-agent-panel" role="dialog" aria-modal="false" hidden>' +
    '<div class="head"><h2 id="ts-agent-title"></h2><button type="button" aria-label="Close chat">×</button></div>' +
    '<div class="log" role="log" aria-live="polite" aria-relevant="additions"></div>' +
    '<form class="form"><label class="sr" for="ts-agent-q"></label><input id="ts-agent-q" type="text" maxlength="300" autocomplete="off" enterkeyhint="send"><button type="submit">Send</button></form>' +
    '</div>' +
    '<button type="button" class="launch' + (buttonLabel ? ' pill' : '') + '" aria-expanded="false" aria-controls="ts-agent-panel">' +
    iconHtml() +
    '</button></div>';

  var wrap = root.querySelector('.wrap');
  wrap.style.setProperty('--brand', brand);
  wrap.style.setProperty('--ink', ink);
  var launch = root.querySelector('.launch');
  if (onLeft) wrap.classList.add('left');
  // Plays the owner's animation once more (it runs a few times, then stops).
  function animate() {
    if (!animation || reduceMotion) return;
    launch.classList.remove('play-' + animation);
    void launch.offsetWidth;
    launch.classList.add('play-' + animation);
  }
  launch.addEventListener('animationend', function (event) {
    if (event.target === launch || event.pseudoElement) launch.classList.remove('play-' + animation);
  });
  if (buttonLabel) launch.appendChild(element('span', '', buttonLabel));
  // A logo that doesn't load falls back to the chat icon.
  var logoImg = launch.querySelector('img.logo');
  if (logoImg) {
    logoImg.addEventListener('error', function () {
      logoImg.insertAdjacentHTML('afterend', SVG + ICONS.chat + '</svg>');
      logoImg.remove();
    });
  }
  // The owner's picture: loaded first, so one that can't load shows the chat icon instead of an empty circle.
  var pic = launch.querySelector('.pic');
  if (pic) {
    var src = siteImage(picture);
    var probe = new Image();
    probe.onload = function () {
      pic.style.backgroundImage = 'url("' + src.replace(/["\\]/g, '') + '")';
    };
    probe.onerror = function () {
      pic.insertAdjacentHTML('afterend', SVG + ICONS.chat + '</svg>');
      pic.remove();
    };
    probe.src = src;
  }
  var panel = root.querySelector('.panel');
  var nudge = root.querySelector('.nudge');
  var log = root.querySelector('.log');
  var form = root.querySelector('.form');
  var input = root.querySelector('input');
  var send = root.querySelector('.form button');
  root.querySelector('h2').textContent = name;
  panel.setAttribute('aria-labelledby', 'ts-agent-title');
  root.querySelector('label').textContent = 'Ask ' + name + ' a question';
  input.placeholder = 'Ask a question…';
  launch.setAttribute('aria-label', 'Chat with ' + name);

  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  // A link to a page of the site. `onGo` runs first (reporting the suggestion as accepted).
  function goLink(target, label, onGo) {
    var a = element('a', 'go', label || 'Open page');
    a.href = siteHref(target);
    if (onGo) a.addEventListener('click', onGo);
    return a;
  }

  function addMessage(entry, remember) {
    var msg = element('div', 'msg' + (entry.me ? ' me' : ''), entry.text);
    if (entry.target) {
      var row = element('div', 'row');
      row.appendChild(goLink(entry.target, entry.label));
      msg.appendChild(row);
    }
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    if (remember) {
      state.log.push({ me: Boolean(entry.me), text: entry.text, target: entry.target || null, label: entry.label || null });
      save();
    }
    return msg;
  }

  addMessage({ text: greeting });
  state.log.forEach(function (entry) {
    addMessage(entry);
  });

  function setOpen(open, focus) {
    state.open = open;
    save();
    panel.hidden = !open;
    launch.setAttribute('aria-expanded', String(open));
    if (open) {
      hideNudge();
      log.scrollTop = log.scrollHeight;
      if (focus) input.focus();
    } else if (focus) {
      launch.focus();
    }
  }
  launch.addEventListener('click', function () {
    setOpen(panel.hidden, true);
  });
  root.querySelector('.head button').addEventListener('click', function () {
    setOpen(false, true);
  });
  wrap.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!panel.hidden) setOpen(false, true);
    else if (!nudge.hidden) answerSuggestion('dismissed');
  });

  /* ------------------------------------------------------------ remembering */

  // The site's own cookie banner or consent tool (window.TwinstackAgent.remember(true|false)).
  function choose(yes) {
    if (!rememberDays || !tracking) return;
    if (yes) {
      memory = { choice: 'yes', vid: remembered() ? memory.vid : randomId(22), until: 0, log: [] };
      keepMemory();
      // Tell the server now, so this visit is remembered too.
      if (typeof flush === 'function') flushSoon();
    } else {
      if (remembered()) post('forget', { s: state.sid, v: memory.vid }, false);
      memory = { choice: 'no', until: Date.now() + 180 * DAY };
      keepMemory();
    }
  }
  window.TwinstackAgent = {
    remember: function (yes) {
      choose(Boolean(yes));
    },
  };
  var flushSoon = function () {};

  /* ------------------------------------------------------------ suggestions */

  var current = null; // the suggestion on show: { id, timer }
  var NUDGE_MS = 25000;

  function report(id, outcome) {
    post('outcome', { s: state.sid, i: id, o: outcome }, false);
  }

  function hideNudge() {
    nudge.hidden = true;
    if (current) clearTimeout(current.timer);
  }

  function answerSuggestion(outcome) {
    if (!current) return;
    var id = current.id;
    hideNudge();
    current = null;
    report(id, outcome);
    if (outcome === 'dismissed') launch.focus();
  }

  function showSuggestion(s) {
    if (!s || !s.id || !s.text || !s.target) return;
    state.suggested += 1;
    state.greeted = true;
    clearTimeout(greetTimer);
    save();
    // On screen now: the server won't offer it again on the next page.
    report(s.id, 'shown');
    var accept = function () {
      if (current && current.id === s.id) {
        clearTimeout(current.timer);
        current = null;
      }
      report(s.id, 'accepted');
    };
    if (!panel.hidden) {
      // The chat is open: the suggestion joins it.
      var msg = addMessage({ text: s.text }, false);
      var row = element('div', 'row');
      row.appendChild(goLink(s.target, s.label, accept));
      msg.appendChild(row);
      state.log.push({ text: s.text, target: s.target, label: s.label });
      save();
      return;
    }
    if (current) answerSuggestion('ignored');
    nudge.querySelector('p').textContent = s.text;
    var buttons = nudge.querySelector('.row');
    buttons.textContent = '';
    buttons.appendChild(goLink(s.target, s.label, accept));
    var no = element('button', 'no', 'No thanks');
    no.type = 'button';
    no.addEventListener('click', function () {
      answerSuggestion('dismissed');
    });
    buttons.appendChild(no);
    nudge.hidden = false;
    animate();
    current = {
      id: s.id,
      timer: setTimeout(function () {
        answerSuggestion('ignored');
      }, NUDGE_MS),
    };
  }
  nudge.querySelector('.x').addEventListener('click', function () {
    if (current) answerSuggestion('dismissed');
    else hideNudge();
  });

  /* ------------------------------------------------------------ greeting */

  // A few seconds into a visit, the helper says hello in a bubble (the owner's greeting), once a
  // visit: it costs nothing and shows visitors they can ask. A suggestion that comes takes its place.
  var GREET_MS = 4000;
  var greetTimer = null;
  var greetOn = true;
  function greet() {
    if (!greetOn || state.greeted || !panel.hidden || !nudge.hidden) return;
    state.greeted = true;
    save();
    nudge.querySelector('p').textContent = greeting;
    var buttons = nudge.querySelector('.row');
    buttons.textContent = '';
    var ask = element('button', 'go', 'Ask a question');
    ask.type = 'button';
    ask.addEventListener('click', function () {
      setOpen(true, true);
    });
    buttons.appendChild(ask);
    nudge.hidden = false;
    animate();
    clearTimeout(greetTimer);
    greetTimer = setTimeout(function () {
      if (!current) hideNudge();
    }, 15000);
  }
  if (!state.greeted) setTimeout(greet, GREET_MS);

  /* ------------------------------------------------------------ questions */

  var asking = false;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var question = input.value.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!question || asking) return;
    asking = true;
    send.disabled = true;
    input.value = '';
    addMessage({ me: true, text: question }, true);
    var waiting = addMessage({ text: '…' });
    waiting.setAttribute('aria-label', name + ' is writing');
    post('ask', { s: state.sid, i: randomId(12), p: page, q: question, dnt: !tracking || undefined }, true).then(function (reply) {
      waiting.remove();
      var answer = reply && reply.answer;
      if (answer && answer.text) addMessage({ text: answer.text, target: answer.target, label: answer.label }, true);
      else addMessage({ text: "Sorry, I can't answer that right now. Please try again later, or have a look around the site." }, false);
      asking = false;
      send.disabled = false;
      input.focus();
    });
  });

  /* ------------------------------------------------------------ out of the way */

  // Lifted above a cookie or consent banner fixed to the bottom of the window, so it never covers it.
  var BANNERS = '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i],[id*="gdpr" i],[class*="gdpr" i]';
  function lift() {
    var height = 0;
    var found;
    try {
      found = document.querySelectorAll(BANNERS);
    } catch (e) {
      return;
    }
    for (var i = 0; i < found.length && i < 50; i++) {
      var el = found[i];
      if (el === host) continue;
      var style = getComputedStyle(el);
      if ((style.position !== 'fixed' && style.position !== 'sticky') || style.display === 'none' || style.visibility === 'hidden') continue;
      var rect = el.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom >= window.innerHeight - 4 && rect.top > window.innerHeight / 3) height = Math.max(height, window.innerHeight - rect.top);
    }
    wrap.style.setProperty('--lift', Math.round(height) + 'px');
  }
  var liftTimer = null;
  function liftSoon() {
    clearTimeout(liftTimer);
    liftTimer = setTimeout(lift, 150);
  }
  window.addEventListener('resize', liftSoon);
  if (window.MutationObserver) new MutationObserver(liftSoon).observe(document.body, { childList: true, subtree: false, attributes: true, attributeFilter: ['class', 'style'] });
  document.addEventListener('click', liftSoon, true);

  document.body.appendChild(host);
  lift();
  // Catches the eye shortly after the page settles.
  setTimeout(animate, 1200);
  // Banners that come in late (consent tools load their own scripts).
  setTimeout(lift, 1000);
  setTimeout(lift, 4000);
  if (state.open) setOpen(true, false);

  /* ------------------------------------------------------------ noticing */

  if (!tracking) return;

  var queue = [{ k: 'v', p: page }];
  var since = Date.now();
  var visible = document.visibilityState !== 'hidden';
  var seenMs = 0;
  var deepest = 0;
  var left = false;
  // The server makes at most five suggestions a visit; after that only questions are sent.
  var MAX_SUGGESTIONS = 5;

  function secondsOnPage() {
    return Math.round((seenMs + (visible ? Date.now() - since : 0)) / 1000);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (visible) seenMs += Date.now() - since;
      visible = false;
      flush(false);
    } else {
      visible = true;
      since = Date.now();
    }
  });

  var TARGETS = 'a[href],button,[role="button"],summary';
  function inWidget(el) {
    return el === host || (el && el.closest && el.closest('[data-twinstack-agent]'));
  }
  function labelOf(el) {
    var text = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (!text) {
      var img = el.querySelector && el.querySelector('img[alt]');
      text = (el.innerText || el.textContent || '').trim() || (img && img.getAttribute('alt')) || '';
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  function linkOf(el) {
    var href = el.getAttribute && el.getAttribute('href');
    if (!href) return undefined;
    try {
      var url = new URL(href, location.href);
      if (url.protocol === 'tel:') return 'tel';
      if (url.protocol === 'mailto:') return 'mail';
      if (!/^https?:$/.test(url.protocol)) return undefined;
      if (url.host !== location.host) return 'ext:' + url.hostname;
      return sitePath(url.pathname);
    } catch (e) {
      return undefined;
    }
  }
  // A section: its heading, else its id.
  function sectionOf(node) {
    var section = node.closest && node.closest('section,[id]:not(main):not(body)');
    if (!section || section.closest('header,footer,nav') || !section.closest('main')) return null;
    var heading = section.querySelector('h1,h2,h3');
    var label = (heading && (heading.innerText || heading.textContent)) || section.id || '';
    label = label.replace(/\s+/g, ' ').trim().slice(0, 80);
    return label ? { el: section, label: label } : null;
  }
  function thingOf(node) {
    if (!node || !node.closest || inWidget(node)) return null;
    var el = node.closest(TARGETS);
    if (el && !el.closest('form')) return { el: el, l: labelOf(el), u: linkOf(el), x: el.tagName === 'A' ? 'link' : 'button' };
    if (el) return { el: el, l: labelOf(el), x: 'button' };
    var section = sectionOf(node);
    return section && { el: section.el, l: section.label, x: 'section' };
  }

  // Resting the pointer: added up per thing, sent once it lasts long enough to mean something.
  var HOVER_MIN = { link: 400, button: 400, section: 3000 };
  // While the pointer stays on a link or button, what it has rested so far is sent at these
  // moments, without waiting for it to move away: the first lets the server start writing a
  // suggestion, the next ones are the rests that count. These are the balanced pace's; every reply
  // brings the owner's pace (PACES in the web app's site-agent-rules.js), so a change there
  // needs no publish.
  var CHECKPOINTS = [400, 1500, 2500];
  function takeSettings(widget) {
    if (!widget) return;
    if (Array.isArray(widget.rest)) {
      var rest = widget.rest.filter(function (ms) {
        return typeof ms === 'number' && ms >= 200 && ms <= 10000;
      });
      if (rest.length && rest.length <= 8) CHECKPOINTS = rest.sort(function (a, b) {
        return a - b;
      });
    }
    if (typeof widget.max === 'number' && widget.max >= 0 && widget.max <= 10) MAX_SUGGESTIONS = widget.max;
    if (widget.greet === false) greetOn = false;
  }
  var hovering = null;
  var slipping = null;
  var SLIP_MS = 300;
  function reportHover(final) {
    var ms = Date.now() - hovering.at;
    var thing = hovering.thing;
    var fresh = Math.min(ms, 120000) - hovering.sent;
    if (ms < HOVER_MIN[thing.x] || fresh <= 0) return;
    hovering.sent += fresh;
    queue.push({ k: 'h', l: thing.l, u: thing.u, x: thing.x, d: fresh });
    if (!final) flush(true);
  }
  function endHover() {
    if (!hovering) return;
    clearTimeout(hovering.timer);
    reportHover(true);
    hovering = null;
  }
  function nextCheckpoint() {
    var h = hovering;
    var waited = Date.now() - h.at;
    for (var i = 0; i < CHECKPOINTS.length; i++) {
      if (CHECKPOINTS[i] > waited) {
        h.timer = setTimeout(function () {
          if (hovering !== h || document.visibilityState === 'hidden') return;
          reportHover(false);
          nextCheckpoint();
        }, CHECKPOINTS[i] - waited);
        return;
      }
    }
  }
  document.addEventListener(
    'pointerover',
    function (event) {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      var thing = thingOf(event.target);
      if (hovering && thing && thing.el === hovering.thing.el) {
        // Back on it after slipping off the edge: the rest carries on.
        clearTimeout(slipping);
        slipping = null;
        return;
      }
      if (!thing) {
        // A hand on a mouse wobbles: slipping just off a button for a moment doesn't end the rest.
        if (hovering && !slipping) slipping = setTimeout(function () { slipping = null; endHover(); }, SLIP_MS);
        return;
      }
      clearTimeout(slipping);
      slipping = null;
      endHover();
      hovering = { thing: thing, at: Date.now(), sent: 0, timer: null };
      if (thing.x !== 'section' && state.suggested < MAX_SUGGESTIONS) nextCheckpoint();
    },
    { passive: true },
  );
  document.addEventListener(
    'click',
    function (event) {
      endHover();
      var thing = thingOf(event.target);
      if (!thing) return;
      queue.push({ k: 'c', l: thing.l, u: thing.u, x: thing.x });
    },
    true,
  );
  window.addEventListener(
    'scroll',
    function () {
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      var depth = max > 0 ? Math.round((window.scrollY / max) * 100) : 100;
      if (depth > deepest) deepest = Math.min(100, depth);
    },
    { passive: true },
  );
  // About to leave: the pointer goes out through the top of the window (desktop).
  document.addEventListener('mouseout', function (event) {
    if (left || event.relatedTarget || event.clientY > 0) return;
    left = true;
    queue.push({ k: 'x' });
    flush(true);
  });

  var sending = false;
  // Something to send arrived while a request was out: sent as soon as that one comes back.
  var again = false;
  var firstSent = false;
  function flush(wantReply) {
    if (!queue.length) return;
    // Past the visit's suggestions only each page's first view goes (so the owner sees which
    // suggestions led somewhere).
    if (firstSent && state.suggested >= MAX_SUGGESTIONS) {
      queue.length = 0;
      return;
    }
    if (sending && wantReply) {
      again = true;
      return;
    }
    firstSent = true;
    var events = queue.splice(0, 60);
    events.push({ k: 't', d: secondsOnPage() }, { k: 's', d: deepest });
    var batch = { s: state.sid, p: page, w: window.innerWidth, e: events };
    if (!wantReply) {
      // q: the page is closing or hidden, so no reply can be shown: the server never suggests then.
      batch.q = 1;
      post('events', batch, false);
      return;
    }
    sending = true;
    post('events', batch, true).then(function (reply) {
      sending = false;
      if (reply) takeSettings(reply.widget);
      if (reply && reply.suggestion) showSuggestion(reply.suggestion);
      if (again) {
        again = false;
        if (queue.length) flush(true);
      }
    });
  }

  // A beat every few seconds while something happened, and now and then while the page is read.
  var beats = 0;
  var timer = setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    beats += 1;
    if (queue.length) flush(true);
    else if (beats % 3 === 0 && secondsOnPage() <= 180) {
      queue.push({ k: 't', d: secondsOnPage() });
      flush(true);
    }
    if (secondsOnPage() > 30 * 60) clearInterval(timer);
  }, 5000);
  window.addEventListener('pagehide', function () {
    endHover();
    flush(false);
  });
  flushSoon = function () {
    queue.push({ k: 't', d: secondsOnPage() });
    flush(true);
  };
  // The first view straight away, so the visit's pages are known.
  flush(true);
})();
