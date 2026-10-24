- **critical** — data loss, a security vulnerability (a secret, credential or
  signing key in a committed file; a Gradle wrapper or distribution whose
  checksum check is removed or no longer matches Gradle's published value), a
  `!!`, unchecked cast or `error()` that untrusted input can reach, or a change
  that silently corrupts persisted state.
- **high** — a bug that breaks the feature the issue asked for in either app; a
  forbidden module edge or a platform-only API in `commonMain`; a shared
  ViewModel that imports UI or navigation API, holds a router, or does work
  that survives `close()`; cancellation turned into an error state; a stale
  result that can overwrite newer state; an exported API change that leaves a
  CoreKit bridge or an Android consumer broken or wrong; a verify or
  architecture-check step that can report success without having checked; or a
  violation of the issue's own "Out of scope"; a `review-rules/` rule or task
  weakened or dropped without the Task asking for it, a scope pattern that
  drops or cannot match the files it intends, or a platform left with no task.
- **medium** — a bug confined to an edge case; new ViewModel, use-case or
  architecture-check behavior without a test; text a user reads in shared code;
  a domain, data or factory type newly reachable from the exported framework;
  a `!!` or unchecked cast in test code; an effect emitted off the main thread;
  an unexplained `@Suppress` or a relaxed detekt rule; an inconsistency with an
  established pattern elsewhere in `mobile/`; contradicting or factually wrong
  `review-rules/` content.
- **low** — style, naming, a comment that would help, a small missed
  simplification.

Critical, high and medium all block the merge (`REVIEW_BLOCK_SEVERITY: medium`
in `.github/workflows/code-review.yml`); low does not.
