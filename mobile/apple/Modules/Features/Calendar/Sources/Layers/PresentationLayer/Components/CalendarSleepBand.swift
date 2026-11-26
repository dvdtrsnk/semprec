import CoreKit
import DesignSystem
import SwiftUI

/// What the day view does with a night of sleep on the timeline: open it, hold it, move it or stretch one of its ends.
struct CalendarSleepHandlers {

    let open: (_ night: String) -> Void
    /// The night is held: selected, and moved by the finger that holds it until it lifts.
    let hold: (_ night: String) -> Void
    /// The night is moved (no edge) or one end dragged, by minutes from where it is.
    let drag: (_ night: String, _ edge: CalendarEdge?, _ deltaMinutes: Int) -> Void
    let dragEnd: () -> Void
}

/// One part of a night on a day's timeline: the evening from bedtime to midnight, or the morning from midnight to
/// waking. A tap opens the night. Held, it is selected, as an event is, and follows the finger at once; a selected
/// night also moves with a finger that slides on it, and shows a handle at its own end, bedtime on the evening and the
/// wake time on the morning, to stretch or shorten it. The evening says how long the night is and whether it reaches
/// the sleep goal, and the time the plan would have when the night was changed from it.
struct CalendarSleepBand: View {

    // MARK: - Constants
    private static let holdDuration = 0.35

    // MARK: - Dependencies
    let sleep: CalendarSleep
    let evening: Bool
    /// The minutes of this day the band covers.
    let startMinutes: Int
    let endMinutes: Int
    let geometry: CalendarGeometry
    let width: CGFloat
    let selected: Bool
    let labelHidden: Bool
    let handlers: CalendarSleepHandlers

    // MARK: - State
    /// Whether a finger presses the night; one still on it after the hold's time holds it.
    @State private var pressing = false

    // MARK: - Body
    var body: some View {
        let height = max(geometry.y(minutes: endMinutes) - geometry.y(minutes: startMinutes), 0)
        label
            .opacity(labelHidden ? 0 : 1)
            .padding(6)
            .frame(width: width, height: height, alignment: evening ? .topLeading : .bottomLeading)
            .background(tint.opacity(selected ? 0.22 : 0.1), in: RoundedRectangle(cornerRadius: 6))
            .overlay {
                if selected { RoundedRectangle(cornerRadius: 6).strokeBorder(tint, lineWidth: 1.5) }
            }
            .contentShape(Rectangle())
            .onTapGesture { handlers.open(sleep.night) }
            // Held, the night is selected and the day view moves it with the finger that held it. Nothing here claims
            // a touch that scrolls the day or turns it: a drag inside a scroll view would take its touches.
            // A long press of a view in a scroll view is recognized only when the finger lifts, so the press is timed:
            // a finger still on the night after the hold's time holds it.
            .onLongPressGesture(minimumDuration: Self.holdDuration, perform: {}, onPressingChanged: { pressing = $0 })
            .task(id: pressing) {
                guard pressing else { return }
                try? await Task.sleep(for: .seconds(Self.holdDuration))
                if !Task.isCancelled { handlers.hold(sleep.night) }
            }
            .overlay(alignment: evening ? .top : .bottom) { if selected { handle } }
            .animation(.snappy(duration: 0.2), value: selected)
            .offset(x: CalendarGeometry.gutter, y: geometry.y(minutes: startMinutes))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text("calendar.sleep.title", bundle: .module))
            .accessibilityValue(Text(accessibilityValue))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { handlers.open(sleep.night) }
    }
}

// MARK: - Subviews
private extension CalendarSleepBand {

    var tint: Color { Theme.Colors.sleep }

    @ViewBuilder var label: some View {
        if evening {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Image(systemName: "moon.fill").font(.caption2)
                    Text(CalendarDates.clock(minutes: sleep.bedMinutes)).font(.caption2.weight(.semibold))
                    Text(duration).font(.caption2)
                    goalMark
                }
                .foregroundStyle(tint)
                if let plan = planNote {
                    Text(plan).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        } else {
            HStack(spacing: 4) {
                Image(systemName: sleep.alarm ? "alarm" : "sun.max").font(.caption2)
                Text(CalendarDates.clock(minutes: sleep.wakeMinutes)).font(.caption2.weight(.semibold))
            }
            .foregroundStyle(tint)
        }
    }

    /// Whether the night reaches the goal: a check when it does, a warning when it is shorter.
    @ViewBuilder var goalMark: some View {
        if let meets = sleep.meetsGoal {
            Image(systemName: meets ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(meets ? Color.green : Color.orange)
                .accessibilityHidden(true)
        }
    }

    /// "7 h 45 min".
    var duration: String {
        CalendarSleepBand.durationFormatter.string(from: TimeInterval(sleep.durationMinutes * 60)) ?? ""
    }

    /// Made once: a formatter is costly to make, and the band is drawn on every frame of a scroll.
    static let durationFormatter: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .short
        formatter.allowedUnits = [.hour, .minute]
        return formatter
    }()

    /// The plan's own times, for a night changed from them.
    var planNote: String? {
        guard sleep.changed, let bed = sleep.planBedMinutes, let wake = sleep.planWakeMinutes else { return nil }
        let format = String(localized: "calendar.sleep.plan", bundle: .module)
        return String(format: format, CalendarDates.range(from: bed, to: wake))
    }

    var accessibilityValue: String {
        [
            CalendarDates.range(from: sleep.bedMinutes, to: sleep.wakeMinutes),
            duration,
            sleep.meetsGoal.map {
                String(localized: $0 ? "calendar.sleep.goalMet" : "calendar.sleep.goalMissed", bundle: .module)
            },
            planNote
        ].compactMap { $0 }.joined(separator: ", ")
    }

    var handle: some View {
        Circle()
            .fill(Color(white: 1))
            .overlay(Circle().strokeBorder(tint, lineWidth: 2))
            .frame(width: 12, height: 12)
            .padding(10)
            .contentShape(Rectangle())
            .gesture(slide(edge: evening ? .start : .end))
            .frame(maxWidth: .infinity, alignment: evening ? .trailing : .leading)
            .padding(.horizontal, 12)
            .offset(y: evening ? -16 : 16)
            .accessibilityLabel(
                Text(evening ? "calendar.sleep.handle.bed" : "calendar.sleep.handle.wake", bundle: .module)
            )
    }

    func slide(edge: CalendarEdge?) -> some Gesture {
        DragGesture(minimumDistance: 2, coordinateSpace: .calendarDay)
            .onChanged { handlers.drag(sleep.night, edge, minutes($0)) }
            .onEnded { _ in handlers.dragEnd() }
    }

    func minutes(_ drag: DragGesture.Value) -> Int {
        Int((drag.translation.height / geometry.hourHeight * 60).rounded())
    }
}
