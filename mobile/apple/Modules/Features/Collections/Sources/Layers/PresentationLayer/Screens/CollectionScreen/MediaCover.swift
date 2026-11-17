import SwiftUI

/// The cover of a book or a film until Semp finds its picture: a 2:3 card in a colour of its own, with the title set
/// in a serif and the author (or the year) under it, as a printed cover is laid out.
struct MediaCover: View {

    // MARK: - Dependencies
    let title: String
    let subtitle: String?
    var width: CGFloat?

    // MARK: - Body
    var body: some View {
        let palette = Self.palette(for: title)
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(LinearGradient(colors: [palette.top, palette.bottom], startPoint: .top, endPoint: .bottom))
            .aspectRatio(2.0 / 3.0, contentMode: .fit)
            .frame(width: width)
            .overlay(alignment: .topLeading) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(.system(size: fontSize, weight: .bold, design: .serif))
                        .lineLimit(4)
                        .minimumScaleFactor(0.7)
                    Spacer(minLength: 4)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle.uppercased())
                            .font(.system(size: fontSize * 0.62))
                            .tracking(0.6)
                            .lineLimit(2)
                            .opacity(0.85)
                    }
                }
                .foregroundStyle(palette.ink)
                .padding(.horizontal, 8)
                .padding(.vertical, 10)
            }
            .shadow(color: .black.opacity(0.18), radius: 7, y: 6)
            .accessibilityHidden(true)
    }
}

// MARK: - Colours
private extension MediaCover {

    struct Palette {
        let top: Color
        let bottom: Color
        let ink: Color
    }

    /// Larger covers in the detail get a larger title than the tiles of the gallery.
    var fontSize: CGFloat {
        guard let width else { return 14 }
        return max(12, width / 7)
    }

    /// The colours of covers, the same for a title every time it is drawn.
    static let palettes: [Palette] = [
        Palette(top: Color(red: 0.23, green: 0.18, blue: 0.15), bottom: Color(red: 0.48, green: 0.36, blue: 0.24),
                ink: Color(red: 0.96, green: 0.91, blue: 0.84)),
        Palette(top: Color(red: 0.06, green: 0.10, blue: 0.17), bottom: Color(red: 0.20, green: 0.27, blue: 0.37),
                ink: .white),
        Palette(top: Color(red: 0.94, green: 0.92, blue: 0.88), bottom: Color(red: 0.79, green: 0.75, blue: 0.68),
                ink: Color(red: 0.11, green: 0.11, blue: 0.12)),
        Palette(top: Color(red: 0.48, green: 0.12, blue: 0.12), bottom: Color(red: 0.79, green: 0.29, blue: 0.23),
                ink: .white),
        Palette(top: Color(red: 0.12, green: 0.23, blue: 0.36), bottom: Color(red: 0.30, green: 0.49, blue: 0.66),
                ink: .white),
        Palette(top: Color(red: 0.16, green: 0.29, blue: 0.21), bottom: Color(red: 0.36, green: 0.55, blue: 0.40),
                ink: Color(red: 0.95, green: 0.97, blue: 0.93))
    ]

    static func palette(for title: String) -> Palette {
        let sum = title.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return palettes[sum % palettes.count]
    }
}

// MARK: - Preview
#Preview {
    HStack(alignment: .top) {
        MediaCover(title: "Duna", subtitle: "Frank Herbert")
        MediaCover(title: "Interstellar", subtitle: "2014")
        MediaCover(title: "Projekt Hail Mary", subtitle: "Andy Weir", width: 120)
    }
    .padding()
}
