---
name: fix-review-findings
description: "How to address code-review-bot findings on a Semprec pull request - verify the bot's claim, check it against the issue's Task, Acceptance criteria and Out of scope, fix the whole class of defect rather than the one instance, add the test that proves the fix, and reply only after the fix is committed. Load this BEFORE changing code in response to a review, whether in a Relay fix-review-findings run or by hand. Triggers on: review findings, review:changes-requested, an inline review thread, a review summary comment, FINAL_DECISION: blocked, a fix round, a Relay fix prompt, and any instruction to address, resolve or reply to review comments."
---

# Fixing review findings

A fix round is where defects are most often *introduced*, not only removed.
Findings re-opened after a fix, and the longest blocked loops on this repository
(four rounds on one pull request), came from the same few habits:

- applying a finding literally against the issue,
- fixing one instance and leaving its siblings,
- patching one interleaving per round,
- folding unrelated changes in.

The triage verdicts themselves — fix it, fix a cheap low, reply to a wrong one —
are in `.bb/AGENTS.md` (`## Review findings`). This skill is how you carry them
out.

Load the topic skills for the files each finding touches, the same way
`implement-issue` §2 tells you to for an implementation. A finding about a
`catch` needs `error-handling`, a finding about a test needs `testing`, and so on.

## 1. Verify the claim before accepting it

Check what the finding asserts against the repository. Look at the schema
constraint it assumes, the grep it implies ("nothing else imports this"), the
code it says is missing, and whether the code is pre-existing or moved verbatim.
Most rejected findings were the bot not checking one of these.

Why: a fix agent that accepts a false claim writes code, or worse a rule, that
encodes it. Then the next reviewer has two wrong things to undo.

## 2. Check it against the issue before applying it

Read the finding next to the issue's `## Task`, `## Acceptance criteria` and
`### Out of scope`.

- If the finding asks for something the Task forbids or assigns to a later
  issue, do not change the code. Reply on the thread and quote the issue line.
- If applying it would break an Acceptance criterion, look for a fix that
  satisfies both. If there is none, reply with the conflict, or end with
  `Relay-Step-Status: blocked` when a human has to decide.

Why: the issue is the law here (`.bb/AGENTS.md`, `## The issue is the law`).
Review fixes that contradicted it were reverted later, every time, at the cost of
another round.

## 3. Fix the class, not the instance

Before editing, list every place that shares the defect:

- the other side of a pair (add/remove, create/delete, lock/unlock);
- the success path and the error path that write the same rows;
- every call site of the same guard;
- the sibling operations on the same resource (a `stat` and the `rm` that
  follows it);
- the parallel copies of the same rule in other platforms' files.

Fix all of them in this round.

Why: the bot reports the first instance it sees. Fixing only that one
guarantees the next round reports the second.

## 4. Enumerate failure points before rewriting async error handling

For a finding about a race or a failure in a multi-step async sequence, do not
patch the interleaving it names. First list every `await` and every step that
commits something irreversible. Then write down the correct state after a
failure at each point, and only then change the code. Use identity checks
(`map.get(key) === entry`) rather than key presence when another task can
replace the entry.

Why: patching one interleaving per round is what produced the four-round loop.

## 5. Every fix brings its proof

- Add a test that fails without the fix (see `testing`).
- Re-read the docstrings, comments, ADR text and PR description that describe
  the code you changed, and make them true again.

Why: an unproven fix is reported again as an untested branch, and a stale
docstring is reported as a false claim.

## 6. Keep the round scoped

Change only what the findings and the pull request's own intent require. A
flake, a bug or a cleanup you notice along the way goes into your final answer
as a proposed follow-up, not into this branch.

Why: unrelated changes in a fix round are themselves reported as scope findings,
and were the most frequently re-opened kind.

## 7. Reply after the fix is committed

Reply "fixed" on a thread only after the commit exists. Check the bytes that
were actually written (an edit tool can rewrite an escape sequence) and name the
commit and the test in the reply. Resolve only the threads you addressed. A
rejection reply gives the concrete reason: the issue line, the schema constraint
or the code path that shows the finding does not hold.

## Before ending the round, check

- [ ] Every finding was checked against the repository and against the issue.
- [ ] Every sibling of each fixed instance was fixed too.
- [ ] Every fix has a test that fails without it.
- [ ] Docstrings, comments and ADR text near each fix still describe the code.
- [ ] No change outside the findings and the pull request's intent.
- [ ] Every reply names a commit, or the concrete reason the finding is wrong.
