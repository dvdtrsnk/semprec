import AppIntents
import CoreKit
import Foundation

/// Writes a text down, or on iOS keeps a scanned document, into the Inbox, as the Action button runs it through
/// `SemprecShortcuts`: it asks for the type, then for the content when they are not set. A text is asked for and kept
/// without opening the app. A scan brings the app to the foreground, which shows the system document scanner
/// (`ScanPresenter`); the scanned pages are kept as one PDF. Either capture is kept on the device with the day and the
/// current time of this device, gets a few seconds to reach the server, and waits in the device's outbox until it
/// does, also without a connection
/// (docs/adr/2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk.md); while it waits, the
/// background tasks that send it are scheduled (`CaptureSending`).
struct AddToInboxIntent: AppIntent {

    // MARK: - Shared
    static let title: LocalizedStringResource = "intent.addToInbox.title"
    static let description = IntentDescription("intent.addToInbox.description")
    /// A text runs in the background; a scan continues in the foreground, where the scanner can be shown.
    static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]
    /// The capture reads the person's session and writes what they typed on the device, so the device must be
    /// unlocked.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    /// How long the run waits for the capture to reach the server before it answers; the sending goes on after it.
    private static let sendingWait: Duration = .seconds(3)

    // MARK: - Parameters
    @Parameter(title: "intent.addToInbox.type")
    var type: InboxTypeEntity?

    @Parameter(title: "intent.addToInbox.content")
    var content: InboxContent?

    /// The text of a text capture; with a scan, kept beside the document when it is set, and not asked for.
    @Parameter(title: "intent.addToInbox.text", inputOptions: String.IntentInputOptions(multiline: true))
    var text: String?

    /// The day of the capture; today when it is not set.
    @Parameter(title: "intent.addToInbox.day")
    var day: Date?

    // MARK: - Methods
    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let capture = InboxShortcutCapture.shared
        guard capture.isSignedIn else { return .result(dialog: "intent.addToInbox.signIn") }
        let type: InboxTypeEntity
        if let chosen = self.type {
            type = chosen
        } else {
            type = try await $type.requestValue("intent.addToInbox.type.request")
        }
        let dialog: IntentDialog
        switch try await chosenContent() {
        case .text:
            dialog = try await captureText(capture, type: type)
        #if os(iOS)
        case .scan:
            dialog = try await captureScan(capture, type: type)
        #endif
        }
        return .result(dialog: dialog)
    }

    // MARK: - Private
    /// The content set or asked for; on macOS, where a text is the only content, it is not asked for.
    @MainActor
    private func chosenContent() async throws -> InboxContent {
        if let content { return content }
        guard InboxContent.allCases.count > 1 else { return .text }
        return try await $content.requestValue("intent.addToInbox.content.request")
    }

    @MainActor
    private func captureText(_ capture: InboxShortcutCapture, type: InboxTypeEntity) async throws -> IntentDialog {
        let text: String
        if let written = self.text {
            text = written
        } else {
            text = try await $text.requestValue("intent.addToInbox.text.request")
        }
        let now = Date.now
        let failure = await capture.capture(
            text: text,
            day: IsoDay.string(from: day ?? now),
            time: ClockTime.string(from: now),
            typeId: type.typeId,
            file: nil
        )
        guard let failure else {
            await Self.sendBriefly(capture)
            await CaptureSending.shared.captureAdded()
            return "intent.addToInbox.saved"
        }
        switch failure.kind {
        case .invalidData:
            throw $text.needsValueError("intent.addToInbox.text.empty")
        case .unauthorized:
            return "intent.addToInbox.signIn"
        case .unavailable, .notFound, .rejected, nil:
            return "intent.addToInbox.failed"
        }
    }

    #if os(iOS)
    /// Brings the app to the foreground and waits for the scanner's outcome. The presenter writes the capture itself,
    /// and schedules its background sending, so a scan the person finishes is kept even when the system ends this run
    /// before it answers.
    @MainActor
    private func captureScan(_ capture: InboxShortcutCapture, type: InboxTypeEntity) async throws -> IntentDialog {
        guard DocumentScanner.isSupported else { return "intent.addToInbox.scan.unavailable" }
        try await continueInForeground(alwaysConfirm: false)
        let request = ScanPresenter.Request(typeId: type.typeId, text: text ?? "", day: day)
        switch await ScanPresenter.shared.scan(request) {
        case .saved:
            await Self.sendBriefly(capture)
            return "intent.addToInbox.scan.saved"
        case .cancelled:
            return "intent.addToInbox.scan.cancelled"
        case .failed(let failure):
            return failure.kind == .unauthorized ? "intent.addToInbox.signIn" : "intent.addToInbox.scan.failed"
        }
    }
    #endif

    /// Waits for `capture.send()` at most `sendingWait`, so a slow connection does not hold the answer back; cancelling
    /// the wait leaves the sending running.
    @MainActor
    private static func sendBriefly(_ capture: InboxShortcutCapture) async {
        let sending = Task { @MainActor in _ = await capture.send() }
        let deadline = Task {
            try? await Task.sleep(for: sendingWait)
            sending.cancel()
        }
        await sending.value
        deadline.cancel()
    }
}
