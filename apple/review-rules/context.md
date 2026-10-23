This is the `apple/` platform of the Semprec monorepo (the other platforms,
`backend/` and `web/`, have their own review-rules and are reviewed
independently). `apple/` is a single shared Swift codebase for the Semprec
iOS and macOS app — one app, both platforms, not two separate projects.

The codebase is currently an empty scaffold. These rules apply from the
first real implementation PR onward; until then no Swift file here matches the
scope below, and this platform reviews only changes to its own
`review-rules/`.

Work is tracked as a strictly sequential queue of GitHub issues, each fully
self-contained (context, requirements, explicit scope boundaries). A pull
request is expected to close exactly one such issue and implement only what
it describes.

This platform also reviews changes to its own `review-rules/` directory — the
rules, tasks, severities and scope enforced here — through
`tasks/review-rules.md`, which reports nothing for a pull request that does not
touch them.
