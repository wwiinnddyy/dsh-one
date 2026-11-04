/**
 * Browser side of dsh-one: one floating panel that reads `/one/api/overview`.
 * Written against the DSH client module closure-factory protocol; React is
 * resolved through the platform module table.
 */
window.__ModuleLoader__.load({
    id: '@wwiinnddyy/dsh-one',
    factory(require) {
        const React = require('react');
        function ensureStyle() {
            const id = 'dsh-one-panel-css';
            if (typeof document === 'undefined' || document.querySelector(`style[data-one-css="${id}"]`) !== null)
                return;
            const style = document.createElement('style');
            style.dataset.oneCss = id;
            style.textContent = [
                '.one-pill{position:fixed;right:16px;bottom:16px;z-index:2147483000;border:1px solid var(--dsh-border,#8884);',
                'background:var(--dsh-bg,#111);color:inherit;border-radius:10px;padding:8px 12px;font:600 12px/1.2 system-ui;',
                'cursor:pointer;box-shadow:0 6px 24px #0004}',
                '.one-panel{position:fixed;right:16px;bottom:60px;z-index:2147483000;width:min(420px,calc(100vw - 32px));',
                'max-height:min(70vh,560px);overflow:auto;border:1px solid var(--dsh-border,#8884);border-radius:12px;',
                'background:var(--dsh-bg,#111);color:inherit;font:13px/1.45 system-ui;box-shadow:0 12px 40px #0006}',
                '.one-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid var(--dsh-border,#8884)}',
                '.one-head h3{margin:0;font-size:13px}',
                '.one-body{padding:10px 12px}',
                '.one-sec{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.65;margin:10px 0 6px}',
                '.one-row{display:flex;gap:8px;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--dsh-border,#8882)}',
                '.one-row:last-child{border-bottom:0}',
                '.one-row b{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
                '.one-row span{opacity:.7;white-space:nowrap}',
                '.one-health{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:12px;opacity:.8}',
                '.one-empty{opacity:.7;padding:8px 0}',
                '.one-err{color:#e66;padding:8px 0}',
            ].join('');
            document.head.appendChild(style);
        }
        function itemRow(item) {
            return React.createElement('div', { key: item.id, className: 'one-row' }, [
                React.createElement('b', { key: 't', title: item.detail ?? item.title }, item.title),
                React.createElement('span', { key: 's' }, item.status),
            ]);
        }
        function section(title, items) {
            return React.createElement('div', { key: title }, [
                React.createElement('div', { key: 'h', className: 'one-sec' }, `${title} · ${items.length}`),
                ...(items.length === 0
                    ? [React.createElement('div', { key: 'e', className: 'one-empty' }, 'None')]
                    : items.slice(0, 12).map(itemRow)),
            ]);
        }
        function OnePanel() {
            const [open, setOpen] = React.useState(false);
            const [data, setData] = React.useState(undefined);
            const [error, setError] = React.useState(undefined);
            React.useEffect(() => {
                let alive = true;
                const load = async () => {
                    try {
                        const response = await fetch('/one/api/overview', { credentials: 'same-origin', cache: 'no-store' });
                        if (!response.ok)
                            throw new Error(`HTTP ${response.status}`);
                        const value = await response.json();
                        if (alive) {
                            setData(value);
                            setError(undefined);
                        }
                    }
                    catch (loadError) {
                        if (alive)
                            setError(String(loadError));
                    }
                };
                void load();
                const timer = setInterval(() => { void load(); }, 3000);
                return () => {
                    alive = false;
                    clearInterval(timer);
                };
            }, []);
            const attention = data?.attention.length ?? 0;
            const running = data?.running.length ?? 0;
            const pill = React.createElement('button', {
                key: 'pill',
                className: 'one-pill',
                onClick: () => setOpen(!open),
                title: 'DSH One',
            }, `One ${attention}/${running}`);
            if (!open)
                return pill;
            const body = React.createElement('div', { key: 'body', className: 'one-body' }, [
                ...(error === undefined ? [] : [React.createElement('div', { key: 'err', className: 'one-err' }, error)]),
                section('Needs attention', data?.attention ?? []),
                section('Running', data?.running ?? []),
                section('History', data?.history ?? []),
                ...(data === undefined ? [] : [
                    React.createElement('div', { key: 'health', className: 'one-sec' }, 'Health'),
                    React.createElement('div', { key: 'h2', className: 'one-health' }, [
                        React.createElement('div', { key: 's' }, `storage ${data.health.storage}`),
                        React.createElement('div', { key: 'c' }, `core ${data.health.core}`),
                        React.createElement('div', { key: 'd' }, `delegate ${data.health.delegate}`),
                        React.createElement('div', { key: 'i' }, `ingress ${data.health.ingress}`),
                        React.createElement('div', { key: 'w' }, `workers ${data.health.workers}/${data.health.maxWorkers}`),
                        React.createElement('div', { key: 'l' }, `leases ${data.health.leases}`),
                        React.createElement('div', { key: 'p' }, `policy ${data.health.policyVersion ?? '—'}`),
                        React.createElement('div', { key: 'e' }, data.health.lastError ?? 'no error'),
                    ]),
                ]),
            ]);
            return React.createElement('div', { key: 'panel', className: 'one-panel' }, [
                React.createElement('div', { key: 'head', className: 'one-head' }, [
                    React.createElement('h3', { key: 't' }, 'DSH One'),
                    React.createElement('button', { key: 'c', onClick: () => setOpen(false) }, 'Close'),
                ]),
                body,
            ]);
        }
        const inject = ['slots'];
        function apply(ctx) {
            ensureStyle();
            const slots = ctx.slots;
            if (slots === undefined)
                return;
            ctx.effect?.(() => {
                slots.inject('shell.overlay', () => slots.register({
                    name: 'shell.overlay',
                    id: 'dsh-one-panel',
                    order: 90,
                    label: 'DSH One',
                }, OnePanel));
            }, 'dsh-one: client overlay');
        }
        return { inject, apply };
    },
});
export {};
