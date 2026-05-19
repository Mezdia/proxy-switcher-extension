/* ═══════════════════════════════════════════════════
   Mezdia Proxy Switcher — Options Page Script
   ═══════════════════════════════════════════════════ */

// ── i18n Helpers ──

async function loadLocaleMap(lang) {
    if (!lang) return null;
    try {
        const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
        const res = await fetch(url);
        if (!res.ok) return null;
        const json = await res.json();
        return Object.entries(json).reduce((o, [k, v]) => (o[k] = v && v.message ? v.message : '', o), {});
    } catch {
        return null;
    }
}

function applyI18n(map) {
    const html = document.documentElement;
    html.innerHTML = html.innerHTML.replace(/__MSG_(\w+)__/g, (_, key) => {
        return (map && map[key]) || '';
    });

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        const msg = (map && map[key]) || '';
        if (!msg) return;

        if (el instanceof HTMLInputElement) {
            if (el.placeholder) el.placeholder = msg;
            else if (el.value) el.value = msg;
        } else {
            el.textContent = msg;
        }
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
    applyLtrForce();
}

function applyLtrForce() {
    document.querySelectorAll('.ltr-force').forEach(el => {
        el.dir = 'ltr';
    });
}


// ── Helper ──

let _statusRefreshTimer = null;

function formatTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleString();
}

function formatRelative(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' hr ago';
    return formatTime(ts);
}


// ── Status Refresh ──

async function refreshStatus() {
    try {
        const status = await chrome.runtime.sendMessage({ action: 'get_monitoring_status' });
        if (!status) return;

        // Connection badge
        const connEl = document.getElementById('status_connection');
        if (connEl) {
            let badgeClass = 'disabled';
            let badgeText = 'Disabled';
            if (status.enabled) {
                if (status.lastReportStatus === 'success') {
                    badgeClass = 'connected';
                    badgeText = 'Connected';
                } else if (status.lastReportStatus === 'error') {
                    badgeClass = 'disconnected';
                    badgeText = 'Error';
                } else {
                    badgeClass = 'pending';
                    badgeText = 'Pending';
                }
            }
            connEl.innerHTML = `<span class="status-badge ${badgeClass}">${badgeText}</span>`;
        }

        // Last report
        const lastReportEl = document.getElementById('status_last_report');
        if (lastReportEl) {
            lastReportEl.textContent = status.enabled ? formatRelative(status.lastReportTime) : '—';
        }

        // Visits sent
        const visitsEl = document.getElementById('status_visits_sent');
        if (visitsEl) {
            visitsEl.textContent = status.lastReportVisits || 0;
        }

        // Reports sent
        const reportsEl = document.getElementById('status_reports_sent');
        if (reportsEl) {
            reportsEl.textContent = status.totalReportsSent || 0;
        }

        // Pending
        const pendingEl = document.getElementById('status_pending');
        if (pendingEl) {
            pendingEl.textContent = status.pendingVisitsCount || 0;
        }

        // Active
        const activeEl = document.getElementById('status_active');
        if (activeEl) {
            activeEl.textContent = status.activeVisitsCount || 0;
        }

        // Detail
        const detailEl = document.getElementById('status_detail');
        if (detailEl) {
            if (status.enabled && status.lastReportTime) {
                let detail = `Last report: ${formatTime(status.lastReportTime)}`;
                if (status.lastReportResponse) {
                    detail += `\nServer response: ${status.lastReportResponse}`;
                }
                if (status.lastReportError) {
                    detail += `\nError: ${status.lastReportError}`;
                }
                detailEl.textContent = detail;
            } else if (status.enabled) {
                detailEl.textContent = 'Waiting for first report...';
            } else {
                detailEl.textContent = '';
            }
        }

        // Device ID
        const deviceIdEl = document.getElementById('device_id_value');
        if (deviceIdEl && status.deviceId) {
            deviceIdEl.textContent = status.deviceId;
        }

    } catch (e) {
        console.error('[Mezdia Options] refreshStatus error:', e);
    }
}


// ── Init ──

