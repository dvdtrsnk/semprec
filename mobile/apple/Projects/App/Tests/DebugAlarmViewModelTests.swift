import CoreKit
import XCTest

@testable import Alldots

/// The debug alarm screen's adapter over a scripted shared model: it republishes the state and forwards every intent;
/// what each intent does is the shared ViewModel's.
final class DebugAlarmViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedDebugAlarmScreenModel(state: DebugAlarmState(authorization: .notDetermined))
        let viewModel = DebugAlarmViewModel(model: model)
        XCTAssertEqual(viewModel.state.authorization, .notDetermined)
        let observer = Task { await viewModel.observe() }

        model.publish(DebugAlarmState(authorization: .authorized, alarms: [DebugAlarmRow(id: "a1")], codeCount: 2))
        try await eventually { viewModel.state.alarms.count == 1 }

        XCTAssertEqual(viewModel.state.authorization, .authorized)
        XCTAssertEqual(viewModel.state.codeCount, 2)
        observer.cancel()
    }

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedDebugAlarmScreenModel(state: DebugAlarmState())
        let viewModel = DebugAlarmViewModel(model: model)
        let moment = Date(timeIntervalSince1970: 1_800_000_000)

        viewModel.send(.requestAuthorization)
        viewModel.send(.ringIn(.tenSeconds, withCodes: false))
        viewModel.send(.ringIn(.fiveMinutes, withCodes: true))
        viewModel.send(.ringAt(moment, repeat: .daily, withCodes: true))
        viewModel.send(.cancel("a1"))
        viewModel.send(.cancelAll)
        viewModel.send(.refresh)
        viewModel.send(.dismissFailure)

        XCTAssertEqual(model.actions, [
            .requestAuthorization,
            .ringIn(.tenSeconds, withCodes: false),
            .ringIn(.fiveMinutes, withCodes: true),
            .ringAt(moment, repeat: .daily, withCodes: true),
            .cancel("a1"),
            .cancelAll,
            .refresh,
            .dismissFailure
        ])
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedDebugAlarmScreenModel?
        autoreleasepool {
            let model = ScriptedDebugAlarmScreenModel(state: DebugAlarmState())
            weakModel = model
            let viewModel = DebugAlarmViewModel(model: model)
            withExtendedLifetime(viewModel) {}
        }
        XCTAssertNil(weakModel, "The view model must own the only reference to its model")
    }
}
