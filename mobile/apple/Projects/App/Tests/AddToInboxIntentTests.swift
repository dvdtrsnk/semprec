import CoreKit
import Foundation
import XCTest

@testable import Semprec

/// What `AddToInboxIntent` offers as the type of a capture, and which pick answers with the scan intent.
@MainActor
final class AddToInboxIntentTests: XCTestCase {

    private static let types = [
        InboxCaptureType(id: "type-1", label: "Receipt", emoji: "🧾"),
        InboxCaptureType(id: "type-2", label: "Idea", emoji: "")
    ]

    // MARK: - Type list
    func testTheTypeListStartsWithScanWhereTheDeviceCanScanThenNoTypeThenTheTypes() {
        let cases: [(types: InboxShortcutCapture.Types, scannerSupported: Bool, expected: [String])] = [
            (.loaded(Self.types), true, ["scan", "noType", "type-1", "type-2"]),
            (.loaded(Self.types), false, ["noType", "type-1", "type-2"]),
            (.failed(Failed(kind: .unavailable)), true, ["scan", "noType"]),
            (.failed(Failed(kind: .unavailable)), false, ["noType"])
        ]
        for (types, scannerSupported, expected) in cases {
            let offered = InboxTypeQuery.offered(types, scannerSupported: scannerSupported)
            XCTAssertEqual(offered.map(\.id), expected, "scanner supported: \(scannerSupported), types: \(types)")
        }
    }

    func testOnlyAServerTypeGivesACaptureATypeId() {
        let offered = InboxTypeQuery.offered(.loaded(Self.types), scannerSupported: true)

        XCTAssertEqual(offered.map(\.typeId), [nil, nil, "type-1", "type-2"])
        XCTAssertEqual(offered.map(\.kind), [
            .scan,
            .noType,
            .type(label: "Receipt", emoji: "🧾"),
            .type(label: "Idea", emoji: "")
        ])
    }

    #if os(macOS)
    func testAMacNeverOffersScan() {
        let offered = InboxTypeQuery.offered(.loaded(Self.types))

        XCTAssertEqual(offered.map(\.id), ["noType", "type-1", "type-2"])
    }
    #endif

    // MARK: - Result
    func testScanAnswersWithTheScanIntentOnTheChosenDay() throws {
        let day = try XCTUnwrap(Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 20)))

        let scan = try XCTUnwrap(AddToInboxIntent.scanIntent(for: .scan, day: day))
        XCTAssertEqual(scan.day, day)
        XCTAssertNil(try XCTUnwrap(AddToInboxIntent.scanIntent(for: .scan, day: nil)).day)
    }

    func testATypeOrNoTypeCapturesATextWithoutTheScanIntent() {
        let textChoices = [InboxTypeEntity.noType] + Self.types.map(InboxTypeEntity.init)

        for type in textChoices {
            XCTAssertNil(AddToInboxIntent.scanIntent(for: type, day: nil), "\(type.id) captures a text")
        }
    }
}