document.addEventListener('DOMContentLoaded', async () => {
    const stored = await chrome.runtime.sendMessage({ action: 'get_option' });

    // Apply language
    await applyLanguage(stored.lang || '');

    // Elements
    const enabledCheckbox = document.getElementById('monitoring_enabled');
    const serverConfig = document.getElementById('server_config_section');
    const statusSection = document.getElementById('status_section');
    const deviceSection = document.getElementById('device_section');
    const urlInput = document.getElementById('monitoring_url');
    const apiKeyInput = document.getElementById('monitoring_api_key');
    const intervalInput = document.getElementById('monitoring_interval');
    const throughProxyCheckbox = document.getElementById('monitoring_through_proxy');
    const testBtn = document.getElementById('test_connection_btn');
    const sendNowBtn = document.getElementById('send_now_btn');

    // Set initial values
    enabledCheckbox.checked = !!stored.monitoring_enabled;
    if (urlInput) urlInput.value = stored.monitoring_url || '';
    if (apiKeyInput) apiKeyInput.value = stored.monitoring_api_key || '';
    if (intervalInput) intervalInput.value = stored.monitoring_interval || 120;
    if (throughProxyCheckbox) throughProxyCheckbox.checked = !!stored.monitoring_through_proxy;

    // Show/hide sections based on enabled state
    function toggleSections(enabled) {
        serverConfig.style.display = enabled ? '' : 'none';
        statusSection.style.display = enabled ? '' : 'none';
        deviceSection.style.display = enabled ? '' : 'none';
        if (enabled) {
            refreshStatus();
            startStatusRefresh();
        } else {
            stopStatusRefresh();
        }
    }

    toggleSections(enabledCheckbox.checked);

    // Toggle monitoring enabled
    enabledCheckbox.addEventListener('change', async function () {
        toggleSections(this.checked);
        await chrome.runtime.sendMessage({ action: 'set_option', key: 'monitoring_enabled', val: this.checked });
    });

    // URL change (debounced)
    let urlDebounce = null;
    if (urlInput) {
        urlInput.addEventListener('input', function () {
            if (urlDebounce) clearTimeout(urlDebounce);
            urlDebounce = setTimeout(async () => {
                await chrome.runtime.sendMessage({ action: 'set_option', key: 'monitoring_url', val: this.value.trim() });
            }, 800);
        });
    }

    // API Key change (debounced)
    let apiKeyDebounce = null;
    if (apiKeyInput) {
        apiKeyInput.addEventListener('input', function () {
            if (apiKeyDebounce) clearTimeout(apiKeyDebounce);
            apiKeyDebounce = setTimeout(async () => {
                await chrome.runtime.sendMessage({ action: 'set_option', key: 'monitoring_api_key', val: this.value.trim() });
            }, 800);
        });
    }

    // Interval change
    if (intervalInput) {
        intervalInput.addEventListener('change', async function () {
            let val = parseInt(this.value) || 120;
            if (val < 30) val = 30;
            if (val > 600) val = 600;
            this.value = val;
            await chrome.runtime.sendMessage({ action: 'set_option', key: 'monitoring_interval', val: val });
        });
    }

    // Through proxy toggle
    if (throughProxyCheckbox) {
        throughProxyCheckbox.addEventListener('change', async function () {
            await chrome.runtime.sendMessage({ action: 'set_option', key: 'monitoring_through_proxy', val: this.checked });
        });
    }

    // Test connection button
    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            const originalText = testBtn.querySelector('span').textContent;
            testBtn.querySelector('span').textContent = '...';

            try {
                const result = await chrome.runtime.sendMessage({ action: 'test_monitoring_connection' });
                if (result && result.connected) {
                    testBtn.querySelector('span').textContent = 'Connected!';
                    testBtn.style.background = 'var(--success)';
                } else {
                    testBtn.querySelector('span').textContent = result.error || `Failed (HTTP ${result.httpStatus})`;
                    testBtn.style.background = 'var(--danger)';
                }
            } catch (e) {
                testBtn.querySelector('span').textContent = 'Error: ' + e.message;
                testBtn.style.background = 'var(--danger)';
            }

            setTimeout(() => {
                testBtn.querySelector('span').textContent = originalText;
                testBtn.style.background = '';
                testBtn.disabled = false;
            }, 2000);

            refreshStatus();
        });
    }

    // Send now button
    if (sendNowBtn) {
        sendNowBtn.addEventListener('click', async () => {
            sendNowBtn.disabled = true;
            const originalText = sendNowBtn.querySelector('span').textContent;
            sendNowBtn.querySelector('span').textContent = 'Sending...';

            try {
                const result = await chrome.runtime.sendMessage({ action: 'send_monitor_report_now' });
                if (result && result.reportStatus === 'success') {
                    sendNowBtn.querySelector('span').textContent = 'Sent!';
                    sendNowBtn.style.background = 'var(--success)';
                } else {
                    sendNowBtn.querySelector('span').textContent = 'Failed';
                    sendNowBtn.style.background = 'var(--danger)';
                }
            } catch (e) {
                sendNowBtn.querySelector('span').textContent = 'Error';
                sendNowBtn.style.background = 'var(--danger)';
            }

            setTimeout(() => {
                sendNowBtn.querySelector('span').textContent = originalText;
                sendNowBtn.style.background = '';
                sendNowBtn.disabled = false;
            }, 2000);

            refreshStatus();
        });
    }

    // Show body
    document.body.style.display = '';
});


// ── Auto-refresh status ──

function startStatusRefresh() {
    if (_statusRefreshTimer) clearInterval(_statusRefreshTimer);
    _statusRefreshTimer = setInterval(refreshStatus, 10000); // Refresh every 10s
}

function stopStatusRefresh() {
    if (_statusRefreshTimer) {
        clearInterval(_statusRefreshTimer);
        _statusRefreshTimer = null;
    }
}
