import CoreGraphics
import CoreKit
import Foundation
import SwiftUI
import XCTest

@testable import CollectionsFeature

final class PresentationHelpersTests: XCTestCase {

    // MARK: - Colors and icons
    func testAHexColorParsesOnlyTheServersForm() {
        XCTAssertNotNil(Color(hex: "#007AFF"))
        XCTAssertNil(Color(hex: nil))
        XCTAssertNil(Color(hex: "007AFF"))
        XCTAssertNil(Color(hex: "#07AF"))
        XCTAssertNil(Color(hex: "#GGGGGG"))
    }

    func testAnIconNameHasItsSymbolAndAnUnknownOneAGenericSymbol() {
        XCTAssertEqual(CollectionIcon.symbol(for: "folder"), "folder")
        XCTAssertEqual(CollectionIcon.symbol(for: "checkmark-circle"), "checkmark.circle")
        XCTAssertEqual(CollectionIcon.symbol(for: "no-such-icon"), "square.grid.2x2")
        XCTAssertEqual(CollectionIcon.symbol(for: nil), "square.grid.2x2")
        XCTAssertEqual(CollectionIcon.symbol(forDatabase: "people"), "person")
        XCTAssertEqual(CollectionIcon.symbol(forDatabase: nil), "square.grid.2x2")
    }

    func testTheSystemDatabasesHaveSymbolsOfTheirOwn() {
        let keys = [
            "projects", "tasks", "events", "people", "companies", "files", "journal", "threads", "transcripts", "areas"
        ]
        XCTAssertEqual(Set(keys.map { CollectionIcon.symbol(forDatabase: $0) }).count, keys.count)
    }

    // MARK: - Failure text
    func testEveryFailureHasItsOwnMessage() {
        let kinds: [FailureKind?] = [.unavailable, .invalidData, .unauthorized, .notFound, .rejected, nil]
        let messages = kinds.map { FailureKind.message(for: $0) }
        XCTAssertEqual(Set(messages).count, kinds.count)
        XCTAssertTrue(messages.allSatisfy { !$0.isEmpty && !$0.hasPrefix("failure.") })
    }

    // MARK: - Appearance
    func testPeopleAndProjectsAreRoundAndAFilesBadgeIsItsType() {
        let row = CollectionRow(
            id: "f", title: "A", group: FieldOption(key: "x", label: "X", color: "#FF0000"), date: nil, subtitle: [],
            fileType: "PDF"
        )
        XCTAssertTrue(CollectionAppearance(databaseKey: "people", color: nil).isRound)
        XCTAssertTrue(CollectionAppearance(databaseKey: "projects", color: nil).isRound)
        XCTAssertFalse(CollectionAppearance(databaseKey: "files", color: nil).isRound)
        XCTAssertEqual(CollectionAppearance(databaseKey: "files", color: nil).badgeLabel(of: row), "PDF")
        XCTAssertNil(CollectionAppearance(databaseKey: "people", color: nil).badgeLabel(of: row))
        let files = CollectionAppearance(databaseKey: "files", color: "#00FF00")
        XCTAssertEqual(files.tint(of: row), Color(hex: "#FF0000"))
        let plain = CollectionRow(id: "p", title: "A", group: nil, date: nil, subtitle: [], fileType: nil)
        XCTAssertEqual(files.tint(of: plain), Color(hex: "#00FF00"))
    }

