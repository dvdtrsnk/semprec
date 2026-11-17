import CoreKit
import XCTest

@testable import TasksFeature

final class TasksViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedTasksScreenModel(state: TasksState(phase: .loading))
        let viewModel = TasksViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        defer { observer.cancel() }
        model.publish(TasksState(phase: .content, openCount: 3))
        try await eventually { viewModel.state.openCount == 3 }
        model.publish(TasksState(phase: .failure(.unavailable)))
        try await eventually { viewModel.state.phase == .failure(.unavailable) }
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedTasksScreenModel(state: TasksState(phase: .content))
        let viewModel = TasksViewModel(model: model, router: RouterSpy())
        let actions: [TasksAction] = [
            .selectTab(.all), .toggleHideDone, .setArea("a1"), .setProject(nil), .setFlaggedOnly(true), .clearFilters,
            .retry, .refresh, .toggleDone(taskId: "t1"), .rename(taskId: "t1", title: "Nový"), .add(title: "Koupit"),
            .openDetails(taskId: "t1"), .dismissNotice
        ]
        actions.forEach(viewModel.send)
        XCTAssertEqual(model.actions, actions)
    }

    @MainActor
    func testTheOpenDetailsEffectReachesTheRouter() async throws {
        let model = ScriptedTasksScreenModel(state: TasksState(phase: .content))
        let router = RouterSpy()
        let viewModel = TasksViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.openDetails(taskId: "t7"))
        try await eventually { !router.shown.isEmpty }
        XCTAssertEqual(router.shown, ["t7"])
    }

    @MainActor
    func testEffectsRaisedBeforeObservationAreRoutedOnceItStarts() async throws {
        let router = RouterSpy()
        let model = ScriptedTasksScreenModel(
            state: TasksState(phase: .content),
            effects: [.openDetails(taskId: "t1"), .openDetails(taskId: "t2")]
        )
        let viewModel = TasksViewModel(model: model, router: router)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        try await eventually { router.shown.count == 2 }
        XCTAssertEqual(router.shown, ["t1", "t2"])
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedTasksScreenModel?
        var viewModel: TasksViewModel?
        do {
            let model = ScriptedTasksScreenModel(state: TasksState())
            weakModel = model
            viewModel = TasksViewModel(model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("The condition did not hold in time")
    }
}

// MARK: - Spies
@MainActor
private final class RouterSpy: TasksRouting {

    // MARK: - Properties
    private(set) var shown: [String] = []

    // MARK: - TasksRouting
    func showDetails(taskId: String) {
        shown.append(taskId)
    }
}
