import AppIntents
import CoreKit
import Foundation

/// Writes a text down into the Inbox without opening the app, as the Action button runs it through `SemprecShortcuts`:
/// it asks for the type and the text when they are not set, keeps the capture on the device with the day and the
/// current time of this device, and gives it a few seconds to reach the server. The capture waits in the device's
/// outbox until it does, also without a connection
/// (docs/adr/2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk.md).
struct AddToInboxIntent: AppIntent {

    // MARK: - Shared
    static let title: LocalizedStringResource = "intent.addToInbox.title"
    static let description = IntentDescription("intent.addToInbox.description")
    static let supportedModes: IntentModes = .background
    /// The capture reads the person's session and writes what they typed on the device, so the device must be
    /// unlocked.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    /// How long the run waits for the capture to reach the server before it answers; the sending goes on after it.
    private static let sendingWait: Duration = .seconds(3)

    // MARK: - Parameters
    @Parameter(title: "intent.addToInbox.type")
    var type: InboxTypeEntity?

    @Parameter(title: "intent.addToInbox.text", inputOptions: String.IntentInputOptions(multiline: true))
    var text: String?

    /// The day of the capture; today when it is not set.
    @Parameter(title: "intent.addToInbox.day")
    var day: Date?

    // MARK: - Methods
    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let capture = InboxShortcutCapture()
        guard capture.isSignedIn else { return .result(dialog: "intent.addToInbox.signIn") }
        let type: InboxTypeEntity
        if let chosen = self.type {
            type = chosen
        } else {
            type = try await $type.requestValue("intent.addToInbox.type.request")
        }
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
            typeId: type.typeId
        )
        guard let failure else {
            await Self.sendBriefly(capture)
            return .result(dialog: "intent.addToInbox.saved")
        }
        switch failure.kind {
        case .invalidData:
            throw $text.needsValueError("intent.addToInbox.text.empty")
        case .unauthorized:
            return .result(dialog: "intent.addToInbox.signIn")
        case .unavailable, .notFound, .rejected, nil:
            return .result(dialog: "intent.addToInbox.failed")
        }
    }

    // MARK: - Private
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
