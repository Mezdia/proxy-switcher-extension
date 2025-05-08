const defaults = {
    proxy_current: '',
    proxy_list: '',
    reload_current_tab: false,
    reload_other_tabs: false,
    remove_cookies: false,
    remove_cache: false,
};


let proxyEnabled = false;
let proxyAuth = null;


const readJSON = str => {
    if (!str) return '';
    try {
        return JSON.parse(str);
    } catch {
        return '';
    }
};


async function runSideEffects() {
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

    if (reload_current_tab || reload_other_tabs) {
        const wins = await chrome.windows.getAll({populate: true});
        for (const w of wins) {
            for (const t of w.tabs) {
                if (reload_current_tab && t.active) chrome.tabs.reload(t.id);
                if (reload_other_tabs && !t.active) chrome.tabs.reload(t.id);
            }
        }
    }

    if (remove_cookies) await chrome.browsingData.removeCookies({});
    if (remove_cache) await chrome.browsingData.removeCache({});
}


function parseProxyList(raw) {
    return raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
        .map(line => {
            if (line.includes('@')) {
                const [auth, host] = line.split('@');
                const [user, pass] = auth.split(':');
                const [ip, port] = host.split(':');
                return {ip, port, user, pass};
            }

            const [ip, port, user = '', pass = ''] = line.split(':');
            return {ip, port, user, pass};
        })
        .filter(({ip, port, user, pass}) => ip && port && (!user && !pass || user && pass));
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


function applyProxy({ip, port, user = '', pass = ''}, withSideFx = true) {
    const cfg = {
        mode: 'fixed_servers',
        rules: {singleProxy: {host: ip, port: Number(port)}},
    };
    chrome.proxy.settings.set({value: cfg, scope: 'regular'});

    proxyEnabled = true;
    proxyAuth = user && pass ? {user, pass} : null;

    chrome.storage.local.set({proxy_current: JSON.stringify({ip, port, user, pass})});
    updateIcon();
    if (withSideFx) runSideEffects();
}

function disableProxy() {
    chrome.proxy.settings.clear({scope: 'regular'});
    proxyEnabled = false;
    proxyAuth = null;
    chrome.storage.local.set({proxy_current: ''});
    updateIcon();
    runSideEffects();
}


chrome.storage.local.get('proxy_current').then(({proxy_current}) => {
    const p = readJSON(proxy_current);
    if (p && p.ip && p.port) applyProxy(p, false);
});


chrome.webRequest.onAuthRequired.addListener(
    details => {
        if (details.isProxy && proxyAuth) {
            return {authCredentials: {username: proxyAuth.user, password: proxyAuth.pass}};
        }
    },
    {urls: ['<all_urls>']},
    ['blocking']
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
            });
            return true;
        }

        case 'set_option': {
            chrome.storage.local.set({[req.key]: req.val}).then(() => sendResponse({status: 'ok'}));
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
            applyProxy(req.data);
            sendResponse({status: 'ok'});
            return true;
        }

        case 'disable_proxy': {
            disableProxy();
            sendResponse({status: 'ok'});
            return true;
        }

    }
});
