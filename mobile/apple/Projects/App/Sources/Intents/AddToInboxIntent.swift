import AppIntents
import CoreKit
import Foundation

/// Writes a text into the Inbox, or hands a scan to `ScanIntoInboxIntent`, as the Action button runs it through
/// `SemprecShortcuts`. It asks for the type when it is not set, from a list that starts with "Scan" where the device
/// can scan. A type or "No type" asks for the text and keeps it without opening the app, on the device with the day
/// and the current time of this device; it gets a few seconds to reach the server, waits in the device's outbox until
/// it does, also without a connection, and while it waits the background tasks that send it are scheduled
/// (`CaptureSending`). "Scan" answers with `ScanIntoInboxIntent`, which the system then runs with the app open.
struct AddToInboxIntent: AppIntent {

    // MARK: - Shared
    static let title: LocalizedStringResource = "intent.addToInbox.title"
    static let description = IntentDescription("intent.addToInbox.description")
    /// Background only, so Shortcuts shows no "Open When Run" choice: a text never opens the app, and a scan opens it
    /// through the intent this one answers with.
    static let supportedModes: IntentModes = .background
    /// The capture reads the person's session and writes what they typed on the device, so the device must be
    /// unlocked.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    /// How long a run waits for the capture to reach the server before it answers; the sending goes on after it.
    private static let sendingWait: Duration = .seconds(3)

    // MARK: - Parameters
    @Parameter(title: "intent.addToInbox.type")
    var type: InboxTypeEntity?

    /// The text of a text capture; not asked for a scan.
    @Parameter(title: "intent.addToInbox.text", inputOptions: String.IntentInputOptions(multiline: true))
    var text: String?

    /// The day of the capture; today when it is not set.
    @Parameter(title: "intent.addToInbox.day")
    var day: Date?

    // MARK: - Methods
    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & OpensIntent {
        let capture = InboxShortcutCapture.shared
        guard capture.isSignedIn else { return .result(dialog: "intent.addToInbox.signIn") }
        let type: InboxTypeEntity
        if let chosen = self.type {
            type = chosen
        } else {
            type = try await $type.requestValue("intent.addToInbox.type.request")
        }
        if let scan = Self.scanIntent(for: type, day: day) {
            return .result(opensIntent: scan, dialog: "intent.addToInbox.scan.opening")
        }
        return .result(dialog: try await captureText(capture, type: type))
    }

    /// The intent this run answers with for `type`: `ScanIntoInboxIntent` on `day` for "Scan", none for a text.
    static func scanIntent(for type: InboxTypeEntity, day: Date?) -> ScanIntoInboxIntent? {
        guard type.kind == .scan else { return nil }
        var scan = ScanIntoInboxIntent()
        scan.day = day
        return scan
    }

    /// Waits for `capture.send()` at most `sendingWait`, so a slow connection does not hold the answer back. Cancelling
    /// the wait leaves the sending running, because adding the capture started the outbox's round, which waits for it
    /// too.
    @MainActor
    static func sendBriefly(_ capture: InboxShortcutCapture) async {
        let sending = Task { @MainActor in _ = await capture.send() }
        let deadline = Task {
            try? await Task.sleep(for: sendingWait)
            sending.cancel()
        }
        await sending.value
        deadline.cancel()
    }

    // MARK: - Private
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
}
