import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the bridges' mappings between Kotlin and Swift values with Kotlin values built here. The
/// in-memory repository behind `HomeSDK` never fails and is never empty, so the real ViewModels never reach most of
/// these branches. Both modules declare most of these type names, so each is qualified with its module.
final class SharedMappingTests: XCTestCase {

    // MARK: - Home
    @MainActor
    func testHomeMapsEveryPhase() {
        let items = [SharedSDK.HomeItem(id: "item-7", ordinal: 7), SharedSDK.HomeItem(id: "item-3", ordinal: 3)]
        XCTAssertEqual(SharedHomeScreenModel.state(homeState(.loading)), .loading)
        XCTAssertEqual(
            SharedHomeScreenModel.state(homeState(.content, items: items)),
            .content([
                CoreKit.PlaceholderItem(id: "item-7", ordinal: 7),
                CoreKit.PlaceholderItem(id: "item-3", ordinal: 3)
            ])
        )
        XCTAssertEqual(SharedHomeScreenModel.state(homeState(.empty)), .empty)
    }

    @MainActor
    func testHomeMapsEachFailure() {
        XCTAssertEqual(SharedHomeScreenModel.state(homeState(.error, failure: .unavailable)), .failure(.unavailable))
        XCTAssertEqual(SharedHomeScreenModel.state(homeState(.error, failure: .invalidData)), .failure(.invalidData))
        XCTAssertEqual(SharedHomeScreenModel.state(homeState(.error)), .failure(nil))
    }

    @MainActor
    func testHomeMapsEachAction() {
        XCTAssertEqual(SharedHomeScreenModel.action(.retry) as? NSObject, SharedSDK.HomeActionRetry.shared)
        XCTAssertEqual(
            SharedHomeScreenModel.action(.selectItem(id: "item-2")) as? NSObject,
            SharedSDK.HomeActionSelectItem(id: "item-2")
        )
    }

    @MainActor
    func testHomeMapsEachEffect() {
        XCTAssertEqual(
            SharedHomeScreenModel.effect(SharedSDK.HomeEffectOpenDetail(id: "item-4")),
            .openDetail(id: "item-4")
        )
    }

    // MARK: - Detail
    @MainActor
    func testDetailMapsEveryPhase() {
        XCTAssertEqual(SharedDetailScreenModel.state(detailState(.loading)), .loading)
        XCTAssertEqual(
            SharedDetailScreenModel.state(detailState(.content, item: SharedSDK.HomeItem(id: "item-3", ordinal: 3))),
            .content(CoreKit.PlaceholderItem(id: "item-3", ordinal: 3))
        )
        XCTAssertEqual(SharedDetailScreenModel.state(detailState(.notFound)), .notFound)
    }

    @MainActor
    func testDetailContentWithoutAnItemIsAnUnexpectedFailure() {
        XCTAssertEqual(SharedDetailScreenModel.state(detailState(.content)), .failure(nil))
    }

    @MainActor
    func testDetailMapsEachFailure() {
        XCTAssertEqual(
            SharedDetailScreenModel.state(detailState(.error, failure: .unavailable)),
            .failure(.unavailable)
        )
        XCTAssertEqual(
            SharedDetailScreenModel.state(detailState(.error, failure: .invalidData)),
            .failure(.invalidData)
        )
        XCTAssertEqual(SharedDetailScreenModel.state(detailState(.error)), .failure(nil))
    }

    @MainActor
    func testDetailMapsEachAction() {
        XCTAssertEqual(SharedDetailScreenModel.action(.retry) as? NSObject, SharedSDK.DetailActionRetry.shared)
    }

    // MARK: - Settings
    @MainActor
    func testSettingsMapsTheRowsInOrder() {
        XCTAssertEqual(
            SharedSettingsScreenModel.state(SharedSDK.SettingsState(rows: [.about])),
            CoreKit.SettingsState(rows: [.about])
        )
        XCTAssertEqual(
            SharedSettingsScreenModel.state(SharedSDK.SettingsState(rows: [])),
            CoreKit.SettingsState(rows: [])
        )
    }

    @MainActor
    func testSettingsMapsEachAction() {
        XCTAssertEqual(
            SharedSettingsScreenModel.action(.selectRow(.about)) as? NSObject,
            SharedSDK.SettingsActionSelectRow(row: .about)
        )
    }

    @MainActor
    func testSettingsMapsEachEffect() {
        XCTAssertEqual(SharedSettingsScreenModel.effect(SharedSDK.SettingsEffectShowAbout.shared), .showAbout)
    }

    // MARK: - Shared values
    func testFailureKindMapsEachKotlinKind() {
        XCTAssertEqual(CoreKit.FailureKind(SharedSDK.FailureKind.unavailable), .unavailable)
        XCTAssertEqual(CoreKit.FailureKind(SharedSDK.FailureKind.invalidData), .invalidData)
    }

    func testSettingsRowMapsEachRowBothWays() {
        XCTAssertEqual(CoreKit.SettingsRow(SharedSDK.SettingsRow.about), .about)
        XCTAssertEqual(CoreKit.SettingsRow.about.shared, SharedSDK.SettingsRow.about)
    }
}

