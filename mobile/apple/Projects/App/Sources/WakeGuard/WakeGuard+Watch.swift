import Foundation

// MARK: - Watch alarms
extension WakeGuard {

    /// Schedules the watch alarms of every mission that guards no ring yet, after its next ring. A mission whose single
    /// ring has passed unguarded is removed. One pass runs at a time, so two refreshes never arm a mission twice.
    func armMissions() async {
        guard !isArming else { return }
        isArming = true
        defer { isArming = false }
        for id in missions.filter({ $0.guardedRing == nil }).map(\.id) {
            guard let mission = missions.first(where: { $0.id == id }) else { continue }
            guard let ring = mission.nextRing(after: now()) else {
                silence([mission.alarmID], keeping: nil)
                missions.removeAll { $0.id == id }
                continue
            }
            let watchIDs = await scheduleWatches(for: mission, after: ring)
            if let index = missions.firstIndex(where: { $0.id == id }) {
                missions[index].guardedRing = ring
                missions[index].watchIDs = watchIDs
            }
        }
        persist()
    }

    /// The mission ended: its ringing alarms stop and its waiting watch alarms are cancelled. A single ring's mission
    /// is removed with its alarm; a daily one guards its next ring.
    func finish(_ mission: WakeMission) async {
        switch mission.time {
        case .once:
            silence([mission.alarmID] + mission.watchIDs, keeping: nil)
            missions.removeAll { $0.id == mission.id }
        case .daily:
            silence([mission.alarmID] + mission.watchIDs, keeping: mission.alarmID)
            if let index = missions.firstIndex(where: { $0.id == mission.id }) {
                missions[index].guardedRing = nil
                missions[index].watchIDs = []
            }
        }
        persist()
        updateRinging()
        await armMissions()
    }

    /// Stops each of `ids` that rings and cancels each that waits, except `kept`, the daily alarm that rings again
    /// tomorrow. An id the system no longer holds needs nothing. A refusal is kept in `failure`; the other ids are
    /// still handled.
    func silence(_ ids: [UUID], keeping kept: UUID?) {
        let held: [UUID: AlarmPhase]
        do {
            held = Dictionary(try scheduler.alarms().map { ($0.id, $0.phase) }) { first, _ in first }
        } catch {
            failure = String(describing: error)
            return
        }
        for id in ids {
            guard let phase = held[id] else { continue }
            do {
                if phase != .scheduled {
                    try scheduler.stop(id: id)
                } else if id != kept {
                    try scheduler.cancel(id: id)
                }
            } catch {
                failure = String(describing: error)
            }
        }
    }

    func persist() {
        do {
            try store.save(missions)
        } catch {
            failure = String(describing: error)
        }
    }

    /// The mission whose guarded ring has come, the earliest first.
    static func ringingMission(in missions: [WakeMission], at now: Date) -> WakeMission? {
        missions
            .filter { ($0.guardedRing ?? .distantFuture) <= now }
            .min { ($0.guardedRing ?? .distantFuture) < ($1.guardedRing ?? .distantFuture) }
    }

    /// The codes without surrounding whitespace, blanks and repeats, in their order.
    static func normalized(_ codes: [String]) -> [String] {
        var seen = Set<String>()
        return codes
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}

// MARK: - Private
private extension WakeGuard {

    /// Schedules the watch alarms after `ring` until the system refuses one; answers the ids it accepted. The ones
    /// accepted before a refusal still guard the ring.
    func scheduleWatches(for mission: WakeMission, after ring: Date) async -> [UUID] {
        var ids: [UUID] = []
        for offset in WakeMission.watchOffsets {
            let request = AlarmRequest(
                title: mission.title,
                schedule: .once(ring.addingTimeInterval(TimeInterval(offset * 60))),
                opensWakeGuard: true
            )
            do {
                try await scheduler.schedule(request)
                ids.append(request.id)
            } catch {
                failure = String(describing: error)
                break
            }
        }
        return ids
    }
}
