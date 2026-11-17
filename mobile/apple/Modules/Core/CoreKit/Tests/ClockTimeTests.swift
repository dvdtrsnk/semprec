import XCTest

@testable import CoreKit

final class ClockTimeTests: XCTestCase {

    func testATimeOfDayIsReadOnTheGivenDayAndWrittenBack() throws {
        let day = try XCTUnwrap(IsoDay.date(from: "2026-11-16"))
        let date = try XCTUnwrap(ClockTime.date(from: "09:05", on: day))
        XCTAssertEqual(ClockTime.string(from: date), "09:05")
        XCTAssertEqual(IsoDay.string(from: date), "2026-11-16")
        XCTAssertEqual(ClockTime.string(from: try XCTUnwrap(ClockTime.date(from: "23:59", on: day))), "23:59")
    }

    func testTextThatIsNoTimeOfDayIsNone() {
        for text in ["", "9", "24:00", "12:60", "ab:cd", "1:2:3"] {
            XCTAssertNil(ClockTime.date(from: text), text)
        }
    }
}
