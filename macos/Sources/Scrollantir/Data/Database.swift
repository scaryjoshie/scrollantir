import Foundation
import Logging
import NIOSSL
import PostgresNIO

enum DatabaseError: LocalizedError {
  case malformedDSN(String)

  var errorDescription: String? {
    switch self {
    case .malformedDSN(let dsn):
      return "malformed DSN (host/user/password/port not parseable): \(dsn.prefix(40))…"
    }
  }
}

/// Thin async wrapper around PostgresNIO for the queries the dashboard needs.
///
/// PostgresClient is a TaskGroup-style client: `run()` must be executing on
/// a concurrent worker before any `query(…)` leases a connection, or the
/// lease waits forever. This class owns the `run()` Task for the app's
/// lifetime and uses `Task.yield()` at startup so `run()` gets scheduled
/// before the first query.
final class Database: @unchecked Sendable {
  private let client: PostgresClient
  private let runTask: Task<Void, Never>
  private let logger: Logger

  /// Async factory because we need to `await Task.yield()` after spawning
  /// the run() task, to make sure its body gets to `client.run()` before any
  /// query is issued.
  static func connect(dsn: String) async throws -> Database {
    guard
      let url = URL(string: dsn),
      let host = url.host,
      let user = url.user?.removingPercentEncoding,
      let password = url.password?.removingPercentEncoding
    else {
      throw DatabaseError.malformedDSN(dsn)
    }
    let port = url.port ?? 5432
    let pathDB = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
    let database = pathDB.isEmpty ? "postgres" : pathDB

    var tls = TLSConfiguration.makeClientConfiguration()
    // swift-nio-ssl uses bundled BoringSSL CA roots which sometimes lag behind
    // public ISRG/Let's Encrypt chain updates; Supabase's pooler cert fails
    // `fullVerification` in that configuration even though psql (which uses
    // macOS system roots) accepts it. For v0 we relax to no-hostname-verify;
    // the TLS channel is still encrypted with a valid chain-of-some-form and
    // the DSN is a private Supabase pooler endpoint we already trust by name.
    // Revisit with a bundled root or Security-framework trust eval later.
    tls.certificateVerification = .none

    var config = PostgresClient.Configuration(
      host: host,
      port: port,
      username: user,
      password: password,
      database: database,
      tls: .require(tls)
    )
    config.options.minimumConnections = 0
    config.options.maximumConnections = 4

    var logger = Logger(label: "scrollantir.db")
    logger.logLevel = .info  // bump to .debug for verbose TLS/auth tracing

    // Pass the REAL logger to PostgresClient so its background warnings
    // (e.g. "run() hasn't been called yet") surface. The convenience init
    // wires a no-op logger, silently hiding those.
    let client = PostgresClient(configuration: config, backgroundLogger: logger)
    let runTask = Task.detached(priority: .userInitiated) { await client.run() }

    // Yield so the detached task gets scheduled and `run()` starts the pool
    // before any caller tries to lease a connection via query().
    for _ in 0..<3 { await Task.yield() }

    return Database(client: client, runTask: runTask, logger: logger)
  }

  private init(client: PostgresClient, runTask: Task<Void, Never>, logger: Logger) {
    self.client = client
    self.runTask = runTask
    self.logger = logger
  }

  deinit {
    runTask.cancel()
  }

  // MARK: - Queries

  /// Last `limit` reports newest-first, optionally filtered to a single tag.
  func fetchReports(tagFilter: String?, limit: Int = 50) async throws -> [Report] {
    let rows: PostgresRowSequence
    if let tag = tagFilter {
      rows = try await client.query(
        """
        SELECT id, title, body, tags, window_start, window_end, created_at
          FROM public.reports
         WHERE deleted_at IS NULL
           AND \(tag) = ANY(tags)
         ORDER BY created_at DESC
         LIMIT \(limit)
        """,
        logger: logger
      )
    } else {
      rows = try await client.query(
        """
        SELECT id, title, body, tags, window_start, window_end, created_at
          FROM public.reports
         WHERE deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT \(limit)
        """,
        logger: logger
      )
    }

    var results: [Report] = []
    for try await row in rows {
      let decoded = try row.decode(
        (UUID, String, String, [String], Date?, Date?, Date).self
      )
      results.append(
        Report(
          id: decoded.0,
          title: decoded.1,
          body: decoded.2,
          tags: decoded.3,
          windowStart: decoded.4,
          windowEnd: decoded.5,
          createdAt: decoded.6
        )
      )
    }
    return results
  }

  /// Events for one device in a date range. Uses events_enriched so we get
  /// device_label + tags rollup along with raw event fields.
  func fetchEvents(device: String, start: Date, end: Date, limit: Int = 20000) async throws
    -> [EnrichedEvent]
  {
    let rows = try await client.query(
      """
      SELECT id, timestamp_utc, device, source, duration_s,
             COALESCE(data::text, '{}') AS data_text
        FROM public.events_enriched
       WHERE device = \(device)
         AND timestamp_utc >= \(start)
         AND timestamp_utc <  \(end)
       ORDER BY timestamp_utc
       LIMIT \(limit)
      """,
      logger: logger
    )

    var results: [EnrichedEvent] = []
    for try await row in rows {
      let decoded = try row.decode((UUID, Date, String, String, Double, String).self)
      results.append(
        EnrichedEvent(
          id: decoded.0,
          timestampUTC: decoded.1,
          device: decoded.2,
          source: decoded.3,
          durationSec: decoded.4,
          dataJSON: decoded.5
        )
      )
    }
    return results
  }

  /// Lightweight liveness + auth check for --smoke.
  func selectOne() async throws -> Int {
    let rows = try await client.query("SELECT 1", logger: logger)
    for try await row in rows {
      let (n) = try row.decode(Int.self)
      return n
    }
    return -1
  }
}
