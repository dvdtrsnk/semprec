import CoreKit
import XCTest

@testable import CollectionsFeature

final class OriginAndDeletionTests: XCTestCase {

    // MARK: - Source names
    private func field(origin: ValueOrigin?) -> FieldView {
        FieldView(
            propertyKey: "project",
            name: "Project",
            kind: .relation,
            content: .empty,
            options: [],
            editable: true,
            origin: origin
        )
    }

    func testASourceIsNamedByItsKindAndTitle() {
        let task = ValueOrigin(
            kind: .inherited,
            sources: [OriginSource(itemId: "t1", databaseKey: "tasks", title: "Send invoice")],
            brokenBy: nil
        )
        XCTAssertEqual(field(origin: task).sourceName(among: []), "task “Send invoice”")
        let box = OriginSource(itemId: "x", databaseKey: nil, title: "Box")
        let other = ValueOrigin(kind: .inherited, sources: [box], brokenBy: nil)
        XCTAssertEqual(field(origin: other).sourceName(among: []), "“Box”")
        let sender = ValueOrigin(
            kind: .inheritedBroken,
            sources: [OriginSource(itemId: nil, databaseKey: "weird", title: "novak-web.cz")],
            brokenBy: .user
        )
        XCTAssertEqual(field(origin: sender).sourceName(among: []), "“novak-web.cz”")
    }

    func testAnUnnamedSourceIsFoundAmongTheItemsOwnRelations() {
        let derived = ValueOrigin(
            kind: .derived,
            sources: [OriginSource(itemId: "p1", databaseKey: "projects", title: "")],
            brokenBy: nil
        )
        let project = FieldView(
            propertyKey: "project",
            name: "Project",
            kind: .relation,
            content: .targets([FieldTarget(id: "p1", databaseKey: "projects", title: "Web", color: nil)]),
            options: [],
            editable: true,
            origin: nil
        )
        XCTAssertEqual(field(origin: derived).sourceName(among: [project]), "project “Web”")
        XCTAssertEqual(field(origin: derived).sourceName(among: []), "another item")
        XCTAssertEqual(field(origin: nil).sourceName(among: []), "another item")
        let none = ValueOrigin(kind: .derived, sources: [], brokenBy: nil)
        XCTAssertEqual(field(origin: none).sourceName(among: [project]), "another item")
    }

    // MARK: - Deletion
    func testADeletionStatesWhatItReachesAndLeavesOutWhatItDoesNot() {
        let impact = ImpactView(
            related: [ImpactEntry(databaseKey: "files", count: 3), ImpactEntry(databaseKey: nil, count: 1)],
            nestedItems: 2, nestedPages: 0, takenOverValues: 4, seriesInstances: 0, attachments: 5, hostEvents: 0
        )
        let message = DeletionSummary(title: "Semprec", impact: impact, names: ["files": "Files"]).message
        XCTAssertEqual(
            message.components(separatedBy: "\n"),
            [
                "“Semprec” moves to Recently deleted, where it stays for 30 days. The deletion reaches:",
                "Files: 3",
                ": 1",
                "Items inside it: 2",
                "Values other items take over from it, which stay as their own: 4",
                "Attachments: 5"
            ]
        )
    }

    func testADeletionWithNoImpactOnlyHasItsIntroduction() {
        let none = ImpactView(
            related: [],
            nestedItems: 0,
            nestedPages: 0,
            takenOverValues: 0,
            seriesInstances: 0,
            attachments: 0,
            hostEvents: 0
        )
        let intro = DeletionSummary(title: "X", impact: none, names: [:]).message
        XCTAssertEqual(intro.components(separatedBy: "\n").count, 1)
        let all = ImpactView(
            related: [],
            nestedItems: 1,
            nestedPages: 1,
            takenOverValues: 1,
            seriesInstances: 1,
            attachments: 1,
            hostEvents: 1
        )
        let everything = DeletionSummary(title: "X", impact: all, names: [:]).message
        XCTAssertEqual(everything.components(separatedBy: "\n").count, 7)
    }
}
