/// The keys laid out around a center (days, weeks or months), kept until the center moves. A view's body runs far
/// more often than its center moves, and working the keys out takes hundreds of date calculations.
final class CalendarKeyCache {

    // MARK: - Properties
    private var center: String?
    private var keys: [String] = []

    // MARK: - Methods
    func keys(around center: String, make: (String) -> [String]) -> [String] {
        if center != self.center {
            self.center = center
            keys = make(center)
        }
        return keys
    }
}
