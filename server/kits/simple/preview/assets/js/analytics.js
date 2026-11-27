/* Visit counting for the site's owner, sent to the Twinstack web app (site.config.json → analytics).
   No cookies and nothing stored about the visitor: each page view sends the page's path, the site
   it came from, its campaign tags, the screen width and the time zone. Clicks on links that leave
   the site send where they went. Nothing is sent when the visitor asks not to be tracked (Do Not
   Track or Global Privacy Control), on a local preview, or from a browser the owner has excluded
   by opening the site with ?twinstack-analytics=off (=on counts it again). */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script || !window.JSON) return;
  var endpoint = script.getAttribute('data-endpoint');
  var key = script.getAttribute('data-key');
  if (!endpoint || !key) return;
  if (!/^https?:$/.test(location.protocol) || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;

  var IGNORE = 'twinstack-analytics';
  var params = new URLSearchParams(location.search);
  try {
    if (params.get(IGNORE) === 'off') localStorage.setItem(IGNORE, 'off');
    if (params.get(IGNORE) === 'on') localStorage.removeItem(IGNORE);
    if (localStorage.getItem(IGNORE) === 'off') return;
  } catch (e) {
    // Storage blocked: the visit is counted.
  }

  // The site's base path (/<repo> on a GitHub Pages project site): the build prefixes this
  // script's src with it, so paths are sent as the site's own, the same on every address.
  var src = script.getAttribute('src') || '';
  var base = src.slice(0, Math.max(0, src.indexOf('/assets/js/analytics.js')));
  function sitePath(pathname) {
    var p = base && pathname.indexOf(base) === 0 ? pathname.slice(base.length) || '/' : pathname;
    return p.replace(/\/index\.html$/, '/');
  }

  var url = endpoint.replace(/\/+$/, '') + '/' + encodeURIComponent(key);
  function send(event) {
    var body = JSON.stringify(event);
    // text/plain: a simple request, so no preflight and nothing is read back.
    if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return;
    if (window.fetch) fetch(url, { method: 'POST', body: body, keepalive: true, mode: 'no-cors', credentials: 'omit' });
  }

  var referrer = '';
  try {
    var from = document.referrer && new URL(document.referrer);
    if (from && from.hostname !== location.hostname) referrer = from.hostname;
  } catch (e) {}

  var zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (e) {}

  send({
    t: 'pageview',
    p: sitePath(location.pathname),
    nf: script.hasAttribute('data-not-found') || undefined,
    r: referrer || undefined,
    us: params.get('utm_source') || undefined,
    um: params.get('utm_medium') || undefined,
    uc: params.get('utm_campaign') || undefined,
    w: window.innerWidth,
    tz: zone || undefined,
  });

  // Links that leave the site: phone, email, WhatsApp and other websites.
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest && event.target.closest('a[href]');
    if (!link) return;
    var target;
    try {
      target = new URL(link.href, location.href);
    } catch (e) {
      return;
    }
    var kind = target.protocol === 'tel:' ? 'phone' : target.protocol === 'mailto:' ? 'email' : null;
    if (!kind) {
      if (!/^https?:$/.test(target.protocol) || target.hostname === location.hostname) return;
      kind = /(^|\.)(wa\.me|whatsapp\.com)$/.test(target.hostname) ? 'whatsapp' : 'link';
    }
    send({ t: 'click', p: sitePath(location.pathname), k: kind, h: kind === 'link' ? target.hostname : undefined });
  }, true);
})();
