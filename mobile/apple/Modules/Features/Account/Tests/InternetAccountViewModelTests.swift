import CoreKit
import XCTest

@testable import AccountFeature

final class InternetAccountViewModelTests: XCTestCase {

    // MARK: - List
    @MainActor
    func testTheListRoutesTheOpenedAccountAndCountsConnections() async throws {
        let router = RouterSpy()
        let model = ScriptedInternetAccountsScreenModel(state: InternetAccountsState())
        let viewModel = InternetAccountsViewModel(model: model, router: router)
        // Raised before anyone observes: it waits for the observer.
        model.emit(.openAccount(accountId: "m1"))
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.connected)
        try await eventually { router.internetAccounts.count == 1 && viewModel.connections == 1 }
        XCTAssertEqual(router.internetAccounts, ["m1"])
    }

    @MainActor
    func testTheListForwardsTheConnectForm() {
        let model = ScriptedInternetAccountsScreenModel(state: InternetAccountsState())
        let viewModel = InternetAccountsViewModel(model: model, router: RouterSpy())
        let connect = InternetAccountsAction.connect(
            provider: .other, address: "a@b.cz", password: "pw", imapHost: "i", smtpHost: "s", caldavUrl: ""
        )
        viewModel.send(connect)
        viewModel.send(.dismissConnectFailure)
        XCTAssertEqual(model.actions, [connect, .dismissConnectFailure])
    }

    // MARK: - Account
    @MainActor
    func testCalendarsSwitchedOnAsksTheRouterForThePermissionToNotify() async throws {
        let router = RouterSpy()
        let model = ScriptedInternetAccountScreenModel(state: InternetAccountState())
        let viewModel = InternetAccountViewModel(model: model, router: router)
        viewModel.send(.setService(.calendars, enabled: true))
        XCTAssertEqual(model.actions, [.setService(.calendars, enabled: true)])
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.calendarsTurnedOn)
        try await eventually { router.permissionRequests == 1 }
        XCTAssertEqual(viewModel.closeRequests, 0)
    }

    @MainActor
    func testTheAccountRequestsToCloseWhenItWasRemoved() async throws {
        let router = RouterSpy()
        let model = ScriptedInternetAccountScreenModel(state: InternetAccountState())
        let viewModel = InternetAccountViewModel(model: model, router: router)
        viewModel.send(.requestRemoval)
        XCTAssertEqual(model.actions, [.requestRemoval])
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.removed)
        try await eventually { viewModel.closeRequests == 1 }
        XCTAssertEqual(router.permissionRequests, 0)
    }

    @MainActor
    func testReleasingTheViewModelsReleasesTheirModels() {
        weak var weakList: ScriptedInternetAccountsScreenModel?
        weak var weakAccount: ScriptedInternetAccountScreenModel?
        var list: InternetAccountsViewModel?
        var account: InternetAccountViewModel?
        do {
            let listModel = ScriptedInternetAccountsScreenModel(state: InternetAccountsState())
            let accountModel = ScriptedInternetAccountScreenModel(state: InternetAccountState())
            weakList = listModel
            weakAccount = accountModel
            list = InternetAccountsViewModel(model: listModel, router: RouterSpy())
            account = InternetAccountViewModel(model: accountModel, router: RouterSpy())
        }
        XCTAssertNotNil(weakList)
        XCTAssertNotNil(weakAccount)
        list = nil
        account = nil
        XCTAssertNil(weakList)
        XCTAssertNil(weakAccount)
        XCTAssertNil(list)
        XCTAssertNil(account)
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
