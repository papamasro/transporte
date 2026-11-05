// Consentimiento de estadísticas: Google Analytics se inyecta solo después de "Aceptar".
// La elección (aceptar o rechazar) se guarda en localStorage y se puede cambiar desde el panel.
(() => {
    const STORAGE_KEY = 'radaramba.analytics-consent-v1';
    const GA_ID = (globalThis.APP_CONFIG?.ANALYTICS?.gaMeasurementId || '').toString().trim();
    let analyticsLoaded = false;

    // Respeta el flag `analytics` si js/app/feature-flags.js está cargado.
    function isAnalyticsFeatureEnabled() {
        if (!GA_ID) return false;
        if (typeof globalThis.isFeatureEnabled === 'function') return globalThis.isFeatureEnabled('analytics');
        return globalThis.APP_FEATURE_FLAGS?.analytics !== false;
    }

    function readConsent() {
        try {
            const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || 'null');
            return parsed?.value === 'granted' || parsed?.value === 'denied' ? parsed.value : null;
        } catch {
            return null;
        }
    }

    function writeConsent(value) {
        try {
            globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ value, timestamp: Date.now() }));
        } catch {
            // sin storage la elección dura solo esta sesión
        }
    }

    function gtag() {
        globalThis.dataLayer.push(arguments);
    }

    function loadAnalytics() {
        if (!isAnalyticsFeatureEnabled()) return;
        globalThis[`ga-disable-${GA_ID}`] = false;
        if (analyticsLoaded) {
            gtag('consent', 'update', { analytics_storage: 'granted' });
            return;
        }
        analyticsLoaded = true;

        globalThis.dataLayer = globalThis.dataLayer || [];
        globalThis.gtag = gtag;
        gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
        gtag('js', new Date());
        gtag('config', GA_ID, { anonymize_ip: true });

        const script = document.createElement('script');
        script.async = true;
        script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
        document.head.appendChild(script);
    }

    // Revocar en la misma sesión: GA ya cargado deja de enviar hits y se borran sus cookies.
    function disableAnalytics() {
        if (!analyticsLoaded) return;
        globalThis[`ga-disable-${GA_ID}`] = true;
        gtag('consent', 'update', { analytics_storage: 'denied' });
        const hostParts = globalThis.location.hostname.split('.');
        const domains = ['', ...hostParts.map((_part, index) => `.${hostParts.slice(index).join('.')}`)];
        document.cookie.split(';')
            .map(cookie => cookie.split('=')[0].trim())
            .filter(name => name === '_ga' || name.startsWith('_ga_') || name === '_gid')
            .forEach(name => {
                domains.forEach(domain => {
                    document.cookie = `${name}=; Max-Age=0; path=/${domain ? `; domain=${domain}` : ''}`;
                });
            });
    }

    function getBanner() {
        return document.getElementById('consent-banner');
    }

    function hideBanner() {
        const banner = getBanner();
        if (!banner || banner.classList.contains('hidden')) return;
        const hadFocus = banner.contains(document.activeElement);
        banner.classList.add('hidden');
        if (hadFocus) {
            // El botón de privacidad vive en el menú "Más opciones" (cerrado): el foco vuelve al botón del menú.
            const menuBtn = document.getElementById('app-menu-btn');
            if (menuBtn && menuBtn.getClientRects().length > 0 && !menuBtn.closest('[inert]')) menuBtn.focus({ preventScroll: true });
            else globalThis.focusAppHome?.();
        }
    }

    function showBanner({ focus = false } = {}) {
        const banner = getBanner();
        if (!banner) return;
        banner.classList.remove('hidden');
        if (focus) document.getElementById(readConsent() === 'granted' ? 'consent-reject' : 'consent-accept')?.focus({ preventScroll: true });
    }

    function setAnalyticsConsent(value) {
        if (value !== 'granted' && value !== 'denied') return;
        writeConsent(value);
        if (value === 'granted') loadAnalytics();
        else disableAnalytics();
        hideBanner();
    }

    function openConsentSettings() {
        showBanner({ focus: true });
    }

    function initConsent() {
        if (!isAnalyticsFeatureEnabled()) {
            document.getElementById('consent-settings-btn')?.classList.add('hidden');
            return;
        }
        const consent = readConsent();
        if (consent === 'granted') loadAnalytics();
        else if (consent === null) showBanner();
    }

    globalThis.setAnalyticsConsent = setAnalyticsConsent;
    globalThis.openConsentSettings = openConsentSettings;

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initConsent);
    else initConsent();
})();
