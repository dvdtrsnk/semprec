import CoreKit
import Foundation

/// When the app sends the Inbox captures that wait in the device's outbox outside the windows' own triggers
/// (docs/adr/2026-11-27-apple-app-sends-waiting-inbox-captures-from-background-tasks.md): when it becomes active it
/// sends them through the CoreKit bridge, and on iOS, after a capture was added and when it moves to the background
/// while captures wait, it schedules the background tasks of `CaptureBackgroundTasks`. macOS has no `BGTaskScheduler`
/// for apps, so there only becoming active sends.
///
/// It is one per process, as the outbox is: the app delegate registers its tasks at launch, `SemprecApp` reports the
/// app's phase, and the intent, the scanner and the diary report a capture they added. Each call makes its own bridge
/// (`makeCaptures`) and releases it afterwards.
@MainActor
final class CaptureSending {

    // MARK: - Shared
    static let shared = CaptureSending()

    // MARK: - Dependencies
    private let makeCaptures: @MainActor () -> any WaitingCaptures
    #if os(iOS)
    /// The two background tasks that send the captures while the app is not running.
    let backgroundTasks: CaptureBackgroundTasks
    #endif

    // MARK: - Init
    #if os(iOS)
    /// Over the bridge of the intents and the system's scheduler by default; tests pass their own.
    init(
        makeCaptures: @escaping @MainActor () -> any WaitingCaptures = { InboxShortcutCapture() },
        scheduler: any CaptureTaskScheduler = CaptureBackgroundTasks.systemScheduler
    ) {
        self.makeCaptures = makeCaptures
        backgroundTasks = CaptureBackgroundTasks(scheduler: scheduler, makeCaptures: makeCaptures)
    }
    #else
    /// Over the bridge of the intents by default; tests pass their own.
    init(makeCaptures: @escaping @MainActor () -> any WaitingCaptures = { InboxShortcutCapture() }) {
        self.makeCaptures = makeCaptures
    }
    #endif

    // MARK: - Methods
    /// The app became active: sends the captures that wait now. A window's own triggers send them too; this one also
    /// covers a process whose windows started before the captures were added.
    func appBecameActive() async {
        _ = await makeCaptures().send()
    }

    /// The app moved to the background: on iOS, schedules both background tasks when captures wait.
    func appMovedToBackground() async {
        #if os(iOS)
        await backgroundTasks.scheduleIfWaiting()
        #endif
    }

    /// A capture was added to the outbox (by the intent, the scanner or the diary): on iOS, schedules both background
    /// tasks when captures still wait.
    func captureAdded() async {
        #if os(iOS)
        await backgroundTasks.scheduleIfWaiting()
        #endif
    }
}
