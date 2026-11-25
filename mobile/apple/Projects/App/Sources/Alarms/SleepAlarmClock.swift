import Combine
import CoreKit
import Foundation

/// Rings the alarms of the sleep plan on this device: reads the week's alarms and keeps the system's alarms in step
/// with them. Without a code an alarm is a plain system alarm; with the wake settings asking for a code it is a
/// wake-up mission of the `WakeGuard`, which rings until a code is scanned. An alarm already ringing is never removed.
@MainActor
final class SleepAlarmClock: ObservableObject {

    // MARK: - Dependencies
    private let source: any SleepAlarmSource
    private let scheduler: any AlarmScheduler
    private let wakeGuard: WakeGuard
    private let store: any SleepAlarmStore
    private let now: @MainActor () -> Date
    private let calendar: Calendar

    // MARK: - Published Properties
    @Published private(set) var settings: SleepWakeSettings
    /// The last failure of a read or a write, for the wake settings screen.
    @Published private(set) var failure: String?
    private var isSyncing = false
    /// A sync asked for while one ran; the running one makes another pass.
    private var syncAgain = false
    /// The sync the last settings change asked for. An earlier one is never cancelled: a cancelled pass would read
    /// nothing and keep the old alarms, while a running pass picks the new settings up through `syncAgain`.
    private(set) var pendingSync: Task<Void, Never>?

    // MARK: - Init
    init(
        source: any SleepAlarmSource,
        scheduler: any AlarmScheduler,
        wakeGuard: WakeGuard,
        store: any SleepAlarmStore,
        now: @escaping @MainActor () -> Date = { Date() },
        calendar: Calendar = .current
    ) {
        self.source = source
        self.scheduler = scheduler
        self.wakeGuard = wakeGuard
        self.store = store
        self.now = now
        self.calendar = calendar
        do {
            settings = try store.load()
        } catch {
            settings = SleepWakeSettings()
            failure = Self.message(error)
        }
    }

    // MARK: - Methods
    /// Keeps the wake settings at once and brings the alarms in step with them.
    func update(_ settings: SleepWakeSettings) {
        self.settings = settings
        do {
            try store.save(settings)
        } catch {
            failure = Self.message(error)
        }
        pendingSync = Task { [weak self] in await self?.sync() }
    }

    /// Reads the week's alarms and schedules, replaces or removes the system's alarms to match. A failed read keeps
    /// the alarms the device holds. One pass runs at a time; a sync asked for meanwhile makes the running one pass
    /// again, so the last settings always win.
    func sync() async {
        guard scheduler.isSupported else { return }
        guard !isSyncing else {
            syncAgain = true
            return
        }
        isSyncing = true
        defer { isSyncing = false }
        repeat {
            syncAgain = false
            await syncOnce()
        } while syncAgain
    }

    /// One pass of `sync()`.
    private func syncOnce() async {
        guard let alarms = await source.sleepAlarms(today: Self.day(now(), calendar: calendar)) else { return }
        let rings = Dictionary(alarms.compactMap(ring).map { ($0.key, $0) }) { first, _ in first }
        let codes = settings.activeCodes
        if codes.isEmpty {
            await removeMissions(keeping: [])
            await schedulePlain(rings)
        } else {
            await schedulePlain([:])
            await scheduleMissions(rings, codes: codes)
        }
    }

    /// Whether a silent push with `payload` tells the device that the sleep plan changed.
    func asksForSleepAlarms(_ payload: [String: String]) -> Bool {
        source.asksForSleepAlarms(payload)
    }

    /// Nobody is signed in: the alarms of the person who was are removed, apart from one ringing now.
    func signedOut() async {
        await schedulePlain([:])
        await removeMissions(keeping: [])
    }
}

/// One alarm of the sleep plan as the device rings it: its key, which names the ring, and its moment.
struct SleepAlarmRing: Equatable {

    let key: String
    let date: Date
    let title: String
}

// MARK: - Private
private extension SleepAlarmClock {

    static let keyPrefix = "sleep:"

