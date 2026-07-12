import MyTrackerCore
import SwiftUI

struct LiftsView: View {
    @EnvironmentObject private var store: TrackerStore
    @State private var group: LiftMuscleGroup = .chest
    @State private var exercise = ""
    @State private var sets = 3
    @State private var reps = 8
    @State private var weightText = "0"

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    weekNavigator
                    legend
                    liftComposer
                    weeklySummary
                    liftList
                }
                .padding()
                .padding(.bottom, 24)
            }
            .navigationTitle("Weekly Lifts")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var weekNavigator: some View {
        HStack {
            Button { store.moveDay(by: -7) } label: {
                Image(systemName: "chevron.left").frame(width: 44, height: 44)
            }
            Spacer()
            VStack(spacing: 3) {
                Text("Week")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(weekRangeLabel)
                    .font(.headline)
            }
            Spacer()
            Button { store.moveDay(by: 7) } label: {
                Image(systemName: "chevron.right").frame(width: 44, height: 44)
            }
            .disabled(!canMoveToNextWeek)
        }
    }

    private var legend: some View {
        HStack(spacing: 8) {
            ForEach(LiftMuscleGroup.allCases, id: \.self) { group in
                Text(group.displayName)
                    .font(.caption.weight(.medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(group.faintColor, in: Capsule())
            }
        }
        .accessibilityLabel("Chest is red, back is blue, and leg is green")
    }

    private var liftComposer: some View {
        VStack(spacing: 14) {
            HStack(spacing: 8) {
                ForEach(LiftMuscleGroup.allCases, id: \.self) { option in
                    Button {
                        group = option
                    } label: {
                        Text(option.displayName)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(option == group ? option.faintColor : Color.clear, in: Capsule())
                            .overlay(Capsule().stroke(option == group ? option.color : Color.secondary.opacity(0.25)))
                    }
                    .buttonStyle(.plain)
                }
            }

            TextField("Exercise, e.g. Bench press", text: $exercise)
                .textInputAutocapitalization(.words)
                .textFieldStyle(.roundedBorder)

            HStack(spacing: 12) {
                Stepper("Sets \(sets)", value: $sets, in: 1...20)
                Stepper("Reps \(reps)", value: $reps, in: 1...100)
            }
            .font(.subheadline)

            HStack {
                TextField("Weight", text: $weightText)
                    .keyboardType(.decimalPad)
                    .textFieldStyle(.roundedBorder)
                Text(store.state.unit.weightSymbol)
                    .foregroundStyle(.secondary)
            }

            Button(action: addLift) {
                Label("Add lift for \(store.selectedDate.formatted(date: .abbreviated, time: .omitted))", systemImage: "plus")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(group.color)
            .disabled(exercise.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || parsedWeight == nil)
        }
        .padding()
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
    }

    private var weeklySummary: some View {
        let lifts = store.selectedWeekLifts
        let totalSets = lifts.reduce(0) { $0 + $1.lift.sets }
        return HStack {
            summaryMetric("Lifts", value: lifts.count)
            Spacer()
            summaryMetric("Sets", value: totalSets)
            Spacer()
            summaryMetric("Chest", value: count(.chest), color: .red)
            Spacer()
            summaryMetric("Back", value: count(.back), color: .blue)
            Spacer()
            summaryMetric("Leg", value: count(.leg), color: .green)
        }
        .padding()
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
    }

    @ViewBuilder
    private var liftList: some View {
        if store.selectedWeekLifts.isEmpty {
            ContentUnavailableView(
                "No lifts this week",
                systemImage: "dumbbell",
                description: Text("Log a chest, back, or leg exercise above.")
            )
            .frame(minHeight: 220)
        } else {
            LazyVStack(spacing: 10) {
                ForEach(store.selectedWeekLifts) { datedLift in
                    liftCard(datedLift)
                }
            }
        }
    }

    private func liftCard(_ datedLift: DatedLift) -> some View {
        HStack(spacing: 12) {
            Text(datedLift.lift.group.displayName)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
                .frame(width: 42)

            VStack(alignment: .leading, spacing: 4) {
                Text(datedLift.lift.exercise)
                    .font(.headline)
                Text(liftDetail(datedLift))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(role: .destructive) { store.removeLift(datedLift) } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.plain)
        }
        .padding()
        .background(datedLift.lift.group.faintColor, in: RoundedRectangle(cornerRadius: 16))
    }

    private func summaryMetric(_ title: String, value: Int, color: Color = .primary) -> some View {
        VStack(spacing: 3) {
            Text("\(value)").font(.headline).monospacedDigit().foregroundStyle(color)
            Text(title).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var parsedWeight: Double? {
        guard let value = Double(weightText), value.isFinite, value >= 0, value <= 5_000 else { return nil }
        return value
    }

    private func addLift() {
        guard let weight = parsedWeight else { return }
        store.addLift(group: group, exercise: exercise, sets: sets, reps: reps, weight: weight)
        exercise = ""
    }

    private func count(_ group: LiftMuscleGroup) -> Int {
        store.selectedWeekLifts.filter { $0.lift.group == group }.count
    }

    private var weekRangeLabel: String {
        guard let week = DateKey.mondayWeek(containing: store.selectedDay),
              let start = DateKey.date(from: week.start),
              let end = DateKey.date(from: week.end) else { return "" }
        return "\(start.formatted(.dateTime.month(.abbreviated).day())) – \(end.formatted(.dateTime.month(.abbreviated).day()))"
    }

    private var canMoveToNextWeek: Bool {
        guard let week = DateKey.mondayWeek(containing: store.selectedDay) else { return false }
        return week.end < DateKey.string(from: Date())
    }

    private func liftDetail(_ datedLift: DatedLift) -> String {
        let date = DateKey.date(from: datedLift.day)?.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()) ?? datedLift.day
        let weight = datedLift.lift.weight.formatted(.number.precision(.fractionLength(0...1)))
        return "\(date) · \(datedLift.lift.sets) × \(datedLift.lift.reps) @ \(weight) \(store.state.unit.weightSymbol)"
    }
}

private extension LiftMuscleGroup {
    var color: Color {
        switch self {
        case .chest: .red
        case .back: .blue
        case .leg: .green
        }
    }

    var faintColor: Color { color.opacity(0.14) }
}
