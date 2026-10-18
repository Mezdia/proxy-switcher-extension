#!/usr/bin/env node
/* ═══════════════════════════════════════════════════
   check.mjs — verifies the packages and that the Gecko proxy engine takes the
   same routing decisions as the shipped Blink PAC script.

   node scripts/check.mjs
   ═══════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildOne, collectTarget, options, packageEntries, ROOT, sourceManifest, validate} from './build.mjs';
import {createRuntime, evaluatePac} from './harness.mjs';
import {createZip, readZip} from './zip.mjs';
import {TARGETS, TARGET_IDS} from './targets.mjs';

const results = [];
const record = (suite, name, ok, detail = '') => results.push({suite, name, ok, detail});

function assert(suite, name, condition, detail = '') {
    record(suite, name, Boolean(condition), condition ? '' : detail);
}

function equals(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.join() === kb.join() && ka.every(k => equals(a[k], b[k]));
}

/* ── 1. Packages: transforms, structure, referenced files ── */

const source = sourceManifest();
const builds = {};

for (const id of TARGET_IDS) {
    const target = TARGETS[id];
    const build = buildOne(target);
    builds[id] = build;
    assert('package', `${id} builds`, build.ok, (build.problems ?? []).join('; '));
    if (!build.ok) continue;

    const {manifest, entries} = build;
    assert('package', `${id} keeps the version`, manifest.version === source.version,
        `manifest ${manifest.version} != source ${source.version}`);
    assert('package', `${id} has all four locales`,
        ['en', 'fa', 'ar', 'ru'].every(l => entries.some(e => e.name === `_locales/${l}/messages.json`)));
    assert('package', `${id} ships no build tooling`,
        !entries.some(e => e.name.startsWith('scripts/') || e.name.startsWith('node_modules/') || e.name.startsWith('.git')));

    // Line endings are part of the package bytes: a CRLF checkout would ship a
    // different archive than an LF one, so text files must arrive normalized.
    const crlf = entries.filter(e => /\.(?:js|json|html|css|svg)$/.test(e.name) && e.data.includes('\r'))
        .map(e => e.name);
    assert('package', `${id} text files are LF normalized`, crlf.length === 0, `CRLF found in: ${crlf.join(', ')}`);

    if (target.engine === 'gecko') {
        assert('package', 'firefox uses background.scripts',
            manifest.background.scripts?.[0] === 'assets/js/sw.js' && !manifest.background.service_worker);
        assert('package', 'firefox drops the tabGroups permission', !manifest.permissions.includes('tabGroups'));
        assert('package', 'firefox keeps proxy auth', manifest.permissions.includes('webRequestAuthProvider'));
        assert('package', 'firefox grants tabs (Gecko hides tab.url otherwise)', manifest.permissions.includes('tabs'));
        assert('package', 'firefox pins a minimum Gecko version',
            manifest.browser_specific_settings.gecko.strict_min_version === '121.0');
        assert('package', 'firefox declares an add-on id (AMO requires it for MV3)',
            /@/.test(manifest.browser_specific_settings.gecko.id ?? ''),
            `id=${manifest.browser_specific_settings.gecko.id}`);
    } else {
        assert('package', `${id} manifest is byte-identical to the source manifest`,
            JSON.stringify(manifest) === JSON.stringify(source));
    }
}

/* ── 2. Blink packages must not mutate the shipped code ── */

for (const id of ['chrome', 'edge']) {
    const build = builds[id];
    if (!build?.ok) continue;
    const drifted = build.entries.filter(entry => {
        if (entry.name === 'manifest.json') return false;
        const onDisk = fs.readFileSync(path.join(ROOT, entry.name));
        return Buffer.compare(onDisk, entry.data) !== 0;
    }).map(e => e.name);
    assert('blink parity', `${id} sources are unmodified`, drifted.length === 0, `drifted: ${drifted.join(', ')}`);
}

