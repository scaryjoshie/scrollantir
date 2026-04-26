// App-name normalization. Lives in the central server module so all
// summaries, tooltips, and (eventually) agent-side reports agree.

// Apps to exclude entirely from "active time on Mac" attribution.
// These fire as system.window while the user is not really *using* the Mac —
// they're lock screens, auth prompts, or transient system overlays.
export const EXCLUDED_MAC_APPS = new Set<string>([
  'loginwindow',                     // lock screen
  'SecurityAgent',                   // sudo / auth prompt overlay
  'coreautha',                       // Touch ID / password authentication
  'CoreServicesUIAgent',             // system auth dialogs
  'Passwords Extension Helper (Zen)', // browser password autofill prompt
]);

// Android package → display name for common apps we care about.
// Keep this small + boring. Fall back to a derived last-segment name if
// we don't recognize the package.
const PACKAGE_NAMES: Record<string, string> = {
  'app.revanced.android.youtube': 'YouTube',
  'com.google.android.youtube': 'YouTube',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.instagram.android': 'Instagram',
  'com.zhiliaoapp.musically': 'TikTok',
  'com.ss.android.ugc.trill': 'TikTok',
  'com.discord': 'Discord',
  'com.reddit.frontpage': 'Reddit',
  'com.google.android.apps.messaging': 'Messages',
  'com.google.android.apps.nexuslauncher': 'Pixel launcher',
  'com.google.android.googlequicksearchbox': 'Google',
  'com.android.chrome': 'Chrome',
  'com.android.vending': 'Play Store',
  'com.android.settings': 'Settings (Android)',
  'com.google.android.gm': 'Gmail',
  'com.spotify.music': 'Spotify',
  'com.whatsapp': 'WhatsApp',
  'com.instructure.candroid': 'Canvas',
  'com.google.android.dialer': 'Phone',
  'com.google.android.contacts': 'Contacts',
  'com.google.android.calendar': 'Calendar',
  'com.google.android.apps.maps': 'Maps',
  'com.google.android.apps.photos': 'Photos',
  'com.google.android.apps.docs': 'Drive',
  'com.google.android.keep': 'Keep',
  'app.scrollantir': 'Scrollantir',
};

export function labelForApp(device: 'mac' | 'phone', rawApp: string): string {
  if (device === 'phone') {
    const mapped = PACKAGE_NAMES[rawApp];
    if (mapped) return mapped;
    return prettyAndroidPackage(rawApp);
  }
  return rawApp;
}

function prettyAndroidPackage(pkg: string): string {
  // Reasonable fallback: last segment, title-cased a bit.
  const last = pkg.split('.').pop() ?? pkg;
  if (last.length <= 2) return pkg;
  return last.charAt(0).toUpperCase() + last.slice(1);
}
