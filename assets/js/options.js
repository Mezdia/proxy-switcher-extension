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

const MSG_PREFIX = '__MSG_';

// chrome.i18n covers the "auto" language case, where no locale map is loaded.
function getMessage(map, key) {
    if (map && map[key]) return map[key];
    try { return chrome.i18n.getMessage(key) || ''; } catch { return ''; }
}

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
    document.querySelectorAll('.ltr-force').forEach(el => {
        el.dir = 'ltr';
    });
}


document.addEventListener('DOMContentLoaded', async () => {
    const stored = await chrome.runtime.sendMessage({ action: 'get_option' });

    await applyLanguage(stored.lang || '');

    document.body.style.display = '';
});