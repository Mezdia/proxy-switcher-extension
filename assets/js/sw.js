/* ═══════════════════════════════════════════════════
   Mezdia Proxy Switcher — Service Worker v4.0.0
   ═══════════════════════════════════════════════════ */

const DEFAULT_GROUP_NAME = 'Mezdia';

const SUPPORTED_PROTOCOLS = ['http', 'https', 'socks5'];

/* Blink applies an inline PAC script; Gecko cannot store one and instead asks
   the extension for a proxy per request through proxy.onRequest. */
const GECKO_PROXY = typeof browser !== 'undefined' && typeof browser.proxy?.onRequest?.addListener === 'function';

/* Gecko can group tabs by id but has no tabGroups API, so a group cannot be
   titled and its id has to be remembered instead of looked up by name. */
const SUPPORTS_TAB_GROUPS = !!chrome.tabGroups && typeof chrome.tabs.group === 'function';
const SUPPORTS_TAB_GROUPING = typeof chrome.tabs.group === 'function';

const defaults = {
    proxy_current: '',
    proxy_list: '',
    reload_current_tab: false,
    reload_other_tabs: false,
    remove_cookies: false,
    remove_cache: false,
    theme: '',
    lang: 'en',
    exclude_urls: '[]',
    proxy_scope: 'all',
};


let proxyEnabled = false;
let proxyAuth = null;
let _restored = false;

let _refreshTimer = null;
const REFRESH_DEBOUNCE_MS = 800;

const readJSON = str => {
    if (!str) return '';
    try {
        return JSON.parse(str);
    } catch {
        return '';
    }
};


