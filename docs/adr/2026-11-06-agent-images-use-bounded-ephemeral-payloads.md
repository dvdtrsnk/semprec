---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Bound ephemeral agent images at decode and the final gateway payload

## Context

Gh1752 requires actual resizing, fresh and continued image turns, ref-only persistence and a gateway request strictly below its existing 4 MiB limit. Agents has no declared image library; a transitive canvas import is not a supported dependency. Installed pi 0.85.1 exposes prompt(string, images) and pi-messages onPayload immediately before JSON.stringify/fetch. Its generic image transformer consults model.input, but pi-messages serializes context directly. An image-only byte budget cannot bound a request also containing tools, system prompt, history and options.

## Decision

Declare exactly sharp 0.34.5 as an agents production dependency, updating only its importer and required dependency/optional platform lock graph under pinned pnpm9.12.0. No unrelated upgrades, provider dependency, postinstall policy change or host image tools. The dedicated refImage.ts helper owns ephemeral decode/resize. Load through the already scoped tenant metadata and blob roots; cap source reads at 16 MiB, reject before decode when oversized or unsupported, and close owned streams. Accept raster JPEG/PNG/WebP/GIF by actual byte signature and decoded metadata; unsupported formats, including SVG/PDF, become the existing unavailable-image placeholder, without invoking an external renderer. Use only the first frame, strict corrupt-input refusal and a 32,000,000 input-pixel limit. Never disable libvips safety checks. These bounds rely on decoder/header behavior and are not a universal native-memory sandbox.

Resize without enlargement to at most 1600 pixels on the longest side, preserving orientation, to one JPEG at fixed quality75. Retain only output at most 256 KiB; oversize/corrupt/failed/cancelled output becomes a placeholder rather than unbounded retries. Use a five-second sharp processing timeout, remembering that its documented clock starts when libvips opens input and excludes libuv queue wait. Do not claim an absolute five-second wall deadline. Bound concurrent helper calls within a turn; do not abandon owned asynchronous decoding with an unobserved race. Cancellation stops new work and settles/destroys owned pipelines. No persistent resized copy, database write, image bytes or raw provider content in logs/events/tasks.

Extend existing local AgentSession options/send with optional ephemeral image inputs; no new parallel session port. piAgentSession passes them to the installed prompt overload on fresh and continuing turns while yielding the original task and refs only for persistence. Replay reconstructs temporary images from persisted refs; model input declares text and image. Keep the model-only date/text prefix and unrelated tool/session behavior.

At modelComposition's existing onPayload boundary, measure the exact UTF-8 JSON body after any existing caller payload callback. Work on the outgoing ephemeral payload, not stored events or the session's original history. Replace oldest image blocks first with fixed text placeholders, then newer ones only if needed, measuring again. Leave tool results, tool-call pairing, unrelated text and system/options structure unchanged except image-to-placeholder substitution. If no further images can be removed and the full payload is still not strictly below 4*1024*1024 bytes, refuse before network with a fixed safe failure. Never truncate unrelated prompts/tools or claim successful delivery for that refusal. Keep the gateway's independent cap and accounting/auth path unchanged. Test the actual serialized body, not estimates of base64 alone.

## Evidence and alternatives

Use real decoder-generated fixtures for dimensions, output size, corrupt/unsupported/overpixel/overbyte inputs and finite cancellation/failure cleanup. Test fresh and continuing prompts through the installed adapter, ten-image replay and complete serialized gateway payload with system/tools/options, oldest-first placeholders and non-image-only refusal with no fetch. Inspect actual run/task/events for absence of binary/expanded data. Real gateway accepts permitted image blocks with only provider transport injected; no live provider-quality claim.

Rejected: transitive native imports, raw bytes described as resized, host-specific utilities, permanent derivatives, text truncation or relying solely on model.input. Sharp limits are documented in https://sharp.pixelplumbing.com/api-constructor/ and https://sharp.pixelplumbing.com/api-output/ ; the pinned release is https://sharp.pixelplumbing.com/changelog/v0.34.5/ . Those documents establish API options, not successful local decoder execution, which still needs tests.
