import XCTest

@testable import Semprec

/// What the wake settings screen says the switch does. The tests run in English, so the texts below are the English
/// ones of the String Catalog.
final class SleepWakeScreenTests: XCTestCase {

    @MainActor
    func testTheFooterSaysWhatTheSwitchDoesForEachSetting() {
        XCTAssertEqual(
            SleepWakeScreen.footer(SleepWakeSettings(requiresCode: false, codes: ["590"])),
            "The sleep plan's alarms stop with the system's Stop button."
        )
        XCTAssertEqual(
            SleepWakeScreen.footer(SleepWakeSettings(requiresCode: true, codes: ["  "])),
            "Add at least one code. Until then the alarm stops with the system's Stop button."
        )
        XCTAssertTrue(
            SleepWakeScreen.footer(SleepWakeSettings(requiresCode: true, codes: ["590"]))
                .hasPrefix("The alarm rings until you scan one of the codes")
        )
    }
}
