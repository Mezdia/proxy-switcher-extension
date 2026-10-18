/* ═══════════════════════════════════════════════════
   harness.mjs — runs assets/js/sw.js against a fake Blink or Gecko runtime
   and evaluates the PAC script it produces the way a browser would.
   ═══════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {ROOT} from './build.mjs';

const PAC_BUILTINS = {
    // Chrome matches these case-sensitively against an already-lowercased host.
    shExpMatch: (text, pattern) => {
        const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp(`^${source}$`).test(text);
    },
    dnsDomainIs: (host, domain) => host.endsWith(domain),
    isInNet: () => false,
    myIpAddress: () => '127.0.0.1',
    dnsResolve: host => '127.0.0.1',
};

export function evaluatePac(pacSource, url) {
    const host = new URL(url).hostname;
    const sandbox = {url, host, ...PAC_BUILTINS};
    vm.createContext(sandbox);
    return vm.runInContext(`${pacSource}\nFindProxyForURL(url, host)`, sandbox);
}

/**
 * A minimal but faithful stand-in for the parts of the extension API sw.js uses.
 * @param {'blink'|'gecko'} engine
 * @param {object} [fixture] tabs and storage to seed the runtime with
 */
export function createRuntime(engine, {tabs = [], storage = {}, sourceFile = path.join(ROOT, 'assets/js/sw.js')} = {}) {
    const store = {...storage};
    const calls = {pacScripts: [], proxySettings: [], onRequestAdded: 0, onRequestRemoved: 0, authRequired: 0, icons: [], badges: []};
    let onRequestListener = null;

    const promise = value => Promise.resolve(value);
    const hasTabGroups = engine === 'blink';

    const chrome = {
        storage: {local: {
            get: keys => {
                const list = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
                return promise(list.reduce((o, k) => (k in store ? (o[k] = store[k], o) : o), {}));
            },
            set: values => {
                Object.assign(store, JSON.parse(JSON.stringify(values)));
                return promise(undefined);
            },
        }},
        runtime: {
            id: 'fake-extension',
            getURL: p => `${engine === 'gecko' ? 'moz' : 'chrome'}-extension://${p}`,
            onStartup: {addListener: () => {}},
            onInstalled: {addListener: () => {}},
            onMessage: {
                addListener: fn => {
                    calls.messageListener = fn;
                },
            },
        },
        tabs: {
            query: () => promise(tabs.map((t, i) => ({id: i + 1, groupId: t.groupId ?? -1, ...t}))),
            reload: () => {},
            create: () => promise({id: 99}),
            group: ({tabIds, groupId}) => promise(groupId ?? 7),
            onUpdated: {addListener: () => {}},
            onAttached: {addListener: () => {}},
            onRemoved: {addListener: () => {}},
        },
        action: {
            setIcon: details => {
                calls.icons.push(details);
                return promise(undefined);
            },
            setBadgeText: details => {
                calls.badges.push(details);
                return promise(undefined);
            },
        },
        browsingData: {
            removeCookies: () => promise(undefined),
            removeCache: () => promise(undefined),
        },
        webRequest: {
            onAuthRequired: {
                addListener: fn => {
                    calls.authRequired++;
                    chrome.webRequest.onAuthRequired.listener = fn;
                    return fn;
                },
            },
        },
        proxy: engine === 'gecko'
            ? {onRequest: {
                addListener: fn => {
                    onRequestListener = fn;
                    calls.onRequestAdded++;
                },
                removeListener: () => {
                    onRequestListener = null;
                    calls.onRequestRemoved++;
                },
            }}
            : {settings: {
                set: details => {
                    calls.proxySettings.push(details);
                    calls.pacScripts.push(details.value.pacScript.data);
                    return promise(undefined);
                },
                clear: () => {
                    calls.proxySettings.push({cleared: true});
                    return promise(undefined);
                },
            }},
    };

    if (hasTabGroups) {
        const groupId = 7;
        chrome.tabGroups = {
            query: () => promise([{id: groupId, title: 'Mezdia', color: 'blue'}]),
            get: id => promise({id, title: 'Mezdia', color: 'blue'}),
            update: (id, props) => promise({id, ...props}),
            onCreated: {addListener: () => {}},
            onUpdated: {addListener: () => {}},
            onRemoved: {addListener: () => {}},
        };
    }

    const sandbox = {
        chrome,
        console: {log: () => {}, warn: (...a) => calls.warnings.push(a.join(' ')), error: () => {}},
        URL, TextEncoder, btoa, atob, JSON, Math, Date, RegExp, Array, Object, String, Number, Boolean, Error, Promise,
        setTimeout: (fn, ms) => {
            calls.timers.push({fn, ms});
            return calls.timers.length;
        },
        clearTimeout: () => {},
    };
    sandbox.globalThis = sandbox;
    calls.warnings = [];
    calls.timers = [];

    if (engine === 'gecko') sandbox.browser = chrome;

    vm.createContext(sandbox);
    const source = fs.readFileSync(sourceFile, 'utf8');
    vm.runInContext(source, sandbox, {filename: 'sw.js'});

    return {
        sandbox,
        calls,
        store,
        /** Ask the Gecko policy engine how a URL would be routed. */
        routeUrl: url => {
            if (engine !== 'gecko') throw new Error('routeUrl is gecko-only');
            if (!onRequestListener) throw new Error('no proxy.onRequest listener is installed');
            return onRequestListener({url});
        },
        flushTimers: () => {
            const pending = calls.timers.splice(0, calls.timers.length);
            for (const t of pending) t.fn();
            return pending.length;
        },
    };
}
