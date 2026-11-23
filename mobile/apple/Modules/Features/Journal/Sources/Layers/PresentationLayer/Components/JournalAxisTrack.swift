import CoreKit
import Foundation

// MARK: - Track
/// The tracks of the rows, kept until a row's window moves: a scroll redraws the axis on every frame, and the track
/// of a row of days has some two thousand cells.
@MainActor
final class JournalAxisTracks {

    private var cache: [JournalPeriodKind: (key: JournalAxisTrackKey, track: JournalAxisTrack)] = [:]

    func track(for row: JournalAxisRow) -> JournalAxisTrack {
        let key = JournalAxisTrackKey(row: row)
        if let cached = cache[row.kind], cached.key == key { return cached.track }
        let track = JournalAxisTrack(row: row)
        cache[row.kind] = (key, track)
        return track
    }
}

/// What a row's track depends on: its cells are consecutive periods, so the first, the last and their count name them.
struct JournalAxisTrackKey: Equatable {

    let first: String?
    let last: String?
    let count: Int

    init(row: JournalAxisRow) {
        first = row.cells.first?.start
        last = row.cells.last?.start
        count = row.cells.count
    }
}

/// The cells of one row on the time line: where each period starts and ends, in days since 1970.
@MainActor
struct JournalAxisTrack {

    let starts: [Double]
    let ends: [Double]

    init(row: JournalAxisRow) {
        let starts = row.cells.map { Double(Self.epochDay(year: $0.year, month: $0.month, day: $0.day)) }
        self.starts = starts
        ends = starts.indices.map { index in
            index + 1 < starts.count ? starts[index + 1] : starts[index] + row.kind.typicalSpan
        }
    }

    var bounds: ClosedRange<Double>? {
        guard let first = starts.first, let last = ends.last, first < last else { return nil }
        return first...last
    }

    /// The middle of the cell at `index`.
    func middle(of index: Int) -> Double {
        (starts[index] + ends[index]) / 2
    }

    /// The moment at `position` in cells, the inverse of `position(of:)`.
    func moment(at position: Double) -> Double {
        guard !starts.isEmpty else { return 0 }
        let index = min(max(Int(position.rounded(.down)), 0), starts.count - 1)
        return starts[index] + (position - Double(index)) * (ends[index] - starts[index])
    }

    /// The position of `cursor` in cells: 3.5 is the middle of the fourth cell.
    func position(of cursor: Double) -> Double {
        guard !starts.isEmpty else { return 0 }
        var low = 0
        var high = starts.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if starts[mid] <= cursor { low = mid } else { high = mid - 1 }
        }
        let length = max(ends[low] - starts[low], 1)
        return Double(low) + (cursor - starts[low]) / length
    }

    static func epochDay(_ key: String) -> Double? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Double(epochDay(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// Days since 1970-01-01 of a date of the proleptic Gregorian calendar, by arithmetic alone: the cells of a row
    /// are counted on every change of its window, and a date formatter for each would stall the scroll.
    static func epochDay(year: Int, month: Int, day: Int) -> Int {
        let shifted = month <= 2 ? year - 1 : year
        let era = (shifted >= 0 ? shifted : shifted - 399) / 400
        let yearOfEra = shifted - era * 400
        let dayOfYear = (153 * ((month + 9) % 12) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    /// The day `YYYY-MM-DD` that `epochDay` falls in.
    static func key(_ epochDay: Double) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let date = Date(timeIntervalSince1970: epochDay.rounded(.down) * secondsPerDay)
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    private static let secondsPerDay: Double = 86_400
}
