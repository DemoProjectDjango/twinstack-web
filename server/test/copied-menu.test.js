import "./env.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { adoptCopiedMenu, copiedFooterMenu, copiedHeaderMenu } = await import("../src/navigation.js");

const HEADER = `<div class="imported-chrome" data-designed="copied" data-chrome-id="abc123">
<a id="logo" href="/"><img src="/assets/img/copied/x/logo.png" alt="Logo"></a>
<ul id="menu-primary">
  <li><a href="https://example.org/solutions/">Solutions</a>
    <ul><li><a href="https://example.org/features/">Features</a>
      <ul><li><a href="https://example.org/crm/">Offline CRM</a><li><a href="https://example.org/wash/">WASH</a></ul>
    </ul>
  <li><a href="/pricing.html">Pricing</a>
  <li><a href="#">Company</a><ul><li><a href="/about.html">About &amp; team</a></li></ul></li>
</ul>
<a class="btn-primary" href="https://example.org/contact/"><span>SCHEDULE A CALL</span></a>
<ul class="mobile-only"><li><a href="/pricing.html">Pricing</a></li></ul>
<a hidden data-chrome-page href="/">home</a>
</div>`;

const FOOTER = `<div class="imported-chrome" data-designed="copied" data-chrome-id="abc123">
<div class="band"><h2>Interested to learn more? Get in touch with our team today please.</h2><p>Long text about the form.</p></div>
<footer>
  <div class="col"><p class="title">SOLUTIONS BY FEATURE</p>
    <a href="https://example.org/crm/">Offline CRM</a>
    <a href="https://example.org/maps/">Location Mapping</a>
  </div>
  <div class="col"><h4>Learn more</h4><ul><li><a href="/careers.html">Careers</a></li><li><a href="/privacy.html">Privacy Policy</a></li></ul></div>
  <div class="contact"><p>T::</p><a href="tel:+18665550100">1-866-555-0100</a><a href="mailto:hello@example.org">hello@example.org</a></div>
  <div class="mobile"><a href="#feature">SOLUTIONS BY FEATURE</a><div><a href="https://example.org/crm/">Offline CRM</a><a href="https://example.org/maps/">Location Mapping</a></div></div>
  <p class="legal"><a href="/terms.html">Terms of use</a></p>
</footer>
</div>`;

test("a copied header's main menu, dropdowns and button are read as menu settings", () => {
  const { items, cta } = copiedHeaderMenu(HEADER);
  assert.deepEqual(items, [
    { label: "Solutions", url: "https://example.org/solutions/", children: [
      { label: "Features", url: "https://example.org/features/" },
      { label: "Offline CRM", url: "https://example.org/crm/" },
      { label: "WASH", url: "https://example.org/wash/" },
    ] },
    { label: "Pricing", url: "/pricing.html" },
    { label: "Company", children: [{ label: "About & team", url: "/about.html" }] },
  ]);
  assert.deepEqual(cta, { label: "Schedule a call", url: "https://example.org/contact/" });
});

test("a copied footer's columns come from their own headings, once each, without contact links", () => {
  const { columns, legal } = copiedFooterMenu(FOOTER);
  assert.deepEqual(columns.map((c) => c.title), ["Solutions by feature", "Learn more"]);
  assert.deepEqual(columns[0].links.map((l) => l.label), ["Offline CRM", "Location Mapping"]);
  assert.deepEqual(columns[1].links.map((l) => l.url), ["/careers.html", "/privacy.html"]);
  assert.deepEqual(legal, [{ label: "Terms of use", url: "/terms.html" }]);
});

async function site(nav) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copied-menu-"));
  await fs.mkdir(path.join(dir, "templates/partials"), { recursive: true });
  await fs.mkdir(path.join(dir, "content/data"), { recursive: true });
  await fs.writeFile(path.join(dir, "templates/partials/header.html"), HEADER);
  await fs.writeFile(path.join(dir, "templates/partials/footer.html"), FOOTER);
  await fs.writeFile(path.join(dir, "site.config.json"), JSON.stringify({ name: "Example", collections: {} }));
  await fs.writeFile(path.join(dir, "content/data/navigation.json"), `${JSON.stringify(nav, null, 2)}\n`);
  return dir;
}
const readNav = async (dir) => JSON.parse(await fs.readFile(path.join(dir, "content/data/navigation.json"), "utf8"));

test("the copied menus replace the template's starter links once, keeping the rest of the file", async () => {
  const dir = await site({
    _comment: "kept",
    header: { items: [{ label: "Blog", url: "/blog.html" }], cta: { label: "Contact us", url: "/contact.html" } },
    footer: [{ title: "Pages", links: [{ label: "About", url: "/about.html" }] }],
    legal: [{ label: "Sitemap", url: "/sitemap.xml" }],
    appearance: { header: { theme: "light" }, footer: { theme: "dark" } },
  });
  assert.ok(await adoptCopiedMenu(dir));
  const nav = await readNav(dir);
  assert.equal(nav._comment, "kept");
  assert.deepEqual(nav.appearance, { header: { theme: "light" }, footer: { theme: "dark" } });
  assert.deepEqual(nav.header.items.map((i) => i.label), ["Solutions", "Pricing", "Company"]);
  assert.equal(nav.header.cta.label, "Schedule a call");
  assert.deepEqual(nav.footer.map((c) => c.title), ["Solutions by feature", "Learn more"]);
  assert.deepEqual(nav.legal, [{ label: "Terms of use", url: "/terms.html" }]);
  assert.equal(nav.copiedMenu, "abc123");

  // The owner's later menu edits stay: it's read once per copied header.
  nav.header.items = [{ label: "Mine", url: "/mine.html" }];
  await fs.writeFile(path.join(dir, "content/data/navigation.json"), JSON.stringify(nav));
  assert.equal(await adoptCopiedMenu(dir), null);
  assert.deepEqual((await readNav(dir)).header.items, [{ label: "Mine", url: "/mine.html" }]);
});

test("nothing changes for a header and footer that weren't copied", async () => {
  const dir = await site({ header: { items: [] } });
  await fs.writeFile(path.join(dir, "templates/partials/header.html"), HEADER.replace("copied", "claude"));
  await fs.writeFile(path.join(dir, "templates/partials/footer.html"), FOOTER.replace("copied", "claude"));
  assert.equal(await adoptCopiedMenu(dir), null);
});
