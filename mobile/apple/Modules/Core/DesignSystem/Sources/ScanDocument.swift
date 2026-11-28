import Foundation
import PDFKit

/// The scanned pages as a file: one PDF of every page in order, named `Scan YYYY-MM-DD HH-mm.pdf` for the moment of
/// the scan, with the media type `application/pdf`.
public enum ScanDocument {

    // MARK: - Types
    /// The PDF's name, its media type and its bytes as Base64 text.
    public struct File: Equatable, Sendable {
        public let filename: String
        public let mimeType: String
        public let base64: String
    }

    // MARK: - Shared
    public static let mimeType = "application/pdf"

    /// Whether this device can scan a document: an iPhone or iPad with the system document scanner, never the
    /// simulator; a Mac has no document scanner.
    public static var isScannerSupported: Bool {
        #if os(iOS)
            DocumentScanner.isSupported
        #else
            false
        #endif
    }

    // MARK: - Methods
    /// One PDF of `pages`, or nil when there is no page or PDFKit wrote no data. The document is written once and its
    /// bytes encoded once, so a scan of many pages is held as its pages, one PDF and one Base64 text, not more.
    public static func file(pages: [PDFPage], scannedAt date: Date) -> File? {
        guard !pages.isEmpty else { return nil }
        let document = PDFDocument()
        for (index, page) in pages.enumerated() {
            document.insert(page, at: index)
        }
        guard let data = document.dataRepresentation() else { return nil }
        return File(filename: filename(scannedAt: date), mimeType: mimeType, base64: data.base64EncodedString())
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
