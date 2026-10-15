// Added to every page of the site preview by routes/preview.js (never to the published site).
// It does nothing until the editor's page (the iframe's parent) turns editing on. Then clicking
// a heading, paragraph or button's text inside <main> makes it editable (the header and footer
// keep working, so the menu still opens other pages); Enter or clicking away
// sends the text before and after to the parent, which saves it (POST …/pages/text). Escape
// puts the text back. It also tells the parent which page is showing and how far it's scrolled,
// so the preview can come back to the same place after it rebuilds.
(function () {
  if (window.parent === window) return;
  var SOURCE = "twinstack-preview";
  var editing = false;
  var active = null;
  var hovered = null;
  var nextId = 1;
  var pending = {};

  function send(message) {
    message.source = SOURCE;
    window.parent.postMessage(message, "*");
  }

  var style = document.createElement("style");
  style.textContent =
    "[data-ts-hover]{outline:2px dashed rgba(37,99,235,.8)!important;outline-offset:3px;cursor:text!important}" +
    "[data-ts-editing]{outline:2px solid rgb(37,99,235)!important;outline-offset:3px;cursor:text!important}" +
    "[data-ts-saving]{outline:2px solid rgba(37,99,235,.35)!important;outline-offset:3px}" +
    "[data-ts-failed]{outline:2px solid rgb(220,38,38)!important;outline-offset:3px}" +
    "html[data-ts-editing-on] main a,html[data-ts-editing-on] main button{cursor:text!important}";
  (document.head || document.documentElement).appendChild(style);

  function isInline(el) {
    return window.getComputedStyle(el).display === "inline";
  }

  // The block of text a click landed in: the nearest element that isn't inline (so a click on a
  // bold word edits its whole paragraph), and only one that holds nothing but text and inline parts.
  function editableFrom(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    var main = el && el.closest("main");
    if (!main || el === main) return null;
    if (el.closest("svg, textarea, input, select, option, script, style, pre, code")) return null;
    while (el.parentElement && el.parentElement !== main && isInline(el)) el = el.parentElement;
    if (el === main || !el.textContent.trim() || el.textContent.length > 5000) return null;
    var inside = el.querySelectorAll("*");
    for (var i = 0; i < inside.length; i++) {
      var child = inside[i];
      if (child.closest("svg") && child.tagName.toLowerCase() !== "svg") continue;
      var display = window.getComputedStyle(child).display;
      if (display !== "inline" && display !== "none" && display !== "contents" && child.tagName.toLowerCase() !== "svg" && child.tagName.toLowerCase() !== "img" && child.tagName.toLowerCase() !== "br") {
        return null;
      }
    }
    return el;
  }

  // Which of the page's elements with exactly this text it is, for text the page has more than once.
  function placeOf(el) {
    var text = el.textContent.trim();
    var same = [];
    var all = document.querySelectorAll("main " + el.tagName);
    for (var i = 0; i < all.length; i++) if (all[i].textContent.trim() === text) same.push(all[i]);
    return { index: same.indexOf(el), count: same.length };
  }

  function setHover(el) {
    if (hovered === el) return;
    if (hovered) hovered.removeAttribute("data-ts-hover");
    hovered = el;
    if (el) el.setAttribute("data-ts-hover", "");
  }

  function caretAt(x, y) {
    var range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      var position = document.caretPositionFromPoint(x, y);
      if (position) {
        range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
      }
    }
    if (!range) return;
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function start(el, x, y) {
    setHover(null);
    var place = placeOf(el);
    active = { el: el, before: el.textContent, html: el.innerHTML, index: place.index, count: place.count };
    try {
      el.contentEditable = "plaintext-only";
    } catch (err) {
      el.contentEditable = "true";
    }
    if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
    el.setAttribute("data-ts-editing", "");
    el.setAttribute("spellcheck", "true");
    el.focus();
    caretAt(x, y);
    send({ type: "typing", on: true });
  }

  function stop(el) {
    el.removeAttribute("contenteditable");
    el.removeAttribute("data-ts-editing");
  }

  function cancel() {
    if (!active) return;
    var current = active;
    active = null;
    current.el.innerHTML = current.html;
    stop(current.el);
    send({ type: "typing", on: false });
  }

  function finish() {
    if (!active) return;
    var current = active;
    active = null;
    stop(current.el);
    send({ type: "typing", on: false });
    var after = current.el.textContent;
    if (after === current.before) return;
    var id = nextId++;
    pending[id] = current;
    current.el.setAttribute("data-ts-saving", "");
    send({
      type: "edit",
      id: id,
      path: window.location.pathname,
      before: current.before,
      after: after,
      index: current.index,
      count: current.count,
    });
  }

  function setEditing(on) {
    editing = on;
    if (on) document.documentElement.setAttribute("data-ts-editing-on", "");
    else {
      document.documentElement.removeAttribute("data-ts-editing-on");
      setHover(null);
      finish();
    }
  }

  document.addEventListener(
    "mouseover",
    function (event) {
      if (editing && !active) setHover(editableFrom(event.target));
    },
    true,
  );

  // Capture first, so the site's own links, buttons and menus don't act while editing.
  document.addEventListener(
    "click",
    function (event) {
      if (!editing) return;
      // The header and footer still work, so the menu can open another page to edit.
      if (!event.target.closest || !event.target.closest("main")) return;
      event.preventDefault();
      event.stopPropagation();
      if (active && active.el.contains(event.target)) return;
      if (active) active.el.blur();
      var el = editableFrom(event.target);
      if (el) start(el, event.clientX, event.clientY);
      else send({ type: "not-editable" });
    },
    true,
  );

  document.addEventListener(
    "submit",
    function (event) {
      if (editing) event.preventDefault();
    },
    true,
  );

  document.addEventListener(
    "keydown",
    function (event) {
      if (!active || !active.el.contains(event.target)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        active.el.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    },
    true,
  );

  document.addEventListener(
    "focusout",
    function (event) {
      if (active && event.target === active.el) finish();
    },
    true,
  );

  var scrollTimer = null;
  window.addEventListener(
    "scroll",
    function () {
      if (scrollTimer) return;
      scrollTimer = setTimeout(function () {
        scrollTimer = null;
        send({ type: "scroll", path: window.location.pathname, y: Math.round(window.scrollY) });
      }, 200);
    },
    { passive: true },
  );

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === "mode") setEditing(Boolean(data.editing));
    else if (data.type === "go" && typeof data.path === "string" && data.path.charAt(0) === "/") window.location.replace(data.path);
    else if (data.type === "scroll" && typeof data.y === "number") window.scrollTo(0, data.y);
    else if (data.type === "result" && pending[data.id]) {
      var saved = pending[data.id];
      delete pending[data.id];
      saved.el.removeAttribute("data-ts-saving");
      if (!data.ok) {
        saved.el.innerHTML = saved.html;
        saved.el.setAttribute("data-ts-failed", "");
        setTimeout(function () {
          saved.el.removeAttribute("data-ts-failed");
        }, 2500);
      }
    }
  });

  send({ type: "ready", path: window.location.pathname });
})();
