package app.scrollantir.net

import android.content.Context

/**
 * Process-wide holder for the `device` value stamped onto every outgoing
 * event. Sourced from SecurePrefs (written by the QR onboarding flow) and
 * cached in memory so Emit doesn't need a Context on every call.
 *
 * Default is "phone" — the historical hardcoded value — so installs that
 * pre-date QR onboarding keep emitting the same device until a fresh QR
 * scan overwrites it.
 */
object DeviceId {
    private const val DEFAULT = "phone"

    @Volatile private var cached: String = DEFAULT

    /** Prime the cache from persisted prefs. Safe to call repeatedly. */
    fun prime(context: Context) {
        val stored = SecurePrefs.get(context)
            .getString(SecurePrefs.KEY_DEVICE_ID, null)
            ?.takeIf { it.isNotBlank() }
        cached = stored ?: DEFAULT
    }

    fun current(): String = cached

    /** Called when the onboarding flow writes a fresh device_id to prefs. */
    fun set(value: String) {
        cached = value.takeIf { it.isNotBlank() } ?: DEFAULT
    }
}
