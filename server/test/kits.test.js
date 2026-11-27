import "./env.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Starter kits (src/kits.js): every kit is listed, and each one, applied to a fresh copy of the site
// template, builds and passes the template's own check (the deploy's). The template is the local
// twinstack-site checkout beside this repo, or TWINSTACK_SITE_DIR; without one the build part is skipped.

const workspaces = await fs.mkdtemp(path.join(os.tmpdir(), "twinstack-kits-"));
process.env.WORKSPACES_DIR = workspaces;
const { applyKit, listKits, loadKits, sameAddress } = await import("../src/kits.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = process.env.TWINSTACK_SITE_DIR || path.resolve(here, "../../../twinstack-site");
const hasTemplate = existsSync(path.join(TEMPLATE, "scripts/build.js")) && existsSync(path.join(TEMPLATE, "node_modules"));
const SKIP = new Set(["node_modules", "dist", ".git", ".env"]);
const STARTER_HOME = "---\ntitle: Home\nurl: /\n---\n\n# Home\n\nOne sentence on what you do.\n";

/** A copy of the template at workspace key `key`, like a new site: the starter homepage and the owner's name and details. */
async function newSite(key) {
  const dir = path.join(workspaces, ...key.split("/"));
  await fs.cp(TEMPLATE, dir, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
  // A junction needs no admin rights on Windows; elsewhere it's a plain link.
  await fs.symlink(path.join(TEMPLATE, "node_modules"), path.join(dir, "node_modules"), "junction");
  // Every real site is a git checkout: the setup keeps its build plan in .git/.
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(path.join(dir, "content/pages/home.md"), STARTER_HOME);
  const config = JSON.parse(await fs.readFile(path.join(dir, "site.config.json"), "utf8"));
  config.name = "Harbour Street Bakery";
  config.description = "Fresh bread and pastries, baked every morning.";
  config.contact = { ...config.contact, email: "hello@example.com", phone: "+44 20 7946 0000" };
  await fs.writeFile(path.join(dir, "site.config.json"), JSON.stringify(config, null, 2));
  return dir;
}

const node = (dir, script) => execFileSync(process.execPath, [script], { cwd: dir, encoding: "utf8", stdio: "pipe", env: { ...process.env, NODE_ENV: "production" } });

describe("starter kits", () => {
  after(() => fs.rm(workspaces, { recursive: true, force: true }));

  it("lists every kit, free, with its pages and no folder paths", async () => {
    const kits = await listKits();
    assert.ok(kits.some((k) => k.id === "simple"), "the simple kit is listed");
    for (const kit of kits) {
      assert.equal(kit.free, true);
      assert.equal(kit.dir, undefined);
      assert.ok(kit.pages.some((p) => p.url === "/"), `${kit.id} has a homepage`);
    }
  });

  it("compares page addresses the way the site serves them", () => {
    assert.ok(sameAddress("/contact.html", "/contact"));
    assert.ok(sameAddress("/contact/", "/contact"));
    assert.ok(!sameAddress("/contact.html", "/about.html"));
  });

  it("every kit page is a finished design, not a starter", async () => {
    for (const kit of await loadKits()) {
      for (const page of kit.pages) {
        const text = await fs.readFile(path.join(kit.dir, "pages", page.file), "utf8");
        assert.match(text, /<section\b[^>]*class=/, `${kit.id}/${page.file} has designed sections`);
        assert.doesNotMatch(text, /One sentence on (what|how)|Replace this with|Opening paragraph: the specific situation/);
        assert.match(text, new RegExp(`^url: ${page.url.replace(/[.]/g, "\\.")}$`, "m"), `${kit.id}/${page.file} is at ${page.url}`);
      }
    }
  });

  describe("applied to a new site", { skip: !hasTemplate && "no twinstack-site checkout with node_modules beside this repo" }, () => {
    let dir;
    const key = "u1.e1/owner/site";
    before(async () => {
      dir = await newSite(key);
    });

    it("replaces the starter homepage and adds the contact page", async () => {
      const result = await applyKit(key, "simple");
      assert.deepEqual(result.pages.map((p) => p.file).sort(), ["content/pages/contact.md", "content/pages/home.md"]);
      assert.equal(result.pages.find((p) => p.url === "/contact.html").menu, true);
      const home = await fs.readFile(path.join(dir, "content/pages/home.md"), "utf8");
      assert.match(home, /\{\{ site\.name \}\}/);
    });

    it("builds and passes the site's own check, with the owner's details on the pages", () => {
      node(dir, "scripts/build.js");
      const output = node(dir, "scripts/check.js");
      assert.doesNotMatch(output, /^\s*error\s/m, output);
    });

    it("shows the owner's name, description and contact details", async () => {
      const home = await fs.readFile(path.join(dir, "dist/index.html"), "utf8");
      assert.match(home, /Harbour Street Bakery/);
      assert.match(home, /Fresh bread and pastries/);
      assert.match(home, /tel:\+44 20 7946 0000/);
      const contact = await fs.readFile(path.join(dir, "dist/contact.html"), "utf8");
      assert.match(contact, /mailto:hello@example\.com/);
      // Details the owner didn't give are left out, not shown empty.
      assert.doesNotMatch(contact, /Opening hours/);
    });

    it("never overwrites a page the owner already has", async () => {
      await fs.writeFile(path.join(dir, "content/pages/contact.md"), "---\ntitle: Contact\nurl: /contact.html\n---\n<section class=\"p-4\">Mine</section>\n");
      const again = await applyKit(key, "simple");
      assert.deepEqual(again.pages, []);
      assert.match(await fs.readFile(path.join(dir, "content/pages/contact.md"), "utf8"), /Mine/);
    });

    it("a setup saved with a kit and only the name and what the business does builds the site with no AI", async () => {
      const kitKey = "u1.e1/owner/kit-only";
      const kitDir = await newSite(kitKey);
      const { saveSetup } = await import("../src/site-setup.js");
      const body = { name: "Harbour Street Bakery", what: "Fresh bread every morning.", brief: "", type: "generic", by: "keywords", questions: [], answers: {}, skipped: [], pages: [], chrome: "design", chromeChoice: {}, known: [], findings: [], kit: "simple" };
      const saved = await saveSetup({ key: kitKey, siteId: null, body, options: { chrome: true } });
      assert.equal(saved.build, false, "nothing is left for the AI to build");
      assert.match(await fs.readFile(path.join(kitDir, "content/pages/home.md"), "utf8"), /What we offer/);
      assert.ok(existsSync(path.join(kitDir, "content/pages/contact.md")));
      const nav = JSON.parse(await fs.readFile(path.join(kitDir, "content/data/navigation.json"), "utf8"));
      assert.ok(nav.header.items.some((i) => i.url === "/contact.html"), "Contact is in the header menu");
      const config = JSON.parse(await fs.readFile(path.join(kitDir, "site.config.json"), "utf8"));
      assert.equal(config.description, "Fresh bread every morning.");
      node(kitDir, "scripts/build.js");
      assert.doesNotMatch(node(kitDir, "scripts/check.js"), /^\s*error\s/m);
    });

    it("refuses a kit that doesn't exist", async () => {
      assert.equal(await applyKit(key, "nope"), null);
    });
  });
});

describe("starter kit previews", () => {
  it("every kit has a built preview (npm run kits:build)", async () => {
    const { KITS_DIR } = await import("../src/kits.js");
    for (const kit of await loadKits()) {
      assert.ok(existsSync(path.join(KITS_DIR, kit.id, "preview/index.html")), `${kit.id} has preview/index.html`);
      for (const page of kit.pages.filter((p) => p.url !== "/")) {
        assert.ok(existsSync(path.join(KITS_DIR, kit.id, "preview", page.url)), `${kit.id} preview has ${page.url}`);
      }
    }
  });

  it("serves them publicly, sandboxed, and nothing else", async () => {
    const express = (await import("express")).default;
    const { kitPreviewRouter } = await import("../src/kits.js");
    const app = express();
    app.use("/api/kit-preview", kitPreviewRouter());
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/kit-preview`;
    try {
      for (const url of ["/simple", "/simple/", "/simple/contact.html", "/simple/assets/css/main.css"]) {
        const res = await fetch(base + url);
        assert.equal(res.status, 200, url);
        assert.match(res.headers.get("content-security-policy"), /^sandbox /, url);
      }
      for (const url of ["/simple/.nojekyll", "/simple/..%2fkit.json", "/simple/missing.html", "/Bad_Kit/x", "/nope/"]) {
        assert.equal((await fetch(base + url)).status, 404, url);
      }
    } finally {
      server.close();
    }
  });
});
