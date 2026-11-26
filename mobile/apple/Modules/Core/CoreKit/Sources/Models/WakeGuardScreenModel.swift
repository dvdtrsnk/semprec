import Foundation

/// What the guard covers the window with: nothing, the camera waiting for a code, or the taps.
public enum WakeGuardPhase: Equatable, Sendable {

    case idle
    case scanning
    case tapping
}

/// Which kind of alarm rings, which the app words its title from.
public enum WakeTitleKind: Equatable, Sendable {

    case sleepAlarm
}

/// The guard of one window. `requiredTaps` and `fallbackDelayMinutes` are the rules' numbers for the copy;
/// `fallbackOpensAt` is when the person may tap instead of scanning, and `fallbackOpen` says it may now.
public struct WakeGuardState: Equatable, Sendable {

    public var phase: WakeGuardPhase
    public var tapsLeft: Int
    public var requiredTaps: Int
    public var fallbackDelayMinutes: Int
    public var fallbackOpensAt: Date?
    public var fallbackOpen: Bool
    public var codeCount: Int
    public var titleKind: WakeTitleKind

    public init(
        phase: WakeGuardPhase = .idle,
        tapsLeft: Int = 200,
        requiredTaps: Int = 200,
        fallbackDelayMinutes: Int = 10,
        fallbackOpensAt: Date? = nil,
        fallbackOpen: Bool = false,
        codeCount: Int = 0,
        titleKind: WakeTitleKind = .sleepAlarm
    ) {
        self.phase = phase
        self.tapsLeft = tapsLeft
        self.requiredTaps = requiredTaps
        self.fallbackDelayMinutes = fallbackDelayMinutes
        self.fallbackOpensAt = fallbackOpensAt
        self.fallbackOpen = fallbackOpen
        self.codeCount = codeCount
        self.titleKind = titleKind
    }
}

public enum WakeGuardAction: Equatable, Sendable {

    /// The camera read this code.
    case codeScanned(String)
    case tap
    case openTapFallback
    case backToScanning
}

public enum WakeGuardEffect: Equatable, Sendable {

    /// The code read is none of the mission's.
    case codeRejected
    /// A code or the last tap stopped the mission.
    case finished
}

public typealias WakeGuardScreenModel = ScreenModel<WakeGuardState, WakeGuardAction, WakeGuardEffect>

/// Wake guard screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedWakeGuardScreenModel = ScriptedScreenModel<WakeGuardState, WakeGuardAction, WakeGuardEffect>
