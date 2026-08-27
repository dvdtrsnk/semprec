# Semprec

Implementace backendu Semprecu — pnpm workspace monorepo (`packages/` jádro,
`modules/` vertikální řezy, `services/` procesy), podle rozhodnutí zapsaných v
plánovací specifikaci (`backend.html`, repo `LifeOS/vize/`, lokální, bez remote).

## Zdroj zadání

Tenhle repo se **neřídí přímo `backend.html`**. Každý kus práce má svůj vlastní,
plně samostatný GitHub Issue — kontext, zadání i scope jsou vypsané přímo v issue,
bez nutnosti sahat do plánovacího repozitáře. Issues se berou v pořadí podle čísla
(`[N/21]` v názvu), sekvenčně, jeden po druhém.

## Struktura

- `packages/` — sdílené jádro: `data`, `module-registry`, `agent-runtime`, `queue`,
  `realtime`, `credentials`, `shared`.
- `modules/` — vertikální řezy (Emails, Semprec, později Books/Films) — vznikají
  postupně podle fronty issues.
- `services/` — samostatné procesy (`semprec-api`, `semprec-agents`,
  `semprec-mailsync`, `semprec-transcribe`, `semprec-ai-gateway`) — vznikají
  postupně podle fronty issues.

## Stack

Node LTS, TypeScript, pnpm workspace, Postgres (+ Prisma), `graphile-worker`.
