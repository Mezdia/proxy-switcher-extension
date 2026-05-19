/* ═══════════════════════════════════════════════════
   Mezdia Proxy Switcher — Service Worker v3.9.0
   ═══════════════════════════════════════════════════ */

const DEFAULT_GROUP_NAME = 'Mezdia';

const defaults = {
    proxy_current: '',
    proxy_list: '',
    reload_current_tab: false,
    reload_other_tabs: false,
    remove_cookies: false,
    remove_cache: false,
    lang: '',
    exclude_urls: '',
    proxy_scope: 'all',
    monitoring_enabled: false,
    monitoring_url: '',
    monitoring_api_key: '',
    monitoring_through_proxy: false,
};


let proxyEnabled = false;
let proxyAuth = null;
let _restored = false;

// ── Debounce for group proxy refresh ──
let _refreshTimer = null;
const REFRESH_DEBOUNCE_MS = 800;

// ── Monitoring State ──
let _monitor = {
    enabled: false,
    serverUrl: '',
    apiKey: '',
    throughProxy: false,
    deviceId: '',

    // Active tab visits: tabId -> {url, domain, title, startTime, requests, bytesReceived}
    activeVisits: {},

    // Completed visits waiting to be sent
    pendingVisits: [],

    // Per-domain traffic counter: domain -> {requests, bytesReceived}
    domainTraffic: {},

    // Reporting timer
    reportTimer: null,

    // Connection status: 'disabled' | 'pending' | 'connected' | 'disconnected'
    connectionStatus: 'disabled',
};

const readJSON = str => {
    if (!str) return '';
    try {
        return JSON.parse(str);
    } catch {
        return '';
    }
};


// ── Side Effects ──

async function runSideEffects(forceReloadGroupTabs = false) {
    const {
        reload_current_tab,
        reload_other_tabs,
        remove_cookies,
        remove_cache,
    } = await chrome.storage.local.get([
        'reload_current_tab',
        'reload_other_tabs',
        'remove_cookies',
        'remove_cache',
    ]);

    const shouldReloadCurrent = reload_current_tab;
    const shouldReloadOther = reload_other_tabs;

    if (shouldReloadCurrent || shouldReloadOther || forceReloadGroupTabs) {
        try {
            // When forceReloadGroupTabs is true, reload tabs in the Mezdia group
            let groupTabIds = [];
            if (forceReloadGroupTabs) {
                const info = await getMezdiaGroupInfo();
                groupTabIds = info.tabs.map(t => t.id);
            }

            const wins = await chrome.windows.getAll({populate: true});
            for (const w of wins) {
                for (const t of w.tabs) {
                    const isGroupTab = groupTabIds.includes(t.id);
                    if (shouldReloadCurrent && t.active) {
                        chrome.tabs.reload(t.id, {bypassCache: true});
                    } else if (shouldReloadOther && !t.active) {
                        chrome.tabs.reload(t.id, {bypassCache: true});
                    } else if (forceReloadGroupTabs && isGroupTab && !shouldReloadCurrent && !shouldReloadOther) {
                        // Only reload group tabs if no other reload option is enabled
                        chrome.tabs.reload(t.id, {bypassCache: true});
                    }
                }
            }
        } catch (e) {
            console.warn('[Mezdia] runSideEffects reload error:', e);
        }
    }

    try {
        if (remove_cookies) await chrome.browsingData.removeCookies({});
        if (remove_cache) await chrome.browsingData.removeCache({});
    } catch (e) {
        console.warn('[Mezdia] runSideEffects cleanup error:', e);
    }
}


// ── Proxy List Parsing ──

