import Foundation

/// The two letters on the profile button: the initials of the first two words of the address before the `@`
/// (`david.tresnak@x.cz` is `DT`), or its first two letters when it is one word.
enum ProfileInitials {

    static func text(email: String?) -> String? {
        guard let email else { return nil }
        let words = email.prefix { $0 != "@" }.split { !$0.isLetter && !$0.isNumber }
        if words.count >= 2, let first = words[0].first, let second = words[1].first {
            return String([first, second]).uppercased()
        }
        guard let word = words.first else { return nil }
        return String(word.prefix(2)).uppercased()
    }
}
