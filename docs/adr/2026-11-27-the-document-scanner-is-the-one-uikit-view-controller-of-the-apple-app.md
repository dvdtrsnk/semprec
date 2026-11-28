---
status: accepted
date: 2026-11-27
area: [mobile]
supersedes: []
superseded-by: null
---

# The document scanner is the one UIKit view controller of the Apple app

## Context

The owner captures a scanned document into the Inbox from the iPhone's Action button, through the App Shortcut of
`AddToInboxIntent` ([[2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk]]), and attaches one to a
capture in the diary. The scan waits in the device's capture outbox like a text
([[2026-11-27-inbox-captures-wait-in-a-device-outbox-that-outlives-the-session]]).

The system's document scanner, which finds the page's edges, straightens it and takes several pages, is
`VNDocumentCameraViewController` of VisionKit, a UIKit view controller. SwiftUI has no view for it. The Apple app is one
SwiftUI codebase without UIKit or AppKit ([[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]]); its UIKit so far
is views, gestures and windows that SwiftUI lacks (the calendar's drag and pinch, the Semp layer, the volume hold),
each in one small iOS-only file, and no presented UIKit view controller. Taking a photo inside the app was left open
until SwiftUI offers a camera view without UIKit ([[2026-11-16-photos-are-picked-with-the-swiftui-photos-picker]]).

The Shortcuts dialog cannot show a camera, so the scanner must be shown in a scene of the app brought to the
foreground, while the run that asked for it may be ended by the system before the person finishes.

Rejected:

- A camera of our own (`AVFoundation` with Vision's rectangle detection), as the wake guard reads codes. It would
  rebuild the system scanner's edge detection, perspective correction, page review and multi-page flow, worse.
- Leaving the scan to another app (Files, Notes) and sharing its PDF to Semprec. It needs a share extension, a second
  process the outbox does not coordinate, and several steps from the Action button.

## Decision

- **The one exception.** One `UIViewControllerRepresentable`, `DocumentScanner` in DesignSystem
  (`mobile/apple/Modules/Core/DesignSystem/Sources/DocumentScanner.swift`), wraps `VNDocumentCameraViewController`, so
  both the app and a feature can show it. The file is wrapped whole in `#if os(iOS)`, reaches UIKit through
  `import SwiftUI` (no `import UIKit`), and is the only file that imports `VisionKit`, which is added to
  `apple.systemModules`. It reports the scanned pages, a cancel or a failure through closures. No other UIKit view
  controller is presented by the app; another one needs its own decision.
- **One PDF, built once.** `ScanDocument` (DesignSystem) makes the pages one PDF with PDFKit: each page from its image,
  JPEG-compressed, the images loaded one at a time, the document written once and encoded to Base64 once, named
  `Scan YYYY-MM-DD HH-mm.pdf` with media type `application/pdf`. Every scan is kept with source camera. `PDFKit` is
  added to `apple.systemModules`.
- **iOS only.** VisionKit has no document scanner on macOS. `ScanDocument.isScannerSupported` is false there and on an
  iOS device without the scanner (`VNDocumentCameraViewController.isSupported` is false, as on the simulator), and no
  place offers a scan then: the Mac has no scanner.
- **From the Action button.** `AddToInboxIntent` offers "Scan" first in its list of types where the scanner is
  supported and answers it with `ScanIntoInboxIntent`, which the system runs with the app open
  ([[2026-11-28-a-capture-intent-runs-in-the-background-and-opens-the-app-only-through-a-second-intent]]). That intent
  answers that the scanner is not available where it is not supported, and otherwise asks the process-wide
  `ScanPresenter` for a scan and waits for its outcome. Each scene observes the presenter (`ScanPresentation` on
  `AppScene`); the first active scene that claims a request shows the scanner full screen, so one window shows it. A
  new request ends a waiting one as cancelled and takes its place, so a request whose window went away does not block
  later ones.
- **The app writes the capture.** When the person finishes, the presenter captures the PDF through the CoreKit bridge
  `InboxShortcutCapture`, without a type and without a text, on the day the intent passed or the day the scan is
  finished, at the time it is finished. It does so in a task of the app, not of the intent's run, so a finished scan is
  kept even when the run ended first. A cancelled or failed scan captures nothing.
- **In the diary.** The Journal feature's capture row offers Scan document in its attachment menu where the scanner is
  supported, shows it through DesignSystem's `documentScanner(isPresented:onFinish:onFail:)`, and attaches the PDF as
  a picked file is attached.

## Consequences

- The app depends on a UIKit view controller in one file; if SwiftUI gains a document scanner view, that file is the
  one to replace.
- The scanner runs only on a device with a camera. Tests cover the PDF building and the presenter's outcomes on both
  platforms without it; the scanner itself, the foreground transition and the cover are verified only on a device.
- The camera permission's text covers the document scanner as well as the wake guard's codes.
- The scanner's error is not kept (the app has no logger); the intent answers that the scan could not be saved, and
  the diary that the item was not added.
- A scan finished after the system ended the intent's run is kept, but nobody is told; the person sees it reach the
  Inbox.
- A scan from the Action button carries no type and no text; adding either needs its own parameter on
  `ScanIntoInboxIntent`.
