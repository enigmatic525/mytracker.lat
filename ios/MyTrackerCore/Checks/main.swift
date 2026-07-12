import Foundation
import MyTrackerCore

enum CheckFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String {
        switch self { case .failed(let message): message }
    }
}

func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw CheckFailure.failed(message) }
}

func runChecks() throws {
    var state = TrackerState(
        goalBalance: -500,
        maintenance: 2_400,
        maintenanceHistory: ["2026-07-10": 2_500]
    )
    state.addEntry(on: "2026-07-12", kind: .intake, calories: 1_800, label: "Meals")
    state.addEntry(on: "2026-07-12", kind: .activity, calories: 300, label: "Cycling")
    let summary = state.summary(on: "2026-07-12")
    try check(summary.expenditure == 2_800, "Summary expenditure mismatch")
    try check(summary.targetIntake == 2_300, "Summary target mismatch")
    try check(summary.remaining == 500, "Summary remaining mismatch")

    var capped = TrackerState()
    capped.addEntry(on: "2026-07-12", kind: .intake, calories: 9_900)
    let clamped = capped.addEntry(on: "2026-07-12", kind: .intake, calories: 500)
    try check(clamped?.calories == 100, "Daily cap was not enforced")
    try check(capped.addEntry(on: "2026-07-12", kind: .intake, calories: 1) == nil, "Entry above cap was accepted")

    let encoded = try TrackerPersistence.encoder.encode(state)
    let decoded = try TrackerPersistence.decoder.decode(TrackerState.self, from: encoded)
    try check(decoded == state, "Web-compatible state did not round-trip")

    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let persistence = TrackerPersistence(directory: directory)
    let backupURL = directory.appendingPathComponent("backup.json")
    try persistence.exportBackup(state, to: backupURL)
    let restored = try persistence.importBackup(from: backupURL)
    try check(restored == state, "Backup did not round-trip")

    try check(DateKey.isValid("2026-07-12"), "Valid date key was rejected")
    try check(!DateKey.isValid("2026-02-31"), "Impossible date key was accepted")
}

do {
    try runChecks()
    if CommandLine.arguments.contains("--live") {
        let estimate = try await LiveAIEntryClient().estimate(entry: "one medium apple")
        try check(estimate.entryKind == .intake, "Live AI entry category mismatch")
        try check(estimate.calories > 0, "Live AI calorie estimate was empty")
        print("Live AI check passed: \(estimate.label), \(estimate.calories) calories")
    }
    print("MyTrackerCore checks passed")
} catch {
    fputs("MyTrackerCore check failed: \(error)\n", stderr)
    exit(1)
}
