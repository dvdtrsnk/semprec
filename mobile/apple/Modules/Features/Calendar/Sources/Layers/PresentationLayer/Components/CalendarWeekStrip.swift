import SwiftUI

/// The weeks as pages, Monday first, on the week of the selected day. A swipe moves the weeks with the finger and
/// settles on a whole week: past half the strip, or on a short fast flick, it settles on the next one, and never
/// further than that, however fast the flick. A tap shows that day. The selected day's circle fades from the old day
/// to the new one.
struct CalendarWeekStrip: View {

    // MARK: - Dependencies
    let selectedDay: String
    let today: String
    let onPick: (String) -> Void
    let onPage: (Int) -> Void

    // MARK: - State
    /// The Monday the pages are laid out around; moved when the strip nears either end.
    @State private var anchor: String?
    /// The Monday of the page the strip shows or settles on.
    @State private var visibleWeek: String?
    /// The Monday a settled swipe asked for, until the selected day arrives in that week.
    @State private var requestedWeek: String?
    @State private var phase = ScrollPhase.idle

    // MARK: - Body
    var body: some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(weeks, id: \.self) { monday in
                    week(monday)
                        .containerRelativeFrame(.horizontal)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(OneWeekPaging())
        .scrollIndicators(.hidden)
        .fixedSize(horizontal: false, vertical: true)
        .scrollPosition(id: $visibleWeek)
        .onScrollPhaseChange { _, newPhase in
            phase = newPhase
            if newPhase == .idle { settle() }
        }
        // The page can be reported after the scroll came to rest, so a late report settles too.
        .onChange(of: visibleWeek) {
            if phase == .idle { settle() }
        }
        .onAppear {
            anchor = selectedMonday
            visibleWeek = selectedMonday
        }
        .onChange(of: selectedDay) {
            requestedWeek = nil
            guard visibleWeek != selectedMonday else { return }
            recenterIfNeeded(on: selectedMonday)
            withAnimation(.easeInOut(duration: Self.duration)) { visibleWeek = selectedMonday }
        }
    }
}

// MARK: - Subviews
private extension CalendarWeekStrip {

    func week(_ monday: String) -> some View {
        HStack(spacing: 0) {
            ForEach((0..<7).map { CalendarDates.shifted(monday, by: $0) }, id: \.self) { day in
                VStack(spacing: 4) {
                    Text(CalendarDates.weekdayShort(CalendarDates.isoWeekday(day)))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Button { onPick(day) } label: {
                        Text("\(CalendarDates.dayNumber(day))")
                            .font(.callout.weight(day == selectedDay || day == today ? .semibold : .regular))
                            .foregroundStyle(numberStyle(day))
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(circleColor(day)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(CalendarDates.dayTitle(day))
                    .accessibilityIdentifier(CalendarIdentifiers.day(day))
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 8)
        .animation(.easeInOut(duration: Self.duration), value: selectedDay)
    }
}

// MARK: - Private
private extension CalendarWeekStrip {

    static let duration = 0.25
    /// Pages on each side of the anchor; the strip recenters before a swipe can reach the last one.
    static let weeksAround = 104

    var selectedMonday: String { CalendarDates.monday(of: selectedDay) }

    var weeks: [String] {
        let center = anchor ?? selectedMonday
        return (-Self.weeksAround...Self.weeksAround).map { CalendarDates.shifted(center, by: $0 * 7) }
    }

    /// Shows the week the strip settled on: the same weekday in that week.
    func settle() {
        let current = requestedWeek ?? selectedMonday
        guard let visibleWeek, visibleWeek != current else { return }
        requestedWeek = visibleWeek
        recenterIfNeeded(on: visibleWeek)
        onPage(CalendarDates.days(from: current, to: visibleWeek))
    }

    func recenterIfNeeded(on monday: String) {
        let center = anchor ?? selectedMonday
        let offset = CalendarDates.days(from: center, to: monday) / 7
        if abs(offset) > Self.weeksAround - 8 { anchor = monday }
    }

    func numberStyle(_ day: String) -> AnyShapeStyle {
        if day == selectedDay { return AnyShapeStyle(.background) }
        if day == today { return AnyShapeStyle(Color.red) }
        return CalendarDates.isoWeekday(day) >= 6 ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary)
    }

    func circleColor(_ day: String) -> Color {
        guard day == selectedDay else { return .clear }
        return day == today ? .red : .primary
    }
}

/// Paging that settles at most one page away from where the swipe started: the page the swipe would come to rest
/// on, rounded, and clamped to the neighbouring pages. A scroll the strip makes itself has no velocity and may
/// travel further.
private struct OneWeekPaging: ScrollTargetBehavior {

    func updateTarget(_ target: inout ScrollTarget, context: TargetContext) {
        let width = context.containerSize.width
        guard width > 0 else { return }
        let start = (context.originalTarget.rect.minX / width).rounded()
        let proposed = target.rect.minX / width
        let isProgrammatic = context.velocity == .zero && abs(proposed - start) > 1.5
        let page = isProgrammatic ? proposed.rounded() : start + min(max((proposed - start).rounded(), -1), 1)
        target.rect.origin.x = page * width
    }
}
