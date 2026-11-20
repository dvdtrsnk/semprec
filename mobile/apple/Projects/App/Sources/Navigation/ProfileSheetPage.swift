import CoreKit

/// A page on the profile sheet's own stack: a page a row of the profile leads to, or one internet account, which the
/// internet accounts page opens.
enum ProfileSheetPage: Hashable {

    case page(AccountPage)
    /// `accountId` is the id of the account's Mailboxes item.
    case internetAccount(accountId: String)
}
