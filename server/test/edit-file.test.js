import "./env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { applyTextEdits } = await import("../src/assistant/tools.js");

describe("the AI's file edits", () => {
  const css = ".logo img { height: 400px }\n.menu { gap: 2px }\n";

  it("two edits of one file in one answer both apply, the second on the file the first left", () => {
    const first = applyTextEdits(css, [{ find: "height: 400px", replace: "height: 40px" }], null, "a.css");
    // The second was proposed against the original; made again on what's there now, it still fits.
    const second = applyTextEdits(first, [{ find: "gap: 2px", replace: "gap: 16px" }], null, "a.css");
    assert.equal(second, ".logo img { height: 40px }\n.menu { gap: 16px }\n");
  });

  it("is refused only when the text it replaces is really gone", () => {
    assert.throws(() => applyTextEdits(css, [{ find: "height: 999px", replace: "x" }], null, "a.css"), /isn't in a\.css/);
    assert.throws(() => applyTextEdits("a a", [{ find: "a", replace: "b" }], null, "f"), /2 times/);
    assert.equal(applyTextEdits("a a", [{ find: "a", replace: "b", all: true }], null, "f"), "b b");
  });

  it("keeps Windows line endings", () => {
    assert.equal(applyTextEdits("x\r\ny\r\n", [{ find: "x\ny", replace: "x\nz" }], null, "f"), "x\r\nz\r\n");
  });
});
