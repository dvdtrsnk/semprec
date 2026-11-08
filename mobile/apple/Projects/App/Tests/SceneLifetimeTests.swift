import SwiftUI
import XCTest

@testable import Semprec

final class SceneLifetimeTests: XCTestCase {

    // MARK: - Tests
    /// Closing a window drops its `AppScene`. NavigatorUI keeps the scene's destination provider in the root
    /// navigation state for as long as that state lives, and on macOS AppKit keeps the closed window's tab bar
    /// environment, root navigator included. A provider that holds the composition or the scene view strongly
    /// therefore keeps the composition, and the Kotlin SDK behind its screen model factory, alive after the window is
    /// gone.
    @MainActor
    func testClosingASceneReleasesItsCompositionAndItsScreenModelFactory() async throws {
        weak var composition: AppComposition?
        weak var models: AnyObject?
        let window = try SceneWindow()
        do {
            let scene = AppComposition()
            composition = scene
            models = scene.models
            try await window.show(AppScene(composition: scene))
        }
        XCTAssertNotNil(composition, "The shown scene must own its composition")
        window.close()
        try await eventually { composition == nil && models == nil }
        XCTAssertNil(composition, "The closed scene's composition must be released")
        XCTAssertNil(models, "The closed scene's screen model factory, and its Kotlin SDK, must be released")
    }
}
