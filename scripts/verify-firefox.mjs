#!/usr/bin/env node
/* ═══════════════════════════════════════════════════
   verify-firefox.mjs — drives the built Firefox package in a real Firefox.

   It copies dist/firefox to a temp directory, appends a verification script to
   that copy's background scripts (the shipped package is never modified), boots
   Firefox with web-ext, and then asserts on what actually reached the wire.

     npm run build && npm run verify:firefox

   Requires a local Firefox and the web-ext dev dependency.
   ═══════════════════════════════════════════════════ */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn, execSync} from 'node:child_process';
import {buildOne, options, ROOT} from './build.mjs';
import {TARGETS} from './targets.mjs';

const EXT_PORT = 18899;
const DEFAULT_PORT = 18901;
const TARGET_BASE = 'http://127.0.0.1:18900';
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 180000);

const events = [];
const wire = {ext: [], defaults: []};

function listen(port, label, log) {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const url = req.url;
            if (url.includes('/report')) {
                let body = '';
                req.on('data', c => body += c);
                req.on('end', () => {
                    events.push(body.trim());
                    res.writeHead(200, {'content-type': 'text/plain'});
                    res.end('ok');
                });
                return;
            }
            log.push(`${req.method} ${url}`);
            res.writeHead(200, {'content-type': 'text/plain', 'cache-control': 'no-store'});
            res.end(`proxied-by-${label}:${url}`);
        });
        server.on('connect', (req, socket) => {
            log.push(`CONNECT ${req.url}`);
            socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        });
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

const routed = entries => entries.filter(u => !u.includes('/report'));

const HARNESS = `/* appended by scripts/verify-firefox.mjs — never part of a shipped package */
const REPORT = 'http://127.0.0.1:${EXT_PORT}/report';
const send = (key, value) => fetch(\`\${REPORT}?k=\${encodeURIComponent(key)}\`, {
    method: 'POST', body: \`\${key}|\${JSON.stringify(value)}\`, cache: 'no-store',
}).catch(() => {});

async function grab(pathname) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
        const res = await fetch('${TARGET_BASE}/' + pathname, {cache: 'no-store', signal: ctrl.signal});
        return {status: res.status, body: (await res.text()).slice(0, 48)};
    } catch (e) {
        return {error: e.name};
    } finally {
        clearTimeout(timer);
    }
}

(async () => {
    const info = await chrome.runtime.getBrowserInfo();
    await send('browser', info);

    await chrome.storage.local.set({
        proxy_scope: 'all',
        exclude_urls: JSON.stringify(['${TARGET_BASE}/excluded*']),
        remove_cookies: false,
        remove_cache: false,
        reload_current_tab: false,
        reload_other_tabs: false,
    });

    await applyProxy({ip: '127.0.0.1', port: '${EXT_PORT}', protocol: 'http', user: '', pass: ''}, false);
    // Registering the filter is asynchronous in the browser process; warm it up
    // before measuring so the assertions describe the steady state.
    await grab('warmup');
    await new Promise(r => setTimeout(r, 500));
    await send('enabled.baseline', await grab('included'));
    await send('enabled.excluded', await grab('excluded-asset'));

    disableProxy();
    await new Promise(r => setTimeout(r, 300));
    await send('disabled.falls-back', await grab('after-disable'));

    await applyProxy({ip: '127.0.0.1', port: '${EXT_PORT}', protocol: 'http', user: '', pass: ''}, false);
    await send('reenabled', await grab('included-again'));
    disableProxy();

    await send('popup.locale.fetch', await (async () => {
        try {
            const res = await fetch(chrome.runtime.getURL('_locales/fa/messages.json'), {cache: 'no-store'});
            return {ok: res.ok, status: res.status};
        } catch (e) {
            return {error: String(e.message)};
        }
    })());

    await send('done', true);
})();
`;

