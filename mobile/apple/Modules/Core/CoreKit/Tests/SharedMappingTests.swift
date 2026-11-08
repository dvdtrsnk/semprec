import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the bridges' mappings between Kotlin and Swift values with Kotlin values built here. The
/// in-memory repository behind `HomeSDK` never fails and is never empty, so the real ViewModels never reach most of
/// these branches. Both modules declare most of these type names, so each is qualified with its module.
final class SharedMappingTests: XCTestCase {

    // MARK: - Home
    @MainActor
    func testHomeMapsEveryPhase() {
        let items = [SharedSDK.HomeItem(id: "item-7", ordinal: 7), SharedSDK.HomeItem(id: "item-3", ordinal: 3)]
        XCTAssertEqual(SharedHomeScreenModel.state(homeState(.loading)), .loading)
        XCTAssertEqual(
            SharedHomeScreenModel.state(homeState(.content, items: items)),
            .content([
                CoreKit.PlaceholderItem(id: "item-7", ordinal: 7),
                CoreKit.PlaceholderItem(id: "item-3", ordinal: 3)
            ])
        )
        XCTAssertEqual(SharedHomeScreenModel.state(homeState(.empty)), .empty)
    }

    @MainActor
    func testHomeMapsEachFailure() {
        XCTAssertEqual(SharedHomeScreenModel.state(homeState(.error, failure: .unavailable)), .failure(.unavailable))
        XCTAssertEqual(SharedHomeScreenModel.state(homeState(.error, failure: .invalidData)), .failure(.invalidData))
        XCTAssertEqual(SharedHomeScreenModel.state(homeState(.error)), .failure(nil))
    }

    @MainActor
    func testHomeMapsEachAction() {
        XCTAssertEqual(SharedHomeScreenModel.action(.retry) as? NSObject, SharedSDK.HomeActionRetry.shared)
        XCTAssertEqual(
            SharedHomeScreenModel.action(.selectItem(id: "item-2")) as? NSObject,
            SharedSDK.HomeActionSelectItem(id: "item-2")
        )
    }

    @MainActor
    func testHomeMapsEachEffect() {
        XCTAssertEqual(
            SharedHomeScreenModel.effect(SharedSDK.HomeEffectOpenDetail(id: "item-4")),
            .openDetail(id: "item-4")
        )
    }

    // MARK: - Detail
    @MainActor
    func testDetailMapsEveryPhase() {
        XCTAssertEqual(SharedDetailScreenModel.state(detailState(.loading)), .loading)
        XCTAssertEqual(
            SharedDetailScreenModel.state(detailState(.content, item: SharedSDK.HomeItem(id: "item-3", ordinal: 3))),
            .content(CoreKit.PlaceholderItem(id: "item-3", ordinal: 3))
        )
        XCTAssertEqual(SharedDetailScreenModel.state(detailState(.notFound)), .notFound)
    }

    @MainActor
    func testDetailContentWithoutAnItemIsAnUnexpectedFailure() {
        XCTAssertEqual(SharedDetailScreenModel.state(detailState(.content)), .failure(nil))
    }

    @MainActor
    func testDetailMapsEachFailure() {
        XCTAssertEqual(
            SharedDetailScreenModel.state(detailState(.error, failure: .unavailable)),
            .failure(.unavailable)
        )
        XCTAssertEqual(
            SharedDetailScreenModel.state(detailState(.error, failure: .invalidData)),
            .failure(.invalidData)
        )
        XCTAssertEqual(SharedDetailScreenModel.state(detailState(.error)), .failure(nil))
    }

    @MainActor
    func testDetailMapsEachAction() {
        XCTAssertEqual(SharedDetailScreenModel.action(.retry) as? NSObject, SharedSDK.DetailActionRetry.shared)
    }

    // MARK: - Settings
    @MainActor
    func testSettingsMapsTheRowsInOrder() {
        XCTAssertEqual(
            SharedSettingsScreenModel.state(SharedSDK.SettingsState(rows: [.about])),
            CoreKit.SettingsState(rows: [.about])
        )
        XCTAssertEqual(
            SharedSettingsScreenModel.state(SharedSDK.SettingsState(rows: [])),
            CoreKit.SettingsState(rows: [])
        )
    }

    @MainActor
    func testSettingsMapsEachAction() {
        XCTAssertEqual(
            SharedSettingsScreenModel.action(.selectRow(.about)) as? NSObject,
            SharedSDK.SettingsActionSelectRow(row: .about)
        )
    }

    @MainActor
    func testSettingsMapsEachEffect() {
        XCTAssertEqual(SharedSettingsScreenModel.effect(SharedSDK.SettingsEffectShowAbout.shared), .showAbout)
    }

    // MARK: - Shared values
    func testFailureKindMapsEachKotlinKind() {
        XCTAssertEqual(CoreKit.FailureKind(SharedSDK.FailureKind.unavailable), .unavailable)
        XCTAssertEqual(CoreKit.FailureKind(SharedSDK.FailureKind.invalidData), .invalidData)
    }

    func testSettingsRowMapsEachRowBothWays() {
        XCTAssertEqual(CoreKit.SettingsRow(SharedSDK.SettingsRow.about), .about)
        XCTAssertEqual(CoreKit.SettingsRow.about.shared, SharedSDK.SettingsRow.about)
    }
}

// MARK: - Helpers
private extension SharedMappingTests {

    func homeState(
        _ phase: SharedSDK.HomePhase,
        items: [SharedSDK.HomeItem] = [],
        failure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.HomeState {
        SharedSDK.HomeState(phase: phase, items: items, failure: failure)
    }

    func detailState(
        _ phase: SharedSDK.DetailPhase,
        item: SharedSDK.HomeItem? = nil,
        failure: SharedSDK.FailureKind? = nil
    ) -> SharedSDK.DetailState {
        SharedSDK.DetailState(phase: phase, item: item, failure: failure)
    }
}
