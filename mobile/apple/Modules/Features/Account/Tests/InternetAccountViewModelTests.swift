import AuthenticationServices
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

    @MainActor
    func testTheListOpensTheSignInPageInTheBrowserItStartedWithAndReportsHowItEnded() async throws {
        let callback = try XCTUnwrap(URL(string: "semprec://oauth?state=s&code=c"))
        let outcomes: [(BrowserSignIn, InternetAccountsAction)] = [
            (BrowserSignIn { _ in callback }, .signInReturned(callbackUrl: callback.absoluteString)),
            (BrowserSignIn { _ in throw ASWebAuthenticationSessionError(.canceledLogin) }, .signInCancelled),
            (BrowserSignIn { _ in throw ASWebAuthenticationSessionError(.presentationContextInvalid) }, .signInFailed)
        ]
        for (browser, end) in outcomes {
            let model = ScriptedInternetAccountsScreenModel(state: InternetAccountsState())
            let viewModel = InternetAccountsViewModel(model: model, router: RouterSpy())
            viewModel.signIn(.google, calendars: true, browser: browser)
            let observer = Task { await viewModel.observe() }
            model.emit(.openSignIn(url: "https://accounts.google.com/o/oauth2/v2/auth?state=s"))
            try await eventually { model.actions.count == 2 }
            observer.cancel()
            XCTAssertEqual(model.actions, [.startSignIn(provider: .google, calendars: true), end])
        }
    }

    @MainActor
    func testASignInPageWithoutABrowserOrAnAddressFails() async throws {
        let model = ScriptedInternetAccountsScreenModel(state: InternetAccountsState())
        let viewModel = InternetAccountsViewModel(model: model, router: RouterSpy())
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.openSignIn(url: "https://accounts.google.com"))
        try await eventually { model.actions == [.signInFailed] }
        let opened = Opened()
        let browser = BrowserSignIn { url in
            opened.urls.append(url)
            return url
        }
        viewModel.signIn(.microsoft, calendars: false, browser: browser)
        model.emit(.openSignIn(url: ""))
        try await eventually { model.actions.count == 3 }
        XCTAssertEqual(model.actions.last, .signInFailed)
        XCTAssertEqual(opened.urls, [])
    }

    @MainActor
    func testTheListSignsAnAccountInAgainInTheBrowserItStartedWith() async throws {
        let callback = try XCTUnwrap(URL(string: "semprec://oauth?state=s&code=c"))
        let model = ScriptedInternetAccountsScreenModel(state: InternetAccountsState())
        let viewModel = InternetAccountsViewModel(model: model, router: RouterSpy())
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        let opened = Opened()
        viewModel.signInAgain(
            accountId: "m1",
            browser: BrowserSignIn { url in
                opened.urls.append(url)
                return callback
            }
        )
        model.emit(.openSignIn(url: "https://accounts.google.com/a"))
        try await eventually { model.actions.count == 2 }
        XCTAssertEqual(
            model.actions,
            [.signInAgain(accountId: "m1"), .signInReturned(callbackUrl: callback.absoluteString)]
        )
        XCTAssertEqual(opened.urls.map(\.absoluteString), ["https://accounts.google.com/a"])
    }

    @MainActor
    func testTheListForwardsThePasswordSignInAndOpeningTheExistingAccount() {
        let model = ScriptedInternetAccountsScreenModel(state: InternetAccountsState())
        let viewModel = InternetAccountsViewModel(model: model, router: RouterSpy())
        let actions: [InternetAccountsAction] = [
            .passwordSignIn(.submit(password: "pw", username: "")),
            .passwordSignIn(.cancel),
            .openExisting,
            .dismissSignInFailure
        ]
        actions.forEach(viewModel.send)
        XCTAssertEqual(model.actions, actions)
    }

    @MainActor
    func testTheAccountForwardsThePasswordSignIn() {
        let model = ScriptedInternetAccountScreenModel(state: InternetAccountState())
        let viewModel = InternetAccountViewModel(model: model, router: RouterSpy())
        let actions: [InternetAccountAction] = [
            .passwordSignIn(.submit(password: "pw", username: "me@firma.cz")),
            .passwordSignIn(.cancel)
        ]
        actions.forEach(viewModel.send)
        XCTAssertEqual(model.actions, actions)
    }

    // MARK: - Account
    @MainActor
    func testTheAccountSignsInAgainAndAllowsCalendarsInTheBrowserItStartedWith() async throws {
        let callback = try XCTUnwrap(URL(string: "semprec://oauth?state=s&error=access_denied"))
        let model = ScriptedInternetAccountScreenModel(state: InternetAccountState())
        let viewModel = InternetAccountViewModel(model: model, router: RouterSpy())
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        let opened = Opened()
        viewModel.signInAgain(
            browser: BrowserSignIn { url in
                opened.urls.append(url)
                return callback
            }
        )
        model.emit(.openSignIn(url: "https://login.microsoftonline.com/a"))
        try await eventually { model.actions.count == 2 }
        viewModel.allowCalendarAccess(browser: BrowserSignIn { _ in throw CancellationError() })
        model.emit(.openSignIn(url: "https://login.microsoftonline.com/b"))
        try await eventually { model.actions.count == 4 }
        let expected: [InternetAccountAction] = [
            .signIn(.again),
            .signIn(.returned(callbackUrl: callback.absoluteString)),
            .signIn(.allowCalendarAccess),
            .signIn(.cancelled)
        ]
        XCTAssertEqual(model.actions, expected)
        XCTAssertEqual(opened.urls.map(\.absoluteString), ["https://login.microsoftonline.com/a"])
    }

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

/// The pages a scripted browser was asked to open.
@MainActor
private final class Opened {

    var urls: [URL] = []
}
