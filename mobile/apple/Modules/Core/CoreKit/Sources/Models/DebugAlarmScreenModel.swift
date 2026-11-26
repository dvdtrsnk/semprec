import Foundation

/// What the person decided about the app ringing system alarms; `unsupported` on a device that has none.
public enum DebugAlarmAuthorization: Equatable, Sendable {

    case notDetermined
    case denied
    case authorized
    case unsupported
}

/// Where an alarm of the device is: waiting for its moment, or ringing now.
public enum DebugAlarmPhase: Equatable, Sendable {

    case scheduled
    case alerting
}

/// What an alarm of the app is: a plain one, or a wake mission with watch alarms that a scanned code stops.
public enum DebugAlarmKind: Equatable, Sendable {

    case alarm
    case mission
}

/// Whose alarm it is: the sleep plan's, the debug tool's, or one the app does not know.
public enum DebugAlarmSource: Equatable, Sendable {

    case sleepPlan
    case debug
    case unknown
}

/// Why the debug tool did not do what the person asked.
public enum DebugAlarmFailure: Equatable, Sendable {

    case notAuthorized
    case limitReached
    case unsupported
    case deviceFailed
    case readFailed
    case noCodes
    case inThePast
}

/// How long from now a test alarm rings.
public enum DebugAlarmDelay: Equatable, Sendable {

    case tenSeconds
    case oneMinute
    case fiveMinutes
}

/// Whether an alarm at a chosen time rings once or on every one of the next days.
public enum DebugAlarmRepeat: Equatable, Sendable {

    case once
    case daily
}

/// An alarm or mission the app holds. `ringAt` is nil for an alarm nothing tells the moment of; `phase` is nil for a
/// mission whose own alarm the device no longer holds.
public struct DebugAlarmRow: Equatable, Sendable, Identifiable {

    public var id: String
    public var kind: DebugAlarmKind
    public var source: DebugAlarmSource
    public var ringAt: Date?
    public var phase: DebugAlarmPhase?
    public var codeCount: Int
    public var watchCount: Int

    public init(
        id: String,
        kind: DebugAlarmKind = .alarm,
        source: DebugAlarmSource = .debug,
        ringAt: Date? = nil,
        phase: DebugAlarmPhase? = .scheduled,
        codeCount: Int = 0,
        watchCount: Int = 0
    ) {
        self.id = id
        self.kind = kind
        self.source = source
        self.ringAt = ringAt
        self.phase = phase
        self.codeCount = codeCount
        self.watchCount = watchCount
    }
}

/// The debug alarm tool. `alarms` come soonest first; `codeCount` is how many codes the wake settings hold for a
/// mission, `dailyDays` how many days a daily alarm rings, `busy` that an action has not finished.
public struct DebugAlarmState: Equatable, Sendable {

    public var authorization: DebugAlarmAuthorization
    public var alarms: [DebugAlarmRow]
    public var codeCount: Int
    public var dailyDays: Int
    public var busy: Bool
    public var failure: DebugAlarmFailure?

    public init(
        authorization: DebugAlarmAuthorization = .authorized,
        alarms: [DebugAlarmRow] = [],
        codeCount: Int = 0,
        dailyDays: Int = 7,
        busy: Bool = false,
        failure: DebugAlarmFailure? = nil
    ) {
        self.authorization = authorization
        self.alarms = alarms
        self.codeCount = codeCount
        self.dailyDays = dailyDays
        self.busy = busy
        self.failure = failure
    }
}

public enum DebugAlarmAction: Equatable, Sendable {

    case refresh
    case requestAuthorization
    /// Rings `delay` from now; with `withCodes` as a wake mission that the codes of the wake settings stop.
    case ringIn(DebugAlarmDelay, withCodes: Bool)
    /// Rings at `date`, or with `.daily` every day at its time of day on the device's clock.
    case ringAt(Date, repeat: DebugAlarmRepeat, withCodes: Bool)
    case cancel(String)
    case cancelAll
    case dismissFailure
}

public typealias DebugAlarmScreenModel = ScreenModel<DebugAlarmState, DebugAlarmAction, Never>

/// Debug alarm screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedDebugAlarmScreenModel = ScriptedScreenModel<DebugAlarmState, DebugAlarmAction, Never>
