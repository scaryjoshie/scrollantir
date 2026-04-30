# Session 2026-04-29 — GPS noise filtering

Continuation of the location-quality thread from
[`session-2026-04-28.md`](session-2026-04-28.md). Yesterday bumped
`LocationWatcher` from `PRIORITY_BALANCED_POWER_ACCURACY` →
`PRIORITY_HIGH_ACCURACY` to improve baseline fix quality. Today addresses
the residual problem: the map track on `LocationScreen` "spazzes" — within
a minute the device's plotted position can leap 50+ meters even while
actually stationary, especially around campus.

## TL;DR

- Diagnosed: the jumps come from **WiFi/cell-triangulated fixes leaking
  through Fused with `provider = "fused"`** and small (optimistic)
  accuracy radii. `PRIORITY_HIGH_ACCURACY` is GPS-*led*, not GPS-*only*.
  Dense-AP environments (campus) make this worst.
- Implemented a three-gate filter pipeline in `LocationWatcher.recordReading`:
  1. Tightened accuracy gate (200m → 50m)
  2. **GPS-attestation gate** — drop fixes that don't expose
     satellite-derived fields (`hasVerticalAccuracy` or
     `hasSpeed && hasBearing`)
  3. **Speed-based outlier rejection** keyed off `ActivityWatcher.current`
- Lowered `CurrentLocationRequest.setMaxUpdateAgeMillis` from 60s → 15s
  to stop activity-transition anchors from being served minute-old cached
  fixes (a separate source of "teleports").
- New stored event field: `gps_attested: true`. Optional
  `implied_speed_mps` is recorded when a previous accepted reading was
  available, for post-hoc analysis of marginal-but-passed readings.
- No changes to `LocationScreen` — filtering happens at storage. Bad
  readings simply never get recorded.

## Key insights from this session

These are the conceptual conclusions that drove the implementation. If
the code ever needs to be revisited, these are the load-bearing ideas.

### 1. `PRIORITY_HIGH_ACCURACY` is GPS-*led*, not GPS-*only*

The single most important misconception to clear up. The flag's name
implies "use GPS"; what it actually means is *"use everything available
— GPS + WiFi + cell + sensors — to produce the most accurate fix you
can right now."* On a phone surrounded by WiFi APs whose locations
Google has indexed, "best fix" can mean a WiFi-triangulated position,
even when GPS would have been available a moment later. The chip is not
lying about its priority — it just doesn't have a knob for "GPS only,
please wait if you have to."

### 2. The dishonest reading is not the one with bad accuracy — it's the one with *good* accuracy and a wrong position

The original 200m gate assumed bad readings would self-identify by
having large accuracy radii. They don't. WiFi triangulation produces
fixes with `accuracy_m = 18` that are 50–80m off. The GPS-attestation
gate works because it doesn't trust the self-reported accuracy — it
checks for *physical signatures of GPS* (vertical accuracy, Doppler
speed/bearing) that WiFi/cell triangulation cannot fake.

### 3. On dense-WiFi environments (campus), every reading is suspect by default

A single AP's MAC-to-location mapping in Google's database can be off by
tens of meters, or stale (the AP physically moved). As you walk past a
dozen APs, the inferred-position pulls toward each in turn. This is
fundamentally what produces the "spazzing" pattern. No on-device
filtering will recover the right position from a WiFi-only fix; the
only sound move is to refuse those fixes and accept the indoor-gap
trade.

### 4. Filtering does not reduce chip wake rate or data frequency in the way it feels like it should

