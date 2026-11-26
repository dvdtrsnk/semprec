import XCTest

@testable import CalendarFeature

final class CalendarMenuPlacementTests: XCTestCase {

    private let menu = CGSize(width: 280, height: 44)
    private let container = CGSize(width: 400, height: 800)

    private func origin(_ anchor: CGRect, top: CGFloat = 100, bottom: CGFloat = 660) -> CGPoint {
        CalendarMenuPlacement.origin(menu: menu, anchor: anchor, container: container, top: top, bottom: bottom)
    }

    // MARK: - Below
    func testTheMenuSitsCentredUnderTheItemWhenThereIsRoom() {
        let place = origin(CGRect(x: 60, y: 200, width: 280, height: 56))
        XCTAssertEqual(place.x, 60)
        XCTAssertEqual(place.y, 200 + 56 + CalendarMenuPlacement.gap)
    }

    func testTheMenuStaysInsideTheSidesOfTheScreen() {
        let left = origin(CGRect(x: 0, y: 200, width: 60, height: 56))
        XCTAssertEqual(left.x, CalendarMenuPlacement.margin)
        let right = origin(CGRect(x: 350, y: 200, width: 50, height: 56))
        XCTAssertEqual(right.x, container.width - CalendarMenuPlacement.margin - menu.width)
    }

    // MARK: - Above
    func testTheMenuMovesAboveTheItemWhenTheBarsAtTheBottomLeaveNoRoom() {
        let place = origin(CGRect(x: 60, y: 600, width: 280, height: 56))
        XCTAssertEqual(place.y, 600 - CalendarMenuPlacement.gap - menu.height)
    }

    func testTheMenuStaysBelowTheItemWhenItJustFitsBeforeTheBars() {
        // 560 + 8 + 44 = 612 <= 660, and one point lower would be 660 + 1 > 660.
        let fits = origin(CGRect(x: 60, y: 500, width: 280, height: 52))
        XCTAssertEqual(fits.y, 560)
        let tooLow = origin(CGRect(x: 60, y: 500, width: 280, height: 109))
        XCTAssertEqual(tooLow.y, 500 - CalendarMenuPlacement.gap - menu.height)
    }

    // MARK: - Inside
    func testTheMenuSitsOverTheMiddleOfAnItemThatFillsTheFreePart() {
        let place = origin(CGRect(x: 60, y: 50, width: 280, height: 900))
        // The free part is 100 to 660; its middle is 380.
        XCTAssertEqual(place.y, 380 - menu.height / 2)
    }

    func testTheMenuNeverGoesAboveTheTopOfTheFreePart() {
        let place = origin(CGRect(x: 60, y: -300, width: 280, height: 1000), top: 100, bottom: 160)
        XCTAssertGreaterThanOrEqual(place.y, 100)
    }
}
