/* ═══════════════════════════════════════════════════
   Mezdia Proxy Switcher — Popup Script (Vanilla JS) v3.9.0
   ═══════════════════════════════════════════════════ */

// ── i18n Helpers ──

async function loadLocaleMap(lang) {
    if (!lang) return null;
    try {
        const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
        const res = await fetch(url);
        if (!res.ok) return null;
        const json = await res.json();
        const map = Object.entries(json).reduce((o, [k, v]) => (o[k] = v && v.message ? v.message : '', o), {});
        return map;
    } catch (e) {
        return null;
    }
}

/**
 * Get a translated message for a given key.
 */
function getMessage(map, key) {
    if (map && map[key]) return map[key];
    try { return chrome.i18n.getMessage(key) || ''; } catch { return ''; }
}

/**
 * Apply i18n to the entire document (only called ONCE on initial load).
 * This replaces __MSG_ placeholders in the static HTML.
 */
function applyI18n(map) {
    const html = document.documentElement;
    html.innerHTML = html.innerHTML.replace(/__MSG_(\w+)__/g, (_, key) => {
        return getMessage(map, key);
    });

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        const msg = getMessage(map, key);
        if (!msg) return;

        if (el instanceof HTMLInputElement) {
            if (el.placeholder) el.placeholder = msg;
            else if (el.value) el.value = msg;
        } else {
            el.innerHTML = msg;
        }
    });
}

/**
 * Apply i18n to a specific element only (for dynamic content).
 * This avoids destroying event listeners on the rest of the page.
 */
function applyI18nToElement(el, map) {
    if (!el) return;
    el.innerHTML = el.innerHTML.replace(/__MSG_(\w+)__/g, (_, key) => {
        return getMessage(map, key);
    });
}

async function applyLanguage(lang) {
    const html = document.documentElement;
    if (lang === 'fa' || lang === 'ar') {
        html.dir = 'rtl';
        html.lang = lang;
    } else if (lang) {
        html.dir = 'ltr';
        html.lang = lang;
    } else {
        // Auto: check browser language
        const browserLang = navigator.language || 'en';
        if (browserLang.startsWith('fa') || browserLang.startsWith('ar')) {
            html.dir = 'rtl';
        } else {
            html.dir = 'ltr';
        }
        html.lang = browserLang;
    }

    const map = await loadLocaleMap(lang);
    applyI18n(map);

    // After i18n, apply LTR force to technical elements
    applyLtrForce();
}

/**
 * In RTL mode, ensure technical elements remain LTR.
 */
function applyLtrForce() {
    const isRtl = document.documentElement.dir === 'rtl';

    const ltrSelectors = [
        '#import_proxy',
        '#exclude_urls_input',
        '#exclude_urls_box',
        '.help-content textarea',
    ];

    ltrSelectors.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) {
            el.dir = 'ltr';
            if (isRtl) el.classList.add('ltr-force');
        }
    });

    const proxyContainer = document.getElementById('proxy_list_container');
    if (proxyContainer) {
        proxyContainer.dir = 'ltr';
        if (isRtl) proxyContainer.classList.add('ltr-force');
    }
}


// ── Tab Navigation ──

function initTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;

            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            const pane = document.getElementById(`tab-${target}`);
            if (pane) pane.classList.add('active');

            // If switching to settings and group mode is active, refresh group status
            if (target === 'settings') {
                const scopeGroup = document.getElementById('scope_group');
                if (scopeGroup && scopeGroup.checked) {
                    refreshGroupStatus();
                }
            }
        });
    });
}

function switchTab(tabName) {
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (btn) btn.click();
}


// ── Help Toggle (Import Section) ──

function initHelpToggle() {
    const toggle = document.getElementById('helpToggle');
    const content = document.getElementById('helpContent');
    if (!toggle || !content) return;

    toggle.addEventListener('click', () => {
        toggle.classList.toggle('open');
        content.classList.toggle('open');
    });
}


// ── Tips Toggle (Settings Section) ──

function initTipsToggle() {
    const toggle = document.getElementById('tipsToggle');
    const content = document.getElementById('tipsContent');
    if (!toggle || !content) return;

    toggle.addEventListener('click', () => {
        toggle.classList.toggle('open');
        content.classList.toggle('open');
    });
}


// ── Theme ──

function applyThemeClass(theme) {
    const html = document.documentElement;
    if (theme === 'dark' || theme === '') {
        html.classList.remove('light');
    } else if (theme === 'light') {
        html.classList.add('light');
    } else {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        html.classList.toggle('light', !prefersDark);
    }
}


// ── Cached i18n map (avoid re-fetching) ──

