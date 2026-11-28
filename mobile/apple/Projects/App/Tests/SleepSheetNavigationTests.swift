import CoreKit
import NavigatorUI
import SwiftUI
import XCTest

@testable import Alldots

/// The sleep sheets of the app: they are presented over a tab's stack and not pushed, and the scene provides the
/// sheet's screen.
final class SleepSheetNavigationTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testTheSleepNightSheetIsPresentedOverTheStackAndNotPushed() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        let stack = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)

        scene.navigation.presentSheet(.sleepNight(night: "2026-10-16"), from: .overview)

        XCTAssertEqual(stack.navigator.presentingSheetOrCover as? AppDestination, .sleepNight(night: "2026-10-16"))
        XCTAssertEqual(stack.navigator.count, 0, "The sheet must be presented, not pushed")
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet, "The window must show the sleep sheet")
        window.close()
    }

    @MainActor
    func testTheSleepPlanSheetIsPresentedWithoutANight() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        let stack = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)

        scene.navigation.presentSheet(.sleepPlan(night: nil), from: .overview)

        XCTAssertEqual(stack.navigator.presentingSheetOrCover as? AppDestination, .sleepPlan(night: nil))
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet)
        window.close()
    }

    @MainActor
    func testTheWakeSettingsAreAnotherSheetOfTheSameStackThatTakesThePlaceOfTheSleepSheet() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        let stack = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)
        scene.navigation.presentSheet(.sleepPlan(night: nil), from: .overview)
        try await eventually { window.presentsSheet }
        scene.currentTab = .overview

        scene.sleepRouter.showWakeSettings()

        XCTAssertEqual(stack.navigator.presentingSheetOrCover as? AppDestination, .sleepWakeSettings)
        XCTAssertEqual(stack.navigator.count, 0, "The wake settings must be presented, not pushed")
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet)
        window.close()
    }

    // MARK: - Wake guard
    @MainActor
    func testAWakeMissionThatStartsRingingClosesTheOpenSheet() async throws {
        let models = SignedInModels()
        let guardModel = ScriptedWakeGuardScreenModel(state: WakeGuardState())
        models.scriptedWakeGuard = guardModel
        let window = try SceneWindow()
        let scene = AppComposition(models: models)
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        let stack = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)
        scene.navigation.presentSheet(.sleepPlan(night: nil), from: .overview)
        try await eventually { window.presentsSheet }
        XCTAssertNotNil(stack.navigator.presentingSheetOrCover, "A sheet is open while nothing rings")

        guardModel.publish(WakeGuardState(phase: .scanning, codeCount: 1))
        try await eventually { stack.navigator.presentingSheetOrCover == nil }

        XCTAssertNil(stack.navigator.presentingSheetOrCover, "The guard must not have a sheet above it")
        try await eventually { !window.presentsSheet }
        XCTAssertFalse(window.presentsSheet)
        window.close()
    }

    @MainActor
    func testASheetStaysOpenWhileNoMissionRings() async throws {
        let models = SignedInModels()
        let guardModel = ScriptedWakeGuardScreenModel(state: WakeGuardState())
        models.scriptedWakeGuard = guardModel
        let window = try SceneWindow()
        let scene = AppComposition(models: models)
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        scene.navigation.presentSheet(.sleepPlan(night: nil), from: .overview)
        try await eventually { window.presentsSheet }

        guardModel.publish(WakeGuardState(phase: .idle, fallbackOpen: false, codeCount: 0))
        try await Task.sleep(for: .milliseconds(300))

        XCTAssertTrue(window.presentsSheet)
        window.close()
    }

    @MainActor
    func testWhileAMissionRingsNoRouteOpensAScreenAboveTheGuardAndTheyWorkAgainAfterIt() async throws {
        let models = SignedInModels()
        let guardModel = ScriptedWakeGuardScreenModel(state: WakeGuardState(phase: .scanning, codeCount: 1))
        models.scriptedWakeGuard = guardModel
        let window = try SceneWindow()
        let scene = AppComposition(models: models)
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        let stack = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)
        XCTAssertTrue(scene.navigation.isBlocked)

        scene.navigation.presentSheet(.sleepPlan(night: nil), from: .overview)
        scene.navigation.push(.pending(title: "Inbox"), in: .overview)
        XCTAssertNil(stack.navigator.presentingSheetOrCover)
        XCTAssertEqual(stack.navigator.count, 0)

        guardModel.publish(WakeGuardState())
        try await eventually { !scene.navigation.isBlocked }
        scene.navigation.presentSheet(.sleepPlan(night: nil), from: .overview)

        XCTAssertEqual(stack.navigator.presentingSheetOrCover as? AppDestination, .sleepPlan(night: nil))
        window.close()
    }
}
