#if os(iOS)
import BackgroundTasks

/// A background task the system runs, as `CaptureBackgroundTasks` handles it: it hands the task an expiration handler
/// and completes it once. `BGTask` is the production one; tests pass a double, since the system creates every `BGTask`.
protocol CaptureBackgroundTask: AnyObject {

    /// Called by the system, on a queue of its choice, when the task's time is up.
    var expirationHandler: (() -> Void)? { get set }

    func setTaskCompleted(success: Bool)
}

/// Where `CaptureBackgroundTasks` submits its requests: `BGTaskScheduler` in production, a double in tests.
protocol CaptureTaskScheduler: AnyObject {

    /// Submits `taskRequest`, replacing a request with its identifier that has not run yet.
    func submit(_ taskRequest: BGTaskRequest) throws
}

// MARK: - Protocol conformance
extension BGTask: CaptureBackgroundTask {}

extension BGTaskScheduler: CaptureTaskScheduler {}
#endif
