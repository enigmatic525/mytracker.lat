import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct AIEntryEstimate: Codable, Equatable, Sendable {
    public let category: String
    public let label: String
    public let calories: Int
    public let confidence: String

    public var entryKind: EntryKind? {
        switch category {
        case "food": .intake
        case "exercise": .activity
        default: nil
        }
    }
}

public protocol AIEntryServing: Sendable {
    func estimate(entry: String) async throws -> AIEntryEstimate
}

public struct LiveAIEntryClient: AIEntryServing, Sendable {
    public static let productionEndpoint = URL(string: "https://mytracker-lat.vercel.app/api/food")!
    public let endpoint: URL

    public init(endpoint: URL = Self.productionEndpoint) {
        self.endpoint = endpoint
    }

    public func estimate(entry: String) async throws -> AIEntryEstimate {
        let cleaned = entry.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, cleaned.count <= 200 else { throw AIEntryError.invalidEntry }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        request.httpBody = try JSONEncoder().encode(EntryRequest(entry: cleaned))

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AIEntryError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let payload = try? JSONDecoder().decode(ErrorResponse.self, from: data)
            throw AIEntryError.server(payload?.error ?? "Could not estimate that entry right now")
        }
        let estimate = try JSONDecoder().decode(AIEntryEstimate.self, from: data)
        guard estimate.calories > 0, estimate.entryKind != nil else { throw AIEntryError.invalidResponse }
        return estimate
    }

    private struct EntryRequest: Encodable { let entry: String }
    private struct ErrorResponse: Decodable { let error: String }
}

public enum AIEntryError: LocalizedError, Equatable, Sendable {
    case invalidEntry
    case invalidResponse
    case server(String)

    public var errorDescription: String? {
        switch self {
        case .invalidEntry: "Describe food or exercise in 200 characters or fewer."
        case .invalidResponse: "The calorie service returned an invalid response."
        case .server(let message): message
        }
    }
}
