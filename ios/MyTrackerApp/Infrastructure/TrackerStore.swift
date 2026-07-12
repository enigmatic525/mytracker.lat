import Combine
import Foundation
import MyTrackerCore

@MainActor
final class TrackerStore: ObservableObject {
    @Published private(set) var state: TrackerState
    @Published var selectedDate: Date
    @Published var alertMessage: String?

    private let persistence: TrackerPersistence
    private let aiClient: any AIEntryServing

    init(
        persistence: TrackerPersistence? = nil,
        aiClient: any AIEntryServing = LiveAIEntryClient()
    ) {
        let directory = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!.appendingPathComponent("MyTracker", isDirectory: true)
        let resolvedPersistence = persistence ?? TrackerPersistence(directory: directory)
        self.persistence = resolvedPersistence
        self.aiClient = aiClient
        self.selectedDate = Date()
        do {
            self.state = try resolvedPersistence.load()
        } catch {
            self.state = TrackerState()
            self.alertMessage = "Your saved data could not be loaded. A new tracker was started."
        }
    }

    var selectedDay: String { DateKey.string(from: selectedDate) }
    var selectedSummary: DaySummary { state.summary(on: selectedDay) }
    var selectedEntries: [CalorieEntry] { state.entries(on: selectedDay) }

    func moveDay(by amount: Int) {
        guard let date = Calendar.current.date(byAdding: .day, value: amount, to: selectedDate) else { return }
        selectedDate = min(date, Date())
    }

    func selectToday() { selectedDate = Date() }

    func addEntry(kind: EntryKind, calories: Int, label: String? = nil) {
        mutate { $0.addEntry(on: selectedDay, kind: kind, calories: calories, label: label) }
    }

    func removeEntry(_ entry: CalorieEntry) {
        mutate { $0.removeEntry(id: entry.id, on: selectedDay) }
    }

    func estimateAndAdd(_ text: String) async throws -> AIEntryEstimate {
        let estimate = try await aiClient.estimate(entry: text)
        guard let kind = estimate.entryKind else { throw AIEntryError.invalidResponse }
        addEntry(kind: kind, calories: estimate.calories, label: estimate.label)
        return estimate
    }

    func setWeight(_ value: Double?) {
        mutate { $0.setWeight(value, on: selectedDay) }
    }

    func setTheme(_ theme: TrackerTheme) { mutate { $0.theme = theme } }
    func setUnit(_ unit: UnitSystem) { mutate { $0.unit = unit } }

    func setGoalBalance(_ value: Int) {
        mutate { $0.goalBalance = min(max(value, -TrackerState.goalBalanceLimit), TrackerState.goalBalanceLimit) }
    }

    func setMaintenance(_ value: Int) {
        mutate { $0.setMaintenance(value, effectiveOn: selectedDay) }
    }

    func addProgressPhoto(dataURL: String) {
        mutate { $0.addProgressPhoto(ProgressPhoto(dataURL: dataURL), on: selectedDay) }
    }

    func removeProgressPhoto(day: String, photo: ProgressPhoto) {
        mutate { $0.removeProgressPhoto(id: photo.id, on: day) }
    }

    func cycleLift(on day: String) {
        mutate {
            let nextGroup: LiftMuscleGroup?
            switch $0.liftHistory[day]?.first?.group {
            case nil: nextGroup = .chest
            case .chest: nextGroup = .back
            case .back: nextGroup = .leg
            case .leg: nextGroup = nil
            }

            $0.liftHistory[day] = nil
            if let nextGroup {
                // Retain the shared web/native backup schema while recording
                // attendance and the selected workout color.
                $0.addLift(on: day, group: nextGroup, exercise: "Workout", sets: 1, reps: 1, weight: 0)
            }
        }
    }

    func importBackup(from url: URL) {
        do {
            let imported = try persistence.importBackup(from: url)
            state = imported
            try persistence.save(imported)
        } catch {
            alertMessage = "That backup could not be imported: \(error.localizedDescription)"
        }
    }

    private func mutate(_ change: (inout TrackerState) -> Void) {
        change(&state)
        state.sanitize()
        do {
            try persistence.save(state)
        } catch {
            alertMessage = "Your latest change could not be saved: \(error.localizedDescription)"
        }
    }
}
