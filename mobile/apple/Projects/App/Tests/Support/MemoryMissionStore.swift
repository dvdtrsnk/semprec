import Foundation

@testable import Semprec

/// A store that keeps the missions in memory.
final class MemoryMissionStore: WakeMissionStore, @unchecked Sendable {

    var missions: [WakeMission] = []
    var loadFailure: Error?

    func load() throws -> [WakeMission] {
        if let loadFailure { throw loadFailure }
        return missions
    }

    func save(_ missions: [WakeMission]) throws {
        self.missions = missions
    }
}
