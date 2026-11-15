import XCTest

/// The app end to end on an iOS simulator, on the real shared SDK and the app's navigation, as the user drives it.
/// Elements are found by the accessibility identifiers of the app and the features, each equal to the Android test
/// tag of the same element. The app starts on the sign-in form, because no server is signed in on a fresh simulator.
final class SmokeFlowTests: XCTestCase {

    // MARK: - Lifecycle
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: - Tests
    @MainActor
    func testAFreshLaunchShowsTheSessionGate() {
        let app = XCUIApplication()
        app.launch()
        let gate = app.descendants(matching: .any)[AppIdentifiers.sessionGate].firstMatch
        XCTAssertTrue(gate.waitForExistence(timeout: 15), "The app must start behind the session gate")
    }
}
