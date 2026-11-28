import XCTest

@testable import Alldots

/// The one universal link the app opens: a password-reset link of alldots.app, read strictly. Every other address
/// opens nothing.
final class PasswordResetLinkTests: XCTestCase {

    // MARK: - Tests
    func testTheMailedLinkOpensWithItsTokenAndTheServerOfItsOrigin() throws {
        let token = "q1W2e3R4t5Y6u7I8o9P0a-S_d1F2g3H4j5K6l7Z8x9C"
        let links = [
            "https://alldots.app/?page=password-reset#token=\(token)",
            "https://alldots.app?page=password-reset#token=\(token)",
            "HTTPS://AllDots.App/?page=password-reset#token=\(token)",
            "https://alldots.app/?utm_source=mail&page=password-reset#token=\(token)"
        ]
        for text in links {
            let link = try XCTUnwrap(PasswordResetLink(url: try XCTUnwrap(URL(string: text))), text)
            XCTAssertEqual(link.serverUrl, "https://alldots.app", text)
            XCTAssertEqual(link.token, token, text)
        }
    }

    func testEveryOtherAddressOpensNothing() throws {
        let addresses = [
            "alldots://oauth?state=s&code=c",
            "http://alldots.app/?page=password-reset#token=abc",
            "https://www.alldots.app/?page=password-reset#token=abc",
            "https://api.alldots.app/?page=password-reset#token=abc",
            "https://alldots.app.example.com/?page=password-reset#token=abc",
            "https://alldots.app:8443/?page=password-reset#token=abc",
            "https://user@alldots.app/?page=password-reset#token=abc",
            "https://alldots.app/other?page=password-reset#token=abc",
            "https://alldots.app/",
            "https://alldots.app/?page=login#token=abc",
            "https://alldots.app/?page=password-reset&page=password-reset#token=abc",
            "https://alldots.app/?page=password-reset",
            "https://alldots.app/?page=password-reset#",
            "https://alldots.app/?page=password-reset#token=",
            "https://alldots.app/?page=password-reset#other=abc",
            "https://alldots.app/?page=password-reset#token=abc&next=x",
            "https://alldots.app/?page=password-reset#token=a.b",
            "https://alldots.app/?page=password-reset#token=\(String(repeating: "a", count: 257))"
        ]
        for text in addresses {
            XCTAssertNil(PasswordResetLink(url: try XCTUnwrap(URL(string: text), text)), text)
        }
    }

    func testEachOpenedLinkIsItsOwnSheet() throws {
        let url = try XCTUnwrap(URL(string: "https://alldots.app/?page=password-reset#token=abc"))
        let first = try XCTUnwrap(PasswordResetLink(url: url))
        let second = try XCTUnwrap(PasswordResetLink(url: url))
        XCTAssertNotEqual(first.id, second.id)
    }
}
