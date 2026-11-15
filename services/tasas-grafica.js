const fs = require('fs');
const https = require('https');
const axios = /** @type {import('axios').AxiosStatic} */ (/** @type {unknown} */ (require('axios')));
const cheerio = require('cheerio');

const DOLARAPI_HISTORICOS_URL = 'https://ve.dolarapi.com/v1/historicos/dolares/oficial';
const DOLARAPI_HISTORICOS_EUR_URL = 'https://ve.dolarapi.com/v1/historicos/euros/oficial';
const FX_API_DATE_URL = (fecha) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${fecha}/v1/currencies/usd.json`;
const NEXUS_TASAS_API_DEFAULT = 'http://68.168.218.147:3002/api/tasas';
const CONFIG_KEY_INICIALIZADA = 'grafica_tasas_bcv_inicializada';
const CONFIG_KEY_MULTIMONEDA = 'grafica_tasas_multimoneda_inicializada';

const ESQUEMA_GRAFICA_TASAS = {
    grafica_tasas_bcv: {
        fecha: "DATE PRIMARY KEY",
        valor: "DECIMAL(18, 8) DEFAULT 0",
        valor_eur: "DECIMAL(18, 8) DEFAULT 0",
        valor_cny: "DECIMAL(18, 8) DEFAULT 0",
        valor_try: "DECIMAL(18, 8) DEFAULT 0",
        valor_rub: "DECIMAL(18, 8) DEFAULT 0",
        fuente: "TEXT DEFAULT 'NEXUS_API'",
        es_fin_de_semana: "INTEGER DEFAULT 0",
        fecha_registro: "DATETIME DEFAULT (datetime('now', '-4 hours'))"
    }
};

const INDICES_GRAFICA_TASAS = `
    CREATE INDEX IF NOT EXISTS idx_grafica_tasas_bcv_fecha ON grafica_tasas_bcv(fecha);
    CREATE INDEX IF NOT EXISTS idx_grafica_tasas_bcv_fuente ON grafica_tasas_bcv(fuente);