let _cachedI18nMap = null;
let _cachedLang = '';

async function getI18nMap() {
    if (_cachedI18nMap) return _cachedI18nMap;
    try {
        const { lang } = await chrome.runtime.sendMessage({ action: 'get_option', key: ['lang'] });
        _cachedLang = lang || '';
        _cachedI18nMap = await loadLocaleMap(_cachedLang || navigator.language || 'en');
        return _cachedI18nMap;
    } catch {
        return null;
    }
}

/**
 * Get a translated string from the cached i18n map.
 * Falls back to chrome.i18n if not found in map.
 */
function t(key) {
    if (_cachedI18nMap && _cachedI18nMap[key]) return _cachedI18nMap[key];
    try { return chrome.i18n.getMessage(key) || key; } catch { return key; }
}


// ── Proxy List Rendering ──

async function createTableProxy() {
    const { proxy_list = '[]', proxy_current = '' } = await chrome.runtime.sendMessage({
        action: 'get_option',
        key: ['proxy_list', 'proxy_current'],
    });

    let list;
    try { list = JSON.parse(proxy_list); } catch { list = []; }

    let current;
    try { current = proxy_current ? JSON.parse(proxy_current) : null; } catch { current = null; }

    // Update import textarea
    const importArea = document.querySelector('[name="import_proxy"]');
    if (importArea) {
        importArea.value = list.flatMap(p => [
            ...(p.commentBefore ? [`# ${p.commentBefore}`] : []),
            `${p.user && p.pass ? `${p.user}:${p.pass}@` : ''}${p.ip}:${p.port}` + (p.commentAfter ? ` # ${p.commentAfter}` : '')
        ]).join('\n');
    }

    // Show/hide disable button
    const resetBtn = document.querySelector('button.resetProxy');
    if (resetBtn) {
        resetBtn.classList.toggle('d-none', !current);
    }

    const container = document.getElementById('proxy_list_container');
    if (!container) return;

    // Clear existing content
    container.innerHTML = '';

    if (!list.length) {
        // Create empty state — do NOT auto-switch tabs
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state';
        emptyDiv.innerHTML = `
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-icon">
                <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"/>
            </svg>
            <p>__MSG_TEXT_EMPTY_LIST__</p>`;

        // Apply i18n ONLY to the new element (not whole page!)
        const map = await getI18nMap();
        applyI18nToElement(emptyDiv, map);

        container.appendChild(emptyDiv);
        container.dir = 'ltr';
        if (document.documentElement.dir === 'rtl') container.classList.add('ltr-force');

        return;
    }

    const listDiv = document.createElement('div');
    listDiv.className = 'proxy-list';
    listDiv.dir = 'ltr';

    list.forEach(p => {
        const isCurrent = current && current.ip === p.ip && current.port === p.port && current.user === p.user && current.pass === p.pass;
        const after = p.commentAfter ?? '';

        if (p.commentBefore) {
            const commentDiv = document.createElement('div');
            commentDiv.className = 'proxy-comment';
            commentDiv.textContent = p.commentBefore;
            listDiv.appendChild(commentDiv);
        }

        const card = document.createElement('div');
        card.className = `proxy-card${isCurrent ? ' current' : ''}`;
        card.dataset.ip = p.ip;
        card.dataset.port = p.port;
        card.dataset.user = p.user || '';
        card.dataset.pass = p.pass || '';

        // Status dot
        const status = document.createElement('div');
        status.className = 'proxy-status';
        card.appendChild(status);

        // Info section
        const info = document.createElement('div');
        info.className = 'proxy-info';

        // Main line: ip:port
        const mainLine = document.createElement('div');
        mainLine.className = 'proxy-main';

        const ipSpan = document.createElement('span');
        ipSpan.className = 'proxy-ip';
        ipSpan.textContent = p.ip;
        mainLine.appendChild(ipSpan);

        const portSpan = document.createElement('span');
        portSpan.className = 'proxy-port';
        portSpan.textContent = p.port;
        mainLine.appendChild(portSpan);

        info.appendChild(mainLine);

        // Meta line: credentials + note
        const metaLine = document.createElement('div');
        metaLine.className = 'proxy-meta';

        if (p.user) {
            const creds = document.createElement('span');
            creds.className = 'proxy-credentials';
            creds.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> ${p.user}`;
            metaLine.appendChild(creds);
        }

        if (after) {
            const note = document.createElement('span');
            note.className = 'proxy-note';
            note.textContent = after;
            note.title = after;
            metaLine.appendChild(note);
        }

        info.appendChild(metaLine);
        card.appendChild(info);

        // Action button
        const action = document.createElement('button');
        action.className = 'proxy-action';
        action.title = isCurrent ? 'Disable' : 'Connect';
        if (isCurrent) {
            action.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`;
        } else {
            action.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        }
        card.appendChild(action);

        // Click handlers
        card.addEventListener('click', (e) => {
            if (isCurrent || e.target.closest('.proxy-action')) {
                disableProxyAction();
            } else {
                selectProxyAction(card);
            }
        });

        listDiv.appendChild(card);
    });

    container.appendChild(listDiv);
    container.dir = 'ltr';
}

