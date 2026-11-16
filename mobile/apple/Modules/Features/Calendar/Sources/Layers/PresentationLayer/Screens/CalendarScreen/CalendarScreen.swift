import CoreKit
import DesignSystem
import SwiftUI

/// The calendar: a year of months, a month of days or one day hour by hour.
struct CalendarScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: CalendarViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> CalendarViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        Text(viewModel.state.selectedDay)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CalendarIdentifiers.screen)
            .task { await viewModel.observe() }
    }
}
