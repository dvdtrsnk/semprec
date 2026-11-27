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

    /// Opens the wake settings from the sleep sheet of the Calendar. It needs a signed-in session, which a fresh
    /// simulator does not have, so it is skipped there and runs on a simulator that is signed in to a server.
    @MainActor
    func testTheWakeSettingsOpenFromTheSleepSheet() throws {
        let app = XCUIApplication()
        app.launch()
        let calendarTab = app.descendants(matching: .any)[AppIdentifiers.calendarTab].firstMatch
        try XCTSkipUnless(calendarTab.waitForExistence(timeout: 15), "The app is signed out, so it has no sleep sheet")
        calendarTab.tap()
        let calendars = app.descendants(matching: .any)["calendar.calendars"].firstMatch
        XCTAssertTrue(calendars.waitForExistence(timeout: 10), "The Calendar must offer its calendars")
        calendars.tap()
        let sleepInfo = app.descendants(matching: .any)["calendars.info.sleep"].firstMatch
        XCTAssertTrue(sleepInfo.waitForExistence(timeout: 10), "The sleep calendar must offer its sheet")
        sleepInfo.tap()

        let wakeSettings = app.descendants(matching: .any)[SleepIdentifiers.wakeSettings].firstMatch
        XCTAssertTrue(wakeSettings.waitForExistence(timeout: 10), "The sleep sheet must offer the wake settings")
        wakeSettings.tap()

        let screen = app.descendants(matching: .any)[SleepIdentifiers.wakeScreen].firstMatch
        XCTAssertTrue(screen.waitForExistence(timeout: 10), "The wake settings must open")
        XCTAssertTrue(app.descendants(matching: .any)[SleepIdentifiers.wakeRequiresCode].firstMatch.exists)
    }

    /// Opens the debug alarm tool from the profile sheet, which is in every build. It needs a signed-in session, so it
    /// is skipped on a fresh simulator. The Simulator has no AlarmKit, so the tool shows its permission as unavailable.
    @MainActor
    func testTheDebugAlarmToolOpensFromTheProfileSheet() throws {
        let app = XCUIApplication()
        app.launch()
        let profile = app.descendants(matching: .any)[OverviewIdentifiers.profile].firstMatch
        try XCTSkipUnless(profile.waitForExistence(timeout: 15), "The app is signed out, so it has no profile button")
        profile.tap()
        let debugOpen = app.descendants(matching: .any)[AppIdentifiers.debugOpen].firstMatch
        XCTAssertTrue(debugOpen.waitForExistence(timeout: 10), "The profile sheet must offer the debug menu")
        debugOpen.tap()

        let menu = app.descendants(matching: .any)[AppIdentifiers.debugMenu].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "The debug menu must open")
        app.descendants(matching: .any)[AppIdentifiers.debugAlarmsRow].firstMatch.tap()

        let screen = app.descendants(matching: .any)[AppIdentifiers.debugAlarmScreen].firstMatch
        XCTAssertTrue(screen.waitForExistence(timeout: 10), "The alarm tool must open")
        XCTAssertTrue(app.descendants(matching: .any)[AppIdentifiers.debugAlarmPermission].firstMatch.exists)
    }
}
