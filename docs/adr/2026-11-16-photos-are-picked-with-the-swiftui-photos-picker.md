---
status: accepted
date: 2026-11-16
area: [mobile]
supersedes: []
superseded-by: null
---

# Photos are picked with the SwiftUI photos picker

## Context

The diary's Inbox capture of the design attaches "a photo or a file" to what the person writes down
(`POST /api/inbox/items` with blobs from `POST /api/blobs`). Files come through `fileImporter`, which SwiftUI has
built in, but the photo library is reached only through `PhotosPicker`, which lives in the `PhotosUI` module.
`apple.systemModules` in `mobile/scripts/architecture-policy.json` lists the system modules the Apple targets may
import, and `PhotosUI` was not one of them. A camera capture would need UIKit's image picker, which the app does not
use (one SwiftUI codebase, no UIKit or AppKit).

## Decision

- `PhotosUI` is an allowed system module. The app uses it only for the SwiftUI `PhotosPicker` and its
  `PhotosPickerItem`, whose bytes the feature hands to the shared ViewModel as it does with a picked file.
- No camera capture: a photo is picked from the library, or taken with the system camera into the library first.

## Consequences

- A feature that picks photos uses the same picker and keeps the bytes out of the shared state, as the capture row
  does.
- Taking a photo inside the app stays open until SwiftUI offers a camera view without UIKit.
