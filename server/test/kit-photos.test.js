import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { swapKitPhotos } from "../src/kit-files.js";

const kit = { id: "demo", photos: [{ file: "hero.webp", label: "Top" }, { file: "cause.webp", label: "Project" }] };

async function site() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swap-"));
  await fs.mkdir(path.join(dir, "content/pages"), { recursive: true });
  await fs.mkdir(path.join(dir, "content/data"), { recursive: true });
  await fs.mkdir(path.join(dir, "assets/img/uploads"), { recursive: true });
  await fs.writeFile(path.join(dir, "content/pages/home.md"), '<img src="/assets/img/kit/demo/hero.webp" alt="x"><img src="/assets/img/kit/demo/cause.webp">');
  await fs.writeFile(path.join(dir, "content/data/causes.json"), JSON.stringify({ items: [{ title: "T", image: "/assets/img/kit/demo/cause.webp", imageAlt: "T" }, { title: "U", image: "/assets/img/kit/demo/other.webp", imageAlt: "U" }] }));
  for (const f of ["a.jpg", "b.jpg"]) await fs.writeFile(path.join(dir, "assets/img/uploads", f), "x");
  return dir;
}

test("the owner's photos take the template's slots in order, in pages and data, and swapped items lose their alt text", async () => {
  const dir = await site();
  const n = await swapKitPhotos(kit, dir, ["/assets/img/uploads/a.jpg", "/assets/img/uploads/b.jpg"]);
  assert.equal(n, 2);
  const page = await fs.readFile(path.join(dir, "content/pages/home.md"), "utf8");
  assert.match(page, /src="\/assets\/img\/uploads\/a\.jpg"/);
  assert.match(page, /<img src="\/assets\/img\/uploads\/b\.jpg">/);
  const data = JSON.parse(await fs.readFile(path.join(dir, "content/data/causes.json"), "utf8"));
  assert.equal(data.items[0].image, "/assets/img/uploads/b.jpg");
  assert.equal(data.items[0].imageAlt, "");
  assert.equal(data.items[1].image, "/assets/img/kit/demo/other.webp");
  assert.equal(data.items[1].imageAlt, "U");
});

test("one photo replaces only the first slot, and bad or missing photos are skipped", async () => {
  const dir = await site();
  assert.equal(await swapKitPhotos(kit, dir, ["../../etc/passwd", "/assets/img/uploads/missing.jpg", "https://x.test/a.jpg", "/assets/img/uploads/a.jpg"]), 1);
  const page = await fs.readFile(path.join(dir, "content/pages/home.md"), "utf8");
  assert.match(page, /uploads\/a\.jpg/);
  assert.match(page, /kit\/demo\/cause\.webp/);
  assert.equal(await swapKitPhotos(kit, dir, []), 0);
});
