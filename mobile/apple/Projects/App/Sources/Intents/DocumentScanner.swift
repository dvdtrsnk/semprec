#if os(iOS)
import PDFKit
import SwiftUI
import VisionKit

/// The system document scanner (`VNDocumentCameraViewController` of VisionKit), which SwiftUI has no view for: the
/// one UIKit view controller of the app, iOS only, with UIKit reached through `import SwiftUI`
/// (docs/adr/2026-11-27-the-document-scanner-is-the-one-uikit-view-controller-of-the-apple-app.md). It reports how
/// the scan ended to `presenter`, which closes it.
struct DocumentScanner: UIViewControllerRepresentable {

    // MARK: - Shared
    /// Whether this device has the scanner (a device with a camera; never the simulator).
    static var isSupported: Bool {
        VNDocumentCameraViewController.isSupported
    }

    /// The JPEG quality each page's image is kept with in the PDF, so a page holds compressed bytes rather than the
    /// camera's full image.
    private static let pageQuality = 0.8

    // MARK: - Dependencies
    let presenter: ScanPresenter

    // MARK: - Methods
    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let scanner = VNDocumentCameraViewController()
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(presenter: presenter)
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

    /// The scanner's delegate, which hands each outcome to the presenter. VisionKit calls it on the main thread, as the
    /// scanner is a view controller; its protocol is not marked so, hence the `@preconcurrency` conformance.
    @MainActor
    final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {

        // MARK: - Dependencies
        private let presenter: ScanPresenter

        // MARK: - Init
        init(presenter: ScanPresenter) {
            self.presenter = presenter
        }

        // MARK: - Methods
        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFinishWith scan: VNDocumentCameraScan
        ) {
            presenter.finish(pages: DocumentScanner.pages(of: scan))
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            presenter.cancel()
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFailWithError error: any Error
        ) {
            presenter.fail()
        }
    }
}
#endif
