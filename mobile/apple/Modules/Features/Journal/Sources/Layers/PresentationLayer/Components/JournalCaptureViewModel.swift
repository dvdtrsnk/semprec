import Combine
import CoreKit
import DesignSystem
import Foundation
import PDFKit

/// Thin adapter between the capture row of the diary's Inbox and its shared screen model: republishes the state and
/// forwards intents. A capture that went through bumps `captured`, so the row clears its text and the diary shows the
/// day again, and is reported to the app through `onCaptured`.
@MainActor
final class JournalCaptureViewModel: ObservableObject {

    // MARK: - Dependencies
    private let model: any InboxCaptureScreenModel
    /// The app's hook for a capture that went through, which schedules its sending while the app is not running.
    private let onCaptured: @MainActor () -> Void

    // MARK: - Published Properties
    @Published private(set) var state: InboxCaptureState
    /// How many captures went through; the row and the diary react to each change.
    @Published private(set) var captured = 0

    // MARK: - Init
    init(model: any InboxCaptureScreenModel, onCaptured: @escaping @MainActor () -> Void) {
        self.model = model
        self.onCaptured = onCaptured
        state = model.state
    }

    // MARK: - Methods
    /// Applies shared state and effects until the screen's task is cancelled.
    func observe() async {
        await model.observe(
            onState: { [weak self] in self?.state = $0 },
            onEffect: { [weak self] effect in
                switch effect {
                case .captured:
                    self?.captured += 1
                    self?.onCaptured()
                }
            }
        )
    }

    func loadTypes() {
        model.send(.loadTypes)
    }

    func pickType(_ typeId: String?) {
        model.send(.pickType(typeId))
    }

    func attach(_ file: CaptureFile, source: InboxCaptureSource) {
        model.send(.attach(filename: file.filename, mimeType: file.mimeType, base64: file.base64, source: source))
    }

    /// Attaches the scanned `pages` as one PDF named for `date`, from the camera, as a picked file is attached; false
    /// when the PDF could not be made, with nothing attached.
    func attachScan(_ pages: [PDFPage], scannedAt date: Date) -> Bool {
        guard let scan = ScanDocument.file(pages: pages, scannedAt: date) else { return false }
        attach(CaptureFile(filename: scan.filename, mimeType: scan.mimeType, base64: scan.base64), source: .camera)
        return true
    }

    func removeAttachment() {
        model.send(.removeAttachment)
    }

    func submit(text: String, day: String, time: String) {
        model.send(.submit(text: text, day: day, time: time))
    }

    func dismissFailure() {
        model.send(.dismissFailure)
    }
}
