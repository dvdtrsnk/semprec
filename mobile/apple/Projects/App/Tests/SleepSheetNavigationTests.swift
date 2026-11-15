import NavigatorUI
import SwiftUI
import XCTest

@testable import Semprec

/// The sleep sheets of the app: a Calendar router, which another slice adds, presents them over its tab's stack, and
/// the scene provides the sheet's screen.
final class SleepSheetNavigationTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testTheSleepNightSheetIsPresentedOverTheStackAndNotPushed() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .home) != nil }
        let home = try XCTUnwrap(scene.navigation.stack(for: .home) as? NavigatorStackAdapter)

        scene.navigation.presentSheet(.sleepNight(night: "2026-10-16"), from: .home)

        XCTAssertEqual(home.navigator.presentingSheetOrCover as? AppDestination, .sleepNight(night: "2026-10-16"))
        XCTAssertEqual(home.navigator.count, 0, "The sheet must be presented, not pushed")
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet, "The window must show the sleep sheet")
        window.close()
    }

    @MainActor
    func testTheSleepPlanSheetIsPresentedWithoutANight() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .home) != nil }
        let home = try XCTUnwrap(scene.navigation.stack(for: .home) as? NavigatorStackAdapter)

        scene.navigation.presentSheet(.sleepPlan(night: nil), from: .home)

        XCTAssertEqual(home.navigator.presentingSheetOrCover as? AppDestination, .sleepPlan(night: nil))
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet)
        window.close()
    }
}
