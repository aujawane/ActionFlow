import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Regression coverage for the actual root cause of "meeting intelligence stays stale after
 * analysis completes until a manual browser refresh": CommitmentsPanel, StandaloneTasksPanel,
 * and IdeasRequirementsPanel each mirror their commitments/tasks props into local useState (for
 * optimistic corrections) but never resynced that state when router.refresh() delivered fresh
 * props -- so a real router.refresh() (already correctly triggered by
 * MeetingAnalysisStatusPanel/lib/meeting-analysis-status-client.ts) fetched new server data that
 * these three client components silently ignored. The fix is the same prop-resync useEffect
 * pattern already used by components/meeting-library.tsx and components/meeting-details-editor.tsx.
 */

async function readSource(relativePath: string) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("CommitmentsPanel resyncs local commitments state when initialCommitments prop changes", async () => {
  const source = await readSource("components/commitments-panel.tsx");
  assert.match(source, /const \[commitments, setCommitments\] = useState\(initialCommitments\);/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setCommitments\(initialCommitments\);\s*\}, \[initialCommitments\]\);/
  );
});

test("StandaloneTasksPanel resyncs local tasks state when initialTasks prop changes", async () => {
  const source = await readSource("components/standalone-tasks-panel.tsx");
  assert.match(source, /const \[tasks, setTasks\] = useState\(initialTasks\);/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setTasks\(initialTasks\);\s*\}, \[initialTasks\]\);/
  );
});

test("IdeasRequirementsPanel resyncs both local commitments and tasks state when their props change", async () => {
  const source = await readSource("components/ideas-requirements-panel.tsx");
  assert.match(source, /const \[commitments, setCommitments\] = useState\(initialCommitments\);/);
  assert.match(source, /const \[tasks, setTasks\] = useState\(initialTasks\);/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setCommitments\(initialCommitments\);\s*\}, \[initialCommitments\]\);/
  );
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setTasks\(initialTasks\);\s*\}, \[initialTasks\]\);/
  );
});

test("TopicResults never needed the fix -- topics/insights are used directly as props, not mirrored into state", async () => {
  const source = await readSource("components/topic-results.tsx");
  // Only expandedTopicIds (UI-only expand/collapse) is local state; topics/insights themselves
  // are read straight from props everywhere.
  assert.doesNotMatch(source, /useState\(topics\)/);
  assert.doesNotMatch(source, /useState\(insights\)/);
  assert.match(source, /useState<Set<string>>\(new Set\(\)\)/);
});

test("all three fixed panels import useEffect", async () => {
  for (const file of [
    "components/commitments-panel.tsx",
    "components/standalone-tasks-panel.tsx",
    "components/ideas-requirements-panel.tsx"
  ]) {
    const source = await readSource(file);
    assert.match(source, /import \{[^}]*useEffect[^}]*\} from "react";/, file);
  }
});