`;

function getCaracasDateObj() {
    const d = new Date();
    const utcMillis = d.getTime() + (d.getTimezoneOffset() * 60000);
    return new Date(utcMillis - (4 * 60 * 60 * 1000));
}

function obtenerHoyCaracasISO() {
    const c = getCaracasDateObj();
    const pad = (n) => String(n).padStart(2, '0');
    return `${c.getFullYear()}-${pad(c.getMonth() + 1)}-${pad(c.getDate())}`;
}

function obtenerAhoraCaracasStr() {
    const c = getCaracasDateObj();
    const pad = (n) => String(n).padStart(2, '0');
    return `${c.getFullYear()}-${pad(c.getMonth() + 1)}-${pad(c.getDate())} ${pad(c.getHours())}:${pad(c.getMinutes())}:${pad(c.getSeconds())}`;
}

function restarMesesISO(fechaISO, meses) {
    const [y, m, d] = fechaISO.split('-').map(Number);
    const dt = new Date(Date.UTC(y, (m - 1) - meses, 1));
    const ultimoDiaMes = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(d, ultimoDiaMes));
    return dt.toISOString().slice(0, 10);
}

function sumarDiasISO(fechaISO, dias) {
    const [y, m, d] = fechaISO.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + dias));
    return dt.toISOString().slice(0, 10);
}

function obtenerDiaSemanaISO(fechaISO) {
    const [y, m, d] = fechaISO.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Dom, 6=Sab
}

function parseNumeroTasa(val) {
    if (val === null || val === undefined) return NaN;
    const cleaned = String(val).trim().replace(',', '.');
    const num = parseFloat(cleaned);
    return (!isNaN(num) && num > 0) ? num : NaN;
}

function conexionesUnicas(conns) {
    const unicas = [];
    for (const c of (conns || [])) {
        if (c && !unicas.includes(c)) unicas.push(c);
    }
    return unicas;
}

function asegurarColumnasMultimoneda(conns) {
    const cols = ['valor_eur', 'valor_cny', 'valor_try', 'valor_rub'];
    for (const conn of conexionesUnicas(conns)) {
        try {
            const info = conn.prepare(`PRAGMA table_info(grafica_tasas_bcv)`).all();
            const existentes = new Set(info.map(c => c.name));
            for (const col of cols) {
                if (!existentes.has(col)) {
                    conn.exec(`ALTER TABLE grafica_tasas_bcv ADD COLUMN ${col} DECIMAL(18, 8) DEFAULT 0;`);
                }
            }
        } catch (_) {}
    }
}

function leerFlagConfig(dbConn, clave) {
    if (!dbConn) return false;
    try {
        const row = dbConn.prepare(`SELECT valor FROM configuracion WHERE clave = ?`).get(clave);
        return Boolean(row && String(row.valor).trim().toLowerCase() === 'true');
    } catch (_) {
        return false;
    }
}

function guardarFlagConfig(conns, clave) {
    const ahora = obtenerAhoraCaracasStr();
    for (const conn of conexionesUnicas(conns)) {
        try {
            conn.prepare(`
                INSERT INTO configuracion (clave, valor, fecha_actualizacion)
                VALUES (?, 'true', ?)
                ON CONFLICT(clave) DO UPDATE SET
                    valor = 'true',
                    fecha_actualizacion = excluded.fecha_actualizacion
            `).run(clave, ahora);
        } catch (_) {}
        try {
            conn.prepare(`
                INSERT INTO configuraciones_maestras (clave, valor)
                VALUES (?, 'true')
                ON CONFLICT(clave) DO UPDATE SET valor = 'true'
            `).run(clave);
        } catch (_) {}
    }
}

function estaGraficaInicializada(dbConn) {
    if (!dbConn) return { flagActivo: false, multimonedaActivo: false, totalRegistros: 0 };
    const flagActivo = leerFlagConfig(dbConn, CONFIG_KEY_INICIALIZADA);
    const multimonedaActivo = leerFlagConfig(dbConn, CONFIG_KEY_MULTIMONEDA);
    let totalRegistros = 0;

    try {
        const rowCnt = dbConn.prepare(`SELECT COUNT(*) AS total FROM grafica_tasas_bcv`).get();
        totalRegistros = rowCnt ? Number(rowCnt.total || 0) : 0;
    } catch (_) {}

    return { flagActivo, multimonedaActivo, totalRegistros };
}

function marcarGraficaInicializada(conns, { multimoneda = false } = {}) {
    guardarFlagConfig(conns, CONFIG_KEY_INICIALIZADA);
    if (multimoneda) guardarFlagConfig(conns, CONFIG_KEY_MULTIMONEDA);
}

function insertarFilasEnConexiones(conns, filas, { overwrite = false } = {}) {
    if (!filas || filas.length === 0) return 0;
    asegurarColumnasMultimoneda(conns);
    const ahora = obtenerAhoraCaracasStr();
    const sql = overwrite
        ? `
            INSERT INTO grafica_tasas_bcv (fecha, valor, valor_eur, valor_cny, valor_try, valor_rub, fuente, es_fin_de_semana, fecha_registro)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(fecha) DO UPDATE SET
                valor = excluded.valor,
                valor_eur = CASE WHEN excluded.valor_eur > 0 THEN excluded.valor_eur ELSE grafica_tasas_bcv.valor_eur END,
                valor_cny = CASE WHEN excluded.valor_cny > 0 THEN excluded.valor_cny ELSE grafica_tasas_bcv.valor_cny END,
                valor_try = CASE WHEN excluded.valor_try > 0 THEN excluded.valor_try ELSE grafica_tasas_bcv.valor_try END,
                valor_rub = CASE WHEN excluded.valor_rub > 0 THEN excluded.valor_rub ELSE grafica_tasas_bcv.valor_rub END,
                fuente = excluded.fuente,
                es_fin_de_semana = excluded.es_fin_de_semana,
                fecha_registro = excluded.fecha_registro
          `
        : `
            INSERT OR IGNORE INTO grafica_tasas_bcv (fecha, valor, valor_eur, valor_cny, valor_try, valor_rub, fuente, es_fin_de_semana, fecha_registro)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;

    let totalInsertadas = 0;
    for (const conn of conexionesUnicas(conns)) {
        try {
            const stmt = conn.prepare(sql);
            const tx = conn.transaction((items) => {
                let count = 0;
                for (const item of items) {
                    const info = stmt.run(
                        item.fecha,
                        item.valor || 0,
                        item.valor_eur || 0,
                        item.valor_cny || 0,
                        item.valor_try || 0,
                        item.valor_rub || 0,
                        item.fuente || 'NEXUS_API',
                        item.es_fin_de_semana ? 1 : 0,
                        item.fecha_registro || ahora
                    );
                    count += Number(info.changes || 0);
                }
                return count;
            });
            const cnt = tx(filas);
            if (totalInsertadas === 0) totalInsertadas = cnt;
        } catch (err) {
            console.warn(`⚠️ [GRAFICA TASAS] Error escribiendo en DB:`, err.message);
        }
    }
    return totalInsertadas;
}

async function obtenerHistoricoDolarApiPorUrl(url) {
    const resp = await axios.get(url, { timeout: 15000 });
    const lista = Array.isArray(resp.data) ? resp.data : [];
    const ordenados = lista
        .map(item => ({
            fecha: item && item.fecha ? String(item.fecha).slice(0, 10) : '',
            valor: parseNumeroTasa(item ? item.promedio : null)
        }))
        .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.fecha) && !isNaN(item.valor))
        .sort((a, b) => a.fecha.localeCompare(b.fecha));

    const mapa = new Map();
    for (const r of ordenados) {
        mapa.set(r.fecha, r.valor);
    }
    return { ordenados, mapa };
}

function buscarBaselineEnLista(ordenados, fechaCorte) {
    let val = NaN;
    for (const r of ordenados) {
        if (r.fecha <= fechaCorte) val = r.valor;
        else break;
    }
    if (isNaN(val)) {
        const primero = ordenados.find(r => r.fecha >= fechaCorte);
        if (primero) val = primero.valor;
    }
    return val;
}