const distFirefox = path.join(options.outDir, 'firefox');
if (!fs.existsSync(path.join(distFirefox, 'manifest.json'))) {
    const build = buildOne(TARGETS.firefox);
    if (!build.ok) {
        console.error('firefox package failed validation:', build.problems);
        process.exit(1);
    }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezdia-verify-'));
const copyDir = path.join(workDir, 'extension');
fs.cpSync(distFirefox, copyDir, {recursive: true});

const manifest = JSON.parse(fs.readFileSync(path.join(copyDir, 'manifest.json'), 'utf8'));
manifest.background.scripts = [...manifest.background.scripts, 'verify-harness.js'];
fs.writeFileSync(path.join(copyDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(copyDir, 'verify-harness.js'), HARNESS);

const extServer = await listen(EXT_PORT, 'ext', wire.ext);
const defaultServer = await listen(DEFAULT_PORT, 'default', wire.defaults);

const webExtEntry = path.join(ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
const child = spawn(process.execPath, [webExtEntry, 'run',
    '--source-dir', copyDir,
    '--target', 'firefox-desktop',
    '--no-reload', '--no-input',
    '--pref', 'network.proxy.type=1',
    '--pref', 'network.proxy.http=127.0.0.1',
    '--pref', `network.proxy.http_port=${DEFAULT_PORT}`,
    '--pref', 'network.proxy.share_proxy_settings=true',
    '--pref', 'network.proxy.no_proxies_on=',
    '--pref', 'network.proxy.allow_hijacking_localhost=true',
], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});

let stdout = '';
let exited = false;
child.stdout.on('data', d => stdout += d);
child.stderr.on('data', d => stdout += d);
child.on('close', () => {
    exited = true;
});

const kill = () => {
    if (process.platform === 'win32' && child.pid) {
        try {
            execSync(`taskkill /PID ${child.pid} /T /F`, {stdio: 'ignore'});
        } catch { /* already gone */ }
    } else {
        child.kill('SIGKILL');
    }
};

const outcome = await new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
        if (events.some(e => e.startsWith('done|'))) {
            clearInterval(timer);
            resolve('done');
        } else if (exited) {
            clearInterval(timer);
            resolve('web-ext-exited');
        } else if (Date.now() - started > TIMEOUT_MS) {
            clearInterval(timer);
            resolve('timeout');
        }
    }, 500);
});

await new Promise(resolve => setTimeout(resolve, 1500));
kill();
extServer.close();
defaultServer.close();
fs.rmSync(workDir, {recursive: true, force: true});

const report = Object.fromEntries(events.map(line => {
    const idx = line.indexOf('|');
    return [line.slice(0, idx), JSON.parse(line.slice(idx + 1))];
}));

const checks = [];
const expect = (name, ok, detail) => checks.push({name, ok, detail});

expect('firefox booted the package', Boolean(report.browser), `outcome=${outcome}`);
expect('proxy applied: included host reaches the extension proxy',
    report['enabled.baseline']?.body?.includes('proxied-by-ext'), JSON.stringify(report['enabled.baseline']));
expect('exclusion applied: excluded host bypasses the proxy entirely',
    report['enabled.excluded']?.error && routed(wire.ext).every(u => !u.includes('excluded')) && routed(wire.defaults).every(u => !u.includes('excluded')),
    JSON.stringify(report['enabled.excluded']));
expect('disable restores the browser default proxy',
    report['disabled.falls-back']?.body?.includes('proxied-by-default'), JSON.stringify(report['disabled.falls-back']));
expect('re-enable routes again',
    report['reenabled']?.body?.includes('proxied-by-ext'), JSON.stringify(report['reenabled']));
expect('popup can load locale files while the proxy is active',
    report['popup.locale.fetch']?.ok === true, JSON.stringify(report['popup.locale.fetch']));

console.log(`\nFirefox ${report.browser?.version ?? '?'} · outcome=${outcome}`);
console.log(`extension proxy routed: ${routed(wire.ext).length} requests`);
console.log(`default proxy routed:   ${routed(wire.defaults).length} requests\n`);

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? ' ok ' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        ${c.detail}`}`);
}

if (failed || outcome !== 'done') {
    console.log('\n--- web-ext output ---');
    console.log(stdout.slice(-2500));
}

console.log(`\n${checks.length - failed}/${checks.length} end-to-end checks passed`);
process.exit(failed || outcome !== 'done' ? 1 : 0);