const chromeBuild = builds.chrome;
const firefoxBuild = builds.firefox;
if (chromeBuild?.ok && firefoxBuild?.ok) {
    const chromeNames = chromeBuild.entries.map(e => e.name).sort();
    const firefoxNames = firefoxBuild.entries.map(e => e.name).sort();
    assert('firefox parity', 'same file set as chrome', chromeNames.join() === firefoxNames.join(),
        `chrome=${chromeNames.length} firefox=${firefoxNames.length}`);

    const codeDiffers = firefoxBuild.entries.filter(entry => {
        const other = chromeBuild.entries.find(e => e.name === entry.name);
        return other && Buffer.compare(other.data, entry.data) !== 0;
    }).map(e => e.name);
    assert('firefox parity', 'only manifest.json differs', codeDiffers.join() === 'manifest.json',
        `differing: ${codeDiffers.join(', ') || '(none)'}`);
}

/* ── 3. Archives round-trip and open in an independent tool ── */

const pkgDir = path.join(options.outDir, 'packages');
for (const id of TARGET_IDS) {
    const build = builds[id];
    if (!build?.ok) continue;
    const file = path.join(pkgDir, build.archiveName);
    assert('archive', `${id} archive written`, fs.existsSync(file), file);
    if (!fs.existsSync(file)) continue;

    let entries = [];
    try {
        entries = readZip(fs.readFileSync(file));
    } catch (e) {
        record('archive', `${id} archive integrity`, false, String(e.message));
        continue;
    }
    record('archive', `${id} archive integrity`, true, `${entries.length} entries`);
    assert('archive', `${id} has a root manifest`, entries.some(e => e.name === 'manifest.json'));
    assert('archive', `${id} has no parent traversal`, !entries.some(e => e.name.includes('..')));
    assert('archive', `${id} entries match the build`,
        entries.map(e => e.name).sort().join() === build.entries.map(e => e.name).sort().join());
}

