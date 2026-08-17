import assert from "node:assert/strict";
import test from "node:test";

import { computeReplacedOwners, dedupeNames, deriveSupportingPeople } from "../lib/commitment-people";

// ============================================================
// dedupeNames -- rescued from the old structured "Wrong supporting person" picker (removed in
// favor of the "Correct with Parfait" chat assistant); still exactly what the assistant's
// server-side validator uses to compute a commitment's current supporting-people list.
// ============================================================

test("dedupeNames: case/whitespace-insensitive duplicates collapse to one entry, first-seen casing kept", () => {
  assert.deepEqual(
    dedupeNames(["Aditya Ujawane", "aditya ujawane", "  Aditya Ujawane  ", "Cameron Brock"]),
    ["Aditya Ujawane", "Cameron Brock"]
  );
});

test("dedupeNames: empty/whitespace-only entries are dropped", () => {
  assert.deepEqual(dedupeNames(["", "   ", "Cameron Brock"]), ["Cameron Brock"]);
});

test("dedupeNames: no supporting people at all returns an empty list, not a crash", () => {
  assert.deepEqual(dedupeNames([]), []);
});

// ============================================================
// computeReplacedOwners -- the actual mutation logic behind a supporting-person correction,
// reused unchanged by lib/commitment-correction/validate.ts's apply path.
// ============================================================

test("computeReplacedOwners: replaces only the matched entry", () => {
  const result = computeReplacedOwners(
    ["Francesca Todarello", "Aditya Ujawane"],
    "Aditya Ujawane",
    "Cameron Brock"
  );
  assert.deepEqual(result, ["Francesca Todarello", "Cameron Brock"]);
});

test("computeReplacedOwners: match is case/whitespace-insensitive", () => {
  const result = computeReplacedOwners(
    ["Francesca Todarello", "aditya ujawane "],
    "Aditya Ujawane",
    "Cameron Brock"
  );
  assert.deepEqual(result, ["Francesca Todarello", "Cameron Brock"]);
});

test("computeReplacedOwners: the owner is never touched when it isn't present in owners[] (the common case)", () => {
  const result = computeReplacedOwners(["Aditya Ujawane"], "Aditya Ujawane", "Cameron Brock");
  assert.deepEqual(result, ["Cameron Brock"]);
});

test("computeReplacedOwners: the owner is preserved even when redundantly present in owners[] alongside supporting people, since it is never a personToReplace option", () => {
  const result = computeReplacedOwners(
    ["Francesca Todarello", "Francesca Todarello", "Aditya Ujawane"],
    "Aditya Ujawane",
    "Cameron Brock"
  );
  assert.deepEqual(result, ["Francesca Todarello", "Francesca Todarello", "Cameron Brock"]);
});

test("computeReplacedOwners: every other supporting person remains intact when there are multiple", () => {
  const result = computeReplacedOwners(
    ["Francesca Todarello", "Aditya Ujawane", "Hannah Just Milender"],
    "Aditya Ujawane",
    "Cameron Brock"
  );
  assert.deepEqual(result, ["Francesca Todarello", "Cameron Brock", "Hannah Just Milender"]);
});

test("computeReplacedOwners: a non-array/null owners value degrades to an empty result rather than throwing", () => {
  assert.deepEqual(computeReplacedOwners(null, "Aditya Ujawane", "Cameron Brock"), []);
  assert.deepEqual(computeReplacedOwners(undefined, "Aditya Ujawane", "Cameron Brock"), []);
});

// ============================================================
// deriveSupportingPeople -- commitment.owners minus the current owner, deduped. Matches
// commitments-panel.tsx's own "Supporting" display rule.
// ============================================================

test("deriveSupportingPeople: excludes the current owner and dedupes the rest", () => {
  const result = deriveSupportingPeople(
    ["Francesca Todarello", "Aditya Ujawane", "aditya ujawane"],
    "Francesca Todarello"
  );
  assert.deepEqual(result, ["Aditya Ujawane"]);
});

test("deriveSupportingPeople: no supporting people returns an empty list", () => {
  assert.deepEqual(deriveSupportingPeople(["Francesca Todarello"], "Francesca Todarello"), []);
});

test("deriveSupportingPeople: an unassigned owner (null) still correctly excludes nothing extra -- every owners[] entry is a supporting person", () => {
  assert.deepEqual(deriveSupportingPeople(["Aditya Ujawane", "Cameron Brock"], null), [
    "Aditya Ujawane",
    "Cameron Brock"
  ]);
});
