import CoreKit
import Foundation
import PDFKit
import XCTest

@testable import Alldots

/// The presenter between `ScanIntoInboxIntent` and the scanner: which scene shows it, and what each way a scan ends
/// captures and answers, over a capture double and a fixed clock.
@MainActor
final class ScanPresenterTests: XCTestCase {

    private let scene = UUID()

    // MARK: - Finishing
    func testAFinishedScanCapturesOnePdfOnTheDayItIsFinishedAndAnswersSaved() async throws {
        let captures = CaptureRecorder()
        let presenter = try presenter(captures)

        let scan = Task { await presenter.scan(Self.request) }
        try await eventually { presenter.request != nil }
        presenter.claim(scene: scene)
        XCTAssertEqual(presenter.scene, scene)
        presenter.finish(pages: [page(), page()])
        XCTAssertNil(presenter.request, "Finishing closes the scanner at once")
        XCTAssertNil(presenter.scene)
        let outcome = await scan.value

        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(captures.calls.count, 1)
        let call = try XCTUnwrap(captures.calls.first)
        XCTAssertEqual(call.day, "2026-11-27", "Without a chosen day the scan is kept on the day it is finished")
        XCTAssertEqual(call.time, "07:45")
        XCTAssertEqual(call.file.filename, "Scan 2026-11-27 07-45.pdf")
        XCTAssertEqual(call.file.mimeType, "application/pdf")
        XCTAssertEqual(call.file.source, .camera)
        let document = try XCTUnwrap(PDFDocument(data: try XCTUnwrap(Data(base64Encoded: call.file.base64))))
        XCTAssertEqual(document.pageCount, 2)
        try await eventually { captures.reported == 1 }
        XCTAssertEqual(captures.reported, 1, "A kept scan is reported once, so its background sending is scheduled")
    }

    func testAKeptScanIsReportedBeforeTheIntentHearsItWasSaved() async throws {
        let captures = CaptureRecorder()
        let presenter = try presenter(captures) {
            try? await Task.sleep(for: .milliseconds(50))
            captures.reported += 1
        }

        let scan = Task { await presenter.scan(Self.request) }
        try await eventually { presenter.request != nil }
        presenter.claim(scene: scene)
        presenter.finish(pages: [page()])
        let outcome = await scan.value

        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(captures.reported, 1, "The background sending is scheduled before the intent's brief send")
    }

    func testAFinishedScanKeepsTheChosenDay() async throws {
        let captures = CaptureRecorder()
        let presenter = try presenter(captures)
        let day = try XCTUnwrap(Calendar.current.date(from: DateComponents(year: 2026, month: 11, day: 20)))

        let scan = Task { await presenter.scan(ScanPresenter.Request(day: day)) }
        try await eventually { presenter.request != nil }
        presenter.finish(pages: [page()])
        let outcome = await scan.value

        XCTAssertEqual(outcome, .saved)
        let call = try XCTUnwrap(captures.calls.first)
        XCTAssertEqual(call.day, "2026-11-20")
        XCTAssertEqual(call.time, "07:45")
    }

    func testACaptureTheOutboxRefusesAnswersItsFailure() async throws {
        let captures = CaptureRecorder(answer: Failed(kind: .unauthorized))
        let presenter = try presenter(captures)

        let scan = Task { await presenter.scan(Self.request) }
        try await eventually { presenter.request != nil }
        presenter.finish(pages: [page()])
        let outcome = await scan.value

        XCTAssertEqual(outcome, .failed(Failed(kind: .unauthorized)))
        XCTAssertEqual(captures.calls.count, 1)
        await Task.yield()
        XCTAssertEqual(captures.reported, 0, "A capture that was not kept is not reported")
    }

    func testAScanFinishedWithNoPageCapturesNothingAndAnswersCancelled() async throws {
        let captures = CaptureRecorder()
        let presenter = try presenter(captures)

        let scan = Task { await presenter.scan(Self.request) }
        try await eventually { presenter.request != nil }
        presenter.finish(pages: [])
        let outcome = await scan.value

        XCTAssertEqual(outcome, .cancelled)
        XCTAssertTrue(captures.calls.isEmpty)
        XCTAssertNil(presenter.request)
    }