async function runSideEffects(groupTabIds = null) {
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

    if (shouldReloadCurrent || shouldReloadOther || groupTabIds) {
        try {
            const tabs = await chrome.tabs.query({});
            for (const t of tabs) {
                if (shouldReloadCurrent && t.active) {
                    chrome.tabs.reload(t.id, {bypassCache: true});
                } else if (shouldReloadOther && !t.active) {
                    chrome.tabs.reload(t.id, {bypassCache: true});
                } else if (groupTabIds && groupTabIds.has(t.id) && !shouldReloadCurrent && !shouldReloadOther) {
                    chrome.tabs.reload(t.id, {bypassCache: true});
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


function normalizeProtocol(proto) {
    if (!proto) return 'http';
    const lower = proto.toLowerCase().replace(/[\s\-]/g, '');
    if (lower === 'socks5' || lower === 'socksv5') return 'socks5';
    if (lower === 'https' || lower === 'ssl') return 'https';
    if (lower === 'http') return 'http';
    return 'http';
}

function parseProxyList(raw) {
    let pendingComment = '';

    return raw.split(/\r?\n/).reduce((out, rawLine) => {
        const line = rawLine.trim();
        if (!line) {
            pendingComment = '';
            return out;
        }
        if (line.startsWith('#')) {
            pendingComment = line.slice(1).trim();
            return out;
        }

        const idx = line.indexOf('#');
        const text = idx === -1 ? line : line.slice(0, idx).trim();
        const inlineComment = idx === -1 ? '' : line.slice(idx + 1).trim();

        let protocol = 'http';
        let proxyText = text;

        const protocolMatch = text.match(/^((?:socks5|https?|ssl|socksv5)\s*:)/i);
        if (protocolMatch) {
            protocol = normalizeProtocol(protocolMatch[1].replace(/:$/, '').trim());
            proxyText = text.slice(protocolMatch[0].length).trim();
        }

        let ip, port, user = '', pass = '';
        if (proxyText.includes('@')) {
            const [auth, host] = proxyText.split('@');
            [user, pass] = auth.split(':');
            [ip, port] = host.split(':');
        } else {
            [ip, port, user = '', pass = ''] = proxyText.split(':');
        }

        if (!ip || !port || ((!!user) ^ (!!pass))) {
            pendingComment = '';
            return out;
        }

        out.push({ip, port, user, pass, protocol, commentBefore: pendingComment, commentAfter: inlineComment});

        pendingComment = '';
        return out;
    }, []);
}


function updateIcon() {
    const postfix = proxyEnabled ? 'enabled' : 'disabled';
    const path = [16, 32].reduce((o, size) => {
        o[size] = chrome.runtime.getURL(`assets/images/icon${size}_${postfix}.png`);
        return o;
    }, {});
    chrome.action.setIcon({path});
    chrome.action.setBadgeText({text: proxyEnabled ? 'proxy' : ''});
}


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

        const groupIds = new Set(groups.map(g => g.id));
        const allTabs = await chrome.tabs.query({});

        const domainSet = new Set();
        for (const tab of allTabs) {
            if (tab.groupId !== undefined && tab.groupId !== -1 && groupIds.has(tab.groupId)) {
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


/* Gecko mirror of getMezdiaGroupInfo: the Mezdia group is identified by the
   tab id it was created with, because no group title can be stored. */
async function getGeckoGroupInfo() {
    const result = {exists: false, groupColor: null, tabs: [], domains: []};
    const {mezdia_group_id = null} = await chrome.storage.local.get('mezdia_group_id');
    if (!mezdia_group_id) return result;

    try {
        const allTabs = await chrome.tabs.query({});
        const domainSet = new Set();

        for (const tab of allTabs) {
            if (tab.groupId !== mezdia_group_id) continue;

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

        result.exists = result.tabs.length > 0;
        result.domains = [...domainSet].sort();
    } catch (e) {
        console.warn('[Mezdia] getGeckoGroupInfo error:', e);
    }

    return result;
}


async function getGroupInfo() {
    return SUPPORTS_TAB_GROUPS ? getMezdiaGroupInfo() : getGeckoGroupInfo();
}


/* Gecko cannot name a group, so the group created here is remembered by id. */
async function geckoJoinGroup(tabId) {
    const {mezdia_group_id = null} = await chrome.storage.local.get('mezdia_group_id');
    const tabs = await chrome.tabs.query({});

    if (mezdia_group_id && tabs.some(t => t.groupId === mezdia_group_id)) {
        await chrome.tabs.group({groupId: mezdia_group_id, tabIds: [tabId]});
        return mezdia_group_id;
    }

    const groupId = await chrome.tabs.group({tabIds: [tabId]});
    await chrome.storage.local.set({mezdia_group_id: groupId});
    return groupId;
}


function classifyExcludeEntries(entries) {
    const domains = [];
    const patterns = [];
    for (const entry of (entries || [])) {
        if (!entry || typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (!trimmed) continue;
        if (trimmed.includes('*') || trimmed.includes('/') || trimmed.includes(':')) {
            patterns.push(trimmed);
        } else {
            domains.push(trimmed);
        }
    }
    return { domains, patterns };
}

function pacProxyDirective(proxyHost, proxyPort, protocol) {
    if (protocol === 'socks5') return `SOCKS5 ${proxyHost}:${proxyPort}; SOCKS ${proxyHost}:${proxyPort}`;
    if (protocol === 'https') return `HTTPS ${proxyHost}:${proxyPort}`;
    return `PROXY ${proxyHost}:${proxyPort}`;
}

function buildGroupPacScript(proxyHost, proxyPort, protocol, domains, excludeEntries) {
    let safeDomains = (domains || []).filter(d => d && typeof d === 'string');
    const { domains: excludeDomains, patterns: excludePatterns } = classifyExcludeEntries(excludeEntries);

    const jsonDomains = JSON.stringify(safeDomains);
    const jsonExDomains = JSON.stringify(excludeDomains);
    const jsonExPatterns = JSON.stringify(excludePatterns);
    const directive = pacProxyDirective(proxyHost, proxyPort, protocol);

    return `function FindProxyForURL(url, host) {
  var proxiedDomains = ${jsonDomains};
  var excludeDomains = ${jsonExDomains};
  var excludePatterns = ${jsonExPatterns};
  var i, j;

  for (i = 0; i < excludePatterns.length; i++) {
    if (shExpMatch(url, excludePatterns[i]) || shExpMatch(host, excludePatterns[i])) {
      return "DIRECT";
    }
  }

  for (i = 0; i < excludeDomains.length; i++) {
    if (host === excludeDomains[i] || dnsDomainIs(host, "." + excludeDomains[i])) {
      return "DIRECT";
    }
  }

  if (proxiedDomains.length === 0) {
    return "DIRECT";
  }

  for (j = 0; j < proxiedDomains.length; j++) {
    if (host === proxiedDomains[j] || dnsDomainIs(host, "." + proxiedDomains[j])) {
      return "${directive}";
    }
  }

  return "DIRECT";
}`;
}


function buildAllTabsPacScript(proxyHost, proxyPort, protocol, excludeEntries) {
    const { domains: excludeDomains, patterns: excludePatterns } = classifyExcludeEntries(excludeEntries);
    const jsonExDomains = JSON.stringify(excludeDomains);
    const jsonExPatterns = JSON.stringify(excludePatterns);
    const directive = pacProxyDirective(proxyHost, proxyPort, protocol);
    return `function FindProxyForURL(url, host) {
  var excludeDomains = ${jsonExDomains};
  var excludePatterns = ${jsonExPatterns};
  var i;

  for (i = 0; i < excludePatterns.length; i++) {
    if (shExpMatch(url, excludePatterns[i]) || shExpMatch(host, excludePatterns[i])) {
      return "DIRECT";
    }
  }

  for (i = 0; i < excludeDomains.length; i++) {
    if (host === excludeDomains[i] || dnsDomainIs(host, "." + excludeDomains[i])) {
      return "DIRECT";
    }
  }

  return "${directive}";
}`;
}


/* ── Gecko proxy engine ──
   proxy.onRequest is the stand-in for the PAC script: returning null drops the
   proxy for that request (PAC "DIRECT"), an object applies it, and undefined
   leaves whatever the browser itself configured in charge.

   Unlike the Blink PAC — which the browser keeps even while the extension is
   asleep — this policy lives in the background script, so it is mirrored into
   storage and awaited before the first request is answered after a wake-up. */

const SH_EXP_SPECIALS = /[.+^${}()|[\]\\]/g;
const GECKO_POLICY_KEY = 'gecko_policy';

let geckoPolicy = null;
let geckoListenerInstalled = false;
let geckoRestore = null;

function toShellRegExp(pattern) {
    return new RegExp(`^${pattern.replace(SH_EXP_SPECIALS, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function hostInDomain(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}

/* Only SOCKS carries credentials in the ProxyInfo itself; an HTTP proxy's
   Proxy-Authorization header is ignored here, so that auth keeps flowing through
   webRequest.onAuthRequired, which both engines honour. */
function geckoProxyInfo({ip, port, protocol, user, pass}) {
    const type = protocol === 'socks5' ? 'socks' : protocol;
    const info = {type, host: ip, port};

    if (type === 'socks') {
        info.proxyDNS = true;
        if (user && pass) {
            info.username = user;
            info.password = pass;
        }
    }

    return info;
}

function compileGeckoPolicy({proxyInfo, domains = [], patterns = [], allowDomains = null}) {
    return {proxyInfo, domains, patterns: patterns.map(toShellRegExp), allowDomains};
}

async function restoreGeckoPolicy() {
    const stored = await chrome.storage.local.get(GECKO_POLICY_KEY);
    let snapshot = null;
    try {
        snapshot = stored[GECKO_POLICY_KEY] ? JSON.parse(stored[GECKO_POLICY_KEY]) : null;
    } catch {
        snapshot = null;
    }

    if (snapshot && snapshot.proxyInfo) geckoPolicy = compileGeckoPolicy(snapshot);
    return geckoPolicy;
}

function decideGecko(url) {
    const policy = geckoPolicy;
    if (!policy) return undefined;

    let host;
    try {
        host = new URL(url).hostname;
    } catch {
        return undefined;
    }

    for (const pattern of policy.patterns) {
        if (pattern.test(url) || pattern.test(host)) return null;
    }
    for (const domain of policy.domains) {
        if (hostInDomain(host, domain)) return null;
    }
    if (policy.allowDomains !== null && !policy.allowDomains.some(d => hostInDomain(host, d))) {
        return null;
    }

    return {...policy.proxyInfo};
}

async function geckoOnRequest(details) {
    if (!geckoPolicy) {
        geckoRestore = restoreGeckoPolicy().finally(() => {
            geckoRestore = null;
        });
        await geckoRestore;
    }

    return decideGecko(details.url);
}

async function installGeckoPolicy(policy) {
    geckoPolicy = compileGeckoPolicy(policy);
    await chrome.storage.local.set({[GECKO_POLICY_KEY]: JSON.stringify({
        proxyInfo: policy.proxyInfo,
        domains: policy.domains ?? [],
        patterns: policy.patterns ?? [],
        allowDomains: policy.allowDomains ?? null,
    })});

    if (geckoListenerInstalled) return;
    chrome.proxy.onRequest.addListener(geckoOnRequest, {urls: ['<all_urls>']});
    geckoListenerInstalled = true;
}

function clearGeckoPolicy() {
    geckoPolicy = null;
    chrome.storage.local.remove(GECKO_POLICY_KEY).catch(() => {});
    if (!geckoListenerInstalled) return;

    chrome.proxy.onRequest.removeListener(geckoOnRequest);
    geckoListenerInstalled = false;
}


async function applyProxy({ip, port, user = '', pass = '', protocol = 'http'}, withSideFx = true) {
    const {exclude_urls = '[]', proxy_scope = 'all'} = await chrome.storage.local.get(['exclude_urls', 'proxy_scope']);
    let entries;
    try {
        entries = JSON.parse(exclude_urls);
        if (!Array.isArray(entries)) entries = [];
    } catch {
        entries = String(exclude_urls).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }

    let groupTabIds = null;
    let allowDomains = null;
    const proxyHost = ip, proxyPort = Number(port);
    const normalizedProtocol = normalizeProtocol(protocol);

    if (proxy_scope === 'group' && SUPPORTS_TAB_GROUPING) {
        const info = await getGroupInfo();
        groupTabIds = new Set(info.tabs.map(t => t.id));
        allowDomains = info.domains;
    } else if (proxy_scope === 'group') {
        console.warn('[Mezdia] tab groups are unavailable in this browser, proxying all tabs instead');
    }

    if (GECKO_PROXY) {
        await installGeckoPolicy({
            proxyInfo: geckoProxyInfo({ip: proxyHost, port: proxyPort, protocol: normalizedProtocol, user, pass}),
            ...classifyExcludeEntries(entries),
            allowDomains,
        });
    } else {
        const pacData = allowDomains === null
            ? buildAllTabsPacScript(proxyHost, proxyPort, normalizedProtocol, entries)
            : buildGroupPacScript(proxyHost, proxyPort, normalizedProtocol, allowDomains, entries);
        await chrome.proxy.settings.set({value: {mode: 'pac_script', pacScript: {data: pacData}}, scope: 'regular'});
    }

    proxyEnabled = true;
    proxyAuth = user && pass ? {user, pass} : null;
    await chrome.storage.local.set({proxy_current: JSON.stringify({ip, port, user, pass, protocol: normalizedProtocol})});
    updateIcon();

    if (withSideFx) {
        await runSideEffects(groupTabIds);
    }
}


function disableProxy() {
    try {
        if (GECKO_PROXY) {
            clearGeckoPolicy();
        } else {
            chrome.proxy.settings.clear({scope: 'regular'});
        }
    } catch (e) {
        console.warn('[Mezdia] disableProxy clear error:', e);
    }
    proxyEnabled = false;
    proxyAuth = null;
    chrome.storage.local.set({proxy_current: ''});
    updateIcon();
    runSideEffects();
}


async function restoreProxy() {
    if (_restored) return;
    _restored = true;

    try {
        const {proxy_current = ''} = await chrome.storage.local.get('proxy_current');
        const p = readJSON(proxy_current);
        if (p && p.ip && p.port) {
            if (!p.protocol) p.protocol = 'http';
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
    if (!proxyEnabled) return;

    if (_refreshTimer) {
        clearTimeout(_refreshTimer);
    }

    _refreshTimer = setTimeout(async () => {
        _refreshTimer = null;

        if (!proxyEnabled) return;

        try {
            const {proxy_scope = 'all', proxy_current = ''} = await chrome.storage.local.get(['proxy_scope', 'proxy_current']);
            if (proxy_scope !== 'group' || !proxy_current) return;

            const p = JSON.parse(proxy_current);
            await applyProxy(p, false);
        } catch (e) {
            console.error('[Mezdia] refreshGroupProxy error:', e);
        }
    }, REFRESH_DEBOUNCE_MS);
}


chrome.runtime.onStartup.addListener(() => { restoreProxy().catch(e => console.error('[Mezdia] onStartup:', e)); });
chrome.runtime.onInstalled.addListener(() => { restoreProxy().catch(e => console.error('[Mezdia] onInstalled:', e)); });
restoreProxy().catch(e => console.error('[Mezdia] initial restoreProxy:', e));


chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
        refreshGroupProxy();
    }
});

chrome.tabs.onAttached.addListener(() => {
    refreshGroupProxy();
});

chrome.tabs.onRemoved.addListener(() => {
    refreshGroupProxy();
});

if (chrome.tabGroups) {
    chrome.tabGroups.onCreated.addListener(() => refreshGroupProxy());
    chrome.tabGroups.onUpdated.addListener(() => refreshGroupProxy());
    chrome.tabGroups.onRemoved.addListener(() => refreshGroupProxy());
}


chrome.webRequest.onAuthRequired.addListener(details => {
        if (details.isProxy && proxyAuth) {
            return {authCredentials: {username: proxyAuth.user, password: proxyAuth.pass}};
        }
    }, {urls: ['<all_urls>']}, ['blocking']
);


chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    switch (req.action) {
        case 'get_option': {
            const keys = req.key == null ? Object.keys(defaults) : Array.isArray(req.key) ? req.key : [req.key];

            const defSubset = keys.reduce((o, k) => (o[k] = defaults[k], o), {});
            chrome.storage.local.get(defSubset).then(stored => {
                const out = keys.reduce((o, k) => (o[k] = stored[k], o), {});
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
                        }
                    } catch (e) {
                        console.error('[Mezdia] set_option re-apply error:', e);
                    }
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

        case 'save_proxylist': {
            const listData = req.data;
            if (!Array.isArray(listData)) {
                sendResponse({status: 'error', message: 'Invalid list data'});
                return true;
            }
            chrome.storage.local.set({proxy_list: JSON.stringify(listData)}).then(() => sendResponse({
                status: 'ok',
                saved: listData.length
            }));
            return true;
        }

        case 'delete_proxy': {
            (async () => {
                try {
                    const {proxy_list = '[]', proxy_current = ''} = await chrome.storage.local.get(['proxy_list', 'proxy_current']);
                    let list;
                    try { list = JSON.parse(proxy_list); } catch { list = []; }
                    let current;
                    try { current = proxy_current ? JSON.parse(proxy_current) : null; } catch { current = null; }

                    const index = req.index;
                    if (index < 0 || index >= list.length) {
                        sendResponse({status: 'error', message: 'Invalid index'});
                        return;
                    }

                    const deleted = list[index];

                    if (current && current.ip === deleted.ip && current.port === deleted.port && current.user === deleted.user && current.pass === deleted.pass) {
                        disableProxy();
                    }

                    list.splice(index, 1);
                    await chrome.storage.local.set({proxy_list: JSON.stringify(list)});
                    sendResponse({status: 'ok'});
                } catch (e) {
                    sendResponse({status: 'error', message: e.message});
                }
            })();
            return true;
        }

        case 'update_proxy': {
            (async () => {
                try {
                    const {proxy_list = '[]', proxy_current = ''} = await chrome.storage.local.get(['proxy_list', 'proxy_current']);
                    let list;
                    try { list = JSON.parse(proxy_list); } catch { list = []; }
                    let current;
                    try { current = proxy_current ? JSON.parse(proxy_current) : null; } catch { current = null; }

                    const index = req.index;
                    const updated = req.data;

                    if (index < 0 || index >= list.length || !updated || !updated.ip || !updated.port) {
                        sendResponse({status: 'error', message: 'Invalid index or data'});
                        return;
                    }

                    if (!updated.protocol) updated.protocol = 'http';
                    updated.protocol = normalizeProtocol(updated.protocol);

                    const wasCurrent = current && current.ip === list[index].ip && current.port === list[index].port && current.user === list[index].user && current.pass === list[index].pass;

                    list[index] = updated;

                    await chrome.storage.local.set({proxy_list: JSON.stringify(list)});

                    if (wasCurrent) {
                        await applyProxy(updated, true);
                    }

                    sendResponse({status: 'ok'});
                } catch (e) {
                    sendResponse({status: 'error', message: e.message});
                }
            })();
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
                    const info = await getGroupInfo();
                    info.proxyEnabled = proxyEnabled;
                    info.groupable = SUPPORTS_TAB_GROUPING;

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
                        lang: 'en',
                        scope: 'all',
                        groupable: SUPPORTS_TAB_GROUPING,
                    });
                }
            })();
            return true;
        }

        case 'create_mezdia_group': {
            (async () => {
                if (!SUPPORTS_TAB_GROUPING) {
                    sendResponse({status: 'error', message: 'Tab groups are not supported by this browser'});
                    return;
                }

                try {
                    const query = SUPPORTS_TAB_GROUPS ? {active: true, currentWindow: true} : {active: true, lastFocusedWindow: true};
                    const [activeTab] = await chrome.tabs.query(query);
                    if (!activeTab) {
                        sendResponse({status: 'error', message: 'No active tab found'});
                        return;
                    }

                    if (!SUPPORTS_TAB_GROUPS) {
                        sendResponse({
                            status: 'ok',
                            message: 'Mezdia group created',
                            groupId: await geckoJoinGroup(activeTab.id),
                        });
                        refreshGroupProxy();
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
                if (!SUPPORTS_TAB_GROUPING) {
                    sendResponse({status: 'error', message: 'Tab groups are not supported by this browser'});
                    return;
                }

                try {
                    const tabId = req.tabId;
                    if (!tabId) {
                        sendResponse({status: 'error', message: 'No tab ID provided'});
                        return;
                    }

                    if (!SUPPORTS_TAB_GROUPS) {
                        const groupId = await geckoJoinGroup(tabId);
                        refreshGroupProxy();
                        sendResponse({status: 'ok', groupId: groupId});
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

        default:
            break;
    }
});