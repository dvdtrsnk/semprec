import CoreKit
import XCTest

@testable import AccountFeature

final class DevicesViewModelTests: XCTestCase {

    // MARK: - Properties
    private let mac = DeviceItem(
        id: "s2",
        kind: .mac,
        platform: .macos,
        name: "MacBook",
        createdAt: "2026-09-12T10:00:00Z",
        lastSeenAt: "2026-10-21T08:00:00Z"
    )

    // MARK: - Tests
    @MainActor
    func testStartsFromTheCurrentStateAndRepublishesChanges() async throws {
        let model = ScriptedDevicesScreenModel(state: DevicesState())
        let viewModel = DevicesViewModel(model: model)
        XCTAssertEqual(viewModel.state.phase, .loading)
        let observer = Task { await viewModel.observe() }
        defer { observer.cancel() }
        model.publish(DevicesState(phase: .content, others: [mac]))
        try await eventually { viewModel.state.others == [mac] }
        model.publish(DevicesState(phase: .error, failure: .unavailable))
        try await eventually { viewModel.state.failure == .unavailable }
    }

    @MainActor
    func testIntentsAreForwardedToTheModel() {
        let model = ScriptedDevicesScreenModel(state: DevicesState())
        let viewModel = DevicesViewModel(model: model)
        viewModel.retry()
        viewModel.ask(mac)
        viewModel.askOthers()
        viewModel.cancel()
        viewModel.confirm()
        viewModel.dismissFailure()
        XCTAssertEqual(
            model.actions,
            [.retry, .ask(deviceId: "s2"), .askOthers, .cancel, .confirm, .dismissFailure]
        )
    }

    @MainActor
    func testReleasingTheViewModelReleasesItsModel() {
        weak var weakModel: ScriptedDevicesScreenModel?
        var viewModel: DevicesViewModel?
        do {
            let model = ScriptedDevicesScreenModel(state: DevicesState())
            weakModel = model
            viewModel = DevicesViewModel(model: model)
        }
        XCTAssertNotNil(weakModel)
        viewModel = nil
        XCTAssertNil(weakModel)
        XCTAssertNil(viewModel)
    }

    // MARK: - Words
    @MainActor
    func testADeviceIsNamedByItsOwnNameOrByItsKind() {
        XCTAssertEqual(DeviceRow.name(of: mac), "MacBook")
        let unnamed = DeviceItem(id: "s", kind: .browser, platform: .web, name: nil, createdAt: "", lastSeenAt: "")
        XCTAssertFalse(DeviceRow.name(of: unnamed).isEmpty)
        XCTAssertNotEqual(DeviceRow.name(of: unnamed), DeviceRow.name(of: DeviceItem(
            id: "s", kind: .ipad, platform: .ios, name: nil, createdAt: "", lastSeenAt: ""
        )))
    }

    @MainActor
    func testEveryKindHasItsOwnSymbolAndEveryPlatformItsOwnName() {
        let kinds: [AccountDeviceKind] = [.iphone, .ipad, .mac, .browser, .unknown]
        XCTAssertEqual(Set(kinds.map(DeviceRow.symbol(of:))).count, kinds.count)
        let platforms: [AccountPlatform] = [.web, .ios, .macos, .unknown]
        XCTAssertEqual(Set(platforms.map(DeviceRow.platformName)).count, platforms.count)
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
