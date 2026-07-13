import MyTrackerCore
import SwiftUI

struct LiftsView: View {
    @EnvironmentObject private var store: TrackerStore

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: 6),
        count: 7
    )

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Lifts")
                            .font(.title3.weight(.semibold))
                        Text(monthLabel)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .padding(.top, 2)

                        LazyVGrid(columns: columns, spacing: 6) {
                            ForEach(Array(weekdaySymbols.enumerated()), id: \.offset) { _, symbol in
                                Text(symbol)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity)
                            }

                            ForEach(monthCells.indices, id: \.self) { index in
                                if let date = monthCells[index] {
                                    attendanceButton(for: date)
                                } else {
                                    Color.clear
                                        .aspectRatio(1, contentMode: .fit)
                                        .accessibilityHidden(true)
                                }
                            }
                        }
                        .padding(.vertical, 16)

                        Divider()

                        HStack(alignment: .firstTextBaseline) {
                            HStack(alignment: .firstTextBaseline, spacing: 4) {
                                Text("\(completedThisWeek)/7")
                                    .font(.title3.weight(.medium))
                                    .monospacedDigit()
                                Text("this week")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("Tap to cycle colors")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 12)
                    }
                    .padding(16)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                }
                .padding()
                .padding(.bottom, 24)
            }
            .navigationTitle("Lifts")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func attendanceButton(for date: Date) -> some View {
        let day = DateKey.string(from: date)
        let group = store.state.liftHistory[day]?.first?.group
        let completed = group != nil
        let isToday = Calendar.current.isDateInToday(date)
        let label = date.formatted(.dateTime.weekday(.wide).month(.wide).day())

        return Button { store.cycleLift(on: day) } label: {
            ZStack {
                if isToday {
                    RoundedRectangle(cornerRadius: 3)
                        .stroke(
                            Color.secondary,
                            style: StrokeStyle(lineWidth: 1, dash: [3, 2])
                        )
                }
                RoundedRectangle(cornerRadius: 3)
                    .fill(attendanceColor(for: group))
                    .padding(isToday ? 3 : 0)
                Text("\(Calendar.current.component(.day, from: date))")
                    .font(.caption2)
                    .foregroundStyle(.primary)
                    .monospacedDigit()
            }
            .aspectRatio(1, contentMode: .fit)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label)\(isToday ? ", today" : "")")
        .accessibilityValue(group?.displayName ?? "No lift")
        .accessibilityAddTraits(completed ? .isSelected : [])
    }

    private func attendanceColor(for group: LiftMuscleGroup?) -> Color {
        switch group {
        case .chest: .red.opacity(0.58)
        case .back: .blue.opacity(0.62)
        case .leg: .green.opacity(0.62)
        case nil: .secondary.opacity(0.18)
        }
    }

    private var weekdaySymbols: [String] {
        Calendar.current.veryShortStandaloneWeekdaySymbols
    }

    private var monthLabel: String {
        Date().formatted(.dateTime.month(.wide).year())
    }

    private var monthCells: [Date?] {
        let calendar = Calendar.current
        let today = Date()
        let components = calendar.dateComponents([.year, .month], from: today)
        guard let firstDay = calendar.date(from: components),
              let days = calendar.range(of: .day, in: .month, for: firstDay) else { return [] }
        let leadingBlanks = calendar.component(.weekday, from: firstDay) - 1
        let dates = days.compactMap { day -> Date? in
            calendar.date(byAdding: .day, value: day - 1, to: firstDay)
        }
        return Array(repeating: nil, count: leadingBlanks) + dates.map(Optional.some)
    }

    private var completedThisWeek: Int {
        let today = DateKey.string(from: Date())
        guard let week = DateKey.mondayWeek(containing: today) else { return 0 }
        return store.state.liftHistory.keys.filter { day in
            day >= week.start && day <= week.end && store.state.liftHistory[day]?.isEmpty == false
        }.count
    }
}
