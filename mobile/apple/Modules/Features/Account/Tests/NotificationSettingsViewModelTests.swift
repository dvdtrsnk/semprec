import CoreKit
import XCTest

@testable import AccountFeature

final class NotificationSettingsViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedNotificationSettingsScreenModel(state: NotificationSettingsState())
        let viewModel = NotificationSettingsViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        let choices = NotificationChoices(invites: false)
        model.publish(NotificationSettingsState(phase: .content, choices: choices))
        try await eventually { viewModel.state.choices == choices }
        XCTAssertEqual(viewModel.state.choices?.isOn(.invites), false)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedNotificationSettingsScreenModel(state: NotificationSettingsState())
        let viewModel = NotificationSettingsViewModel(model: model, router: RouterSpy())
        viewModel.retry()
        viewModel.set(.badgeInbox, enabled: true)
        viewModel.setProblemsLevel(.all)
        viewModel.dismissFailure()
        XCTAssertEqual(
            model.actions,
            [.retry, .set(.badgeInbox, enabled: true), .setProblemsLevel(.all), .dismissFailure]
        )
    }

    @MainActor
    func testAPermissionRequestReachesTheRouterOnceAlsoWhenRaisedBeforeObservation() async throws {
        let model = ScriptedNotificationSettingsScreenModel(state: NotificationSettingsState())
        let router = RouterSpy()
        let viewModel = NotificationSettingsViewModel(model: model, router: router)
        model.emit(.requestPermission)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        try await eventually { router.permissionRequests == 1 }
        model.emit(.requestPermission)
        try await eventually { router.permissionRequests == 2 }
        XCTAssertEqual(router.pages, [])
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedNotificationSettingsScreenModel?
        var viewModel: NotificationSettingsViewModel?
        do {
            let model = ScriptedNotificationSettingsScreenModel(state: NotificationSettingsState())
            weakModel = model
            viewModel = NotificationSettingsViewModel(model: model, router: RouterSpy())
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    func testEverySwitchReadsItsOwnValue() {
        var choices = NotificationChoices(
            approvals: false,
            invites: false,
            reminders: false,
            problemsSummary: false,
            badgeApprovals: false,
            badgeInvites: false,
            badgeInbox: false
        )
        for choice in AccountNotificationSwitch.allCases {
            XCTAssertFalse(choices.isOn(choice))
        }
        choices.badgeInvites = true
        XCTAssertEqual(AccountNotificationSwitch.allCases.filter(choices.isOn), [.badgeInvites])
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
