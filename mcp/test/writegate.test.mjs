// The write-gate patterns live in scripts/bridge.js (Nashorn, cannot be imported) – take the regex
// literals straight from the file, so the test checks exactly what the bridge uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../scripts/bridge.js", import.meta.url), "utf8");
const rx = name => {
  const m = new RegExp(`var ${name} = (\\/.*\\/[a-z]*);`).exec(src);
  assert.ok(m, `${name} not found in bridge.js`);
  return eval(m[1]);
};
const SAVE_WORDS = rx("SAVE_WORDS"), SAVE_CODES = rx("SAVE_CODES"), COMMIT_WORDS = rx("COMMIT_WORDS"),
  COMMIT_QUESTION = rx("COMMIT_QUESTION"), ALV_WRITE_CODES = rx("ALV_WRITE_CODES");

test("save/post buttons", () => {
  for (const t of ["Save", "Post", "Buchen", "Sichern", "Speichern", " Save as Variant..."]) assert.ok(SAVE_WORDS.test(t), t);
  for (const t of ["Cancel", "Continue", "Back", "Display", "Saved list"]) assert.ok(!SAVE_WORDS.test(t), t);
});
test("buttons that commit at once", () => {
  for (const t of ["Close", "Release", "Reverse", "Delete", "Löschen", "Stornieren", "Freigeben", "Schliessen"]) assert.ok(COMMIT_WORDS.test(t), t);
  for (const t of ["Cancel", "Continue", "Choose"]) assert.ok(!COMMIT_WORDS.test(t), t);
});
test("OK-codes", () => {
  for (const c of ["=BU", "BU", "=SAVE", "/11", "=SICH"]) assert.ok(SAVE_CODES.test(c), c);
  for (const c of ["=BACK", "/nSE16H", "=ENTE", "BUCHEN"]) assert.ok(!SAVE_CODES.test(c), c);
});
test("pop-up questions that lead to a write – but not information texts", () => {
  for (const q of ["Do you want to create the key?", "Data was changed Save changes?", "Are you sure you want to close the key?", "Wollen Sie den Beleg buchen?"])
    assert.ok(COMMIT_QUESTION.test(q), q);
  for (const q of ["Key ABC created", "Document posted under the number 42", "Cannot start transaction X", "Entry was closed"])
    assert.ok(!COMMIT_QUESTION.test(q), q);
});
test("ALV toolbar function codes", () => {
  for (const c of ["&DATA_SAVE", "&SAVE", "&DELETE", "&LOCAL&DELETE_ROW"]) assert.ok(ALV_WRITE_CODES.test(c), c);
  for (const c of ["&SORT_ASC", "&DETAIL", "&MB_FILTER", "&FIND"]) assert.ok(!ALV_WRITE_CODES.test(c), c);
});
