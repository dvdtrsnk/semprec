import CoreKit
import XCTest

@testable import MailFeature

final class MailFormattingTests: XCTestCase {

    // MARK: - Times
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return calendar
    }

    private let locale = Locale(identifier: "en_US")
    private let now = ISO8601DateFormatter().date(from: "2026-10-20T15:00:00Z") ?? .distantPast

    func testTheServersMicrosecondsAreAccepted() {
        let date = MailFormatting.date("2026-10-20T12:41:00.123456Z")
        XCTAssertEqual(date, ISO8601DateFormatter().date(from: "2026-10-20T12:41:00Z"))
        XCTAssertNil(MailFormatting.date("yesterday"))
        XCTAssertNil(MailFormatting.date(nil))
    }

    func testARowFromTodayShowsTheClockTime() {
        let text = MailFormatting.listTime("2026-10-20T12:41:00.000000Z", now: now, calendar: calendar, locale: locale)
        XCTAssertTrue(text.contains("12:41"), text)
    }

    func testARowFromYesterdayAndFromTheLastWeekAndOlder() {
        let yesterday = MailFormatting.listTime("2026-10-19T09:30:00Z", now: now, calendar: calendar, locale: locale)
        let thisWeek = MailFormatting.listTime("2026-10-16T09:30:00Z", now: now, calendar: calendar, locale: locale)
        let older = MailFormatting.listTime("2026-09-02T09:30:00Z", now: now, calendar: calendar, locale: locale)
        XCTAssertFalse(yesterday.isEmpty)
        XCTAssertNotEqual(yesterday, thisWeek)
        XCTAssertEqual(thisWeek, "Fri")
        XCTAssertEqual(older, "9/2")
        XCTAssertEqual(MailFormatting.listTime("nonsense", now: now, calendar: calendar, locale: locale), "")
    }

    func testMessageTimesNeedARealDate() {
        XCTAssertEqual(MailFormatting.messageTime(nil, calendar: calendar, locale: locale), "")
        XCTAssertFalse(MailFormatting.messageTime("2026-10-12T10:00:00Z", calendar: calendar, locale: locale).isEmpty)
    }

    // MARK: - People
    func testInitialsAreTheFirstLettersOfTheFirstAndLastWord() {
        XCTAssertEqual(MailFormatting.initials(name: "Petr Novák", address: "p@x.cz"), "PN")
        XCTAssertEqual(MailFormatting.initials(name: "jana marie kovářová", address: "j@x.cz"), "JK")
        XCTAssertEqual(MailFormatting.initials(name: "Alza.cz", address: "a@alza.cz"), "A")
        XCTAssertEqual(MailFormatting.initials(name: "  ", address: "karel@zlaty.cz"), "K")
        XCTAssertEqual(MailFormatting.initials(name: "", address: ""), "\u{2022}")
    }

    func testTheAvatarColorOfASenderStaysTheSame() {
        XCTAssertEqual(MailFormatting.avatarColor("petr@novak.cz"), MailFormatting.avatarColor("PETR@novak.cz"))
        let colors = ["a@x.cz", "b@x.cz", "c@x.cz", "d@x.cz", "e@x.cz", "f@x.cz"].map(MailFormatting.avatarColor)
        XCTAssertTrue(colors.contains { $0 != colors[0] }, "The palette must tell senders apart")
    }

    // MARK: - Files and folders
    func testFileExtensionsAreCapitalLettersOrABullet() {
        XCTAssertEqual(MailFormatting.fileExtension("Nabidka_web.pdf"), "PDF")
        XCTAssertEqual(MailFormatting.fileExtension("archive.tar.gz"), "GZ")
        XCTAssertEqual(MailFormatting.fileExtension("document.markdown"), "MARK")
        XCTAssertEqual(MailFormatting.fileExtension("README"), "\u{2022}")
        XCTAssertEqual(MailFormatting.fileExtension(".hidden"), "\u{2022}")
        XCTAssertEqual(MailFormatting.fileExtension("trailing."), "\u{2022}")
    }

    func testFileSizesUseTheSystemUnits() {
        XCTAssertTrue(MailFormatting.fileSize(840).contains("840"))
        XCTAssertTrue(MailFormatting.fileSize(1_200_000).contains("MB"))
    }

    func testFolderSymbolsFollowTheSpecialPurpose() {
        let expected = [
            "inbox": "tray", "sent": "paperplane", "drafts": "doc", "archive": "archivebox",
            "junk": "exclamationmark.triangle", "trash": "trash", "none": "tag", "anything": "tag"
        ]
        for (purpose, symbol) in expected {
            XCTAssertEqual(MailFormatting.folderSymbol(purpose), symbol, purpose)
        }
    }

    // MARK: - Link texts
    func testLinkTextsNameTheSourceAndWhoChangedTheValue() {
        let inherited = MailLinkInfo(type: .inherited, sourceTitles: ["Petr Novák"], brokenByAgent: false)
        let byUser = MailLinkInfo(type: .broken, sourceTitles: ["Novák Web"], brokenByAgent: false)
        let bySemp = MailLinkInfo(type: .broken, sourceTitles: ["Novák Web"], brokenByAgent: true)
        let derived = MailLinkInfo(type: .derived, sourceTitles: [], brokenByAgent: false)
        let unknown = MailLinkInfo(type: .inherited, sourceTitles: [], brokenByAgent: false)
        XCTAssertTrue(MailLinkTexts.text(inherited).contains("Petr Novák"))
        XCTAssertTrue(MailLinkTexts.text(byUser).contains("Novák Web"))
        XCTAssertTrue(MailLinkTexts.text(bySemp).contains("Semp"))
        XCTAssertFalse(MailLinkTexts.text(byUser).contains("Semp"))
        XCTAssertFalse(MailLinkTexts.text(derived).contains("%"))
        XCTAssertFalse(MailLinkTexts.text(unknown).contains("%"))
        XCTAssertEqual(
            [inherited, byUser, derived].map(MailLinkTexts.symbol),
            ["link", "personalhotspot.slash", "arrow.turn.down.right"]
        )
        XCTAssertEqual(Set([inherited, byUser, derived].map(MailLinkTexts.title)).count, 3)
    }
}