    /// The ring of `alarm` in the device's time zone, or nil when it has passed or its day is unreadable.
    func ring(_ alarm: SleepAlarmTime) -> SleepAlarmRing? {
        guard
            let day = Self.date(alarm.wakeDay, calendar: calendar),
            let date = calendar.date(byAdding: .minute, value: alarm.wakeMinutes, to: day),
            date > now()
        else { return nil }
        let time = String(format: "%02d:%02d", alarm.wakeMinutes / 60, alarm.wakeMinutes % 60)
        let key = Self.keyPrefix + alarm.wakeDay + " " + time
        return SleepAlarmRing(key: key, date: date, title: String(localized: "alarm.sleep.title"))
    }

    /// Schedules a plain system alarm for each of `rings` that has none and cancels the ones no ring needs.
    func schedulePlain(_ rings: [String: SleepAlarmRing]) async {
        var scheduled = loadScheduled()
        // An alarm whose cancel failed stays in the ledger, so the next sync cancels it again.
        for (key, id) in scheduled where rings[key] == nil {
            if cancel(id) { scheduled[key] = nil }
        }
        var added: [UUID] = []
        for (key, ring) in rings where scheduled[key] == nil {
            let request = AlarmRequest(title: ring.title, schedule: .once(ring.date))
            do {
                try await scheduler.schedule(request)
                scheduled[key] = request.id
                added.append(request.id)
            } catch {
                failure = Self.message(error)
            }
        }
        do {
            try store.saveScheduled(scheduled)
        } catch {
            failure = Self.message(error)
            // The ledger does not know them, so the next sync would schedule them again beside these.
            for id in added { _ = cancel(id) }
        }
    }

    /// Creates a wake-up mission for each of `rings` that has none with these codes, and removes the sleep missions
    /// no ring needs or that ask for other codes.
    func scheduleMissions(_ rings: [String: SleepAlarmRing], codes: [String]) async {
        let current = wakeGuard.missions.filter { $0.source?.hasPrefix(Self.keyPrefix) == true }
        let kept = current.filter { mission in
            guard let source = mission.source else { return false }
            return rings[source] != nil && mission.codes == codes
        }
        await removeMissions(keeping: Set(kept.compactMap(\.source)))
        let held = Set(wakeGuard.missions.compactMap(\.source))
        for (key, ring) in rings where !held.contains(key) {
            do {
                try await wakeGuard.create(title: ring.title, time: .once(ring.date), codes: codes, source: key)
            } catch {
                failure = Self.message(error)
            }
        }
    }

    /// Removes the sleep missions whose source is not in `kept`; the guard keeps one that is ringing.
    func removeMissions(keeping kept: Set<String>) async {
        for mission in wakeGuard.missions {
            guard let source = mission.source, source.hasPrefix(Self.keyPrefix), !kept.contains(source) else {
                continue
            }
            await wakeGuard.remove(mission.id)
        }
    }

    /// Cancels an alarm that has not rung, counting down or paused included; one ringing now rings on until the
    /// person stops it, and one gone needs nothing. A ringing alarm leaves the ledger without being scheduled again:
    /// it rings at or after its moment, and `ring(_:)` drops every moment that is not still ahead.
    /// Answers whether the alarm needs no more tracking: false when reading or cancelling it failed.
    func cancel(_ id: UUID) -> Bool {
        do {
            let phase = try scheduler.alarms().first { $0.id == id }?.phase
            if let phase, phase != .alerting { try scheduler.cancel(id: id) }
            return true
        } catch {
            failure = Self.message(error)
            return false
        }
    }

    func loadScheduled() -> [String: UUID] {
        do {
            return try store.loadScheduled()
        } catch {
            failure = Self.message(error)
            return [:]
        }
    }

    /// What went wrong, in words the wake settings screen shows.
    static func message(_ error: Error) -> String {
        switch error as? AlarmSchedulingError {
        case .notAuthorized: String(localized: "sleepWake.failure.notAuthorized")
        case .limitReached: String(localized: "sleepWake.failure.limitReached")
        case .unsupported, nil: String(localized: "sleepWake.failure.other")
        }
    }

    static func day(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    static func date(_ day: String, calendar: Calendar) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
