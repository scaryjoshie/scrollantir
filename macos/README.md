# scrollantir / macOS dashboard

Native macOS SwiftUI app for reading scrollantir reports + event timelines.
Reads `user_role` DSN from the login keychain and connects straight to
Supabase Postgres over TLS. No Supabase auth; no middle tier.

## Layout

```
macos/
├── Package.swift                      SPM manifest (macOS 14+)
├── Sources/Scrollantir/
│   ├── ScrollantirApp.swift          @main; --smoke branches to CLI
│   ├── AppModel.swift                 @Observable shared state
│   ├── ContentView.swift              TabView
│   ├── Data/
│   │   ├── Keychain.swift            reads scrollantir/user-role
│   │   ├── Database.swift            PostgresNIO actor
│   │   └── Models.swift              Report, EnrichedEvent
│   └── Features/
│       ├── Reports/…                 NavigationSplitView + MarkdownUI
│       └── Timeline/…                Three Swift Charts lanes
```

## First run

```bash
cd macos
# DSN bypass is the dev-friendly path — unsigned SwiftPM binaries
# silently deadlock on macOS keychain access instead of prompting,
# so we export the DSN from the shell via security:
export SCROLLANTIR_USER_ROLE_DSN="$(security find-generic-password -s scrollantir -a user-role -w)"
swift build                     # downloads PostgresNIO, KeychainAccess, MarkdownUI
swift run Scrollantir --smoke   # headless: DSN + SELECT 1 + fetch 3 reports
```

Expected smoke output:

```
[smoke] 1/4 reading scrollantir/user-role from login keychain (or SCROLLANTIR_USER_ROLE_DSN env)…
[smoke] 2/4 DSN retrieved (host=aws-1-us-east-2.pooler.supabase.com, 137 chars)
[smoke] 3/4 connecting to Postgres and running SELECT 1…
[smoke] 4/4 fetching 3 reports…
[smoke] ok · SELECT 1 = 1, fetched 3 reports:
  · Weekly report 2026-04-21  …  tags=["weekly"]
  · Daily digest 2026-04-21   …  tags=["daily"]
  · Daily digest 2026-04-21   …  tags=["daily"]
```

## Launching the UI

Two ways — both need the env var set in their parent shell:

```bash
# 1. From the terminal
cd macos
export SCROLLANTIR_USER_ROLE_DSN="$(security find-generic-password -s scrollantir -a user-role -w)"
swift run Scrollantir

# 2. From Xcode — open the package as a workspace, set the scheme env var,
#    hit ⌘R. In Xcode: Product → Scheme → Edit Scheme → Run → Arguments →
#    Environment Variables → add SCROLLANTIR_USER_ROLE_DSN.
xed macos/Package.swift
```

## Known rough edges (v0)

- **Keychain deadlock on unsigned binaries.** `scrollantir/user-role` is in
  the login keychain but unsigned SwiftPM executables don't reliably trigger
  macOS's "Always Allow" prompt; they just hang on the access check. The
  env-var path above is the reliable dev loop. Fix path: ship as a properly
  signed Xcode-project app, then Keychain becomes the primary source.

- **TLS cert verification relaxed.** swift-nio-ssl uses bundled BoringSSL CA
  roots that lag behind Supabase's pooler cert chain; `.fullVerification`
  fails even though `psql` (using macOS system roots) accepts. `Database.swift`
  currently sets `.certificateVerification = .none` — TLS channel still
  encrypted, but no chain verification. Revisit with a bundled root or
  Security-framework trust evaluation before shipping publicly.

## Dependencies (and why these)

| Package | Why this one |
|---|---|
| [`vapor/postgres-nio`](https://github.com/vapor/postgres-nio) | Direct Postgres over TLS. Skips `supabase-swift`'s JWT-auth model, which doesn't match our role-based DSN. |
| [`kishikawakatsumi/KeychainAccess`](https://github.com/kishikawakatsumi/KeychainAccess) | 3-line DSN retrieval vs. ~30 with raw `Security.framework`. |
| [`gonzalezreal/swift-markdown-ui`](https://github.com/gonzalezreal/swift-markdown-ui) | Full CommonMark + GFM in SwiftUI. Reports render in one line: `Markdown(report.body)`. |

## What this doesn't do (v0)

- No chat with the agent (future; needs an HTTP endpoint on the orchestrator)
- No report editing / writes; `user_role` is SELECT-only on `public.reports` by design
- No settings UI; DSN is always `scrollantir/user-role` from the keychain
- No code signing or notarization (local-dev binary; `swift run` or Xcode Run)
- No report search or timeline zoom — explicit v0.1 items

## When you'd expand to a real Xcode project

Never, if you're only running it yourself. Convert if you want code signing,
notarization, TestFlight, or an App Store listing. `File → New → Project →
macOS → App` in Xcode, copy the `Sources/` tree in, set the same three SPM
dependencies, done.

## Related

- `../docs/orchestrator.md` — agent that writes the reports this app reads
- `../docs/data-flow.md` — overall runtime placement and credential map
- `../docs/roadmap.md` — shipping order and remaining `user_role` uses
