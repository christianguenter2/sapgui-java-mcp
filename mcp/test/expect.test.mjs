import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExpect } from "../dist/expect.js";

test("short form PROGRAM/DYNPRO", () => {
  assert.deepEqual(parseExpect("SAPLSE16N/120"), { program: "SAPLSE16N", screen: 120 });
});
test("with transaction and window", () => {
  assert.deepEqual(parseExpect("SE16H SAPLSE16N/120 wnd[1]"), { transaction: "SE16H", program: "SAPLSE16N", screen: 120, window: "wnd[1]" });
});
test("namespace program keeps its slashes", () => {
  assert.deepEqual(parseExpect("/XYZ/SAPLFOO/0100"), { program: "/XYZ/SAPLFOO", screen: 100 });
});
test("object form passes through, undefined stays undefined", () => {
  assert.deepEqual(parseExpect({ program: "P", screen: 1 }), { program: "P", screen: 1 });
  assert.equal(parseExpect(undefined), undefined);
});
test("junk becomes a transaction name – the guard then refuses (fail safe)", () => {
  assert.deepEqual(parseExpect("nonsense!"), { transaction: "nonsense!" });
});
test("empty string is refused", () => {
  assert.throws(() => parseExpect("   "), /cannot parse expect/);
});
