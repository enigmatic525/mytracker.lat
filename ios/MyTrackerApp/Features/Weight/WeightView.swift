import Charts
import MyTrackerCore
import SwiftUI

struct WeightView: View {
    @EnvironmentObject private var store: TrackerStore
    @State private var weightText = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    DayNavigator()
                    weightChart
                    entryCard
                    historyList
                }
                .padding()
                .padding(.bottom, 24)
            }
            .navigationTitle("Weight")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear(perform: loadSelectedWeight)
            .onChange(of: store.selectedDate) { _, _ in loadSelectedWeight() }
        }
    }

    private var weightChart: some View {
        Group {
            if weightPoints.isEmpty {
                ContentUnavailableView("No weight history", systemImage: "chart.xyaxis.line")
            } else {
                Chart(weightPoints) { point in
                    LineMark(
                        x: .value("Date", point.date),
                        y: .value("Weight", point.weight)
                    )
                    .interpolationMethod(.catmullRom)
                    PointMark(
                        x: .value("Date", point.date),
                        y: .value("Weight", point.weight)
                    )
                }
                .chartYAxis { AxisMarks(position: .leading) }
            }
        }
        .frame(height: 230)
        .padding()
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
    }

    private var entryCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Weight for \(store.selectedDate.formatted(date: .abbreviated, time: .omitted))")
                .font(.headline)
            HStack {
                TextField("Weight", text: $weightText)
                    .keyboardType(.decimalPad)
                    .textFieldStyle(.roundedBorder)
                Text(store.state.unit.weightSymbol)
                    .foregroundStyle(.secondary)
                Button("Save") {
                    guard let weight = Double(weightText), weight > 0 else { return }
                    store.setWeight(weight)
                }
                .buttonStyle(.borderedProminent)
            }
            if store.state.weightHistory[store.selectedDay] != nil {
                Button("Remove this entry", role: .destructive) {
                    store.setWeight(nil)
                    weightText = ""
                }
            }
        }
        .padding()
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
    }

    private var historyList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Recent entries").font(.headline)
            ForEach(weightPoints.suffix(12).reversed()) { point in
                HStack {
                    Text(point.date.formatted(date: .abbreviated, time: .omitted))
                    Spacer()
                    Text(point.weight.formatted(.number.precision(.fractionLength(1))))
                        .monospacedDigit()
                    Text(store.state.unit.weightSymbol)
                        .foregroundStyle(.secondary)
                }
                Divider()
            }
        }
        .padding()
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
    }

    private var weightPoints: [WeightPoint] {
        store.state.weightHistory.compactMap { key, weight in
            DateKey.date(from: key).map { WeightPoint(date: $0, weight: weight) }
        }.sorted { $0.date < $1.date }
    }

    private func loadSelectedWeight() {
        if let weight = store.state.weightHistory[store.selectedDay] {
            weightText = weight.formatted(.number.precision(.fractionLength(1)))
        } else {
            weightText = ""
        }
    }
}

private struct WeightPoint: Identifiable {
    let date: Date
    let weight: Double
    var id: Date { date }
}
