/* ═══════════════════════════════════════════════════
   Mezdia Proxy Switcher — Service Worker v3.12.1
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

function buildGroupPacScript(proxyHost, proxyPort, domains, excludeEntries) {
    let safeDomains = (domains || []).filter(d => d && typeof d === 'string');
    const { domains: excludeDomains, patterns: excludePatterns } = classifyExcludeEntries(excludeEntries);

    const jsonDomains = JSON.stringify(safeDomains);
    const jsonExDomains = JSON.stringify(excludeDomains);
    const jsonExPatterns = JSON.stringify(excludePatterns);

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
      return "PROXY ${proxyHost}:${proxyPort}";
    }
  }

  return "DIRECT";
}`;
}


function buildAllTabsPacScript(proxyHost, proxyPort, excludeEntries) {
    const { domains: excludeDomains, patterns: excludePatterns } = classifyExcludeEntries(excludeEntries);
    const jsonExDomains = JSON.stringify(excludeDomains);
    const jsonExPatterns = JSON.stringify(excludePatterns);
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

  return "PROXY ${proxyHost}:${proxyPort}";
}`;
}


async function applyProxy({ip, port, user = '', pass = ''}, withSideFx = true) {
    const {exclude_urls = '[]', proxy_scope = 'all'} = await chrome.storage.local.get(['exclude_urls', 'proxy_scope']);
    let entries;
    try {
        entries = JSON.parse(exclude_urls);
        if (!Array.isArray(entries)) entries = [];
    } catch {
        entries = String(exclude_urls).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }

    let pacData;
    const proxyHost = ip, proxyPort = Number(port);

    if (proxy_scope === 'group') {
        const domains = await getMezdiaGroupDomains();
        pacData = buildGroupPacScript(proxyHost, proxyPort, domains, entries);
    } else {
        pacData = buildAllTabsPacScript(proxyHost, proxyPort, entries);
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

        default:
            break;
    }
});