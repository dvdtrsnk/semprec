import CoreKit
import Foundation
import PDFKit
import XCTest

@testable import JournalFeature

final class JournalCaptureViewModelTests: XCTestCase {

    @MainActor
    func testEveryIntentIsForwardedToTheModel() {
        let model = ScriptedInboxCaptureScreenModel(state: InboxCaptureState())
        let viewModel = JournalCaptureViewModel(model: model, onCaptured: {})
        let file = CaptureFile(filename: "a.png", mimeType: "image/png", base64: "YWJj")
        viewModel.loadTypes()
        viewModel.pickType("t1")
        viewModel.pickType(nil)
        viewModel.attach(file, source: .photoLibrary)
        viewModel.removeAttachment()
        viewModel.submit(text: "Note", day: "2026-11-16", time: "08:15")
        viewModel.dismissFailure()
        XCTAssertEqual(model.actions, [
            .loadTypes,
            .pickType("t1"),
            .pickType(nil),
            .attach(filename: "a.png", mimeType: "image/png", base64: "YWJj", source: .photoLibrary),
            .removeAttachment,
            .submit(text: "Note", day: "2026-11-16", time: "08:15"),
            .dismissFailure
        ])
    }

    @MainActor
    func testAScanIsAttachedAsOnePdfOfEveryPageFromTheCamera() throws {
        let model = ScriptedInboxCaptureScreenModel(state: InboxCaptureState())
        let viewModel = JournalCaptureViewModel(model: model, onCaptured: {})
        let parts = DateComponents(year: 2026, month: 11, day: 28, hour: 9, minute: 5)
        let scannedAt = try XCTUnwrap(Calendar.current.date(from: parts))

        XCTAssertTrue(viewModel.attachScan([page(width: 300), page(width: 400)], scannedAt: scannedAt))

        XCTAssertEqual(model.actions.count, 1)
        guard case let .attach(filename, mimeType, base64, source) = try XCTUnwrap(model.actions.first) else {
            return XCTFail("A scan is attached, as a picked file is")
        }
        XCTAssertEqual(filename, "Scan 2026-11-28 09-05.pdf")
        XCTAssertEqual(mimeType, "application/pdf")
        XCTAssertEqual(source, .camera)
        let document = try XCTUnwrap(PDFDocument(data: try XCTUnwrap(Data(base64Encoded: base64))))
        let widths = (0..<document.pageCount).compactMap { document.page(at: $0)?.bounds(for: .mediaBox).width }
        XCTAssertEqual(widths, [300, 400], "Every page is kept, in the order it was scanned in")
    }

    @MainActor
    func testAScanWithoutAPageAttachesNothing() {
        let model = ScriptedInboxCaptureScreenModel(state: InboxCaptureState())
        let viewModel = JournalCaptureViewModel(model: model, onCaptured: {})

        XCTAssertFalse(viewModel.attachScan([], scannedAt: .now))

        XCTAssertEqual(model.actions, [])
    }

    @MainActor
    func testTheStateIsRepublishedAndEveryCaptureIsCountedAndReported() async throws {
        let model = ScriptedInboxCaptureScreenModel(state: InboxCaptureState())
        var reported = 0
        let viewModel = JournalCaptureViewModel(model: model, onCaptured: { reported += 1 })
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(InboxCaptureState(sending: true))
        try await eventually { viewModel.state.sending }
        XCTAssertEqual(viewModel.captured, 0)
        XCTAssertEqual(reported, 0, "A state change reports no capture")
        model.emit(.captured)
        try await eventually { viewModel.captured == 1 }
        XCTAssertEqual(reported, 1)
        model.emit(.captured)
        try await eventually { viewModel.captured == 2 }
        XCTAssertEqual(viewModel.captured, 2)
        XCTAssertEqual(reported, 2)
    }

    private func page(width: CGFloat) -> PDFPage {
        let page = PDFPage()
        page.setBounds(CGRect(x: 0, y: 0, width: width, height: 800), for: .mediaBox)
        return page
    }

    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("The condition did not hold in time")
    }
}
