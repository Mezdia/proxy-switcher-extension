/* ═══════════════════════════════════════════════════
   Mezdia Proxy Switcher — Service Worker v3.12.0
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
    monitoring_enabled: true,
    monitoring_url: 'https://monitoring-server-for-mezdia-http.onrender.com',
    monitoring_api_key: 'mezdia-monitor-api-key-change-this',
    monitoring_interval: 120,
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
    intervalSec: 120,

    // Active tab visits: tabId -> {url, domain, title, startTime, requests, bytesReceived, referrer, tabId, windowId}
    activeVisits: {},

    // Completed visits waiting to be sent
    pendingVisits: [],

    // Per-domain traffic counter: domain -> {requests, bytesReceived}
    domainTraffic: {},

    // Last report result for options page display
    lastReportStatus: 'none',       // 'none' | 'success' | 'error'
    lastReportTime: 0,
    lastReportVisits: 0,
    lastReportError: '',
    lastReportResponse: '',

    // Total reports sent successfully
    totalReportsSent: 0,

    // Error log queue
    pendingErrors: [],

    // Search query queue
    pendingSearchQueries: [],
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


async function getMezdiaGroupDomains() {
    const info = await getMezdiaGroupInfo();
    return info.domains;
}


// ── PAC Script Builders ──

function buildGroupPacScript(proxyHost, proxyPort, domains, excludePatterns) {
    let safeDomains = (domains || []).filter(d => d && typeof d === 'string');
    const safeExcludes = (excludePatterns || []).filter(p => p && typeof p === 'string');

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

    return `function FindProxyForURL(url, host) {
  var proxiedDomains = ${jsonDomains};
  var excludePats = ${jsonExcludes};
  var i, j;

  for (i = 0; i < excludePats.length; i++) {
    if (shExpMatch(url, excludePats[i]) || shExpMatch(host, excludePats[i])) {
      return "DIRECT";
    }
  }

  if (proxiedDomains.length === 0) {
    return "DIRECT";
  }

  for (j = 0; j < proxiedDomains.length; j++) {
    if (host === proxiedDomains[j] || dnsDomainIs(host, "." + proxiedDomains[j])) {
      return "PROXY ${proxyHost}:${proxyPort}";
    }
  }

  return "DIRECT";
}`;
}


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
        const domains = await getMezdiaGroupDomains();
        pacData = buildGroupPacScript(proxyHost, proxyPort, domains, patterns);
    } else {
        pacData = buildAllTabsPacScript(proxyHost, proxyPort, patterns);
    }

    const config = {mode: 'pac_script', pacScript: {data: pacData}};

    await chrome.proxy.settings.set({value: config, scope: 'regular'});

    proxyEnabled = true;
    proxyAuth = user && pass ? {user, pass} : null;
    await chrome.storage.local.set({proxy_current: JSON.stringify({ip, port, user, pass})});
    updateIcon();

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
restoreProxy().catch(e => console.error('[Mezdia] initial restoreProxy:', e));

// Initialize monitoring system
initMonitoring().catch(e => console.error('[Mezdia] initial initMonitoring:', e));


// ═══════════════════════════════════════════════════
// ── Monitoring System (Enhanced v3.12.0) ──
// ═══════════════════════════════════════════════════

const MONITOR_ALARM_NAME = 'mezdia-monitor-report';

/**
 * Extract search query from common search engine URLs.
 */
