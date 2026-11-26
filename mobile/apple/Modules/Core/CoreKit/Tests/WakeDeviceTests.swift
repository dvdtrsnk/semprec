import CoreGraphics
import SharedSDK
import XCTest

@testable import CoreKit

/// The device adapters of the wake missions: the storage in the user defaults, the beep and the camera's codes.
final class WakeDeviceTests: XCTestCase {

    // MARK: - Wake storage
    @MainActor
    func testTheWakeStorageKeepsSettingsAndMissionsAcrossInstances() throws {
        let defaults = try Self.isolatedDefaults()
        let storage = DefaultsWakeStorage(defaults: defaults)
        XCTAssertFalse(storage.loadSettings().requiresCode)
        XCTAssertEqual(storage.loadMissions().count, 0)

        storage.saveSettings(settings: SharedSDK.WakeSettings(requiresCode: true, codes: ["1", "2"]))
        storage.saveMissions(missions: [
            SharedSDK.WakeMission(
                key: "sleep:k", ringAtEpochSeconds: 100, alarmId: "a", codes: ["1"], watchIds: ["w1", "w2"], armed: true
            )
        ])

        let again = DefaultsWakeStorage(defaults: defaults)
        XCTAssertEqual(again.loadSettings().requiresCode, true)
        XCTAssertEqual(again.loadSettings().codes, ["1", "2"])
        let mission = try XCTUnwrap(again.loadMissions().first)
        XCTAssertEqual(mission.key, "sleep:k")
        XCTAssertEqual(mission.ringAtEpochSeconds, 100)
        XCTAssertEqual(mission.alarmId, "a")
        XCTAssertEqual(mission.codes, ["1"])
        XCTAssertEqual(mission.watchIds, ["w1", "w2"])
        XCTAssertTrue(mission.armed)
    }

    @MainActor
    func testStoredValuesThatCannotBeReadCountAsNothingStored() throws {
        let defaults = try Self.isolatedDefaults()
        defaults.set(Data("not json".utf8), forKey: "cz.semprec.wakeSettings")
        defaults.set(Data("not json".utf8), forKey: "cz.semprec.wakeMissions")

        let storage = DefaultsWakeStorage(defaults: defaults)

        XCTAssertFalse(storage.loadSettings().requiresCode)
        XCTAssertEqual(storage.loadSettings().codes, [])
        XCTAssertEqual(storage.loadMissions().count, 0)
    }

    // MARK: - The device services
    @MainActor
    func testFactoriesGivenTheSameDeviceServicesShareTheWakeSettingsAndOthersDoNot() throws {
        let services = SharedDeviceNotifications(sessionStore: .memory).deviceServices
        let first = SharedScreenModelFactory(sessionStore: .memory, deviceServices: services)
        let second = SharedScreenModelFactory(sessionStore: .memory, deviceServices: services)
        let apart = isolatedFactory()
        let firstSettings = first.makeWakeSettings()
        let secondSettings = second.makeWakeSettings()
        let apartSettings = apart.makeWakeSettings()

        firstSettings.send(.addCode("123"))

        XCTAssertEqual(secondSettings.state.codes, ["123"])
        XCTAssertEqual(apartSettings.state.codes, [])
    }

    // MARK: - The beep
    func testTheBeepSoundsTwiceAndIsSilentInThePausesOfEverySecond() {
        let samples = stride(from: 0.0, to: 3.0, by: 0.0005).map { ($0, BeepTone.value(at: $0)) }

        for (time, value) in samples {
            let position = time.truncatingRemainder(dividingBy: 1)
            let sounding = position < 0.15 || (position >= 0.25 && position < 0.4)
            if sounding {
                XCTAssertEqual(abs(value), BeepTone.amplitude, "sounds at \(time)")
            } else {
                XCTAssertEqual(value, 0, "is silent at \(time)")
            }
        }
        XCTAssertTrue(samples.contains { $0.1 > 0 } && samples.contains { $0.1 < 0 }, "the wave swings both ways")
    }

    @MainActor
    func testEveryStopDetachesTheSourceNodeSoThatPlayingAgainAddsNoSecondOne() throws {
        let beep = DeviceAlarmBeep()
        try XCTSkipUnless(beep.start(), "This host has no audio output to start the engine on")
        XCTAssertNotNil(beep.source)

        beep.stop()
        XCTAssertNil(beep.source, "The node must leave the engine when the beep stops")

        XCTAssertTrue(beep.start())
        XCTAssertNotNil(beep.source)
        beep.stop()
        XCTAssertNil(beep.source)
    }

    // MARK: - The camera's codes
    func testTheCameraOutputYieldsACodeOnceWhileItIsSeenAndAgainAfterTheInterval() async {
        let (codes, codeContinuation) = AsyncStream.makeStream(of: String.self)
        let (_, frameContinuation) = AsyncStream.makeStream(of: CGImage.self)
        let output = CameraOutput(codes: codeContinuation, frames: frameContinuation)
        let start = Date(timeIntervalSince1970: 1_000)

        output.report("123", at: start)
        output.report("123", at: start.addingTimeInterval(0.5))
        output.report("456", at: start.addingTimeInterval(0.6))
        output.report("123", at: start.addingTimeInterval(0.7))
        output.report("123", at: start.addingTimeInterval(3))
        codeContinuation.finish()

        var yielded: [String] = []
        for await code in codes { yielded.append(code) }
        XCTAssertEqual(yielded, ["123", "456", "123", "123"], "456 in between made 123 new again")
    }

    func testACodeIsReportedOnceWhileTheCameraKeepsSeeingItAndAgainAfterTheInterval() {
        var filter = CodeRepeatFilter()
        let start = Date(timeIntervalSince1970: 1_000)

        XCTAssertTrue(filter.accepts("123", at: start))
        XCTAssertFalse(filter.accepts("123", at: start.addingTimeInterval(0.1)))
        XCTAssertFalse(filter.accepts("123", at: start.addingTimeInterval(1.9)))
        XCTAssertTrue(filter.accepts("123", at: start.addingTimeInterval(2)))
        XCTAssertTrue(filter.accepts("456", at: start.addingTimeInterval(2.1)))
        XCTAssertTrue(filter.accepts("123", at: start.addingTimeInterval(2.2)), "another code in between resets it")
    }
}

// MARK: - Helpers
private extension WakeDeviceTests {

    static func isolatedDefaults() throws -> UserDefaults {
        try XCTUnwrap(UserDefaults(suiteName: "cz.semprec.tests.\(UUID().uuidString)"))
    }
}
