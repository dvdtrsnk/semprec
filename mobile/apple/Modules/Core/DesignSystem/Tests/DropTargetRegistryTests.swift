import CoreGraphics
import Foundation
import XCTest

@testable import DesignSystem

/// Which object under the Semp bubble's drop point counts: the smallest registered frame containing it.
@MainActor
final class DropTargetRegistryTests: XCTestCase {

    func testThePointPicksTheSmallestFrameThatContainsIt() throws {
        let registry = DropTargetRegistry()
        registry.update(id: UUID(), frame: CGRect(x: 0, y: 0, width: 400, height: 800), payload: "screen")
        registry.update(id: UUID(), frame: CGRect(x: 10, y: 100, width: 300, height: 50), payload: "row")
        let hit = try XCTUnwrap(registry.target(at: CGPoint(x: 20, y: 120)))
        XCTAssertEqual(hit.payload as? String, "row")
        XCTAssertEqual(hit.frame, CGRect(x: 10, y: 100, width: 300, height: 50))
        XCTAssertEqual(registry.target(at: CGPoint(x: 20, y: 400))?.payload as? String, "screen")
    }

    func testNothingUnderThePointIsNoTarget() {
        let registry = DropTargetRegistry()
        XCTAssertNil(registry.target(at: .zero))
        registry.update(id: UUID(), frame: CGRect(x: 10, y: 10, width: 10, height: 10), payload: "row")
        XCTAssertNil(registry.target(at: CGPoint(x: 50, y: 50)))
    }

    func testAnUpdateMovesAnObjectAndARemovalDropsIt() {
        let registry = DropTargetRegistry()
        let id = UUID()
        registry.update(id: id, frame: CGRect(x: 0, y: 0, width: 10, height: 10), payload: "row")
        registry.update(id: id, frame: CGRect(x: 100, y: 100, width: 10, height: 10), payload: "row")
        XCTAssertNil(registry.target(at: CGPoint(x: 5, y: 5)))
        XCTAssertEqual(registry.target(at: CGPoint(x: 105, y: 105))?.payload as? String, "row")
        registry.remove(id: id)
        XCTAssertNil(registry.target(at: CGPoint(x: 105, y: 105)))
    }
}
