import type { TranscriptSegmentRow } from "../../../../../lib/execution-intelligence/eval-harness/snapshot";

/**
 * FROZEN synthetic transcript for benchmark Meeting 4 ("Planning / Handoff"). Generated from
 * scenario.md in this same directory. See meeting-01-status/transcript.ts for shared conventions.
 */
export type SyntheticTranscriptSegment = TranscriptSegmentRow & { index: number };

export const meetingId = "synthetic-meeting-04-handoff";
export const meetingTitle = "Team Permissions Rollout Planning";
export const participants = ["Grace", "Owen", "Mia", "Derek"];

function ts(offsetSeconds: number): string {
  const base = Date.UTC(2026, 8, 10, 15, 0, 0);
  return new Date(base + offsetSeconds * 1000).toISOString();
}

function seg(index: number, offsetSeconds: number, speaker: string, text: string): SyntheticTranscriptSegment {
  return { id: `SYN-M4-${String(index).padStart(4, "0")}`, index, timestamp: ts(offsetSeconds), speaker, text };
}

export const transcriptSegments: SyntheticTranscriptSegment[] = [
  seg(1, 0, "Grace", "okay so today's just about getting the team permissions rollout planned out, who's doing what, roughly when"),
  seg(2, 7, "Owen", "sounds good"),
  seg(3, 9, "Grace", "Owen, backend side, that's you right"),
  seg(4, 13, "Owen", "yeah, I'll build out the API for it, the endpoints for assigning roles and checking access"),
  seg(5, 20, "Grace", "roughly how long"),
  seg(6, 22, "Owen", "I'd guess like a week, maybe a little more once I get into the edge cases"),
  seg(7, 28, "Grace", "okay that works"),
  seg(8, 30, "Grace", "Mia, that means the UI is kind of waiting on Owen a bit"),
  seg(9, 35, "Mia", "yeah, I mean I can start on some of the UI shell now, like the screens and layout"),
  seg(10, 41, "Mia", "but the real wiring, actually calling the endpoints, that has to wait until your stuff exists"),
  seg(11, 48, "Owen", "yeah that's fair, I'll ping you the second the endpoints are up, even before they're fully polished"),
  seg(12, 54, "Mia", "perfect, that works, I'll just do the shell in the meantime"),
  seg(13, 58, "Grace", "great, so Mia you're building the permissions UI, blocked on Owen's API for the real integration part"),
  seg(14, 65, "Mia", "yep"),
  seg(15, 67, "Grace", "okay what about the data migration, moving everyone's existing access over to the new model"),
  seg(16, 73, "Owen", "yeah that one's gonna be a little gnarly, there's some weird legacy data in there"),
  seg(17, 78, "Mia", "I was actually looking at that data a bit last week, there's some stuff that doesn't map cleanly"),
  seg(18, 85, "Owen", "oh nice, okay, do you want to just pair on that one with me, since you already have context"),
  seg(19, 91, "Mia", "yeah let's do that, I think it'll go faster with both of us on it anyway given how messy it is"),
  seg(20, 97, "Grace", "okay so migration script is you two together"),
  seg(21, 101, "Owen", "yep"),
  seg(22, 102, "Mia", "yep"),
  seg(23, 103, "Grace", "cool, okay, documentation, somebody needs to write up what the migration actually does, for whoever has to support it later"),
  seg(24, 111, "Derek", "I can write that up, I haven't touched the permissions stuff but I can learn it well enough for a doc"),
  seg(25, 118, "Grace", "hmm, actually, Mia, since you're the one who's going to actually understand the messy data parts, might make more sense for you to write that one"),
  seg(26, 127, "Mia", "yeah that's fair, I'll have way more context by the time we're done anyway"),
  seg(27, 132, "Mia", "yeah sure, I can do that, I'll write up the migration doc once Owen and I are through the script"),
  seg(28, 139, "Derek", "yeah no that makes sense, happy to not have to learn a whole new data model just to write a doc"),
  seg(29, 146, "Grace", "ha, okay, sorry Derek, didn't mean to assign and unassign you in the same breath"),
  seg(30, 152, "Derek", "all good, honestly relieved"),
  seg(31, 155, "Grace", "okay Derek, what are you actually on the hook for then"),
  seg(32, 159, "Derek", "I've got the external API docs, and I was gonna loop in the partner integrations team too since this could affect their setup"),
  seg(33, 167, "Grace", "oh right, yeah that's two separate things, make sure both happen, the public docs and actually telling them directly"),
  seg(34, 174, "Derek", "yeah for sure, I'll update the docs and send the partner team a heads up separately, probably a quick call or an email"),
  seg(35, 182, "Grace", "perfect"),
  seg(36, 184, "Grace", "oh, before I forget, did the beta customer announcement go out, the one about the new permissions stuff coming"),
  seg(37, 191, "Derek", "oh yeah, I sent that last week actually, that one's done"),
  seg(38, 196, "Grace", "oh great, I'd forgotten"),
  seg(39, 198, "Grace", "okay, separately, can someone also own customer comms for the actual rollout, like when we flip it on"),
  seg(40, 205, "Grace", "different thing from the beta announcement, this is the real one"),
  seg(41, 209, "Owen", "I could maybe take that, but I'm pretty heads down on the API and the migration script"),
  seg(42, 215, "Mia", "yeah same, I don't think I have room for that one"),
  seg(43, 219, "Grace", "okay no worries, we don't have to solve it right this second"),
  seg(44, 224, "Grace", "let's talk timeline for a second, when do we actually want this live"),
  seg(45, 229, "Owen", "I'd say two weeks is realistic if nothing weird comes up in the migration"),
  seg(46, 235, "Mia", "yeah two weeks sounds right to me too"),
  seg(47, 238, "Grace", "okay, so we should probably put a go, no-go review on the calendar before we actually flip it on"),
  seg(48, 245, "Grace", "I'll get that scheduled for next Friday, so everyone has eyes on it before launch"),
  seg(49, 252, "Owen", "sounds good"),
  seg(50, 254, "Mia", "works for me"),
  seg(51, 256, "Derek", "yeah actually, thinking about it, I can take the rollout customer comms too, it's pretty similar to what I already do for the docs and partner stuff"),
  seg(52, 264, "Grace", "oh perfect, yeah that makes sense, you're already in that headspace"),
  seg(53, 269, "Derek", "yeah I'll fold it in, I'll draft something closer to launch once we actually know the date is solid"),
  seg(54, 276, "Grace", "great, that actually solves that then"),
  seg(55, 279, "Grace", "okay one more thing, should somebody write up a rollback plan, like what we do if this goes badly"),
  seg(56, 286, "Owen", "yeah probably a good idea in theory"),
  seg(57, 289, "Derek", "yeah, in theory, nobody's jumping at it though"),
  seg(58, 293, "Grace", "ha, fair, let's not force it, whenever, no rush, it's not blocking the launch"),
  seg(59, 299, "Mia", "yeah I think we're all a little stretched already"),
  seg(60, 303, "Grace", "yeah that's okay, we'll revisit if we need to"),
  seg(61, 307, "Grace", "okay let's go back to the migration script for a second, I want to make sure the scope is actually clear"),
  seg(62, 313, "Owen", "yeah so basically we're taking everyone's current role assignments and remapping them into the new permission model"),
  seg(63, 320, "Mia", "and flagging anything that doesn't map cleanly instead of silently guessing"),
  seg(64, 325, "Owen", "right, exactly, anything ambiguous gets flagged for a human to look at rather than us just picking something"),
  seg(65, 332, "Grace", "okay good, that's the scope I had in my head too"),
  seg(66, 336, "Grace", "and just to double check timeline on that one, still thinking you two can get through it alongside the backend API work"),
  seg(67, 343, "Owen", "yeah I think so, it's the same general window, maybe slips a day or two depending what we find"),
  seg(68, 350, "Mia", "yeah same read from me"),
  seg(69, 353, "Grace", "okay perfect, I think we have a plan"),
  seg(70, 356, "Grace", "so, Owen on the API, Mia on the UI shell now and full integration once Owen's ready, you two pairing on the migration script, Mia writing the migration doc after that, Derek on the external docs, partner heads up, and now rollout customer comms too, and I'll get the go, no-go review on the calendar for next Friday"),
  seg(71, 374, "Owen", "yep that's right"),
  seg(72, 376, "Mia", "matches what I've got"),
  seg(73, 378, "Derek", "yep all good"),
  seg(74, 380, "Grace", "awesome, thanks everyone, this was a good one")
];
