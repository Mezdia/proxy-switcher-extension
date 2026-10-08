<div align="center">

<img src="assets/images/icon128_enabled.png" width="116" height="116" alt="Mezdia Proxy Switcher — a browser window carrying a shield" />

# Mezdia Proxy Switcher

**Manage and switch proxies in your browser.**

A Manifest V3 extension for Chrome, Edge and every other Chromium browser: keep a list of
proxies, jump between them in one click, and decide exactly which tabs should be routed.

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-7C5CFF?style=flat-square)](manifest.json)
[![Version 4.0.2](https://img.shields.io/badge/version-4.0.2-7C5CFF?style=flat-square)](https://github.com/Mezdia2/proxy-switcher-extension/releases/tag/v4.0.2)
[![Chromium browsers](https://img.shields.io/badge/Chrome%20·%20Edge%20·%20Brave-supported-241457?style=flat-square)](#install)
[![Protocols](https://img.shields.io/badge/HTTP%20·%20HTTPS%20·%20SOCKS5-4ade80?style=flat-square)](#import-format)
[![Languages](https://img.shields.io/badge/EN%20·%20FA%20·%20AR%20·%20RU-fbbf24?style=flat-square)](#languages)
[![No telemetry](https://img.shields.io/badge/telemetry-none-4ade80?style=flat-square)](#permissions)

<br/>

**Watch the 45-second tour** — [download the 1080p teaser](https://github.com/Mezdia2/proxy-switcher-extension/releases/download/v4.0.2/Mezdia-Proxy-Switcher-Promo-1080p.mp4)

[![Mezdia Proxy Switcher in motion: the popup opens from the toolbar icon, a proxy is switched with one click, and bulk import is used](docs/teaser.gif)](https://github.com/Mezdia2/proxy-switcher-extension/releases/tag/v4.0.2)

*The popup drops out of the toolbar icon, the active proxy lights up, and everything else waits its turn.*

</div>

---

## Why this exists

Most proxy switchers treat the whole browser as one switch. In practice you rarely want that —
you want one research tab going out through a different exit while your bank tab, your local
dev server and your mail keep their normal connection.

Mezdia Proxy Switcher is built around that difference:

| | |
|---|---|
| **Per-group routing** | Apply the proxy to the whole browser, or only to the tabs inside a Chrome tab group. Group mode is the reason this extension exists. |
| **Three protocols** | HTTP, HTTPS and SOCKS5, each with its own badge, so a mixed pool stays readable at a glance. |
| **One-click switching** | The active proxy is marked with a green dot and a left accent bar; click another to move over. |
| **Bulk import** | Paste a whole file at once. Comments, credentials and protocol prefixes are all understood. |
| **Search and filter** | Narrow a long list by text or by protocol before you pick. |
| **Edit and delete** | Fix an entry in place, or remove it and undo the mistake from the toast. |
| **Excluded URLs** | Keep domains out of the tunnel — plain domains or `*.wildcard` patterns, added as tags. |
| **Clean switch** | Optionally reload the current and other tabs, and drop cookies and cache as part of switching. |
| **Dark and light** | A real light theme, revealed with a circle-wave transition that grows out of the corner. |
| **Four languages** | English, Persian, Russian and Arabic — with right-to-left layout that keeps IP addresses and domains readable left-to-right. |

---

## Install

There is no store listing yet, so load it as an unpacked extension.

1. Download or clone this repository.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** — top right.
4. Click **Load unpacked** and select the repository folder.
5. Pin **Mezdia Proxy Switcher** to your toolbar.

The same steps work in Brave, Arc and any other Chromium browser.

---

## Quick start

1. Open the popup and go to **Import**.
2. Add one proxy under **Add Proxy**, or paste a whole list under **Bulk Import** and hit **Save**.
3. Back on **Proxies**, click the entry you want. It goes green — you are routed.
4. Want out? Click **Disable Proxy** at the top of the list, or click the active entry again.

Settings such as reloading and cookie cleanup are applied the next time you switch, not when you
press save — the popup says so at the top of that tab.

---

## Import format

Bulk import accepts one proxy per line. The protocol prefix is optional and defaults to HTTP.

```
# Comments start with a hash and are kept in the list as section labels
185.224.128.0:8080
185.224.128.0:8080:login:password
login:password@185.224.128.0:8080

https: 51.15.24.96:443
socks5: 91.243.82.12:1080:login:password
```

| Protocol | Accepted forms |
|---|---|
| **HTTP** | `ip:port` · `ip:port:login:password` · `login:password@ip:port` |
| **HTTPS** | `https: ip:port` · `https: ip:port:login:password` · `https: login:password@ip:port` |
| **SOCKS5** | `socks5: ip:port` · `socks5: ip:port:login:password` · `socks5: login:password@ip:port` |

A comment line placed directly above an entry becomes that entry's label, so a pasted file keeps
its section headings.

---

## Group mode

**Settings → Proxy Scope → Mezdia Group** limits the proxy to the tabs in one Chrome tab group.
Everything outside the group connects directly.

1. Open the tabs you want proxied.
2. Select them, right-click, **Add tabs to group**, and name the group exactly **`Mezdia`** — the
   name is case-sensitive. Or press **Create Mezdia Group from Current Tab** in the popup.
3. Watch **Group Status**: it reports whether the group exists, how many tabs it holds, and which
   domains are currently going through the proxy.

Adding or removing tabs, or navigating a grouped tab to a new domain, updates the routing within
about a second — no need to re-apply.

> **Worth knowing** — routing is decided by domain, not by tab. If the same domain is open both
> inside the Mezdia group and in a normal tab, the proxy applies to every request to that domain.
> For a clean separation, keep different domains in each context.

---

## Settings reference

| Setting | What it does |
|---|---|
| **Proxy Scope** | `All Tabs` routes the whole browser. `Mezdia Group` routes only the group. |
| **Reload current tab** | Reloads the active tab after switching. |
| **Reload all other tabs** | Reloads every other tab too, so cached responses do not linger. |
| **Remove cookies** | Clears cookies as part of the switch. |
| **Remove cache** | Clears the HTTP cache as part of the switch. |
| **Language** | Auto (browser), English, Persian, Russian or Arabic. |
| **Excluded URLs** | Domains that must never use the proxy. Type and press Enter or comma; `*.` patterns are supported; click × to remove. |

---

## Permissions

Every permission is there because the proxy APIs require it — none of them is used for anything
else.

| Permission | Why it is needed |
|---|---|
| `proxy` | Reads and writes the browser's proxy configuration. |
| `webRequest` + `webRequestAuthProvider` | Answers `407 Proxy Authentication Required` for proxies that need a login and password. |
| `browsingData` | The optional "remove cookies / remove cache" switch. |
| `storage` | Saves your proxy list and settings. |
| `tabGroups` | Finds the Mezdia group and the domains inside it. |
| `<all_urls>` (host) | Chrome requires broad host access to intercept proxy authentication challenges. |

**On the data side:** your list and settings live in `chrome.storage.local` on your own machine.
The extension ships no analytics, no crash reporting and no remote code — the only network
requests it makes are to the proxies and sites you point it at.

---

## Languages

English, Persian, Russian and Arabic are bundled. Persian and Arabic render right-to-left, while
technical content — IP addresses, ports, domains and proxy lists — is pinned left-to-right so it
stays readable inside an RTL layout.

---

## Repository layout

```
.
├── manifest.json              Manifest V3, default locale en
├── popup.html                 The toolbar popup
├── options.html               Localized options shell
├── _locales/                  en · fa · ar · ru
└── assets/
    ├── css/                   popup.css (dark-first tokens) · options.css
    ├── js/                    sw.js (service worker) · popup.js · options.js · theme-transition.js
    └── images/                Toolbar and extension icons
```

`assets/js/sw.js` owns the actual proxy configuration and group routing; `popup.js` is the UI and
`theme-transition.js` wraps the View Transition API used for the theme change, with a fallback for
browsers that lack it.

---

## Release notes

The full changelog lives on the [releases page](https://github.com/Mezdia2/proxy-switcher-extension/releases).
Highlights from the 4.x line: SOCKS5 support, protocol badges, search and filter, inline edit and
delete with undo, tag-style excluded URLs, per-group routing with live status, and the circle-wave
theme transition.

---

## Credits

Built with care by [Mezdia](https://github.com/Mezdia).

<div align="center">

<img src="assets/images/icon128_enabled.png" width="26" height="26" alt="" /> **Switch smarter. Route anywhere.**

</div>