async function obtenerRatiosFallbackNexus(apiUrl) {
    const endpoint = apiUrl || process.env.NEXUS_TASAS_API_URL || NEXUS_TASAS_API_DEFAULT;
    try {
        const resp = await axios.get(endpoint, { timeout: 6000 });
        const rates = resp.data && resp.data.rates ? resp.data.rates : null;
        if (rates) {
            const usd = parseNumeroTasa(rates.USD ?? rates.usd ?? rates.DOLAR);
            const eur = parseNumeroTasa(rates.EUR ?? rates.eur ?? rates.EURO);
            const cny = parseNumeroTasa(rates.CNY ?? rates.cny ?? rates.YUAN);
            const trY = parseNumeroTasa(rates.TRY ?? rates.try ?? rates.LIRA);
            const rub = parseNumeroTasa(rates.RUB ?? rates.rub ?? rates.RUBLO);
            if (!isNaN(usd)) {
                return {
                    eurRatio: !isNaN(eur) ? (usd / eur) : 0.905,
                    cnyRatio: !isNaN(cny) ? (usd / cny) : 6.67,
                    tryRatio: !isNaN(trY) ? (usd / trY) : 50.3,
                    rubRatio: !isNaN(rub) ? (usd / rub) : 82.1
                };
            }
        }
    } catch (_) {}
    return { eurRatio: 0.905, cnyRatio: 6.67, tryRatio: 50.3, rubRatio: 82.1 };
}

async function obtenerCrossRatesHistoricosPorFechas(fechasHabiles) {
    const mapaFx = new Map();
    const batchSize = 15;
    for (let i = 0; i < fechasHabiles.length; i += batchSize) {
        const lote = fechasHabiles.slice(i, i + batchSize);
        const resultados = await Promise.allSettled(
            lote.map(f => axios.get(FX_API_DATE_URL(f), { timeout: 5000 }).then(r => ({ fecha: f, usd: r.data && r.data.usd ? r.data.usd : null })))
        );
        for (const res of resultados) {
            if (res.status === 'fulfilled' && res.value && res.value.usd) {
                const u = res.value.usd;
                const cny = parseNumeroTasa(u.cny);
                const trY = parseNumeroTasa(u.try);
                const rub = parseNumeroTasa(u.rub);
                if (!isNaN(cny) || !isNaN(trY) || !isNaN(rub)) {
                    mapaFx.set(res.value.fecha, { cny, try: trY, rub });
                }
            }
        }
    }
    return mapaFx;
}

async function completarMultimonedaHistorica({ db, masterDbDirect, apiUrl } = {}) {
    if (!db) return { executed: false, reason: 'no_db' };
    asegurarColumnasMultimoneda([db, masterDbDirect]);

    try {
        const pendientes = db.prepare(`
            SELECT fecha, valor, es_fin_de_semana
            FROM grafica_tasas_bcv
            WHERE valor > 0 AND (valor_eur IS NULL OR valor_eur <= 0 OR valor_cny IS NULL OR valor_cny <= 0 OR valor_try IS NULL OR valor_try <= 0 OR valor_rub IS NULL OR valor_rub <= 0)
            ORDER BY fecha ASC
        `).all();

        if (pendientes.length === 0) {
            guardarFlagConfig([db, masterDbDirect], CONFIG_KEY_MULTIMONEDA);
            return { executed: false, reason: 'already_complete' };
        }

        console.log(`🌐 [GRAFICA TASAS] Completando histórico multimoneda (EUR, CNY, TRY, RUB) para ${pendientes.length} días...`);
        const [eurHist, fallbackRatios] = await Promise.all([
            obtenerHistoricoDolarApiPorUrl(DOLARAPI_HISTORICOS_EUR_URL).catch(() => ({ ordenados: [], mapa: new Map() })),
            obtenerRatiosFallbackNexus(apiUrl)
        ]);

        const fechasHabiles = pendientes.filter(r => !r.es_fin_de_semana).map(r => String(r.fecha).slice(0, 10));
        const mapaFx = await obtenerCrossRatesHistoricosPorFechas(fechasHabiles);

        const primeraFecha = String(pendientes[0].fecha).slice(0, 10);
        let eurActual = buscarBaselineEnLista(eurHist.ordenados, primeraFecha);
        if (isNaN(eurActual)) eurActual = parseFloat(pendientes[0].valor) / fallbackRatios.eurRatio;

        let cnyRatio = fallbackRatios.cnyRatio;
        let tryRatio = fallbackRatios.tryRatio;
        let rubRatio = fallbackRatios.rubRatio;
        let lastCny = parseFloat(pendientes[0].valor) / cnyRatio;
        let lastTry = parseFloat(pendientes[0].valor) / tryRatio;
        let lastRub = parseFloat(pendientes[0].valor) / rubRatio;

        const updates = [];
        for (const row of pendientes) {
            const f = String(row.fecha).slice(0, 10);
            const usdVal = parseFloat(row.valor);
            const esFds = Number(row.es_fin_de_semana || 0) === 1;

            if (!esFds) {
                if (eurHist.mapa.has(f)) {
                    eurActual = eurHist.mapa.get(f);
                } else if (isNaN(eurActual) || eurActual <= 0) {
                    eurActual = usdVal / fallbackRatios.eurRatio;
                }
                const fx = mapaFx.get(f);
                if (fx) {
                    if (!isNaN(fx.cny)) cnyRatio = fx.cny;
                    if (!isNaN(fx.try)) tryRatio = fx.try;
                    if (!isNaN(fx.rub)) rubRatio = fx.rub;
                }
                lastCny = usdVal / cnyRatio;
                lastTry = usdVal / tryRatio;
                lastRub = usdVal / rubRatio;
            }

            updates.push({
                fecha: f,
                valor_eur: Number(eurActual.toFixed(8)),
                valor_cny: Number(lastCny.toFixed(8)),
                valor_try: Number(lastTry.toFixed(8)),
                valor_rub: Number(lastRub.toFixed(8))
            });
        }

        for (const conn of conexionesUnicas([db, masterDbDirect])) {
            try {
                const stmt = conn.prepare(`
                    UPDATE grafica_tasas_bcv
                    SET valor_eur = ?, valor_cny = ?, valor_try = ?, valor_rub = ?
                    WHERE fecha = ?
                `);
                conn.transaction((rows) => {
                    for (const u of rows) {
                        stmt.run(u.valor_eur, u.valor_cny, u.valor_try, u.valor_rub, u.fecha);
                    }
                })(updates);
            } catch (err) {
                console.warn('⚠️ [GRAFICA TASAS] Error actualizando multimoneda en DB:', err.message);
            }
        }

        guardarFlagConfig([db, masterDbDirect], CONFIG_KEY_MULTIMONEDA);
        console.log(`✅ [GRAFICA TASAS] Multimoneda histórica completada (${updates.length} días).`);
        return { executed: true, updated: updates.length };
    } catch (err) {
        console.warn('⚠️ [GRAFICA TASAS] Error en completarMultimonedaHistorica:', err.message);
        return { executed: false, error: err.message };
    }
}

