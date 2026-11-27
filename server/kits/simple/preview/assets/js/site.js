/* Progressive enhancement only. The site works with JavaScript disabled.
   Visual state is expressed as data attributes so Tailwind variants
   (data-[open=false]:hidden) do the styling, not JavaScript. */
(function () {
  'use strict';

  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.getElementById('primary-nav');

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.getAttribute('data-open') === 'true';
      nav.setAttribute('data-open', String(!open));
      toggle.setAttribute('aria-expanded', String(!open));
      toggle.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && nav.getAttribute('data-open') === 'true') {
        nav.setAttribute('data-open', 'false');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }

  // The header's look once the page is scrolled (data-scrolled): a see-through header turns
  // solid, and one set to shrink gets lower.
  var header = document.querySelector('.site-header[data-scrolled]');
  if (header) {
    var ticking = false;
    var update = function () {
      ticking = false;
      header.setAttribute('data-scrolled', String(window.scrollY > 8));
    };
    update();
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }, { passive: true });
  }

  // Dropdowns open on hover and focus in CSS; this adds arrow-key entry.
  document.querySelectorAll('.group > a').forEach(function (link) {
    // An imported page (or a header copied from one) may use "group" too; it isn't the menu.
    if (link.closest && link.closest('.imported-page, .imported-chrome')) return;
    var panel = link.parentElement.querySelector('ul');
    if (!panel) return;
    link.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        var first = panel.querySelector('a');
        if (first) first.focus();
      }
    });
  });

  // A table wider than its column (a pricing comparison on a phone) scrolls by itself,
  // like a markdown table in .table-scroll, instead of being cut off at the screen's
  // edge (main clips what sticks out sideways). Only tables that don't fit and aren't
  // already in something that scrolls; an imported page's own CSS is left as it is.
  document.querySelectorAll('main table').forEach(function (table) {
    var parent = table.parentElement;
    if (!parent || table.closest('.table-scroll, .imported-page, .imported-chrome') || parent.closest('table')) return;
    if (table.offsetWidth <= parent.clientWidth + 1) return;
    for (var el = parent; el && el.tagName !== 'MAIN'; el = el.parentElement) {
      if (/auto|scroll/.test(window.getComputedStyle(el).overflowX)) return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    parent.insertBefore(wrap, table);
    wrap.appendChild(table);
  });

  // A page imported with its own CSS (edit-page.js --keep-styles) may have had a
  // scroll-reveal effect driven by its old script. The converter records it on
  // the wrapper; this plays it back. Without this script (or IntersectionObserver)
  // the root class is never added, so the hiding rules never apply.
  document.querySelectorAll('.imported-page[data-reveal]').forEach(function (page) {
    if (!('IntersectionObserver' in window)) return;
    var data = page.dataset;
    var stagger = /^(\d+)x(\d+)$/.exec(data.revealStagger || '');
    var items = page.querySelectorAll('.' + data.reveal);
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add(data.revealState);
        observer.unobserve(entry.target);
      });
    }, { rootMargin: data.revealMargin || '0px', threshold: Number(data.revealThreshold) || 0 });
    items.forEach(function (item, i) {
      if (stagger) item.style.transitionDelay = (i % Number(stagger[1])) * Number(stagger[2]) + 'ms';
      observer.observe(item);
    });
    page.classList.add(data.revealRoot);
  });
})();