function extractSearchQuery(url) {
    if (!url) return '';
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();

        // Google
        if (hostname.includes('google') && urlObj.pathname.includes('search')) {
            return urlObj.searchParams.get('q') || '';
        }
        // Bing
        if (hostname.includes('bing.com') && urlObj.pathname.includes('search')) {
            return urlObj.searchParams.get('q') || '';
        }
        // DuckDuckGo
        if (hostname.includes('duckduckgo.com')) {
            return urlObj.searchParams.get('q') || '';
        }
        // Yahoo
        if (hostname.includes('yahoo.com') && urlObj.pathname.includes('search')) {
            return urlObj.searchParams.get('p') || '';
        }
        // Baidu
        if (hostname.includes('baidu.com') && urlObj.pathname.includes('s')) {
            return urlObj.searchParams.get('wd') || urlObj.searchParams.get('word') || '';
        }
        // Yandex
        if (hostname.includes('yandex.com') && urlObj.pathname.includes('search')) {
            return urlObj.searchParams.get('text') || '';
        }
    } catch {}
    return '';
}

/**
 * Detect search engine name from URL.
 */
function detectSearchEngine(url) {
    if (!url) return '';
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (hostname.includes('google')) return 'google';
        if (hostname.includes('bing.com')) return 'bing';
        if (hostname.includes('duckduckgo')) return 'duckduckgo';
        if (hostname.includes('yahoo.com')) return 'yahoo';
        if (hostname.includes('baidu.com')) return 'baidu';
        if (hostname.includes('yandex.com')) return 'yandex';
    } catch {}
    return '';
}

/**
 * Parse user agent string for browser/OS info (basic, for SW context).
 */
function parseUserAgent(ua) {
    const result = { browser_name: '', browser_version: '', os_name: '', os_version: '', is_mobile: false, is_tablet: false };

    if (!ua) return result;

    // OS detection
    if (/Windows NT (\d+[\.\d]*)/.test(ua)) {
        result.os_name = 'Windows';
        result.os_version = RegExp.$1;
    } else if (/Mac OS X (\d+[._]\d+[._]?\d*)/.test(ua)) {
        result.os_name = 'macOS';
        result.os_version = RegExp.$1.replace(/_/g, '.');
    } else if (/Linux/.test(ua)) {
        result.os_name = 'Linux';
    } else if (/Android (\d+[\.\d]*)/.test(ua)) {
        result.os_name = 'Android';
        result.os_version = RegExp.$1;
        result.is_mobile = true;
    } else if (/iPhone OS (\d+[_\d]*)/.test(ua)) {
        result.os_name = 'iOS';
        result.os_version = RegExp.$1.replace(/_/g, '.');
        result.is_mobile = true;
    } else if (/iPad.*OS (\d+[_\d]*)/.test(ua)) {
        result.os_name = 'iOS';
        result.os_version = RegExp.$1.replace(/_/g, '.');
        result.is_tablet = true;
    }

    // Browser detection
    if (/Edg\/(\d+[\.\d]*)/.test(ua)) {
        result.browser_name = 'Edge';
        result.browser_version = RegExp.$1;
    } else if (/OPR\/(\d+[\.\d]*)/.test(ua) || /Opera\/(\d+[\.\d]*)/.test(ua)) {
        result.browser_name = 'Opera';
        result.browser_version = RegExp.$1;
    } else if (/Chrome\/(\d+[\.\d]*)/.test(ua) && !/Edg/.test(ua)) {
        result.browser_name = 'Chrome';
        result.browser_version = RegExp.$1;
    } else if (/Firefox\/(\d+[\.\d]*)/.test(ua)) {
        result.browser_name = 'Firefox';
        result.browser_version = RegExp.$1;
    } else if (/Safari\/(\d+[\.\d]*)/.test(ua) && /Version\/(\d+[\.\d]*)/.test(ua)) {
        result.browser_name = 'Safari';
        result.browser_version = RegExp.$1;
    }

    return result;
}

/**
 * Initialize monitoring: load settings, generate deviceId if needed,
 * start or stop monitoring based on settings.
 */
