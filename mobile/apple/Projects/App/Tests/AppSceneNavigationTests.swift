import CoreKit
import NavigatorUI
import SwiftUI
import XCTest

@testable import Alldots

/// The navigation of a shown `AppScene` on its real NavigatorUI stacks: each tab registers its own stack, a route
/// reaches the stack of its tab with its presentation, and the scene provides each destination's screen.
final class AppSceneNavigationTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testEveryTabRegistersItsOwnStack() async throws {
        for tab in [AppTab.overview, .calendar, .journal] {
            let window = try SceneWindow()
            let scene = AppComposition(models: SignedInModels())
            try await window.show(AppScene(composition: scene, selectedTab: tab))
            let stack = try await registeredStack(tab, of: scene)
            XCTAssertEqual(stack.navigator.count, 0, "A new scene shows the root of the \(tab) tab")
            window.close()
        }
    }

    @MainActor
    func testAPushedDestinationShowsItsScreenOnTheStackOfItsTab() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        let overview = try await registeredStack(.overview, of: scene)

        scene.navigation.push(.pending(title: "Inbox"), in: .overview)
        XCTAssertEqual(overview.navigator.count, 1, "The destination must be pushed onto the Overview stack")
        XCTAssertNil(overview.navigator.presentingSheetOrCover, "The destination must not be presented")
        try await eventually { window.stackTitle == "Inbox" }
        XCTAssertEqual(window.stackTitle, "Inbox", "The Overview tab must show the pushed screen on top")
        XCTAssertFalse(window.presentsSheet)
        window.close()
    }

    @MainActor
    func testASheetIsPresentedOverTheStackOfItsTab() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene, selectedTab: .calendar))
        let calendar = try await registeredStack(.calendar, of: scene)

        scene.navigation.presentSheet(.pending(title: "Profile"), from: .calendar)
        XCTAssertEqual(calendar.navigator.presentingSheetOrCover as? AppDestination, .pending(title: "Profile"))
        XCTAssertEqual(calendar.navigator.count, 0, "The sheet must be presented, not pushed")
        try await eventually { calendar.navigator.isPresenting && window.presentsSheet }
        XCTAssertTrue(calendar.navigator.isPresenting, "The Calendar stack must present the sheet")
        XCTAssertTrue(window.presentsSheet, "The window must show the sheet")
        window.close()
    }
}

// MARK: - Helpers
private extension AppSceneNavigationTests {

    /// The stack registered for `tab`, once the tab's stack appeared and registered.
    @MainActor
    func registeredStack(_ tab: AppTab, of scene: AppComposition) async throws -> NavigatorStackAdapter {
        try await eventually { scene.navigation.stack(for: tab) != nil }
        return try XCTUnwrap(
            scene.navigation.stack(for: tab) as? NavigatorStackAdapter,
            "The \(tab) tab must register its NavigatorUI stack"
        )
    }
}
