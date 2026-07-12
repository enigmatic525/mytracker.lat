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
                            Text("Tap a day to mark it")
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
        let completed = store.state.liftHistory[day]?.isEmpty == false
        let label = date.formatted(.dateTime.weekday(.wide).month(.wide).day())

        return Button { store.toggleLift(on: day) } label: {
            RoundedRectangle(cornerRadius: 3)
                .fill(completed ? Color.green.opacity(0.62) : Color.secondary.opacity(0.18))
                .aspectRatio(1, contentMode: .fit)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label), \(completed ? "lift completed" : "no lift")")
        .accessibilityValue(completed ? "Marked" : "Not marked")
        .accessibilityAddTraits(completed ? .isSelected : [])
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
