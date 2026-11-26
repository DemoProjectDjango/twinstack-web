import "./env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { uploadName } = await import("../src/assistant/attachments.js");

describe("uploadName", () => {
  it("keeps plain names and replaces what the Files API refuses", () => {
    assert.equal(uploadName("photo.jpg"), "photo.jpg");
    assert.equal(uploadName("Fern studio · frame 1 of 12 (0:02).jpg"), "Fern studio _ frame 1 of 12 _0_02_.jpg");
    assert.equal(uploadName("Café menu.pdf"), "Cafe menu.pdf");
    assert.equal(uploadName("見積書.pdf"), "pdf");
    assert.equal(uploadName(""), "file");
    assert.match(uploadName("a".repeat(300) + ".png"), /^a{116}\.png$/);
  });
});
