Check the files this pull request touches under any `review-rules/`
directory — `context.md`, `rules.md`, `severity.md`, `scope.md` and
`tasks/*.md`. They are the specification the review bot enforces, so a change
here changes what every later pull request is held to. Report nothing for
files outside a `review-rules/` directory.

1. A rule or task item deleted, or weakened — made narrower, made
   conditional, or moved to a lower severity — without the linked issue's
   `## Task` calling for it — high. Quote the removed or old wording. A
   weakened rule is indistinguishable from an accident unless the pull request
   says why.
2. A `scope.md` change that drops files out of review: an `# Include` pattern
   removed or narrowed, or an `# Exclude` pattern added, so that files matched
   today would no longer be — high. Name a tracked file that loses coverage.
   Remember the bot's matching: a file belongs to the platform whose directory
   is the longest prefix of its path, and patterns are matched relative to
   that directory, with `**` meaning "any characters, including `/`" and `*`
   meaning "any characters except `/`".
3. A `scope.md` pattern that cannot match what it evidently intends — high:
   it is a silent coverage gap. Two shapes recur: `dir/*.md` meant to cover
   `dir/sub/notes.md`, where the single `*` never crosses a `/`; and
   `dir/**/*.md` meant to cover `dir/notes.md`, where the bot compiles `**/`
   to `.*/`, which still requires a `/` after `dir/`. Judge a pattern by the
   bot's matcher, not by `.github/scripts/check-review-scope.mjs`, which lets
   `**/` match no directory at all.
4. A platform left with no `tasks/*.md` file while its `scope.md` still
   includes files — high. The bot refuses to report a clean review when no
   task ran, so every pull request matching that platform fails its
   `code-review` check.
5. A rule, task item or severity level that contradicts another one in the
   same platform's `review-rules/`, or an ADR under `docs/adr/` — medium: a
   reviewer handed both sides cannot tell which applies, so the same change
   can be judged differently from one run to the next. Name both sides.
6. A checkable claim about this repository that is wrong — a path, file,
   script, command, job name or convention that does not exist or does not
   behave as stated — medium: reviewers and implementers act on it as fact,
   so a wrong claim produces wrong findings and wrong fixes. Verify it
   against the repository.
7. A rule added with no statement of why it exists — low. A severity that
   disagrees with the platform's `severity.md` is a contradiction under item 5.
