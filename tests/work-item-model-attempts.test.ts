import assert from "node:assert/strict";
import test from "node:test";

import {
  runAtomicActionHarvestModel,
  runWorkItemExtractionModel
} from "../lib/execution-intelligence/work-item-model";

/**
 * GPT-6.1 Sol production experiment: work_item_extraction must make exactly one model attempt
 * (see V4_STAGE_MAX_ATTEMPTS_OVERRIDE in lib/execution-intelligence/work-item-model.ts), since its
 * per-attempt timeout alone can now consume most of the ~300s workflow-step budget. Every other
 * V4 stage must keep the existing 2-attempt retry behavior untouched.
 */

test("work_item_extraction makes exactly one model attempt, even on repeated failure", async () => {
  let calls = 0;
  const result = await runWorkItemExtractionModel({
    systemPrompt: "system",
    context: {},
    createResponse: async () => {
      calls += 1;
      throw new Error("simulated model timeout");
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.ok, false);
});

test("work_item_extraction returns the model's output on a single successful attempt", async () => {
  let calls = 0;
  const result = await runWorkItemExtractionModel({
    systemPrompt: "system",
    context: {},
    createResponse: async () => {
      calls += 1;
      return { output_text: JSON.stringify({ items: [] }), usage: null };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.ok, true);
});

test("other V4 stages (e.g. atomic_action_harvest) still retry up to 2 attempts on failure", async () => {
  let calls = 0;
  const result = await runAtomicActionHarvestModel({
    systemPrompt: "system",
    context: {},
    createResponse: async () => {
      calls += 1;
      throw new Error("simulated model timeout");
    }
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, false);
});
