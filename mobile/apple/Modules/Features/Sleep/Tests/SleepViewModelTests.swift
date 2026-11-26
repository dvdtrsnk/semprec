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
        viewModel.send(.open(.plan, planID: "weekdays"))
        viewModel.send(.setSwitch(.alarm, isOn: false))
        viewModel.send(.setTime(.bed, minutes: 1_320))
        viewModel.send(.pickMinutes(.goal, minutes: 450))
        viewModel.send(.pickSound(.birds))
        viewModel.send(.toggleDay(6))
        viewModel.send(.addPlan(name: "Other days"))
        viewModel.send(.deletePlan)
        viewModel.send(.resetNight)
        viewModel.send(.back)
        viewModel.send(.dismissSaveFailure)
        let save = SleepAction.savePlan(
            planID: nil, name: "Weekend", wakeDays: [6, 7], bedMinutes: 1_380, wakeMinutes: 480, alarm: true
        )
        viewModel.send(save)
        viewModel.send(.removePlan(planID: "weekend"))
        viewModel.send(.saveNight(bedMinutes: 1_410, wakeMinutes: 420, alarm: false))

        XCTAssertEqual(
            model.actions,
            [
                .retry, .open(.plan, planID: "weekdays"), .setSwitch(.alarm, isOn: false),
                .setTime(.bed, minutes: 1_320), .pickMinutes(.goal, minutes: 450), .pickSound(.birds), .toggleDay(6),
                .addPlan(name: "Other days"), .deletePlan, .resetNight, .back, .dismissSaveFailure, save,
                .removePlan(planID: "weekend"), .saveNight(bedMinutes: 1_410, wakeMinutes: 420, alarm: false)
            ]
        )
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