async function selectProxyAction(card) {
    try {
        const result = await chrome.runtime.sendMessage({
            action: 'set_proxy',
            data: {
                ip: card.dataset.ip,
                port: card.dataset.port,
                user: card.dataset.user,
                pass: card.dataset.pass,
            },
        });

        if (result && result.status === 'error') {
            console.error('[Mezdia] Failed to set proxy:', result.message);
        }
    } catch (e) {
        console.error('[Mezdia] selectProxyAction error:', e);
    }

    await createTableProxy();
    // Refresh group status if in group mode
    const scopeGroup = document.getElementById('scope_group');
    if (scopeGroup && scopeGroup.checked) {
        refreshGroupStatus();
    }
}

async function disableProxyAction() {
    try {
        await chrome.runtime.sendMessage({ action: 'disable_proxy' });
    } catch (e) {
        console.error('[Mezdia] disableProxyAction error:', e);
    }
    await createTableProxy();
}


// ── Proxy Scope ──

function initProxyScope(stored) {
    const scopeAll = document.getElementById('scope_all');
    const scopeGroup = document.getElementById('scope_group');
    if (!scopeAll || !scopeGroup) return;

    const scope = stored.proxy_scope || 'all';
    if (scope === 'group') {
        scopeGroup.checked = true;
    } else {
        scopeAll.checked = true;
    }

    // Show/hide group-specific UI
    toggleGroupUI(scope === 'group');

    [scopeAll, scopeGroup].forEach(radio => {
        radio.addEventListener('change', async function () {
            const val = this.value;
            await chrome.runtime.sendMessage({ action: 'set_option', key: 'proxy_scope', val: val });
            toggleGroupUI(val === 'group');

            // If there's an active proxy, re-apply it with the new scope
            // The service worker handles this in the set_option handler
            // But we also refresh the UI here
            if (val === 'group') {
                refreshGroupStatus();
            }
        });
    });
}

function toggleGroupUI(isGroup) {
    const statusPanel = document.getElementById('group_status_panel');
    const tipsSection = document.getElementById('group_tips_section');

    if (statusPanel) {
        statusPanel.classList.toggle('d-none', !isGroup);
    }
    if (tipsSection) {
        tipsSection.classList.toggle('d-none', !isGroup);
    }

    if (isGroup) {
        refreshGroupStatus();
    }
}


// ── Group Status (FULLY TRANSLATED) ──

