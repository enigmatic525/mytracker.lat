import SwiftUI

struct DayNavigator: View {
    @EnvironmentObject private var store: TrackerStore

    var body: some View {
        HStack {
            Button { store.moveDay(by: -1) } label: {
                Image(systemName: "chevron.left")
                    .frame(width: 44, height: 44)
            }

            Spacer()

            DatePicker(
                "Day",
                selection: $store.selectedDate,
                in: ...Date(),
                displayedComponents: .date
            )
            .labelsHidden()
            .datePickerStyle(.compact)

            Spacer()

            Button { store.moveDay(by: 1) } label: {
                Image(systemName: "chevron.right")
                    .frame(width: 44, height: 44)
            }
            .disabled(Calendar.current.isDateInToday(store.selectedDate))
        }
        .font(.headline)
    }
}
