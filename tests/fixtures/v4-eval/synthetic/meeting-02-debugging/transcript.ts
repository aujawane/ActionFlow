import type { TranscriptSegmentRow } from "../../../../../lib/execution-intelligence/eval-harness/snapshot";

/**
 * FROZEN synthetic transcript for benchmark Meeting 2 ("Engineering / Debugging"). Generated from
 * scenario.md in this same directory. See meeting-01-status/transcript.ts for the shared
 * conventions note (deterministic SYN-M2-NNNN ids, not UUIDs; frozen once written).
 */
export type SyntheticTranscriptSegment = TranscriptSegmentRow & { index: number };

export const meetingId = "synthetic-meeting-02-debugging";
export const meetingTitle = "Export Timeout Incident Call";
export const participants = ["Nadia", "Ravi", "Tom"];

function ts(offsetSeconds: number): string {
  const base = Date.UTC(2026, 8, 3, 14, 30, 0);
  return new Date(base + offsetSeconds * 1000).toISOString();
}

function seg(index: number, offsetSeconds: number, speaker: string, text: string): SyntheticTranscriptSegment {
  return { id: `SYN-M2-${String(index).padStart(4, "0")}`, index, timestamp: ts(offsetSeconds), speaker, text };
}

export const transcriptSegments: SyntheticTranscriptSegment[] = [
  seg(1, 0, "Tom", "okay I'm here, Nadia what are we looking at"),
  seg(2, 4, "Nadia", "so we started getting alerts like twenty minutes ago, exports are timing out for a chunk of customers"),
  seg(3, 11, "Ravi", "is it all customers or just some"),
  seg(4, 14, "Nadia", "just some so far, seems to be the bigger accounts, let me pull up the logs"),
  seg(5, 20, "Nadia", "can you guys see my screen"),
  seg(6, 23, "Tom", "yeah I can see it"),
  seg(7, 25, "Ravi", "yep"),
  seg(8, 26, "Nadia", "okay so this is the export worker, and uh, give me a sec, let me filter down to just errors"),
  seg(9, 33, "Nadia", "okay yeah look at this, these are all timing out at the exact same step"),
  seg(10, 39, "Tom", "scroll down a bit"),
  seg(11, 41, "Nadia", "yeah so"),
  seg(12, 43, "Nadia", "it's the upload step, these are all failing trying to upload the generated file"),
  seg(13, 50, "Ravi", "upload to where, S3?"),
  seg(14, 52, "Nadia", "yeah S3, and it's specifically the bigger files, that tracks with it being the bigger accounts"),
  seg(15, 59, "Tom", "so it's just timing out because the file's too big and it takes too long"),
  seg(16, 65, "Nadia", "yeah basically, there's no timeout or retry around that call at all, it just hangs until the whole thing gives up"),
  seg(17, 74, "Ravi", "okay that makes sense, that's a pretty simple thing to fix honestly"),
  seg(18, 80, "Nadia", "yeah agreed, it's not like the upload is actually broken, it's just not resilient"),
  seg(19, 87, "Tom", "okay but first, is anything stuck right now, like are customers actively blocked"),
  seg(20, 93, "Nadia", "let me check the queue"),
  seg(21, 96, "Nadia", "yeah there's a worker that looks stuck, it's been chewing on the same job for way too long"),
  seg(22, 103, "Ravi", "I can just restart that one, hang on"),
  seg(23, 107, "Ravi", "okay restarting it now"),
  seg(24, 112, "Ravi", "okay it's back up, picking up new jobs again"),
  seg(25, 117, "Nadia", "yeah I see it moving again, queue's draining"),
  seg(26, 121, "Tom", "okay good, that buys us some time"),
  seg(27, 125, "Tom", "so what's the actual fix here"),
  seg(28, 128, "Ravi", "I mean the real fix is just wrap that S3 call with a proper timeout and a retry, so it fails fast and tries again instead of hanging forever"),
  seg(29, 137, "Ravi", "yeah I can do that, shouldn't take too long, I'll get it in today or tomorrow"),
  seg(30, 144, "Tom", "could we just bump the memory on the worker instead, like a quick band-aid"),
  seg(31, 150, "Ravi", "we could, but that's not really the problem, memory's not the bottleneck here"),
  seg(32, 156, "Tom", "yeah fair, that's just papering over it, let's not do that"),
  seg(33, 161, "Ravi", "right, let's just fix the actual thing"),
  seg(34, 164, "Tom", "okay agreed"),
  seg(35, 166, "Tom", "once that's in, somebody should actually verify large-account exports work end to end in staging, not just trust that the retry logic is right"),
  seg(36, 176, "Nadia", "yeah that's fair, that shouldn't be the same person who wrote the fix either probably"),
  seg(37, 182, "Tom", "yeah I'll take that one, I'll run a few big exports through staging once Ravi's change is up"),
  seg(38, 191, "Ravi", "sounds good"),
  seg(39, 193, "Nadia", "oh, also, we clearly didn't catch this until customers started hitting it"),
  seg(40, 199, "Nadia", "I can add some actual logging and an alert around export duration so we see this coming next time instead of finding out from a support ticket"),
  seg(41, 208, "Tom", "yeah please, that would've saved us twenty minutes of scrambling"),
  seg(42, 213, "Nadia", "yeah I'll wire that up this week"),
  seg(43, 217, "Tom", "and somebody should give Jensen a heads up, he's the one who filed the ticket"),
  seg(44, 223, "Tom", "I'll just message him, let him know we found it and a fix is coming"),
  seg(45, 229, "Ravi", "cool"),
  seg(46, 231, "Nadia", "oh this reminds me actually, didn't the old exporter have basically this exact issue like six months ago"),
  seg(47, 238, "Tom", "oh yeah, ha, I forgot about that, same kind of thing, a big file just hanging on upload"),
  seg(48, 245, "Nadia", "funny, different system, same bug basically"),
  seg(49, 248, "Tom", "yeah no action needed there, just funny timing"),
  seg(50, 252, "Nadia", "anyway, while we're on this, let me also just check whether the small-account export path has the same risk"),
  seg(51, 260, "Nadia", "give me a second"),
  seg(52, 262, "Nadia", "okay so it looks like small accounts go through a similar code path, I'm not sure if they'd actually hit the same timeout though since the files are way smaller"),
  seg(53, 271, "Nadia", "I didn't get all the way through checking it, I'll pick that up after this call, want to make sure we're not missing something there too"),
  seg(54, 280, "Tom", "yeah good call, don't want to assume it's fine"),
  seg(55, 284, "Ravi", "makes sense"),
  seg(56, 286, "Tom", "okay I think we have a plan, Ravi's doing the fix, I'm doing the staging verification after and pinging Jensen, Nadia's adding alerting and finishing the small-account check"),
  seg(57, 297, "Nadia", "yep that's right"),
  seg(58, 299, "Ravi", "sounds good to me"),
  seg(59, 301, "Tom", "great, thanks everyone, good catch Nadia"),
  seg(60, 306, "Nadia", "no problem")
];
