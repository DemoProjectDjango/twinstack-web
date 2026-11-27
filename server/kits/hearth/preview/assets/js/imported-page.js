/* Loaded before the scripts of a page imported with its own HTML, CSS and
   scripts (scripts/edit-page.js --from-html), only on such a page. Those
   scripts were written for the original page, and three things differ here:

   - Every class in the copy carries an "imp-" prefix, which its CSS is scoped
     to. The original names are put back next to them, and a class a script
     adds or removes later is mirrored to its "imp-" twin, so scripts and CSS
     both find what they expect.
   - The old <html> and <body> are one wrapper element (.imported-page) inside
     the site's page. Their classes are put on the site's <html> and <body>,
     where scripts look for them, and classes scripts change there are mirrored
     onto the wrapper, where the CSS expects them.
   - The old header, footer and navigation were removed. Looking one of them
     up returns a detached stand-in element rather than null, so a script that
     sets up the old menu first doesn't stop with an error before the rest.

   The <script> tag carries data-html-class, data-body-class and data-removed
   ("#id .class" tokens) from the page's frontmatter. base.html calls body()
   right after <body> opens and ready() before the page's own body scripts.

   A header and footer copied from a converted page (.imported-chrome, see
   scripts/edit-page.js --with-header/--with-footer) are handled the same way,
   on every page: their partial loads this file too, with data-removed naming
   the converted page's own parts, which other pages don't have. Loaded twice
   on one page, the second copy only adds its stand-ins. */
(function () {
  'use strict';

  var PREFIX = 'imp-';
  var ROOTS = '.imported-page, .imported-chrome';
  var config = (document.currentScript && document.currentScript.dataset) || {};
  var words = function (value) { return String(value || '').split(/\s+/).filter(Boolean); };
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };

  if (window.TwinstackImported) {
    window.TwinstackImported.addRemoved(config.removed);
    return;
  }

  var removedIds = {};
  var removedClasses = {};
  function addRemoved(tokens) {
    words(tokens).forEach(function (token) {
      if (token.charAt(0) === '#') removedIds[token.slice(1)] = true;
      else if (token.charAt(0) === '.') removedClasses[token.slice(1)] = true;
    });
  }
  addRemoved(config.removed);
  words(config.htmlClass).forEach(function (name) { document.documentElement.classList.add(name); });

  /* ---------------------------------------------- stand-ins for removed parts */

  var standIns = {};
  var isStandIn = function (el) { return Boolean(el && el.__twinstackStandIn); };
  function standIn(key) {
    if (!standIns[key]) {
      var el = document.createElement('div');
      el.__twinstackStandIn = true;
      standIns[key] = el;
    }
    return standIns[key];
  }
  function mentionsRemoved(selector) {
    var re = /([#.])((?:\\.|[\w-])+)/g;
    var m;
    while ((m = re.exec(String(selector)))) {
      if (m[1] === '#' ? removedIds[m[2]] : removedClasses[m[2]]) return true;
    }
    return false;
  }

  var getElementById = Document.prototype.getElementById;
  Document.prototype.getElementById = function (id) {
    var found = getElementById.call(this, id);
    return found || (removedIds[id] ? standIn('#' + id) : found);
  };
  var documentQuery = Document.prototype.querySelector;
  Document.prototype.querySelector = function (selector) {
    var found = documentQuery.call(this, selector);
    return found || (mentionsRemoved(selector) ? standIn(selector) : found);
  };
  // Inside a stand-in (the old header's menu button, say) there is always another stand-in.
  var elementQuery = Element.prototype.querySelector;
  Element.prototype.querySelector = function (selector) {
    var found = elementQuery.call(this, selector);
    return found || (isStandIn(this) ? standIn(selector) : found);
  };

  /* ------------------------------------------------------- class mirroring */

  var twin = function (name) { return name.indexOf(PREFIX) === 0 ? name.slice(PREFIX.length) : PREFIX + name; };

  // An element new to the page (or there from the start): every class gets its twin.
  function pair(el) {
    if (!el.classList) return;
    each(Array.prototype.slice.call(el.classList), function (name) {
      if (!el.classList.contains(twin(name))) el.classList.add(twin(name));
    });
  }
  function pairTree(node) {
    if (node.nodeType !== 1) return;
    pair(node);
    each(node.querySelectorAll('[class]'), pair);
    each(node.querySelectorAll('template'), function (t) { each(t.content.querySelectorAll('[class]'), pair); });
  }
  // What a script changed on an element, applied to the twins.
  function mirror(el, oldValue) {
    var before = words(oldValue);
    var after = Array.prototype.slice.call(el.classList);
    after.forEach(function (name) {
      if (before.indexOf(name) < 0 && !el.classList.contains(twin(name))) el.classList.add(twin(name));
    });
    before.forEach(function (name) {
      if (after.indexOf(name) < 0) el.classList.remove(twin(name));
    });
  }

  function body() {
    words(config.bodyClass).forEach(function (name) { document.body.classList.add(name); });
  }

  // Each wrapper on the page (the converted page's, a copied header's or footer's), once.
  function ready() {
    if (!('MutationObserver' in window)) return;
    each(document.querySelectorAll(ROOTS), function (page) {
      if (page.__twinstackReady) return;
      page.__twinstackReady = true;
      watch(page);
    });
  }

  function watch(page) {
    each(page.children, pairTree);

    // Classes head scripts already put on <html> or <body> ("js") belong to the wrapper too, and
    // ones they took off ("no-js") leave it.
    [document.documentElement, document.body].forEach(function (root) {
      each(root.classList, function (name) {
        if (name.indexOf(PREFIX) !== 0) page.classList.add(PREFIX + name);
      });
    });
    words(config.htmlClass).forEach(function (name) {
      if (!document.documentElement.classList.contains(name)) page.classList.remove(PREFIX + name);
    });
    words(config.bodyClass).forEach(function (name) {
      if (!document.body.classList.contains(name)) page.classList.remove(PREFIX + name);
    });

    var inPage = new MutationObserver(function (records) {
      records.forEach(function (r) {
        if (r.type === 'attributes' && r.target !== page) mirror(r.target, r.oldValue);
        else if (r.type === 'childList') each(r.addedNodes, pairTree);
      });
      // The changes made here are not a script's.
      inPage.takeRecords();
    });
    inPage.observe(page, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });

    var roots = new MutationObserver(function (records) {
      records.forEach(function (r) {
        var before = words(r.oldValue);
        var after = Array.prototype.slice.call(r.target.classList);
        after.forEach(function (name) { if (before.indexOf(name) < 0 && name.indexOf(PREFIX) !== 0) page.classList.add(PREFIX + name); });
        before.forEach(function (name) { if (after.indexOf(name) < 0 && name.indexOf(PREFIX) !== 0) page.classList.remove(PREFIX + name); });
      });
    });
    [document.documentElement, document.body].forEach(function (root) {
      roots.observe(root, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    });
  }

  window.TwinstackImported = { body: body, ready: ready, addRemoved: addRemoved };
})();
