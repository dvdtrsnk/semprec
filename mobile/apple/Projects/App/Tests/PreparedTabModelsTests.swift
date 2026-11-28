import CoreKit
import XCTest

@testable import Alldots

@MainActor
final class PreparedTabModelsTests: XCTestCase {

    func testPreparingMakesTheCalendarAndTheDiaryOnceForTheDay() {
        let models = SignedInModels()
        let prepared = PreparedTabModels(models: models)
        prepared.prepare(today: "2026-11-24")
        prepared.prepare(today: "2026-11-24")
        XCTAssertEqual(models.calendarDays, ["2026-11-24"])
        XCTAssertEqual(models.journalDays, ["2026-11-24"])
    }

    func testATabAskingForThePreparedDayGetsThePreparedModelOnce() {
        let models = SignedInModels()
        let prepared = PreparedTabModels(models: models)
        prepared.prepare(today: "2026-11-24")
        let calendar = prepared.calendarModel(initialDay: "2026-11-24")
        let journal = prepared.journalModel(initialDay: "2026-11-24")
        XCTAssertEqual(models.calendarDays, ["2026-11-24"], "The prepared calendar is handed out, not made again")
        XCTAssertEqual(models.journalDays, ["2026-11-24"], "The prepared diary is handed out, not made again")
        // A second tab (another window, a tab made again) gets a model of its own: one model has one owner.
        let again = prepared.calendarModel(initialDay: "2026-11-24")
        XCTAssertFalse(again as AnyObject === calendar as AnyObject)
        XCTAssertEqual(models.calendarDays, ["2026-11-24", "2026-11-24"])
        XCTAssertNotNil(journal)
    }

    func testATabAskingForAnotherDayGetsANewModelAndThePreparedOneIsDropped() {
        let models = SignedInModels()
        let prepared = PreparedTabModels(models: models)
        prepared.prepare(today: "2026-11-24")
        _ = prepared.calendarModel(initialDay: "2026-11-25")
        _ = prepared.journalModel(initialDay: "2026-11-25")
        XCTAssertEqual(models.calendarDays, ["2026-11-24", "2026-11-25"])
        XCTAssertEqual(models.journalDays, ["2026-11-24", "2026-11-25"])
        // Nothing prepared is left to hand out.
        _ = prepared.calendarModel(initialDay: "2026-11-24")
        XCTAssertEqual(models.calendarDays, ["2026-11-24", "2026-11-25", "2026-11-24"])
    }

    func testATabOpenedBeforeAnythingWasPreparedMakesItsOwnModel() {
        let models = SignedInModels()
        let prepared = PreparedTabModels(models: models)
        _ = prepared.journalModel(initialDay: "2026-11-24")
        XCTAssertEqual(models.journalDays, ["2026-11-24"])
        prepared.prepare(today: "2026-11-24")
        XCTAssertEqual(models.calendarDays, ["2026-11-24"])
        XCTAssertEqual(models.journalDays, ["2026-11-24", "2026-11-24"], "The diary is prepared for a later tab")
    }

    func testTheCompositionPreparesFromTheScreenModelsOfItsScene() {
        let models = SignedInModels()
        let composition = AppComposition(models: models)
        composition.preparedTabs.prepare(today: "2026-11-24")
        _ = composition.preparedTabs.calendarModel(initialDay: "2026-11-24")
        XCTAssertEqual(models.calendarDays, ["2026-11-24"])
    }
}
