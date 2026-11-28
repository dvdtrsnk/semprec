import PDFKit
import SwiftUI

// MARK: - Document scanner
extension View {

    /// Shows the system document scanner full screen while `isPresented` on iOS, closes it when the scan ends and
    /// hands the scanned pages to `onFinish`; a cancelled scan, or one without a page, hands nothing, and a failed one
    /// calls `onFail`. A Mac has no document scanner, so there it shows nothing (`ScanDocument.isScannerSupported`).
    public func documentScanner(
        isPresented: Binding<Bool>,
        onFinish: @escaping @MainActor ([PDFPage]) -> Void,
        onFail: @escaping @MainActor () -> Void
    ) -> some View {
        #if os(iOS)
            fullScreenCover(isPresented: isPresented) {
                DocumentScanner(
                    onFinish: { pages in
                        isPresented.wrappedValue = false
                        if !pages.isEmpty { onFinish(pages) }
                    },
                    onCancel: { isPresented.wrappedValue = false },
                    onFail: {
                        isPresented.wrappedValue = false
                        onFail()
                    }
                )
                .ignoresSafeArea()
            }
        #else
            self
        #endif
    }
}
