import CoreKit
import XCTest

@testable import InboxFeature

/// The texts and formats the screen builds from what the shared ViewModel says.
final class InboxTextTests: XCTestCase {

    // MARK: - Failures
    func testEveryFailureHasItsOwnText() {
        let failures: [FailureKind?] = [.unavailable, .invalidData, .unauthorized, .notFound, .rejected, nil]
        let messages = failures.map { FailureKind.message(for: $0) }
        XCTAssertEqual(Set(messages).count, failures.count)
        XCTAssertFalse(messages.contains { $0.hasPrefix("failure.") })
    }

    // MARK: - Cards
    func testEveryKindOfCardHasItsOwnChipAndTheRisksTheirOwnText() {
        let types: [InboxCardType] = [
            .task, .event, .page, .journal, .project, .area, .company, .person, .health, .file, .recording, .mcp,
            .invalid, .clarify, .transcriptEvent, .speaker, .approval, .unsupported
        ]
        let chips = types.map(\.chipText)
        XCTAssertEqual(Set(chips).count, types.count)
        XCTAssertFalse(chips.contains { $0.hasPrefix("inbox.") })
        let risks: [InboxRiskLevel] = [.irreversible, .outbound, .breaksLink, .write]
        XCTAssertEqual(Set(risks.map(\.text)).count, risks.count)
        XCTAssertFalse(risks.contains { $0.text.hasPrefix("inbox.") })
    }

    func testAFieldTheAppDeclaresItselfIsLabelledByItsKeyAndAServerLabelWins() {
        XCTAssertEqual(InboxField(key: "who", type: .choice).title, "Person")
        XCTAssertEqual(InboxField(key: "name", type: .text, label: "Název").title, "Název")
        XCTAssertEqual(InboxField(key: "unknownKey", type: .text).title, "unknownKey")
        XCTAssertEqual(InboxField(key: "x", type: .text, placeholder: "").hint, nil)
        XCTAssertEqual(InboxField(key: "x", type: .text, placeholder: "Name").hint, "Name")
    }

    func testAStaticOptionIsLabelledByTheAppAndAServerLabelWins() {
        XCTAssertEqual(InboxChoice(id: "start").title(in: "placement"), "Start")
        XCTAssertEqual(InboxChoice(id: "auto").title(in: "language"), "Detect")
        XCTAssertEqual(InboxChoice(id: nil, none: true).title(in: "project"), "None")
        XCTAssertEqual(InboxChoice(id: "todo", label: "K udělání").title(in: "status"), "K udělání")
        XCTAssertEqual(InboxChoice(id: "mystery").title(in: "status"), "mystery")
    }

    func testAnAvatarTakesTheInitialsOfAPersonOrTheOnesTheServerGave() {
        XCTAssertEqual(InboxChoice(id: "p", label: "Jana Kovářová").avatarInitials, "JK")
        XCTAssertEqual(InboxChoice(id: "p", label: "Máma").avatarInitials, "M")
        XCTAssertEqual(InboxChoice(id: "p", label: "Jana", initials: "JJ").avatarInitials, "JJ")
    }

    // MARK: - Dates
    func testADayIsShownWithItsWeekdayInTheLocaleOfThePerson() throws {
        let english = try XCTUnwrap(InboxFormatting.day("2026-10-16", locale: Locale(identifier: "en_US")))
        XCTAssertTrue(english.contains("Fri"), english)
        XCTAssertTrue(english.contains("2026"), english)
        let czech = try XCTUnwrap(InboxFormatting.day("2026-10-16T09:00", locale: Locale(identifier: "cs_CZ")))
        XCTAssertTrue(czech.contains("pá"), czech)
        XCTAssertNil(InboxFormatting.day("soon"))
        XCTAssertNil(InboxFormatting.day(nil))
    }

    func testATimeIsShownInTheStyleOfThePersonAndATextThatIsNoTimeIsNone() throws {
        let english = try XCTUnwrap(InboxFormatting.time("14:30", locale: Locale(identifier: "en_US")))
        XCTAssertTrue(english.contains("2:30"), english)
        let czech = try XCTUnwrap(InboxFormatting.time("09:05", locale: Locale(identifier: "cs_CZ")))
        XCTAssertTrue(czech.contains("9:05"), czech)
        XCTAssertNil(InboxFormatting.time("25:00"))
        XCTAssertNil(InboxFormatting.time("noon"))
        XCTAssertNil(InboxFormatting.time(nil))
    }

    func testACaptureIsShownByItsDayAndItsTime() throws {
        let locale = Locale(identifier: "en_US")
        let shown = try XCTUnwrap(InboxFormatting.captured(date: "2026-10-16", time: "08:12", locale: locale))
        XCTAssertTrue(shown.contains("Fri") && shown.contains("8:12"), shown)
        XCTAssertEqual(InboxFormatting.captured(date: nil, time: nil), nil)
    }

    func testTodayIsAnIsoDay() {
        let today = InboxFormatting.today(now: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertNotNil(today.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression))
    }
}
