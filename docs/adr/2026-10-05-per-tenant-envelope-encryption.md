---
status: accepted
date: 2026-10-05
area: [backend]
supersedes: []
superseded-by: null
---

# Third-party secrets are sealed under a per-tenant data key wrapped by the master key

## Context

Every third-party secret a user connects lives in `external_credentials` and is encrypted with
libsodium `crypto_secretbox_easy` directly under the deployment master key `CREDENTIALS_MASTER_KEY`.
With several tenants ([[2026-10-03-tenant-isolation-through-row-level-security]]) this has two
weaknesses. The ciphertext carries no associated data, so one copied onto another row, of another
item or another user, decrypts there. And one key protects everyone, so deleting a user cannot make
their secrets unrecoverable from backups while the master key exists.

## Decision

Each tenant gets a random 32-byte data key (DEK), stored in the tenant-owned table `tenant_keys`
wrapped under the master key with XChaCha20-Poly1305 (IETF AEAD). `master_key_version` records which
master key version wrapped it, so a later rotation can tell old rows from new.

Associated data binds every ciphertext to its owner:

- the wrap uses `semprec:tenant-key:v1:<tenantId>` (UTF-8, `tenantId` the lowercase canonical UUID
  text), so a key row copied to another tenant does not unwrap;
- credentials will be sealed under the DEK with associated data `tenant_id‖item_id`.

The credential rollout is ordered so that a one-release rollback always finds readable data:

1. a release that reads both schemes ships first;
2. only after that release runs in production do new writes switch to the DEK;
3. then existing rows are re-encrypted;
4. then the master-key-only scheme is retired.

Deleting a tenant's `tenant_keys` row is the crypto-shred for account deletion: every credential
sealed under that key becomes unrecoverable. `tenant_keys` has no `UPDATE` grant (rewriting a row
would orphan everything sealed under it) and no `ON DELETE CASCADE` (the key is deleted
deliberately). It is kept out of the 12-month backup and gets its own 7-day backup, so shredding is
complete within 7 days even for someone holding the master key and an old dump.

## Consequences

- A stolen or misplaced ciphertext is useless outside its tenant and item.
- Account deletion can make secrets unrecoverable without touching backups of the main dump.
- Credential reads and writes need the tenant key, resolved through the key store.
- The separate key backup is an operational obligation: losing it loses every tenant's secrets.

## Alternatives considered

- **Master key plus associated data only.** Fixes cross-row copying but offers no shredding: the
  master key opens every backup.
- **DEKs inside the main dump.** Shredding is defeated for the 12 months the dump is kept.
- **A key per credential.** More keys to store, wrap and back up, with no isolation gain over one
  key per tenant.
