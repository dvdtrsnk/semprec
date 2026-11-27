import CoreKit
import Foundation
import PDFKit

/// The scanned pages as the file of a capture: one PDF of every page in order, named `Scan YYYY-MM-DD HH-mm.pdf` for
/// the moment of the scan, with the media type `application/pdf` and the source camera.
enum ScanDocument {

    // MARK: - Shared
    static let mimeType = "application/pdf"

    // MARK: - Methods
    /// One PDF of `pages`, or nil when there is no page or PDFKit wrote no data. The document is written once and its
    /// bytes encoded once, so a scan of many pages is held as its pages, one PDF and one Base64 text, not more.
    static func file(pages: [PDFPage], scannedAt date: Date) -> InboxShortcutCapture.File? {
        guard !pages.isEmpty else { return nil }
        let document = PDFDocument()
        for (index, page) in pages.enumerated() {
            document.insert(page, at: index)
        }
        guard let data = document.dataRepresentation() else { return nil }
        return InboxShortcutCapture.File(
            filename: filename(scannedAt: date),
            mimeType: mimeType,
            base64: data.base64EncodedString(),
            source: .camera
        )
    }

    /// `Scan YYYY-MM-DD HH-mm.pdf` for `date` in the calendar and time zone of this device.
    static func filename(scannedAt date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(
            format: "Scan %04d-%02d-%02d %02d-%02d.pdf",
            parts.year ?? 0,
            parts.month ?? 1,
            parts.day ?? 1,
            parts.hour ?? 0,
            parts.minute ?? 0
        )
    }
}
