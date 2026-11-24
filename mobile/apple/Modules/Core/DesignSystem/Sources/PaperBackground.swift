import SwiftUI

/// How far a page is scrolled for the paper behind it, up to a screen's height, beyond which the paper no longer
/// changes. Only the paper reads it, so a scroll redraws the paper alone.
@MainActor
@Observable
public final class PaperScroll {

    public var offset: CGFloat = 0

    public init() {}

    /// Moves the haze with a scroll from `old` to `new`, within `limit`: down to its place at the top and up until it
    /// is gone. A change larger than `limit` is not a scroll but a jump (a scroll laid out anew around another place),
    /// which the haze does not follow.
    public func follow(from old: CGFloat, to new: CGFloat, limit: CGFloat) {
        let change = new - old
        guard abs(change) < limit else { return }
        let moved = min(max(offset + change, 0), limit)
        if moved != offset { offset = moved }
    }
}

// MARK: - Following a scroll
extension View {

    /// Moves `scroll` with this scroll view from the top of its content: the haze is at its place while the page is
    /// at its top and gone a screen's height below it.
    public func paperScroll(_ scroll: PaperScroll) -> some View {
        onScrollGeometryChange(
            for: CGFloat.self,
            of: { min(max($0.contentOffset.y + $0.contentInsets.top, 0), $0.containerSize.height) },
            action: { _, offset in scroll.offset = offset }
        )
    }

    /// Moves `scroll` with this scroll view's offset while it moves (by a finger, as it coasts or in an animation), for
    /// a scroll without a top of its own (one that goes on both ways): the haze goes up as the content does and comes
    /// back down to its place. A scroll placed at rest (laid out anew, or brought to where it opens) leaves the haze
    /// where it is. With `nil` the scroll moves no paper, and the view stays the same view whichever it is given.
    public func paperScrollFollowing(_ scroll: PaperScroll?) -> some View {
        modifier(PaperScrollFollowing(scroll: scroll))
    }
}

/// Follows a scroll's moves into a paper's haze while the scroll moves.
private struct PaperScrollFollowing: ViewModifier {

    let scroll: PaperScroll?
    @State private var isMoving = false

    func body(content: Content) -> some View {
        content
            .onScrollPhaseChange { _, phase in isMoving = phase != .idle }
            .onScrollGeometryChange(
                for: PaperScrollPlace.self,
                of: { PaperScrollPlace(offset: $0.contentOffset.y, height: $0.containerSize.height) },
                action: { old, new in
                    guard isMoving else { return }
                    scroll?.follow(from: old.offset, to: new.offset, limit: new.height)
                }
            )
    }
}

/// Where a scroll is and how tall it is.
private struct PaperScrollPlace: Equatable {

    let offset: CGFloat
    let height: CGFloat
}

/// The paper behind a page, as in the diary's design: a soft blue haze at the top left and warm sand at the top right
/// that fade into an off-white page, under a fine grain. In dark appearance the same shape in deep, muted tones. The
/// haze belongs to the top of the page and scrolls away with it by `scroll`; below it the paper's plain colour goes on
/// for as long as the page does.
public struct PaperBackground: View {

    // MARK: - Dependencies
    let scroll: PaperScroll

    // MARK: - Init
    public init(scroll: PaperScroll) {
        self.scroll = scroll
    }

    // MARK: - Body
    public var body: some View {
        PaperPattern(scrolled: scroll.offset)
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }
}

/// The paper in whatever frame it is given, scrolled by `scrolled` points: its plain colour, the haze `pageHeight` tall
/// (the frame's height when `nil`) at its top and the grain over both. A page fills the screen with it; a part of the
/// screen that shows the paper behind it gives the screen's height, so the haze there matches the page's.
public struct PaperPattern: View {

    // MARK: - Dependencies
    let scrolled: CGFloat
    let pageHeight: CGFloat?

    // MARK: - Init
    public init(scrolled: CGFloat, pageHeight: CGFloat? = nil) {
        self.scrolled = scrolled
        self.pageHeight = pageHeight
    }

