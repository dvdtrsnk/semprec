import Combine
import CoreGraphics
import SwiftUI
import XCTest

@testable import Semprec

/// Where the Semp bubble is: docked in Semp's button of the tab bar while that button is shown and on top, floating
/// wherever the tab bar is hidden or covered, gone under an alert; and what the tab view's Semp button selects.
final class SempDockTests: XCTestCase {

    private let slot = CGRect(x: 319, y: 791, width: 62, height: 62)

    // MARK: - State
    func testAShownButtonOnTopDocksTheBubbleInIt() {
        let reading = SempDockReading(slot: slot, slotOnTop: true, alertShown: false)
        XCTAssertEqual(SempDock.state(for: reading), .docked(slot))
        XCTAssertEqual(SempDock.state(for: reading).dock, slot)
    }

    func testAButtonCoveredByAPresentationOrAHiddenTabBarFloatsTheBubble() {
        XCTAssertEqual(SempDock.state(for: SempDockReading(slot: slot, slotOnTop: false, alertShown: false)), .floating)
        XCTAssertEqual(SempDock.state(for: .noTabBar), .floating)
        XCTAssertNil(SempDock.state(for: .noTabBar).dock)
    }

    func testAnAlertHidesTheBubbleWhereverTheTabBarIs() {
        XCTAssertEqual(SempDock.state(for: SempDockReading(slot: slot, slotOnTop: true, alertShown: true)), .hidden)
        XCTAssertEqual(SempDock.state(for: SempDockReading(slot: nil, slotOnTop: false, alertShown: true)), .hidden)
    }

    @MainActor
    func testTheDockPublishesOnlyAChangedState() {
        let dock = SempDock()
        var published: [SempDockState] = []
        let subscription = dock.$state.dropFirst().sink { published.append($0) }
        let docked = SempDockReading(slot: slot, slotOnTop: true, alertShown: false)

        dock.read(docked)
        dock.read(docked)
        dock.read(.noTabBar)

        XCTAssertEqual(published, [.docked(slot), .floating])
        subscription.cancel()
    }

    // MARK: - Selection
    @MainActor
    func testSelectingAnAreaSelectsItsTab() {
        var tab = AppTab.overview
        let chat = SempChatPresenter()
        let selection = SceneTab.selection(Binding(get: { tab }, set: { tab = $0 }), chat: chat)

        selection.wrappedValue = .area(.journal)

        XCTAssertEqual(tab, .journal)
        XCTAssertEqual(selection.wrappedValue, .area(.journal))
        XCTAssertFalse(chat.isPresented)
    }

    @MainActor
    func testSelectingSempsButtonOpensTheChatAndKeepsTheTab() {
        var tab = AppTab.calendar
        let chat = SempChatPresenter()
        let selection = SceneTab.selection(Binding(get: { tab }, set: { tab = $0 }), chat: chat)

        selection.wrappedValue = .semp

        XCTAssertTrue(chat.isPresented)
        XCTAssertEqual(chat.root, .latest)
        XCTAssertEqual(tab, .calendar)
        XCTAssertEqual(selection.wrappedValue, .area(.calendar))
    }
}
