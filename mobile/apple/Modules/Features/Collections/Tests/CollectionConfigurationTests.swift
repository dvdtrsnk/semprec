import XCTest

@testable import CollectionsFeature

/// What the engine knows about the collections that are configured on it: the symbols of their databases and the way a
/// rating is read out.
final class CollectionConfigurationTests: XCTestCase {

    func testEveryConfiguredCollectionHasItsOwnSymbol() {
        let keys = ["healthRecords", "books", "movies", "recipes"]
        let symbols = keys.map { CollectionIcon.symbol(forDatabase: $0) }
        XCTAssertEqual(symbols, ["cross.case", "books.vertical", "film", "fork.knife"])
        XCTAssertEqual(CollectionIcon.symbol(forDatabase: "unknown"), "square.grid.2x2")
        XCTAssertEqual(CollectionIcon.symbol(forDatabase: nil), "square.grid.2x2")
    }

    func testTheNamesTheServerGivesADatabaseKeepTheirSymbols() {
        XCTAssertEqual(CollectionIcon.symbol(for: "book"), "book")
        XCTAssertEqual(CollectionIcon.symbol(for: "film"), "film")
        XCTAssertEqual(CollectionIcon.symbol(for: "fork-knife"), "fork.knife")
        XCTAssertEqual(CollectionIcon.symbol(for: "heart"), "heart")
    }

    @MainActor
    func testARatingIsReadOutAsItsStarsOfFive() {
        let label = RatingStars.label(4)
        XCTAssertTrue(label.contains("4") && label.contains("5"), label)
        XCTAssertNotEqual(RatingStars.label(4), RatingStars.label(5))
        XCTAssertEqual(RatingStars.maximum, 5)
    }
}
