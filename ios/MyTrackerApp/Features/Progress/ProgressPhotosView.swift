import MyTrackerCore
import PhotosUI
import SwiftUI

struct ProgressPhotosView: View {
    @EnvironmentObject private var store: TrackerStore
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var isLoading = false

    private let columns = [GridItem(.adaptive(minimum: 145), spacing: 12)]

    var body: some View {
        let pickerTitle = isLoading ? "Processing photo…" : "Add progress photo"
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    DayNavigator()
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Label(pickerTitle, systemImage: "camera.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isLoading)

                    if photos.isEmpty {
                        ContentUnavailableView(
                            "No progress photos",
                            systemImage: "photo.on.rectangle.angled",
                            description: Text("Photos stay in the app's local data and backups.")
                        )
                        .frame(minHeight: 300)
                    } else {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(photos) { item in
                                photoCard(item)
                            }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Progress")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: selectedPhoto) { _, item in load(item) }
        }
    }

    private func photoCard(_ item: DatedPhoto) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            if let image = ProgressImageEncoder.image(from: item.photo.dataURL) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(height: 180)
                    .frame(maxWidth: .infinity)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            HStack {
                Text(DateKey.date(from: item.day)?.formatted(date: .abbreviated, time: .omitted) ?? item.day)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(role: .destructive) {
                    store.removeProgressPhoto(day: item.day, photo: item.photo)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
    }

    private var photos: [DatedPhoto] {
        store.state.progressPhotos.flatMap { day, photos in
            photos.map { DatedPhoto(day: day, photo: $0) }
        }.sorted { $0.photo.timestampMilliseconds > $1.photo.timestampMilliseconds }
    }

    private func load(_ item: PhotosPickerItem?) {
        guard let item else { return }
        isLoading = true
        Task {
            defer { isLoading = false; selectedPhoto = nil }
            do {
                guard let data = try await item.loadTransferable(type: Data.self),
                      let dataURL = ProgressImageEncoder.dataURL(from: data) else {
                    store.alertMessage = "That image could not be processed."
                    return
                }
                store.addProgressPhoto(dataURL: dataURL)
            } catch {
                store.alertMessage = "That image could not be loaded: \(error.localizedDescription)"
            }
        }
    }
}

private struct DatedPhoto: Identifiable {
    let day: String
    let photo: ProgressPhoto
    var id: String { photo.id }
}
