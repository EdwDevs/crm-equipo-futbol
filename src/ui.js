// IMPORTANTE: helpers de UI nunca deben asumir que el elemento existe; la app renderiza vistas parciales.
export const safeText = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
};

export const safeVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
};

// IMPORTANTE: todo dato externo o escrito por usuarios debe sanearse antes de usar innerHTML.
export const escapeHTML = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

export const formatCOP = (amount) => new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0
}).format(amount || 0);

export const setHidden = (id, shouldHide) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', shouldHide);
};

export const setWidth = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.style.width = `${Math.max(0, Math.min(100, value || 0))}%`;
};

export const chartTooltipLabel = (context, formatter = null) => {
    const label = context.dataset?.label || context.label || 'Valor';
    const value = context.parsed?.y ?? context.parsed?.x ?? context.parsed ?? context.raw ?? 0;
    return formatter ? formatter(label, value, context) : `${label}: ${value}`;
};

export const renderProgressRows = (containerId, rows, emptyText = 'Sin datos para mostrar') => {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!rows.length) {
        container.innerHTML = `<div class="text-center py-6 text-xs text-slate-500">${escapeHTML(emptyText)}</div>`;
        return;
    }

    const maxValue = Math.max(...rows.map(row => row.value), 1);
    container.innerHTML = rows.map((row, index) => `
        <div class="rounded-2xl bg-white/[.03] border border-white/8 p-3">
            <div class="flex items-center justify-between gap-3 mb-2">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="w-7 h-7 rounded-xl ${row.badgeClass || 'bg-white/5 text-slate-300'} flex items-center justify-center text-xs font-extrabold">${index + 1}</span>
                    <span class="text-sm font-bold text-white truncate">${escapeHTML(row.label)}</span>
                </div>
                <span class="text-sm font-extrabold ${row.valueClass || 'text-primary'}">${escapeHTML(row.display)}</span>
            </div>
            <div class="h-2 rounded-full bg-white/5 overflow-hidden"><div class="h-full ${row.barClass || 'bg-primary'}" style="width: ${(row.value / maxValue) * 100}%"></div></div>
        </div>
    `).join('');
};

export const closeModal = (id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
};

export const showToast = (msg, isError = false) => {
    const el = document.getElementById('toast');
    const msgEl = document.getElementById('toastMsg');
    if (!el || !msgEl) return;

    msgEl.textContent = msg;
    el.classList.remove('opacity-0', 'pointer-events-none');
    el.classList.add('opacity-100');

    if (isError) {
        el.classList.add('bg-red-900/90', 'border-red-500');
    } else {
        el.classList.remove('bg-red-900/90', 'border-red-500');
    }

    setTimeout(() => {
        el.classList.remove('opacity-100');
        el.classList.add('opacity-0', 'pointer-events-none');
    }, 2600);
};
