#!/usr/bin/env node
/* ═══════════════════════════════════════════════════
   build.mjs — packages the extension for every supported engine.

   node scripts/build.mjs                      # all targets
   node scripts/build.mjs --target=firefox     # one target
   node scripts/build.mjs --gecko-id=<amo id>  # pin the Firefox add-on id
   ═══════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createZip} from './zip.mjs';
import {TARGETS, TARGET_IDS} from './targets.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
    const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
}

export const options = {
    outDir: path.resolve(ROOT, arg('out', 'dist')),
    geckoAddonId: arg('gecko-id', process.env.GECKO_ADDON_ID || null),
    dist: arg('dist', 'true') !== 'false',
};

export const sourceManifest = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(path.join(ROOT, dir), {withFileTypes: true})) {
        const name = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...walk(name));
        else if (entry.isFile()) out.push({name, data: fs.readFileSync(path.join(ROOT, name))});
    }
    return out;
}

/** Assemble one target: shared sources first, then the declared manifest transform. */
export function collectTarget(target, {geckoAddonId = options.geckoAddonId} = {}) {
    const manifest = target.manifest(sourceManifest(), {geckoAddonId});

    const sourceFiles = [
        ...target.dirs.flatMap(walk),
        ...target.rootFiles.filter(name => name !== 'manifest.json')
            .map(name => ({name, data: fs.readFileSync(path.join(ROOT, name))})),
        {name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')},
    ];

    return {
        manifest,
        files: new Map(sourceFiles.map(file => [file.name, file.data])),
        version: manifest.version,
    };
}

/** Every path the manifest or a shipped page references must exist in the package. */
export function validate(target, manifest, files) {
    const problems = [];
    const referenced = new Set();

    for (const group of [manifest.icons, manifest.action?.default_icon]) {
        for (const p of Object.values(group ?? {})) referenced.add(p);
    }
    for (const p of manifest.background?.scripts ?? []) referenced.add(p);
    if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
    for (const p of [manifest.options_page, manifest.options_ui?.page, manifest.action?.default_popup]) {
        if (p) referenced.add(p);
    }

    for (const [name, data] of files) {
        if (!name.endsWith('.html') && !name.endsWith('.css')) continue;
        const text = data.toString('utf8');
        const base = path.posix.dirname(name);

        for (const m of text.matchAll(/<(?:script|img)\s+[^>]*\bsrc="([^"]+)"|<link[^>]*\bhref="([^"]+)"/g)) {
            const ref = m[1] ?? m[2];
            if (/^(?:https?:|data:|blob:|chrome:|moz-extension:|about:)/.test(ref)) continue;
            referenced.add(path.posix.normalize(ref.startsWith('/') ? ref.slice(1) : `${base}/${ref}`));
        }
        for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
            const ref = m[1];
            if (/^(?:https?:|data:)/.test(ref)) continue;
            referenced.add(path.posix.normalize(`${base}/${ref}`));
        }
    }

    for (const ref of referenced) {
        if (ref.includes('..')) problems.push(`path traversal in reference: ${ref}`);
        else if (!files.has(ref)) problems.push(`referenced file missing: ${ref}`);
    }

    if (!manifest.version || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
        problems.push(`invalid version: ${manifest.version}`);
    }

    const defaultMessageFile = `_locales/${manifest.default_locale}/messages.json`;
    if (manifest.default_locale && !files.has(defaultMessageFile)) {
        problems.push(`default_locale messages missing: ${defaultMessageFile}`);
    }

    if (target.engine === 'gecko') {
        if (manifest.background?.service_worker) problems.push('Gecko target must not declare background.service_worker');
        if (!manifest.background?.scripts?.length) problems.push('Gecko target needs background.scripts');
        if ((manifest.permissions || []).includes('tabGroups')) problems.push('Gecko target must not request tabGroups');
        if (!manifest.browser_specific_settings?.gecko) problems.push('Gecko target lacks browser_specific_settings.gecko');
    } else {
        if (manifest.browser_specific_settings) problems.push('Blink target must not carry browser_specific_settings');
        if (!manifest.background?.service_worker) problems.push('Blink target needs background.service_worker');
        if (manifest.background?.scripts) problems.push('Blink target must not declare background.scripts');
    }

    return problems;
}

export const packageEntries = files => [...files.entries()]
    .map(([name, data]) => ({name, data}))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

export function buildOne(target) {
    const {manifest, files, version} = collectTarget(target);
    const entries = packageEntries(files);
    const problems = validate(target, manifest, files);
    if (problems.length) return {target: target.id, ok: false, problems};

    if (options.dist) {
        const distDir = path.join(options.outDir, target.id);
        fs.rmSync(distDir, {recursive: true, force: true});
        for (const {name, data} of entries) {
            const abs = path.join(distDir, name);
            fs.mkdirSync(path.dirname(abs), {recursive: true});
            fs.writeFileSync(abs, data);
        }
    }

    const archiveName = `mezdia-proxy-switcher-${target.id}-v${version}.${target.artifact}`;
    const zip = createZip(entries);
    fs.mkdirSync(path.join(options.outDir, 'packages'), {recursive: true});
    fs.writeFileSync(path.join(options.outDir, 'packages', archiveName), zip);

    return {
        target: target.id,
        label: target.label,
        engine: target.engine,
        ok: true,
        version,
        manifest,
        entries,
        files: entries.length,
        uncompressed: entries.reduce((n, e) => n + e.data.length, 0),
        archiveName,
        bytes: zip.length,
        sha256: crypto.createHash('sha256').update(zip).digest('hex'),
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const requested = arg('target', 'all');
    const ids = requested === 'all' ? TARGET_IDS : requested.split(',');
    const unknown = ids.filter(id => !TARGETS[id]);
    if (unknown.length) {
        console.error(`Unknown target(s): ${unknown.join(', ')} — known: ${TARGET_IDS.join(', ')}`);
        process.exit(2);
    }

    const report = ids.map(id => buildOne(TARGETS[id]));

    fs.mkdirSync(path.join(options.outDir, 'packages'), {recursive: true});
    fs.writeFileSync(path.join(options.outDir, 'packages', 'BUILD-INFO.json'), JSON.stringify({
        generatedBy: 'scripts/build.mjs',
        node: process.version,
        geckoAddonId: options.geckoAddonId,
        builds: report.map(({manifest, entries, ...summary}) => summary),
    }, null, 2) + '\n', 'utf8');

    let failed = false;
    for (const r of report) {
        if (!r.ok) {
            failed = true;
            console.error(`✗ ${r.target}`);
            for (const p of r.problems) console.error(`    ${p}`);
            continue;
        }
        console.log(`✓ ${r.target.padEnd(8)} ${r.engine.padEnd(7)} v${r.version}  ${String(r.files).padStart(3)} files  ` +
            `${(r.uncompressed / 1024).toFixed(1)} KiB → ${(r.bytes / 1024).toFixed(1)} KiB  ${r.archiveName}`);
        console.log(`    sha256 ${r.sha256}`);
    }

    if (failed) process.exit(1);
}
