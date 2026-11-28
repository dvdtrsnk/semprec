#if os(iOS)
import PDFKit
import SwiftUI
import VisionKit

/// The system document scanner (`VNDocumentCameraViewController` of VisionKit), which SwiftUI has no view for: the
/// one UIKit view controller of the app, iOS only, with UIKit reached through `import SwiftUI`. It reports how the
/// scan ended through its three closures; whoever shows it closes it.
public struct DocumentScanner: UIViewControllerRepresentable {

    // MARK: - Shared
    /// Whether this device has the scanner (a device with a camera; never the simulator).
    public static var isSupported: Bool {
        VNDocumentCameraViewController.isSupported
    }

    /// The JPEG quality each page's image is kept with in the PDF, so a page holds compressed bytes rather than the
    /// camera's full image.
    private static let pageQuality = 0.8

    // MARK: - Dependencies
    private let onFinish: @MainActor ([PDFPage]) -> Void
    private let onCancel: @MainActor () -> Void
    private let onFail: @MainActor () -> Void

    // MARK: - Init
    /// `onFinish` gets the scanned pages in order, `onCancel` is called when the person cancels the scan and
    /// `onFail` when the scanner fails (the camera could not be used).
    public init(
        onFinish: @escaping @MainActor ([PDFPage]) -> Void,
        onCancel: @escaping @MainActor () -> Void,
        onFail: @escaping @MainActor () -> Void
    ) {
        self.onFinish = onFinish
        self.onCancel = onCancel
        self.onFail = onFail
    }

    // MARK: - Methods
    public func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let scanner = VNDocumentCameraViewController()
        scanner.delegate = context.coordinator
        return scanner
    }

    public func updateUIViewController(_ scanner: VNDocumentCameraViewController, context: Context) {}

    public func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish, onCancel: onCancel, onFail: onFail)
    }

    /// The pages of `scan` in order, each made a PDF page from its image in its own autorelease pool, so the camera's
    /// images are loaded one at a time rather than all together.
    static func pages(of scan: VNDocumentCameraScan) -> [PDFPage] {
        (0..<scan.pageCount).compactMap { index in
            autoreleasepool {
                PDFPage(image: scan.imageOfPage(at: index), options: [.compressionQuality: pageQuality])
            }
        }
    }
}

// MARK: - Coordinator
extension DocumentScanner {

    /// The scanner's delegate, which hands each outcome to the scanner's closures. VisionKit calls it on the main
    /// thread, as the scanner is a view controller; its protocol is not marked so, hence the `@preconcurrency`
    /// conformance.
    @MainActor
    public final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {

        // MARK: - Dependencies
        private let onFinish: @MainActor ([PDFPage]) -> Void
        private let onCancel: @MainActor () -> Void
        private let onFail: @MainActor () -> Void

        // MARK: - Init
        init(
            onFinish: @escaping @MainActor ([PDFPage]) -> Void,
            onCancel: @escaping @MainActor () -> Void,
            onFail: @escaping @MainActor () -> Void
        ) {
            self.onFinish = onFinish
            self.onCancel = onCancel
            self.onFail = onFail
        }

        // MARK: - Methods
        public func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFinishWith scan: VNDocumentCameraScan
        ) {
            onFinish(DocumentScanner.pages(of: scan))
        }

        public func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            onCancel()
        }

        public func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFailWithError error: any Error
        ) {
            onFail()
        }
    }
}
#endif
