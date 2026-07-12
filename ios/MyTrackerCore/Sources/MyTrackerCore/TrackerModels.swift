import Foundation

public enum EntryKind: String, Codable, CaseIterable, Sendable {
    case intake = "in"
    case activity = "out"
}

public struct CalorieEntry: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var kind: EntryKind
    public var calories: Int
    public var label: String?

    public init(
        id: String = UUID().uuidString,
        kind: EntryKind,
        calories: Int,
        label: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.calories = calories
        self.label = label?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case kind = "t"
        case calories = "a"
        case label
    }
}

public struct ProgressPhoto: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var timestampMilliseconds: Int64
    public var dataURL: String

    public init(
        id: String = UUID().uuidString,
        timestampMilliseconds: Int64 = Int64(Date().timeIntervalSince1970 * 1_000),
        dataURL: String
    ) {
        self.id = id
        self.timestampMilliseconds = timestampMilliseconds
        self.dataURL = dataURL
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case timestampMilliseconds = "ts"
        case dataURL = "dataUrl"
    }
}

public enum TrackerTheme: String, Codable, CaseIterable, Sendable {
    case light
    case dark
}

public enum UnitSystem: String, Codable, CaseIterable, Sendable {
    case imperial
    case metric

    public var weightSymbol: String {
        switch self {
        case .imperial: "lb"
        case .metric: "kg"
        }
    }
}

public struct DaySummary: Equatable, Sendable {
    public let intake: Int
    public let activity: Int
    public let maintenance: Int
    public let goalBalance: Int

    public var expenditure: Int { maintenance + activity }
    public var targetIntake: Int { max(0, expenditure + goalBalance) }
    public var remaining: Int { targetIntake - intake }
    public var balance: Int { intake - expenditure }

    public var progress: Double {
        guard targetIntake > 0 else { return intake > 0 ? 1 : 0 }
        return min(max(Double(intake) / Double(targetIntake), 0), 1)
    }
}

public struct TrackerState: Codable, Equatable, Sendable {
    public static let dailyCalorieCap = 10_000
    public static let goalBalanceLimit = 1_500

    public var goalBalance: Int
    public var maintenance: Int
    public var maintenanceHistory: [String: Int]
    public var history: [String: [CalorieEntry]]
    public var weightHistory: [String: Double]
    public var progressPhotos: [String: [ProgressPhoto]]
    public var theme: TrackerTheme
    public var unit: UnitSystem

    public init(
        goalBalance: Int = -500,
        maintenance: Int = 2_500,
        maintenanceHistory: [String: Int] = [:],
        history: [String: [CalorieEntry]] = [:],
        weightHistory: [String: Double] = [:],
        progressPhotos: [String: [ProgressPhoto]] = [:],
        theme: TrackerTheme = .dark,
        unit: UnitSystem = .imperial
    ) {
        self.goalBalance = goalBalance
        self.maintenance = maintenance
        self.maintenanceHistory = maintenanceHistory
        self.history = history
        self.weightHistory = weightHistory
        self.progressPhotos = progressPhotos
        self.theme = theme
        self.unit = unit
        sanitize()
    }

    public func maintenance(on day: String) -> Int {
        let effectiveKey = maintenanceHistory.keys
            .filter { DateKey.isValid($0) && $0 <= day }
            .max()
        return effectiveKey.flatMap { maintenanceHistory[$0] } ?? maintenance
    }

    public func entries(on day: String) -> [CalorieEntry] {
        history[day] ?? []
    }

    public func summary(on day: String) -> DaySummary {
        let entries = entries(on: day)
        return DaySummary(
            intake: entries.filter { $0.kind == .intake }.reduce(0) { $0 + $1.calories },
            activity: entries.filter { $0.kind == .activity }.reduce(0) { $0 + $1.calories },
            maintenance: maintenance(on: day),
            goalBalance: goalBalance
        )
    }

    @discardableResult
    public mutating func addEntry(
        on day: String,
        kind: EntryKind,
        calories: Int,
        label: String? = nil
    ) -> CalorieEntry? {
        guard DateKey.isValid(day), calories > 0 else { return nil }
        let current = entries(on: day)
            .filter { $0.kind == kind }
            .reduce(0) { $0 + $1.calories }
        let accepted = min(calories, Self.dailyCalorieCap - current)
        guard accepted > 0 else { return nil }

        let entry = CalorieEntry(kind: kind, calories: accepted, label: label)
        history[day, default: []].append(entry)
        return entry
    }

    public mutating func removeEntry(id: String, on day: String) {
        history[day]?.removeAll { $0.id == id }
        if history[day]?.isEmpty == true { history[day] = nil }
    }

    public mutating func setWeight(_ weight: Double?, on day: String) {
        guard DateKey.isValid(day) else { return }
        if let weight, weight.isFinite, weight > 0, weight <= 1_500 {
            weightHistory[day] = (weight * 10).rounded() / 10
        } else {
            weightHistory[day] = nil
        }
    }

