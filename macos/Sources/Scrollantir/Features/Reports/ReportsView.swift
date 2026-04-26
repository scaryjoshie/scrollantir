import SwiftUI

struct ReportsView: View {
  @Environment(AppModel.self) var model

  var body: some View {
    @Bindable var model = model
    NavigationSplitView {
      List(selection: $model.selectedReportID) {
        ForEach(model.reports) { report in
          ReportCard(report: report).tag(report.id as UUID?)
        }
      }
      .listStyle(.sidebar)
      .navigationTitle("Reports")
      .navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 420)
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Picker("Filter", selection: $model.tagFilter) {
            Text("All").tag(nil as String?)
            Text("Daily").tag("daily" as String?)
            Text("Weekly").tag("weekly" as String?)
            Text("Smoke").tag("smoke" as String?)
          }
          .pickerStyle(.segmented)
          .frame(maxWidth: 320)
        }
      }
      .overlay {
        if model.reports.isEmpty && !model.isLoading {
          Text("no reports yet").foregroundStyle(.secondary)
        }
      }
    } detail: {
      if let id = model.selectedReportID,
        let report = model.reports.first(where: { $0.id == id })
      {
        ReportDetailView(report: report)
      } else {
        Text("Select a report")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .onChange(of: model.tagFilter) { _, _ in
      Task { await model.loadReports() }
    }
  }
}
