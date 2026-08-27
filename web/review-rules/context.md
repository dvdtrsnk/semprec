This is the `web/` platform of the Semprec monorepo (the other platforms,
`backend/` and `apple/`, have their own review-rules and are reviewed
independently). `web/` is the Semprec web frontend.

The codebase is currently an empty scaffold — no framework has been chosen
yet. These rules apply from the first real implementation PR onward; until
then no file here matches the scope below and this platform is effectively
inactive. Revisit `scope.md` once a framework is picked (its build output
and generated-file conventions will need their own excludes).

Work is tracked as a strictly sequential queue of GitHub issues, each fully
self-contained (context, requirements, explicit scope boundaries). A pull
request is expected to close exactly one such issue and implement only what
it describes.
