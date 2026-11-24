import CoreKit

/// A page on the profile sheet's own stack: a page a row of the profile leads to, one internet account, which the
/// internet accounts page opens, or a page of the debug menu, which the app opens from the profile's toolbar.
enum ProfileSheetPage: Hashable {

    case page(AccountPage)
    /// `accountId` is the id of the account's Mailboxes item.
    case internetAccount(accountId: String)
    /// The debug menu.
    case debug
    /// The debug tool of system alarms.
    case debugAlarms
}
