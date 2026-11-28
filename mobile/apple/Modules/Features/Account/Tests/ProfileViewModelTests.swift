import CoreKit
import XCTest

@testable import AccountFeature

final class ProfileViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedProfileScreenModel(state: ProfileState(email: "a@b.cz"))
        let viewModel = ProfileViewModel(model: model, router: RouterSpy())
        XCTAssertEqual(viewModel.state.email, "a@b.cz")
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(ProfileState(phase: .content, email: "a@b.cz", locale: "en"))
        try await eventually { viewModel.state.locale == "en" }
        XCTAssertEqual(viewModel.state.phase, .content)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedProfileScreenModel(state: ProfileState())
        let viewModel = ProfileViewModel(model: model, router: RouterSpy())
        viewModel.retry()
        viewModel.open(.trash)
        viewModel.changeLocale("en")
        viewModel.requestPasswordReset()
        viewModel.signOut()
        viewModel.dismissFailure()
        XCTAssertEqual(
            model.actions,
            [.retry, .open(.trash), .changeLocale("en"), .requestPasswordReset, .signOut, .dismissFailure]
        )
    }

    @MainActor
    func testEveryPageTheModelRaisesReachesTheRouterOnce() async throws {
        let router = RouterSpy()
        let model = ScriptedProfileScreenModel(state: ProfileState())
        let viewModel = ProfileViewModel(model: model, router: router)
        // Raised before anyone observes: it waits for the observer.
        model.emit(.devices)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.emit(.aiUsage)
        model.emit(.internetAccounts)
        try await eventually { router.pages.count == 3 }
        XCTAssertEqual(router.pages, [.devices, .aiUsage, .internetAccounts])
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedProfileScreenModel?
        var viewModel: ProfileViewModel?
        do {
            let model = ScriptedProfileScreenModel(state: ProfileState())
            weakModel = model
            viewModel = ProfileViewModel(model: model, router: RouterSpy())
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
final class RouterSpy: AccountRouting {

    // MARK: - Properties
    private(set) var pages: [AccountPage] = []
    private(set) var internetAccounts: [String] = []
    private(set) var permissionRequests = 0

    // MARK: - Protocol conformance
    func show(_ page: AccountPage) {
        pages.append(page)
    }

    func showInternetAccount(accountId: String) {
        internetAccounts.append(accountId)
    }

    func requestNotificationPermission() {
        permissionRequests += 1
    }
}
