import Combine
import Foundation

/// The wake-up guard of the process: keeps the wake-up missions, schedules each one's watch alarms on the system's
/// timers, and decides whether one is ringing. A mission rings from its guarded ring until one of its codes is shown,
/// or, after `WakeMission.tapFallbackDelay`, until the person taps `WakeMission.requiredTaps` times; nothing else ends
/// it, because the system's Stop button only silences the alert in front of the person.
@MainActor
final class WakeGuard: ObservableObject {

    // MARK: - Shared
    /// The one instance of the process: the app's root covers every window with the guard while a mission rings.
    static let shared = WakeGuard(scheduler: SystemAlarmScheduler(), store: DefaultsWakeMissionStore())

    // MARK: - Dependencies
    let scheduler: any AlarmScheduler
    let store: any WakeMissionStore
    let now: @MainActor () -> Date

    // MARK: - Published Properties
    @Published var missions: [WakeMission]
    /// The mission that rings now; the guard covers the app while it is set.
    @Published private(set) var ringing: WakeMission?
    /// The taps the person made on the ringing mission's tap fallback.
    @Published private(set) var taps = 0
    /// The last failure of a write to the system or the store, for the debug screen.
    @Published var failure: String?
    /// Whether a pass of `armMissions()` runs; a second one waits for the next refresh.
    var isArming = false

    // MARK: - Init
    init(
        scheduler: any AlarmScheduler,
        store: any WakeMissionStore,
        now: @escaping @MainActor () -> Date = { Date() }
    ) {
        self.scheduler = scheduler
        self.store = store
        self.now = now
        do {
            missions = try store.load()
        } catch {
            missions = []
            failure = String(describing: error)
        }
        ringing = Self.ringingMission(in: missions, at: now())
    }

    // MARK: - Methods
    /// Creates a wake-up mission ringing at `time` that only one of `codes` ends, and schedules its watch alarms once
    /// its ring is within `WakeMission.armHorizon`. `source` names what created it, nil for one made by hand.
    func create(title: String, time: AlarmTime, codes: [String], source: String? = nil) async throws {
        let codes = WakeCodes.normalized(codes)
        guard !codes.isEmpty else { throw WakeGuardError.noCodes }
        let mission = WakeMission(
            id: UUID(),
            title: title,
            time: time,
            codes: codes,
            alarmID: UUID(),
            guardedRing: nil,
            watchIDs: [],
            source: source
        )
        try await scheduler.schedule(
            AlarmRequest(id: mission.alarmID, title: title, schedule: time, opensWakeGuard: true)
        )
        missions.append(mission)
        persist()
        await armMissions()
    }

    /// Arms the missions without watch alarms and decides which one rings; the app calls it when it becomes active
    /// and every few seconds while it is.
    func refresh() async {
        await armMissions()
        updateRinging()
    }

    /// The person showed `code`; answers whether it ended the ringing mission.
    @discardableResult
    func submit(code: String) async -> Bool {
        guard let mission = ringing, mission.accepts(code) else { return false }
        await finish(mission)
        return true
    }

    /// When the ringing mission lets the person tap instead of scanning; nil while none rings.
    var tapFallbackOpensAt: Date? {
        ringing?.guardedRing.map { $0.addingTimeInterval(WakeMission.tapFallbackDelay) }
    }

    /// Whether the tap fallback of the ringing mission is open now.
    var tapFallbackIsOpen: Bool {
        guard let opensAt = tapFallbackOpensAt else { return false }
        return now() >= opensAt
    }

    /// One tap on the tap fallback; the last required tap ends the ringing mission. Taps before the fallback opens do
    /// not count.
    func tap() async {
        guard let mission = ringing, tapFallbackIsOpen else { return }
        taps += 1
        if taps >= WakeMission.requiredTaps { await finish(mission) }
    }

    /// Sets `ringing` from the missions and the clock; a newly ringing mission starts with no taps.
    func updateRinging() {
        let mission = Self.ringingMission(in: missions, at: now())
        if mission?.id != ringing?.id { taps = 0 }
        ringing = mission
    }

    /// Removes a mission that is not ringing, with its alarm and watch alarms.
    func remove(_ id: UUID) async {
        guard ringing?.id != id, let mission = missions.first(where: { $0.id == id }) else { return }
        silence([mission.alarmID] + mission.watchIDs, keeping: nil)
        missions.removeAll { $0.id == id }
        persist()
    }
}

/// Why a wake-up mission could not be created.
enum WakeGuardError: Error, Equatable {

    /// A wake-up mission needs at least one code.
    case noCodes
}
