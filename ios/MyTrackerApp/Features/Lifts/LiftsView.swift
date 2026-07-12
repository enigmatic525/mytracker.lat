import MyTrackerCore
import SwiftUI

struct LiftsView: View {
    @EnvironmentObject private var store: TrackerStore

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: 6),
        count: 10
    )

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Lifts")
                            .font(.title3.weight(.semibold))
                        Text("Last 30 Days")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .padding(.top, 2)

                        LazyVGrid(columns: columns, spacing: 6) {
                            ForEach(attendanceDays, id: \.self) { date in
                                attendanceButton(for: date)
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

    private var attendanceDays: [Date] {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        return (0..<30).reversed().compactMap {
            calendar.date(byAdding: .day, value: -$0, to: today)
        }
    }

    private var completedThisWeek: Int {
        let today = DateKey.string(from: Date())
        guard let week = DateKey.mondayWeek(containing: today) else { return 0 }
        return store.state.liftHistory.keys.filter { day in
            day >= week.start && day <= week.end && store.state.liftHistory[day]?.isEmpty == false
        }.count
    }
}
