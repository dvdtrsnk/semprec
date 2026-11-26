import Foundation

// MARK: - Watch alarms
extension WakeGuard {

    /// Schedules the watch alarms of every mission that guards no ring yet, after its next ring, once that ring is
    /// within `WakeMission.armHorizon`. A mission whose single ring has passed unguarded is removed. One pass runs at a
    /// time, so two refreshes never arm a mission twice.
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
            guard ring.timeIntervalSince(now()) <= WakeMission.armHorizon else { continue }
            // A pass cancelled while it scheduled leaves the mission unarmed, so the next pass arms it whole.
            guard let watchIDs = await scheduleWatches(for: mission, after: ring) else { break }
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

    /// Stops each of `ids` that rings and cancels each that has not rung, counting down or paused included, except
    /// `kept`, the daily alarm that rings again tomorrow. An id the system no longer holds needs nothing. A refusal
    /// is kept in `failure`; the other ids are still handled.
    func silence(_ ids: [UUID], keeping kept: UUID?) {
        let held: [UUID: AlarmPhase]
        do {
            held = Dictionary(try scheduler.alarms().map { ($0.id, $0.phase) }) { first, _ in first }
        } catch {
            failure = String(describing: error)
            silenceUnread(ids, keeping: kept)
            return
        }
        for id in ids {
            guard let phase = held[id] else { continue }
            do {
                if phase == .alerting {
                    try scheduler.stop(id: id)
                } else if id != kept {
                    try scheduler.cancel(id: id)
                }
            } catch {
                failure = String(describing: error)
            }
        }
    }

    /// `silence` without the system's list: each of `ids` but `kept` is cancelled, and stopped where it already rings,
    /// so no alarm of a mission that ended stays live because the list could not be read.
    func silenceUnread(_ ids: [UUID], keeping kept: UUID?) {
        for id in ids where id != kept {
            do {
                try scheduler.cancel(id: id)
            } catch {
                do {
                    try scheduler.stop(id: id)
                } catch {
                    failure = String(describing: error)
                }
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

}

// MARK: - Private
private extension WakeGuard {

    /// Schedules the watch alarms after `ring` until the system refuses one; answers the ids it accepted. The ones
    /// accepted before a refusal still guard the ring. A cancelled task cancels the ones it scheduled and answers
    /// nil: the mission is not armed, rather than armed with part of its watch.
    func scheduleWatches(for mission: WakeMission, after ring: Date) async -> [UUID]? {
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
            } catch is CancellationError {
                silence(ids, keeping: nil)
                return nil
            } catch {
                failure = String(describing: error)
                break
            }
            if Task.isCancelled {
                silence(ids, keeping: nil)
                return nil
            }
        }
        return ids
    }
}
