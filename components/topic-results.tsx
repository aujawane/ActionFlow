"use client";

import { useEffect, useMemo, useState } from "react";

import { InsightsPanel } from "@/components/insights-panel";
import { PromptsPanel } from "@/components/prompts-panel";
import type { ExtractedInsight, GeneratedPrompt, MeetingTopic } from "@/lib/types";

function formatConfidence(confidence: number | null) {
  if (confidence === null || Number.isNaN(confidence)) return "N/A";
  return `${Math.round(confidence * 100)}%`;
}

export function TopicResults({
  topics,
  insights,
  prompts
}: {
  topics: MeetingTopic[];
  insights: ExtractedInsight[];
  prompts: GeneratedPrompt[];
}) {
  const sortedTopics = useMemo(() => {
    return [...topics].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  }, [topics]);
  const [expandedTopicIds, setExpandedTopicIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (sortedTopics.length === 0) {
      setExpandedTopicIds(new Set());
      return;
    }

    setExpandedTopicIds((prev) => {
      const validIds = new Set(sortedTopics.map((topic) => topic.id));
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
      }
      if (next.size === 0 && sortedTopics[0]) {
        next.add(sortedTopics[0].id);
      }
      return next;
    });
  }, [sortedTopics]);

  function toggleTopic(topicId: string) {
    setExpandedTopicIds((prev) => {
      const next = new Set(prev);
      if (next.has(topicId)) {
        next.delete(topicId);
      } else {
        next.add(topicId);
      }
      return next;
    });
  }

  if (topics.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Topics</h2>
        <p className="mt-1 text-sm text-slate-600">
          No segmented topics yet. Run Analyze Meeting to create topic-level insights.
        </p>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Topics</h2>
        <p className="text-xs text-slate-500">
          Topic-by-topic analysis and prompts, each grouped under its topic name.
        </p>
      </div>

      <div className="space-y-4">
        {sortedTopics.map((topic) => {
          const topicInsights = insights.filter((item) => item.topic_id === topic.id);
          const topicPrompts = prompts.filter((item) => item.topic_id === topic.id);
          const isExpanded = expandedTopicIds.has(topic.id);

          return (
            <article
              key={topic.id}
              className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleTopic(topic.id)}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      {isExpanded ? "Collapse" : "Expand"}
                    </button>
                    <h3 className="text-base font-semibold text-slate-900">{topic.title}</h3>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                    Confidence: {formatConfidence(topic.confidence)}
                  </span>
                </div>
                {topic.summary ? (
                  <p className="text-sm text-slate-700">{topic.summary}</p>
                ) : null}
                {topic.separation_reason ? (
                  <p className="text-xs text-slate-500">
                    Why separated: {topic.separation_reason}
                  </p>
                ) : null}
              </div>

              {isExpanded ? (
                <>
                  <InsightsPanel insights={topicInsights} />
                  <PromptsPanel prompts={topicPrompts} />
                </>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
