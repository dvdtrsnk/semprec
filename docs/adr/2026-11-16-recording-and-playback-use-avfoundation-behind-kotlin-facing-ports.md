---
status: accepted
date: 2026-11-16
area: [mobile]
supersedes: []
superseded-by: null
---

# Recording and playback use AVFoundation behind ports that Kotlin owns

## Context

The mobile design records meetings and voice notes (Recordings, the event page) and plays a recording back next to its
transcript. Both need the device microphone and speaker, which only the platform's audio framework reaches. The apps
may import only the system modules the policy lists (`apple.systemModules`), and the decisions about a recording (when
to ask for the microphone, which phases a take goes through, what a failed upload leaves behind, retry and discard,
which segment is being spoken) are screen logic that lives in the shared ViewModels
(`2026-10-24-kotlin-multiplatform-below-native-mobile-ui`). Tests of that logic must not need a microphone.

The server takes a recording as one raw `POST /api/recordings` (audio or video body, `X-Filename`, `X-Event-Id`,
`X-Recorded-At`), transcribes it by itself and serves the audio back from `GET /api/blobs/:id` with the bearer token
and range requests. Live voice mode and on-device dictation (`2026-10-28-dictation-on-device-and-read-aloud-through-the-gateway`)
are not part of this decision.

## Decision

- `AVFoundation` is added to `apple.systemModules`. It is imported only by two small adapters in CoreKit,
  `DeviceAudioRecorder` (an `AVAudioRecorder` writing AAC into the temporary folder, metering for the waveform) and
  `DeviceAudioPlayer` (an `AVPlayer` streaming the blob with the `Authorization` header), and by the one helper that
  prepares the iOS audio session. No other module imports it.
- The adapters implement the Kotlin interfaces `AudioRecorder` and `AudioPlayer` of `:shared:core`. The interfaces have
  no suspending function and no flow, only calls and one callback each, so that a Swift class can implement them and a
  test can script them. `HomeSDK` takes the two adapters as optional constructor arguments (the defaults have neither,
  so every existing test and preview keeps working).
- The state machine is the Kotlin `RecorderViewModel` (idle, recording, paused, saving, uploading, failed; retry keeps
  the file on the device until it is uploaded or discarded; leaving the screen with the microphone open ends the take
  and drops it). Playback state (playing, position, speed, active segment) is the Kotlin `TranscriptViewModel`, which
  the adapter reports back to through `PlayerListener`.
- The recording file is read in Kotlin (`readRecordedFile`, an `expect`/`actual` per platform), so the bytes never cross
  the Swift boundary element by element, and sent through `AuthenticatedApi.upload`, whose request timeout is ten
  minutes instead of thirty seconds. The player is given the URL and the header value instead of bytes, so the audio
  streams and seeks without being held in memory.
- The app's Info.plist gets `NSMicrophoneUsageDescription` (English, Czech in `InfoPlist.xcstrings`) and the `audio`
  background mode, so a take goes on when the screen locks; the macOS sandbox gets the audio-input and the user-selected
  read-only file entitlements (the latter for importing a file).
- The only platform conditional is `AudioSessionConfiguration`: iOS has one shared audio session that must be set to
  record or to play, macOS has none. The microphone permission uses `AVAudioApplication`, which both platforms have.

## Consequences

- A recording of an hour (about 30 MB at 64 kbit/s) is held in memory once while it uploads. A streaming upload from
  the file would need a body type the client does not have; it is a decision for when recordings are longer.
- Android implements the same two interfaces with its own framework when it gets these screens; nothing in the shared
  layer changes.
- The two adapters, the permission prompt and the real microphone are the parts no test here exercises; they are
  checked by running the app on a device.