async function refreshGroupStatus() {
    const statusBody = document.getElementById('group_status_body');
    if (!statusBody) return;

    // Ensure i18n map is loaded
    await getI18nMap();

    try {
        const info = await chrome.runtime.sendMessage({ action: 'get_group_status' });

        statusBody.innerHTML = '';

        // Group existence row
        const groupRow = document.createElement('div');
        groupRow.className = 'group-status-row';

        const groupLabel = document.createElement('span');
        groupLabel.className = 'label';
        groupLabel.textContent = t('TEXT_GRP_LABEL');

        const groupValue = document.createElement('span');
        groupValue.className = 'value ' + (info.exists ? 'success' : 'danger');
        groupValue.textContent = info.exists ? t('TEXT_GRP_ACTIVE') : t('TEXT_GRP_NOT_FOUND');

        groupRow.appendChild(groupLabel);
        groupRow.appendChild(groupValue);
        statusBody.appendChild(groupRow);

        // Tab count row
        const tabRow = document.createElement('div');
        tabRow.className = 'group-status-row';

        const tabLabel = document.createElement('span');
        tabLabel.className = 'label';
        tabLabel.textContent = t('TEXT_GRP_TABS');

        const tabValue = document.createElement('span');
        tabValue.className = 'value ' + (info.tabs.length > 0 ? 'success' : 'warning');
        tabValue.textContent = String(info.tabs.length);

        tabRow.appendChild(tabLabel);
        tabRow.appendChild(tabValue);
        statusBody.appendChild(tabRow);

        // Domain list
        if (info.domains.length > 0) {
            const domainHeader = document.createElement('div');
            domainHeader.className = 'group-status-row';

            const dLabel = document.createElement('span');
            dLabel.className = 'label';
            dLabel.textContent = t('TEXT_GRP_DOMAINS');

            const dValue = document.createElement('span');
            dValue.className = 'value';
            dValue.textContent = String(info.domains.length);

            domainHeader.appendChild(dLabel);
            domainHeader.appendChild(dValue);
            statusBody.appendChild(domainHeader);

            const domainPills = document.createElement('div');
            domainPills.className = 'group-domain-pills';

            info.domains.forEach(domain => {
                const pill = document.createElement('span');
                pill.className = 'group-domain-item';
                pill.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/></svg>${domain}`;
                domainPills.appendChild(pill);
            });

            statusBody.appendChild(domainPills);
        } else {
            const noDomains = document.createElement('div');
            noDomains.className = 'group-no-domains';
            noDomains.textContent = t('TEXT_GRP_NO_DOMAINS');
            statusBody.appendChild(noDomains);
        }

        // Show/hide create group button
        const createBtn = document.getElementById('create_group_btn');
        if (createBtn) {
            createBtn.classList.toggle('d-none', info.exists);
        }

    } catch (e) {
        statusBody.innerHTML = `<div class="group-no-domains">${t('TEXT_GRP_ERROR')}</div>`;
    }
}


// ── Create Mezdia Group ──

function initCreateGroupBtn() {
    const btn = document.getElementById('create_group_btn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        const originalText = btn.querySelector('span').textContent;

        try {
            const result = await chrome.runtime.sendMessage({ action: 'create_mezdia_group' });
            if (result.status === 'ok') {
                btn.querySelector('span').textContent = t('TEXT_GRP_CREATED');
                btn.classList.add('btn-primary');
                btn.classList.remove('btn-outline');
                await refreshGroupStatus();
                setTimeout(() => {
                    btn.querySelector('span').textContent = originalText;
                    btn.classList.remove('btn-primary');
                    btn.classList.add('btn-outline');
                    btn.disabled = false;
                }, 2000);
            } else {
                btn.querySelector('span').textContent = t('TEXT_GRP_ERROR');
                setTimeout(() => {
                    btn.querySelector('span').textContent = originalText;
                    btn.disabled = false;
                }, 2000);
            }
        } catch (e) {
            btn.querySelector('span').textContent = t('TEXT_GRP_ERROR');
            setTimeout(() => {
                btn.querySelector('span').textContent = originalText;
                btn.disabled = false;
            }, 2000);
        }
    });
}


// ── Exclude URLs Tag-Box Helpers ──

// Global state for exclude tags (must be global so helper functions can access it)
let excludeTags = [];

function addExcludeTags(text) {
    if (!text) return;
    // Split by comma, newline, or semicolon; trim spaces; filter empty
    const newEntries = text.split(/[,\n;]+/)
        .map(s => s.trim().toLowerCase())
        .filter(s => s.length > 0);

    // Remove protocol prefix if user pasted full URLs (we match by domain)
    const cleaned = newEntries.map(e => {
        try {
            // If it looks like a URL, extract hostname
            if (e.startsWith('http://') || e.startsWith('https://')) {
                return new URL(e).hostname;
            }
        } catch {}
        return e;
    });

    // Add only unique entries
    let changed = false;
    for (const entry of cleaned) {
        if (!excludeTags.includes(entry)) {
            excludeTags.push(entry);
            changed = true;
        }
    }
    if (changed) {
        renderExcludeTags();
        saveExcludeTags();
    }
}

function removeExcludeTag(index) {
    excludeTags.splice(index, 1);
    renderExcludeTags();
    saveExcludeTags();
}

function renderExcludeTags() {
    const container = document.getElementById('exclude_urls_tags');
    if (!container) return;
    container.innerHTML = '';
    excludeTags.forEach((tag, index) => {
        const tagEl = document.createElement('span');
        tagEl.className = 'tag-item';
        tagEl.innerHTML = `<span class="tag-text">${tag}</span><button type="button" class="tag-remove" data-index="${index}" title="Remove">&times;</button>`;
        container.appendChild(tagEl);
    });
    // Attach remove handlers
    container.querySelectorAll('.tag-remove').forEach(btn => {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const idx = parseInt(this.dataset.index);
            removeExcludeTag(idx);
        });
    });
}

function saveExcludeTags() {
    chrome.runtime.sendMessage({ action: 'set_option', key: 'exclude_urls', val: JSON.stringify(excludeTags) }, () => {
        // After saving, re-apply the current proxy so the PAC script gets updated
        chrome.runtime.sendMessage({ action: 'reapply_proxy' });
    });
}


// ── Init ──

document.addEventListener('DOMContentLoaded', async () => {
    const stored = await chrome.runtime.sendMessage({ action: 'get_option' });

    // Apply language (this does the initial full-page i18n, once)
    await applyLanguage(stored.lang || '');

    // Cache the i18n map for dynamic content
    await getI18nMap();

    // Apply theme
    applyThemeClass(stored.theme || '');

    // Initialize tabs (AFTER i18n so DOM is finalized)
    initTabs();

    // Initialize help toggle
    initHelpToggle();

    // Initialize tips toggle
    initTipsToggle();

    // Initialize proxy scope
    initProxyScope(stored);

    // Initialize create group button
    initCreateGroupBtn();

    // Proxy list
    await createTableProxy();

    // Apply LTR force after everything is loaded
    applyLtrForce();

    // ── Event Listeners ──

    // Disable proxy button
    const resetBtn = document.querySelector('button.resetProxy');
    if (resetBtn) {
        resetBtn.addEventListener('click', disableProxyAction);
    }

    // Save proxy (import)
    const saveBtn = document.querySelector('.saveProxy');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const importArea = document.querySelector('[name="import_proxy"]');
            await chrome.runtime.sendMessage({
                action: 'save_proxylist_from_import',
                data: importArea ? importArea.value.trim() : '',
            });
            await createTableProxy();
            switchTab('list');
        });
    }

    // Settings checkboxes
    const optionKeys = ['reload_current_tab', 'reload_other_tabs', 'remove_cookies', 'remove_cache'];
    optionKeys.forEach(key => {
        const el = document.getElementById(key);
        if (!el) return;
        el.checked = !!stored[key];
        el.addEventListener('change', function () {
            chrome.runtime.sendMessage({ action: 'set_option', key: this.id, val: this.checked });
        });
    });

    // Exclude URLs — Tag Box (populate global excludeTags)
    try {
        const raw = stored.exclude_urls || '[]';
        let parsed;
        try {
            parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) parsed = [];
        } catch {
            // Backward compat: old format was newline-separated string
            parsed = String(raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        }
        excludeTags = parsed;
    } catch {
        excludeTags = [];
    }

    renderExcludeTags();

    const excludeInput = document.getElementById('exclude_urls_input');
    const excludeBox = document.getElementById('exclude_urls_box');

    // Click on tag-box should focus the input
    if (excludeBox && excludeInput) {
        excludeBox.addEventListener('click', function (e) {
            if (e.target === excludeBox || e.target.closest('.tag-list')) {
                excludeInput.focus();
            }
        });
    }

    if (excludeInput) {
        excludeInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addExcludeTags(this.value);
                this.value = '';
            }
            if (e.key === 'Backspace' && !this.value && excludeTags.length > 0) {
                excludeTags.pop();
                renderExcludeTags();
                saveExcludeTags();
            }
        });

        // Also handle paste (comma or newline separated)
        excludeInput.addEventListener('paste', function (e) {
            e.preventDefault();
            const paste = (e.clipboardData || window.clipboardData).getData('text');
            addExcludeTags(paste);
            this.value = '';
        });
    }

    // Language selector — save and reload popup
    const langSelect = document.getElementById('language_select');
    if (langSelect) {
        langSelect.value = stored.lang || '';
        langSelect.addEventListener('change', function () {
            const v = this.value || '';
            // Save the new language, then reload the popup to apply it
            chrome.runtime.sendMessage({ action: 'set_option', key: 'lang', val: v }, () => {
                // Reload the popup so it re-initializes with the new language
                location.reload();
            });
        });
    }

    // Theme toggle
    const themeBtn = document.getElementById('theme_toggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', async () => {
            const html = document.documentElement;
            const isLight = html.classList.contains('light');
            const newTheme = isLight ? '' : 'light';
            await chrome.runtime.sendMessage({ action: 'set_option', key: 'theme', val: newTheme });
            applyThemeClass(newTheme);
        });
    }

    // Copyright link
    const copyrightLink = document.getElementById('copyright_link');
    if (copyrightLink) {
        copyrightLink.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: copyrightLink.href });
        });
    }

    // Save button in settings
    const settingsSaveBtn = document.querySelector('.settings-save');
    if (settingsSaveBtn) {
        settingsSaveBtn.addEventListener('click', async () => {
            // Tags are already saved on each change; this button is for visual feedback
            settingsSaveBtn.style.transform = 'scale(0.97)';
            setTimeout(() => { settingsSaveBtn.style.transform = ''; }, 150);
        });
    }

    // Show body
    document.body.style.display = '';
});



