function i18n() {
    const html = document.documentElement;
    html.innerHTML = html.innerHTML.replace(/__MSG_(\w+)__/g, (_, key) =>
        chrome.i18n.getMessage(key) || ''
    );

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        const msg = chrome.i18n.getMessage(key);
        if (!msg) return;

        if (el instanceof HTMLInputElement) {
            if (el.placeholder) el.placeholder = msg;
            else if (el.value) el.value = msg;
        } else {
            el.innerHTML = msg;
        }
    });
}


function refresh_tooltip() {
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(tooltip => new bootstrap.Tooltip(tooltip, {
        animation: false,
        customClass: 'custom-tooltip',
    }));
}


async function createTableProxy() {
    const {proxy_list = '[]', proxy_current = ''} = await chrome.runtime.sendMessage({
        action: 'get_option',
        key: ['proxy_list', 'proxy_current'],
    });

    let list;
    try {
        list = JSON.parse(proxy_list);
    } catch {
        list = [];
    }

    let current;
    try {
        current = proxy_current ? JSON.parse(proxy_current) : null;
    } catch {
        current = null;
    }

    const tbody = $('table.proxy_list tbody').empty();

    $('[name="import_proxy"]').val(
        list.flatMap(p => [
            ...(p.commentBefore ? [`# ${p.commentBefore}`] : []),
            `${p.user && p.pass ? `${p.user}:${p.pass}@` : ''}${p.ip}:${p.port}` + (p.commentAfter ? ` # ${p.commentAfter}` : '')
        ]).join('\n')
    );

    $('button.resetProxy')[current ? 'removeClass' : 'addClass']('d-none');

    if (!list.length) {
        setTimeout(() => $('#nav-import-tab').tab('show'), 250);
        return;
    }

    list.forEach(p => {
        const isCurrent = current && current.ip === p.ip && current.port === p.port && current.user === p.user && current.pass === p.pass;
        const emoji = isCurrent ? '✅' : '⚪';
        const after = p.commentAfter ?? '';

        if (p.commentBefore) {
            tbody.append(`<tr><td></td><td colspan="5" class="p-0 px-1">${p.commentBefore}</td></tr>`);
        }

        tbody.append(`
        <tr>
            <td class="py-0 px-1 align-middle${isCurrent ? '' : ' text-secondary'}">
                <a href="#" class="text-decoration-none proxy_${isCurrent ? 'current' : 'select'}">${emoji}</a>
            </td>
            <td class="p-0"><input class="font-monospace form-control form-control-sm i_ip"   value="${p.ip}" readonly></td>
            <td class="p-0"><input class="font-monospace form-control form-control-sm i_port" value="${p.port}" readonly></td>
            <td class="p-0"><input class="font-monospace form-control form-control-sm i_user" value="${p.user}" readonly></td>
            <td class="p-0"><input class="font-monospace form-control form-control-sm i_pass" value="${p.pass}" readonly></td>
            <td class="p-0"><input class="font-monospace form-control form-control-sm" value="${after}" data-bs-toggle="tooltip" data-bs-placement="left" title="${after}" readonly></td>
        </tr>
        `);
    });

    refresh_tooltip();
}


$(async function () {
    i18n();
    refresh_tooltip();

    $("body")
        .on('click', 'a#copyright_link', function () {
            chrome.tabs.create({url: $(this).attr('href')});
            return false;
        })
        .on('click', '.saveProxy', async function () {
            await chrome.runtime.sendMessage({
                action: 'save_proxylist_from_import',
                data: $('[name="import_proxy"]').val().trim(),
            });

            await createTableProxy();

            $('#nav-list-tab').tab('show');
        })
        .on('click', '.proxy_list a.proxy_select', async function (e) {
            e.preventDefault();

            const $tr = $(this).closest('tr');

            await chrome.runtime.sendMessage({
                action: 'set_proxy',
                data: {
                    ip: $tr.find('.i_ip').val().trim(),
                    port: $tr.find('.i_port').val().trim(),
                    user: $tr.find('.i_user').val().trim(),
                    pass: $tr.find('.i_pass').val().trim(),
                },
            });

            await createTableProxy();
        })
        .on('click', '.proxy_list a.proxy_current, button.resetProxy', async function (e) {
            e.preventDefault();

            await chrome.runtime.sendMessage({action: 'disable_proxy'});

            await createTableProxy();
        });


    const stored = await chrome.runtime.sendMessage({action: 'get_option'});

    const optionKeys = ['reload_current_tab', 'reload_other_tabs', 'remove_cookies', 'remove_cache'];
    optionKeys.forEach(key => {
        $('#' + key).prop('checked', !!stored[key]).on('change', function () {
            chrome.runtime.sendMessage({action: 'set_option', key: this.id, val: this.checked});
        });
    });

    $('#exclude_urls').val(stored.exclude_urls || '').on('change', function () {
        chrome.runtime.sendMessage({action: 'set_option', key: 'exclude_urls', val: this.value.trim(),});
    });


    await createTableProxy();
    document.body.style.display = '';
});
