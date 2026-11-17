Check the repository scripts this pull request touches under
`.github/scripts/`. These are zero-dependency Node ES modules that workflows
and agents run against the live repository: they read GitHub state, decide
what to write, and write issues, comments and labels. A script that misreads
a failure as an empty result, or writes when it was told not to, changes the
repository for real with nobody watching. Report nothing for files outside
`.github/scripts/`.

1. A GitHub or other API call whose failure — a non-2xx response, a GraphQL
   `errors` array, a truncated listing or tree, a page that is not the
   expected shape — is treated as an empty or successful result — high. A
   half-read repository must never look like an empty one: a script that
   concludes "nothing to do" or "nothing exists" from a failed read acts on a
   state that is not there.
2. A script with a dry-run mode that performs any write while in dry-run —
   high. Dry-run is how a change to the script is tried safely; a write that
   escapes it lands on the real repository during the one run that was
   promised to have no effect.
3. A token or other secret written to stdout, stderr, a job summary, or an
   issue or comment body — high. Workflow logs, job summaries and issue
   bodies are readable far beyond the job that produced them, and a leaked
   token is usable until someone notices and rotates it.
4. Data from outside the repository's own code — an API response, an issue
   or comment body, a decoded payload, a CLI argument, a file another process
   or an agent wrote — used without being validated where it is read —
   medium. This is repository rule 6 in `.bb/AGENTS.md`: an unchecked shape
   works until the producer changes, and then fails somewhere far from the
   read that should have caught it.
5. A sequence of writes whose header comment claims it is safe to re-run,
   but which a crash between two of its writes would leave in a state a
   re-run duplicates or loses — medium. A re-run is exactly what follows a
   crash, so a claim that does not hold across the gap between writes
   produces duplicate issues or silently dropped work on the run meant to
   recover.
6. New decision logic (a function that decides what gets written, skipped or
   reported) added without a `node:test` test in a sibling `*.test.mjs` file
   that covers each of its branches — medium. These scripts have no other
   safety net: an untested branch is first exercised against the live
   repository.
7. A header comment or doc comment that states inputs, environment variables
   or behavior the code contradicts — medium. The header is how a workflow
   author or an agent learns how to call the script; a wrong one gets it
   called wrongly.
