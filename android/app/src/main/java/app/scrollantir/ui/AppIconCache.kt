package app.scrollantir.ui

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Resolves app icons and labels by package name, cached in memory.
 *
 * Missing icon → null (we render a placeholder). Missing label falls back
 * to a humanized version of the package name (last segment, title-cased).
 */
object AppIconCache {
    private data class Entry(val icon: ImageBitmap?, val label: String)

    private val cache: MutableMap<String, Entry> = mutableMapOf()

    private fun resolve(context: Context, pkg: String): Entry {
        cache[pkg]?.let { return it }

        val pm = context.packageManager
        val icon: ImageBitmap? = try {
            val drawable = pm.getApplicationIcon(pkg)
            val w = drawable.intrinsicWidth.coerceAtLeast(48)
            val h = drawable.intrinsicHeight.coerceAtLeast(48)
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bmp)
            drawable.setBounds(0, 0, canvas.width, canvas.height)
            drawable.draw(canvas)
            bmp.asImageBitmap()
        } catch (_: PackageManager.NameNotFoundException) {
            null
        } catch (_: Throwable) {
            null
        }

        val label: String = try {
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        } catch (_: Throwable) {
            humanizePackage(pkg)
        }

        val entry = Entry(icon, label)
        cache[pkg] = entry
        return entry
    }

    private fun humanizePackage(pkg: String): String {
        val last = pkg.substringAfterLast('.')
        return last.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
    }

    /**
     * Compose helper. Returns (icon, label) pair. Resolves off-main the
     * first time a package is seen; subsequent reads are instant.
     */
    @Composable
    fun rememberAppInfo(pkg: String): Pair<ImageBitmap?, String> {
        val context = LocalContext.current
        var state by remember(pkg) {
            val cached = cache[pkg]
            mutableStateOf(cached?.let { it.icon to it.label } ?: (null to humanizePackage(pkg)))
        }
        LaunchedEffect(pkg) {
            if (cache[pkg] == null) {
                val resolved = withContext(Dispatchers.IO) { resolve(context, pkg) }
                state = resolved.icon to resolved.label
            }
        }
        return state
    }
}
