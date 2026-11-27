import "./env.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { adoptHeaderLogo } = await import("../src/brand.js");

const LOGO = "/assets/img/copied/example.org/logo-nav.png";

async function site({ header, brand }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "adopt-logo-"));
  await fs.mkdir(path.join(dir, "templates/partials"), { recursive: true });
  await fs.mkdir(path.join(dir, "assets/img/copied/example.org"), { recursive: true });
  await fs.writeFile(path.join(dir, LOGO.slice(1)), "png");
  await fs.writeFile(path.join(dir, "templates/partials/header.html"), header);
  await fs.writeFile(path.join(dir, "site.config.json"), `${JSON.stringify({ name: "Example", brand }, null, 2)}\n`);
  return dir;
}

const readBrand = async (dir) => JSON.parse(await fs.readFile(path.join(dir, "site.config.json"), "utf8")).brand;
const copiedHeader = `<div class="imported-chrome" data-designed="copied"><a href="/"><img src="${LOGO}" alt="Example logo"></a><nav><ul><li>Menu</li></ul></nav></div>`;

test("a copied header's logo becomes the site's logo while it has none", async () => {
  const dir = await site({ header: copiedHeader, brand: { logoText: "Example", logo: "", logoMark: "/assets/img/logo-mark.svg" } });
  assert.equal(await adoptHeaderLogo(dir), LOGO);
  const brand = await readBrand(dir);
  assert.equal(brand.logo, LOGO);
  assert.deepEqual(Object.keys(brand), ["logoText", "logo", "logoMark"]);
});

test("an owner's own logo is never replaced", async () => {
  const dir = await site({ header: copiedHeader, brand: { logo: "/assets/img/brand/mine.png" } });
  assert.equal(await adoptHeaderLogo(dir), null);
  assert.equal((await readBrand(dir)).logo, "/assets/img/brand/mine.png");
});

test("only a copied header's logo is taken, and only a file the site has", async () => {
  const designed = await site({ header: copiedHeader.replace("copied", "claude"), brand: { logo: "" } });
  assert.equal(await adoptHeaderLogo(designed), null);
  const missing = await site({ header: copiedHeader.replace(LOGO, "/assets/img/copied/example.org/gone.png"), brand: { logo: "" } });
  assert.equal(await adoptHeaderLogo(missing), null);
  const remote = await site({ header: copiedHeader.replace(LOGO, "https://example.org/logo.png"), brand: { logo: "" } });
  assert.equal(await adoptHeaderLogo(remote), null);
});