    func testFinishingWithoutARequestCapturesNothing() async throws {
        let captures = CaptureRecorder()
        let presenter = try presenter(captures)

        presenter.finish(pages: [page()])
        await Task.yield()

        XCTAssertTrue(captures.calls.isEmpty)
    }

    // MARK: - Cancelling and failing
    func testACancelledScanCapturesNothingAndAnswersCancelled() async throws {
        let captures = CaptureRecorder()
        let presenter = try presenter(captures)

        let scan = Task { await presenter.scan(Self.request) }
        try await eventually { presenter.request != nil }
        presenter.claim(scene: scene)
        presenter.cancel()
        let outcome = await scan.value

        XCTAssertEqual(outcome, .cancelled)
        XCTAssertTrue(captures.calls.isEmpty)
        XCTAssertNil(presenter.request)
        XCTAssertNil(presenter.scene)
    }

    func testAFailedScannerCapturesNothingAndAnswersAnUnexpectedFailure() async throws {
        let captures = CaptureRecorder()
        let presenter = try presenter(captures)

        let scan = Task { await presenter.scan(Self.request) }
        try await eventually { presenter.request != nil }
        presenter.fail()
        let outcome = await scan.value

        XCTAssertEqual(outcome, .failed(Failed(kind: nil)))
        XCTAssertTrue(captures.calls.isEmpty)
        XCTAssertNil(presenter.request)
    }

    func testANewScanEndsTheOneThatWaitsAsCancelledAndTakesItsPlace() async throws {
        let captures = CaptureRecorder()
        let presenter = try presenter(captures)
        let second = ScanPresenter.Request(day: nil)

        let first = Task { await presenter.scan(Self.request) }
        try await eventually { presenter.request != nil }
        presenter.claim(scene: scene)
        let next = Task { await presenter.scan(second) }
        let firstOutcome = await first.value
        try await eventually { presenter.request == second }

        XCTAssertEqual(firstOutcome, .cancelled)
        XCTAssertEqual(presenter.request, second)
        XCTAssertNil(presenter.scene, "The new request waits for a scene to claim it")
        presenter.finish(pages: [page()])
        let nextOutcome = await next.value
        XCTAssertEqual(nextOutcome, .saved)
        XCTAssertEqual(captures.calls.count, 1, "Only the scan that took the place of the first one is captured")
    }

    // MARK: - Claiming
    func testOnlyTheFirstSceneToClaimARequestShowsTheScanner() async throws {
        let presenter = try presenter(CaptureRecorder())

        presenter.claim(scene: scene)
        XCTAssertNil(presenter.scene, "Nothing is shown while no scan is asked for")

        let scan = Task { await presenter.scan(Self.request) }
        try await eventually { presenter.request != nil }
        presenter.claim(scene: scene)
        presenter.claim(scene: UUID())
        XCTAssertEqual(presenter.scene, scene)

        presenter.cancel()
        _ = await scan.value
    }

    // MARK: - Private
    private static let request = ScanPresenter.Request(day: nil)

    private func presenter(
        _ captures: CaptureRecorder,
        captured: (@MainActor () async -> Void)? = nil
    ) throws -> ScanPresenter {
        let parts = DateComponents(year: 2026, month: 11, day: 27, hour: 7, minute: 45)
        let now = try XCTUnwrap(Calendar.current.date(from: parts))
        return ScanPresenter(
            capture: { day, time, file in captures.record(CaptureRecorder.Call(day: day, time: time, file: file)) },
            captured: captured ?? { captures.reported += 1 },
            now: { now }
        )
    }

    private func page() -> PDFPage {
        let page = PDFPage()
        page.setBounds(CGRect(x: 0, y: 0, width: 600, height: 800), for: .mediaBox)
        return page
    }
}

/// The captures a presenter wrote, answering each with `answer`.
@MainActor
private final class CaptureRecorder {

    struct Call {
        let day: String
        let time: String
        let file: InboxShortcutCapture.File
    }

    // MARK: - Properties
    private(set) var calls: [Call] = []
    /// How often the presenter reported a kept capture.
    var reported = 0
    private let answer: Failed?

    // MARK: - Init
    init(answer: Failed? = nil) {
        self.answer = answer
    }

    // MARK: - Methods
    func record(_ call: Call) -> Failed? {
        calls.append(call)
        return answer
    }
}
