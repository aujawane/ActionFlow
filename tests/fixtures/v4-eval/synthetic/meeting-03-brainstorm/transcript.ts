import type { TranscriptSegmentRow } from "../../../../../lib/execution-intelligence/eval-harness/snapshot";

/**
 * FROZEN synthetic transcript for benchmark Meeting 3 ("Product Brainstorm"). Generated from
 * scenario.md in this same directory. See meeting-01-status/transcript.ts for shared conventions.
 */
export type SyntheticTranscriptSegment = TranscriptSegmentRow & { index: number };

export const meetingId = "synthetic-meeting-03-brainstorm";
export const meetingTitle = "Digest Email Brainstorm";
export const participants = ["Jordan", "Riley", "Sana", "Felix"];

function ts(offsetSeconds: number): string {
  const base = Date.UTC(2026, 8, 8, 10, 0, 0);
  return new Date(base + offsetSeconds * 1000).toISOString();
}

function seg(index: number, offsetSeconds: number, speaker: string, text: string): SyntheticTranscriptSegment {
  return { id: `SYN-M3-${String(index).padStart(4, "0")}`, index, timestamp: ts(offsetSeconds), speaker, text };
}

export const transcriptSegments: SyntheticTranscriptSegment[] = [
  seg(1, 0, "Jordan", "okay so this one's just a brainstorm, nothing's getting decided today, I just want to get ideas out about the digest email"),
  seg(2, 8, "Riley", "cool, honestly I feel like nobody even reads the digest email right now"),
  seg(3, 13, "Jordan", "yeah that's kind of the problem, open rates are pretty low"),
  seg(4, 17, "Sana", "what if it wasn't an email at all, like what if it just lived in the product"),
  seg(5, 22, "Jordan", "interesting, say more"),
  seg(6, 24, "Sana", "I don't know, just like, a little panel when you log in, 'here's what happened this week'"),
  seg(7, 30, "Riley", "ooh I actually like that"),
  seg(8, 33, "Felix", "we could also just send it over Slack instead of email, people actually check Slack"),
  seg(9, 38, "Jordan", "yeah that's come up before actually"),
  seg(10, 41, "Riley", "right, people live in Slack all day, email is kind of an afterthought for a lot of folks"),
  seg(11, 47, "Jordan", "yeah I think there's something there honestly, but that's a whole integration, that's not a this-month thing"),
  seg(12, 54, "Felix", "yeah no for sure, that's like a whole project"),
  seg(13, 57, "Jordan", "let's shelve that for now, next quarter at the earliest, if we even do it"),
  seg(14, 63, "Felix", "makes sense"),
  seg(15, 65, "Sana", "what if we went even further though, like what if there was an AI generated summary of everything that happened, like a little paragraph instead of a list of bullet points"),
  seg(16, 74, "Jordan", "hm, like an actual written summary"),
  seg(17, 77, "Sana", "yeah like 'this week your team closed three things and there's two blockers you should look at', that kind of thing"),
  seg(18, 85, "Riley", "I mean that's basically a whole dashboard at that point"),
  seg(19, 89, "Felix", "yeah that's a lot though, like an AI generated analytics dashboard is a pretty big lift"),
  seg(20, 95, "Jordan", "it is, and I don't know if people actually want prose, versus just wanting the facts fast"),
  seg(21, 101, "Riley", "yeah I feel like I personally just want the three bullet points, not a paragraph"),
  seg(22, 106, "Sana", "fair, I just think it would look cool"),
  seg(23, 109, "Jordan", "ha, it would look cool, I'm just not sure it's the right investment right now"),
  seg(24, 114, "Felix", "yeah I don't think any of us are saying we should actually build that"),
  seg(25, 119, "Jordan", "right, just a fun idea, let's keep it in the back pocket"),
  seg(26, 123, "Riley", "okay separately, what about just the visual design of the thing, like regardless of channel"),
  seg(27, 128, "Jordan", "yeah go for it"),
  seg(28, 130, "Riley", "I think the current layout is just kind of a wall of text, there's no hierarchy"),
  seg(29, 135, "Sana", "yeah it does kind of all look the same weight"),
  seg(30, 139, "Riley", "right, so I'm picturing maybe two different directions, one that's more like a card-based thing, one that's more like a simple ranked list, top things first"),
  seg(31, 149, "Jordan", "could you mock both of those up, like actual options we could look at"),
  seg(32, 154, "Riley", "yeah I can do that, I'll put together both directions for the review"),
  seg(33, 160, "Jordan", "perfect, that's exactly what I wanted"),
  seg(34, 163, "Sana", "going back to the trends thing for a second, what if we just showed like a little graph of activity over time, not the whole AI summary thing, just like, a line going up or down"),
  seg(35, 174, "Jordan", "oh that's simpler, I like that more honestly"),
  seg(36, 178, "Felix", "yeah a graph is a lot more believable than a paragraph"),
  seg(37, 182, "Sana", "I could probably just throw together a rough version of that, see if it's even feasible before we talk about actually shipping it anywhere"),
  seg(38, 190, "Jordan", "yeah do that, just a rough prototype, we don't need it production ready or anything"),
  seg(39, 196, "Sana", "yeah exactly, just enough to see if the data even supports it"),
  seg(40, 201, "Jordan", "great"),
  seg(41, 203, "Felix", "can I throw out kind of a wild one"),
  seg(42, 206, "Jordan", "go for it"),
  seg(43, 207, "Felix", "what if the digest could talk, like a voice summary you listen to on your commute"),
  seg(44, 213, "Riley", "ha, that's a lot"),
  seg(45, 215, "Felix", "yeah I'm mostly kidding, but like, imagine you're driving and it just reads you the week"),
  seg(46, 221, "Jordan", "I mean never say never but that's extremely not where we are right now"),
  seg(47, 227, "Felix", "yeah totally agree, just thinking out loud"),
  seg(48, 230, "Jordan", "honestly though, here's a scenario I keep picturing, like imagine a user logs in Monday morning and everything that happened last week is just sitting there sorted by project, no digging required, that's kind of the dream"),
  seg(49, 242, "Riley", "yeah that's a nice picture of where this could go eventually"),
  seg(50, 246, "Sana", "totally, that's not like, a today thing though"),
  seg(51, 250, "Jordan", "no definitely not, just painting the picture of why we care about any of this"),
  seg(52, 256, "Felix", "makes sense"),
  seg(53, 258, "Jordan", "okay, so, before we wrap, I'm curious if the Slack delivery thing is actually worth pursuing or if it's just a nice idea"),
  seg(54, 266, "Felix", "I mean, I could just turn it on informally for my own team for like a week, see if they actually look at it more than the email version"),
  seg(55, 275, "Jordan", "oh yeah, do that, that's a cheap way to get a real signal before we commit to building anything"),
  seg(56, 283, "Felix", "yeah I'll just set that up for my team this week and see what happens"),
  seg(57, 289, "Jordan", "perfect, that's actually really useful, way better than us just guessing"),
  seg(58, 295, "Sana", "yeah agreed"),
  seg(59, 297, "Riley", "I kind of want to know the result of that before I even finalize the mocks honestly"),
  seg(60, 303, "Jordan", "yeah fair, but let's not block on it, mocks can happen in parallel"),
  seg(61, 309, "Riley", "yeah no that's fine, I'll just do both directions regardless"),
  seg(62, 314, "Jordan", "okay I think that's a good session, lots of stuff to chew on"),
  seg(63, 319, "Felix", "yeah this was fun"),
  seg(64, 321, "Sana", "agreed, I'll go start poking at the graph thing"),
  seg(65, 326, "Jordan", "awesome, thanks everyone")
];
