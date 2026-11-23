import Foundation

/// What a signed-in scene tells of the changes it has not brought to the server: whether it is offline, how many
/// changes wait to be sent, and how many the server refused since they were dismissed.
public struct SyncStatusState: Equatable, Sendable {

    public let offline: Bool
    public let waiting: Int
    public let failed: Int

    public init(offline: Bool, waiting: Int, failed: Int) {
        self.offline = offline
        self.waiting = waiting
        self.failed = failed
    }
}

public enum SyncStatusAction: Equatable, Sendable {

    /// The person saw the refused changes; they are forgotten until another one is refused.
    case dismissFailures
}

/// The sync status screen model raises no effects.
public typealias SyncStatusScreenModel = ScreenModel<SyncStatusState, SyncStatusAction, Never>

/// Sync status screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSyncStatusScreenModel = ScriptedScreenModel<SyncStatusState, SyncStatusAction, Never>
