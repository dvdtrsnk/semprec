import Foundation

@testable import Semprec

/// A store that keeps the missions in memory. Tests and the code they drive
/// run on the main actor, which is what makes the unchecked `Sendable` sound; a test that hands it to another
/// isolation must make it safe first.
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
