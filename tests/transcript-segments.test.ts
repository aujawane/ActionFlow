import assert from "node:assert/strict";
import test from "node:test";

import {
  filterValidSegmentIds,
  getSegmentIdsFromTopic,
  isValidSegmentId
} from "../lib/transcript-segments";

test("accepts valid UUID segment ids and rejects malformed values", () => {
  assert.equal(isValidSegmentId("e919513f-66f3-4082-86c0-38be4b9d0e4f"), true);
  assert.equal(isValidSegmentId("f4145425-0789-49cc-be70-2d8db134d8cc1"), false);
  assert.equal(isValidSegmentId("uuid-1"), false);

  assert.deepEqual(
    filterValidSegmentIds([
      "e919513f-66f3-4082-86c0-38be4b9d0e4f",
      "f4145425-0789-49cc-be70-2d8db134d8cc1",
      "not-a-uuid"
    ]),
    ["e919513f-66f3-4082-86c0-38be4b9d0e4f"]
  );
});

test("optionally restricts segment ids to a known set", () => {
  const allowed = new Set(["e919513f-66f3-4082-86c0-38be4b9d0e4f"]);
  assert.deepEqual(
    getSegmentIdsFromTopic(
      [
        "e919513f-66f3-4082-86c0-38be4b9d0e4f",
        "415e6577-4b6c-452e-ab78-ee0c15b12ddd"
      ],
      allowed
    ),
    ["e919513f-66f3-4082-86c0-38be4b9d0e4f"]
  );
});
