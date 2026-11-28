import Foundation
import PDFKit
import XCTest

@testable import DesignSystem

/// The PDF a finished scan becomes: every page in order, its name for the moment of the scan and its media type.
final class ScanDocumentTests: XCTestCase {

    // MARK: - Tests
    func testThePagesBecomeOnePdfWithEveryPageNamedForTheScan() throws {
        let scannedAt = try moment(year: 2026, month: 11, day: 27, hour: 7, minute: 45)
        let pages = [page(width: 300), page(width: 400), page(width: 500)]

        let file = try XCTUnwrap(ScanDocument.file(pages: pages, scannedAt: scannedAt))

        XCTAssertEqual(file.filename, "Scan 2026-11-27 07-45.pdf")
        XCTAssertEqual(file.mimeType, "application/pdf")
        let data = try XCTUnwrap(Data(base64Encoded: file.base64))
        let document = try XCTUnwrap(PDFDocument(data: data))
        XCTAssertEqual(document.pageCount, 3)
        let widths = (0..<document.pageCount).compactMap { document.page(at: $0)?.bounds(for: .mediaBox).width }
        XCTAssertEqual(widths, [300, 400, 500], "The pages keep the order they were scanned in")
    }

    func testOnePageMakesAOnePagePdf() throws {
        let scannedAt = try moment(year: 2026, month: 11, day: 27, hour: 7, minute: 45)

        let file = try XCTUnwrap(ScanDocument.file(pages: [page(width: 300)], scannedAt: scannedAt))

        let document = try XCTUnwrap(PDFDocument(data: try XCTUnwrap(Data(base64Encoded: file.base64))))
        XCTAssertEqual(document.pageCount, 1)
    }

    func testNoPageMakesNoFile() throws {
        let scannedAt = try moment(year: 2026, month: 11, day: 27, hour: 7, minute: 45)

        XCTAssertNil(ScanDocument.file(pages: [], scannedAt: scannedAt))
    }

    func testTheNamePadsEveryPartToItsWidth() throws {
        let scannedAt = try moment(year: 2027, month: 1, day: 5, hour: 9, minute: 3)

        XCTAssertEqual(ScanDocument.filename(scannedAt: scannedAt), "Scan 2027-01-05 09-03.pdf")
    }

    // MARK: - Private
    private func moment(year: Int, month: Int, day: Int, hour: Int, minute: Int) throws -> Date {
        let parts = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)
        return try XCTUnwrap(Calendar.current.date(from: parts))
    }

    private func page(width: CGFloat) -> PDFPage {
        let page = PDFPage()
        page.setBounds(CGRect(x: 0, y: 0, width: width, height: 800), for: .mediaBox)
        return page
    }
}
