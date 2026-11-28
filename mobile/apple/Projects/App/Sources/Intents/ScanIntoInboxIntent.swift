import AppIntents
import CoreKit
import DesignSystem
import Foundation

/// Scans a document into the Inbox: the system runs it with the app open when `AddToInboxIntent` answers with it for
/// "Scan". It shows the system document scanner through `ScanPresenter`, which keeps the scanned pages as one PDF
/// without a type and without a text, on `day` or the day the scan is finished, and schedules its background sending;
/// it answers whether the scan was saved. It is not offered on its own in Shortcuts.
struct ScanIntoInboxIntent: AppIntent {

    // MARK: - Shared
    static let title: LocalizedStringResource = "intent.scanIntoInbox.title"
    static let isDiscoverable = false
    /// Foreground only: the scanner needs the app on screen, and no choice is left to the person.
    static let supportedModes: IntentModes = .foreground(.immediate)
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    // MARK: - Parameters
    /// The day of the capture; the day the scan is finished on when it is not set.
    @Parameter(title: "intent.addToInbox.day")
    var day: Date?

    // MARK: - Methods
    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        // Without a scanner no scene would ever show one, and the run would wait for good.
        guard ScanDocument.isScannerSupported else { return .result(dialog: "intent.addToInbox.scan.unavailable") }
        switch await ScanPresenter.shared.scan(ScanPresenter.Request(day: day)) {
        case .saved:
            await AddToInboxIntent.sendBriefly(InboxShortcutCapture.shared)
            return .result(dialog: "intent.addToInbox.scan.saved")
        case .cancelled:
            return .result(dialog: "intent.addToInbox.scan.cancelled")
        case .failed(let failure):
            return .result(
                dialog: failure.kind == .unauthorized ? "intent.addToInbox.signIn" : "intent.addToInbox.scan.failed"
            )
        }
    }
}
