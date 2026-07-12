import Foundation

public struct TrackerPersistence: Sendable {
    public let stateURL: URL

    public init(directory: URL) {
        self.stateURL = directory.appendingPathComponent("tracker-state-v2.json")
    }

    public func load() throws -> TrackerState {
        guard FileManager.default.fileExists(atPath: stateURL.path) else { return TrackerState() }
        let data = try Data(contentsOf: stateURL)
        return try Self.decoder.decode(TrackerState.self, from: data)
    }

    public func save(_ state: TrackerState) throws {
        try FileManager.default.createDirectory(
            at: stateURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try Self.encoder.encode(state)
        try data.write(to: stateURL, options: .atomic)
    }

    public func exportBackup(_ state: TrackerState, to url: URL) throws {
        let data = try Self.encoder.encode(TrackerBackup(state: state))
        try data.write(to: url, options: .atomic)
    }

    public func importBackup(from url: URL) throws -> TrackerState {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        if let backup = try? Self.decoder.decode(TrackerBackup.self, from: data) {
            return backup.state
        }
        return try Self.decoder.decode(TrackerState.self, from: data)
    }

    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    public static let decoder = JSONDecoder()
}
