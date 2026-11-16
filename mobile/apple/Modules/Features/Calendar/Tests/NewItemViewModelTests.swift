import CoreKit
import XCTest

@testable import CalendarFeature

final class NewItemViewModelTests: XCTestCase {

    // MARK: - Properties
    private let editing = NewItemState(phase: .editing, defaultDay: "2026-10-16")

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedNewItemScreenModel(state: NewItemState(phase: .loading, defaultDay: "2026-10-16"))
        let viewModel = NewItemViewModel(model: model)
        XCTAssertEqual(viewModel.state.phase, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        model.publish(.preview)
        try await eventually { viewModel.state.phase == .editing }
        XCTAssertEqual(viewModel.state, .preview)
        model.publish(NewItemState(phase: .saving, defaultDay: "2026-10-16"))
        try await eventually { viewModel.state.phase == .saving }
        XCTAssertEqual(viewModel.state.phase, .saving)
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testCreateHandsTheFormOverAsItsDraft() {
        let model = ScriptedNewItemScreenModel(state: editing)
        let viewModel = NewItemViewModel(model: model)
        var form = NewItemForm(day: "2026-10-16", now: noon, calendar: utc)
        form.title = "Standup"
        viewModel.create(form)
        XCTAssertEqual(model.actions, [.create(form.draft)])
    }

    @MainActor
    func testAnEditClearsOnlyAFailure() async throws {
        let model = ScriptedNewItemScreenModel(state: editing)
        let viewModel = NewItemViewModel(model: model)
        viewModel.edited()
        XCTAssertTrue(model.actions.isEmpty, "Nothing failed, so an edit has nothing to clear")
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        model.publish(NewItemState(phase: .failed(.rejected), defaultDay: "2026-10-16"))
        try await eventually { viewModel.state.phase == .failed(.rejected) }
        viewModel.edited()
        XCTAssertEqual(model.actions, [.edited])
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testACreatedItemIsRecordedIncludingOneReportedBeforeObservation() async throws {
        let model = ScriptedNewItemScreenModel(state: editing, effects: [.created(itemId: "item-1")])
        let viewModel = NewItemViewModel(model: model)
        XCTAssertNil(viewModel.createdItemId)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }
        try await eventually { viewModel.createdItemId != nil }
        XCTAssertEqual(viewModel.createdItemId, "item-1")
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testReleasingTheViewModelReleasesTheScreenModel() {
        weak var weakModel: ScriptedNewItemScreenModel?
        var viewModel: NewItemViewModel?
        do {
            let model = ScriptedNewItemScreenModel(state: editing)
            weakModel = model
            viewModel = NewItemViewModel(model: model)
        }
        XCTAssertNotNil(viewModel)
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel, "Releasing the ViewModel must release the model, which closes the shared one")
    }

    // MARK: - Helpers
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }

    private var noon: Date {
        Date(timeIntervalSince1970: 1_792_152_000)
    }

    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<500 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
    }
}
