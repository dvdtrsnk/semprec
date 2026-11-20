import DesignSystem
import SwiftUI

/// The page behind the diary, as in the design: a soft blue haze at the top left and warm sand at the top right that
/// fade into an off-white page, under a fine grain. In dark appearance the same shape in deep, muted tones. The
/// gradient belongs to the top of the page and scrolls away with it by `scrolled` points; below it the page's plain
/// colour goes on for as long as the page does.
struct JournalBackground: View {

    // MARK: - Dependencies
    let scrolled: CGFloat

    // MARK: - Body
    var body: some View {
        JournalBackgroundPattern(scrolled: scrolled)
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }
}

/// The diary's page in whatever frame it is given, scrolled by `scrolled` points: its plain colour, the gradient one
/// frame tall at its top and the grain over both. The page fills the screen with it.
struct JournalBackgroundPattern: View {

    // MARK: - Dependencies
    let scrolled: CGFloat

    // MARK: - Body
    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .top) {
                Self.page
                gradient
                    .frame(height: proxy.size.height)
                    .offset(y: -max(scrolled, 0))
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
            .clipped()
        }
        .overlay { JournalGrain().allowsHitTesting(false) }
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
/// fixed seed, so the grain does not change between draws.
private struct JournalGrain: View {

    @Environment(\.colorScheme)
    private var colorScheme

    var body: some View {
        Canvas { context, size in
            var random = SeededRandom(seed: 0x5EED)
            let dots = Int(size.width * size.height / Self.areaPerDot)
            let shade: Color = colorScheme == .dark ? .white : .black
            for _ in 0..<dots {
                let point = CGPoint(x: random.next() * size.width, y: random.next() * size.height)
                let opacity = 0.02 + random.next() * 0.05
                context.fill(Path(CGRect(origin: point, size: Self.dotSize)), with: .color(shade.opacity(opacity)))
            }
        }
    }

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

/// The colours of the diary's design beyond the app's own tokens.
enum JournalColors {

    /// The periods that contain the selection on the axis.
    static let gold = Color(light: 0xB08D45, dark: 0xD6B36B)
    /// The cards on the diary's page: near white over the gradient, a raised grey in dark appearance.
    static let card = Color(light: 0xFDFDFC, dark: 0x1C1D20)
}

/// The band at the top of the screen behind the axis row that stays there: the page's own pattern at that place,
/// blurred and fading out below the row, so the page scrolling under it does not show through the row's text.
struct JournalTopBand: View {

    // MARK: - Dependencies
    /// The size of the whole page, which the pattern is laid out in so that the band matches the page behind it.
    let pageSize: CGSize
    /// How far down from the top of the screen the band is solid.
    let solidHeight: CGFloat
    /// How far the page is scrolled, so that the band shows the part of the page behind it.
    let scrolled: CGFloat

    // MARK: - Body
    var body: some View {
        JournalBackgroundPattern(scrolled: scrolled)
            .frame(width: pageSize.width + Self.blur * 4, height: pageSize.height)
            .blur(radius: Self.blur)
            .frame(width: pageSize.width, height: solidHeight + Self.fade, alignment: .top)
            .clipped()
            .mask {
                VStack(spacing: 0) {
                    Color.black.frame(height: solidHeight)
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: Self.fade)
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// How far below the solid part the band fades out.
    static let fade: CGFloat = 28
    private static let blur: CGFloat = 10
}
