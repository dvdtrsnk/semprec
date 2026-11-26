#if os(iOS)
import AppIntents

/// The second button of a wake mission's alert: it opens the app, where the guard asks for a code. The system runs it
/// in the app's process when the person taps the button; opening the app is all it does, because the guard of each
/// window covers it as soon as it sees the mission ring.
struct OpenWakeGuardIntent: LiveActivityIntent {

    static let title: LocalizedStringResource = "alarm.scan"
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}
#endif
