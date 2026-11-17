import CoreGraphics
import Foundation
import ImageIO

/// Draws the bytes of a downloaded file for a preview without UIKit or AppKit: an image through ImageIO, the first
/// page of a PDF through CoreGraphics. Any other kind of file has no preview.
enum PreviewImage {

    // MARK: - Properties
    /// The longest side, in pixels, a PDF page is drawn at.
    private static let pdfPixels: CGFloat = 1_400

    // MARK: - Methods
    static func image(from data: Data, mimeType: String) -> CGImage? {
        if mimeType == "application/pdf" { return firstPage(of: data) }
        guard mimeType.hasPrefix("image/"), let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return nil
        }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    private static func firstPage(of data: Data) -> CGImage? {
        guard let provider = CGDataProvider(data: data as CFData),
              let document = CGPDFDocument(provider),
              let page = document.page(at: 1)
        else { return nil }
        let box = page.getBoxRect(.mediaBox)
        guard box.width > 0, box.height > 0 else { return nil }
        let scale = pdfPixels / max(box.width, box.height)
        let size = CGSize(width: (box.width * scale).rounded(), height: (box.height * scale).rounded())
        guard let context = CGContext(
            data: nil,
            width: Int(size.width),
            height: Int(size.height),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(origin: .zero, size: size))
        let canvas = CGRect(origin: .zero, size: size)
        context.concatenate(page.getDrawingTransform(.mediaBox, rect: canvas, rotate: 0, preserveAspectRatio: true))
        context.drawPDFPage(page)
        return context.makeImage()
    }
}
