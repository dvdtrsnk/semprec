import CoreKit
import XCTest

@testable import SleepFeature

final class SleepViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedSleepScreenModel(state: SleepState())
        let viewModel = SleepViewModel(model: model)
        XCTAssertEqual(viewModel.state.phase, .loading)
        let ended = expectation(description: "The observation ended")
        let observer = Task {
            await viewModel.observe()
            ended.fulfill()
        }

        model.publish(.previewReady)
        try await eventually { viewModel.state.phase == .ready }
        XCTAssertEqual(viewModel.state, .previewReady)

        model.publish(SleepState(phase: .failure(.unavailable)))
        try await eventually { viewModel.state.phase == .failure(.unavailable) }
        XCTAssertEqual(viewModel.state.phase, .failure(.unavailable))
        observer.cancel()
        await fulfillment(of: [ended], timeout: 5)
    }

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedSleepScreenModel(state: .previewReady)
        let viewModel = SleepViewModel(model: model)

        viewModel.retry()
        viewModel.send(.open(.night))
        viewModel.send(.setSwitch(.showInCalendar, isOn: false))
        viewModel.send(.pickMinutes(.goal, minutes: 450))
        viewModel.send(.pickSound(.birds))
        viewModel.send(.draft(.editPlan(planID: "weekdays")))
        viewModel.send(.draft(.editPlan(planID: nil)))
        viewModel.send(.draft(.moveDial(.whole, minutes: 1_320)))
        viewModel.send(.draft(.toggleDay(6)))
        viewModel.send(.draft(.setAlarm(isOn: false)))
        viewModel.send(.draft(.confirm(newPlanName: "Other days")))
        viewModel.send(.draft(.deletePlan))
        viewModel.send(.draft(.discard))
        viewModel.send(.draft(.commitNight))
        viewModel.send(.resetNight)
        viewModel.send(.back)
        viewModel.send(.dismissSaveFailure)

        XCTAssertEqual(
            model.actions,
            [
                .retry, .open(.night), .setSwitch(.showInCalendar, isOn: false), .pickMinutes(.goal, minutes: 450),
                .pickSound(.birds), .draft(.editPlan(planID: "weekdays")), .draft(.editPlan(planID: nil)),
                .draft(.moveDial(.whole, minutes: 1_320)), .draft(.toggleDay(6)), .draft(.setAlarm(isOn: false)),
                .draft(.confirm(newPlanName: "Other days")), .draft(.deletePlan), .draft(.discard),
                .draft(.commitNight), .resetNight, .back, .dismissSaveFailure
            ]
        )
    }

    @MainActor
    func testTheEditorAndTheNightDraftAreRepublishedLikeAnyOtherState() async throws {
        let model = ScriptedSleepScreenModel(state: .previewReady)
        let viewModel = SleepViewModel(model: model)
        let observer = Task { await viewModel.observe() }

        model.publish(.previewReady.editing(.previewWeekdays))
        try await eventually { viewModel.state.editor == .previewWeekdays }
        XCTAssertEqual(viewModel.state.editor, .previewWeekdays)

        model.publish(.previewReady.opening(.night))
        try await eventually { viewModel.state.nightDraft == .previewNight }
        XCTAssertNil(viewModel.state.editor)
        XCTAssertEqual(viewModel.state.nightDraft, .previewNight)
        observer.cancel()
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedSleepScreenModel?
        autoreleasepool {
            let model = ScriptedSleepScreenModel(state: .previewReady)
            weakModel = model
            let viewModel = SleepViewModel(model: model)
            withExtendedLifetime(viewModel) {}
        }
        XCTAssertNil(weakModel, "The view model must own the only reference to its model")
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<500 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
    }
}
