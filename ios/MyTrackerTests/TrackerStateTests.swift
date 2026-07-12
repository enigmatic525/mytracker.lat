import XCTest
@testable import MyTrackerCore

final class TrackerStateTests: XCTestCase {
    func testSummaryUsesEffectiveMaintenanceAndGoal() {
        var state = TrackerState(
            goalBalance: -500,
            maintenance: 2_400,
            maintenanceHistory: ["2026-07-10": 2_500]
        )
        state.addEntry(on: "2026-07-12", kind: .intake, calories: 1_800)
        state.addEntry(on: "2026-07-12", kind: .activity, calories: 300)

        let summary = state.summary(on: "2026-07-12")
        XCTAssertEqual(summary.expenditure, 2_800)
        XCTAssertEqual(summary.targetIntake, 2_300)
        XCTAssertEqual(summary.remaining, 500)
    }

    func testEntryCapAndBackupRoundTrip() throws {
        var state = TrackerState()
        state.addEntry(on: "2026-07-12", kind: .intake, calories: 9_900)
        XCTAssertEqual(state.addEntry(on: "2026-07-12", kind: .intake, calories: 500)?.calories, 100)
        XCTAssertNil(state.addEntry(on: "2026-07-12", kind: .intake, calories: 1))

        let data = try TrackerPersistence.encoder.encode(state)
        XCTAssertEqual(try TrackerPersistence.decoder.decode(TrackerState.self, from: data), state)
    }
}