/**
 * Inicializa por única vez la tabla `grafica_tasas_bcv` descargando 3 meses atrás
 * para USD, EUR, CNY, TRY y RUB, propagando el valor del viernes a sábados y domingos.
 * Una vez completada, marca el flag en `configuracion` para no volver a llamar a DolarApi.
 */
async function inicializarGraficaTasasTresMeses({ db, masterDbDirect } = {}) {
    if (!db) return { executed: false, reason: 'no_db' };
    asegurarColumnasMultimoneda([db, masterDbDirect]);

    const estado = estaGraficaInicializada(db);
    if (estado.flagActivo || estado.totalRegistros > 0) {
        if (!estado.flagActivo && estado.totalRegistros > 0) {
            marcarGraficaInicializada([db, masterDbDirect]);
        }
        if (!estado.multimonedaActivo && estado.totalRegistros > 0) {
            await completarMultimonedaHistorica({ db, masterDbDirect });
        }
        // Si masterDbDirect existe y está vacía, copiarle los registros locales sin llamar a la API
        if (masterDbDirect) {
            try {
                const cntM = masterDbDirect.prepare(`SELECT COUNT(*) AS total FROM grafica_tasas_bcv`).get();
                if (!cntM || Number(cntM.total || 0) === 0) {
                    const locales = db.prepare(`SELECT fecha, valor, valor_eur, valor_cny, valor_try, valor_rub, fuente, es_fin_de_semana, fecha_registro FROM grafica_tasas_bcv ORDER BY fecha ASC`).all();
                    if (locales.length > 0) {
                        insertarFilasEnConexiones([masterDbDirect], locales, { overwrite: false });
                    }
                }
            } catch (_) {}
        }
        return { executed: false, reason: 'already_initialized', total: estado.totalRegistros };
    }

    try {
        console.log('🌱 [GRAFICA TASAS] Primera inicialización detectada. Descargando 3 meses históricos multimoneda...');
        const [usdHist, eurHist, fallbackRatios] = await Promise.all([
            obtenerHistoricoDolarApiPorUrl(DOLARAPI_HISTORICOS_URL),
            obtenerHistoricoDolarApiPorUrl(DOLARAPI_HISTORICOS_EUR_URL).catch(() => ({ ordenados: [], mapa: new Map() })),
            obtenerRatiosFallbackNexus()
        ]);

        if (usdHist.ordenados.length === 0) {
            return { executed: false, reason: 'no_valid_records' };
        }

        const hoy = obtenerHoyCaracasISO();
        const fechaCorte = restarMesesISO(hoy, 3);

        let tasaActual = buscarBaselineEnLista(usdHist.ordenados, fechaCorte);
        if (isNaN(tasaActual)) {
            return { executed: false, reason: 'no_baseline_rate' };
        }
        let eurActual = buscarBaselineEnLista(eurHist.ordenados, fechaCorte);
        if (isNaN(eurActual)) eurActual = tasaActual / fallbackRatios.eurRatio;

        // Recolectar fechas hábiles del rango para consultar cross-rates CNY/TRY/RUB
        const fechasHabiles = [];
        let tmp = fechaCorte;
        while (tmp <= hoy) {
            const dow = obtenerDiaSemanaISO(tmp);
            if (dow !== 0 && dow !== 6) fechasHabiles.push(tmp);
            tmp = sumarDiasISO(tmp, 1);
        }
        const mapaFx = await obtenerCrossRatesHistoricosPorFechas(fechasHabiles);

        let cnyRatio = fallbackRatios.cnyRatio;
        let tryRatio = fallbackRatios.tryRatio;
        let rubRatio = fallbackRatios.rubRatio;
        let cnyActual = tasaActual / cnyRatio;
        let tryActual = tasaActual / tryRatio;
        let rubActual = tasaActual / rubRatio;

        const ahora = obtenerAhoraCaracasStr();
        const filasAInsertar = [];
        let cursor = fechaCorte;

        while (cursor <= hoy) {
            const dow = obtenerDiaSemanaISO(cursor);
            const esFinDeSemana = (dow === 0 || dow === 6) ? 1 : 0;

            if (esFinDeSemana === 0 && usdHist.mapa.has(cursor)) {
                tasaActual = usdHist.mapa.get(cursor);
                if (eurHist.mapa.has(cursor)) eurActual = eurHist.mapa.get(cursor);
                else eurActual = tasaActual / fallbackRatios.eurRatio;

                const fx = mapaFx.get(cursor);
                if (fx) {
                    if (!isNaN(fx.cny)) cnyRatio = fx.cny;
                    if (!isNaN(fx.try)) tryRatio = fx.try;
                    if (!isNaN(fx.rub)) rubRatio = fx.rub;
                }
                cnyActual = tasaActual / cnyRatio;
                tryActual = tasaActual / tryRatio;
                rubActual = tasaActual / rubRatio;

                filasAInsertar.push({
                    fecha: cursor,
                    valor: Number(tasaActual.toFixed(8)),
                    valor_eur: Number(eurActual.toFixed(8)),
                    valor_cny: Number(cnyActual.toFixed(8)),
                    valor_try: Number(tryActual.toFixed(8)),
                    valor_rub: Number(rubActual.toFixed(8)),
                    fuente: 'DOLARAPI_BCV',
                    es_fin_de_semana: 0,
                    fecha_registro: ahora
                });
            } else if (esFinDeSemana === 1) {
                filasAInsertar.push({
                    fecha: cursor,
                    valor: Number(tasaActual.toFixed(8)),
                    valor_eur: Number(eurActual.toFixed(8)),
                    valor_cny: Number(cnyActual.toFixed(8)),
                    valor_try: Number(tryActual.toFixed(8)),
                    valor_rub: Number(rubActual.toFixed(8)),
                    fuente: 'DOLARAPI_FIN_SEMANA',
                    es_fin_de_semana: 1,
                    fecha_registro: ahora
                });
            } else {
                if (eurHist.mapa.has(cursor)) eurActual = eurHist.mapa.get(cursor);
                filasAInsertar.push({
                    fecha: cursor,
                    valor: Number(tasaActual.toFixed(8)),
                    valor_eur: Number(eurActual.toFixed(8)),
                    valor_cny: Number(cnyActual.toFixed(8)),
                    valor_try: Number(tryActual.toFixed(8)),
                    valor_rub: Number(rubActual.toFixed(8)),
                    fuente: 'DOLARAPI_FERIADO',
                    es_fin_de_semana: 0,
                    fecha_registro: ahora
                });
            }

            cursor = sumarDiasISO(cursor, 1);
        }

        insertarFilasEnConexiones([db, masterDbDirect], filasAInsertar, { overwrite: false });
        marcarGraficaInicializada([db, masterDbDirect], { multimoneda: true });

        console.log(`✅ [GRAFICA TASAS] Histórico inicial de 3 meses multimoneda guardado (${filasAInsertar.length} días: ${fechaCorte} -> ${hoy}).`);
        return {
            executed: true,
            inserted: filasAInsertar.length,
            desde: fechaCorte,
            hasta: hoy
        };
    } catch (error) {
        console.warn(`⚠️ [GRAFICA TASAS] No se pudo completar la carga inicial de 3 meses (se reintentará en el próximo arranque): ${error.message}`);
        return { executed: false, reason: 'network_error', error: error.message };
    }
}

