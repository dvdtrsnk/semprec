import Combine
import CoreKit
import DesignSystem
import Foundation
import PDFKit

/// Shows the system document scanner for `ScanIntoInboxIntent` and keeps what it scanned: the intent asks for a scan,
/// one scene of the app shows the scanner full screen (`ScanPresentation`), and the scanner's outcome comes back here.
/// The presenter itself writes a finished scan to the device's capture outbox, without a type and without a text, in a
/// task of the app rather than of the intent's run, so the capture is kept even when the system ends that run first,
/// and reports it (`captured`), which schedules its background sending, before the intent hears that it was saved.
///
/// It is one per process, because the system runs the intent outside any scene; a request is shown by the first
/// active scene that claims it, so only one window shows the scanner.
@MainActor
final class ScanPresenter: ObservableObject {

    // MARK: - Types
    /// A scan the intent asks for, kept on `day` (nil for the day the scan is finished on).
    struct Request: Equatable, Sendable {
        let id = UUID()
        let day: Date?
    }

    /// How a scan ended: kept on the device, cancelled with nothing kept, or not kept for `Failed`.
    enum Outcome: Equatable, Sendable {
        case saved
        case cancelled
        case failed(Failed)
    }

    /// Keeps a capture of a file on a day (`yyyy-MM-dd`) at a time (`HH:mm`), without a type and a text; nil once kept.
    typealias Capture = @MainActor (_ day: String, _ time: String, _ file: InboxShortcutCapture.File) async -> Failed?

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
    /// written to the outbox; once it is kept `captured` is called, and then the outcome is `.saved`. No page counts
    /// as cancelled.
    func finish(pages: [PDFPage]) {
        guard let request else { return }
        guard !pages.isEmpty else {
            end(with: .cancelled)
            return
        }
        let date = now()
        guard let scan = ScanDocument.file(pages: pages, scannedAt: date) else {
            end(with: .failed(Failed(kind: nil)))
            return
        }
        let file = InboxShortcutCapture.File(
            filename: scan.filename,
            mimeType: scan.mimeType,
            base64: scan.base64,
            source: .camera
        )
        guard let waiting = take() else { return }
        let capture = capture
        let captured = captured
        Task { @MainActor in
            let failure = await capture(IsoDay.string(from: request.day ?? date), ClockTime.string(from: date), file)
            // Reported before the intent hears of it, so the background sending is scheduled before its brief send.
            if failure == nil { await captured() }
            waiting.resume(returning: failure.map(Outcome.failed) ?? .saved)
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
    private static func inbox(day: String, time: String, file: InboxShortcutCapture.File) async -> Failed? {
        await InboxShortcutCapture.shared.capture(text: "", day: day, time: time, typeId: nil, file: file)
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
