import XCTest

@testable import CoreKit

/// Drives the real Kotlin account ViewModels through their bridges. No server is signed in, so every load ends in the
/// unauthorized failure the Kotlin layer answers without a request; the actions that need no data work as with a server.
final class AccountBridgeTests: XCTestCase {

    // MARK: - Loads
    @MainActor
    func testEveryAccountScreenWithoutASessionEndsInTheUnauthorizedFailure() async throws {
        let profile = SharedScreenModelFactory().makeProfile()
        let profileState = await firstState(of: profile) { $0.phase != .loading }
        XCTAssertEqual(profileState?.phase, .error)
        XCTAssertEqual(profileState?.failure, .unauthorized)
        XCTAssertNil(profileState?.email, "Without a session there is no identity")

        let devices = SharedScreenModelFactory().makeDevices()
        let devicesState = await firstState(of: devices) { $0.phase != .loading }
        XCTAssertEqual(devicesState, DevicesState(phase: .error, failure: .unauthorized))

        let notifications = SharedScreenModelFactory().makeNotificationSettings()
        let notificationState = await firstState(of: notifications) { $0.phase != .loading }
        XCTAssertEqual(notificationState, NotificationSettingsState(phase: .error, failure: .unauthorized))

        let trash = SharedScreenModelFactory().makeTrash()
        let trashState = await firstState(of: trash) { $0.phase != .loading }
        XCTAssertEqual(trashState, TrashState(phase: .error, failure: .unauthorized))

        let usage = SharedScreenModelFactory().makeAiUsage()
        let usageState = await firstState(of: usage) { $0.phase != .loading }
        XCTAssertEqual(usageState?.phase, .error)
        XCTAssertEqual(usageState?.failure, .unauthorized)
        XCTAssertEqual(usageState?.periods.first, .week)
    }

    // A retry replaces the Kotlin state with a new value (through loading), so a state that is another object than
    // the one before shows that the Kotlin ViewModel loaded again.
    @MainActor
    func testRetryMakesTheKotlinDevicesLoadAgain() async throws {
        let model = try XCTUnwrap(SharedScreenModelFactory().makeDevices() as? SharedDevicesScreenModel)
        _ = await firstState(of: model) { $0.phase != .loading }
        let loaded = model.viewModel.state.value
        model.send(.retry)
        XCTAssertFalse(model.viewModel.state.value === loaded, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await firstState(of: model) { $0.phase != .loading }
        XCTAssertEqual(reloaded?.failure, .unauthorized)
    }

    // MARK: - Actions
    @MainActor
    func testOpeningRowsOfTheProfileDeliversEachPageOnceInOrder() async {
        let model = SharedScreenModelFactory().makeProfile()
        model.send(.open(.devices))
        model.send(.open(.trash))
        let buffered = await effects(of: model, count: 2)
        XCTAssertEqual(buffered, [.devices, .trash])
        let none = await effects(of: model, count: 1, timeout: 0.3)
        XCTAssertEqual(none, [], "A delivered effect must not be delivered again")
    }

    @MainActor
    func testTheProfileChecksTheLanguageBeforeSendingIt() {
        let model = SharedScreenModelFactory().makeProfile()
        model.send(.changeLocale("de"))
        XCTAssertFalse(model.state.localeSaving, "A language the server does not offer must not be sent")
    }

    @MainActor
    func testTheTrashSelectionLivesInTheKotlinState() {
        let model = SharedScreenModelFactory().makeTrash()
        model.send(.toggleSelecting)
        XCTAssertTrue(model.state.selecting)
        model.send(.toggleSelecting)
        XCTAssertFalse(model.state.selecting)
    }

    @MainActor
    func testTheUsageScreenIgnoresAPeriodItDoesNotOffer() {
        let model = SharedScreenModelFactory().makeAiUsage()
        model.send(.selectPeriod(.month("1999-01")))
        XCTAssertEqual(model.state.period, .week)
    }

    // MARK: - Lifetime
    @MainActor
    func testReleasingABridgeClosesItsKotlinViewModel() throws {
        var profile: SharedProfileScreenModel? = try XCTUnwrap(SharedScreenModelFactory().makeProfile() as? SharedProfileScreenModel)
        var devices: SharedDevicesScreenModel? = try XCTUnwrap(SharedScreenModelFactory().makeDevices() as? SharedDevicesScreenModel)
        var notifications: SharedNotificationSettingsScreenModel? = try XCTUnwrap(
            SharedScreenModelFactory().makeNotificationSettings() as? SharedNotificationSettingsScreenModel
        )
        var usage: SharedAiUsageScreenModel? = try XCTUnwrap(SharedScreenModelFactory().makeAiUsage() as? SharedAiUsageScreenModel)
        var trash: SharedTrashScreenModel? = try XCTUnwrap(SharedScreenModelFactory().makeTrash() as? SharedTrashScreenModel)
        let leases = try [
            XCTUnwrap(profile?.lease),
            XCTUnwrap(devices?.lease),
            XCTUnwrap(notifications?.lease),
            XCTUnwrap(usage?.lease),
            XCTUnwrap(trash?.lease)
        ]
        XCTAssertTrue(leases.allSatisfy { !$0.isClosed })
        profile = nil
        devices = nil
        notifications = nil
        usage = nil
        trash = nil
        XCTAssertTrue(leases.allSatisfy(\.isClosed))
    }
}

// MARK: - Helpers
// The helpers that iterate a stream wait with a timeout and then cancel their task, so a stream that ignores
// cancellation fails the test instead of hanging it.
private extension AccountBridgeTests {

    @MainActor
    func firstState<Model: ScreenModel>(
        of model: Model,
        timeout: TimeInterval = 5,
        until predicate: @escaping @Sendable (Model.State) -> Bool
    ) async -> Model.State? {
        let found = Received<Model.State>()
        let matched = XCTestExpectation(description: "A matching state arrived")
        let observer = Task { @MainActor in
            for await state in model.states() where predicate(state) {
                found.values.append(state)
                matched.fulfill()
                return
            }
        }
        _ = await XCTWaiter.fulfillment(of: [matched], timeout: timeout)
        observer.cancel()
        return found.values.first
    }

    @MainActor
    func effects<Model: ScreenModel>(of model: Model, count: Int, timeout: TimeInterval = 5) async -> [Model.Effect] {
        let received = Received<Model.Effect>()
        let complete = XCTestExpectation(description: "\(count) effects arrived")
        let observer = Task { @MainActor in
            for await effect in model.effects() {
                received.values.append(effect)
                if received.values.count == count {
                    complete.fulfill()
                    return
                }
            }
        }
        _ = await XCTWaiter.fulfillment(of: [complete], timeout: timeout)
        observer.cancel()
        return received.values
    }
}

/// Values a test task received on the main actor.
@MainActor
private final class Received<Value> {

    // MARK: - Properties
    var values: [Value] = []
}
