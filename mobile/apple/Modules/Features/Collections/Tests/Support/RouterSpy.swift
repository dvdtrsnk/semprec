import CoreKit
import XCTest

@testable import CollectionsFeature

/// A router that records every request.
@MainActor
final class RouterSpy: CollectionsRouting {

    // MARK: - Properties
    var items: [String] = []
    var collections: [CollectionTarget] = []
    var events: [String] = []
    var areas: [String] = []
    var tasks: [String] = []
    var mail: [String] = []
    var mailSignals: [String] = []
    var notes: [String] = []
    var agents: [String] = []

    // MARK: - CollectionsRouting
    func showItem(itemId: String, databaseKey: String?) {
        items.append("\(itemId):\(databaseKey ?? "-")")
    }

    func showCollection(_ target: CollectionTarget) { collections.append(target) }
    func showEvent(itemId: String) { events.append(itemId) }
    func showArea(areaId: String) { areas.append(areaId) }
    func showProjectTasks(projectId: String) { tasks.append(projectId) }
    func showProjectMail(projectId: String) { mail.append(projectId) }
    func showProjectMailSignals(projectId: String) { mailSignals.append(projectId) }
    func showProjectNotes(projectId: String) { notes.append(projectId) }
    func showProjectAgent(projectId: String) { agents.append(projectId) }
}

/// Polls `condition` on the main actor until it holds or `timeout` passes.
@MainActor
func eventually(timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool) async throws {
    let deadline = ContinuousClock.now + timeout
    while !condition(), ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(10))
    }
}
