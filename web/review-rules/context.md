This is the `web/` platform of the Semprec monorepo (the other platforms,
`backend/` and `apple/`, have their own review-rules and are reviewed
independently). `web/` is the Semprec web frontend.

The stack is React + TypeScript on Vite, with Vitest/Testing Library for
unit tests and pnpm as the package manager (issue #96 picked it, building
the first view renderer). Vite's build output lands in `dist/`, which
`scope.md` excludes along with the usual generated files.

Work is tracked as a strictly sequential queue of GitHub issues, each fully
self-contained (context, requirements, explicit scope boundaries). A pull
request is expected to close exactly one such issue and implement only what
it describes.
