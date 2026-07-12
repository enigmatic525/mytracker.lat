import Foundation
import MyTrackerCore
import SwiftUI
import UniformTypeIdentifiers

struct TrackerBackupDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var state: TrackerState

    init(state: TrackerState) {
        self.state = state
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        if let backup = try? TrackerPersistence.decoder.decode(TrackerBackup.self, from: data) {
            state = backup.state
        } else {
            state = try TrackerPersistence.decoder.decode(TrackerState.self, from: data)
        }
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        let data = try TrackerPersistence.encoder.encode(TrackerBackup(state: state))
        return FileWrapper(regularFileWithContents: data)
    }
}
