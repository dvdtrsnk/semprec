import Foundation

/// The letters on the profile button: the initials of the account's display name as the person's locale abbreviates
/// a name (`David Třešňák` is `DT`); without a name, the initials of the first two words of the address before the
/// `@` (`david.tresnak@x.cz` is `DT`), or its first two letters when it is one word.
enum ProfileInitials {

    static func text(name: String? = nil, email: String?) -> String? {
        if let name, let initials = abbreviated(name) { return initials }
        guard let email else { return nil }
        let words = email.prefix { $0 != "@" }.split { !$0.isLetter && !$0.isNumber }
        if words.count >= 2, let first = words[0].first, let second = words[1].first {
            return String([first, second]).uppercased()
        }
        guard let word = words.first else { return nil }
        return String(word.prefix(2)).uppercased()
    }

    private static func abbreviated(_ name: String) -> String? {
        let formatter = PersonNameComponentsFormatter()
        guard let parts = formatter.personNameComponents(from: name) else { return nil }
        formatter.style = .abbreviated
        let initials = formatter.string(from: parts)
        return initials.isEmpty ? nil : initials
    }
}
