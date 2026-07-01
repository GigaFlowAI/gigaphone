---
description: Own a PR all the way to a clean merge — loop addressing CI failures and reviewer comments until it is actually merged.
argument-hint: "[PR number] (defaults to the current branch's PR)"
---
You are **owning a pull request through to merge**. The task is NOT done when CI goes green or
when you *could* merge — it is done only when the PR is **MERGED** with all review feedback
addressed. Treat "merged" as a session goal: do not stop until it holds (or you are genuinely
blocked on a human decision). If a `/goal` is not already active for this, behave as if one is.

PR: **$ARGUMENTS** — if empty, resolve it from the current branch (`gh pr view --json number,url`).

Loop until the PR is merged:

1. **Sync state**: `gh pr view <N> --json state,mergeable,mergeStateStatus,reviewDecision` and
   `gh pr checks <N>`. Also pull review threads: `gh pr view <N> --json reviews,comments` and
   `gh api repos/{owner}/{repo}/pulls/<N>/comments` (inline/review comments).
2. **CI failing** → open the failing check's logs (`gh run view --log-failed`, or the check URL),
   reproduce locally, fix, commit, push. Re-watch CI to completion (background-watch; don't spin).
3. **Unresolved review comments/threads** → address each *actionable* one with a commit; reply to
   the thread explaining what you changed; resolve it. For a comment that is a question or needs a
   decision you can't make, reply asking for clarification and surface it to the user — pause that
   item, keep the rest moving.
4. **Changes requested** → make them, push, and re-request review where appropriate.
5. **Merge** only when: CI green **and** (approved **or** no review required) **and** no open review
   threads **and** `mergeStateStatus` is CLEAN → `gh pr merge <N> --squash --delete-branch`.
6. **While waiting** on CI or a human reviewer, don't idle: background-watch CI to completion, and
   poll for new review activity on a sensible cadence (e.g. `ScheduleWakeup` ~10–20 min, or a
   background `until` poll), re-engaging when anything changes. Keep looping.

Stop early **only** if blocked on a human (a comment you can't resolve without input, or a merge
gate you lack permission for) — say so with `needs input:`. Otherwise: after merging, verify `main`
carries the change and report. Never merge over unaddressed review feedback.
