import MyTrackerCore
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @EnvironmentObject private var store: TrackerStore
    @State private var isExporting = false
    @State private var isImporting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Theme", selection: themeBinding) {
                        Text("Light").tag(TrackerTheme.light)
                        Text("Dark").tag(TrackerTheme.dark)
                    }
                    .pickerStyle(.segmented)

                    Picker("Units", selection: unitBinding) {
                        Text("Imperial").tag(UnitSystem.imperial)
                        Text("Metric").tag(UnitSystem.metric)
                    }
                    .pickerStyle(.segmented)
                }

                Section("Calorie targets") {
                    Stepper(value: maintenanceBinding, in: 500...9_000, step: 50) {
                        LabeledContent("BMR + NEAT", value: "\(store.state.maintenance(on: store.selectedDay)) cal")
                    }
                    Text("Changes apply from \(store.selectedDate.formatted(date: .abbreviated, time: .omitted)) forward.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Stepper(value: goalBinding, in: -1_500...1_500, step: 50) {
                        LabeledContent("Daily balance", value: signed(store.state.goalBalance))
                    }
                }

                Section("Data migration") {
                    Button { isImporting = true } label: {
                        Label("Import web or app backup", systemImage: "square.and.arrow.down")
                    }
                    Button { isExporting = true } label: {
                        Label("Export native backup", systemImage: "square.and.arrow.up")
                    }
                    Text("Export a backup from the website first, then import the JSON file here. Existing native data is replaced only after the file validates.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Service") {
                    Link("Open mytracker.lat", destination: URL(string: "https://mytracker.lat")!)
                    LabeledContent("AI endpoint", value: "Vercel")
                    LabeledContent("Native foundation", value: "SwiftUI + Swift 6")
                }
            }
            .navigationTitle("Settings")
            .fileImporter(
                isPresented: $isImporting,
                allowedContentTypes: [.json],
                allowsMultipleSelection: false
            ) { result in
                switch result {
                case .success(let urls):
                    if let url = urls.first { store.importBackup(from: url) }
                case .failure(let error):
                    store.alertMessage = "The backup picker failed: \(error.localizedDescription)"
                }
            }
            .fileExporter(
                isPresented: $isExporting,
                document: TrackerBackupDocument(state: store.state),
                contentType: .json,
                defaultFilename: "mytracker-backup"
            ) { result in
                if case .failure(let error) = result {
                    store.alertMessage = "The backup could not be exported: \(error.localizedDescription)"
                }
            }
        }
    }

    private var themeBinding: Binding<TrackerTheme> {
        Binding(
            get: { store.state.theme },
            set: { value in store.setTheme(value) }
        )
    }

    private var unitBinding: Binding<UnitSystem> {
        Binding(
            get: { store.state.unit },
            set: { value in store.setUnit(value) }
        )
    }

    private var maintenanceBinding: Binding<Int> {
        Binding(
            get: { store.state.maintenance(on: store.selectedDay) },
            set: { value in store.setMaintenance(value) }
        )
    }

    private var goalBinding: Binding<Int> {
        Binding(
            get: { store.state.goalBalance },
            set: { value in store.setGoalBalance(value) }
        )
    }

    private func signed(_ value: Int) -> String {
        if value > 0 { return "+\(value) cal" }
        if value < 0 { return "−\(abs(value)) cal" }
        return "0 cal"
    }
}
