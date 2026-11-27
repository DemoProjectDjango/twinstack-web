import "./env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { occurrences, swapAt } = await import("../src/text-edit.js");

describe("swapping a picture in a page's source", () => {
  it("finds an address written root-relative or without the slash, never inside a longer one", () => {
    const text = '<img src="/assets/img/a.png"> ![x](assets/img/a.png) <img src="/assets/img/a.png.webp"> url("/assets/img/a.png")';
    assert.equal(occurrences(text, "/assets/img/a.png").length, 3);
  });

  it("swaps the chosen one and drops srcset and sizes from its tag only", () => {
    const text = '<img src="/assets/img/a.png" srcset="/assets/img/a-2x.png 2x" sizes="100vw" alt="A"><img src="/assets/img/a.png" srcset="x 2x">';
    const found = occurrences(text, "/assets/img/a.png");
    const out = swapAt(text, found[0], "/assets/img/uploads/new.jpg");
    assert.equal(out, '<img src="/assets/img/uploads/new.jpg" alt="A"><img src="/assets/img/a.png" srcset="x 2x">');
  });

  it("swaps a markdown image without touching anything else", () => {
    const text = "Intro\n\n![Our team](/assets/img/team.jpg)\n\nMore";
    const out = swapAt(text, occurrences(text, "/assets/img/team.jpg")[0], "/assets/img/uploads/team-2026.jpg");
    assert.equal(out, "Intro\n\n![Our team](/assets/img/uploads/team-2026.jpg)\n\nMore");
  });
});
