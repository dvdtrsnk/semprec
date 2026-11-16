import Foundation
import SwiftUI

/// The words and symbols the mail screens derive from stored values: times, initials, avatar colors, file sizes.
enum MailFormatting {

    // MARK: - Times
    /// The moment an ISO timestamp names, or nil for text that is not one. The server writes microseconds, which the
    /// system parser does not take, so the fraction is dropped: the list shows minutes.
    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let whole = iso.replacing(/\.\d+/, with: "")
        return try? Date(whole, strategy: .iso8601)
    }

    /// The time a row of the list shows: the clock time today, then "yesterday", the weekday within the last week and
    /// the day and month before that.
    static func listTime(
        _ iso: String?,
        now: Date = .now,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        guard let date = date(iso) else { return "" }
        let style = style(locale, calendar)
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(style.hour().minute())
        }
        if isDayBefore(date, now, calendar) {
            return String(localized: "mail.time.yesterday", bundle: .module, locale: locale)
        }
        let start = calendar.startOfDay(for: date)
        let days = calendar.dateComponents([.day], from: start, to: calendar.startOfDay(for: now)).day ?? 0
        if days < 7 {
            return date.formatted(style.weekday(.abbreviated))
        }
        return date.formatted(style.day().month(.defaultDigits))
    }

    /// The date of a message in an open thread: the day and month, with the clock time.
    static func messageTime(
        _ iso: String?,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        guard let date = date(iso) else { return "" }
        return date.formatted(style(locale, calendar).day().month(.defaultDigits).hour().minute())
    }

    /// The day and clock time of an account's last sync.
    static func syncTime(_ iso: String?, calendar: Calendar = .current, locale: Locale = .current) -> String? {
        guard let date = date(iso) else { return nil }
        return date.formatted(style(locale, calendar).weekday(.abbreviated).day().month().hour().minute())
    }

    // MARK: - People
    /// Up to two capital letters: the first letters of the first and last word of the name, or the first letter of the
    /// address when the name is empty.
    static func initials(name: String, address: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace)
        let letters = [words.first, words.count > 1 ? words.last : nil].compactMap { $0?.first }
        if !letters.isEmpty { return String(letters).uppercased() }
        return address.first.map { String($0).uppercased() } ?? "\u{2022}"
    }

    /// A color of the avatar that stays the same for the same sender, from a fixed palette.
    static func avatarColor(_ seed: String) -> Color {
        let palette: [Color] = [.teal, .indigo, .pink, .green, .purple, .orange, .blue, .brown]
        let hash = seed.lowercased().unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
        return palette[Int(hash % UInt32(palette.count))]
    }

    // MARK: - Files
    /// The capital letters after the last dot of the name, or a bullet when there is none.
    static func fileExtension(_ filename: String) -> String {
        guard let dot = filename.lastIndex(of: "."), dot != filename.startIndex else { return "\u{2022}" }
        let ext = filename[filename.index(after: dot)...].prefix(4).uppercased()
        return ext.isEmpty ? "\u{2022}" : ext
    }

    static func fileSize(_ bytes: Int64) -> String {
        bytes.formatted(.byteCount(style: .file))
    }

    // MARK: - Folders
    /// The SF Symbol of a folder by its stored special purpose; a folder without one is a label.
    static func folderSymbol(_ specialPurpose: String) -> String {
        switch specialPurpose {
        case "inbox": "tray"
        case "sent": "paperplane"
        case "drafts": "doc"
        case "archive": "archivebox"
        case "junk": "exclamationmark.triangle"
        case "trash": "trash"
        default: "tag"
        }
    }
}

// MARK: - Private
private extension MailFormatting {

    /// A format style of `calendar`, in its own time zone, so that a time reads the same wherever the app runs.
    static func style(_ locale: Locale, _ calendar: Calendar) -> Date.FormatStyle {
        Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
    }

    /// Whether `date` falls on the day before `now`.
    static func isDayBefore(_ date: Date, _ now: Date, _ calendar: Calendar) -> Bool {
        guard let yesterday = calendar.date(byAdding: .day, value: -1, to: now) else { return false }
        return calendar.isDate(date, inSameDayAs: yesterday)
    }
}
