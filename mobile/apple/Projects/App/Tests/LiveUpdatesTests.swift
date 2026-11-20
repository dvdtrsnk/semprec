import CoreKit
import SwiftUI
import XCTest

@testable import Semprec

/// A signed-in scene keeps its sync socket connected while it is not in the background, and closes it when it goes
/// to the background or stops showing its tabs. A window of the test host is no SwiftUI scene, so the test sets the
/// scene phase itself.
final class LiveUpdatesTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testTheSceneRunsItsLiveUpdatesOutsideTheBackgroundAndStopsThemWhenClosed() async throws {
        let models = SignedInModels()
        let phase = ScenePhaseBox()
        let window = try SceneWindow()
        try await window.show(PhasedScene(phase: phase, composition: AppComposition(models: models)))
        XCTAssertEqual(models.liveUpdateCalls, [true], "The shown scene must start its sync socket once")

        phase.value = .inactive
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(models.liveUpdateCalls, [true, true], "An inactive scene keeps the socket, starting it again")
        phase.value = .background
        try await eventually { models.liveUpdateCalls.count == 3 }
        XCTAssertEqual(models.liveUpdateCalls.last, false, "A scene in the background must stop the socket")
        phase.value = .active
        try await eventually { models.liveUpdateCalls.count == 4 }
        XCTAssertEqual(models.liveUpdateCalls.last, true, "A scene back from the background must start it again")

        window.close()
        try await eventually { models.liveUpdateCalls.count == 5 }
        XCTAssertEqual(models.liveUpdateCalls.last, false, "A scene that stops showing its tabs must stop the socket")
    }
}

// MARK: - Helpers
@MainActor
private final class ScenePhaseBox: ObservableObject {

    @Published var value = ScenePhase.active
}

/// An `AppScene` under the scene phase the test sets.
private struct PhasedScene: View {

    @ObservedObject var phase: ScenePhaseBox
    let composition: AppComposition

    var body: some View {
        AppScene(composition: composition).environment(\.scenePhase, phase.value)
    }
}
