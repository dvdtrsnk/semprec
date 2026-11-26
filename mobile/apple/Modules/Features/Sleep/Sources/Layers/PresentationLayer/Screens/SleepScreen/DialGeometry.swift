import SwiftUI

/// Where the parts of the sleep dial are for one size, and how a point of the dial maps to a minute of the day. Pure
/// drawing and hit-testing arithmetic: which times a night may take is the shared draft's decision.
struct DialGeometry {

    /// The minutes the full circle stands for: one day.
    static let minutesInDay = 1_440.0

    let size: CGFloat
    /// The step of the dial, from the shared draft; the marks inside the snake sit on it.
    let stepMinutes: Int

    // The proportions of the system's own sleep schedule dial, measured on its screenshots.
    var radius: CGFloat { size / 2 }
    var faceRadius: CGFloat { radius * 0.717 }
    var trackWidth: CGFloat { radius - faceRadius }
    var snakeWidth: CGFloat { radius * 0.235 }
    var snakeRadius: CGFloat { radius * 0.874 }

    /// The length of one step along the middle of the snake.
    var stepArc: CGFloat {
        snakeRadius * 2 * .pi * CGFloat(stepMinutes) / CGFloat(Self.minutesInDay)
    }

    /// How many minutes of the dial a round end of the snake covers past its time.
    var knobInsetMinutes: Double {
        Double(snakeWidth * 0.62 / snakeRadius) / (2 * .pi) * Self.minutesInDay
    }

    /// The minute of the day at `point`, 0 at the top, clockwise.
    func minutes(at point: CGPoint) -> Double {
        let angle = atan2(Double(point.x - radius), Double(radius - point.y))
        let turn = angle < 0 ? angle + 2 * .pi : angle
        return turn / (2 * .pi) * Self.minutesInDay
    }

    func isOnTrack(_ point: CGPoint) -> Bool {
        let distance = hypot(point.x - radius, point.y - radius)
        return distance >= faceRadius - trackWidth * 0.25 && distance <= radius + trackWidth * 0.25
    }

    func offset(minutes: Double, radius: CGFloat) -> CGSize {
        let angle = minutes / Self.minutesInDay * 2 * .pi
        return CGSize(width: radius * CGFloat(sin(angle)), height: -radius * CGFloat(cos(angle)))
    }

    /// `minutes` brought into the day, `0..<1440`.
    static func wrapped(_ minutes: Double) -> Double {
        let rest = minutes.truncatingRemainder(dividingBy: minutesInDay)
        return rest < 0 ? rest + minutesInDay : rest
    }

    /// The shorter way round the dial from `start` to `end`, in minutes: positive clockwise.
    static func signedDistance(from start: Double, to end: Double) -> Double {
        let forward = wrapped(end - start)
        return forward > minutesInDay / 2 ? forward - minutesInDay : forward
    }
}
