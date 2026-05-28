/* ═══════════════════════════════════════════════════
   Mezdia Proxy Switcher — Options Page Script
   ═══════════════════════════════════════════════════ */

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


document.addEventListener('DOMContentLoaded', async () => {
    const stored = await chrome.runtime.sendMessage({ action: 'get_option' });

    await applyLanguage(stored.lang || '');

    document.body.style.display = '';
});