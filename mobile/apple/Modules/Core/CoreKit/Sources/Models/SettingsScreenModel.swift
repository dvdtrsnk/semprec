import Foundation

public enum SettingsRow: Hashable, Sendable {

    case about
}

public struct SettingsState: Equatable, Sendable {

    // MARK: - Properties
    public let rows: [SettingsRow]

    // MARK: - Init
    public init(rows: [SettingsRow]) {
        self.rows = rows
    }
}

public enum SettingsAction: Equatable, Sendable {

    case selectRow(SettingsRow)
}

public enum SettingsEffect: Equatable, Sendable {

    case showAbout
}

public typealias SettingsScreenModel = ScreenModel<SettingsState, SettingsAction, SettingsEffect>

/// Settings screen model for previews and tests; it never starts the Kotlin runtime.
public typealias ScriptedSettingsScreenModel = ScriptedScreenModel<SettingsState, SettingsAction, SettingsEffect>
