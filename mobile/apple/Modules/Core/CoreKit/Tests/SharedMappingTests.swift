import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the bridges' mappings between Kotlin and Swift values with Kotlin values built here. Both
/// modules declare most of these type names, so each is qualified with its module.
final class SharedMappingTests: XCTestCase {

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
