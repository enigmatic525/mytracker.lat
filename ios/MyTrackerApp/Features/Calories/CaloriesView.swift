import Charts
import MyTrackerCore
import SwiftUI

struct CaloriesView: View {
    @EnvironmentObject private var store: TrackerStore
    @State private var aiText = ""
    @State private var manualAmount = 0.0
    @State private var isEstimating = false
    @State private var statusMessage: String?
    @State private var statusIsError = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    DayNavigator()
                    balanceChart
                    summaryCard
                    aiEntryBar
                    manualEntryCard
                    entryLog
                }
                .padding()
                .padding(.bottom, 24)
            }
            .navigationTitle("Calories")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var balanceChart: some View {
        Chart(balancePoints) { point in
            BarMark(
                x: .value("Day", point.date, unit: .day),
                y: .value("Balance", point.balance)
            )
            .foregroundStyle(point.balance <= 0 ? Color.green.gradient : Color.orange.gradient)
        }
        .chartYAxis { AxisMarks(position: .leading) }
        .frame(height: 150)
        .padding()
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
        .accessibilityLabel("Seven day calorie balance chart")
    }

    private var summaryCard: some View {
        let summary = store.selectedSummary
        return VStack(spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(summary.remaining >= 0 ? "Remaining" : "Over target")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("\(abs(summary.remaining))")
                        .font(.system(size: 34, weight: .semibold, design: .rounded))
                }
                Spacer()
                ProgressView(value: summary.progress)
                    .progressViewStyle(.circular)
                    .tint(summary.remaining >= 0 ? .blue : .orange)
            }

            ProgressView(value: summary.progress)
                .tint(summary.remaining >= 0 ? .blue : .orange)

            HStack {
                metric("Calories in", value: summary.intake, color: .green)
                Spacer()
                metric("Calories out", value: summary.expenditure, color: .orange)
                Spacer()
                metric("Target", value: summary.targetIntake, color: .blue)
            }
        }
        .padding()
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
    }

    private var aiEntryBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("Describe food or exercise", text: $aiText)
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.send)
                    .onSubmit { submitAIEntry() }
                    .disabled(isEstimating)

                Button(action: submitAIEntry) {
                    if isEstimating {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                }
                .disabled(aiText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isEstimating)
                .accessibilityLabel("Estimate and add entry")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.quaternary, in: Capsule())

            if let statusMessage {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(statusIsError ? Color.orange : Color.secondary)
                    .padding(.horizontal, 8)
            }
        }
    }

    private var manualEntryCard: some View {
        VStack(spacing: 12) {
            HStack {
                Text("Manual entry")
                    .font(.headline)
                Spacer()
                Text("\(Int(manualAmount)) cal")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            Slider(value: $manualAmount, in: 0...5_000, step: 50)
            HStack {
                Button("Add food") { addManual(.intake) }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                Spacer()
                Button("Add exercise") { addManual(.activity) }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
            }
            .disabled(manualAmount <= 0)
        }
        .padding()
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
    }

    private var entryLog: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Entries")
                .font(.headline)
            if store.selectedEntries.isEmpty {
                ContentUnavailableView("No entries", systemImage: "list.bullet", description: Text("Add food or activity above."))
                    .frame(minHeight: 130)
            } else {
                ForEach(store.selectedEntries.reversed()) { entry in
                    HStack {
                        Image(systemName: entry.kind == .intake ? "fork.knife" : "figure.run")
                            .foregroundStyle(entry.kind == .intake ? .green : .orange)
                            .frame(width: 28)
                        VStack(alignment: .leading) {
                            Text(entry.label ?? (entry.kind == .intake ? "Food" : "Activity"))
                            Text(entry.kind == .intake ? "Calories in" : "Calories burned")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(entry.calories)")
                            .monospacedDigit()
                        Button(role: .destructive) { store.removeEntry(entry) } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.vertical, 6)
                    Divider()
                }
            }
        }
        .padding()
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
    }

    private func metric(_ title: String, value: Int, color: Color) -> some View {
        VStack(spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text("\(value)").font(.headline).monospacedDigit().foregroundStyle(color)
        }
    }

    private func addManual(_ kind: EntryKind) {
        store.addEntry(kind: kind, calories: Int(manualAmount))
        manualAmount = 0
    }

    private func submitAIEntry() {
        let text = aiText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isEstimating else { return }
        isEstimating = true
        statusIsError = false
        statusMessage = "Estimating calories…"
        Task {
            do {
                let estimate = try await store.estimateAndAdd(text)
                aiText = ""
                statusMessage = "Added \(estimate.label): \(estimate.calories) calories."
            } catch {
                statusIsError = true
                statusMessage = error.localizedDescription
            }
            isEstimating = false
        }
    }

    private var balancePoints: [BalancePoint] {
        (-6...0).compactMap { offset in
            guard let date = Calendar.current.date(byAdding: .day, value: offset, to: store.selectedDate) else { return nil }
            let summary = store.state.summary(on: DateKey.string(from: date))
            return BalancePoint(date: date, balance: summary.balance)
        }
    }
}

private struct BalancePoint: Identifiable {
    let date: Date
    let balance: Int
    var id: Date { date }
}
