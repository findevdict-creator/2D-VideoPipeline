---
name: retention-check
description: Review or fix a studio video's script for clicks and watch time. Use when asked why a video has low CTR, low average view duration or few impressions, to check a script's hook, pacing or ending, or to act on numbers from YouTube Studio.
---

# Retention check

The studio's rules for a video people click and keep watching are in
`packages/lib/guides/retention.md`. Read it first. The planner and the scriptwriter follow
it when they write; this skill is for checking what they wrote and for acting on real
numbers afterwards.

## Check a script

Run the check once the scene lists are written, before the scenes are built, because a
change to the script is cheap then:

```
npm run studio -- retention <project>
```

It reads every word of narration against the guide and answers with a verdict, the promise
as a viewer would read it, and findings. Each finding names one place (the opening, the
ending, the title and thumbnail, or a scene such as "2.3 Scene title") and the change to
make. It changes nothing in the project. The same check is the "Will people keep
watching?" card on the Video tab.

Act on findings from the most severe down:

- A finding on the opening, the ending or the order of chapters is a change to the outline
  or to a chapter's scene list. Send it as the review note on that outline or chapter.
- A finding on one scene is a review note on that scene.
- A finding on the title and thumbnail: write the upload details again
  (`npm run studio -- youtube <project> --notes "..."`) or ask for a new thumbnail
  (`npm run studio -- thumbnail <project> --notes "..."`). They are a pair: neither repeats
  a word of the other.

Run the check again after the changes. Stop when the verdict is "ready"; do not chase low
findings.

## Read numbers from YouTube Studio

Pass what the person reports with `--notes`, in their words:

```
npm run studio -- retention <project> --notes "38% still watching at 0:30, drop at 1:10, average view duration 0:52 of 3:20, CTR 2.1% mostly from Browse"
```

How to read them:

- Low impressions with normal CTR and watch time: YouTube has not found the audience yet.
  The script is not the problem. Keep the subject and the packaging consistent across
  videos.
- Low CTR: the title and thumbnail do not open a question for the people being shown the
  video. Half of all channels sit between 2% and 10%, and CTR falls as a video is shown
  more widely, so compare with the channel's own earlier videos, not with a target.
- Good CTR and a low share still watching at 0:30: the opening does not deliver on what the
  title and thumbnail promised. Fix the first sentence or the packaging, whichever is
  wrong about the video.
- A dip at one time: the scene at that time. Viewers skipped or left there.
- A slow slide through the middle: runs of "and then". Look for the missing "but".
- A cliff near the end: the video announced that it was over.

Never raise CTR with a promise the video does not keep. YouTube recommends such videos
less, because viewers leave them early.
