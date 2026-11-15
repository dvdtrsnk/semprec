---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# A blob writer consumes its source from the tick it is called

## Context

`BlobStorageWriter.writeStream` is the one write path for every blob (`mail/blobStorage.ts`). Its production implementation, `LocalFsBlobStorageWriter`, used to begin with `await mkdir(dirname(path), { recursive: true })` and only afterwards call `pipeline(source, hasher, createWriteStream(path))`, the first thing that reads the source. For the duration of that `mkdir`, a libuv threadpool job that is slow whenever the pool or the disk is busy, the source was unread and had no `error` listener. Two losses followed from that one ordering:

- A child process's output is lost. `streamFfmpegToStorage` in `semprec-transcribe` spawns `ffmpeg` and in the same tick hands `child.stdout` to `writeStream`. When `ffmpeg` exits while the `mkdir` is pending (a normalized recording of a few seconds is a few kilobytes, smaller than the pipe), Node drains the stdio streams nobody reads and the bytes are dropped. The writer then attached to an ended, empty stream and stored 0 bytes. `normalizeAudio` returned `byteSize: 0` without an error, `probeNormalizedDuration` failed with `MediaToolError`, and `classifyTranscriptionFailure` reported `mediaUnreadable`.
- A source error is uncaught. A source that fails while the `mkdir` is pending (`sempSpeechHandler.ts` destroys its `Readable` with an error when the request is aborted; an upload request body can fail the same way) emits `error` with no listener. The process gets an `uncaughtException`, although `writeStream` also rejects with that error afterwards.

The header comment of the interface already says that "memory-safe" is a structural property of the writer and not something each call site has to get right. No ADR or review rule says when a writer must start reading its source, and the future object-storage writer will need an await of its own (credentials, a multipart upload) before its first byte. Bare `.pipe()` stays excluded for the reason the interface comment gives (#65, truncation under backpressure): the source is attached with `pipeline()`.

## Decision

Every `BlobStorageWriter.writeStream` implementation attaches to the source and observes its errors before its first `await`. Any later or slower preparation (a directory, credentials, a multipart upload) runs behind a bounded buffer, or after the pipeline is attached. A caller may therefore hand over a producer that blocks on a full pipe or that can fail, without having read it first. When the preparation or the write fails, the writer destroys the source, removes the partial bytes and rejects with the first error, unchanged.

`LocalFsBlobStorageWriter` follows it as follows:

1. It builds the size-counting and hashing `Transform` and a `PassThrough` named `staged`, and starts `intake = pipeline(source, hasher, staged)` before the `mkdir`. The default high-water marks bound what `staged` and `hasher` buffer while the directory is created, so a producer such as `ffmpeg` blocks on a full pipe instead of exiting. `intake` is marked as observed; its outcome reaches the caller through `staged`.
2. Inside the `try`: `await mkdir`, then `await pipeline(staged, createWriteStream(path))`, then `await intake`.
3. In the `catch`: `staged.destroy(err)` with the caught error (wrapped in an `Error` when it is not one). `intake` then destroys the source and the hasher with that same error when the `mkdir` or the file write failed. A bare `staged.destroy()` would destroy the source with `ERR_STREAM_PREMATURE_CLOSE`, and a caller that observes its own source (`TenantExportArchive` races `finished(output)` against the write) would report that instead of the storage error. The writer then waits for `intake` to settle without letting its rejection replace the error, removes the partial bytes through `delete` (a failed cleanup is logged and never replaces the error) and rethrows the first error. The identity of the source's error, of `MaxBytesExceededError` and of the `mkdir` error is kept.

## Evidence

- The loss was reproduced with the writer's `mkdir` delayed by a gate: a child that writes 8192 bytes to stdout and exits, handed to `writeStream` while the `mkdir` waits for the child's `close`, stored `byteSize` 0 instead of 8192; `normalizeAudio` of a short sine wave with the `mkdir` delayed by 1.5 s stored an empty file. The repair of the hosted-CI flake measured 10843 bytes on an idle threadpool and 0 bytes with the threadpool saturated by 24 `pbkdf2` jobs.
- `mail/__tests__/blobStorageStreamAttach.unit.test.ts` holds the `mkdir` behind a gate the test controls (no sleep, no load) and proves the 8192 bytes, the `error` listener and flowing state of the source while the gate is closed, the source's own error, the `mkdir` error with the source destroyed by that same error, `MaxBytesExceededError`, and a multi-megabyte source stored completely with the right hash when the directory is created late. `services/semprec-transcribe/src/mediaNormalizationSlowStorage.test.ts` proves the same through `normalizeAudio`.
- Every producer a writer can be handed was checked: `streamFfmpegToStorage` (a child's stdout, exposed to the loss), `ingestUploadedFile` and `ingestUploadedBlob` (the HTTP request body, paused until read, exposed to the error window), `sempSpeechHandler.ts` (a `Readable.from` destroyed on abort, exposed to the error window), `mail/attachments.ts`, `library/libraryCoverStorage.ts` and the archive of `tenancy/tenantExportJob.ts`. `LocalFsBlobStorageWriter` is the only implementation outside tests, so one fix in the writer removes every exposure and no caller changes.

## Alternatives and consequences

Rejected:

- `mkdirSync`: it blocks the event loop on every upload and is the same call a slow disk makes slow.
- Creating the directory at startup: a key's directory is `<tenantId>/...` and is created on demand.
- Buffering the whole source in memory: unbounded, against the header of the file.
- `source.pipe(new PassThrough())`: no error propagation, and the #65 truncation under backpressure.
- A guard in each caller (a `PassThrough` between `ffmpeg` and the writer): it leaves the contract unwritten, leaves the HTTP and speech callers exposed to the error window, and every future caller and the future object-storage writer would have to repeat it.

Consequences:

- While the writer prepares, up to the high-water marks of its intake chain are buffered per write: the writable and readable sides of the hashing `Transform` and of the staging `PassThrough`, about 256 KiB at the 64 KiB default of Node 22 and later, on top of the source's own buffer.
- A future object-storage writer follows the same rule, and a test double that stands in for a writer reads its source in the tick it is called.
- A wrapper that waits before it delegates to a real writer models a slow caller, not a writer, and must not hold a producer that can exit while it waits. Two existing test wrappers do wait (`gatedStorage` in `filesAttachOnUpload.test.ts`, whose producer is an HTTP request body that stays paused, and `ObservedStorage.beforeWrite` in `inboxAttachmentMetadata.test.ts`, whose producer is `ffmpeg` output); they are left to a follow-up.
