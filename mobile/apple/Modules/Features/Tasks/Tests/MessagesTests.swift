import CoreKit
import XCTest

@testable import TasksFeature

final class MessagesTests: XCTestCase {

    // MARK: - Failures
    func testEveryFailureHasItsOwnText() {
        let failures: [FailureKind?] = [.unavailable, .invalidData, .unauthorized, .notFound, .rejected, nil]
        let messages = failures.map { FailureKind.message(for: $0) }
        XCTAssertEqual(Set(messages).count, failures.count)
        XCTAssertFalse(messages.contains { $0.hasPrefix("failure.") })
    }

    // MARK: - Links
    func testALinkNamesItsSourceAndItsAction() {
        let inherited = ValueLink(state: .inherited, sourceTitle: "Schůzka s účetní")
        XCTAssertEqual(LinkTexts.title(.project, inherited), "Project taken over")
        XCTAssertEqual(LinkTexts.title(.people, inherited), "People taken over")
        XCTAssertTrue(LinkTexts.text(.project, inherited).contains("“Schůzka s účetní”"))
        XCTAssertTrue(LinkTexts.text(.people, inherited).contains("“Schůzka s účetní”"))
    }

    func testABrokenLinkSaysWhoBrokeIt() {
        let byUser = ValueLink(state: .broken, sourceTitle: "Standup")
        let bySemp = ValueLink(state: .broken, sourceTitle: "Standup", brokenBySemp: true)
        XCTAssertTrue(LinkTexts.text(.project, byUser).contains("by hand"))
        XCTAssertTrue(LinkTexts.text(.project, bySemp).contains("Semp changed"))
        XCTAssertTrue(LinkTexts.text(.people, byUser).contains("by hand"))
        XCTAssertTrue(LinkTexts.text(.people, bySemp).contains("Semp changed"))
        XCTAssertEqual(LinkTexts.title(.project, byUser), "The project no longer follows its source")
        XCTAssertEqual(LinkTexts.title(.people, byUser), "The people no longer follow their source")
    }

    func testALinkWithoutASourceTitleStillReads() {
        let text = LinkTexts.text(.project, ValueLink(state: .inherited))
        XCTAssertTrue(text.contains("its source"))
    }

    func testADerivedValueIsExplainedWithoutASource() {
        let derived = ValueLink(state: .derived)
        XCTAssertEqual(LinkTexts.title(.company, derived), "Derived value")
        XCTAssertTrue(LinkTexts.text(.company, derived).contains("computed from its project"))
    }

    func testOnlyTheProjectAndThePeopleCanBeLinkedValues() {
        XCTAssertEqual(LinkSubject.project.linkedValue, .project)
        XCTAssertEqual(LinkSubject.people.linkedValue, .people)
        XCTAssertNil(LinkSubject.company.linkedValue)
    }
}
