import type { TranscriptSegmentRow } from "../../../../../lib/execution-intelligence/eval-harness/snapshot";

/**
 * FROZEN synthetic transcript for benchmark Meeting 5 ("Messy / ASR-Noisy"). Generated from
 * scenario.md in this same directory. See meeting-01-status/transcript.ts for shared conventions.
 *
 * Deliberately noisy: misheard terms ("Supabase" -> "super base", "Vercel" -> "versel", "Chatter"
 * -> "chapter", "Beacon" -> "bacon"), stutters, self-corrections, a duplicated phrase, a truncated
 * sentence, an unnaturally split speaker turn, and some missing punctuation. Noise is intentional
 * and frozen -- do not "clean up" this transcript later.
 */
export type SyntheticTranscriptSegment = TranscriptSegmentRow & { index: number };

export const meetingId = "synthetic-meeting-05-messy";
export const meetingTitle = "Quick Sync - Tool Issues";
export const participants = ["Theo", "Nina", "Pavan", "Bex"];

function ts(offsetSeconds: number): string {
  const base = Date.UTC(2026, 8, 12, 9, 0, 0);
  return new Date(base + offsetSeconds * 1000).toISOString();
}

function seg(index: number, offsetSeconds: number, speaker: string, text: string): SyntheticTranscriptSegment {
  return { id: `SYN-M5-${String(index).padStart(4, "0")}`, index, timestamp: ts(offsetSeconds), speaker, text };
}

export const transcriptSegments: SyntheticTranscriptSegment[] = [
  seg(1, 0, "Theo", "hey sorry I'm late, car wouldn't start, anyway, um, where are we"),
  seg(2, 6, "Nina", "no worries, we were just starting, uh Bex had the support thing"),
  seg(3, 10, "Bex", "yeah so we got a complaint, one customer, saying the app just kind of hangs sometimes"),
  seg(4, 16, "Theo", "hangs how, like frozen, or just slow"),
  seg(5, 19, "Bex", "slow I think, like really slow, loading forever"),
  seg(6, 23, "Theo", "yeah that's probably the super base thing, the connection pool, I've been seeing warnings about it in the logs for like two days"),
  seg(7, 31, "Nina", "oh the pooling issue, yeah I saw that too"),
  seg(8, 34, "Theo", "yeah it's running out of connections under load, I think I think it's probably just the pool size being too small for how many we actually open"),
  seg(9, 43, "Pavan", "that would explain it being intermittent, only shows up when it's busy"),
  seg(10, 48, "Theo", "right exactly"),
  seg(11, 50, "Theo", "yeah I'll fix that, I'll bump the pool config and add some actual handling so it doesn't just"),
  seg(12, 56, "Theo", "it just kind of falls over right now instead of queuing or backing off"),
  seg(13, 61, "Nina", "okay that tracks"),
  seg(14, 63, "Nina", "once that's in I can just double check the versel preview still loads fine under it, make sure we didn't break the deploy"),
  seg(15, 70, "Theo", "yeah that'd be good, probably today or tomorrow for my side"),
  seg(16, 75, "Bex", "cool I'll let the customer know we're on it"),
  seg(17, 78, "Pavan", "oh speaking of weird bugs, the chapter agent, it's been duplicating messages for some users"),
  seg(18, 85, "Nina", "wait duplicating like sending the same thing twice"),
  seg(19, 88, "Pavan", "yeah exactly, same message twice in a row, I think it's a retry thing, like it thinks the first one failed when it didn't"),
  seg(20, 95, "Theo", "oh yeah Marcus mentioned that to me earlier actually, said it's probably on the webhook side, he's not on this call but he saw it too"),
  seg(21, 101, "Pavan", "yeah that's probably it, guess that one's on me, I'll take a look at why it's double firing"),
  seg(22, 107, "Nina", "mm okay"),
  seg(23, 109, "Pavan", "yeah I got it"),
  seg(24, 111, "Bex", "oh also, the bacon service, the flag thing, it's stuck again"),
  seg(25, 116, "Nina", "ugh, again"),
  seg(26, 118, "Nina", "okay hang on let me just"),
  seg(27, 120, "Nina", "let me just restart it real quick while we're talking"),
  seg(28, 124, "Nina", "okay yeah it was stuck on the old flag state, restarting now"),
  seg(29, 129, "Nina", "okay it's back, flags are updating again, cool"),
  seg(30, 134, "Theo", "that's like the third time this month"),
  seg(31, 138, "Nina", "yeah it really is"),
  seg(32, 140, "Theo", "I can add an alert for when it restarts or gets stuck like that, so we're not just finding out from Bex every time"),
  seg(33, 148, "Bex", "ha, I don't mind being the canary but sure"),
  seg(34, 152, "Theo", "yeah I'll wire that up, shouldn't take long"),
  seg(35, 156, "Pavan", "nice"),
  seg(36, 158, "Bex", "okay separate thing the same customer from before also asked for an update on the status page, they want to see it reflected there not just hear it from me"),
  seg(37, 167, "Bex", "so I'll update the status page and also just message them directly so they know we saw it"),
  seg(38, 174, "Nina", "yeah do both, people like the direct message more than the page tbh"),
  seg(39, 180, "Bex", "yeah for sure, I'll get the page updated and ping them separately"),
  seg(40, 186, "Theo", "sounds good"),
  seg(41, 188, "Nina", "hey wait going back a second, who's looking at the actual root cause of the connection thing versus just the quick fix"),
  seg(42, 196, "Theo", "that is the fix, bumping the pool and adding backoff, that's not a band-aid, that's actually it"),
  seg(43, 203, "Nina", "oh okay got it, I misunderstood, thought there was a separate deeper thing"),
  seg(44, 209, "Theo", "no no that's it, I mean there could always be something weirder underneath but I don't have any signal pointing that way right now"),
  seg(45, 217, "Pavan", "makes sense"),
  seg(46, 219, "Bex", "okay random idea what if we just rebuilt the whole notification system from scratch like properly this time"),
  seg(47, 226, "Theo", "ha, I mean, sure, someday, that's a big one though"),
  seg(48, 231, "Nina", "yeah that's not a this-week thing, that's like a whole quarter if we're serious about it"),
  seg(49, 237, "Bex", "yeah no I know, just thinking out loud, it'd be nice someday"),
  seg(50, 242, "Pavan", "someday, sure"),
  seg(51, 244, "Theo", "yeah let's not open that can of worms right now"),
  seg(52, 248, "Nina", "agreed"),
  seg(53, 250, "Pavan", "okay I think I'm good, I've got the chapter webhook thing"),
  seg(54, 255, "Theo", "yeah and I've got the super base pool fix plus the bacon alerting"),
  seg(55, 261, "Nina", "and I've got the versel preview check once Theo's fix is up"),
  seg(56, 267, "Bex", "and I've got the status page and the customer ping"),
  seg(57, 272, "Nina", "cool I think that's"),
  seg(58, 274, "Theo", "everything"),
  seg(59, 275, "Nina", "yeah that"),
  seg(60, 277, "Bex", "okay great talk soon")
];