try {
    execFileSync('python', ['-c', 'import zipfile'], {stdio: 'ignore'});
    for (const id of TARGET_IDS) {
        const build = builds[id];
        if (!build?.ok) continue;
        execFileSync('python', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(r'${path.join(pkgDir, build.archiveName)}')
bad=z.testzip()
sys.exit(1 if bad else 0)
`], {stdio: 'pipe'});
        record('archive', `${id} passes python zipfile`, true);
    }
} catch (e) {
    if (e.code === 'ENOENT') record('archive', 'python zipfile cross-check', true, 'skipped: python not on PATH');
    else record('archive', 'python zipfile cross-check', false, String(e.message));
}

/* ── 4. Messages are complete and consistent across locales ── */

const locales = ['en', 'fa', 'ar', 'ru'];
const messageMaps = {};
for (const loc of locales) {
    const file = path.join(ROOT, '_locales', loc, 'messages.json');
    try {
        messageMaps[loc] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        record('i18n', `${loc} messages parse`, false, String(e.message));
    }
}

if (Object.keys(messageMaps).length === locales.length) {
    const baseline = Object.keys(messageMaps.en).sort().join();
    for (const loc of locales.slice(1)) {
        assert('i18n', `${loc} has the same keys as en`, Object.keys(messageMaps[loc]).sort().join() === baseline);
    }

    const referenced = new Set();
    const scanFile = (name) => {
        const text = fs.readFileSync(path.join(ROOT, name), 'utf8');
        for (const m of text.matchAll(/__MSG_(\w+)__/g)) referenced.add(m[1]);
    };
    for (const name of ['manifest.json', 'popup.html', 'options.html', 'assets/js/popup.js', 'assets/js/options.js', 'assets/js/sw.js']) scanFile(name);

    const missing = [...referenced].filter(key => !locales.every(l => messageMaps[l][key]?.message));
    assert('i18n', `all ${referenced.size} referenced messages exist`, missing.length === 0, `missing: ${missing.join(', ')}`);

    const empty = locales.flatMap(l => Object.entries(messageMaps[l]).filter(([, v]) => !v.message).map(([k]) => `${l}/${k}`));
    assert('i18n', 'no empty messages', empty.length === 0, empty.join(', '));
}

/* ── 5. Engine parity: the Gecko policy must route exactly like the shipped PAC ── */

const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/pac-cases.json'), 'utf8'));

function expectedProxyInfo({ip, port, protocol, user, pass}) {
    const type = protocol === 'socks5' ? 'socks' : protocol;
    const info = {type, host: ip, port: Number(port)};
    if (type === 'socks') {
        info.proxyDNS = true;
        if (user && pass) {
            info.username = user;
            info.password = pass;
        }
    }
    return info;
}

for (const testCase of golden.cases) {
    const tabs = [
        ...testCase.group_tabs.map(t => ({...t, groupId: 7})),
        ...testCase.other_tabs.map(t => ({...t, groupId: -1})),
    ];
    const storage = {
        proxy_scope: testCase.scope,
        exclude_urls: testCase.exclude_urls,
        proxy_current: '',
        ...(testCase.group_tabs.length ? {mezdia_group_id: 7} : {}),
    };

    const blink = createRuntime('blink', {tabs, storage});
    const gecko = createRuntime('gecko', {tabs, storage});

    await blink.sandbox.applyProxy(testCase.proxy, false);
    await gecko.sandbox.applyProxy(testCase.proxy, false);

    const pac = blink.calls.pacScripts.at(-1);
    const want = expectedProxyInfo(testCase.proxy);

    if (!pac) {
        record('parity', testCase.name, false, 'the Blink runtime produced no PAC script');
        continue;
    }

    const failures = [];
    for (const [url, decision] of Object.entries(testCase.decisions)) {
        const actualPac = evaluatePac(pac, url);
        if (actualPac !== decision) failures.push(`PAC ${url}: got ${actualPac}, golden ${decision}`);

        const geckoResult = await gecko.routeUrl(url);
        if (decision === 'DIRECT') {
            if (geckoResult !== null) failures.push(`gecko ${url}: got ${JSON.stringify(geckoResult)}, expected null (direct)`);
        } else if (!equals(geckoResult, want)) {
            failures.push(`gecko ${url}: got ${JSON.stringify(geckoResult)}, expected ${JSON.stringify(want)}`);
        }
    }

    record('parity', `${testCase.name} (${Object.keys(testCase.decisions).length} urls)`,
        failures.length === 0, failures.join(' / '));

    // Disabling must remove the filter again, restoring the browser's own configuration.
    gecko.sandbox.disableProxy();
    assert('parity', `${testCase.name} removes the Gecko filter on disable`,
        gecko.calls.onRequestAdded === 1 && gecko.calls.onRequestRemoved === 1,
        `added=${gecko.calls.onRequestAdded} removed=${gecko.calls.onRequestRemoved}`);
}

/* ── 6. The Blink path keeps using the PAC settings API ── */

{
    const blink = createRuntime('blink', {tabs: [], storage: {proxy_scope: 'all', exclude_urls: '[]'}});
    await blink.sandbox.applyProxy({ip: '10.0.0.1', port: '8080', protocol: 'http', user: '', pass: ''}, false);
    assert('runtime', 'blink sets pac_script through proxy.settings',
        blink.calls.proxySettings.length === 1 && blink.calls.proxySettings[0].value.mode === 'pac_script');
    assert('runtime', 'blink registers the blocking auth listener', blink.calls.authRequired === 1);

    const gecko = createRuntime('gecko', {tabs: [], storage: {proxy_scope: 'all', exclude_urls: '[]'}});
    await gecko.sandbox.applyProxy({ip: '10.0.0.1', port: '8080', protocol: 'http', user: '', pass: ''}, false);
    assert('runtime', 'gecko never calls proxy.settings', gecko.calls.proxySettings.length === 0);
    assert('runtime', 'gecko installs one proxy.onRequest filter', gecko.calls.onRequestAdded === 1);
    assert('runtime', 'gecko still answers proxy auth challenges', gecko.calls.authRequired === 1);

    // Re-applying (group refresh, exclusion edits) must not stack listeners.
    await gecko.sandbox.applyProxy({ip: '10.0.0.2', port: '8080', protocol: 'http', user: '', pass: ''}, false);
    assert('runtime', 're-applying does not add a second Gecko filter', gecko.calls.onRequestAdded === 1);

    // Every message the popup can send must be answered.
    const replies = [];
    const respond = value => replies.push(value);
    const actions = [
        {action: 'get_option', key: ['lang']},
        {action: 'set_option', key: 'exclude_urls', val: '[]'},
        {action: 'save_proxylist', data: []},
        {action: 'save_proxylist_from_import', data: ''},
        {action: 'get_group_status'},
        {action: 'disable_proxy'},
        {action: 'refresh_group_proxy'},
        {action: 'unknown_action'},
    ];
    for (const action of actions) {
        const keepAlive = gecko.calls.messageListener(action, {}, respond);
        assert('runtime', `gecko responds to ${action.action}`, keepAlive === true || action.action === 'unknown_action',
            `listener returned ${keepAlive}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert('runtime', 'every routed message produced a response',
        replies.filter(r => r !== undefined).length >= actions.length - 1, JSON.stringify(replies));
}

/* ── 7. A woken Gecko background must not answer before it knows the policy ── */

{
    const storage = {
        proxy_scope: 'all',
        exclude_urls: JSON.stringify(['skip.example']),
        proxy_current: '',
    };
    const warm = createRuntime('gecko', {tabs: [], storage});
    await warm.sandbox.applyProxy({ip: '10.0.0.1', port: '8080', protocol: 'http', user: '', pass: ''}, false);

    const snapshot = JSON.parse(warm.store['gecko_policy'] ?? 'null');
    assert('gecko wake-up', 'the policy is mirrored into storage',
        snapshot?.proxyInfo?.host === '10.0.0.1' && snapshot?.domains?.join() === 'skip.example',
        JSON.stringify(warm.store['gecko_policy']));

    // A woken background holds the persistent filter but no in-memory policy:
    // nothing may be claimed until the snapshot has been read back.
    const cold = createRuntime('gecko', {tabs: [], storage: {...storage, gecko_policy: warm.store['gecko_policy']}});
    assert('gecko wake-up', 'nothing is claimed before the snapshot is read',
        cold.sandbox.decideGecko('http://included.example/x') === undefined);
    await cold.sandbox.restoreGeckoPolicy();
    assert('gecko wake-up', 'included host routes after the snapshot is read',
        equals(cold.sandbox.decideGecko('http://included.example/x'), {type: 'http', host: '10.0.0.1', port: 8080}),
        JSON.stringify(cold.sandbox.decideGecko('http://included.example/x')));
    assert('gecko wake-up', 'excluded host still bypasses after the snapshot is read',
        cold.sandbox.decideGecko('http://skip.example/x') === null);

    warm.sandbox.disableProxy();
    assert('gecko wake-up', 'disabling clears the stored snapshot', !('gecko_policy' in warm.store),
        JSON.stringify(warm.store['gecko_policy']));
}

/* ── 8. Version bookkeeping ── */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert('version', 'package.json matches the manifest', pkg.version === source.version,
    `package ${pkg.version} vs manifest ${source.version}`);

/* ── Report ── */

const bySuite = new Map();
for (const r of results) {
    if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
    bySuite.get(r.suite).push(r);
}

let failed = 0;
for (const [suite, items] of bySuite) {
    const bad = items.filter(i => !i.ok);
    failed += bad.length;
    console.log(`${bad.length ? 'FAIL' : ' ok '}  ${suite.padEnd(14)} ${items.length - bad.length}/${items.length}`);
    for (const b of bad) console.log(`        - ${b.name}${b.detail ? `\n          ${b.detail}` : ''}`);
}

console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
