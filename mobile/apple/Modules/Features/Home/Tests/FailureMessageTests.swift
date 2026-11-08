import CoreKit
import XCTest

@testable import HomeFeature

final class FailureMessageTests: XCTestCase {

    // MARK: - Tests
    func testEachFailureKindAndAnUnexpectedFailureHaveTheirOwnMessage() {
        XCTAssertEqual(FailureKind.message(for: .unavailable), "The content is not available right now.")
        XCTAssertEqual(FailureKind.message(for: .invalidData), "The content could not be read.")
        XCTAssertEqual(FailureKind.message(for: nil), "Something went wrong.")
    }

    func testFailureMessagesAreTranslatedToCzech() throws {
        let czechPath = try XCTUnwrap(Bundle.module.path(forResource: "cs", ofType: "lproj"))
        let czech = try XCTUnwrap(Bundle(path: czechPath))
        let message = { (key: String) in czech.localizedString(forKey: key, value: nil, table: nil) }
        XCTAssertEqual(message("failure.unavailable"), "Obsah teď není dostupný.")
        XCTAssertEqual(message("failure.invalidData"), "Obsah se nepodařilo přečíst.")
        XCTAssertEqual(message("failure.unexpected"), "Něco se pokazilo.")
    }
}
