import "./env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { rebaseHtml, publishedSiteOf } = await import("../src/original-pages.js");

describe("rebaseHtml for a downloaded website", () => {
  const here = (list) => (rel) => list.includes(rel);
  const page = (body) => `<link rel="canonical" href="https://example.org/careers/">${body}`;

  it("knows where the page was published", () => {
    assert.equal(publishedSiteOf(page("")), "https://example.org");
    assert.equal(publishedSiteOf('<meta property="og:url" content="https://shop.example.org/a/">'), "https://shop.example.org");
    assert.equal(publishedSiteOf("<p>no address</p>"), null);
  });

  it("keeps links to pages and files the site has, from any folder", () => {
    const out = rebaseHtml(page('<a href="../about-us/index.html">A</a><img src="../img/a.png">'), "careers/index.html", here(["about-us/index.html", "img/a.png"]));
    assert.match(out, /href="\/about-us\/index\.html"/);
    assert.match(out, /src="\/img\/a\.png"/);
  });

  it("sends links to missing pages and files to the website the page came from", () => {
    const out = rebaseHtml(page('<a href="../privacy/index.html">P</a><video src="../media/big.mov"></video><a href="../blog/">B</a>'), "careers/index.html", here([]));
    assert.match(out, /href="https:\/\/example\.org\/privacy\/"/);
    assert.match(out, /src="https:\/\/example\.org\/media\/big\.mov"/);
    assert.match(out, /href="https:\/\/example\.org\/blog\/"/);
  });

  it("leaves links alone when the page doesn't say where it was published", () => {
    const out = rebaseHtml('<a href="privacy/index.html">P</a>', "index.html", here([]));
    assert.match(out, /href="\/privacy\/index\.html"/);
  });
});
