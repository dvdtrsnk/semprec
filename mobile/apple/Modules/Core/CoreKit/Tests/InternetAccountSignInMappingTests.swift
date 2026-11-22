import SharedSDK
import XCTest

@testable import CoreKit

/// Checks the branches of the internet account bridges' mappings that sign an account in again and name why a
/// connect was refused, with Kotlin values built here.
final class InternetAccountSignInMappingTests: XCTestCase {

    func testEveryConnectFailureAndThePasswordSignInMap() {
        let failures: [(SharedSDK.InternetConnectFailure, CoreKit.InternetConnectFailure)] = [
            (.invalidInput, .invalidInput), (.refused, .refused),
            (.unavailable, .unavailable), (.unexpected, .unexpected), (.declined, .declined),
            (.wrongCredentials, .wrongCredentials), (.appPasswordRequired, .appPasswordRequired),
            (.serverUnreachable, .serverUnreachable), (.tlsFailed, .tlsFailed), (.caldavRefused, .caldavRefused),
            (.caldavUnreachable, .caldavUnreachable), (.alreadyConnected, .alreadyConnected),
            (.rateLimited, .rateLimited), (.wrongAccount, .wrongAccount)
        ]
        for (kotlin, swift) in failures {
            XCTAssertEqual(CoreKit.InternetConnectFailure(kotlin), swift)
        }
        let open = SharedSDK.InternetPasswordSignIn(
            accountId: "m2", address: nil, icloud: false, submitting: false, failure: nil
        )
        XCTAssertEqual(
            CoreKit.InternetPasswordSignIn(open),
            CoreKit.InternetPasswordSignIn(accountId: "m2", address: nil, icloud: false)
        )
    }

    @MainActor
    func testAccountsMapTheSignInAgainActions() throws {
        let existing = SharedInternetAccountsScreenModel.action(.openExisting)
        XCTAssertTrue(existing is SharedSDK.InternetAccountsActionOpenExisting)
        let dismiss = SharedInternetAccountsScreenModel.action(.dismissSignInFailure)
        XCTAssertTrue(dismiss is SharedSDK.InternetAccountsActionDismissSignInFailure)
        let again = try XCTUnwrap(
            SharedInternetAccountsScreenModel.action(.signInAgain(accountId: "m1"))
                as? SharedSDK.InternetAccountsActionSignInAgain
        )
        XCTAssertEqual(again.accountId, "m1")
        let submit = try XCTUnwrap(
            SharedInternetAccountsScreenModel.action(.passwordSignIn(.submit(password: "pw", username: "me")))
                as? SharedSDK.InternetAccountsActionPasswordSignIn
        )
        let step = try XCTUnwrap(submit.step as? SharedSDK.InternetPasswordSignInStepSubmit)
        XCTAssertEqual([step.password, step.username], ["pw", "me"])
        let cancel = try XCTUnwrap(
            SharedInternetAccountsScreenModel.action(.passwordSignIn(.cancel))
                as? SharedSDK.InternetAccountsActionPasswordSignIn
        )
        XCTAssertTrue(cancel.step is SharedSDK.InternetPasswordSignInStepCancel)
    }

    @MainActor
    func testAccountMapsThePasswordSignInActions() throws {
        let submit = try XCTUnwrap(
            SharedInternetAccountScreenModel.action(.passwordSignIn(.submit(password: "pw", username: "")))
                as? SharedSDK.InternetAccountActionPasswordSignIn
        )
        let step = try XCTUnwrap(submit.step as? SharedSDK.InternetPasswordSignInStepSubmit)
        XCTAssertEqual([step.password, step.username], ["pw", ""])
        let cancel = try XCTUnwrap(
            SharedInternetAccountScreenModel.action(.passwordSignIn(.cancel))
                as? SharedSDK.InternetAccountActionPasswordSignIn
        )
        XCTAssertTrue(cancel.step is SharedSDK.InternetPasswordSignInStepCancel)
    }
}
