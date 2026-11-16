import CoreKit
import XCTest

@testable import AccountFeature

final class AiUsageViewModelTests: XCTestCase {

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedAiUsageScreenModel(state: AiUsageState())
        let viewModel = AiUsageViewModel(model: model)
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(AiUsageState(phase: .content, period: .all, totalUsd: 24.12))
        try await eventually { viewModel.state.totalUsd == 24.12 }
        XCTAssertEqual(viewModel.state.period, .all)
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedAiUsageScreenModel(state: AiUsageState())
        let viewModel = AiUsageViewModel(model: model)
        viewModel.retry()
        viewModel.select(.month("2026-10"))
        viewModel.pick(3)
        XCTAssertEqual(model.actions, [.retry, .selectPeriod(.month("2026-10")), .pickPoint(3)])
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedAiUsageScreenModel?
        var viewModel: AiUsageViewModel?
        do {
            let model = ScriptedAiUsageScreenModel(state: AiUsageState())
            weakModel = model
            viewModel = AiUsageViewModel(model: model)
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    // MARK: - Formatting
    private let english = Locale(identifier: "en_US")
    private let czech = Locale(identifier: "cs_CZ")

    func testAPointIsLabelledByItsDayOrItsMonth() {
        XCTAssertEqual(AiUsageFormat.pointLabel("2026-10-21", locale: english), "10/21")
        XCTAssertEqual(AiUsageFormat.pointLabel("2026-10-21", locale: czech).filter { !$0.isWhitespace }, "21.10.")
        XCTAssertEqual(AiUsageFormat.pointLabel("2026-10", locale: english), "Oct 26")
        XCTAssertEqual(AiUsageFormat.pointLabel("soon", locale: english), "soon")
    }

    func testAMonthIsNamedInTheLanguageOfTheLocale() {
        XCTAssertEqual(AiUsageFormat.monthName("2026-10", locale: english), "October")
        XCTAssertEqual(AiUsageFormat.monthName("2026-10", locale: czech), "Říjen")
        XCTAssertNil(AiUsageFormat.monthName("2026-13", locale: english))
        XCTAssertEqual(AiUsageFormat.chip(.month("2026-10"), locale: english), "October")
        XCTAssertEqual(AiUsageFormat.chip(.month("garbage"), locale: english), "garbage")
    }

    func testPricesUnitsAndSharesFollowTheSeparatorsOfTheLocale() {
        XCTAssertEqual(AiUsageFormat.usd(24.1, locale: english), "$24.10")
        XCTAssertEqual(AiUsageFormat.usd(24.1, locale: czech), "$24,10")
        XCTAssertEqual(AiUsageFormat.tokens(3_900_000, locale: english), "3.9 M")
        XCTAssertEqual(AiUsageFormat.tokens(3_900_000, locale: czech), "3,9 M")
        XCTAssertEqual(AiUsageFormat.tokens(12_600, locale: english), "13 k")
        XCTAssertEqual(AiUsageFormat.minutes(8040, locale: english), "134")
        XCTAssertEqual(AiUsageFormat.percent(0.62, locale: english), "62%")
    }

    // MARK: - Helpers
    @MainActor
    private func eventually(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("The condition did not hold in time")
    }
}
