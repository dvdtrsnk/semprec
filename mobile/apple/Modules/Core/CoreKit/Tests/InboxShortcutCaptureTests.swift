import Foundation
import SharedSDK
import XCTest

@testable import CoreKit

/// The bridge of the Inbox intents: every branch of its mappings with the Kotlin values it maps, and the real Kotlin
/// `InboxCaptureSDK` behind it over a session in memory and a directory of its own.
@MainActor
final class InboxShortcutCaptureTests: XCTestCase {

    private let failures: [(SharedSDK.FailureKind?, CoreKit.FailureKind?)] = [
        (.unavailable, .unavailable),
        (.invalidData, .invalidData),
        (.unauthorized, .unauthorized),
        (.notFound, .notFound),
        (.rejected, .rejected),
        (nil, nil)
    ]

    // MARK: - Mapping
    func testLoadedTypesKeepTheirOrderAndValues() {
        let answer = SharedSDK.InboxCaptureTypesAnswerLoaded(types: [
            SharedSDK.InboxCaptureTypeState(id: "t2", label: "Idea", emoji: "I"),
            SharedSDK.InboxCaptureTypeState(id: "t1", label: "Receipt", emoji: "R")
        ])
        XCTAssertEqual(
            InboxShortcutCapture.types(answer),
            .loaded([
                InboxCaptureType(id: "t2", label: "Idea", emoji: "I"),
                InboxCaptureType(id: "t1", label: "Receipt", emoji: "R")
            ])
        )
        XCTAssertEqual(InboxShortcutCapture.types(SharedSDK.InboxCaptureTypesAnswerLoaded(types: [])), .loaded([]))
    }

    func testEveryFailureOfTheTypesMapsToItsKind() {
        for (shared, expected) in failures {
            let answer = SharedSDK.InboxCaptureTypesAnswerRefused(failure: SharedSDK.Failed(kind: shared))
            XCTAssertEqual(InboxShortcutCapture.types(answer), .failed(Failed(kind: expected)))
        }
    }

    func testAKeptCaptureHasNoFailureAndEveryRefusalMapsToItsKind() {
        XCTAssertNil(InboxShortcutCapture.capture(SharedSDK.InboxCaptureAnswerKept.shared))
        for (shared, expected) in failures {
            let answer = SharedSDK.InboxCaptureAnswerRefused(failure: SharedSDK.Failed(kind: shared))
            XCTAssertEqual(InboxShortcutCapture.capture(answer), Failed(kind: expected))
        }
    }

    // MARK: - Kotlin SDK
    func testNobodySignedInIsUnauthorizedAndNothingIsSent() async {
        let storage = SharedSDK.InMemorySessionStorage()
        let capture = InboxShortcutCapture(sessionStorage: storage, dataDirectory: directory())

        XCTAssertFalse(capture.isSignedIn)
        let types = await capture.types()
        XCTAssertEqual(types, .failed(Failed(kind: .unauthorized)))
        let captured = await capture.capture(text: "Buy milk", day: "2026-11-27", time: "07:45", typeId: nil)
        XCTAssertEqual(captured, Failed(kind: .unauthorized))
        let sent = await capture.send()
        XCTAssertFalse(sent)
    }

    func testABlankTextIsRefusedAsInvalid() async {
        let storage = SharedSDK.InMemorySessionStorage()
        storage.save(session: SharedSDK.StoredSession(serverUrl: "http://127.0.0.1:9", token: "tok"))
        let capture = InboxShortcutCapture(sessionStorage: storage, dataDirectory: directory())

        XCTAssertTrue(capture.isSignedIn)
        let captured = await capture.capture(text: "  \n ", day: "2026-11-27", time: "07:45", typeId: nil)
        XCTAssertEqual(captured, Failed(kind: .invalidData))
    }

    // MARK: - Private
    private func directory() -> String {
        FileManager.default.temporaryDirectory.appendingPathComponent("inbox-shortcut-\(UUID().uuidString)").path
    }
}
