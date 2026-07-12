import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: TrackerStore

    var body: some View {
        TabView {
            CaloriesView()
                .tabItem { Label("Calories", systemImage: "flame") }

            WeightView()
                .tabItem { Label("Weight", systemImage: "scalemass") }

            LiftsView()
                .tabItem { Label("Lifts", systemImage: "dumbbell") }

            ProgressPhotosView()
                .tabItem { Label("Progress", systemImage: "photo.on.rectangle") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(.blue)
        .alert(
            "MyTracker",
            isPresented: Binding(
                get: { store.alertMessage != nil },
                set: { if !$0 { store.alertMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { store.alertMessage = nil }
        } message: {
            Text(store.alertMessage ?? "")
        }
    }
}