    // MARK: - Body
    public var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .top) {
                Self.page
                gradient
                    .frame(height: pageHeight ?? proxy.size.height)
                    .offset(y: -max(scrolled, 0))
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
            .clipped()
        }
        .overlay { PaperGrain().allowsHitTesting(false) }
    }

    /// The colour of the page below the gradient, the same as the gradient's bottom row.
    private static let page = Color(light: 0xF9F8F5, dark: 0x0C0D0F)

    private var gradient: some View {
        MeshGradient(
            width: 3,
            height: 4,
            points: [
                [0, 0], [0.5, 0], [1, 0],
                [0, 0.2], [0.55, 0.2], [1, 0.2],
                [0, 0.48], [0.5, 0.48], [1, 0.48],
                [0, 1], [0.5, 1], [1, 1]
            ],
            colors: Self.colors
        )
    }

    /// The top row of the haze, from left to right: the colours the page starts with.
    public static var topColors: [Color] { Array(colors.prefix(3)) }

    /// Three columns, from the top row to the bottom one.
    private static let colors: [Color] = [
        Color(light: 0xC8D7E8, dark: 0x18222F),
        Color(light: 0xDFE0DB, dark: 0x1D2026),
        Color(light: 0xEDE6D8, dark: 0x27231D),
        Color(light: 0xCAD9E8, dark: 0x16202C),
        Color(light: 0xDCDEDC, dark: 0x1A1D22),
        Color(light: 0xDCD5C6, dark: 0x221F1A),
        Color(light: 0xE9EDF1, dark: 0x111316),
        Color(light: 0xEEEFEE, dark: 0x111214),
        Color(light: 0xF1EFEA, dark: 0x131210),
        Color(light: 0xF8F7F4, dark: 0x0C0D0F),
        Color(light: 0xF9F8F5, dark: 0x0C0D0F),
        Color(light: 0xFAF9F6, dark: 0x0C0D0F)
    ]
}

/// A fine, even grain of tiny dots that gives the gradient the paper-like texture of the design. The dots come from a
/// fixed seed and are drawn once into a small tile that repeats over the page, so a view that shows the grain anew
/// (the band behind the pinned row, for one) costs no drawing.
private struct PaperGrain: View {

    @Environment(\.colorScheme)
    private var colorScheme

    var body: some View {
        if let tile = colorScheme == .dark ? Self.darkTile : Self.lightTile {
            Image(decorative: tile, scale: Self.scale)
                .resizable(resizingMode: .tile)
        }
    }

    private static let lightTile = tile(white: 0)
    private static let darkTile = tile(white: 1)

    /// One tile of the grain, `side` points square at `scale` pixels a point, one dot for every `areaPerDot` points.
    private static func tile(white: CGFloat) -> CGImage? {
        let pixels = Int(side * scale)
        let context = CGContext(
            data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
        guard let context else { return nil }
        context.scaleBy(x: scale, y: scale)
        var random = SeededRandom(seed: 0x5EED)
        for _ in 0..<Int(side * side / areaPerDot) {
            let point = CGPoint(x: random.next() * side, y: random.next() * side)
            let opacity = 0.02 + random.next() * 0.05
            context.setFillColor(CGColor(gray: white, alpha: opacity))
            context.fill(CGRect(origin: point, size: dotSize))
        }
        return context.makeImage()
    }

    /// The side of a tile, in points, and its pixels a point.
    private static let side: CGFloat = 128
    private static let scale: CGFloat = 3
    /// One dot for this many square points.
    private static let areaPerDot: CGFloat = 9
    private static let dotSize = CGSize(width: 0.7, height: 0.7)
}

/// A small linear congruential generator, so the grain is the same on every draw.
private struct SeededRandom {

    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    /// The next value in `0..<1`.
    mutating func next() -> CGFloat {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return CGFloat(state >> 11) / CGFloat(UInt64(1) << 53)
    }
}