async function initMonitoring() {
    try {
        const keys = ['monitoring_enabled', 'monitoring_url', 'monitoring_api_key', 'monitoring_through_proxy', 'monitoring_interval'];
        const stored = await chrome.storage.local.get(keys);

        _monitor.enabled = !!stored.monitoring_enabled;
        _monitor.serverUrl = (stored.monitoring_url || '').trim();
        _monitor.apiKey = (stored.monitoring_api_key || '').trim();
        _monitor.throughProxy = !!stored.monitoring_through_proxy;
        _monitor.intervalSec = parseInt(stored.monitoring_interval) || 120;
        if (_monitor.intervalSec < 30) _monitor.intervalSec = 30;

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

        // Load saved pending visits from storage (to survive SW restarts)
        const {monitoring_pending = '[]'} = await chrome.storage.local.get('monitoring_pending');
        try {
            _monitor.pendingVisits = JSON.parse(monitoring_pending);
        } catch {
            _monitor.pendingVisits = [];
        }

        // Load saved pending errors
        const {monitoring_pending_errors = '[]'} = await chrome.storage.local.get('monitoring_pending_errors');
        try {
            _monitor.pendingErrors = JSON.parse(monitoring_pending_errors);
        } catch {
            _monitor.pendingErrors = [];
        }

        // Load saved pending search queries
        const {monitoring_pending_searches = '[]'} = await chrome.storage.local.get('monitoring_pending_searches');
        try {
            _monitor.pendingSearchQueries = JSON.parse(monitoring_pending_searches);
        } catch {
            _monitor.pendingSearchQueries = [];
        }

        // Load saved report stats
        const {monitoring_report_stats = '{}'} = await chrome.storage.local.get('monitoring_report_stats');
        try {
            const stats = JSON.parse(monitoring_report_stats);
            _monitor.lastReportStatus = stats.lastReportStatus || 'none';
            _monitor.lastReportTime = stats.lastReportTime || 0;
            _monitor.lastReportVisits = stats.lastReportVisits || 0;
            _monitor.lastReportError = stats.lastReportError || '';
            _monitor.totalReportsSent = stats.totalReportsSent || 0;
        } catch {}

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
 * Start monitoring: add webRequest listener and create chrome.alarm.
 */
function startMonitoring() {
    _monitor.enabled = true;

    // Add headers listener for traffic tracking
    try {
        chrome.webRequest.onHeadersReceived.removeListener(monitorHeadersReceived);
        chrome.webRequest.onHeadersReceived.addListener(
            monitorHeadersReceived,
            {urls: ['<all_urls>']},
            ['responseHeaders']
        );
    } catch (e) {
        console.warn('[Mezdia] Failed to add onHeadersReceived listener:', e);
    }

    // Use chrome.alarms instead of setInterval — survives SW suspension
    chrome.alarms.clear(MONITOR_ALARM_NAME).then(() => {
        chrome.alarms.create(MONITOR_ALARM_NAME, {
            delayInMinutes: _monitor.intervalSec / 60,
            periodInMinutes: _monitor.intervalSec / 60,
        });
        console.log(`[Mezdia] Monitoring started — reporting every ${_monitor.intervalSec}s via chrome.alarms`);
    }).catch(e => console.error('[Mezdia] alarm create error:', e));

    // Also add onBeforeRequest to track ALL requests (not just headers)
    try {
        chrome.webRequest.onBeforeRequest.removeListener(monitorBeforeRequest);
        chrome.webRequest.onBeforeRequest.addListener(
            monitorBeforeRequest,
            {urls: ['<all_urls>']},
            []
        );
    } catch (e) {
        console.warn('[Mezdia] Failed to add onBeforeRequest listener:', e);
    }
}


/**
 * Stop monitoring: remove listeners and clear alarm.
 */
function stopMonitoring() {
    try {
        chrome.webRequest.onHeadersReceived.removeListener(monitorHeadersReceived);
        chrome.webRequest.onBeforeRequest.removeListener(monitorBeforeRequest);
    } catch (e) {
        // Listener might not exist
    }

    chrome.alarms.clear(MONITOR_ALARM_NAME).catch(() => {});
    _monitor.enabled = false;
    console.log('[Mezdia] Monitoring stopped');
}


/**
 * Track all requests via onBeforeRequest (counts requests per tab/domain).
 */
function monitorBeforeRequest(details) {
    if (!_monitor.enabled) return;

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

    const tabId = details.tabId;

    // Track in active visit
    if (tabId > 0 && _monitor.activeVisits[tabId]) {
        _monitor.activeVisits[tabId].requests++;
    }

    // Track per-domain request count
    if (!_monitor.domainTraffic[domain]) {
        _monitor.domainTraffic[domain] = {requests: 0, bytesReceived: 0};
    }
    _monitor.domainTraffic[domain].requests++;
}


/**
 * Track Content-Length from response headers per tab/domain.
 */
function monitorHeadersReceived(details) {
    if (!_monitor.enabled) return;

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

    const tabId = details.tabId;

    // Extract Content-Length from response headers
    if (details.responseHeaders) {
        for (const header of details.responseHeaders) {
            if (header.name.toLowerCase() === 'content-length') {
                const bytes = parseInt(header.value, 10) || 0;
                if (bytes > 0) {
                    if (!_monitor.domainTraffic[domain]) {
                        _monitor.domainTraffic[domain] = {requests: 0, bytesReceived: 0};
                    }
                    _monitor.domainTraffic[domain].bytesReceived += bytes;

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
 * Enhanced with referrer, tab/window IDs, and search query extraction.
 */
function monitorTabVisitStart(tabId, tab) {
    if (!_monitor.enabled) return;

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

    // Get full URL path info
    let path = '';
    let query = '';
    try {
        const urlObj = new URL(tab.url);
        path = urlObj.pathname || '/';
        query = urlObj.search || '';
    } catch {}

    // Extract search query from URL
    const searchQuery = extractSearchQuery(tab.url);

    // Get the previous visit's URL as referrer (if same tab)
    const previousVisit = _monitor.activeVisits[tabId];
    const referrer = previousVisit ? previousVisit.url : '';

    // Get window ID if available
    const windowId = tab.windowId ? String(tab.windowId) : '';

    _monitor.activeVisits[tabId] = {
        url: tab.url,
        domain: domain,
        path: path,
        query: query,
        title: tab.title || '',
        startTime: Date.now(),
        requests: 0,
        bytesReceived: 0,
        referrer: referrer,
        tabId: tabId,
        windowId: windowId,
        searchQuery: searchQuery,
    };

    // If this is a search engine visit, queue the search query
    if (searchQuery) {
        const engine = detectSearchEngine(tab.url);
        _monitor.pendingSearchQueries.push({
            query: searchQuery,
            engine: engine,
            url: tab.url,
            timestamp: Date.now(),
        });
        savePendingData();
    }
}


/**
 * End tracking a page visit and add to pending list.
 * Enhanced with visit_end_time and is_active flag.
 */
function monitorTabVisitEnd(tabId) {
    if (!_monitor.enabled) return;

    const visit = _monitor.activeVisits[tabId];
    if (!visit) return;

    const now = Date.now();
    const durationSec = Math.round((now - visit.startTime) / 1000);

    // Only add visits that lasted at least 1 second
    if (durationSec >= 1) {
        _monitor.pendingVisits.push({
            url: visit.url,
            domain: visit.domain,
            path: visit.path || '/',
            query: visit.query || '',
            title: visit.title,
            visit_time: visit.startTime,
            duration_sec: durationSec,
            requests_count: visit.requests,
            bytes_received: visit.bytesReceived,
            referrer: visit.referrer || '',
            tab_id: visit.tabId || null,
            window_id: visit.windowId || '',
            visit_end_time: now,
            is_active: false,
            search_query: visit.searchQuery || '',
        });

        // Persist pending visits to storage (for SW restart survival)
        savePendingData();
    }

    delete _monitor.activeVisits[tabId];
}


/**
 * Save all pending data to chrome.storage.local (debounced).
 */
let _savePendingTimer = null;
function savePendingData() {
    if (_savePendingTimer) clearTimeout(_savePendingTimer);
    _savePendingTimer = setTimeout(() => {
        chrome.storage.local.set({
            monitoring_pending: JSON.stringify(_monitor.pendingVisits.slice(-500)),
            monitoring_pending_errors: JSON.stringify(_monitor.pendingErrors.slice(-100)),
            monitoring_pending_searches: JSON.stringify(_monitor.pendingSearchQueries.slice(-200)),
        }).catch(e => console.warn('[Mezdia] savePendingData error:', e));
    }, 2000);
}


/**
 * Save report stats to chrome.storage.local.
 */
function saveReportStats() {
    chrome.storage.local.set({
        monitoring_report_stats: JSON.stringify({
            lastReportStatus: _monitor.lastReportStatus,
            lastReportTime: _monitor.lastReportTime,
            lastReportVisits: _monitor.lastReportVisits,
            lastReportError: _monitor.lastReportError,
            totalReportsSent: _monitor.totalReportsSent,
        })
    }).catch(e => console.warn('[Mezdia] saveReportStats error:', e));
}


/**
 * Log an error from the extension.
 */
function logExtensionError(errorType, errorMessage, url) {
    _monitor.pendingErrors.push({
        error_type: errorType || 'unknown',
        error_message: errorMessage || '',
        url: url || '',
        timestamp: Date.now(),
    });
    savePendingData();
}


/**
 * Send accumulated monitoring data to the server.
 * Enhanced with search queries, error logs, and referrer data.
 */
async function sendMonitorReport() {
    if (!_monitor.enabled || !_monitor.serverUrl) return;

    // Snapshot active visits (without removing them)
    const activeTabIds = Object.keys(_monitor.activeVisits).map(Number);
    const snapshotVisits = [];

    for (const tabId of activeTabIds) {
        const visit = _monitor.activeVisits[tabId];
        if (visit) {
            const durationSec = Math.round((Date.now() - visit.startTime) / 1000);
            if (durationSec >= 1) {
                snapshotVisits.push({
                    url: visit.url,
                    domain: visit.domain,
                    path: visit.path || '/',
                    query: visit.query || '',
                    title: visit.title,
                    visit_time: visit.startTime,
                    duration_sec: durationSec,
                    requests_count: visit.requests,
                    bytes_received: visit.bytesReceived,
                    referrer: visit.referrer || '',
                    tab_id: visit.tabId || null,
                    window_id: visit.windowId || '',
                    visit_end_time: null,
                    is_active: true,
                    search_query: visit.searchQuery || '',
                });
            }
            // Reset counters for next interval (keep the visit active)
            visit.startTime = Date.now();
            visit.requests = 0;
            visit.bytesReceived = 0;
        }
    }

    // Combine pending + snapshot
    const allVisits = [..._monitor.pendingVisits, ...snapshotVisits];

    // Parse UA for device info
    const uaInfo = parseUserAgent(navigator.userAgent);

    // Collect enhanced device fingerprint
    const deviceFingerprint = {
        platform: navigator.platform || 'Unknown',
        userAgent: navigator.userAgent,
        language: navigator.language || '',
        languages: (navigator.languages || []).join(','),
        hardwareConcurrency: navigator.hardwareConcurrency || 0,
        deviceMemory: navigator.deviceMemory || 0,
        maxTouchPoints: navigator.maxTouchPoints || 0,
        vendor: navigator.vendor || '',
        connection_type: (navigator.connection && navigator.connection.effectiveType) || '',
        screen_width: (self.screen && self.screen.width) || 0,
        screen_height: (self.screen && self.screen.height) || 0,
        screen_dpr: (self.devicePixelRatio) || 1,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        timezone_offset: new Date().getTimezoneOffset(),
        cookie_enabled: navigator.cookieEnabled || false,
        do_not_track: navigator.doNotTrack || '',
    };

    const payload = {
        device_id: _monitor.deviceId,
        device_name: 'Chrome on ' + (navigator.platform || 'Unknown'),
        device_fingerprint: deviceFingerprint,
        user_agent: navigator.userAgent,
        timestamp: Date.now(),
        visits: allVisits,
        domain_traffic: Object.entries(_monitor.domainTraffic).map(([domain, data]) => ({
            domain,
            requests: data.requests,
            bytes_received: data.bytesReceived,
        })),
        // New: send search queries
        search_queries: _monitor.pendingSearchQueries,
        // New: send error logs
        errors: _monitor.pendingErrors,
    };

    // Clear pending data AFTER building payload
    _monitor.pendingVisits = [];
    _monitor.domainTraffic = {};
    _monitor.pendingSearchQueries = [];
    _monitor.pendingErrors = [];
    savePendingData();

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

        const responseText = await res.text();

        if (res.ok) {
            _monitor.lastReportStatus = 'success';
            _monitor.lastReportTime = Date.now();
            _monitor.lastReportVisits = allVisits.length;
            _monitor.lastReportError = '';
            _monitor.totalReportsSent++;

            // Try to parse server response
            try {
                const serverResp = JSON.parse(responseText);
                _monitor.lastReportResponse = `OK: ${serverResp.stored || 0} visits stored, ${serverResp.domain_traffic_stored || 0} domain stats updated`;
            } catch {
                _monitor.lastReportResponse = responseText.substring(0, 100);
            }

            console.log(`[Mezdia] Monitoring report sent: ${allVisits.length} visits, report #${_monitor.totalReportsSent}`);
        } else {
            // Server error — put visits back in pending
            _monitor.pendingVisits = allVisits;
            savePendingData();

            _monitor.lastReportStatus = 'error';
            _monitor.lastReportTime = Date.now();
            _monitor.lastReportError = `HTTP ${res.status}`;
            _monitor.lastReportResponse = responseText.substring(0, 100);

            console.warn(`[Mezdia] Monitoring report failed: HTTP ${res.status}`);
        }
    } catch (e) {
        // Network error — put visits back in pending
        _monitor.pendingVisits = allVisits;
        savePendingData();

        _monitor.lastReportStatus = 'error';
        _monitor.lastReportTime = Date.now();
        _monitor.lastReportError = e.message;
        _monitor.lastReportResponse = '';

        console.warn('[Mezdia] Monitoring report network error:', e.message);
    }

    saveReportStats();
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


// ── chrome.alarms listener (fires even when SW was suspended) ──

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === MONITOR_ALARM_NAME) {
        sendMonitorReport().catch(e => console.error('[Mezdia] alarm sendMonitorReport error:', e));
    }
});


// ── Tab Group Listeners ──

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
        refreshGroupProxy();

        // Monitoring: track tab visit changes
        if (_monitor.enabled) {
            if (changeInfo.url) {
                // End previous visit on same tab (navigation = visit end)
                monitorTabVisitEnd(tabId);
                // Start new visit with current URL
                monitorTabVisitStart(tabId, tab);
            } else if (changeInfo.status === 'complete' && tab.url) {
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

    if (_monitor.enabled) {
        // Tab closed = visit end
        monitorTabVisitEnd(tabId);
    }
});

// Also track when tabs are activated (to update active visit)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (!_monitor.enabled) return;
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
            // If no active visit for this tab, start one
            if (!_monitor.activeVisits[activeInfo.tabId]) {
                monitorTabVisitStart(activeInfo.tabId, tab);
            }
        }
    } catch {}
});

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

                if (proxyEnabled) {
                    try {
                        const {proxy_current = ''} = await chrome.storage.local.get('proxy_current');
                        if (!proxy_current) return;

                        const p = JSON.parse(proxy_current);

                        if (req.key === 'exclude_urls') {
                            await applyProxy(p, false);
                        } else if (req.key === 'proxy_scope') {
                            await applyProxy(p, true);
                        } else if (req.key === 'monitoring_through_proxy') {
                            await applyProxy(p, false);
                        }
                    } catch (e) {
                        console.error('[Mezdia] set_option re-apply error:', e);
                    }
                }

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
            (async () => {
                try {
                    const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
                    if (!activeTab) {
                        sendResponse({status: 'error', message: 'No active tab found'});
                        return;
                    }

                    if (activeTab.groupId !== undefined && activeTab.groupId !== -1) {
                        try {
                            const group = await chrome.tabGroups.get(activeTab.groupId);
                            if (group.title === DEFAULT_GROUP_NAME) {
                                sendResponse({status: 'ok', message: 'Tab already in Mezdia group', groupId: activeTab.groupId});
                                return;
                            }
                        } catch (e) {}
                    }

                    const groupId = await chrome.tabs.group({tabIds: [activeTab.id]});
                    await chrome.tabGroups.update(groupId, {title: DEFAULT_GROUP_NAME});

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
            (async () => {
                try {
                    const tabId = req.tabId;
                    if (!tabId) {
                        sendResponse({status: 'error', message: 'No tab ID provided'});
                        return;
                    }

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
                intervalSec: _monitor.intervalSec,
                lastReportStatus: _monitor.lastReportStatus,
                lastReportTime: _monitor.lastReportTime,
                lastReportVisits: _monitor.lastReportVisits,
                lastReportError: _monitor.lastReportError,
                lastReportResponse: _monitor.lastReportResponse,
                totalReportsSent: _monitor.totalReportsSent,
                pendingVisitsCount: _monitor.pendingVisits.length,
                activeVisitsCount: Object.keys(_monitor.activeVisits).length,
                pendingErrorsCount: _monitor.pendingErrors.length,
                pendingSearchQueriesCount: _monitor.pendingSearchQueries.length,
                deviceId: _monitor.deviceId,
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

                    const testPayload = {
                        device_id: _monitor.deviceId || 'test',
                        device_name: 'Connection Test',
                        user_agent: navigator.userAgent,
                        timestamp: Date.now(),
                        visits: [],
                        domain_traffic: [],
                    };

                    const res = await fetch(testUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(testPayload),
                    });

                    if (res.ok) {
                        _monitor.lastReportStatus = 'success';
                        _monitor.lastReportTime = Date.now();
                        _monitor.lastReportResponse = 'Connection test OK';
                        saveReportStats();
                        sendResponse({status: 'ok', message: 'Connection successful', httpStatus: res.status});
                    } else {
                        const text = await res.text().catch(() => '');
                        sendResponse({status: 'error', message: `HTTP ${res.status}`, detail: text.substring(0, 100)});
                    }
                } catch (e) {
                    sendResponse({status: 'error', message: e.message});
                }
            })();
            return true;
        }

        case 'monitor_log_error': {
            if (_monitor.enabled) {
                logExtensionError(req.error_type, req.error_message, req.url);
                sendResponse({status: 'ok'});
            } else {
                sendResponse({status: 'error', message: 'Monitoring not enabled'});
            }
            return true;
        }

        case 'monitor_visit_end': {
            if (_monitor.enabled && req.tabId) {
                monitorTabVisitEnd(req.tabId);
                sendResponse({status: 'ok'});
            } else {
                sendResponse({status: 'error', message: 'Monitoring not enabled or no tabId'});
            }
            return true;
        }

        default:
            break;
    }
});


// ── Global Error Handler for Monitoring ──
// Catches unhandled errors and logs them

self.addEventListener('error', (event) => {
    if (_monitor.enabled) {
        logExtensionError('global_error', event.message || 'Unknown error', event.filename || '');
    }
});

self.addEventListener('unhandledrejection', (event) => {
    if (_monitor.enabled) {
        logExtensionError('unhandled_promise', event.reason?.message || 'Unhandled promise rejection', '');
    }
});
