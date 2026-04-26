import SwiftUI

struct TimelineView: View {
  @Environment(AppModel.self) var model

  var body: some View {
    @Bindable var model = model
    let cal = Calendar(identifier: .gregorian)
    let start = cal.startOfDay(for: model.timelineDay)
    let end = cal.date(byAdding: .day, value: 1, to: start) ?? start.addingTimeInterval(86_400)

    return ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        EventLane(
          title: "Mac",
          events: model.macEvents,
          tint: .blue,
          windowStart: start,
          windowEnd: end
        )
        EventLane(
          title: "Phone",
          events: model.phoneEvents,
          tint: .green,
          windowStart: start,
          windowEnd: end
        )
        EventLane(
          title: "Location",
          events: model.locationEvents,
          tint: .orange,
          windowStart: start,
          windowEnd: end
        )
      }
      .padding(.vertical, 16)
    }
    .navigationTitle("Timeline")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        DatePicker("", selection: $model.timelineDay, displayedComponents: [.date])
          .labelsHidden()
      }
      ToolbarItem(placement: .navigation) {
        Button {
          model.timelineDay = cal.date(byAdding: .day, value: -1, to: model.timelineDay)!
        } label: {
          Label("Previous day", systemImage: "chevron.left")
        }
      }
      ToolbarItem(placement: .navigation) {
        Button {
          model.timelineDay = cal.date(byAdding: .day, value: 1, to: model.timelineDay)!
        } label: {
          Label("Next day", systemImage: "chevron.right")
        }
      }
    }
    .onChange(of: model.timelineDay) { _, _ in
      Task { await model.loadTimeline() }
    }
  }
}