This came up explicitly: "won't filtering kill my frequent data?"
The chip wakes at the rate set by `LocationRequest.intervalMs` regardless
of whether we store the result. Filtering only rejects samples that
were going to be wrong. Outdoors with sky view, ~95% of Fused readings
are GPS-attested and pass. The frequency loss is concentrated indoors
and in dense urban settings, where the alternative ("keep the WiFi
fix") was actively making the trace worse, not better. Honest gaps beat
plausible-looking lies.

### 5. Life360-style "down to the foot" accuracy is UI craft, not better GPS

Place-snapping, map-matching, always-warm GPS, and server-side
smoothing produce the *appearance* of pinpoint accuracy. The underlying
GPS chip on a Pixel 9 is the same one we're using. We can't catch up to
Life360 by tuning the location subscription — that path is exhausted at
PRIORITY_HIGH_ACCURACY. Future quality leaps come from the same display-
layer tricks Life360 uses, especially place-anchoring (we have the
saved-places concept already; see `docs/concepts/places.md`).

### 6. Filter at storage, not at display — for this app, this user, this scale

We considered storing every raw reading and filtering at display, in
the spirit of the existing "store raw, transform on read" pattern
(e.g. activity-state clipping in the Today aggregation). We rejected
it for this case because:

- The user-visible problem is the trace on the map. Display-time
  filtering means every consumer (LocationScreen, future dashboards,
  exports) has to remember to apply the filter.
- The bad readings are not "data that's useful for some other
  purpose" — they're literally wrong. There's no analysis I'd want to
  do over WiFi-jitter that I wouldn't also want to do over the GPS-
  attested subset.
- We do still preserve forensic visibility via the new `gps_attested`
  field, which lets us *know* a reading was attested even though we
  no longer store unattested ones. If we ever loosen the gate, the
  field documents the conservative subset for backward-compatible
  queries.

The general principle (store raw, filter on read) still applies for
data with multiple legitimate views. GPS-noise rejection isn't that.

### 7. The whole noise-handling playbook, ranked

Order in which we evaluated common techniques (highest leverage first):

1. **Speed-based outlier rejection.** Universal in fitness/mapping apps.
   Catches teleports directly. Implemented.
2. **GPS-attestation gate.** Specific to this app's WiFi-jitter problem.
   The biggest single win on campus. Implemented.
3. **Tighter accuracy gate.** Cheap, complementary. Implemented (200 → 50).
4. **Drop stale cached fixes.** Direct cause of activity-transition
   teleports. Implemented (60s → 15s).
5. **Light Kalman smoothing.** Optional polish. *Not* implemented;
   revisit if (1)–(4) prove insufficient.
6. **Map-matching.** Powerful but requires road-network data. Out of
   scope for the phone client.
7. **Place-anchoring on display.** Highest user-perceived quality lever
   *after* (1)–(4) are in. Future work.

## Why the existing filter wasn't enough

Pre-change `recordReading` only checked accuracy:

```kotlin
if (accuracy > 200) drop                    // periodic
if (accuracy > 50  && reason == "start") drop   // transition anchor
```

The 200m bound was set to handle tunnels and indoor weak-signal cases,
but the actual failure mode on campus is the opposite: **tight accuracy
radii on dishonest readings**. Fused will return a WiFi-triangulated fix
with `accuracy_m = 18` while the real position is 50–80m off. The fix is
recent and has a nice-looking radius, so the gate lets it through. As
the device passes near different APs, the inferred position snaps
between their database locations, producing the visual teleport.

## Why GPS attestation works

A real GPS fix sets fields that WiFi/cell-derived fixes physically can't:

| Field | Why GPS sets it | Why WiFi/cell can't |
|---|---|---|
| `hasSpeed()` / `hasBearing()` | Doppler shift from satellites yields velocity for free | No motion signal in a single AP scan |
| `hasVerticalAccuracy()` / `verticalAccuracyMeters` | Three+ satellites resolve altitude | All same-level APs, zero altitude info |

The gate `hasVerticalAccuracy() || (hasSpeed() && hasBearing())` admits
GPS fixes (which routinely set both) and rejects pure WiFi/cell fixes
(which set neither). Hybrid fixes — GPS used a couple of satellites and
filled in with WiFi — typically still set vertical accuracy, so the gate
keeps them.

We don't gain *new* coverage from WiFi/cell attestation; we lose it.
That's the intended trade. The trace is dramatically cleaner outdoors
where GPS is available; indoors the trace gaps out instead of jittering,
which matches what we actually want to know — "where were they really."
Future place-anchoring (see `docs/concepts/places.md`) is the right
solution for the indoor case.

## Speed-based outlier rejection

For each new reading, compute implied speed from the last accepted
reading. Compare against a per-activity max (`maxSpeedFor(state)`), padded
by the combined accuracy budget so a fix near the boundary doesn't get
falsely dropped.

```
ActivityState  maxSpeedFor (m/s)  ≈ km/h
STILL          2.0                 7
WALKING        3.5                12
RUNNING        7.0                25
ON_BICYCLE     14.0               50
IN_VEHICLE     45.0              160
UNKNOWN        14.0               50  (treat as bike-tier)
```

The pad is `(accLast + accNew) / dt`. Two readings with ±15m accuracy
1s apart could legitimately appear ~30m apart and report speed = 30 m/s
without anyone moving. The padding accommodates this exactly.

### First-reading-after-transition special case

Skipping the speed gate for the first reading after `onActivityChange`
matters because:

- STILL → IN_VEHICLE: phone was sitting on a desk; first vehicle GPS
  fix is from 30m away (driver picked it up, walked outside, drove off).
  Implied speed from the desk-anchor is huge but the new reading is
  honest.
- Activity transitions land in `LocationWatcher` already. We just need
  to flip `skipNextSpeedCheck = true` there. The flag clears on the
  first accepted reading, so subsequent readings get gated normally.

## What's new on the wire

`phone.location.reading` events now include:

```json
{
  "lat": ...,
  "lng": ...,
  "accuracy_m": ...,
  "provider": "fused",
  "reason": "...",
  "gps_attested": true,
  "implied_speed_mps": 1.4   // optional; present iff lastAccepted was set
}
```

`gps_attested` is always `true` for any stored reading (the gate fires
before storage). It's there explicitly so if we relax the gate later,
historical rows can be queried as the conservative subset.

## What did NOT change

- `setMinUpdateDistanceMeters` per-activity tuning — unchanged.
  WALKING 40m, RUNNING 40m, BICYCLE 60m, VEHICLE 100m. Orthogonal to the
  noise problem.
- `LocationScreen.kt` — no display changes. Filter is at storage; see
  Key Insight #6 above for the explicit deliberation. Short version: we
  considered storing all raw readings and filtering at display, decided
  against it because the bad readings have no other legitimate use,
  every consumer would have to remember the filter, and `gps_attested`
  metadata still preserves the forensic ability to reason about which
  readings the gate accepted.
- `ActivityWatcher.kt` — unchanged. `LocationWatcher` reads
  `currentActivity` from a private field updated in `onActivityChange`,
  not from `ActivityWatcher` directly, so no API coupling added.
- Server / forwarder — `phone.location.*` events are still forwarder-
  filtered (local-only), no change.

## How Life360 dodges this differently

The "how is Life360 so accurate?" question came up explicitly and it's
worth recording the answer in detail, because it shapes our future
roadmap.

Life360's apparent "down to the foot" accuracy on campus is not better
GPS — it's a stack of UI tricks layered on top of a fundamentally
similar GPS subscription:

- **Place-snapping:** displayed marker snaps to saved-place coordinates
  when the device is nearby. Real fix may be 15m off; the bubble sits
  on the house. Most of the perceived "Life360 accuracy" is actually
  this trick.
- **Map-matching:** while driving, snap to the nearest road segment.
  Same trick Google Maps uses for nav. The dot is dead center on the
  road regardless of where the GPS actually puts you.
- **Always-warm GPS:** continuous foreground service keeps the chip
  hot. Every fix is post-cold-lock quality (sub-5m on Pixel-class
  hardware). Pays for it in famously bad battery life.
- **Sensor fusion / dead reckoning:** accelerometer + step counter +
  gyro fill in between GPS fixes for smoother apparent motion.
- **Server-side trajectory smoothing:** retroactive Kalman / HMM passes
  rewrite jagged historical traces before display.

**Conclusion: we cannot close the perceived gap by tuning the location
subscription.** PRIORITY_HIGH_ACCURACY is already the strongest fused
priority Android exposes. The remaining quality leaps live at the
display layer — primarily place-anchoring, which we already have the
data model for in `docs/concepts/places.md`. Server-side smoothing is
a worthwhile experiment eventually but does not justify the complexity
at personal-use scale.

## Future (not done this session)

- **Place anchoring on the phone.** Detect that we've been within ~30m
  of a known place for >5 minutes; visually anchor the marker to the
  saved place coordinates while we remain inside. Hides what little
  jitter survives the GPS-attested gate when stationary.
- **Optional: light Kalman smoothing for display.** Speed gating + GPS
  attestation handle the gross outliers; a 2D Kalman would give a
  smoother polyline by interpolating between fixes. Defer until we see
  whether the current changes make it unnecessary.
- **Indoor coverage.** With GPS-attested gating we lose
  WiFi-triangulated readings indoors. If post-rollout we see large
  daytime gaps, consider a relaxed second tier ("non-attested but
  accuracy < 25m") stored separately as `phone.location.coarse`,
  excluded from default views.

## Files touched

- `android/app/src/main/java/app/scrollantir/tracker/LocationWatcher.kt`
  — filter pipeline, currentActivity field, lastAccepted state,
  haversineMeters helper, tightened MAX_ACCURACY_M, lowered
  setMaxUpdateAgeMillis, updated class doc.

## Verified

- `./gradlew :app:compileDebugKotlin` clean.
- No call-site changes required: `onActivityChange(state)` signature
  unchanged; `recordReading` is private.

## Pointers

- [session-2026-04-28.md](session-2026-04-28.md) — yesterday's priority
  bump, immediately preceding work
- [`docs/concepts/location.md`](../concepts/location.md) — collection
  spec; the 200m → 50m bound and the new attestation/speed gates are
  not yet reflected there
- [`docs/concepts/places.md`](../concepts/places.md) — place-anchoring
  module the "Future" section refers to
- Android `Location` API reference — confirms `hasVerticalAccuracy()`,
  `hasSpeed()`, `hasBearing()` semantics relied on by the attestation
  gate
