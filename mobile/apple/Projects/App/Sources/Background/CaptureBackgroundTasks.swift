#if os(iOS)
import BackgroundTasks
import Foundation

/// The two background tasks that send the Inbox captures waiting in the device's outbox while the app is not running
/// (docs/adr/2026-11-27-apple-app-sends-waiting-inbox-captures-from-background-tasks.md): a processing task that runs
/// once the device has a network, and an app refresh the system runs when it sees fit. Neither time is guaranteed.
/// Both run the same send through the CoreKit bridge, end when it returns or when the system expires them (which
/// cancels the send), and are scheduled again while captures wait. iOS only: macOS has no `BGTaskScheduler` for apps.
@MainActor
final class CaptureBackgroundTasks {

    // MARK: - Identifiers
    /// The processing task, which needs a network connection. Listed in `BGTaskSchedulerPermittedIdentifiers`.
    static let sendIdentifier = "cz.semprec.app.inboxCaptures.send"
    /// The app refresh task. Listed in `BGTaskSchedulerPermittedIdentifiers`.
    static let refreshIdentifier = "cz.semprec.app.inboxCaptures.refresh"

    /// The system's scheduler, where the requests go in production.
    nonisolated static var systemScheduler: any CaptureTaskScheduler { BGTaskScheduler.shared }

    // MARK: - Dependencies
    private let scheduler: any CaptureTaskScheduler
    private let captures: any WaitingCaptures

    // MARK: - Init
    /// Over `captures`, the bridge of the process in production.
    init(scheduler: any CaptureTaskScheduler, captures: any WaitingCaptures) {
        self.scheduler = scheduler
        self.captures = captures
    }

    // MARK: - Methods
    /// Registers the launch handlers of both tasks with the system's scheduler. The system requires it before the app
    /// finishes launching, so the app delegate calls it from `application(_:didFinishLaunchingWithOptions:)`; the
    /// handlers run on the main queue.
    func register() {
        for identifier in [Self.sendIdentifier, Self.refreshIdentifier] {
            let handler: @Sendable (BGTask) -> Void = { [weak self] task in
                // The system calls the handler on the main queue (`using: .main`) and never touches the task from
                // another thread before it, so handing it to the main actor shares it with nobody.
                nonisolated(unsafe) let task = task
                MainActor.assumeIsolated { _ = self?.run(task) }
            }
            BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main, launchHandler: handler)
        }
    }

    /// Schedules both tasks when a capture of the person signed in waits; nothing when none does.
    func scheduleIfWaiting() async {
        guard await captures.capturesWait() else { return }
        schedule()
    }

    /// Runs `task`: sends the captures that wait through the bridge, then completes it with success when none is left,
    /// or schedules both tasks again and completes it without success when some still wait (no network, a server
    /// that did not answer). When the system expires the task first, the send is cancelled, both tasks are scheduled
    /// again, because the send did not finish, and the task completes without success. It completes exactly once;
    /// the returned task is the send, which tests await.
    @discardableResult
    func run(_ task: any CaptureBackgroundTask) -> Task<Void, Never> {
        let completion = Completion(task)
        let captures = self.captures
        let sending = Task { @MainActor in
            let waits = if await captures.send() { false } else { await captures.capturesWait() }
            // An expired task was scheduled again and completed by its expiration handler.
            guard !Task.isCancelled else { return }
            if waits { self.schedule() }
            completion.complete(success: !waits)
        }
        task.expirationHandler = { @Sendable in
            sending.cancel()
            Task { @MainActor in
                self.schedule()
                completion.complete(success: false)
            }
        }
        return sending
    }

    // MARK: - Private
    /// Submits both requests; a request with the same identifier that has not run yet is replaced. The processing
    /// task waits for a network; neither sets an earliest date, so the system picks the time.
    private func schedule() {
        let send = BGProcessingTaskRequest(identifier: Self.sendIdentifier)
        send.requiresNetworkConnectivity = true
        submit(send)
        submit(BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier))
    }

    /// Submits one request. A refusal (background refresh turned off, too many requests, a simulator without the
    /// scheduler) loses no capture: it keeps waiting in the outbox, the app sends it when it becomes active, and the
    /// next capture or move to the background schedules again. The app has no logger, so the refusal is not kept; the
    /// other request is still submitted.
    private func submit(_ request: BGTaskRequest) {
        do {
            try scheduler.submit(request)
        } catch {
            return
        }
    }
}

// MARK: - Completion
/// Completes a background task once: the first of the send and the expiration handler to finish completes it, and
/// every later call does nothing.
@MainActor
private final class Completion {

    // MARK: - Dependencies
    private var task: (any CaptureBackgroundTask)?

    // MARK: - Init
    init(_ task: any CaptureBackgroundTask) {
        self.task = task
    }

    // MARK: - Methods
    func complete(success: Bool) {
        guard let task else { return }
        self.task = nil
        task.setTaskCompleted(success: success)
    }
}
#endif
