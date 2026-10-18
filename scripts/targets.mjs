/* ═══════════════════════════════════════════════════
   Build targets — one definition shared by build and checks.

   The repository root is the Chromium (Blink) source of truth:
   manifest.json + popup.html + options.html + assets/ + _locales/.
   Every other target is a declared transform of that source, so a target can
   never silently drift from what Chrome and Edge ship.
   ═══════════════════════════════════════════════════ */

export const GECKO_STRICT_MIN_VERSION = '121.0';

/* AMO rejects an MV3 package without a declared add-on id, so a default is
   always built in. Publish with --gecko-id= / GECKO_ADDON_ID set to the id of
   the real listing before uploading, otherwise the id cannot be changed later. */
export const DEFAULT_GECKO_ADDON_ID = 'mezdia-proxy-switcher@mezdia2.github.io';

const SHARED_ROOT_FILES = ['manifest.json', 'popup.html', 'options.html'];
const SHARED_DIRS = ['assets/css', 'assets/images', 'assets/js', '_locales'];

const blinkTarget = (id, label) => ({
    id,
    label,
    engine: 'blink',
    artifact: 'zip',
    rootFiles: SHARED_ROOT_FILES,
    dirs: SHARED_DIRS,
    manifest(manifest) {
        return manifest;
    },
});

/* Measured on Firefox 158: tab.url and tab.title stay hidden unless the "tabs"
   permission is granted, even with <all_urls> host permissions, and the group
   scope needs those URLs to build its allow list. */
const GECKO_EXTRA_PERMISSIONS = ['tabs'];

export const TARGETS = {
    chrome: blinkTarget('chrome', 'Google Chrome'),
    edge: blinkTarget('edge', 'Microsoft Edge'),

    firefox: {
        id: 'firefox',
        label: 'Mozilla Firefox',
        engine: 'gecko',
        artifact: 'xpi',
        rootFiles: SHARED_ROOT_FILES,
        dirs: SHARED_DIRS,
        manifest(manifest, {geckoAddonId = DEFAULT_GECKO_ADDON_ID} = {}) {
            const out = structuredClone(manifest);
            const id = geckoAddonId || DEFAULT_GECKO_ADDON_ID;

            // Gecko ignores background.service_worker and runs background.scripts.
            out.background = {scripts: [manifest.background.service_worker]};

            // Gecko has no tabGroups API; the extension degrades to grouping by id.
            const permissions = (manifest.permissions || []).filter(p => p !== 'tabGroups');
            out.permissions = [...permissions, ...GECKO_EXTRA_PERMISSIONS.filter(p => !permissions.includes(p))];

            out.browser_specific_settings = {
                gecko: {
                    id,
                    strict_min_version: GECKO_STRICT_MIN_VERSION,
                },
            };

            return out;
        },
    },
};

export const TARGET_IDS = Object.keys(TARGETS);
