import AppIntents

/// The App Shortcuts of the app, which the Shortcuts app lists and the Action button runs without the person composing
/// anything (Settings › Action Button › Shortcut › Alldots).
struct AlldotsShortcuts: AppShortcutsProvider {

    // MARK: - Shared
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddToInboxIntent(),
            phrases: [
                "Add to \(.applicationName) Inbox",
                "Add to Inbox in \(.applicationName)",
                "Capture in \(.applicationName)"
            ],
            shortTitle: "intent.addToInbox.title",
            systemImageName: "tray.and.arrow.down"
        )
    }
}
