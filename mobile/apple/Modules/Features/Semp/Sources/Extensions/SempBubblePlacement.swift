import CoreGraphics

/// Where the bubble rests: on the left or the right edge, at a height; near the top or the bottom of its band it snaps
/// into the corner.
enum SempBubbleSide: String {

    case left
    case right
}

/// The geometry of the bubble's resting places, in the coordinates of the area it floats over.
struct SempBubblePlacement: Equatable {

    // MARK: - Constants
    static let diameter: CGFloat = 60
    static let margin: CGFloat = 8
    /// How close to the top or the bottom of the band the bubble is pulled into the corner.
    static let magnet: CGFloat = 80
    /// How far ahead of the finger the release velocity throws the bubble.
    static let throwSeconds: CGFloat = 0.22

    // MARK: - Properties
    let size: CGSize

    // MARK: - Methods
    /// The band the top edge of the bubble rests in.
    var yRange: ClosedRange<CGFloat> {
        let top = Self.margin
        return top...max(top, size.height - Self.diameter - Self.margin)
    }

    /// The left edge of the bubble resting on `side`.
    func x(for side: SempBubbleSide) -> CGFloat {
        switch side {
        case .left: Self.margin
        case .right: size.width - Self.diameter - Self.margin
        }
    }

    /// The edge a bubble let go with its center at `centerX` and thrown with `velocityX` points a second ends on.
    func side(centerX: CGFloat, velocityX: CGFloat) -> SempBubbleSide {
        centerX + velocityX * Self.throwSeconds < size.width / 2 ? .left : .right
    }

    /// The resting height for a top edge at `top`: kept in the band, and pulled into the corner when it is near one.
    func rest(top: CGFloat) -> CGFloat {
        let range = yRange
        let clamped = min(max(top, range.lowerBound), range.upperBound)
        if clamped - range.lowerBound < Self.magnet { return range.lowerBound }
        if range.upperBound - clamped < Self.magnet { return range.upperBound }
        return clamped.rounded()
    }
}
