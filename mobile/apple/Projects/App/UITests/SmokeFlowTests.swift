import XCTest

/// The placeholder app end to end on an iOS simulator, on the real shared SDK and the app's navigation, as the user
/// drives it. Elements are found by the accessibility identifiers of the app and the features, each equal to the
/// Android test tag of the same element, so these flows match Android's SmokeFlowTest.
final class SmokeFlowTests: XCTestCase {

    // MARK: - Lifecycle
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: - Tests
    @MainActor
    func testTheHomeListOpensTheDetailAndBackReturnsToTheList() {
        let app = launch()
        let row = app.buttons[HomeIdentifiers.itemPrefix + "item-2"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        let title = row.label
        row.tap()
        let detailTitle = app.staticTexts[HomeIdentifiers.detailTitle]
        XCTAssertTrue(detailTitle.waitForExistence(timeout: 10))
        XCTAssertEqual(detailTitle.label, title, "The detail must show the item of the tapped row")

        goBack(in: app)
        XCTAssertTrue(element(HomeIdentifiers.detailScreen, in: app).waitForNonExistence(timeout: 10))
        XCTAssertTrue(element(HomeIdentifiers.screen, in: app).exists)

        // A reopened detail gets a new shared ViewModel and must show its item rather than stay loading.
        let other = app.buttons[HomeIdentifiers.itemPrefix + "item-1"]
        let otherTitle = other.label
        other.tap()
        XCTAssertTrue(detailTitle.waitForExistence(timeout: 10))
        XCTAssertEqual(detailTitle.label, otherTitle)
    }

    @MainActor
    func testTheAboutRowPresentsTheAboutSheetWithTheAppVersionAndDoneDismissesIt() throws {
        let app = launch()
        tab(AppIdentifiers.settingsTab, in: app).tap()
        let row = app.buttons[SettingsIdentifiers.aboutRow]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let about = element(SettingsIdentifiers.aboutScreen, in: app)
        XCTAssertTrue(about.waitForExistence(timeout: 10))

        // This bundle is built with the app's version and build number.
        let bundle = Bundle(for: Self.self)
        let version = try XCTUnwrap(bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
        let build = try XCTUnwrap(bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
        let versionLine = about.staticTexts
            .containing(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", version, build))
            .firstMatch
        XCTAssertTrue(versionLine.exists, "The About sheet must show version \(version) and build \(build)")

        app.buttons[SettingsIdentifiers.aboutDone].tap()
        XCTAssertTrue(about.waitForNonExistence(timeout: 10))
        XCTAssertTrue(element(SettingsIdentifiers.screen, in: app).exists)
    }

    @MainActor
    func testEachTabKeepsItsOwnStackWhenTheUserSwitchesTabs() {
        let app = launch()
        let row = app.buttons[HomeIdentifiers.itemPrefix + "item-3"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        let title = row.label
        row.tap()
        let detailTitle = app.staticTexts[HomeIdentifiers.detailTitle]
        XCTAssertTrue(detailTitle.waitForExistence(timeout: 10))

        tab(AppIdentifiers.settingsTab, in: app).tap()
        XCTAssertTrue(element(SettingsIdentifiers.screen, in: app).waitForExistence(timeout: 10))
        tab(AppIdentifiers.homeTab, in: app).tap()
        XCTAssertTrue(detailTitle.waitForExistence(timeout: 10), "The Home tab must still show the detail")
        XCTAssertEqual(detailTitle.label, title)

        goBack(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10))
    }
}

// MARK: - Helpers
private extension SmokeFlowTests {

    @MainActor
    func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()
        return app
    }

    /// The element with `identifier`, of any type.
    @MainActor
    func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    /// The tab bar button with `identifier`, once it exists: the identifiers of the tabs reach the accessibility tree
    /// a few seconds after launch.
    @MainActor
    func tab(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        let tab = app.buttons[identifier].firstMatch
        XCTAssertTrue(tab.waitForExistence(timeout: 15), "The tab \(identifier) must exist")
        return tab
    }

    /// Taps the system back button, found by the identifier the system gives it, `BackButton`, anywhere in the app:
    /// on the other iPhone simulators it sits in the navigation bar, while the iOS 27.1 "iPhone Duo" simulator places
    /// it in a toolbar outside the navigation bar, where `app.navigationBars` does not find it.
    @MainActor
    func goBack(in app: XCUIApplication) {
        let back = app.descendants(matching: .any)["BackButton"].firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 10), "The screen must offer the system Back button")
        back.tap()
    }
}
