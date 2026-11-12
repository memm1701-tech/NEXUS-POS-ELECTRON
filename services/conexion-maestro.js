// ============================================================
// GESTOR DE CONEXIÓN CAJA HIJA → CAJA MAESTRA (proceso principal)
//
// Detección SIN polling: se mantiene UN solo túnel SSE abierto contra el
// maestro (/api/maestro/borradores-stream). El servidor ya envía un
// ":heartbeat" cada 20 s por ese mismo túnel, así que:
//   - 'error' / 'close' / 'end' del socket  -> caída detectada al instante
//   - silencio > WATCHDOG_MS (sin heartbeat) -> caída silenciosa (Wi-Fi caído,
//     cable desconectado, laptop dormida) detectada con un timer LOCAL,
//     sin enviar ninguna petición.
// Solo cuando se pierde el túnel arranca la recuperación automática:
//   1. ping a la IP guardada (¿mismo equipo, solo fue un corte?)
//   2. si no responde, barrido de la subred (la IP pudo cambiar por DHCP)
//   3. si el maestro aparece en otra IP, se guarda y se avisa a las ventanas
// Disparadores extra de recuperación inmediata: reanudar de suspensión,
// desbloquear pantalla y evento 'online' del renderer.
// ============================================================
const http = require('http');

const WATCHDOG_MS = 50000;       // 2.5 heartbeats de 20 s
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 15000;

function crearGestorConexion({ getIpMaestro, esMaestro, escanear, ping, persistirIp, emitir, puerto = 3000 }) {
    let estado = 'detenido';          // detenido | conectado | desconectado | buscando
    let ipActual = null;
    let req = null;
    let watchdog = null;
    let recuperando = false;
    let despertarEspera = null;       // permite saltarse el backoff
    let activo = false;

    const log = (...a) => console.log('[CONEXION-MAESTRO]', ...a);

    function publicar(nuevoEstado, extra = {}) {
        estado = nuevoEstado;
        try { emitir({ estado, ip: ipActual, ...extra }); } catch (_) {}
    }

    function limpiarStream() {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (req) {
            const r = req; req = null;
            r.removeAllListeners();
            r.on('error', () => {});
            try { r.destroy(); } catch (_) {}
        }
    }

    function armarWatchdog() {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => perdida('sin heartbeat del maestro'), WATCHDOG_MS);
    }

    // Abre el túnel. Resuelve true si el maestro respondió 200.
    function abrirStream(ip) {
        return new Promise((resolve) => {
            limpiarStream();
            let resuelto = false;
            const fin = (ok) => { if (!resuelto) { resuelto = true; resolve(ok); } };

            const r = http.request({
                host: ip, port: puerto, path: '/api/maestro/borradores-stream',
                method: 'GET', headers: { Accept: 'text/event-stream' }, agent: false
            });
            req = r;

            r.setTimeout(5000, () => { if (!resuelto) { r.destroy(new Error('timeout conectando')); } });
            r.on('socket', (s) => { try { s.setKeepAlive(true, 10000); s.setNoDelay(true); } catch (_) {} });

            r.on('response', (res) => {
                if (res.statusCode !== 200) { res.resume(); return fin(false); }
                r.setTimeout(0);
                ipActual = ip;
                armarWatchdog();
                res.on('data', () => armarWatchdog());   // cualquier byte (heartbeat o evento) = vivo
                res.on('end', () => perdida('el maestro cerró el túnel'));
                res.on('close', () => perdida('túnel cerrado'));
                res.on('error', (e) => perdida(e.message));
                fin(true);
            });
            r.on('error', (e) => { if (!resuelto) fin(false); else perdida(e.message); });
            r.end();
        });
    }

    function perdida(motivo) {
        if (!activo || estado === 'desconectado' || estado === 'buscando') return;
        log('⚠️ Conexión perdida:', motivo);
        limpiarStream();
        publicar('desconectado', { motivo });
        recuperar();
    }

    function esperar(ms) {
        return new Promise((res) => {
            const t = setTimeout(() => { despertarEspera = null; res(); }, ms);
            despertarEspera = () => { clearTimeout(t); despertarEspera = null; res(); };
        });
    }

    async function recuperar() {
        if (recuperando || !activo) return;
        recuperando = true;
        let intento = 0;
        try {
            while (activo) {
                if (esMaestro()) { activo = false; break; }
                publicar('buscando', { intento: intento + 1 });
                const ipGuardada = getIpMaestro();
                let ipEncontrada = null;

                // 1) ¿Sigue estando en la misma IP?
                if (ipGuardada) {
                    const r = await ping(ipGuardada, 1500);
                    if (r && r.ok) ipEncontrada = ipGuardada;
                }
                // 2) Si no, barrido de subred (la IP pudo cambiar)
                if (!ipEncontrada) {
                    const sc = await escanear(1000);
                    if (sc && sc.success && sc.ip) ipEncontrada = sc.ip;
                }
                // 3) Reabrir túnel
                if (ipEncontrada) {
                    const cambio = ipEncontrada !== ipGuardada;
                    if (cambio) {
                        log(`🔀 Maestro encontrado en nueva IP ${ipEncontrada} (antes ${ipGuardada})`);
                        try { await persistirIp(ipEncontrada); } catch (e) { log('No se pudo persistir IP:', e.message); }
                    }
                    if (await abrirStream(ipEncontrada)) {
                        log(`✅ Reconectado a ${ipEncontrada}${cambio ? ' (IP actualizada)' : ''}`);
                        publicar('conectado', { cambioIp: cambio, ipAnterior: cambio ? ipGuardada : null });
                        break;
                    }
                }
                const espera = Math.min(BACKOFF_MIN_MS * Math.pow(2, intento), BACKOFF_MAX_MS);
                intento++;
                publicar('desconectado', { proximoIntentoMs: espera });
                await esperar(espera);
            }
        } finally {
            recuperando = false;
        }
    }

    return {
        iniciar() {
            if (activo) return;
            if (esMaestro()) { estado = 'detenido'; return; }
            activo = true;
            const ip = getIpMaestro();
            if (!ip) { publicar('desconectado', { motivo: 'sin IP configurada' }); return recuperar(); }
            abrirStream(ip).then((ok) => {
                if (ok) { log('📡 Túnel con el maestro activo en', ip); publicar('conectado'); }
                else { publicar('desconectado', { motivo: 'no responde al arrancar' }); recuperar(); }
            });
        },
        // Fuerza reintento inmediato (resume del equipo, 'online', botón manual)
        reconectarAhora(motivo = 'manual') {
            if (esMaestro()) return;
            log('🔄 Reconexión inmediata solicitada:', motivo);
            if (!activo) { this.iniciar(); return; }
            if (estado === 'conectado') {
                // Tras suspensión el socket puede estar muerto sin avisar: se descarta y se revalida
                limpiarStream();
                publicar('desconectado', { motivo });
                recuperar();
            } else if (despertarEspera) {
                despertarEspera();
            } else {
                recuperar();
            }
        },
        // Reinicia por completo (p. ej. tras cambiar la IP/modo desde Configuración)
        reiniciar() {
            activo = false; limpiarStream();
            if (despertarEspera) despertarEspera();
            estado = 'detenido';
            setTimeout(() => this.iniciar(), 300);
        },
        detener() { activo = false; limpiarStream(); if (despertarEspera) despertarEspera(); estado = 'detenido'; },
        obtenerEstado() { return { estado, ip: ipActual || getIpMaestro() }; }
    };
}

module.exports = { crearGestorConexion };