// MARK: - Helpers
private extension SharedMappingTests {

    func homeState(
        _ phase: SharedSDK.HomePhase,
        items: [SharedSDK.HomeItem] = [],
        failure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.HomeState {
        SharedSDK.HomeState(phase: phase, items: items, failure: failure)
    }

    func detailState(
        _ phase: SharedSDK.DetailPhase,
        item: SharedSDK.HomeItem? = nil,
        failure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.DetailState {
        SharedSDK.DetailState(phase: phase, item: item, failure: failure)
    }

    // MARK: - Failures
    @MainActor
    func testEveryKotlinFailureKindMaps() {
        XCTAssertEqual(CoreKit.FailureKind(SharedSDK.FailureKind.unavailable), .unavailable)
        XCTAssertEqual(CoreKit.FailureKind(SharedSDK.FailureKind.invalidData), .invalidData)
        XCTAssertEqual(CoreKit.FailureKind(SharedSDK.FailureKind.unauthorized), .unauthorized)
        XCTAssertEqual(CoreKit.FailureKind(SharedSDK.FailureKind.notFound), .notFound)
        XCTAssertEqual(CoreKit.FailureKind(SharedSDK.FailureKind.rejected), .rejected)
    }

    // MARK: - Session
    @MainActor
    func testSessionMapsEveryPhase() {
        XCTAssertEqual(SharedSessionScreenModel.state(sessionState(.restoring)), .restoring)
        XCTAssertEqual(SharedSessionScreenModel.state(sessionState(.signedOut)), .signedOut)
        XCTAssertEqual(SharedSessionScreenModel.state(sessionState(.unreachable)), .unreachable)
        XCTAssertEqual(
            SharedSessionScreenModel.state(
                sessionState(.signedIn, email: "a@b.cz", role: "admin", serverUrl: "https://s.example")
            ),
            .signedIn(SessionUser(email: "a@b.cz", role: "admin", serverUrl: "https://s.example"))
        )
    }

    @MainActor
    func testSessionSignedInDefaultsTheRoleAndWithoutAnAccountIsSignedOut() {
        XCTAssertEqual(
            SharedSessionScreenModel.state(sessionState(.signedIn, email: "a@b.cz", serverUrl: "https://s.example")),
            .signedIn(SessionUser(email: "a@b.cz", role: "member", serverUrl: "https://s.example"))
        )
        XCTAssertEqual(SharedSessionScreenModel.state(sessionState(.signedIn)), .signedOut)
        XCTAssertEqual(SharedSessionScreenModel.state(sessionState(.signedIn, email: "a@b.cz")), .signedOut)
    }

    @MainActor
    func testSessionMapsEveryAction() {
        XCTAssertTrue(SharedSessionScreenModel.action(.retry) is SharedSDK.SessionActionRetry)
        XCTAssertTrue(SharedSessionScreenModel.action(.signOut) is SharedSDK.SessionActionSignOut)
    }

    // MARK: - Login
    @MainActor
    func testLoginMapsEveryPhase() {
        XCTAssertEqual(
            SharedLoginScreenModel.state(loginState(.editing)),
            .editing(resetRequested: false)
        )
        XCTAssertEqual(
            SharedLoginScreenModel.state(loginState(.editing, resetRequested: true)),
            .editing(resetRequested: true)
        )
        XCTAssertEqual(SharedLoginScreenModel.state(loginState(.signingIn)), .signingIn)
        XCTAssertEqual(SharedLoginScreenModel.state(loginState(.failed, failure: .unauthorized)), .failed(.unauthorized))
        XCTAssertEqual(SharedLoginScreenModel.state(loginState(.failed)), .failed(nil))
    }

    @MainActor
    func testLoginMapsEveryAction() throws {
        let signIn = try XCTUnwrap(
            SharedLoginScreenModel.action(.signIn(server: "s", email: "e", password: "p"))
                as? SharedSDK.LoginActionSignIn
        )
        XCTAssertEqual([signIn.server, signIn.email, signIn.password], ["s", "e", "p"])
        let forgot = try XCTUnwrap(
            SharedLoginScreenModel.action(.forgotPassword(server: "s", email: "e")) as? SharedSDK.LoginActionForgotPassword
        )
        XCTAssertEqual([forgot.server, forgot.email], ["s", "e"])
        XCTAssertTrue(SharedLoginScreenModel.action(.edited) is SharedSDK.LoginActionEdited)
    }

    // MARK: - Builders
    func sessionState(
        _ phase: SharedSDK.SessionPhase,
        email: String? = nil,
        role: String? = nil,
        serverUrl: String? = nil
    ) -> SharedSDK.SessionState {
        SharedSDK.SessionState(phase: phase, email: email, role: role, serverUrl: serverUrl)
    }

    func loginState(
        _ phase: SharedSDK.LoginPhase,
        failure: SharedSDK.FailureKind? = nil,
        resetRequested: Bool = false
    ) -> SharedSDK.LoginState {
        SharedSDK.LoginState(phase: phase, failure: failure, resetRequested: resetRequested)
    }
}
