import SwiftUI

struct ContentView: View {
  @Environment(AppModel.self) var model

  var body: some View {
    Group {
      if let error = model.bootstrapError {
        BootstrapErrorView(message: error)
      } else {
        TabView {
          ReportsView()
            .tabItem { Label("Reports", systemImage: "doc.text") }
          TimelineView()
            .tabItem { Label("Timeline", systemImage: "chart.bar.xaxis") }
        }
      }
    }
  }
}

struct BootstrapErrorView: View {
  let message: String

  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.largeTitle)
        .foregroundStyle(.orange)
      Text("Couldn't connect").font(.headline)
      Text(message)
        .font(.callout)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 40)
      Text("The scrollantir/user-role DSN lives in the macOS login keychain.\nmacOS may have popped an Always-Allow prompt — click Always Allow and relaunch.")
        .font(.caption)
        .foregroundStyle(.tertiary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 40)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
