import CoreKit
import NavigatorUI
import SwiftUI
import XCTest

@testable import Alldots

/// The debug menu and its alarm tool: pages of the profile sheet's own stack, which the app's router pushes, opened
/// from the profile's toolbar and from the menu's row, and shown by the real scene.
final class DebugNavigationTests: XCTestCase {

    // MARK: - Router
    @MainActor
    func testTheDebugMenuIsAPageOfTheSheetsOwnStackAndOpensOnce() {
        let path = AccountPath()
        let router = Self.router(path)

        router.showDebugMenu()
        router.showDebugMenu()

        XCTAssertEqual(path.pages, [.debug])
    }

    @MainActor
    func testTheAlarmToolOpensOverTheMenuOnceAndLeavesTheOtherPagesAlone() {
        let path = AccountPath(pages: [.page(.devices)])
        let router = Self.router(path)

        router.showDebugMenu()
        router.showDebugAlarms()
        router.showDebugAlarms()

        XCTAssertEqual(path.pages, [.page(.devices), .debug, .debugAlarms])
    }

    @MainActor
    func testTheDebugPagesNeitherCloseTheSheetNorTouchATabStack() {
        let context = NavigationContext()
        let overview = DebugStackSpy()
        context.register(overview, for: .overview)
        var dismissals = 0
        let router = AppAccountRouter(
            path: AccountPath(),
            context: context,
            dismissSheet: { dismissals += 1 },
            requestPermission: {}
        )

        router.showDebugMenu()
        router.showDebugAlarms()

        XCTAssertEqual(dismissals, 0)
        XCTAssertTrue(overview.pushed.isEmpty)
        XCTAssertTrue(overview.sheets.isEmpty)
    }

    // MARK: - Scene
    @MainActor
    func testTheRealSceneOpensTheProfileSheetOnTheAlarmToolOverTheDebugMenu() async throws {
        let window = try SceneWindow()
        let scene = AppComposition(models: SignedInModels())
        try await window.show(AppScene(composition: scene))
        try await eventually { scene.navigation.stack(for: .overview) != nil }
        let overview = try XCTUnwrap(scene.navigation.stack(for: .overview) as? NavigatorStackAdapter)

        scene.navigation.presentSheet(.profile(opening: [.debug, .debugAlarms]), from: .overview)

        XCTAssertEqual(
            overview.navigator.presentingSheetOrCover as? AppDestination,
            .profile(opening: [.debug, .debugAlarms])
        )
        try await eventually { window.presentsSheet }
        XCTAssertTrue(window.presentsSheet, "The window must show the profile sheet on the alarm tool")
        #if os(iOS)
            try await eventually { window.sheetTitle == "System alarms" }
            XCTAssertEqual(window.sheetTitle, "System alarms")
        #endif
        window.close()
    }

    // MARK: - Helpers
    @MainActor
    private static func router(_ path: AccountPath) -> AppAccountRouter {
        AppAccountRouter(path: path, context: NavigationContext(), dismissSheet: {}, requestPermission: {})
    }
}

// MARK: - Spies
@MainActor
private final class DebugStackSpy {

    // MARK: - Properties
    var pushed: [AppDestination] = []
    var sheets: [AppDestination] = []
}

// MARK: - Protocol conformance
extension DebugStackSpy: StackNavigating {

    var top: AppDestination? { pushed.last }

    func push(_ destination: AppDestination) {
        pushed.append(destination)
    }

    func presentSheet(_ destination: AppDestination) {
        sheets.append(destination)
    }

    func dismissPresented() {}
}