/**
 * Rellena días faltantes entre la última fecha almacenada y `hastaFechaISO` (por defecto ayer).
 * Los fines de semana toman automáticamente el valor del viernes/último día hábil.
 */
function rellenarHuecosGraficaTasas({ db, masterDbDirect } = {}, hastaFechaISO = null) {
    if (!db) return 0;

    try {
        const hoy = obtenerHoyCaracasISO();
        const limite = hastaFechaISO || sumarDiasISO(hoy, -1);

        const ultimo = db.prepare(`SELECT fecha, valor, valor_eur, valor_cny, valor_try, valor_rub FROM grafica_tasas_bcv ORDER BY fecha DESC LIMIT 1`).get();
        if (!ultimo || !ultimo.fecha || !(parseFloat(ultimo.valor) > 0)) return 0;

        let cursor = sumarDiasISO(String(ultimo.fecha).slice(0, 10), 1);
        if (cursor > limite) return 0;

        const valorArrastre = parseFloat(ultimo.valor);
        const eurArrastre = parseFloat(ultimo.valor_eur || 0);
        const cnyArrastre = parseFloat(ultimo.valor_cny || 0);
        const tryArrastre = parseFloat(ultimo.valor_try || 0);
        const rubArrastre = parseFloat(ultimo.valor_rub || 0);
        const ahora = obtenerAhoraCaracasStr();
        const filas = [];

        while (cursor <= limite) {
            const dow = obtenerDiaSemanaISO(cursor);
            const esFinDeSemana = (dow === 0 || dow === 6) ? 1 : 0;
            filas.push({
                fecha: cursor,
                valor: valorArrastre,
                valor_eur: eurArrastre,
                valor_cny: cnyArrastre,
                valor_try: tryArrastre,
                valor_rub: rubArrastre,
                fuente: esFinDeSemana ? 'FIN_SEMANA_VIERNES' : 'ARRASTRE_DIARIO',
                es_fin_de_semana: esFinDeSemana,
                fecha_registro: ahora
            });
            cursor = sumarDiasISO(cursor, 1);
        }

        if (filas.length > 0) {
            insertarFilasEnConexiones([db, masterDbDirect], filas, { overwrite: false });
            console.log(`📅 [GRAFICA TASAS] Rellenados ${filas.length} día(s) intermedio(s) hasta ${limite}.`);
        }
        return filas.length;
    } catch (err) {
        console.warn('⚠️ [GRAFICA TASAS] Error rellenando huecos:', err.message);
        return 0;
    }
}