    public mutating func setMaintenance(_ value: Int, effectiveOn day: String) {
        guard DateKey.isValid(day) else { return }
        maintenanceHistory[day] = min(max(value, 500), 9_000)
    }

    public mutating func addProgressPhoto(_ photo: ProgressPhoto, on day: String) {
        guard DateKey.isValid(day), photo.dataURL.hasPrefix("data:image/") else { return }
        progressPhotos[day, default: []].append(photo)
        progressPhotos[day] = Array(progressPhotos[day, default: []].suffix(6))
        pruneProgressPhotos()
    }

    public mutating func removeProgressPhoto(id: String, on day: String) {
        progressPhotos[day]?.removeAll { $0.id == id }
        if progressPhotos[day]?.isEmpty == true { progressPhotos[day] = nil }
    }

    public mutating func sanitize() {
        goalBalance = min(max(goalBalance, -Self.goalBalanceLimit), Self.goalBalanceLimit)
        maintenance = min(max(maintenance, 500), 9_000)
        maintenanceHistory = maintenanceHistory.reduce(into: [:]) { result, item in
            guard DateKey.isValid(item.key) else { return }
            result[item.key] = min(max(item.value, 500), 9_000)
        }
        history = history.reduce(into: [:]) { result, item in
            guard DateKey.isValid(item.key) else { return }
            let valid = item.value.filter { $0.calories > 0 && $0.calories <= Self.dailyCalorieCap }
            if !valid.isEmpty { result[item.key] = valid }
        }
        weightHistory = weightHistory.reduce(into: [:]) { result, item in
            guard DateKey.isValid(item.key), item.value.isFinite, item.value > 0, item.value <= 1_500 else { return }
            result[item.key] = item.value
        }
        progressPhotos = progressPhotos.reduce(into: [:]) { result, item in
            guard DateKey.isValid(item.key) else { return }
            let valid = item.value.filter { $0.dataURL.hasPrefix("data:image/") }
            if !valid.isEmpty { result[item.key] = Array(valid.suffix(6)) }
        }
        pruneProgressPhotos()
    }

    private mutating func pruneProgressPhotos() {
        let newest = progressPhotos
            .flatMap { day, photos in photos.map { (day: day, photo: $0) } }
            .sorted { $0.photo.timestampMilliseconds > $1.photo.timestampMilliseconds }
            .prefix(60)
        let allowedIDs = Set(newest.map(\.photo.id))
        progressPhotos = progressPhotos.reduce(into: [:]) { result, item in
            let kept = item.value.filter { allowedIDs.contains($0.id) }
            if !kept.isEmpty { result[item.key] = kept }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case goalBalance
        case legacyGoal = "goal"
        case maintenance
        case maintenanceHistory
        case history
        case weightHistory
        case progressPhotos
        case theme
        case unit
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        maintenance = try container.decodeIfPresent(Int.self, forKey: .maintenance) ?? 2_500
        if let balance = try container.decodeIfPresent(Int.self, forKey: .goalBalance) {
            goalBalance = balance
        } else if let legacyGoal = try container.decodeIfPresent(Int.self, forKey: .legacyGoal) {
            goalBalance = legacyGoal - maintenance
        } else {
            goalBalance = -500
        }
        maintenanceHistory = try container.decodeIfPresent([String: Int].self, forKey: .maintenanceHistory) ?? [:]
        history = try container.decodeIfPresent([String: [CalorieEntry]].self, forKey: .history) ?? [:]
        weightHistory = try container.decodeIfPresent([String: Double].self, forKey: .weightHistory) ?? [:]
        progressPhotos = try container.decodeIfPresent([String: [ProgressPhoto]].self, forKey: .progressPhotos) ?? [:]
        theme = try container.decodeIfPresent(TrackerTheme.self, forKey: .theme) ?? .dark
        unit = try container.decodeIfPresent(UnitSystem.self, forKey: .unit) ?? .imperial
        sanitize()
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(goalBalance, forKey: .goalBalance)
        try container.encode(maintenance, forKey: .maintenance)
        try container.encode(maintenanceHistory, forKey: .maintenanceHistory)
        try container.encode(history, forKey: .history)
        try container.encode(weightHistory, forKey: .weightHistory)
        try container.encode(progressPhotos, forKey: .progressPhotos)
        try container.encode(theme, forKey: .theme)
        try container.encode(unit, forKey: .unit)
    }
}

public struct TrackerBackup: Codable, Equatable, Sendable {
    public let formatVersion: Int
    public let exportedAt: String
    public let state: TrackerState

    public init(state: TrackerState, exportedAt: Date = Date()) {
        self.formatVersion = 2
        self.exportedAt = ISO8601DateFormatter().string(from: exportedAt)
        self.state = state
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
