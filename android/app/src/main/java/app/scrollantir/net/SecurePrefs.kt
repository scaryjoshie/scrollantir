package app.scrollantir.net

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Wraps EncryptedSharedPreferences for storing the ingest token and server URL.
 *
 * Tokens and URLs are not wildly sensitive for a sideloaded personal app, but
 * there's no good reason to store a bearer token in plaintext.
 */
object SecurePrefs {
    private const val FILE_NAME = "scrollantir_secure"

    const val KEY_SERVER_URL = "server_url"
    const val KEY_TOKEN = "token"
    const val KEY_LAST_SYNC_AT = "last_sync_at"
    const val KEY_LAST_SYNC_RESULT = "last_sync_result"
    const val KEY_LAST_SYNC_COUNT = "last_sync_count"

    @Volatile private var instance: SharedPreferences? = null

    fun get(context: Context): SharedPreferences {
        return instance ?: synchronized(this) {
            instance ?: build(context.applicationContext).also { instance = it }
        }
    }

    private fun build(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
}
