import AppKit
import Foundation
import SwiftUI

/// Custom @main so we can branch into a headless --smoke mode before the
/// SwiftUI App runs. The smoke path exercises DSN retrieval + Postgres auth +
/// one round-trip SELECT, then exits 0/1 for CI-style validation.
///
/// `main()` is async so the smoke-mode Task runs on the top-level concurrency
/// context directly (no DispatchSemaphore bridge — that pattern deadlocks
/// here because blocking the main thread on a semaphore starves the Swift
/// concurrency executor and no Task ever gets a chance to run).
@main
struct ScrollantirEntry {
  static func main() async {
    if CommandLine.arguments.contains("--smoke") {
      setbuf(stdout, nil)
      print("[smoke] 1/4 reading scrollantir/user-role from login keychain (or SCROLLANTIR_USER_ROLE_DSN env)…")
      do {
        let dsn = try readUserRoleDSN()
        print("[smoke] 2/4 DSN retrieved (host=\(URL(string: dsn)?.host ?? "?"), \(dsn.count) chars)")
        let db = try await Database.connect(dsn: dsn)
        print("[smoke] 3/4 connecting to Postgres and running SELECT 1…")
        let n = try await db.selectOne()
        precondition(n == 1)
        print("[smoke] 4/4 fetching 3 reports…")
        let reports = try await db.fetchReports(tagFilter: nil, limit: 3)
        print("[smoke] ok · SELECT 1 = \(n), fetched \(reports.count) reports:")
        for r in reports {
          print("  · \(r.title)  (\(r.createdAt))  tags=\(r.tags)")
        }
        exit(0)
      } catch {
        print("[smoke] FAILED: \(error)")
        exit(1)
      }
    }

    // GUI path — async entry still calls the App's synchronous main().
    ScrollantirApp.main()
  }
}

struct ScrollantirApp: App {
  @State private var model = AppModel()

  init() {
    // SwiftPM-built executables don't get Info.plist-based activation,
    // so macOS treats them as accessory/background apps. Force regular
    // activation so the window behaves like a normal Mac app (doesn't
    // vanish when you click away, shows in Dock + ⌘-Tab, menu bar
    // owns the menu).
    NSApplication.shared.setActivationPolicy(.regular)
    NSApplication.shared.activate(ignoringOtherApps: true)
  }

  var body: some Scene {
    WindowGroup("Scrollantir") {
      ContentView()
        .environment(model)
        .frame(minWidth: 900, minHeight: 600)
        .task {
          await model.bootstrap()
        }
    }
    .windowResizability(.contentMinSize)
  }
}
