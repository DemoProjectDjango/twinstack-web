import test from "node:test";
import assert from "node:assert/strict";
import { buildFillRequest, checkFill, mergeFill } from "../src/kit-fill-rules.js";

const fill = { "causes.json": ["title", "summary"], "copy.json": ["badge"] };
const files = {
  "causes.json": { items: [{ title: "Food parcels", summary: "Weekly food for families.", raised: "$8,200", percent: 68, imageAlt: "Food parcels", sample: true }, { title: "Winter meals", summary: "Hot meals.", raised: "$3,150" }] },
  "copy.json": { _comment: "x", badge: "A local charity" },
};
const good = { "causes.json": [{ title: "Vet bills", summary: "Treatment for rescued animals." }, { title: "Foster homes", summary: "A warm bed while they wait." }], "copy.json": { badge: "An animal rescue" } };

test("only the listed text fields are sent", () => {
  const sent = buildFillRequest(fill, files);
  assert.deepEqual(sent["causes.json"][0], { title: "Food parcels", summary: "Weekly food for families." });
  assert.deepEqual(sent["copy.json"], { badge: "A local charity" });
});

test("a good reply is accepted and merged, keeping numbers and marks, and emptying imageAlt (the photo no longer matches)", () => {
  const checked = checkFill(fill, files, good).value;
  assert.ok(checked);
  const { data, changed } = mergeFill(files["causes.json"], checked["causes.json"], fill["causes.json"]);
  assert.equal(changed, 4);
  assert.equal(data.items[0].title, "Vet bills");
  assert.equal(data.items[0].imageAlt, "");
  assert.equal(data.items[0].raised, "$8,200");
  assert.equal(data.items[0].percent, 68);
  assert.equal(data.items[0].sample, true);
  assert.equal(files["causes.json"].items[0].title, "Food parcels");
});

test("the wrong shape refuses the whole reply", () => {
  assert.ok(checkFill(fill, files, { ...good, "causes.json": [good["causes.json"][0]] }).problem);
  assert.ok(checkFill(fill, files, { "copy.json": good["copy.json"] }).problem);
  assert.ok(checkFill(fill, files, { ...good, "copy.json": [] }).problem);
});

test("a field with markup, braces, no text or far too long keeps its sample wording and the rest is used", () => {
  for (const badge of ["<b>Hi</b>", "{{ site.name }}", "", "x".repeat(200), 5]) {
    const checked = checkFill(fill, files, { ...good, "copy.json": { badge } });
    assert.equal(checked.problems.length, 1);
    assert.equal(checked.value["copy.json"].badge, null);
    assert.equal(checked.value["causes.json"][0].title, "Vet bills");
    const { data, changed } = mergeFill(files["copy.json"], checked.value["copy.json"], fill["copy.json"]);
    assert.equal(changed, 0);
    assert.equal(data.badge, "A local charity");
  }
});