/**
 * Consulta las tasas oficiales (USD, EUR, CNY, TRY, RUB) desde nuestra API de Nexus (con fallback directo al BCV).
 */
async function obtenerTasaActualApiNexus({ db, apiUrl } = {}) {
    const endpoint = apiUrl || process.env.NEXUS_TASAS_API_URL || NEXUS_TASAS_API_DEFAULT;

    // 1. Fuente principal: Nuestra API de Nexus
    try {
        const resp = await axios.get(endpoint, { timeout: 10000 });
        const rates = resp.data && resp.data.rates ? resp.data.rates : null;
        if (rates) {
            const val = parseNumeroTasa(rates.USD ?? rates.usd ?? rates.DOLAR ?? rates.dolar);
            if (!isNaN(val)) {
                return {
                    valor: val,
                    valor_eur: parseNumeroTasa(rates.EUR ?? rates.eur ?? rates.EURO) || 0,
                    valor_cny: parseNumeroTasa(rates.CNY ?? rates.cny ?? rates.YUAN) || 0,
                    valor_try: parseNumeroTasa(rates.TRY ?? rates.try ?? rates.LIRA) || 0,
                    valor_rub: parseNumeroTasa(rates.RUB ?? rates.rub ?? rates.RUBLO) || 0,
                    fuente: 'NEXUS_API'
                };
            }
        }
    } catch (err) {
        console.warn(`⚠️ [GRAFICA TASAS] API Nexus (${endpoint}) no disponible, usando fallback: ${err.message}`);
    }

    // 2. Fallback directo al portal oficial del BCV
    try {
        const respBcv = await axios.get('https://www.bcv.org.ve/', {
            timeout: 10000,
            httpsAgent: new https.Agent({ rejectUnauthorized: true }),
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const $ = cheerio.load(respBcv.data);
        const valBcv = parseNumeroTasa($('#dolar strong').text());
        if (!isNaN(valBcv)) {
            return {
                valor: valBcv,
                valor_eur: parseNumeroTasa($('#euro strong').text()) || 0,
                valor_cny: parseNumeroTasa($('#yuan strong').text()) || 0,
                valor_try: parseNumeroTasa($('#lira strong').text()) || 0,
                valor_rub: parseNumeroTasa($('#rublo strong').text()) || 0,
                fuente: 'BCV_SCRAPER_FALLBACK'
            };
        }
    } catch (_) {}

    // 3. Fallback local: TASA_BCV de configuración o última tasa registrada
    if (db) {
        try {
            const cfg = db.prepare(`SELECT valor FROM configuracion WHERE clave = 'TASA_BCV'`).get();
            const valCfg = parseNumeroTasa(cfg ? cfg.valor : null);
            if (!isNaN(valCfg)) {
                return { valor: valCfg, valor_eur: 0, valor_cny: 0, valor_try: 0, valor_rub: 0, fuente: 'TASA_LOCAL_FALLBACK' };
            }
        } catch (_) {}

        try {
            const ult = db.prepare(`SELECT valor, valor_eur, valor_cny, valor_try, valor_rub FROM grafica_tasas_bcv ORDER BY fecha DESC LIMIT 1`).get();
            const valUlt = parseNumeroTasa(ult ? ult.valor : null);
            if (!isNaN(valUlt)) {
                return {
                    valor: valUlt,
                    valor_eur: parseNumeroTasa(ult.valor_eur) || 0,
                    valor_cny: parseNumeroTasa(ult.valor_cny) || 0,
                    valor_try: parseNumeroTasa(ult.valor_try) || 0,
                    valor_rub: parseNumeroTasa(ult.valor_rub) || 0,
                    fuente: 'ARRASTRE_FALLBACK'
                };
            }
        } catch (_) {}
    }

    return null;
}

/**
 * Registra la tasa del día actual en `grafica_tasas_bcv`.
 * - En sábado o domingo replica la última tasa hábil (viernes), sin tomar la tasa anticipada del lunes.
 * - En días hábiles (lunes a viernes) consulta nuestra API de Nexus y guarda el valor del día.
 */
async function ejecutarCapturaDiariaTasa({ db, masterDbDirect, forzarHoy = false, apiUrl } = {}) {
    if (!db) return { success: false, reason: 'no_db' };

    await inicializarGraficaTasasTresMeses({ db, masterDbDirect });

    const hoy = obtenerHoyCaracasISO();
    rellenarHuecosGraficaTasas({ db, masterDbDirect }, sumarDiasISO(hoy, -1));

    const dow = obtenerDiaSemanaISO(hoy);
    const esFinDeSemana = (dow === 0 || dow === 6) ? 1 : 0;
    const ahora = obtenerAhoraCaracasStr();

    if (esFinDeSemana === 1) {
        let rowViernes = null;
        try {
            rowViernes = db.prepare(`
                SELECT valor, valor_eur, valor_cny, valor_try, valor_rub FROM grafica_tasas_bcv
                WHERE fecha < ? AND es_fin_de_semana = 0 AND valor > 0
                ORDER BY fecha DESC LIMIT 1
            `).get(hoy);
            if (!rowViernes || !(parseFloat(rowViernes.valor) > 0)) {
                rowViernes = db.prepare(`
                    SELECT valor, valor_eur, valor_cny, valor_try, valor_rub FROM grafica_tasas_bcv
                    WHERE fecha < ? AND valor > 0
                    ORDER BY fecha DESC LIMIT 1
                `).get(hoy);
            }
        } catch (_) {}

        if (rowViernes && parseFloat(rowViernes.valor) > 0) {
            const tasaViernes = parseFloat(rowViernes.valor);
            insertarFilasEnConexiones([db, masterDbDirect], [{
                fecha: hoy,
                valor: tasaViernes,
                valor_eur: parseFloat(rowViernes.valor_eur || 0),
                valor_cny: parseFloat(rowViernes.valor_cny || 0),
                valor_try: parseFloat(rowViernes.valor_try || 0),
                valor_rub: parseFloat(rowViernes.valor_rub || 0),
                fuente: 'FIN_SEMANA_VIERNES',
                es_fin_de_semana: 1,
                fecha_registro: ahora
            }], { overwrite: forzarHoy });
            console.log(`📌 [GRAFICA TASAS] Fin de semana (${hoy}): tasa del viernes aplicada (${tasaViernes}).`);
            return { success: true, fecha: hoy, valor: tasaViernes, fuente: 'FIN_SEMANA_VIERNES', es_fin_de_semana: 1 };
        }
    }

    if (!forzarHoy) {
        try {
            const existente = db.prepare(`SELECT valor, fuente FROM grafica_tasas_bcv WHERE fecha = ?`).get(hoy);
            if (existente && parseFloat(existente.valor) > 0) {
                return { success: true, fecha: hoy, valor: parseFloat(existente.valor), fuente: existente.fuente, alreadyExists: true };
            }
        } catch (_) {}
    }

    const resTasa = await obtenerTasaActualApiNexus({ db, apiUrl });
    if (!resTasa || !(resTasa.valor > 0)) {
        return { success: false, reason: 'rate_unavailable' };
    }

    insertarFilasEnConexiones([db, masterDbDirect], [{
        fecha: hoy,
        valor: resTasa.valor,
        valor_eur: resTasa.valor_eur || 0,
        valor_cny: resTasa.valor_cny || 0,
        valor_try: resTasa.valor_try || 0,
        valor_rub: resTasa.valor_rub || 0,
        fuente: resTasa.fuente,
        es_fin_de_semana: esFinDeSemana,
        fecha_registro: ahora
    }], { overwrite: true });

    console.log(`✅ [GRAFICA TASAS] Tasa diaria guardada (${hoy}): USD=${resTasa.valor} [${resTasa.fuente}]`);
    return { success: true, fecha: hoy, valor: resTasa.valor, fuente: resTasa.fuente, es_fin_de_semana: esFinDeSemana };
}

function leerHoraConfiguradaRespaldos({ db, autoBackupConfigFile, parseHoraRespaldoConfig }) {
    let horaStr = '06:00 PM';
    let encontradoEnDb = false;

    if (db) {
        try {
            const rowHora = db.prepare(`SELECT valor FROM configuracion WHERE clave = 'hora_backups'`).get();
            if (rowHora && rowHora.valor) {
                horaStr = rowHora.valor;
                encontradoEnDb = true;
            }
        } catch (_) {}
    }

    if (!encontradoEnDb && autoBackupConfigFile && fs.existsSync(autoBackupConfigFile)) {
        try {
            const fCfg = JSON.parse(fs.readFileSync(autoBackupConfigFile, 'utf8'));
            if (fCfg && fCfg.formatted) horaStr = fCfg.formatted;
        } catch (_) {}
    }

    return parseHoraRespaldoConfig(horaStr);
}

/**
 * Crea el controlador del cron diario que captura la tasa a la misma hora
 * configurada en respaldos (por defecto 06:00 PM).
 */
function crearCronGraficaTasas({ getConns, autoBackupConfigFile, parseHoraRespaldoConfig }) {
    let timer = null;
    let watchdogInterval = null;
    let enEjecucion = false;

    async function ejecutarSafe(forzarHoy = false) {
        if (enEjecucion) return { success: false, reason: 'busy' };
        enEjecucion = true;
        try {
            const conns = getConns();
            return await ejecutarCapturaDiariaTasa({
                db: conns.db,
                masterDbDirect: conns.masterDbDirect,
                forzarHoy
            });
        } catch (err) {
            console.error('❌ [CRON GRAFICA TASAS] Error:', err.message);
            return { success: false, error: err.message };
        } finally {
            enEjecucion = false;
        }
    }

    function calcularProximoDisparoMs(parsed) {
        const ahoraCaracas = getCaracasDateObj();
        const proximo = new Date(ahoraCaracas.getTime());
        proximo.setHours(parsed.hour24, parsed.minute, 0, 0);
        if (ahoraCaracas.getTime() >= proximo.getTime()) {
            proximo.setDate(proximo.getDate() + 1);
        }
        return {
            msParaEsperar: Math.max(1000, proximo.getTime() - ahoraCaracas.getTime()),
            ahoraCaracas
        };
    }

    function reprogramar() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        const conns = getConns();
        if (!conns || !conns.db) {
            timer = setTimeout(reprogramar, 60000);
            return;
        }

        const parsed = leerHoraConfiguradaRespaldos({
            db: conns.db,
            autoBackupConfigFile,
            parseHoraRespaldoConfig
        });

        const { msParaEsperar } = calcularProximoDisparoMs(parsed);
        const horasRestantes = (msParaEsperar / 3600000).toFixed(2);

        timer = setTimeout(async () => {
            console.log(`⏰ [CRON GRAFICA TASAS] Hora programada alcanzada (${parsed.formatted}). Capturando tasa del día...`);
            await ejecutarSafe(true);
            reprogramar();
        }, msParaEsperar);

        console.log(`📈 [CRON GRAFICA TASAS] Programado para las ${parsed.formatted} (en ${horasRestantes} horas).`);
    }

    async function iniciar() {
        const conns = getConns();
        if (conns && conns.db) {
            await inicializarGraficaTasasTresMeses({ db: conns.db, masterDbDirect: conns.masterDbDirect });

            const hoy = obtenerHoyCaracasISO();
            rellenarHuecosGraficaTasas({ db: conns.db, masterDbDirect: conns.masterDbDirect }, sumarDiasISO(hoy, -1));

            const parsed = leerHoraConfiguradaRespaldos({
                db: conns.db,
                autoBackupConfigFile,
                parseHoraRespaldoConfig
            });
            const ahoraCaracas = getCaracasDateObj();
            const minActual = ahoraCaracas.getHours() * 60 + ahoraCaracas.getMinutes();
            const minObjetivo = parsed.hour24 * 60 + parsed.minute;
            const dow = obtenerDiaSemanaISO(hoy);

            // Si es fin de semana, rellenar hoy con la tasa del viernes inmediatamente.
            // Si es día hábil y ya pasó la hora configurada hoy y no existe registro de hoy, capturarlo de inmediato.
            if (dow === 0 || dow === 6) {
                await ejecutarSafe(false);
            } else if (minActual >= minObjetivo) {
                const existeHoy = conns.db.prepare(`SELECT 1 FROM grafica_tasas_bcv WHERE fecha = ?`).get(hoy);
                if (!existeHoy) {
                    await ejecutarSafe(true);
                }
            }
        }

        reprogramar();

        // Watchdog ligero cada 15 min: protege ante suspensión/hibernación de Windows pasada la hora del cron
        if (!watchdogInterval) {
            watchdogInterval = setInterval(async () => {
                try {
                    const c = getConns();
                    if (!c || !c.db) return;
                    const parsed = leerHoraConfiguradaRespaldos({
                        db: c.db,
                        autoBackupConfigFile,
                        parseHoraRespaldoConfig
                    });
                    const ahoraC = getCaracasDateObj();
                    const minActual = ahoraC.getHours() * 60 + ahoraC.getMinutes();
                    const minObjetivo = parsed.hour24 * 60 + parsed.minute;
                    const hoy = obtenerHoyCaracasISO();
                    if (minActual >= minObjetivo) {
                        const existeHoy = c.db.prepare(`SELECT 1 FROM grafica_tasas_bcv WHERE fecha = ?`).get(hoy);
                        if (!existeHoy) {
                            await ejecutarSafe(true);
                        }
                    }
                } catch (_) {}
            }, 15 * 60 * 1000);
        }
    }

    return {
        iniciar,
        reprogramar,
        ejecutarAhora: ejecutarSafe
    };
}

function obtenerDatosGraficaTasas(db, dias = 95) {
    if (!db) return [];
    const limitDias = Math.max(1, Math.min(3650, parseInt(dias, 10) || 95));
    try {
        asegurarColumnasMultimoneda([db]);
        const hoy = obtenerHoyCaracasISO();
        const desde = sumarDiasISO(hoy, -limitDias);
        return db.prepare(`
            SELECT fecha, valor, valor_eur, valor_cny, valor_try, valor_rub, fuente, es_fin_de_semana, fecha_registro
            FROM grafica_tasas_bcv
            WHERE fecha >= ?
            ORDER BY fecha ASC
        `).all(desde);
    } catch (err) {
        console.error('❌ [GRAFICA TASAS] Error consultando datos:', err.message);
        return [];
    }
}

module.exports = {
    DOLARAPI_HISTORICOS_URL,
    ESQUEMA_GRAFICA_TASAS,
    INDICES_GRAFICA_TASAS,
    obtenerHoyCaracasISO,
    restarMesesISO,
    sumarDiasISO,
    obtenerDiaSemanaISO,
    estaGraficaInicializada,
    inicializarGraficaTasasTresMeses,
    rellenarHuecosGraficaTasas,
    obtenerTasaActualApiNexus,
    ejecutarCapturaDiariaTasa,
    crearCronGraficaTasas,
    obtenerDatosGraficaTasas
};
