---
status: accepted
date: 2026-11-27
area: [mobile]
supersedes: []
superseded-by: null
---

# The document scanner is the one UIKit view controller of the Apple app

## Context

The owner captures a scanned document into the Inbox from the iPhone's Action button, through `AddToInboxIntent`
([[2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk]]). The scan waits in the device's capture
outbox like a text ([[2026-11-27-inbox-captures-wait-in-a-device-outbox-that-outlives-the-session]]).

The system's document scanner, which finds the page's edges, straightens it and takes several pages, is
`VNDocumentCameraViewController` of VisionKit, a UIKit view controller. SwiftUI has no view for it. The Apple app is one
SwiftUI codebase without UIKit or AppKit ([[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]]); its UIKit so far
is views, gestures and windows that SwiftUI lacks (the calendar's drag and pinch, the Semp layer, the volume hold),
each in one small iOS-only file, and no presented UIKit view controller. Taking a photo inside the app was left open
until SwiftUI offers a camera view without UIKit ([[2026-11-16-photos-are-picked-with-the-swiftui-photos-picker]]).

The Shortcuts dialog cannot show a camera, so the intent must bring the app to the foreground and show the scanner in a
scene, while the run that asked for it may be ended by the system before the person finishes.

Rejected:

- A camera of our own (`AVFoundation` with Vision's rectangle detection), as the wake guard reads codes. It would
  rebuild the system scanner's edge detection, perspective correction, page review and multi-page flow, worse.
- Leaving the scan to another app (Files, Notes) and sharing its PDF to Semprec. It needs a share extension, a second
  process the outbox does not coordinate, and several steps from the Action button.

## Decision

- **The one exception.** One `UIViewControllerRepresentable`, `DocumentScanner` in
  `mobile/apple/Projects/App/Sources/Intents/DocumentScanner.swift`, wraps `VNDocumentCameraViewController`. The file
  is wrapped whole in `#if os(iOS)`, reaches UIKit through `import SwiftUI` (no `import UIKit`), and is the only file
  that imports `VisionKit`, which is added to `apple.systemModules`. No other UIKit view controller is presented by
  the app; another one needs its own decision.
- **iOS only.** VisionKit has no document scanner on macOS, so the intent's content choice (`InboxContent`) offers
  only a text there, and the macOS app has no scanner. On an iOS device without the scanner
  (`VNDocumentCameraViewController.isSupported` is false, as on the simulator) the intent answers that it is not
  available, before it opens the app.
- **Who shows it.** The intent continues in the foreground (`continueInForeground`) and asks a process-wide
  `ScanPresenter` for a scan, then waits for its outcome. Each scene observes the presenter (`ScanPresentation` on
  `AppScene`); the first active scene that claims a request shows the scanner full screen, so one window shows it. A
  new request ends a waiting one as cancelled and takes its place, so a request whose window went away does not block
  later ones.
- **The app writes the capture.** When the person finishes, the presenter makes the pages one PDF with PDFKit (each page
  from its image, JPEG-compressed, one image at a time; the document written once and encoded to Base64 once), named
  `Scan YYYY-MM-DD HH-mm.pdf`, media type `application/pdf`, source camera, and captures it through the CoreKit bridge
  `InboxShortcutCapture` with the type, day, time and text the intent passed. It does so in a task of the app, not of
  the intent's run, so a finished scan is kept even when the run ended first. A cancelled or failed scan captures
  nothing. `PDFKit` is added to `apple.systemModules`.

## Consequences

- The app depends on a UIKit view controller in one file; if SwiftUI gains a document scanner view, that file is the
  one to replace.
- The scanner runs only on a device with a camera. Tests cover the PDF building and the presenter's outcomes on both
  platforms without it; the scanner itself, the foreground transition and the cover are verified only on a device.
- The camera permission's text covers the document scanner as well as the wake guard's codes.
- The scanner's error is not kept (the app has no logger); the intent answers that the scan could not be saved.
- A scan finished after the system ended the intent's run is kept, but nobody is told; the person sees it reach the
  Inbox.
