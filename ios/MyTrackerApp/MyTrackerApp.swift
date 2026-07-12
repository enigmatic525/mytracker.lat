import SwiftUI

@main
struct MyTrackerApp: App {
    @StateObject private var store = TrackerStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .preferredColorScheme(store.state.theme == .dark ? .dark : .light)
        }
    }
}
