import Foundation

/// Where the wake-up missions of this device are kept between launches.
protocol WakeMissionStore: Sendable {

    func load() throws -> [WakeMission]

    func save(_ missions: [WakeMission]) throws
}

/// The `WakeMissionStore` of the device: the missions as JSON under one key of the app's user defaults. They belong to
/// this device only, like the alarms the system holds for it.
struct DefaultsWakeMissionStore: WakeMissionStore {

    static let key = "wakeGuard.missions"

    // MARK: - Dependencies
    private let defaults: @Sendable () -> UserDefaults

    // MARK: - Init
    init(defaults: @escaping @Sendable () -> UserDefaults = { .standard }) {
        self.defaults = defaults
    }

    // MARK: - Protocol conformance
    func load() throws -> [WakeMission] {
        guard let data = defaults().data(forKey: Self.key) else { return [] }
        return try JSONDecoder().decode([WakeMission].self, from: data)
    }

    func save(_ missions: [WakeMission]) throws {
        defaults().set(try JSONEncoder().encode(missions), forKey: Self.key)
    }
}