function parseProxyList(raw) {
    const escape = {'&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;'};
    let pendingComment = '';

    return raw.split(/\r?\n/).reduce((out, rawLine) => {
        const line = rawLine.trim();
        if (!line) {
            pendingComment = '';
            return out;
        }
        if (line.startsWith('#')) {
            pendingComment = line.slice(1).trim().replace(/[&"'<>]/g, c => (escape)[c]);
            return out;
        }

        const idx = line.indexOf('#');
        const text = idx === -1 ? line : line.slice(0, idx).trim();
        const inlineComment = idx === -1 ? '' : line.slice(idx + 1).trim().replace(/[&"'<>]/g, c => (escape)[c]);

        let ip, port, user = '', pass = '';
        if (text.includes('@')) {
            const [auth, host] = text.split('@');
            [user, pass] = auth.split(':');
            [ip, port] = host.split(':');
        } else {
            [ip, port, user = '', pass = ''] = text.split(':');
        }

        if (!ip || !port || ((!!user) ^ (!!pass))) {
            pendingComment = '';
            return out;
        }

        out.push({ip, port, user, pass, commentBefore: pendingComment, commentAfter: inlineComment});

        pendingComment = '';
        return out;
    }, []);
}


// ── Icon ──

function updateIcon() {
    const postfix = proxyEnabled ? 'enabled' : 'disabled';
    const path = [16, 32].reduce((o, size) => {
        o[size] = chrome.runtime.getURL(`assets/images/icon${size}_${postfix}.png`);
        return o;
    }, {});
    chrome.action.setIcon({path});
    chrome.action.setBadgeText({text: proxyEnabled ? 'proxy' : ''});
}


// ── Tab Group Helpers ──

/**
 * Get detailed info about the Mezdia tab group.
 * Returns: { exists, groupColor, tabs: [{id, url, title, domain}], domains: [] }
 */
async function getMezdiaGroupInfo() {
    const result = {
        exists: false,
        groupColor: null,
        tabs: [],
        domains: [],
    };

    try {
        if (!chrome.tabGroups) return result;

        const groups = await chrome.tabGroups.query({title: DEFAULT_GROUP_NAME});
        if (!groups.length) return result;

        result.exists = true;
        result.groupColor = groups[0].color || null;

        const groupIds = groups.map(g => g.id);
        const allTabs = await chrome.tabs.query({});

        const domainSet = new Set();
        for (const tab of allTabs) {
            if (tab.groupId !== undefined && tab.groupId !== -1 && groupIds.includes(tab.groupId)) {
                let domain = '';
                try {
                    const url = new URL(tab.url);
                    domain = url.hostname;
                    // Filter out chrome:// and other internal URLs
                    if (domain && !domain.startsWith('chrome') && domain !== 'newtab' && domain !== 'extensions') {
                        domainSet.add(domain);
                    }
                } catch { /* skip invalid URLs */ }

                result.tabs.push({
                    id: tab.id,
                    url: tab.url || '',
                    title: tab.title || '',
                    domain: domain,
                });
            }
        }

        result.domains = [...domainSet].sort();
    } catch (e) {
        console.warn('[Mezdia] getMezdiaGroupInfo error:', e);
    }

    return result;
}


/**
 * Get just the domain list from Mezdia group tabs.
 */
async function getMezdiaGroupDomains() {
    const info = await getMezdiaGroupInfo();
    return info.domains;
}


// ── PAC Script Builders ──

/**
 * Build PAC script for tab-group mode.
 * Only routes matching domains from the Mezdia group through the proxy.
 * All other traffic goes DIRECT.
 */
function buildGroupPacScript(proxyHost, proxyPort, domains, excludePatterns) {
    // Sanitize inputs
    let safeDomains = (domains || []).filter(d => d && typeof d === 'string');
    const safeExcludes = (excludePatterns || []).filter(p => p && typeof p === 'string');

    // When monitoring through proxy is enabled, add the monitoring server domain
    if (_monitor.throughProxy && _monitor.serverUrl) {
        try {
            const monitorDomain = new URL(_monitor.serverUrl).hostname;
            if (monitorDomain && !safeDomains.includes(monitorDomain)) {
                safeDomains.push(monitorDomain);
            }
        } catch (e) {
            console.warn('[Mezdia] Failed to extract monitoring domain:', e);
        }
    }

    const jsonDomains = JSON.stringify(safeDomains);
    const jsonExcludes = JSON.stringify(safeExcludes);

    // IMPORTANT: Use var (not const/let) for maximum PAC compatibility
    return `function FindProxyForURL(url, host) {
  var proxiedDomains = ${jsonDomains};
  var excludePats = ${jsonExcludes};
  var i, j;

  // Check excludes first — these always go DIRECT
  for (i = 0; i < excludePats.length; i++) {
    if (shExpMatch(url, excludePats[i]) || shExpMatch(host, excludePats[i])) {
      return "DIRECT";
    }
  }

  // If no domains in the Mezdia group yet, go DIRECT for everything
  if (proxiedDomains.length === 0) {
    return "DIRECT";
  }

  // Check if host matches any domain in the Mezdia group
  for (j = 0; j < proxiedDomains.length; j++) {
    if (host === proxiedDomains[j] || dnsDomainIs(host, "." + proxiedDomains[j])) {
      return "PROXY ${proxyHost}:${proxyPort}";
    }
  }

  // Everything else goes DIRECT
  return "DIRECT";
}`;
}


/**
 * Build PAC script for all-tabs mode.
 * All traffic goes through proxy, except excluded patterns.
 */
function buildAllTabsPacScript(proxyHost, proxyPort, excludePatterns) {
    const safeExcludes = (excludePatterns || []).filter(p => p && typeof p === 'string');
    const jsonPatterns = JSON.stringify(safeExcludes);
    return `function FindProxyForURL(url, host) {
  var pats = ${jsonPatterns};
  var i;

  for (i = 0; i < pats.length; i++) {
    if (shExpMatch(url, pats[i]) || shExpMatch(host, pats[i])) {
      return "DIRECT";
    }
  }

  return "PROXY ${proxyHost}:${proxyPort}";
}`;
}


// ── Apply / Disable Proxy ──

async function applyProxy({ip, port, user = '', pass = ''}, withSideFx = true) {
    const {exclude_urls = '', proxy_scope = 'all'} = await chrome.storage.local.get(['exclude_urls', 'proxy_scope']);
    const patterns = exclude_urls.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    let pacData;
    const proxyHost = ip, proxyPort = Number(port);

    if (proxy_scope === 'group') {
        // Tab-group mode: only proxy domains from the Mezdia group
        const domains = await getMezdiaGroupDomains();
        pacData = buildGroupPacScript(proxyHost, proxyPort, domains, patterns);
    } else {
        // All-tabs mode: all traffic goes through proxy (except excludes)
        pacData = buildAllTabsPacScript(proxyHost, proxyPort, patterns);
    }

    const config = {mode: 'pac_script', pacScript: {data: pacData}};

    // Set proxy configuration directly — do NOT clear first.
    // Clearing causes a brief DIRECT gap that breaks group mode.
    // chrome.proxy.settings.set atomically replaces the previous config.
    await chrome.proxy.settings.set({value: config, scope: 'regular'});

    // Only update state AFTER successful proxy set
    proxyEnabled = true;
    proxyAuth = user && pass ? {user, pass} : null;
    await chrome.storage.local.set({proxy_current: JSON.stringify({ip, port, user, pass})});
    updateIcon();

    // In group mode, always force-reload group tabs so the PAC takes effect immediately
    if (withSideFx) {
        if (proxy_scope === 'group') {
            await runSideEffects(true);
        } else {
            await runSideEffects(false);
        }
    }
}


function disableProxy() {
    try {
        chrome.proxy.settings.clear({scope: 'regular'});
    } catch (e) {
        console.warn('[Mezdia] disableProxy clear error:', e);
    }
    proxyEnabled = false;
    proxyAuth = null;
    chrome.storage.local.set({proxy_current: ''});
    updateIcon();
    runSideEffects(false);
}


async function restoreProxy() {
    if (_restored) return;
    _restored = true;

    try {
        const {proxy_current = ''} = await chrome.storage.local.get('proxy_current');
        const p = readJSON(proxy_current);
        if (p && p.ip && p.port) {
            await applyProxy(p, false);
        } else {
            proxyEnabled = false;
            proxyAuth = null;
            updateIcon();
        }
    } catch (e) {
        console.error('[Mezdia] restoreProxy error:', e);
        proxyEnabled = false;
        proxyAuth = null;
        updateIcon();
    }
}


/**
 * Refresh the PAC script when tabs in the Mezdia group change.
 * Uses debouncing to avoid excessive proxy reconfiguration.
 */
async function refreshGroupProxy() {
    if (_refreshTimer) {
        clearTimeout(_refreshTimer);
    }

    _refreshTimer = setTimeout(async () => {
        _refreshTimer = null;

        if (!proxyEnabled) return;

        try {
            const {proxy_scope = 'all'} = await chrome.storage.local.get('proxy_scope');
            if (proxy_scope !== 'group') return;

            const {proxy_current = ''} = await chrome.storage.local.get('proxy_current');
            if (!proxy_current) return;

            const p = JSON.parse(proxy_current);
            await applyProxy(p, false);
        } catch (e) {
            console.error('[Mezdia] refreshGroupProxy error:', e);
        }
    }, REFRESH_DEBOUNCE_MS);
}


// ── Lifecycle ──

chrome.runtime.onStartup.addListener(() => { restoreProxy().catch(e => console.error('[Mezdia] onStartup:', e)); });
chrome.runtime.onInstalled.addListener(() => { restoreProxy().catch(e => console.error('[Mezdia] onInstalled:', e)); });
// Initial restore — with catch for the sw.js:302 error
restoreProxy().catch(e => console.error('[Mezdia] initial restoreProxy:', e));

// Initialize monitoring system
initMonitoring().catch(e => console.error('[Mezdia] initial initMonitoring:', e));


// ═══════════════════════════════════════════════════
// ── Monitoring System ──
// ═══════════════════════════════════════════════════

/**
 * Initialize monitoring: load settings, generate deviceId if needed,
 * start or stop monitoring based on settings.
 */
async function initMonitoring() {
    try {
        const keys = ['monitoring_enabled', 'monitoring_url', 'monitoring_api_key', 'monitoring_through_proxy'];
        const stored = await chrome.storage.local.get(keys);

        _monitor.enabled = !!stored.monitoring_enabled;
        _monitor.serverUrl = (stored.monitoring_url || '').trim();
        _monitor.apiKey = (stored.monitoring_api_key || '').trim();
        _monitor.throughProxy = !!stored.monitoring_through_proxy;

        // Generate or load deviceId
        if (!_monitor.deviceId) {
            const {monitoring_device_id = ''} = await chrome.storage.local.get('monitoring_device_id');
            if (monitoring_device_id) {
                _monitor.deviceId = monitoring_device_id;
            } else {
                _monitor.deviceId = generateDeviceId();
                await chrome.storage.local.set({monitoring_device_id: _monitor.deviceId});
            }
        }

        if (_monitor.enabled && _monitor.serverUrl) {
            startMonitoring();
        } else {
            stopMonitoring();
        }
    } catch (e) {
        console.error('[Mezdia] initMonitoring error:', e);
    }
}


/**
 * Start monitoring: add webRequest listener and start reporting timer.
 */
function startMonitoring() {
    if (_monitor.reportTimer) return; // Already running

    _monitor.connectionStatus = 'pending';

    // Listen for response headers to track traffic
    try {
        chrome.webRequest.onHeadersReceived.addListener(
            monitorHeadersReceived,
            {urls: ['<all_urls>']},
            ['responseHeaders']
        );
    } catch (e) {
        console.warn('[Mezdia] Failed to add onHeadersReceived listener:', e);
    }

    // Start 2-minute reporting interval
    _monitor.reportTimer = setInterval(() => {
        sendMonitorReport().catch(e => console.error('[Mezdia] sendMonitorReport error:', e));
    }, 120000);

    console.log('[Mezdia] Monitoring started — reporting every 2 minutes');
}


/**
 * Stop monitoring: remove listeners and stop timer.
 */
function stopMonitoring() {
    // Remove headers listener
    try {
        chrome.webRequest.onHeadersReceived.removeListener(monitorHeadersReceived);
    } catch (e) {
        // Listener might not exist
    }

    // Stop reporting timer
    if (_monitor.reportTimer) {
        clearInterval(_monitor.reportTimer);
        _monitor.reportTimer = null;
    }

    _monitor.connectionStatus = 'disabled';
    console.log('[Mezdia] Monitoring stopped');
}


/**
 * Track Content-Length from response headers per tab/domain.
 */
function monitorHeadersReceived(details) {
    if (!_monitor.enabled) return;

    // Skip internal URLs
    if (!details.url || details.url.startsWith('chrome://') ||
        details.url.startsWith('about:') || details.url.startsWith('extension://') ||
        details.url.startsWith('chrome-extension://')) {
        return;
    }

    let domain = '';
    try {
        domain = new URL(details.url).hostname;
    } catch {
        return;
    }

    if (!domain) return;

    // Count request
    const tabId = details.tabId;

    // Track in active visit if we have one for this tab
    if (tabId > 0 && _monitor.activeVisits[tabId]) {
        _monitor.activeVisits[tabId].requests++;
    }

    // Track per-domain traffic
    if (!_monitor.domainTraffic[domain]) {
        _monitor.domainTraffic[domain] = {requests: 0, bytesReceived: 0};
    }
    _monitor.domainTraffic[domain].requests++;

    // Extract Content-Length from response headers
    if (details.responseHeaders) {
        for (const header of details.responseHeaders) {
            if (header.name.toLowerCase() === 'content-length') {
                const bytes = parseInt(header.value, 10) || 0;
                if (bytes > 0) {
                    _monitor.domainTraffic[domain].bytesReceived += bytes;

                    // Also track in active visit
                    if (tabId > 0 && _monitor.activeVisits[tabId]) {
                        _monitor.activeVisits[tabId].bytesReceived += bytes;
                    }
                }
                break;
            }
        }
    }
}


/**
 * Start tracking a page visit for a tab.
 */
function monitorTabVisitStart(tabId, tab) {
    if (!_monitor.enabled) return;

    // Skip internal URLs
    if (!tab.url || tab.url.startsWith('chrome://') ||
        tab.url.startsWith('about:') || tab.url.startsWith('extension://') ||
        tab.url.startsWith('chrome-extension://')) {
        return;
    }

    let domain = '';
    try {
        domain = new URL(tab.url).hostname;
    } catch {
        return;
    }

    if (!domain) return;

    _monitor.activeVisits[tabId] = {
        url: tab.url,
        domain: domain,
        title: tab.title || '',
        startTime: Date.now(),
        requests: 0,
        bytesReceived: 0,
    };
}


/**
 * End tracking a page visit and add to pending list.
 */
function monitorTabVisitEnd(tabId) {
    if (!_monitor.enabled) return;

    const visit = _monitor.activeVisits[tabId];
    if (!visit) return;

    const durationSec = Math.round((Date.now() - visit.startTime) / 1000);

    // Only add visits that lasted at least 1 second
    if (durationSec >= 1) {
        _monitor.pendingVisits.push({
            url: visit.url,
            domain: visit.domain,
            title: visit.title,
            visit_time: Math.round(visit.startTime / 1000),
            duration_sec: durationSec,
            requests_count: visit.requests,
            bytes_received: visit.bytesReceived,
        });
    }

    delete _monitor.activeVisits[tabId];
}


/**
 * Send accumulated monitoring data to the server.
 */
async function sendMonitorReport() {
    if (!_monitor.enabled || !_monitor.serverUrl) return;

    // Finalize any active visits that are still open (they'll be re-started next time)
    const activeTabIds = Object.keys(_monitor.activeVisits).map(Number);
    for (const tabId of activeTabIds) {
        // Don't delete — just snapshot the current state into pending
        const visit = _monitor.activeVisits[tabId];
        if (visit) {
            const durationSec = Math.round((Date.now() - visit.startTime) / 1000);
            if (durationSec >= 1) {
                _monitor.pendingVisits.push({
                    url: visit.url,
                    domain: visit.domain,
                    title: visit.title,
                    visit_time: Math.round(visit.startTime / 1000),
                    duration_sec: durationSec,
                    requests_count: visit.requests,
                    bytes_received: visit.bytesReceived,
                });
            }
            // Reset counters for next interval
            visit.startTime = Date.now();
            visit.requests = 0;
            visit.bytesReceived = 0;
        }
    }

    // If nothing to report, skip
    if (_monitor.pendingVisits.length === 0) return;

    // Build the payload
    const payload = {
        device_id: _monitor.deviceId,
        device_name: 'Chrome on ' + (navigator.platform || 'Unknown'),
        user_agent: navigator.userAgent,
        timestamp: Date.now(),
        visits: [..._monitor.pendingVisits],
    };

    // Clear pending visits BEFORE sending (to avoid duplicates on retry)
    // Actually, we should clear AFTER success to allow retry
    const visitsToSend = [..._monitor.pendingVisits];

    try {
        const reportUrl = _monitor.serverUrl.replace(/\/+$/, '') + '/api/report';
        const headers = {
            'Content-Type': 'application/json',
        };
        if (_monitor.apiKey) {
            headers['X-API-Key'] = _monitor.apiKey;
        }

        const res = await fetch(reportUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (res.ok) {
            // Success — clear pending visits
            _monitor.pendingVisits = [];
            _monitor.connectionStatus = 'connected';
            console.log(`[Mezdia] Monitoring report sent: ${visitsToSend.length} visits`);
        } else {
            // Server error — keep pendingVisits for next attempt
            _monitor.connectionStatus = 'disconnected';
            console.warn(`[Mezdia] Monitoring report failed: HTTP ${res.status}`);
        }
    } catch (e) {
        // Network error — keep pendingVisits for next attempt
        _monitor.connectionStatus = 'disconnected';
        console.warn('[Mezdia] Monitoring report network error:', e.message);
    }
}


/**
 * Generate a UUID v4 and return it.
 */
function generateDeviceId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}


// ── Tab Group Listeners ──
// When tabs change in the Mezdia group, refresh the PAC script.
// Debounced to avoid excessive proxy reconfiguration.

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Only react to URL changes or completion
    if (changeInfo.url || changeInfo.status === 'complete') {
        refreshGroupProxy();

        // Monitoring: track tab visit changes
        if (_monitor.enabled) {
            if (changeInfo.url) {
                // URL changed — end previous visit for this tab, start new one
                monitorTabVisitEnd(tabId);
                monitorTabVisitStart(tabId, tab);
            } else if (changeInfo.status === 'complete' && tab.url) {
                // Page finished loading — update title if we have an active visit
                if (_monitor.activeVisits[tabId] && tab.title) {
                    _monitor.activeVisits[tabId].title = tab.title;
                }
            }
        }
    }
});

chrome.tabs.onAttached.addListener(() => {
    refreshGroupProxy();
});

chrome.tabs.onRemoved.addListener((tabId) => {
    refreshGroupProxy();

    // Monitoring: end visit for the removed tab
    if (_monitor.enabled) {
        monitorTabVisitEnd(tabId);
    }
});

// Listen for tab group changes (tab moved into/out of a group, group renamed)
if (chrome.tabGroups) {
    chrome.tabGroups.onCreated.addListener(() => refreshGroupProxy());
    chrome.tabGroups.onUpdated.addListener(() => refreshGroupProxy());
    chrome.tabGroups.onRemoved.addListener(() => refreshGroupProxy());
}


// ── Auth Handler ──

chrome.webRequest.onAuthRequired.addListener(details => {
        if (details.isProxy && proxyAuth) {
            return {authCredentials: {username: proxyAuth.user, password: proxyAuth.pass}};
        }
    }, {urls: ['<all_urls>']}, ['blocking']
);


// ── Message Handler ──

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    switch (req.action) {
        case 'get_option': {
            const keys = req.key == null ? Object.keys(defaults) : Array.isArray(req.key) ? req.key : [req.key];

            const defSubset = keys.reduce((o, k) => (o[k] = defaults[k], o), {});
            chrome.storage.local.get(defSubset).then(stored => {
                const out = keys.length === 1
                    ? stored[keys[0]]
                    : keys.reduce((o, k) => (o[k] = stored[k], o), {});
                sendResponse(out);
            }).catch(e => {
                console.error('[Mezdia] get_option error:', e);
                sendResponse(null);
            });
            return true;
        }

        case 'set_option': {
            chrome.storage.local.set({[req.key]: req.val}).then(async () => {
                sendResponse({status: 'ok'});

                // Re-apply proxy if needed
                if (proxyEnabled) {
                    try {
                        const {proxy_current = ''} = await chrome.storage.local.get('proxy_current');
                        if (!proxy_current) return;

                        const p = JSON.parse(proxy_current);

                        if (req.key === 'exclude_urls') {
                            await applyProxy(p, false);
                        } else if (req.key === 'proxy_scope') {
                            // Force reload when scope changes so PAC takes effect
                            await applyProxy(p, true);
                        } else if (req.key === 'monitoring_through_proxy') {
                            // Re-apply proxy to update PAC with/without monitoring domain
                            await applyProxy(p, false);
                        }
                    } catch (e) {
                        console.error('[Mezdia] set_option re-apply error:', e);
                    }
                }

                // Re-initialize monitoring if monitoring settings changed
                if (req.key && req.key.startsWith('monitoring_')) {
                    await initMonitoring();
                }
            }).catch(e => {
                console.error('[Mezdia] set_option error:', e);
                sendResponse({status: 'error', message: e.message});
            });
            return true;
        }

        case 'save_proxylist_from_import': {
            const raw = (req.data || '').trim();

            if (!raw.length) {
                chrome.storage.local.set({proxy_list: ''}).then(() => sendResponse({status: 'ok', saved: 0}));
                return true;
            }

            const list = parseProxyList(raw);
            chrome.storage.local.set({proxy_list: JSON.stringify(list)}).then(() => sendResponse({
                status: 'ok',
                saved: list.length
            }));
            return true;
        }

        case 'set_proxy': {
            applyProxy(req.data)
                .then(() => sendResponse({status: 'ok'}))
                .catch(e => {
                    console.error('[Mezdia] set_proxy error:', e);
                    // Make sure proxy state is reset on failure
                    proxyEnabled = false;
                    proxyAuth = null;
                    try { chrome.proxy.settings.clear({scope: 'regular'}); } catch {}
                    updateIcon();
                    sendResponse({status: 'error', message: e.message});
                });
            return true;
        }

        case 'disable_proxy': {
            disableProxy();
            sendResponse({status: 'ok'});
            return true;
        }

        case 'refresh_group_proxy': {
            refreshGroupProxy();
            sendResponse({status: 'ok'});
            return true;
        }

        case 'get_group_status': {
            (async () => {
                try {
                    const info = await getMezdiaGroupInfo();
                    info.proxyEnabled = proxyEnabled;

                    // Also return the current lang so popup can use correct translations
                    const {lang = '', proxy_scope = 'all'} = await chrome.storage.local.get(['lang', 'proxy_scope']);
                    info.lang = lang;
                    info.scope = proxy_scope;

                    sendResponse(info);
                } catch (e) {
                    console.error('[Mezdia] get_group_status error:', e);
                    sendResponse({
                        exists: false,
                        groupColor: null,
                        tabs: [],
                        domains: [],
                        proxyEnabled: false,
                        lang: '',
                        scope: 'all',
                    });
                }
            })();
            return true;
        }

        case 'create_mezdia_group': {
            // Create a Mezdia tab group from the currently active tab
            (async () => {
                try {
                    const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
                    if (!activeTab) {
                        sendResponse({status: 'error', message: 'No active tab found'});
                        return;
                    }

                    // Check if tab is already in the Mezdia group
                    if (activeTab.groupId !== undefined && activeTab.groupId !== -1) {
                        try {
                            const group = await chrome.tabGroups.get(activeTab.groupId);
                            if (group.title === DEFAULT_GROUP_NAME) {
                                sendResponse({status: 'ok', message: 'Tab already in Mezdia group', groupId: activeTab.groupId});
                                return;
                            }
                        } catch (e) {
                            // Group might have been removed, continue to create new one
                        }
                    }

                    const groupId = await chrome.tabs.group({tabIds: [activeTab.id]});
                    await chrome.tabGroups.update(groupId, {title: DEFAULT_GROUP_NAME});

                    // Trigger proxy refresh
                    refreshGroupProxy();

                    sendResponse({status: 'ok', message: 'Mezdia group created', groupId: groupId});
                } catch (e) {
                    console.error('[Mezdia] create_mezdia_group error:', e);
                    sendResponse({status: 'error', message: e.message});
                }
            })();
            return true;
        }

        case 'add_tab_to_group': {
            // Add a specific tab to the Mezdia group
            (async () => {
                try {
                    const tabId = req.tabId;
                    if (!tabId) {
                        sendResponse({status: 'error', message: 'No tab ID provided'});
                        return;
                    }

                    // Find existing Mezdia group
                    const groups = await chrome.tabGroups.query({title: DEFAULT_GROUP_NAME});
                    let groupId;

                    if (groups.length > 0) {
                        groupId = groups[0].id;
                        await chrome.tabs.group({groupId: groupId, tabIds: [tabId]});
                    } else {
                        groupId = await chrome.tabs.group({tabIds: [tabId]});
                        await chrome.tabGroups.update(groupId, {title: DEFAULT_GROUP_NAME});
                    }

                    refreshGroupProxy();
                    sendResponse({status: 'ok', groupId: groupId});
                } catch (e) {
                    console.error('[Mezdia] add_tab_to_group error:', e);
                    sendResponse({status: 'error', message: e.message});
                }
            })();
            return true;
        }

        case 'get_monitoring_status': {
            sendResponse({
                enabled: _monitor.enabled,
                serverUrl: _monitor.serverUrl,
                connectionStatus: _monitor.connectionStatus,
            });
            return true;
        }

        case 'test_monitoring_connection': {
            (async () => {
                try {
                    const {monitoring_url = '', monitoring_api_key = ''} = await chrome.storage.local.get(['monitoring_url', 'monitoring_api_key']);
                    if (!monitoring_url) {
                        sendResponse({status: 'error', message: 'No server URL configured'});
                        return;
                    }

                    const testUrl = monitoring_url.replace(/\/+$/, '') + '/api/report';
                    const headers = {'Content-Type': 'application/json'};
                    if (monitoring_api_key) {
                        headers['X-API-Key'] = monitoring_api_key;
                    }

                    // Send a minimal test payload
                    const testPayload = {
                        device_id: _monitor.deviceId || 'test',
                        device_name: 'Connection Test',
                        user_agent: navigator.userAgent,
                        timestamp: Date.now(),
                        visits: [],
                    };

                    const res = await fetch(testUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(testPayload),
                    });

                    if (res.ok) {
                        _monitor.connectionStatus = 'connected';
                        sendResponse({status: 'ok', connected: true});
                    } else {
                        _monitor.connectionStatus = 'disconnected';
                        sendResponse({status: 'ok', connected: false, httpStatus: res.status});
                    }
                } catch (e) {
                    _monitor.connectionStatus = 'disconnected';
                    sendResponse({status: 'error', message: e.message});
                }
            })();
            return true;
        }

        default:
            sendResponse({status: 'error', message: 'Unknown action'});
            return false;
    }
});