    // MARK: - Factory targets
    @MainActor
    func testTheConcreteCollectionsAreTargetsOfTheOneScreen() {
        XCTAssertEqual(CollectionsScreenFactory.projects(), .whole(databaseKey: "projects", databaseId: nil))
        XCTAssertEqual(CollectionsScreenFactory.projects(areaId: "a1"), .ofArea(databaseKey: "projects", areaId: "a1"))
        XCTAssertEqual(CollectionsScreenFactory.people(), .whole(databaseKey: "people", databaseId: nil))
        XCTAssertEqual(CollectionsScreenFactory.companies(), .whole(databaseKey: "companies", databaseId: nil))
        XCTAssertEqual(
            CollectionsScreenFactory.companies(areaId: "a1"),
            .ofArea(databaseKey: "companies", areaId: "a1")
        )
        XCTAssertEqual(CollectionsScreenFactory.events(), .whole(databaseKey: "events", databaseId: nil))
        XCTAssertEqual(CollectionsScreenFactory.events(areaId: "a1"), .ofArea(databaseKey: "events", areaId: "a1"))
        XCTAssertEqual(CollectionsScreenFactory.files(), .whole(databaseKey: "files", databaseId: nil))
        XCTAssertEqual(CollectionsScreenFactory.files(areaId: "a1"), .ofArea(databaseKey: "files", areaId: "a1"))
        XCTAssertEqual(
            CollectionsScreenFactory.files(areaId: "a1", projectId: "p1"),
            .ofItem(databaseKey: "files", relationKey: "projects", itemId: "p1")
        )
    }

    // MARK: - Markdown
    func testEachLineOfAPageIsABlockOfItsKind() {
        let page = "# Title\n\n## Sub\n- one\n* two\n1. first\n2) second\n"
            + "- [ ] todo\n- [x] done\n> quoted\nplain **bold**"
        let blocks = MarkdownBlock.parse(page)
        XCTAssertEqual(
            blocks.map(\.kind),
            [
                .heading(level: 1), .heading(level: 2), .bullet, .bullet, .number(1), .number(2), .todo(done: false),
                .todo(done: true), .quote, .paragraph
            ]
        )
        XCTAssertEqual(
            blocks.map(\.text),
            ["Title", "Sub", "one", "two", "first", "second", "todo", "done", "quoted", "plain **bold**"]
        )
        XCTAssertEqual(blocks.map(\.id), Array(0..<10))
        XCTAssertTrue(MarkdownBlock.parse("  \n\n").isEmpty)
    }

    // MARK: - Preview image
    func testAnImageAndTheFirstPageOfAPdfAreDecodedAndOtherFilesAreNot() throws {
        let png = try XCTUnwrap(Data(base64Encoded: Self.pngBase64))
        XCTAssertEqual(PreviewImage.image(from: png, mimeType: "image/png")?.width, 1)
        XCTAssertNil(PreviewImage.image(from: png, mimeType: "application/zip"))
        XCTAssertNil(PreviewImage.image(from: Data("not an image".utf8), mimeType: "image/png"))
        let pdf = try Self.pdf()
        let page = try XCTUnwrap(PreviewImage.image(from: pdf, mimeType: "application/pdf"))
        XCTAssertEqual(max(page.width, page.height), 1_400)
        XCTAssertNil(PreviewImage.image(from: Data("%PDF broken".utf8), mimeType: "application/pdf"))
    }

    // MARK: - Upload
    func testAFileToUploadIsReadWithItsNameTypeAndBytes() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("collections-upload-test.pdf")
        try Data([1, 2, 3]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let file = try UploadFile.read(url)
        XCTAssertEqual(
            file,
            UploadFile(filename: "collections-upload-test.pdf", mimeType: "application/pdf", base64: "AQID")
        )
        XCTAssertEqual(UploadFile.mimeType(of: URL(fileURLWithPath: "/tmp/photo.jpg")), "image/jpeg")
        let unknown = URL(fileURLWithPath: "/tmp/file.nosuchextension")
        XCTAssertEqual(UploadFile.mimeType(of: unknown), "application/octet-stream")
        XCTAssertThrowsError(try UploadFile.read(url.appendingPathExtension("missing")))
    }
}

// MARK: - Fixtures
private extension PresentationHelpersTests {

    /// A one-pixel PNG.
    static let pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

    /// A one-page PDF of A5 size, drawn with CoreGraphics.
    static func pdf() throws -> Data {
        let data = NSMutableData()
        var box = CGRect(x: 0, y: 0, width: 420, height: 595)
        let consumer = try XCTUnwrap(CGDataConsumer(data: data))
        let context = try XCTUnwrap(CGContext(consumer: consumer, mediaBox: &box, nil))
        context.beginPDFPage(nil)
        context.fill(CGRect(x: 10, y: 10, width: 100, height: 100))
        context.endPDFPage()
        context.closePDF()
        return data as Data
    }
}
