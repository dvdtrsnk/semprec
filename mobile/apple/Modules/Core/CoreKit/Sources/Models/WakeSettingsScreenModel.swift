import Foundation

/// What the wake settings do to a sleep alarm: nothing, ask for a code that none is stored for, or ring until one of
/// the codes is scanned.
public enum WakeMode: Equatable, Sendable {

    case off
    case needsCode
    case active
}

/// Why the wake settings are not what the person asked for.
public enum WakeSettingsFailure: Equatable, Sendable {

    case emptyCode
    case notAuthorized
    case limitReached
    case readFailed
    case deviceFailed
}

public struct WakeSettingsState: Equatable, Sendable {

    public var requiresCode: Bool
    public var codes: [String]
    public var mode: WakeMode
    public var failure: WakeSettingsFailure?

    public init(
        requiresCode: Bool = false,
        codes: [String] = [],
        mode: WakeMode = .off,
        failure: WakeSettingsFailure? = nil
    ) {
        self.requiresCode = requiresCode
        self.codes = codes
        self.mode = mode
        self.failure = failure
    }
}

public enum WakeSettingsAction: Equatable, Sendable {

    case setRequiresCode(Bool)
    case addCode(String)
    case removeCode(String)
    case dismissFailure
}

public typealias WakeSettingsScreenModel = ScreenModel<WakeSettingsState, WakeSettingsAction, Never>

/// Wake settings screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedWakeSettingsScreenModel = ScriptedScreenModel<WakeSettingsState, WakeSettingsAction, Never>
