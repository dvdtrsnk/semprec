Check the agent-facing instruction documents this pull request touches —
`.bb/AGENTS.md`, `.bb/skills/**`, `.claude/skills/**`, and the root
`README.md`. These are read by every agent working in this repository, so a
wrong sentence here is executed rather than merely misread.

1. An instruction that contradicts another instruction file, or an ADR under
   `docs/adr/` — high severity. Name both sides. An agent handed two
   conflicting rules picks one silently.
2. A factual claim about this repository that is checkable and wrong: a path,
   a filename, a command, a script name, a skill name, a test-tier suffix, a
   directory that does not exist. High severity — these are followed
   literally. Verify each one against the repository rather than assuming.
3. A skill or rules file that restates an existing ADR's rationale at length
   instead of linking to it by slug — low. The ADR is the source of truth for
   "why"; a second copy drifts.
4. An instruction that is ambiguous about what an agent must actually do —
   two readings that lead to materially different work — medium. Say which
   readings you found.
5. A rule added with no statement of why it exists — medium. A rule whose
   reason is not recorded is one a later agent cannot tell from an accident,
   and will eventually "clean up".
6. An instruction that widens what an agent may do without saying who
   approves it (writing state directly, merging, force-pushing, deleting,
   sending anything outside this repository) — high severity.
7. A document that has visibly drifted from what this pull request changes
   elsewhere in the files this platform can see — for example a README
   section describing a convention this pull request just replaced. Medium.
