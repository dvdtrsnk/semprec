import XCTest

@testable import AccountFeature

final class AccountFormatTests: XCTestCase {

    // MARK: - Properties
    private let english = Locale(identifier: "en_US")
    private let czech = Locale(identifier: "cs_CZ")
    private let utc = TimeZone(identifier: "UTC") ?? .gmt

    // MARK: - Money
    func testAPriceHasTwoDecimalsAndTheSeparatorOfTheLocale() {
        XCTAssertEqual(AccountFormat.usd(24.12, locale: english), "$24.12")
        XCTAssertEqual(AccountFormat.usd(24.12, locale: czech), "$24,12")
        XCTAssertEqual(AccountFormat.usd(0, locale: english), "$0.00")
    }

    // MARK: - Dates
    func testAnInstantIsReadWithAndWithoutFractionsOfASecond() {
        XCTAssertEqual(AccountFormat.instant("2026-10-21T10:00:00Z"), Date(timeIntervalSince1970: 1_792_576_800))
        XCTAssertEqual(AccountFormat.instant("2026-10-21T10:00:00.000Z"), Date(timeIntervalSince1970: 1_792_576_800))
        XCTAssertNil(AccountFormat.instant("yesterday"))
    }

    func testHowLongAgoIsWordedInTheLocaleAndNilForNoInstant() throws {
        let now = try XCTUnwrap(AccountFormat.instant("2026-10-21T12:00:00Z"))
        XCTAssertEqual(AccountFormat.relative("2026-10-21T10:00:00Z", now: now, locale: english), "2 hr. ago")
        XCTAssertEqual(AccountFormat.relative("2026-10-21T10:00:00Z", now: now, locale: czech), "před 2 h")
        XCTAssertNil(AccountFormat.relative("soon", now: now, locale: english))
    }

    func testADayIsNumericInTheLocaleAndNilForNoInstant() {
        XCTAssertEqual(AccountFormat.day("2026-09-12T10:00:00Z", locale: english, timeZone: utc), "9/12/2026")
        XCTAssertEqual(
            AccountFormat.day("2026-09-12T10:00:00Z", locale: czech, timeZone: utc)?.filter { !$0.isWhitespace },
            "12.9.2026"
        )
        XCTAssertNil(AccountFormat.day("soon", locale: english, timeZone: utc))
    }

    // MARK: - Identity
    func testInitialsAreTheFirstLettersOfTheFirstTwoWordsBeforeTheAt() {
        XCTAssertEqual(AccountFormat.initials(email: "david.tresnak@example.cz"), "DT")
        XCTAssertEqual(AccountFormat.initials(email: "s@tresnak.cc"), "S")
        XCTAssertEqual(AccountFormat.initials(email: "a_b-c@x.cz"), "AB")
        XCTAssertEqual(AccountFormat.initials(email: nil), "")
        XCTAssertEqual(AccountFormat.initials(email: "@x.cz"), "")
    }

    func testInitialsAreThoseOfTheDisplayNameWhenTheAccountHasOne() {
        XCTAssertEqual(AccountFormat.initials(name: "David Třešňák", email: "dev@example.cz"), "DT")
        XCTAssertEqual(AccountFormat.initials(name: "", email: "dev@example.cz"), "D")
        XCTAssertEqual(AccountFormat.initials(name: nil, email: "dev@example.cz"), "D")
    }

    func testTheHostIsTakenFromAServerAddressOrTheAddressItselfIsKept() {
        XCTAssertEqual(AccountFormat.host(of: "https://semprec.tresnak.cc/app"), "semprec.tresnak.cc")
        XCTAssertEqual(AccountFormat.host(of: "not a url"), "not a url")
        XCTAssertNil(AccountFormat.host(of: nil))
    }
}
