import Foundation
@preconcurrency internal import SharedSDK

/// The shared layer's `SleepAlarmLedger` in the user defaults: which system alarm belongs to which ring of the sleep
/// plan, as key to alarm identifier. They are no secret and name nothing but the app's own alarms. Every call comes
/// on the main thread.
@MainActor
final class DefaultsSleepAlarmLedger: NSObject {

    // MARK: - Properties
    private let defaults: UserDefaults
    private let key: String

    // MARK: - Init
    init(defaults: UserDefaults = .standard, key: String = "cz.semprec.sleepAlarmLedger") {
        self.defaults = defaults
        self.key = key
    }
}

// MARK: - Protocol conformance
extension DefaultsSleepAlarmLedger: @preconcurrency SharedSDK.SleepAlarmLedger {

    func load() -> [String: String] {
        defaults.dictionary(forKey: key)?.compactMapValues { $0 as? String } ?? [:]
    }

    func save(entries: [String: String]) {
        defaults.set(entries, forKey: key)
    }
}
