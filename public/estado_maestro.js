// Banner de estado del Servidor Maestro (caja hija). Sin polling: reacciona a eventos del proceso principal.
(function () {
    const api = window.nexusAPI;
    if (!api || typeof api.onEstadoServidorMaestro !== 'function') return;

    let banner = null, ocultarTimer = null;
    function getBanner() {
        if (banner) return banner;
        banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;padding:6px 16px;border-radius:0 0 10px 10px;font:600 12px sans-serif;color:#fff;display:none;box-shadow:0 2px 8px rgba(0,0,0,.3)';
        document.body.appendChild(banner);
        return banner;
    }
    function mostrar(texto, color, autoOcultarMs) {
        const b = getBanner();
        clearTimeout(ocultarTimer);
        b.textContent = texto; b.style.background = color; b.style.display = 'block';
        if (autoOcultarMs) ocultarTimer = setTimeout(() => { b.style.display = 'none'; }, autoOcultarMs);
    }

    let huboCaida = false;
    api.onEstadoServidorMaestro((p) => {
        window.estadoServidorMaestro = p;
        window.dispatchEvent(new CustomEvent('maestro-estado', { detail: p }));
        if (p.estado === 'desconectado' || p.estado === 'buscando') {
            huboCaida = true;
            mostrar('⚠️ Sin conexión con la Caja Maestra — reconectando automáticamente…', '#dc2626');
        } else if (p.estado === 'conectado' && huboCaida) {
            huboCaida = false;
            mostrar(p.cambioIp ? `✅ Reconectado (nueva IP del maestro: ${p.ip})` : '✅ Conexión con la Caja Maestra restablecida', '#16a34a', 4000);
        }
    });

    // El navegador avisa cuando vuelve la red física: reintento inmediato (evento, no polling)
    window.addEventListener('online', () => { try { api.reconectarServidorMaestro(); } catch (_) {} });
})();
