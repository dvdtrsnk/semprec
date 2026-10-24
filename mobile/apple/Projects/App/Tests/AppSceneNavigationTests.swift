import NavigatorUI
import SwiftUI
import XCTest

@testable import Semprec

/// The navigation of a shown `AppScene` on its real NavigatorUI stacks: each tab registers its own stack, a route
/// reaches the stack of its tab with its presentation, and the scene provides each destination's screen.
final class AppSceneNavigationTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testTheHomeRouterPushesTheItemsDetailOntoTheHomeTabsStack() async throws {
        let window = try SceneWindow()
        let scene = AppComposition()
        try await window.show(AppScene(composition: scene))
        let home = try await registeredStack(.home, of: scene)
        XCTAssertEqual(window.stackTitle, try Copy.home())

        scene.homeRouter.showDetail(itemId: "item-2")
        XCTAssertEqual(home.navigator.count, 1, "The detail must be pushed onto the Home stack")
        XCTAssertNil(home.navigator.presentingSheetOrCover, "The detail must not be presented")
        let detail = try Copy.detail()
        try await eventually { window.stackTitle == detail }
        XCTAssertEqual(window.stackTitle, detail, "The Home tab must show the detail screen on top")
        XCTAssertFalse(window.presentsSheet)
        window.close()
    }

    @MainActor
    func testTheSettingsRouterPresentsAboutAsASheetOverTheSettingsTabsStack() async throws {
        let window = try SceneWindow()
        let scene = AppComposition()
        try await window.show(AppScene(composition: scene, selectedTab: .settings))
        let settings = try await registeredStack(.settings, of: scene)

        scene.settingsRouter.showAbout()
        XCTAssertEqual(settings.navigator.presentingSheetOrCover as? AppDestination, .about)
        XCTAssertEqual(settings.navigator.count, 0, "About must be presented, not pushed")
        try await eventually { settings.navigator.isPresenting && window.presentsSheet }
        XCTAssertTrue(settings.navigator.isPresenting, "The Settings stack must present the sheet")
        XCTAssertTrue(window.presentsSheet, "The window must show the sheet")
        XCTAssertEqual(window.stackTitle, try Copy.settings(), "The Settings screen must stay under the sheet")
        #if os(iOS)
            // A macOS sheet window shows no title, so only iOS tells which screen the sheet shows.
            let about = try Copy.about()
            try await eventually { window.sheetTitle == about }
            XCTAssertEqual(window.sheetTitle, about, "The sheet must show the About screen")
        #endif
        window.close()
    }

    #if os(macOS)
        // A bordered push button, the macOS style of a button in a list, reacts only on its capsule around the label;
        // a list row reacts across its width.
        @MainActor
        func testClickingAHomeRowRightOfItsTitleOpensTheItemsDetail() async throws {
            let window = try SceneWindow()
            let scene = AppComposition()
            try await window.show(AppScene(composition: scene))
            let home = try await registeredStack(.home, of: scene)
            try await eventually(timeout: .seconds(10)) { (window.listRowCount ?? 0) > 0 }

            try window.clickRow(0, atFraction: 0.85)
            try await eventually { home.navigator.count == 1 }
            XCTAssertEqual(home.navigator.count, 1, "A click anywhere on a row must open its detail")
            let detail = try Copy.detail()
            try await eventually { window.stackTitle == detail }
            XCTAssertEqual(window.stackTitle, detail)
            window.close()
        }

        @MainActor
        func testClickingTheAboutRowRightOfItsLabelPresentsAbout() async throws {
            let window = try SceneWindow()
            let scene = AppComposition()
            try await window.show(AppScene(composition: scene, selectedTab: .settings))
            let settings = try await registeredStack(.settings, of: scene)
            try await eventually(timeout: .seconds(10)) { (window.listRowCount ?? 0) > 0 }

            try window.clickRow(0, atFraction: 0.85)
            try await eventually { window.presentsSheet }
            XCTAssertEqual(settings.navigator.presentingSheetOrCover as? AppDestination, .about)
            XCTAssertTrue(window.presentsSheet, "A click anywhere on the row must present About")
            window.close()
        }
    #endif
}

// MARK: - Helpers
private extension AppSceneNavigationTests {

    /// The stack registered for `tab`, once the tab's stack appeared and registered.
    @MainActor
    func registeredStack(_ tab: AppTab, of scene: AppComposition) async throws -> NavigatorStackAdapter {
        try await eventually { scene.navigation.stack(for: tab) != nil }
        return try XCTUnwrap(
            scene.navigation.stack(for: tab) as? NavigatorStackAdapter,
            "The \(tab) tab must register its NavigatorUI stack for \(tab)"
        )
    }
}

// MARK: - Copy
/// Navigation titles of the screens, in the language of the test scheme, from the String Catalogs of the features.
private enum Copy {

    static func home() throws -> String { try text("home.title", of: "HomeFeature") }
    static func detail() throws -> String { try text("detail.title", of: "HomeFeature") }
    static func settings() throws -> String { try text("settings.title", of: "SettingsFeature") }
    static func about() throws -> String { try text("about.title", of: "SettingsFeature") }

    /// The text of `key` in the framework `module`, whose bundle identifier extends the app's.
    private static func text(_ key: String, of module: String) throws -> String {
        let app = try XCTUnwrap(Bundle.main.bundleIdentifier, "The tests must run in the app")
        let bundle = try XCTUnwrap(Bundle(identifier: "\(app).\(module)"), "The app must load \(module)")
        let text = bundle.localizedString(forKey: key, value: nil, table: nil)
        XCTAssertNotEqual(text, key, "\(module) must have a text for \(key)")
        return text
    }
}
