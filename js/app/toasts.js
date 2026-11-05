// Avisos breves (toasts) y anuncios para lectores de pantalla: un único lugar con aria-live.
// #toast-region es role="status" (polite): cada toast nuevo se anuncia una vez. announce() usa
// otra región oculta para mensajes sin toast visible (banners de error, cantidad de sugerencias).

const TOAST_DEFAULT_MS = 3500;
const TOAST_MAX_VISIBLE = 3;
const toastState = { seq: 0, timers: new Map() };

function getToastRegion() {
    return document.getElementById('toast-region');
}

function dismissToast(id) {
    const region = getToastRegion();
    clearTimeout(toastState.timers.get(id));
    toastState.timers.delete(id);
    region?.querySelectorAll('.toast').forEach(element => {
        if (element.dataset.toastId === id) element.remove();
    });
}

// options: { id (uno por id: reemplaza al anterior), tone: 'info'|'success'|'error', durationMs (0 = queda) }.
// El texto va siempre como textContent.
function showToast(message, options = {}) {
    const region = getToastRegion();
    const text = (message ?? '').toString().trim();
    if (!region || !text) return null;

    const id = options.id ? String(options.id) : `toast-${++toastState.seq}`;
    dismissToast(id);

    const tone = ['success', 'error'].includes(options.tone) ? options.tone : 'info';
    const toast = document.createElement('div');
    toast.className = `toast is-${tone}`;
    toast.dataset.toastId = id;
    const body = document.createElement('span');
    body.className = 'toast-text';
    body.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Cerrar aviso');
    close.textContent = '×';
    close.addEventListener('click', () => dismissToast(id));
    toast.append(body, close);
    region.append(toast);

    const toasts = region.querySelectorAll('.toast');
    for (let index = 0; index < toasts.length - TOAST_MAX_VISIBLE; index += 1) dismissToast(toasts[index].dataset.toastId);

    const durationMs = Number.isFinite(Number(options.durationMs)) ? Number(options.durationMs) : TOAST_DEFAULT_MS;
    if (durationMs > 0) toastState.timers.set(id, setTimeout(() => dismissToast(id), durationMs));
    return id;
}

// Reescribe el texto (vaciando antes) para que se anuncie aunque sea igual al anterior.
function announce(message) {
    const live = document.getElementById('sr-announcer');
    if (!live) return;
    live.textContent = '';
    requestAnimationFrame(() => { live.textContent = (message ?? '').toString(); });
}

globalThis.showToast = showToast;
globalThis.dismissToast = dismissToast;
globalThis.announce = announce;
