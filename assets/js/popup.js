/* ═══════════════════════════════════════════════════
   Mezdia Proxy Switcher — Popup Script (Vanilla JS) v4.0
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

function getMessage(map, key) {
    if (map && map[key]) return map[key];
    try { return chrome.i18n.getMessage(key) || ''; } catch { return ''; }
}

const MSG_PREFIX = '__MSG_';

// Placeholders live in text nodes and in attributes such as placeholder/title.
// Replacing them in place keeps the existing DOM, whereas rewriting
// documentElement.innerHTML re-parses the whole document and relinks stylesheets.
function applyI18n(map) {
    const translate = str => str.replace(/__MSG_(\w+)__/g, (_, key) => getMessage(map, key));
    const walker = document.createTreeWalker(
        document.documentElement,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
    );

    let node;
    while ((node = walker.nextNode())) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            for (const attr of node.attributes) {
                if (attr.value.includes(MSG_PREFIX)) attr.value = translate(attr.value);
            }
        } else if (node.nodeValue.includes(MSG_PREFIX)) {
            node.nodeValue = translate(node.nodeValue);
        }
    }
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
        html.dir = 'ltr';
        html.lang = 'en';
    }

    const map = await loadLocaleMap(lang);
    applyI18n(map);
    applyLtrForce();
}

function applyLtrForce() {
    const isRtl = document.documentElement.dir === 'rtl';
    const ltrSelectors = [
        '#import_proxy',
        '#exclude_urls_input',
        '#exclude_urls_box',
        '.help-content .help-card textarea',
        '#single_ip', '#single_port', '#single_user', '#single_pass', '#single_note',
        '#edit_ip', '#edit_port', '#edit_user', '#edit_pass', '#edit_note',
        '#proxy_search',
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


// ── Help Toggle ──

function initHelpToggle() {
    const toggle = document.getElementById('helpToggle');
    const content = document.getElementById('helpContent');
    if (!toggle || !content) return;

    toggle.addEventListener('click', () => {
        toggle.classList.toggle('open');
        content.classList.toggle('open');
    });
}


// ── Tips Toggle ──

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


// ── Cached i18n map ──

let _cachedI18nMap = null;
let _cachedLang = '';

async function getI18nMap() {
    if (_cachedI18nMap) return _cachedI18nMap;
    try {
        const { lang } = await chrome.runtime.sendMessage({ action: 'get_option', key: ['lang'] });
        _cachedLang = lang || '';
        _cachedI18nMap = await loadLocaleMap(_cachedLang || 'en');
        return _cachedI18nMap;
    } catch {
        return null;
    }
}

function t(key) {
    if (_cachedI18nMap && _cachedI18nMap[key]) return _cachedI18nMap[key];
    try { return chrome.i18n.getMessage(key) || key; } catch { return key; }
}


// ── Protocol Helpers ──

const PROTOCOLS = {
    http:  { label: 'HTTP',  cls: 'proto-http'  },
    https: { label: 'HTTPS', cls: 'proto-https' },
    socks5:{ label: 'SOCKS5',cls: 'proto-socks5'},
};

function protoLabel(p) {
    const pr = (p && p.protocol) ? p.protocol : 'http';
    return (PROTOCOLS[pr] || PROTOCOLS.http).label;
}

function protoCls(p) {
    const pr = (p && p.protocol) ? p.protocol : 'http';
    return (PROTOCOLS[pr] || PROTOCOLS.http).cls;
}

function createProtoBadge(protocol) {
    const badge = document.createElement('span');
    badge.className = 'proto-badge ' + protoCls({protocol});
    badge.textContent = protoLabel({protocol});
    return badge;
}


// ── Import Sub-Tabs ──

function initImportTabs() {
    const importTabBtns = document.querySelectorAll('.import-tab-btn');
    const importPanes = document.querySelectorAll('.import-pane');

    importTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.import;
            importTabBtns.forEach(b => b.classList.remove('active'));
            importPanes.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const pane = document.getElementById(`import-${target}`);
            if (pane) pane.classList.add('active');
        });
    });
}


// ── Add Single Proxy ──

function getSingleFormData() {
    return {
        ip: document.getElementById('single_ip').value.trim(),
        port: document.getElementById('single_port').value.trim(),
        user: document.getElementById('single_user').value.trim(),
        pass: document.getElementById('single_pass').value.trim(),
        protocol: document.getElementById('single_protocol').value || 'http',
    };
}

function clearSingleForm() {
    document.getElementById('single_ip').value = '';
    document.getElementById('single_port').value = '';
    document.getElementById('single_user').value = '';
    document.getElementById('single_pass').value = '';
    document.getElementById('single_note').value = '';
    document.getElementById('single_protocol').value = 'http';
}

function initAddSingleProxy() {
    const btn = document.querySelector('.add-single-proxy');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        const data = getSingleFormData();
        if (!data.ip || !data.port) return;

        const note = document.getElementById('single_note').value.trim();
        const newProxy = { ip: data.ip, port: data.port, user: data.user, pass: data.pass, protocol: data.protocol };

        if (note) newProxy.commentAfter = note;

        const { proxy_list = '[]' } = await chrome.runtime.sendMessage({
            action: 'get_option',
            key: ['proxy_list'],
        });

        let list;
        try { list = JSON.parse(proxy_list); } catch { list = []; }

        list.push(newProxy);

        await chrome.runtime.sendMessage({
            action: 'save_proxylist',
            data: list,
        });

        clearSingleForm();
        await createTableProxy();
        switchTab('list');
    });
}


// ── Proxy List Rendering ──

let currentFilter = 'all';
let currentSearch = '';
let proxyListCache = [];
let currentProxy = null;
let _searchTimer = null;

const SEARCH_DEBOUNCE_MS = 120;

const ICON = {
    lock: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    edit: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    del: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    off: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
    check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    globe: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`,
    empty: `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="empty-icon">
                <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"/>
            </svg>`,
};

// Lists saved before the escape was removed hold HTML entities; rendering uses
// textContent, so the entities would show literally.
function unescapeLegacy(str) {
    if (!str) return '';
    return String(str).replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => (
        e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : "'"
    ));
}

function setFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll('.proto-filter-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.filter === filter);
    });
    renderProxyList();
}

function setSearch(query) {
    currentSearch = query.toLowerCase().trim();
    const clearBtn = document.getElementById('search_clear');
    if (clearBtn) clearBtn.classList.toggle('d-none', !currentSearch);
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(renderProxyList, SEARCH_DEBOUNCE_MS);
}

function proxyToImportLine(p) {
    const proto = p.protocol && p.protocol !== 'http' ? `${p.protocol}: ` : '';
    const creds = p.user && p.pass ? `${p.user}:${p.pass}@` : '';
    const body = `${proto}${creds}${p.ip}:${p.port}${p.commentAfter ? ` # ${p.commentAfter}` : ''}`;
    return p.commentBefore ? `# ${p.commentBefore}\n${body}` : body;
}

async function loadProxyData() {
    const { proxy_list = '[]', proxy_current = '' } = await chrome.runtime.sendMessage({
        action: 'get_option',
        key: ['proxy_list', 'proxy_current'],
    });

    let list;
    try { list = JSON.parse(proxy_list); } catch { list = []; }
    if (!Array.isArray(list)) list = [];

    proxyListCache = list.map(p => ({
        ...p,
        protocol: p.protocol || 'http',
        commentBefore: unescapeLegacy(p.commentBefore),
        commentAfter: unescapeLegacy(p.commentAfter),
    }));

    try { currentProxy = proxy_current ? JSON.parse(proxy_current) : null; } catch { currentProxy = null; }

    const importArea = document.querySelector('[name="import_proxy"]');
    if (importArea) importArea.value = proxyListCache.map(proxyToImportLine).join('\n');

    const resetBtn = document.querySelector('button.resetProxy');
    if (resetBtn) resetBtn.classList.toggle('d-none', !currentProxy);
}

async function createTableProxy() {
    await loadProxyData();
    renderProxyList();
}

function matchesSearch(p, query) {
    return `${p.ip}:${p.port} ${p.user || ''} ${p.pass || ''} ${protoLabel(p)} ${p.commentBefore || ''} ${p.commentAfter || ''}`
        .toLowerCase()
        .includes(query);
}

function renderProxyList() {
    const container = document.getElementById('proxy_list_container');
    if (!container) return;

    container.textContent = '';
    container.dir = 'ltr';

    const list = proxyListCache;
    const visible = [];
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (currentFilter !== 'all' && (p.protocol || 'http') !== currentFilter) continue;
        if (currentSearch && !matchesSearch(p, currentSearch)) continue;
        visible.push({ p, index: i });
    }

    // Update count
    const countEl = document.getElementById('proxy_count');
    if (countEl) {
        const total = list.length;
        const shown = visible.length;
        countEl.textContent = shown === total
            ? t('TEXT_PROXY_COUNT').replace('{count}', total)
            : t('TEXT_PROXY_COUNT_FILTERED').replace('{shown}', shown).replace('{total}', total);
    }

    if (!visible.length) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state';
        emptyDiv.innerHTML = ICON.empty;

        const emptyText = document.createElement('p');
        emptyText.textContent = currentSearch ? t('TEXT_NO_SEARCH_RESULTS') : t('TEXT_EMPTY_LIST');
        emptyDiv.appendChild(emptyText);

        container.appendChild(emptyDiv);
        return;
    }

    const listDiv = document.createElement('div');
    listDiv.className = 'proxy-list';
    listDiv.dir = 'ltr';

    for (const {p, index: originalIndex} of visible) {
        const isCurrent = !!currentProxy
            && currentProxy.ip === p.ip && currentProxy.port === p.port
            && currentProxy.user === p.user && currentProxy.pass === p.pass;
        const after = p.commentAfter;

        if (p.commentBefore) {
            const commentDiv = document.createElement('div');
            commentDiv.className = 'proxy-comment';
            commentDiv.textContent = p.commentBefore;
            listDiv.appendChild(commentDiv);
        }

        const card = document.createElement('div');
        card.className = `proxy-card${isCurrent ? ' current' : ''}`;
        card.dataset.index = String(originalIndex);

        const status = document.createElement('div');
        status.className = 'proxy-status';
        card.appendChild(status);

        const info = document.createElement('div');
        info.className = 'proxy-info';

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

        const metaLine = document.createElement('div');
        metaLine.className = 'proxy-meta';

        if (p.user) {
            const creds = document.createElement('span');
            creds.className = 'proxy-credentials';
            creds.innerHTML = ICON.lock;
            creds.append(' ' + p.user);
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

        // Protocol badge
        const badge = createProtoBadge(p.protocol);
        card.appendChild(badge);

        // Action buttons (edit + delete)
        const actions = document.createElement('div');
        actions.className = 'proxy-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'proxy-edit-btn';
        editBtn.title = t('TEXT_EDIT');
        editBtn.innerHTML = ICON.edit;
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditModal(originalIndex, p);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'proxy-delete-btn';
        deleteBtn.title = t('TEXT_DELETE');
        deleteBtn.innerHTML = ICON.del;
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteProxyAction(originalIndex, p);
        });

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        card.appendChild(actions);

        // Select/deselect action
        const actionBtn = document.createElement('button');
        actionBtn.className = 'proxy-action';
        actionBtn.title = isCurrent ? t('TEXT_DISABLE') : t('TEXT_CONNECT');
        actionBtn.innerHTML = isCurrent ? ICON.off : ICON.check;
        card.appendChild(actionBtn);

        card.addEventListener('click', (e) => {
            if (e.target.closest('.proxy-actions')) return;
            if (isCurrent || e.target.closest('.proxy-action')) {
                disableProxyAction();
            } else {
                selectProxyAction(p);
            }
        });

        listDiv.appendChild(card);
    }

    container.appendChild(listDiv);
}

async function selectProxyAction(p) {
    try {
        const result = await chrome.runtime.sendMessage({
            action: 'set_proxy',
            data: {
                ip: p.ip,
                port: p.port,
                user: p.user || '',
                pass: p.pass || '',
                protocol: p.protocol || 'http',
            },
        });

        if (result && result.status === 'error') {
            console.error('[Mezdia] Failed to set proxy:', result.message);
        }
    } catch (e) {
        console.error('[Mezdia] selectProxyAction error:', e);
    }

    await createTableProxy();
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


// ── Delete Proxy (with Toast) ──

async function deleteProxyAction(index, proxy) {
    const result = await chrome.runtime.sendMessage({
        action: 'delete_proxy',
        index: index,
    });

    if (result.status !== 'ok') return;

    const label = `${protoLabel(proxy)} ${proxy.ip}:${proxy.port}`;

    let toast = document.getElementById('delete_toast');
    if (toast) toast.remove();

    toast = document.createElement('div');
    toast.id = 'delete_toast';
    toast.className = 'toast';

    const toastText = document.createElement('span');
    toastText.textContent = `${t('TEXT_PROXY_DELETED')}: ${label}`;
    toast.appendChild(toastText);

    const undoBtn = document.createElement('button');
    undoBtn.className = 'toast-undo';
    undoBtn.textContent = t('TEXT_UNDO');
    undoBtn.addEventListener('click', async () => {
        const { proxy_list = '[]' } = await chrome.runtime.sendMessage({ action: 'get_option', key: ['proxy_list'] });
        let list;
        try { list = JSON.parse(proxy_list); } catch { list = []; }
        list.splice(index, 0, proxy);
        await chrome.runtime.sendMessage({ action: 'save_proxylist', data: list });
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 200);
        await createTableProxy();
    });

    toast.appendChild(undoBtn);
    document.querySelector('.app').appendChild(toast);

    setTimeout(() => {
        if (toast.parentNode) {
            toast.classList.add('removing');
            setTimeout(() => { if (toast.parentNode) toast.remove(); }, 200);
        }
    }, 5000);

    await createTableProxy();
}


// ── Edit Modal ──

let editProxyIndex = -1;

function openEditModal(index, proxy) {
    editProxyIndex = index;

    document.getElementById('edit_protocol').value = proxy.protocol || 'http';
    document.getElementById('edit_ip').value = proxy.ip || '';
    document.getElementById('edit_port').value = proxy.port || '';
    document.getElementById('edit_user').value = proxy.user || '';
    document.getElementById('edit_pass').value = proxy.pass || '';
    document.getElementById('edit_note').value = proxy.commentAfter || '';

    const modal = document.getElementById('edit_modal');
    modal.classList.remove('d-none');
}

function closeEditModal() {
    const modal = document.getElementById('edit_modal');
    modal.classList.add('d-none');
    editProxyIndex = -1;
}

function initEditModal() {
    const modal = document.getElementById('edit_modal');
    if (!modal) return;

    document.getElementById('modal_close').addEventListener('click', closeEditModal);
    document.getElementById('modal_cancel').addEventListener('click', closeEditModal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeEditModal();
    });

    document.getElementById('modal_save').addEventListener('click', async () => {
        if (editProxyIndex < 0) return;

        const updated = {
            ip: document.getElementById('edit_ip').value.trim(),
            port: document.getElementById('edit_port').value.trim(),
            user: document.getElementById('edit_user').value.trim(),
            pass: document.getElementById('edit_pass').value.trim(),
            protocol: document.getElementById('edit_protocol').value || 'http',
        };

        const note = document.getElementById('edit_note').value.trim();
        if (note) updated.commentAfter = note;

        if (!updated.ip || !updated.port) return;

        await chrome.runtime.sendMessage({
            action: 'update_proxy',
            index: editProxyIndex,
            data: updated,
        });

        closeEditModal();
        await createTableProxy();
    });
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

    toggleGroupUI(scope === 'group');

    [scopeAll, scopeGroup].forEach(radio => {
        radio.addEventListener('change', async function () {
            const val = this.value;
            await chrome.runtime.sendMessage({ action: 'set_option', key: 'proxy_scope', val: val });
            // toggleGroupUI refreshes the group status itself when entering group mode
            toggleGroupUI(val === 'group');
        });
    });
}

function toggleGroupUI(isGroup) {
    const statusPanel = document.getElementById('group_status_panel');
    const tipsSection = document.getElementById('group_tips_section');

    if (statusPanel) statusPanel.classList.toggle('d-none', !isGroup);
    if (tipsSection) tipsSection.classList.toggle('d-none', !isGroup);
    if (isGroup) refreshGroupStatus();
}


// ── Group Status ──

function statusRow(label, value, valueClass) {
    const row = document.createElement('div');
    row.className = 'group-status-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = valueClass ? `value ${valueClass}` : 'value';
    valueEl.textContent = value;

    row.append(labelEl, valueEl);
    return row;
}

async function refreshGroupStatus() {
    const statusBody = document.getElementById('group_status_body');
    if (!statusBody) return;
    await getI18nMap();

    try {
        const info = await chrome.runtime.sendMessage({ action: 'get_group_status' });
        statusBody.textContent = '';

        statusBody.appendChild(statusRow(
            t('TEXT_GRP_LABEL'),
            info.exists ? t('TEXT_GRP_ACTIVE') : t('TEXT_GRP_NOT_FOUND'),
            info.exists ? 'success' : 'danger'
        ));
        statusBody.appendChild(statusRow(
            t('TEXT_GRP_TABS'),
            String(info.tabs.length),
            info.tabs.length > 0 ? 'success' : 'warning'
        ));

        if (info.domains.length > 0) {
            statusBody.appendChild(statusRow(t('TEXT_GRP_DOMAINS'), String(info.domains.length)));

            const domainPills = document.createElement('div');
            domainPills.className = 'group-domain-pills';
            for (const domain of info.domains) {
                const pill = document.createElement('span');
                pill.className = 'group-domain-item';
                pill.innerHTML = ICON.globe;
                pill.append(domain);
                domainPills.appendChild(pill);
            }
            statusBody.appendChild(domainPills);
        } else {
            const noDomains = document.createElement('div');
            noDomains.className = 'group-no-domains';
            noDomains.textContent = t('TEXT_GRP_NO_DOMAINS');
            statusBody.appendChild(noDomains);
        }

        const createBtn = document.getElementById('create_group_btn');
        if (createBtn) createBtn.classList.toggle('d-none', info.exists);

        if (!chrome.tabGroups) {
            const note = document.createElement('div');
            note.className = 'group-no-domains';
            note.textContent = t('TEXT_GRP_UNTITLED_NOTE');
            statusBody.appendChild(note);
        }

    } catch (e) {
        const err = document.createElement('div');
        err.className = 'group-no-domains';
        err.textContent = t('TEXT_GRP_ERROR');
        statusBody.textContent = '';
        statusBody.appendChild(err);
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


// ── Exclude URLs Tag-Box ──

let excludeTags = [];

function addExcludeTags(text) {
    if (!text) return;
    const newEntries = text.split(/[,\n;]+/)
        .map(s => s.trim().toLowerCase())
        .filter(s => s.length > 0)
        .map(e => {
            if (e.startsWith('http://') || e.startsWith('https://')) {
                try { return new URL(e).hostname; } catch {}
            }
            return e;
        });

    const seen = new Set(excludeTags);
    let changed = false;
    for (const entry of newEntries) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        excludeTags.push(entry);
        changed = true;
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
    container.textContent = '';

    excludeTags.forEach((tag, index) => {
        const tagEl = document.createElement('span');
        tagEl.className = 'tag-item';

        const text = document.createElement('span');
        text.className = 'tag-text';
        text.textContent = tag;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'tag-remove';
        removeBtn.title = 'Remove';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', e => {
            e.stopPropagation();
            removeExcludeTag(index);
        });

        tagEl.append(text, removeBtn);
        container.appendChild(tagEl);
    });
}

// sw.js re-applies the PAC script when exclude_urls changes, so no extra message here.
function saveExcludeTags() {
    chrome.runtime.sendMessage({ action: 'set_option', key: 'exclude_urls', val: JSON.stringify(excludeTags) });
}


// ── Init ──

document.addEventListener('DOMContentLoaded', async () => {
    const stored = await chrome.runtime.sendMessage({ action: 'get_option' });

    await applyLanguage(stored.lang || '');
    await getI18nMap();

    applyThemeClass(stored.theme || '');

    initTabs();
    initImportTabs();
    initHelpToggle();
    initTipsToggle();
    initProxyScope(stored);
    initCreateGroupBtn();
    initAddSingleProxy();
    initEditModal();

    await createTableProxy();
    applyLtrForce();

    // ── Event Listeners ──

    // Disable proxy button
    const resetBtn = document.querySelector('button.resetProxy');
    if (resetBtn) {
        resetBtn.addEventListener('click', disableProxyAction);
    }

    // Save proxy (bulk import)
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

    // Search
    const searchInput = document.getElementById('proxy_search');
    const searchClear = document.getElementById('search_clear');
    if (searchInput) {
        searchInput.addEventListener('input', () => setSearch(searchInput.value));
    }
    if (searchClear) {
        searchClear.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            setSearch('');
        });
    }

    // Protocol filter buttons
    document.querySelectorAll('.proto-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => setFilter(btn.dataset.filter));
    });

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

    // Exclude URLs — Tag Box
    try {
        const raw = stored.exclude_urls || '[]';
        let parsed;
        try {
            parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) parsed = [];
        } catch {
            parsed = String(raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        }
        excludeTags = parsed;
    } catch {
        excludeTags = [];
    }

    renderExcludeTags();

    const excludeInput = document.getElementById('exclude_urls_input');
    const excludeBox = document.getElementById('exclude_urls_box');

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

        excludeInput.addEventListener('paste', function (e) {
            e.preventDefault();
            const paste = (e.clipboardData || window.clipboardData).getData('text');
            addExcludeTags(paste);
            this.value = '';
        });
    }

    // Language selector
    const langSelect = document.getElementById('language_select');
    if (langSelect) {
        langSelect.value = stored.lang || '';
        langSelect.addEventListener('change', function () {
            const v = this.value || '';
            chrome.runtime.sendMessage({ action: 'set_option', key: 'lang', val: v }, () => {
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

            ThemeTransition.transition(() => {
                applyThemeClass(newTheme);
            });
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

    // Settings save button (visual feedback)
    const settingsSaveBtn = document.querySelector('.settings-save');
    if (settingsSaveBtn) {
        settingsSaveBtn.addEventListener('click', async () => {
            settingsSaveBtn.style.transform = 'scale(0.97)';
            setTimeout(() => { settingsSaveBtn.style.transform = ''; }, 150);
        });
    }

    // Show body
    document.body.style.display = '';
});