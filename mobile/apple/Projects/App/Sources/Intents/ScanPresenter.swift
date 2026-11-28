import Combine
import CoreKit
import Foundation
import PDFKit

/// Shows the system document scanner for `AddToInboxIntent` and keeps what it scanned: the intent asks for a scan, one
/// scene of the app shows the scanner full screen (`ScanPresentation`), and the scanner's outcome comes back here. The
/// presenter itself writes a finished scan to the device's capture outbox, in a task of the app rather than of the
/// intent's run, so the capture is kept even when the system ends that run first, and then reports it (`captured`),
/// which schedules its background sending while it waits.
///
/// It is one per process, because the system runs the intent outside any scene; a request is shown by the first
/// active scene that claims it, so only one window shows the scanner.
@MainActor
final class ScanPresenter: ObservableObject {

    // MARK: - Types
    /// What the intent asks to capture with the scan: the type id (nil for none), the text kept with it (empty for
    /// none) and the day (nil for the day the scan is finished on).
    struct Request: Equatable, Sendable {
        let id = UUID()
        let typeId: String?
        let text: String
        let day: Date?
    }

    /// How a scan ended: kept on the device, cancelled with nothing kept, or not kept for `Failed`.
    enum Outcome: Equatable, Sendable {
        case saved
        case cancelled
        case failed(Failed)
    }

    /// Keeps a capture of a text on a day (`yyyy-MM-dd`) at a time (`HH:mm`) with a type id and a file; nil once kept.
    typealias Capture = @MainActor (
        _ text: String,
        _ day: String,
        _ time: String,
        _ typeId: String?,
        _ file: InboxShortcutCapture.File
    ) async -> Failed?

    // MARK: - Shared
    static let shared = ScanPresenter()

    // MARK: - Published Properties
    /// The scan asked for and not ended yet.
    @Published private(set) var request: Request?
    /// The scene that shows the scanner for `request`; nil until an active scene claims it.
    @Published private(set) var scene: UUID?

    // MARK: - Dependencies
    private let capture: Capture
    /// Called once a scan's capture is kept.
    private let captured: @MainActor () async -> Void
    private let now: @MainActor () -> Date
    private var waiting: CheckedContinuation<Outcome, Never>?

    // MARK: - Init
    /// Over the capture bridge of the intents and the app's `CaptureSending` by default; tests pass their own
    /// `capture`, `captured` and clock.
    init(
        capture: @escaping Capture = ScanPresenter.inbox,
        captured: @escaping @MainActor () async -> Void = { await CaptureSending.shared.captureAdded() },
        now: @escaping @MainActor () -> Date = { Date.now }
    ) {
        self.capture = capture
        self.captured = captured
        self.now = now
    }

    // MARK: - Methods
    /// Asks a scene to show the scanner for `request` and answers how the scan ended. A scan asked for while another
    /// one waits ends that one as cancelled and takes its place: the person pressed the action again, and a request
    /// whose scene went away (a window closed under the scanner) must not block every later one.
    func scan(_ request: Request) async -> Outcome {
        end(with: .cancelled)
        return await withCheckedContinuation { continuation in
            waiting = continuation
            self.request = request
        }
    }

    /// Lets the active scene `scene` show the scanner, unless another scene already does or nothing is asked for.
    func claim(scene: UUID) {
        guard request != nil, self.scene == nil else { return }
        self.scene = scene
    }

    /// The person finished the scan with `pages`: the scanner closes, the pages become one PDF and the capture is
    /// written to the outbox; the outcome is `.saved` once it is kept, and then `captured` is called. No page counts
    /// as cancelled.
    func finish(pages: [PDFPage]) {
        guard let request else { return }
        guard !pages.isEmpty else {
            end(with: .cancelled)
            return
        }
        let date = now()
        guard let file = ScanDocument.file(pages: pages, scannedAt: date) else {
            end(with: .failed(Failed(kind: nil)))
            return
        }
        guard let waiting = take() else { return }
        let capture = capture
        let captured = captured
        Task { @MainActor in
            let failure = await capture(
                request.text,
                IsoDay.string(from: request.day ?? date),
                ClockTime.string(from: date),
                request.typeId,
                file
            )
            waiting.resume(returning: failure.map(Outcome.failed) ?? .saved)
            if failure == nil { await captured() }
        }
    }

    /// The person cancelled the scan, or the scanner was dismissed without a scan: nothing is captured.
    func cancel() {
        end(with: .cancelled)
    }

    /// The scanner failed (the camera could not be used): nothing is captured. The app has no logger, so the
    /// scanner's error is not kept; the intent answers that the scan could not be saved.
    func fail() {
        end(with: .failed(Failed(kind: nil)))
    }

    // MARK: - Private
    private static func inbox(
        text: String,
        day: String,
        time: String,
        typeId: String?,
        file: InboxShortcutCapture.File
    ) async -> Failed? {
        await InboxShortcutCapture.shared.capture(text: text, day: day, time: time, typeId: typeId, file: file)
    }

    /// Ends the request shown now, if any, and answers its waiting continuation with `outcome`.
    private func end(with outcome: Outcome) {
        take()?.resume(returning: outcome)
    }

    /// Closes the scanner and hands out the continuation of the request that ends.
    private func take() -> CheckedContinuation<Outcome, Never>? {
        let continuation = waiting
        waiting = nil
        request = nil
        scene = nil
        return continuation
    }
}
