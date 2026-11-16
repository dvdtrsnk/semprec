import CoreKit
import XCTest

@testable import AccountFeature

final class TrashViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedTrashScreenModel(state: TrashState())
        let viewModel = TrashViewModel(model: model)
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(TrashState(phase: .content, tab: .databases, selecting: true))
        try await eventually { viewModel.state.selecting }
        XCTAssertEqual(viewModel.state.tab, .databases)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedTrashScreenModel(state: TrashState())
        let viewModel = TrashViewModel(model: model)
        viewModel.retry()
        viewModel.select(.databases)
        viewModel.loadMore()
        viewModel.toggleSelecting()
        viewModel.toggle("i1")
        viewModel.selectAll()
        viewModel.restore("i2")
        viewModel.restoreSelected()
        viewModel.dismissFailure()
        XCTAssertEqual(
            model.actions,
            [
                .retry, .selectTab(.databases), .loadMore, .toggleSelecting, .toggle(id: "i1"), .selectAll,
                .restore(id: "i2"), .restoreSelected, .dismissFailure
            ]
        )
    }

    @MainActor
    func testARestoreShowsItsNoticeAtOnceAndTakesItAwayAfterAWhile() async throws {
        let model = ScriptedTrashScreenModel(state: TrashState())
        let viewModel = TrashViewModel(model: model, noticeDuration: .milliseconds(50))
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        XCTAssertNil(viewModel.notice)
        model.emit(.restored(restored: 2, refused: 0, databaseName: nil))
        try await eventually { viewModel.notice != nil }
        XCTAssertEqual(viewModel.notice, TrashViewModel.notice(restored: 2, refused: 0, databaseName: nil))
        try await eventually { viewModel.notice == nil }
    }

    @MainActor
    func testANewerRestoreReplacesTheNoticeAndRestartsTheWait() async throws {
        let model = ScriptedTrashScreenModel(state: TrashState())
        let viewModel = TrashViewModel(model: model, noticeDuration: .seconds(30))
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.restored(restored: 1, refused: 0, databaseName: "Tasks"))
        let first = TrashViewModel.notice(restored: 1, refused: 0, databaseName: "Tasks")
        try await eventually { viewModel.notice == first }
        model.emit(.restored(restored: 3, refused: 1, databaseName: nil))
        let second = TrashViewModel.notice(restored: 3, refused: 1, databaseName: nil)
        try await eventually { viewModel.notice == second }
    }

    @MainActor
    func testTheNoticeNamesWhereOneItemWentCountsTheRestAndSaysWhatWasRefused() {
        let into = TrashViewModel.notice(restored: 1, refused: 0, databaseName: "Tasks")
        XCTAssertTrue(into.contains("Tasks") || into.contains("Úkoly"), into)
        let several = TrashViewModel.notice(restored: 3, refused: 0, databaseName: nil)
        XCTAssertTrue(several.contains("3"), several)
        XCTAssertFalse(several.contains("Tasks"))
        let one = TrashViewModel.notice(restored: 1, refused: 0, databaseName: nil)
        XCTAssertTrue(one.contains("1"), one)
        let partial = TrashViewModel.notice(restored: 2, refused: 1, databaseName: "Tasks")
        XCTAssertTrue(partial.contains("2") && partial.contains("1"), partial)
        XCTAssertFalse(partial.contains("Tasks"), "A restore with refusals counts instead of naming a place")
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedTrashScreenModel?
        var viewModel: TrashViewModel?
        do {
            let model = ScriptedTrashScreenModel(state: TrashState())
            weakModel = model
            viewModel = TrashViewModel(model: model)
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
