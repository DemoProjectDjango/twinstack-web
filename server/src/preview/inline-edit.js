// Added to every page of the site preview by routes/preview.js (never to the published site).
// It does nothing until the editor's page (the iframe's parent) turns editing on. Then clicking
// a heading, paragraph or button's text inside <main> makes it editable (the header and footer
// keep working, so the menu still opens other pages); Enter or clicking away
// sends the text before and after to the parent, which saves it (POST …/pages/text). Escape
// puts the text back. It also tells the parent which page is showing and how far it's scrolled,
// so the preview can come back to the same place after it rebuilds. While editing is on, the
// section under the pointer gets an "Ask the AI to change this section" button; pressing it tells
// the parent which section (its heading, first words and place on the page), and the parent starts
// that request in the AI's conversation.
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
    "html[data-ts-editing-on] main a,html[data-ts-editing-on] main button{cursor:text!important}" +
    "[data-ts-section]{outline:1px dashed rgba(37,99,235,.45)!important;outline-offset:-1px}" +
    "[data-ts-ask]{position:absolute!important;z-index:2147483647!important;margin:0!important;font:600 13px/1.2 system-ui,-apple-system,sans-serif!important;" +
    "color:#fff!important;background:rgb(37,99,235)!important;border:0!important;border-radius:999px!important;padding:7px 12px!important;" +
    "cursor:pointer!important;box-shadow:0 4px 14px rgba(0,0,0,.2)!important;white-space:nowrap!important;text-transform:none!important;letter-spacing:normal!important}" +
    "[data-ts-ask]:hover{background:rgb(29,78,216)!important}[data-ts-ask][hidden]{display:none!important}";
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

  // The section a node is in: the outermost <section> inside <main>, else the part of <main> it's in,
  // going down while that part is taller than the window and has more than one block (so a page whose
  // body is one wrapper, like a converted page's, still has sections).
  function sectionOf(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    var main = el && el.closest("main");
    if (!main || el === main) return null;
    var section = el.closest("section");
    if (section && main.contains(section) && section !== main) {
      var outer = section.parentElement && section.parentElement.closest("section");
      while (outer && main.contains(outer) && outer !== main) {
        section = outer;
        outer = section.parentElement && section.parentElement.closest("section");
      }
      return section;
    }
    var part = el;
    while (part.parentElement && part.parentElement !== main) part = part.parentElement;
    while (part.children.length > 1 && part.getBoundingClientRect().height > window.innerHeight * 1.2) {
      var inner = null;
      for (var i = 0; i < part.children.length; i++) if (part.children[i].contains(el)) inner = part.children[i];
      if (!inner) break;
      part = inner;
    }
    return part.textContent.trim() ? part : null;
  }

  // Short, single-line text for the request.
  function clip(text) {
    var line = String(text || "").replace(/\s+/g, " ").trim();
    return line.length > 90 ? line.slice(0, 87).trim() + "\u2026" : line;
  }

  var askButton = document.createElement("button");
  askButton.type = "button";
  askButton.hidden = true;
  askButton.setAttribute("data-ts-ask", "");
  // Escaped: the script is inlined into pages whose encoding isn't known here.
  askButton.textContent = "\u2726 Ask the AI to change this section";
  var askSection = null;

  function placeAsk() {
    if (!askSection) return;
    var rect = askSection.getBoundingClientRect();
    // A zoomed button's top and left are zoomed too, so they're given in its own units.
    var zoom = parseFloat(askButton.style.getPropertyValue("zoom")) || 1;
    var width = askButton.getBoundingClientRect().width;
    var left = Math.max(rect.left + 8, Math.min(rect.right - width - 8, window.innerWidth - width - 8));
    askButton.style.top = Math.round((Math.max(rect.top, 0) + window.scrollY + 8) / zoom) + "px";
    askButton.style.left = Math.round((Math.max(left, 8) + window.scrollX) / zoom) + "px";
  }

  function setSection(section) {
    if (askSection === section) return;
    if (askSection) askSection.removeAttribute("data-ts-section");
    askSection = section;
    if (!askButton.parentNode && document.body) document.body.appendChild(askButton);
    askButton.hidden = !section;
    if (!section) return;
    section.setAttribute("data-ts-section", "");
    placeAsk();
  }

  askButton.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (!askSection) return;
    var siblings = askSection.parentElement ? askSection.parentElement.children : [askSection];
    var position = Array.prototype.indexOf.call(siblings, askSection);
    var heading = askSection.querySelector("h1, h2, h3, h4");
    send({
      type: "ask-section",
      path: window.location.pathname,
      heading: heading ? clip(heading.textContent) : "",
      // innerText keeps the breaks between blocks ("Our story We have…", not "Our storyWe have…").
      start: clip(askSection.innerText || askSection.textContent),
      position: position + 1,
      count: siblings.length,
    });
  });

  window.addEventListener("resize", placeAsk);

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
    setSection(null);
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
      setSection(null);
      finish();
    }
  }

  document.addEventListener(
    "mouseover",
    function (event) {
      if (!editing || active) return;
      setHover(editableFrom(event.target));
      // Over the button itself, its section stays.
      if (event.target !== askButton) setSection(sectionOf(event.target));
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
    // The editor shows the page scaled down (a desktop layout in a narrower box): the button is
    // scaled back up by the same amount, so it stays readable.
    else if (data.type === "scale" && typeof data.value === "number" && data.value > 0.2 && data.value <= 1) {
      askButton.style.setProperty("zoom", String(1 / data.value), "important");
      placeAsk();
    }
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
