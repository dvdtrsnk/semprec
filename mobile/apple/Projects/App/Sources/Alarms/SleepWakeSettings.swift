import Foundation

/// How this device wakes the person for the sleep plan: whether a code ends the alarm, and the codes. They stay on
/// the device, like the alarms it rings: a code belongs to a thing in this person's home.
struct SleepWakeSettings: Codable, Equatable, Sendable {

    var requiresCode = false
    var codes: [String] = []

    /// The codes that end an alarm, or none while the alarm stops with the system's button.
    var activeCodes: [String] {
        requiresCode ? WakeGuard.normalized(codes) : []
    }
}

/// Where the sleep alarm clock keeps, between launches, the wake settings and the plain system alarms it scheduled,
/// each under the key of its ring.
protocol SleepAlarmStore: Sendable {

    func load() throws -> SleepWakeSettings

    func save(_ settings: SleepWakeSettings) throws

    func loadScheduled() throws -> [String: UUID]

    func saveScheduled(_ scheduled: [String: UUID]) throws
}

/// The `SleepAlarmStore` of the device: JSON under two keys of the app's user defaults.
struct DefaultsSleepAlarmStore: SleepAlarmStore {

    static let key = "sleepAlarms.wakeSettings"
    static let scheduledKey = "sleepAlarms.scheduled"

    // MARK: - Dependencies
    private let defaults: @Sendable () -> UserDefaults

    // MARK: - Init
    init(defaults: @escaping @Sendable () -> UserDefaults = { .standard }) {
        self.defaults = defaults
    }

    // MARK: - Protocol conformance
    func load() throws -> SleepWakeSettings {
        guard let data = defaults().data(forKey: Self.key) else { return SleepWakeSettings() }
        return try JSONDecoder().decode(SleepWakeSettings.self, from: data)
    }

    func save(_ settings: SleepWakeSettings) throws {
        defaults().set(try JSONEncoder().encode(settings), forKey: Self.key)
    }

    func loadScheduled() throws -> [String: UUID] {
        guard let data = defaults().data(forKey: Self.scheduledKey) else { return [:] }
        return try JSONDecoder().decode([String: UUID].self, from: data)
    }

    func saveScheduled(_ scheduled: [String: UUID]) throws {
        defaults().set(try JSONEncoder().encode(scheduled), forKey: Self.scheduledKey)
    }
}
