/**
 * Modulo de Inteligencia de Negocios (BI) — Estricto Solo Lectura.
 *
 * Calcula metricas financieras, de tesoreria, cartera CxC/CxP, logistica,
 * inventario avanzado y comportamiento comercial para:
 *  - Estadisticas Generales (/api/maestro/estadisticas/generales-bi)
 *  - Estadisticas Especificas (/api/maestro/estadisticas/especificas-bi)
 *
 * GARANTIA DE AISLAMIENTO:
 * Este modulo ejecuta exclusivamente consultas SELECT (0 INSERT/UPDATE/DELETE)
 * y no altera la estructura ni el ciclo transaccional de CxC, CxP ni Inventario.
 */

'use strict';

const fiscal = require('./contabilidad-fiscal-ve');

// -------------------- UTILIDADES NUMERICAS Y DE FECHA --------------------

function toNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return 0;
    return Math.round((num + Number.EPSILON) * 100) / 100;
}

function round4(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return 0;
    return Math.round((num + Number.EPSILON) * 10000) / 10000;
}

function safeDiv(num, den, fallback = 0) {
    const a = Number(num);
    const b = Number(den);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b) < 1e-9) {
        return fallback;
    }
    const res = a / b;
    return Number.isFinite(res) ? res : fallback;
}

function safeJsonParse(raw, fallback = null) {
    if (!raw) return fallback;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

function getHoyCaracasISO() {
    if (fiscal && typeof fiscal.obtenerHoyCaracasISO === 'function') {
        return fiscal.obtenerHoyCaracasISO();
    }
    return new Date(Date.now() - (4 * 3600 * 1000)).toISOString().slice(0, 10);
}

function dateOnly(val) {
    if (!val) return '';
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const dmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 10);
    }
    return '';
}

function shiftDaysISO(iso, deltaDays) {
    const base = dateOnly(iso) || getHoyCaracasISO();
    const parts = base.split('-').map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + Number(deltaDays || 0)));
    return d.toISOString().slice(0, 10);
}

function daysBetweenISO(startIso, endIso) {
    const a = dateOnly(startIso);
    const b = dateOnly(endIso);
    if (!a || !b) return 0;
    const pa = a.split('-').map(Number);
    const pb = b.split('-').map(Number);
    const ta = Date.UTC(pa[0], pa[1] - 1, pa[2]);
    const tb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
    return Math.round((tb - ta) / 86400000);
}

function normalizarIdentificadorCliente(rif, nombre) {
    const r = String(rif || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (r && r !== 'V000000000' && r !== 'V00000000' && r !== 'SINRIF') {
        return r;
    }
    const n = String(nombre || 'CONSUMIDOR FINAL').trim().toUpperCase();
    return n ? `NOM:${n}` : 'CONSUMIDOR_FINAL';
}

// -------------------- INSPECCION DE ESQUEMA (SOLO LECTURA) --------------------

function createSchemaInspector(conn) {
    const existingTables = new Set();
    const columnsByTable = new Map();

    try {
        const rows = conn.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
        for (const r of rows) {
            if (r && r.name) existingTables.add(String(r.name).toLowerCase());
        }
    } catch (_) {
        // Fallback silencioso si la conexion no permite sqlite_master
    }

    function hasTable(name) {
        return existingTables.has(String(name || '').toLowerCase());
    }

    function getCols(name) {
        const key = String(name || '').toLowerCase();
        if (!hasTable(key)) return new Set();
        if (columnsByTable.has(key)) return columnsByTable.get(key);
        const set = new Set();
        try {
            const safeName = key.replace(/[^a-z0-9_]/g, '');
            const rows = conn.prepare(`PRAGMA table_info("${safeName}")`).all();
            for (const c of rows) {
                if (c && c.name) set.add(String(c.name).toLowerCase());
            }
        } catch (_) {}
        columnsByTable.set(key, set);
        return set;
    }

    function safeAll(sql, params = []) {
        try {
            return conn.prepare(sql).all(...params);
        } catch (_) {
            return [];
        }
    }

    function safeGet(sql, params = []) {
        try {
            return conn.prepare(sql).get(...params);
        } catch (_) {
            return null;
        }
    }

    return { hasTable, getCols, safeAll, safeGet };
}

function companyPredicate(alias, companyId, colsSet) {
    const cid = String(companyId || '').trim();
    if (!cid || cid.toUpperCase() === 'ALL' || (colsSet && !colsSet.has('company_id'))) {
        return { sql: '1=1', params: [] };
    }
    const prefix = alias ? `${alias}.` : '';
    return { sql: `${prefix}company_id = ?`, params: [cid] };
}

// -------------------- TASAS BCV Y CATALOGO DE PRODUCTOS --------------------

function obtenerContextoTasas(schema) {
    let tasaActiva = 1;
    let historial = [];

    if (schema.hasTable('historial_tasas')) {
        const rows = schema.safeAll(`SELECT fecha, valor, fuente FROM historial_tasas ORDER BY fecha DESC, rowid DESC LIMIT 400`);
        for (const r of rows) {
            const f = dateOnly(r.fecha);
            const v = toNum(r.valor, 0);
            if (f && v > 0) {
                historial.push({ fecha: f, valor: v, fuente: r.fuente || 'BCV' });
            }
        }
    }

    if (historial.length > 0) {
        tasaActiva = historial[0].valor;
    } else if (schema.hasTable('parametros_fiscales_ve')) {
        const p = schema.safeGet(`SELECT tasa_bcv_manual FROM parametros_fiscales_ve WHERE tasa_bcv_manual > 0 LIMIT 1`);
        if (p && toNum(p.tasa_bcv_manual) > 0) tasaActiva = toNum(p.tasa_bcv_manual);
    }

    if (tasaActiva <= 0 && schema.hasTable('ventas_locales')) {
        const ult = schema.safeGet(`SELECT tasa_bcv FROM ventas_locales WHERE tasa_bcv > 0 ORDER BY fecha_emision DESC LIMIT 1`);
        if (ult && toNum(ult.tasa_bcv) > 0) tasaActiva = toNum(ult.tasa_bcv);
    }
    if (tasaActiva <= 0) tasaActiva = 1;

    // Serie ordenada cronologicamente (un registro por fecha, tomando el ultimo del dia)
    const porDia = new Map();
    for (let i = historial.length - 1; i >= 0; i--) {
        porDia.set(historial[i].fecha, historial[i].valor);
    }
    const fechasAsc = Array.from(porDia.keys()).sort();
    const serieAsc = fechasAsc.map((f) => ({ fecha: f, valor: porDia.get(f) }));

    // Calcular variacion 30 dias y devaluacion diaria promedio
    const hoy = getHoyCaracasISO();
    const hace30d = shiftDaysISO(hoy, -30);
    const serie30d = serieAsc.filter((x) => x.fecha >= hace30d);

    let variacion30dPct = 0;
    let tasaDevalDiariaAutoPct = 0;
    let fuenteDevaluacion = 'SIN_HISTORIAL';

    const refSerie = serie30d.length >= 2 ? serie30d : serieAsc.slice(-30);
    if (refSerie.length >= 2) {
        const primero = refSerie[0];
        const ultimo = refSerie[refSerie.length - 1];
        const diasDiff = Math.max(1, daysBetweenISO(primero.fecha, ultimo.fecha));
        if (primero.valor > 0 && ultimo.valor > 0) {
            variacion30dPct = round2(((ultimo.valor - primero.valor) / primero.valor) * 100);
            const factorDiario = Math.pow(ultimo.valor / primero.valor, 1 / diasDiff) - 1;
            tasaDevalDiariaAutoPct = round4(Math.max(0, factorDiario * 100));
            fuenteDevaluacion = serie30d.length >= 2 ? 'BCV_30D' : 'BCV_HISTORIAL';
        }
    }

    // Buscar tasa BCV vigente en una fecha dada (<= fecha o la mas cercana)
    function tasaParaFecha(isoDate) {
        const target = dateOnly(isoDate);
        if (!target || serieAsc.length === 0) return tasaActiva;
        let match = serieAsc[0].valor;
        for (const item of serieAsc) {
            if (item.fecha <= target) {
                match = item.valor;
            } else {
                break;
            }
        }
        return match > 0 ? match : tasaActiva;
    }

    return {
        tasaActiva: round4(tasaActiva),
        variacion30dPct,
        tasaDevalDiariaAutoPct,
        fuenteDevaluacion,
        historial30d: refSerie.slice(-30).map((x) => ({ fecha: x.fecha, valor: round2(x.valor) })),
        tasaParaFecha,
        serieAsc
    };
}

function construirMapaProductos(schema, companyId, tasaActiva) {
    const byId = new Map();
    const byCodigo = new Map();
    if (!schema.hasTable('productos_locales')) {
        return { byId, byCodigo, lista: [] };
    }

    const cols = schema.getCols('productos_locales');
    const cf = companyPredicate('', companyId, cols);
    const selectCols = ['id', 'nombre'];
    ['codigo', 'precio', 'precio_compra', 'datos_json', 'categoria', 'currency', 'moneda', 'porcentaje_ganancia'].forEach((c) => {
        if (cols.has(c)) selectCols.push(c);
    });

    const rows = schema.safeAll(
        `SELECT ${selectCols.join(', ')} FROM productos_locales WHERE ${cf.sql}`,
        cf.params
    );

    const stockPorProd = new Map();
    if (schema.hasTable('stock_maestro')) {
        const scols = schema.getCols('stock_maestro');
        const scf = companyPredicate('', companyId, scols);
        const sRows = schema.safeAll(
            `SELECT producto_id, SUM(CASE WHEN cantidad_real > 0 THEN cantidad_real ELSE 0 END) AS stock_total
             FROM stock_maestro WHERE ${scf.sql} GROUP BY producto_id`,
            scf.params
        );
        for (const sr of sRows) {
            stockPorProd.set(String(sr.producto_id), toNum(sr.stock_total, 0));
        }
    }

    const lista = [];
    for (const r of rows) {
        const dj = safeJsonParse(r.datos_json, {}) || {};
        const monedaRaw = String(r.currency || r.moneda || dj.currency || dj.moneda || 'USD').toUpperCase();
        const esBs = monedaRaw === 'BS' || monedaRaw === 'VES';

        let precioRaw = toNum(r.precio, 0);
        if (!precioRaw && dj.precios?.p1?.venta) precioRaw = toNum(dj.precios.p1.venta, 0);

        let compraRaw = toNum(r.precio_compra, 0);
        if (!compraRaw && dj.precio_compra) compraRaw = toNum(dj.precio_compra, 0);
        if (!compraRaw && dj.costo) compraRaw = toNum(dj.costo, 0);
        if (!compraRaw && dj.precios?.p1?.compra) compraRaw = toNum(dj.precios.p1.compra, 0);

        const precioUsd = esBs ? safeDiv(precioRaw, tasaActiva, 0) : precioRaw;
        const costoUsd = esBs ? safeDiv(compraRaw, tasaActiva, 0) : compraRaw;
        const stockActual = stockPorProd.get(String(r.id)) || 0;
        const categoria = String(r.categoria || dj.categoria || dj.category || 'General').trim() || 'General';

        const prod = {
            id: String(r.id),
            codigo: String(r.codigo || dj.codigo || '').trim(),
            nombre: String(r.nombre || 'Producto').trim(),
            categoria,
            moneda: esBs ? 'BS' : 'USD',
            precioUsd: round4(precioUsd),
            costoUsd: round4(costoUsd),
            stockActual: round4(stockActual)
        };
        byId.set(prod.id, prod);
        if (prod.codigo) byCodigo.set(prod.codigo.toUpperCase(), prod);
        lista.push(prod);
    }

    return { byId, byCodigo, lista };
}

function normalizarNaturalezaMetodo(natRaw, nombreRaw = '', idRaw = '') {
    const nat = String(natRaw || '').trim().toUpperCase();
    if (nat === 'CASHEA' || nat === 'CREDITO' || nat === 'CONTADO') return nat;
    if (nat === 'CRÉDITO') return 'CREDITO';
    const nom = String(nombreRaw || '').trim().toUpperCase();
    if (nom.includes('CASHEA')) return 'CASHEA';
    if (String(idRaw || '').trim() === '1000008' || nom.includes('CREDITO') || nom.includes('CRÉDITO')) return 'CREDITO';
    return 'CONTADO';
}

function construirMapaMetodosPago(schema) {
    const byId = new Map();
    const byName = new Map();
    const normKey = (s) => String(s || '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    for (const tabla of ['metodos_pago_locales', 'metodos_pago_maestro']) {
        if (!schema.hasTable(tabla)) continue;
        const cols = schema.getCols(tabla);
        const selNat = cols.has('naturaleza') ? 'naturaleza' : "'' AS naturaleza";
        const rows = schema.safeAll(`SELECT id, nombre, ${selNat} FROM ${tabla}`);
        for (const r of rows) {
            const nat = normalizarNaturalezaMetodo(r.naturaleza, r.nombre, r.id);
            if (r.id != null) {
                const idKey = String(r.id).trim();
                if (idKey) byId.set(idKey, nat);
            }
            if (r.nombre) {
                const nomKey = normKey(r.nombre);
                if (nomKey) byName.set(nomKey, nat);
            }
        }
    }
    return { byId, byName, normKey };
}

function resolverCanalVenta(metodoPagoRaw, numeroFactura, cuentasCasheaFacturasSet, metodosMap = null) {
    if (numeroFactura && cuentasCasheaFacturasSet && cuentasCasheaFacturasSet.has(String(numeroFactura).trim())) {
        return 'CASHEA';
    }
    const clasificarClave = (clave) => {
        const clean = String(clave || '').trim();
        if (!clean) return 'CONTADO';
        if (metodosMap) {
            if (metodosMap.byId.has(clean)) return metodosMap.byId.get(clean);
            const nk = metodosMap.normKey(clean);
            if (metodosMap.byName.has(nk)) return metodosMap.byName.get(nk);
        }
        const upper = clean.toUpperCase();
        if (upper.includes('CASHEA')) return 'CASHEA';
        if (upper === '1000008' || upper.includes('CREDITO') || upper.includes('CRÉDITO')) return 'CREDITO';
        return 'CONTADO';
    };

    const rawStr = String(metodoPagoRaw || '').trim();
    const parsed = safeJsonParse(rawStr, null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        let tieneCashea = false;
        let tieneCredito = false;
        for (const [k, v] of Object.entries(parsed)) {
            if (k.startsWith('vuelto_')) continue;
            const val = toNum(v, 0);
            if (val <= 0) continue;
            const nat = clasificarClave(k);
            if (nat === 'CASHEA') tieneCashea = true;
            if (nat === 'CREDITO') tieneCredito = true;
        }
        if (tieneCashea) return 'CASHEA';
        if (tieneCredito) return 'CREDITO';
        return 'CONTADO';
    }

    if (rawStr.toUpperCase().includes('CASHEA')) return 'CASHEA';
    const natSimple = clasificarClave(rawStr);
    if (natSimple !== 'CONTADO') return natSimple;
    if (rawStr.toUpperCase().includes('CREDITO') || rawStr.toUpperCase().includes('CRÉDITO')) return 'CREDITO';
    return 'CONTADO';
}

function extraerItemsVenta(ventaRow, tasaVenta, prodMap) {
    const dj = safeJsonParse(ventaRow.datos_json, {}) || {};
    const rawItems = Array.isArray(dj.productos) ? dj.productos : (Array.isArray(dj.items) ? dj.items : []);
    const signo = Number(ventaRow.es_nota_credito) === 1 ? -1 : 1;

    const itemsNormalizados = [];
    let cogsItemsSumUsd = 0;

    for (const it of rawItems) {
        if (!it) continue;
        const pid = String(it.id || it.producto_id || '').trim();
        const codigo = String(it.codigo || '').trim();
        if (pid === 'PAGO-DEUDA' || codigo.toUpperCase() === 'DEUDA') continue;

        const qtyAbs = Math.max(0, toNum(it.cantidad !== undefined ? it.cantidad : it.quantity, 1));
        if (qtyAbs <= 0) continue;

        const catalogMatch = prodMap.byId.get(pid) || (codigo ? prodMap.byCodigo.get(codigo.toUpperCase()) : null);
        const monedaIt = String(it.moneda || (catalogMatch ? catalogMatch.moneda : 'BS')).toUpperCase();
        const esBs = monedaIt === 'BS' || monedaIt === 'VES';

        // Precio unitario de venta (exento IVA o base segun facturacion.html)
        const precioRaw = toNum(it.precio, 0);
        let precioUnitUsd = esBs ? safeDiv(precioRaw, tasaVenta, 0) : precioRaw;

        if (precioUnitUsd <= 0 && toNum(it.baseImponible, 0) > 0) {
            const baseRaw = toNum(it.baseImponible, 0);
            const baseUsd = esBs ? safeDiv(baseRaw, tasaVenta, 0) : baseRaw;
            precioUnitUsd = safeDiv(baseUsd, qtyAbs, 0);
        }

        // Costo unitario historico en la venta -> respaldo catalogo -> respaldo precio - ganancia
        const costoRaw = toNum(it.precio_compra !== undefined && it.precio_compra !== '' ? it.precio_compra : it.costo, 0);
        let costoUnitUsd = 0;
        if (costoRaw > 0) {
            costoUnitUsd = esBs ? safeDiv(costoRaw, tasaVenta, 0) : costoRaw;
        } else if (catalogMatch && catalogMatch.costoUsd > 0) {
            costoUnitUsd = catalogMatch.costoUsd;
        } else if (toNum(it.ganancia_unitaria, -1) >= 0 && precioUnitUsd > 0) {
            const ganUnitRaw = toNum(it.ganancia_unitaria, 0);
            const ganUnitUsd = esBs ? safeDiv(ganUnitRaw, tasaVenta, 0) : ganUnitRaw;
            costoUnitUsd = Math.max(0, precioUnitUsd - ganUnitUsd);
        }

        const ingresoUsd = precioUnitUsd * qtyAbs * signo;
        const cogsUsd = costoUnitUsd * qtyAbs * signo;
        const gananciaUnitUsd = Math.max(0, precioUnitUsd - costoUnitUsd);
        const gananciaUsd = (toNum(it.ganancia_unitaria, -1) >= 0 && !esBs)
            ? toNum(it.ganancia_unitaria, 0) * qtyAbs * signo
            : (ingresoUsd - cogsUsd);

        cogsItemsSumUsd += cogsUsd;

        itemsNormalizados.push({
            productId: pid || (catalogMatch ? catalogMatch.id : `SKU-${String(it.nombre || 'X').slice(0, 20)}`),
            codigo: codigo || (catalogMatch ? catalogMatch.codigo : ''),
            nombre: String(it.nombre || (catalogMatch ? catalogMatch.nombre : 'Producto')).trim(),
            categoria: catalogMatch ? catalogMatch.categoria : 'General',
            qty: qtyAbs * signo,
            qtyAbs,
            precioUnitUsd: round4(precioUnitUsd),
            costoUnitUsd: round4(costoUnitUsd),
            ingresoUsd: round4(ingresoUsd),
            cogsUsd: round4(cogsUsd),
            gananciaUsd: round4(gananciaUsd)
        });
    }

    return { items: itemsNormalizados, cogsItemsSumUsd, signo };
}

// -------------------- OPEX UNIFICADO (CXP GASTOS + CAJA + NOMINA) --------------------

function calcularOpexPeriodo(schema, { companyId, fechaInicio, fechaFin, tasaCtx }) {
    let cxpGastosUsd = 0;
    let cajaEgresosUsd = 0;
    let nominaUsd = 0;
    const categoriasMap = new Map();
    const eventosDiarios = new Map();

    const addDaily = (iso, usd) => {
        const f = dateOnly(iso);
        if (!f || !usd) return;
        eventosDiarios.set(f, (eventosDiarios.get(f) || 0) + usd);
    };

    const addCat = (cat, usd) => {
        const key = String(cat || 'Gastos Generales').trim() || 'Gastos Generales';
        categoriasMap.set(key, (categoriasMap.get(key) || 0) + usd);
    };

    // 1. Gastos operativos registrados en CxP (excluye compras de inventario / notas credito)
    if (schema.hasTable('movimientos_cuentas_pagar')) {
        const cols = schema.getCols('movimientos_cuentas_pagar');
        const cf = companyPredicate('', companyId, cols);
        const sel = ['fecha', 'monto'];
        ['monto_bs', 'tasa_bcv', 'motivo', 'es_gasto_operativo', 'categoria_gasto', 'tipo_documento', 'estado', 'neto_a_pagar_usd', 'razon'].forEach((c) => {
            if (cols.has(c)) sel.push(c);
        });
        const rows = schema.safeAll(
            `SELECT ${sel.join(', ')} FROM movimientos_cuentas_pagar
             WHERE ${cf.sql} AND substr(fecha, 1, 10) >= ? AND substr(fecha, 1, 10) <= ?`,
            [...cf.params, fechaInicio, fechaFin]
        );
        for (const r of rows) {
            const estado = String(r.estado || '').toUpperCase();
            if (estado === 'ANULADO' || estado === 'ANULADA') continue;
            const tipoDoc = String(r.tipo_documento || r.motivo || '').toUpperCase();
            if (tipoDoc === 'NOTA_CREDITO' || tipoDoc === 'ABONO') continue;

            const esGastoOp = Number(r.es_gasto_operativo) === 1
                || Boolean(r.categoria_gasto && String(r.categoria_gasto).trim() !== '' && tipoDoc !== 'FACTURA')
                || tipoDoc.includes('GASTO')
                || tipoDoc.includes('SERVICIO');
            if (!esGastoOp) continue;

            let usd = toNum(r.monto, 0);
            if (usd <= 0 && toNum(r.neto_a_pagar_usd, 0) > 0) usd = toNum(r.neto_a_pagar_usd, 0);
            if (usd <= 0 && toNum(r.monto_bs, 0) > 0) {
                const t = toNum(r.tasa_bcv, 0) > 0 ? toNum(r.tasa_bcv) : tasaCtx.tasaParaFecha(r.fecha);
                usd = safeDiv(toNum(r.monto_bs, 0), t, 0);
            }
            if (usd > 0) {
                cxpGastosUsd += usd;
                addCat(r.categoria_gasto || r.motivo || 'Gasto Operativo CxP', usd);
                addDaily(r.fecha, usd);
            }
        }
    }

    // 2. Egresos y gastos operativos en movimientos de caja
    if (schema.hasTable('movimientos_caja_locales')) {
        const cols = schema.getCols('movimientos_caja_locales');
        const cf = companyPredicate('', companyId, cols);
        const sel = ['tipo', 'concepto', 'monto', 'fecha'];
        if (cols.has('monto_usd')) sel.push('monto_usd');
        const rows = schema.safeAll(
            `SELECT ${sel.join(', ')} FROM movimientos_caja_locales
             WHERE ${cf.sql} AND substr(fecha, 1, 10) >= ? AND substr(fecha, 1, 10) <= ?`,
            [...cf.params, fechaInicio, fechaFin]
        );
        for (const r of rows) {
            const tipo = String(r.tipo || '').toLowerCase();
            if (!/(egreso|gasto|retiro|salida)/.test(tipo)) continue;
            let usd = toNum(r.monto_usd, 0);
            if (usd <= 0 && toNum(r.monto, 0) > 0) {
                usd = safeDiv(toNum(r.monto, 0), tasaCtx.tasaParaFecha(r.fecha), 0);
            }
            if (usd > 0) {
                cajaEgresosUsd += usd;
                addCat('Caja Chica / Egresos POS', usd);
                addDaily(r.fecha, usd);
            }
        }
    }

    // 3. Nomina neta del periodo (evita anuladas/borradores si existen cerradas)
    if (schema.hasTable('nominas_periodos')) {
        const cols = schema.getCols('nominas_periodos');
        const cf = companyPredicate('', companyId, cols);
        const sel = ['fecha_inicio', 'fecha_fin', 'total_neto_usd', 'total_neto_bs', 'estado'];
        if (cols.has('tasa_bcv')) sel.push('tasa_bcv');
        const rows = schema.safeAll(
            `SELECT ${sel.join(', ')} FROM nominas_periodos
             WHERE ${cf.sql} AND substr(fecha_fin, 1, 10) >= ? AND substr(fecha_inicio, 1, 10) <= ?`,
            [...cf.params, fechaInicio, fechaFin]
        );
        for (const r of rows) {
            const est = String(r.estado || '').toUpperCase();
            if (est === 'ANULADA' || est === 'CANCELADA') continue;
            let usd = toNum(r.total_neto_usd, 0);
            if (usd <= 0 && toNum(r.total_neto_bs, 0) > 0) {
                const t = toNum(r.tasa_bcv, 0) > 0 ? toNum(r.tasa_bcv) : tasaCtx.tasaParaFecha(r.fecha_fin);
                usd = safeDiv(toNum(r.total_neto_bs, 0), t, 0);
            }
            if (usd > 0) {
                nominaUsd += usd;
                addCat('Nomina y Personal', usd);
                addDaily(r.fecha_fin || r.fecha_inicio, usd);
            }
        }
    }

    const totalUsd = cxpGastosUsd + cajaEgresosUsd + nominaUsd;
    const porCategoria = Array.from(categoriasMap.entries())
        .map(([categoria, usd]) => ({
            categoria,
            usd: round2(usd),
            pct: round2(safeDiv(usd, totalUsd, 0) * 100)
        }))
        .sort((a, b) => b.usd - a.usd);

    return {
        totalUsd: round2(totalUsd),
        porFuente: {
            cxpGastosUsd: round2(cxpGastosUsd),
            cajaEgresosUsd: round2(cajaEgresosUsd),
            nominaUsd: round2(nominaUsd)
        },
        porCategoria,
        eventosDiarios
    };
}

// ============================================================================
// 1. ESTADISTICAS GENERALES BI (NIVEL EMPRESA)
// ============================================================================

function obtenerEstadisticasGeneralesBiDb(conn, opts = {}) {
    if (!conn) throw new Error('Conexion SQLite requerida');

    const schema = createSchemaInspector(conn);
    const companyId = String(opts.companyId || opts.company_id || '').trim();
    const hoyISO = getHoyCaracasISO();
    const fechaFin = dateOnly(opts.fechaFin || opts.fecha_fin) || hoyISO;
    const fechaInicio = dateOnly(opts.fechaInicio || opts.fecha_inicio) || shiftDaysISO(fechaFin, -29);
    const diasPeriodo = Math.max(1, daysBetweenISO(fechaInicio, fechaFin) + 1);

    const friccionBsPct = Math.max(0, Math.min(50, toNum(opts.friccionBsPct ?? opts.friccion_bs_pct, 1.5)));
    const diasInmovilizacionBs = Math.max(0, Math.min(60, toNum(opts.diasInmovilizacionBs ?? opts.dias_inmovilizacion_bs, 3)));

    const tasaCtx = obtenerContextoTasas(schema);
    const tasaActiva = tasaCtx.tasaActiva;
    const devalDiariaPct = opts.tasaDevalDiariaPct !== undefined && opts.tasaDevalDiariaPct !== '' && opts.tasaDevalDiariaPct !== null
        ? Math.max(0, toNum(opts.tasaDevalDiariaPct, tasaCtx.tasaDevalDiariaAutoPct))
        : tasaCtx.tasaDevalDiariaAutoPct;

    const prodMap = construirMapaProductos(schema, companyId, tasaActiva);
    const inventarioCostoUsd = prodMap.lista.reduce((acc, p) => acc + (Math.max(0, p.stockActual) * Math.max(0, p.costoUsd)), 0);

    // ---------------- A. TESORERIA, FRICCION BIMONETARIA Y SLAPR ----------------
    let saldoUsd = 0;
    let saldoBs = 0;
    const cuentasResumen = [];

    if (schema.hasTable('cuentas_tesoreria')) {
        const tcols = schema.getCols('cuentas_tesoreria');
        const cf = companyPredicate('', companyId, tcols);
        const actFilter = tcols.has('activa') ? 'AND COALESCE(activa, 1) = 1' : '';
        const rows = schema.safeAll(
            `SELECT id, nombre, tipo_cuenta, moneda, saldo_actual FROM cuentas_tesoreria WHERE ${cf.sql} ${actFilter}`,
            cf.params
        );
        for (const c of rows) {
            const mon = String(c.moneda || 'USD').toUpperCase();
            const sal = toNum(c.saldo_actual, 0);
            const esBs = mon === 'BS' || mon === 'VES';
            if (esBs) saldoBs += sal;
            else saldoUsd += sal;
            cuentasResumen.push({
                id: c.id,
                nombre: c.nombre || 'Cuenta',
                tipo: c.tipo_cuenta || 'GENERAL',
                moneda: esBs ? 'VES' : 'USD',
                saldo_original: round2(sal),
                saldo_usd_eq: round2(esBs ? safeDiv(sal, tasaActiva, 0) : sal)
            });
        }
    }

    const saldoBsEnUsd = safeDiv(saldoBs, tasaActiva, 0);
    const saldoBrutoUsd = saldoUsd + saldoBsEnUsd;
    const friccionTotalPct = round2(Math.min(95, friccionBsPct + (devalDiariaPct * diasInmovilizacionBs)));
    const perdidaFriccionUsd = saldoBsEnUsd > 0 ? (saldoBsEnUsd * (friccionTotalPct / 100)) : 0;
    const efectivoAjustadoUsd = saldoUsd + Math.max(0, saldoBsEnUsd - perdidaFriccionUsd);

    const inicio90d = shiftDaysISO(fechaFin, -89);
    const opex90 = calcularOpexPeriodo(schema, { companyId, fechaInicio: inicio90d, fechaFin, tasaCtx });
    const opexSemanalPromedioUsd = opex90.totalUsd > 0 ? (opex90.totalUsd / 90) * 7 : 0;
    const slaprSemanas = opexSemanalPromedioUsd > 0 ? safeDiv(efectivoAjustadoUsd, opexSemanalPromedioUsd, 0) : null;

    let slaprEstado = 'SIN_DATOS';
    let slaprEtiqueta = 'Sin OpEx registrado en 90d';
    if (slaprSemanas !== null) {
        if (slaprSemanas >= 13) {
            slaprEstado = 'VERDE';
            slaprEtiqueta = 'Colchon Saludable (>= 13 semanas)';
        } else if (slaprSemanas >= 8) {
            slaprEstado = 'AMARILLO';
            slaprEtiqueta = 'Zona de Atencion (8 a 12.9 semanas)';
        } else if (slaprSemanas >= 4) {
            slaprEstado = 'AMARILLO';
            slaprEtiqueta = 'Alerta Preventiva (4 a 7.9 semanas)';
        } else {
            slaprEstado = 'ROJO';
            slaprEtiqueta = 'Riesgo Critico de Liquidez (< 4 semanas)';
        }
    }

    // ---------------- B. CARTERA CXC, CXP, CEI, DSO, ADD Y AGING ----------------
    const cuentasCxcAll = [];
    const abonosCxcAll = [];
    const agingCxcBuckets = { POR_VENCER: { usd: 0, docs: 0 }, '0_30': { usd: 0, docs: 0 }, '31_60': { usd: 0, docs: 0 }, '61_90': { usd: 0, docs: 0 }, MAS_90: { usd: 0, docs: 0 } };
    const cxcTopVencidas = [];

    if (schema.hasTable('cuentas_por_cobrar')) {
        const cols = schema.getCols('cuentas_por_cobrar');
        const cf = companyPredicate('', companyId, cols);
        const rows = schema.safeAll(`SELECT * FROM cuentas_por_cobrar WHERE ${cf.sql}`, cf.params);
        for (const r of rows) {
            const estado = String(r.estado || 'PENDIENTE').toUpperCase();
            if (estado === 'ANULADA' || estado === 'ANULADO') continue;

            const tasaEm = toNum(r.tasa_emision, 0) > 0 ? toNum(r.tasa_emision) : tasaCtx.tasaParaFecha(r.fecha);
            const montoUsd = toNum(r.monto_usd, 0) > 0
                ? toNum(r.monto_usd)
                : safeDiv(toNum(r.monto_bs !== undefined && r.monto_bs !== null ? r.monto_bs : r.monto, 0), tasaEm, 0);
            const montoPagadoRaw = toNum(r.monto_pagado, 0);
            // monto_pagado en cuentas_por_cobrar suele registrarse en USD o Bs; inferir con seguridad
            const pagadoUsd = montoUsd > 0 && montoPagadoRaw > montoUsd * 1.5 && tasaEm > 2
                ? safeDiv(montoPagadoRaw, tasaEm, 0)
                : montoPagadoRaw;
            const saldoUsdActual = estado === 'PAGADO' || estado === 'COBRADA' || estado === 'PAGADA'
                ? 0
                : Math.max(0, montoUsd - pagadoUsd);

            const fechaEm = dateOnly(r.fecha) || hoyISO;
            const aging = fiscal.calcularAgingDocumento({
                fechaEmision: fechaEm,
                fechaVencimiento: r.fecha_vencimiento || null,
                diasCredito: parseInt(r.dias_credito || 30, 10),
                fechaCorte: fechaFin
            });

            const item = {
                id: r.id,
                factura_nro: r.factura_nro || r.referencia || `CXC-${r.id}`,
                cliente_rif: r.cliente_rif || r.rif_cliente || r.cliente_id || '',
                cliente_nombre: r.cliente_nombre || r.cliente_id || 'Cliente',
                fecha: fechaEm,
                fecha_vencimiento: aging.fecha_vencimiento,
                dias_credito: parseInt(r.dias_credito || 30, 10),
                dias_vencido: aging.dias_vencido,
                bucket: aging.bucket,
                tasa_emision: tasaEm,
                monto_usd: montoUsd,
                saldo_usd: saldoUsdActual
            };
            cuentasCxcAll.push(item);

            if (saldoUsdActual > 0.01) {
                const b = agingCxcBuckets[aging.bucket] || agingCxcBuckets.POR_VENCER;
                b.usd += saldoUsdActual;
                b.docs += 1;
                if (aging.dias_vencido > 0) {
                    cxcTopVencidas.push({
                        factura_nro: item.factura_nro,
                        cliente: item.cliente_nombre,
                        rif: item.cliente_rif,
                        fecha: item.fecha,
                        vencimiento: item.fecha_vencimiento,
                        dias_vencido: item.dias_vencido,
                        saldo_usd: round2(saldoUsdActual)
                    });
                }
            }
        }
    }

    if (schema.hasTable('abonos_cuentas_cobrar')) {
        const cols = schema.getCols('abonos_cuentas_cobrar');
        const cf = companyPredicate('', companyId, cols);
        const rows = schema.safeAll(`SELECT * FROM abonos_cuentas_cobrar WHERE ${cf.sql}`, cf.params);
        for (const a of rows) {
            const fechaAb = dateOnly(a.fecha);
            const tasaAb = toNum(a.tasa_bcv, 0) > 0 ? toNum(a.tasa_bcv) : tasaCtx.tasaParaFecha(fechaAb);
            const usd = toNum(a.monto_usd, 0) > 0
                ? toNum(a.monto_usd)
                : safeDiv(toNum(a.monto_bs, 0), tasaAb, 0);
            abonosCxcAll.push({
                cuenta_id: a.cuenta_id,
                factura_nro: a.factura_nro,
                fecha: fechaAb,
                usd,
                diferencial_cambiario_bs: toNum(a.diferencial_cambiario_bs, 0),
                descuento_pp_usd: toNum(a.descuento_pronto_pago_usd, 0)
            });
        }
    }

    // Reconstruir CxC al inicio y al final del rango para CEI exacto
    const cxcIdByFactura = new Map();
    for (const c of cuentasCxcAll) {
        if (c.id && c.factura_nro) cxcIdByFactura.set(String(c.factura_nro).trim(), `ID:${c.id}`);
    }

    const abonosPorCuentaAntesInicio = new Map();
    const abonosPorCuentaHastaFin = new Map();
    let abonosPeriodoUsd = 0;
    let diferencialAbonosPeriodoBs = 0;

    for (const ab of abonosCxcAll) {
        const facTrim = String(ab.factura_nro || '').trim();
        const key = ab.cuenta_id
            ? `ID:${ab.cuenta_id}`
            : (facTrim && cxcIdByFactura.has(facTrim) ? cxcIdByFactura.get(facTrim) : `FAC:${facTrim}`);
        if (ab.fecha && ab.fecha < fechaInicio) {
            abonosPorCuentaAntesInicio.set(key, (abonosPorCuentaAntesInicio.get(key) || 0) + ab.usd);
        }
        if (!ab.fecha || ab.fecha <= fechaFin) {
            abonosPorCuentaHastaFin.set(key, (abonosPorCuentaHastaFin.get(key) || 0) + ab.usd);
        }
        if (ab.fecha && ab.fecha >= fechaInicio && ab.fecha <= fechaFin) {
            abonosPeriodoUsd += ab.usd;
            diferencialAbonosPeriodoBs += ab.diferencial_cambiario_bs;
        }
    }

    let cxcInicialUsd = 0;
    let cxcFinalUsd = 0;
    let ventasCreditoPeriodoUsd = 0;
    let plazoPonderadoNum = 0;
    let plazoPonderadoDen = 0;

    for (const c of cuentasCxcAll) {
        const key = c.id ? `ID:${c.id}` : `FAC:${c.factura_nro || ''}`;
        if (c.fecha < fechaInicio) {
            const pagAntes = abonosPorCuentaAntesInicio.get(key) || 0;
            const saldoEst = Math.max(0, c.monto_usd - pagAntes);
            // Si no existen registros en abonos para cuentas ya cerradas, usar saldo actual como cota
            cxcInicialUsd += (c.saldo_usd === 0 && pagAntes === 0) ? 0 : saldoEst;
        }
        if (c.fecha >= fechaInicio && c.fecha <= fechaFin) {
            ventasCreditoPeriodoUsd += c.monto_usd;
        }
        if (c.fecha <= fechaFin) {
            const pagHastaFin = abonosPorCuentaHastaFin.get(key) || 0;
            const saldoFinEst = Math.max(0, c.monto_usd - pagHastaFin);
            cxcFinalUsd += (pagHastaFin === 0) ? c.saldo_usd : Math.min(c.monto_usd, saldoFinEst);
        }
        if (c.saldo_usd > 0.01) {
            plazoPonderadoNum += c.dias_credito * c.saldo_usd;
            plazoPonderadoDen += c.saldo_usd;
        }
    }

    const cxcAbiertaUsd = cuentasCxcAll.reduce((acc, c) => acc + c.saldo_usd, 0);
    const denominadorCei = cxcInicialUsd + ventasCreditoPeriodoUsd;
    const ceiPct = denominadorCei > 0.01
        ? round2(Math.max(0, Math.min(100, safeDiv(denominadorCei - cxcFinalUsd, denominadorCei, 0) * 100)))
        : null;

    // CxP Abierta y Aging CxP
    let cxpAbiertaUsd = 0;
    const agingCxpBuckets = { POR_VENCER: { usd: 0, docs: 0 }, '0_30': { usd: 0, docs: 0 }, '31_60': { usd: 0, docs: 0 }, '61_90': { usd: 0, docs: 0 }, MAS_90: { usd: 0, docs: 0 } };
    const cxpTopVencidas = [];
    const cuentasCxpAbiertas = [];

    if (schema.hasTable('movimientos_cuentas_pagar')) {
        const cols = schema.getCols('movimientos_cuentas_pagar');
        const cf = companyPredicate('', companyId, cols);
        const rows = schema.safeAll(`SELECT * FROM movimientos_cuentas_pagar WHERE ${cf.sql}`, cf.params);
        for (const r of rows) {
            const estado = String(r.estado || 'PENDIENTE').toUpperCase();
            if (estado === 'PAGADO' || estado === 'ANULADO' || estado === 'ANULADA') continue;
            const tipoDoc = String(r.tipo_documento || r.motivo || '').toUpperCase();
            if (tipoDoc === 'NOTA_CREDITO' || tipoDoc === 'ABONO') continue;

            const tasaEm = toNum(r.tasa_bcv, 0) > 0 ? toNum(r.tasa_bcv) : tasaCtx.tasaParaFecha(r.fecha);
            let montoUsd = toNum(r.neto_a_pagar_usd, 0) > 0 ? toNum(r.neto_a_pagar_usd) : toNum(r.monto, 0);
            if (montoUsd <= 0 && toNum(r.monto_bs, 0) > 0) montoUsd = safeDiv(toNum(r.monto_bs, 0), tasaEm, 0);

            const abonado = toNum(r.monto_abonado, 0);
            const saldoUsd = Math.max(0, montoUsd - abonado);
            if (saldoUsd <= 0.01) continue;

            cxpAbiertaUsd += saldoUsd;
            const fechaEm = dateOnly(r.fecha) || hoyISO;
            const aging = fiscal.calcularAgingDocumento({
                fechaEmision: fechaEm,
                fechaVencimiento: r.fecha_vencimiento || null,
                diasCredito: parseInt(r.dias_credito || 30, 10),
                fechaCorte: fechaFin
            });
            const b = agingCxpBuckets[aging.bucket] || agingCxpBuckets.POR_VENCER;
            b.usd += saldoUsd;
            b.docs += 1;

            cuentasCxpAbiertas.push({ saldoUsd, tasaEm });
            if (aging.dias_vencido > 0) {
                cxpTopVencidas.push({
                    comprobante: r.comprobante || r.id,
                    proveedor: r.razon || r.proveedor_rif || 'Proveedor',
                    fecha: fechaEm,
                    vencimiento: aging.fecha_vencimiento,
                    dias_vencido: aging.dias_vencido,
                    saldo_usd: round2(saldoUsd)
                });
            }
        }
    }

    // Anticipos y Saldos a Favor
    let anticiposCxcUsd = 0;
    let anticiposCxpUsd = 0;
    if (schema.hasTable('anticipos_saldos_favor')) {
        const cols = schema.getCols('anticipos_saldos_favor');
        const cf = companyPredicate('', companyId, cols);
        const rows = schema.safeAll(
            `SELECT modulo, saldo_disponible_usd, saldo_disponible_bs, estado FROM anticipos_saldos_favor WHERE ${cf.sql}`,
            cf.params
        );
        for (const a of rows) {
            const est = String(a.estado || 'DISPONIBLE').toUpperCase();
            if (est === 'AGOTADO' || est === 'ANULADO') continue;
            const usd = toNum(a.saldo_disponible_usd, 0) > 0
                ? toNum(a.saldo_disponible_usd)
                : safeDiv(toNum(a.saldo_disponible_bs, 0), tasaActiva, 0);
            if (String(a.modulo || '').toUpperCase() === 'CXP') anticiposCxpUsd += usd;
            else anticiposCxcUsd += usd;
        }
    }

    // ---------------- C. VENTAS DEL PERIODO, UTILIDAD COMERCIAL VS CAMBIARIA ----------------
    let ingresosNetosUsd = 0;
    let cogsPeriodoUsd = 0;
    const ventasFacturaFechaMap = new Map();

    if (schema.hasTable('ventas_locales')) {
        const cols = schema.getCols('ventas_locales');
        const cf = companyPredicate('', companyId, cols);
        const extraFilters = [];
        if (cols.has('es_anulada')) extraFilters.push('COALESCE(es_anulada, 0) = 0');
        if (cols.has('estado')) extraFilters.push("UPPER(COALESCE(estado, '')) != 'ANULADA'");
        const anulaSql = extraFilters.length ? `AND ${extraFilters.join(' AND ')}` : '';

        const sel = ['id', 'numero_factura', 'base_imponible', 'monto_exento', 'monto_total', 'monto_iva', 'tasa_bcv', 'ganancia_venta', 'datos_json', 'fecha_emision'];
        if (cols.has('es_nota_credito')) sel.push('es_nota_credito');
        if (cols.has('monto_igtf')) sel.push('monto_igtf');

        const rows = schema.safeAll(
            `SELECT ${sel.join(', ')} FROM ventas_locales
             WHERE ${cf.sql} ${anulaSql} AND substr(fecha_emision, 1, 10) >= ? AND substr(fecha_emision, 1, 10) <= ?`,
            [...cf.params, fechaInicio, fechaFin]
        );

        for (const v of rows) {
            const f = dateOnly(v.fecha_emision);
            const tasaV = toNum(v.tasa_bcv, 0) > 0 ? toNum(v.tasa_bcv) : tasaCtx.tasaParaFecha(f);
            const signo = Number(v.es_nota_credito) === 1 ? -1 : 1;

            const baseExBs = toNum(v.base_imponible, 0) + toNum(v.monto_exento, 0);
            const netSinImpBs = baseExBs > 0 ? baseExBs : Math.max(0, toNum(v.monto_total, 0) - toNum(v.monto_iva, 0) - toNum(v.monto_igtf, 0));
            const ventaUsd = safeDiv(netSinImpBs, tasaV, 0) * signo;

            const { cogsItemsSumUsd, items } = extraerItemsVenta(v, tasaV, prodMap);
            let cogsV = cogsItemsSumUsd;
            if (cogsV === 0 && items.length === 0 && toNum(v.ganancia_venta, 0) > 0) {
                cogsV = Math.max(0, Math.abs(ventaUsd) - toNum(v.ganancia_venta, 0)) * signo;
            }
            ingresosNetosUsd += ventaUsd;
            cogsPeriodoUsd += cogsV;
        }

        // Mapa de fechas de facturas recientes para calcular DRAF historico de guias
        const fRows = schema.safeAll(
            `SELECT numero_factura, fecha_emision FROM ventas_locales WHERE ${cf.sql} ${anulaSql} AND numero_factura IS NOT NULL`,
            cf.params
        );
        for (const fr of fRows) {
            if (fr.numero_factura) ventasFacturaFechaMap.set(String(fr.numero_factura).trim(), dateOnly(fr.fecha_emision));
        }
    }

    const utilidadComercialBrutaUsd = ingresosNetosUsd - cogsPeriodoUsd;
    const margenComercialPct = round2(safeDiv(utilidadComercialBrutaUsd, ingresosNetosUsd, 0) * 100);

    const dsoCreditoDias = ventasCreditoPeriodoUsd > 0.01
        ? round2((cxcFinalUsd / ventasCreditoPeriodoUsd) * diasPeriodo)
        : null;
    const dsoTotalDias = ingresosNetosUsd > 0.01
        ? round2((cxcFinalUsd / ingresosNetosUsd) * diasPeriodo)
        : 0;
    const plazoPromedioCreditoDias = plazoPonderadoDen > 0 ? round2(plazoPonderadoNum / plazoPonderadoDen) : 30;
    const addDias = dsoCreditoDias !== null ? round2(dsoCreditoDias - plazoPromedioCreditoDias) : round2(dsoTotalDias - plazoPromedioCreditoDias);

    // Diferencial Cambiario Realizado y No Realizado
    let diferencialNotasRealizadoBs = 0;
    if (schema.hasTable('notas_ajuste_cambiario')) {
        const cols = schema.getCols('notas_ajuste_cambiario');
        const cf = companyPredicate('', companyId, cols);
        const rows = schema.safeAll(
            `SELECT modulo, tipo_ajuste, variacion_bruta_bs, estado, fecha_operacion
             FROM notas_ajuste_cambiario
             WHERE ${cf.sql} AND substr(fecha_operacion, 1, 10) >= ? AND substr(fecha_operacion, 1, 10) <= ?`,
            [...cf.params, fechaInicio, fechaFin]
        );
        for (const n of rows) {
            const est = String(n.estado || '').toUpperCase();
            if (est === 'ANULADA' || est === 'REVERSADA') continue;
            // En CxC variacion positiva favorece flujo cobrado; en CxP variacion positiva es sobrecosto cambiario
            const varBs = toNum(n.variacion_bruta_bs, 0);
            const sign = String(n.modulo || '').toUpperCase() === 'CXP' ? -1 : 1;
            diferencialNotasRealizadoBs += varBs * sign;
        }
    }

    const diferencialRealizadoBs = diferencialAbonosPeriodoBs + diferencialNotasRealizadoBs;
    const diferencialRealizadoUsd = safeDiv(diferencialRealizadoBs, tasaActiva, 0);

    let diferencialNoRealizadoBs = 0;
    let fuenteNoRealizado = 'CARTERA_ABIERTA_VIVA';
    let usadoCierreMensual = false;

    if (schema.hasTable('cierres_cambiarios_mensuales')) {
        const cols = schema.getCols('cierres_cambiarios_mensuales');
        const cf = companyPredicate('', companyId, cols);
        const periodoYm = fechaFin.slice(0, 7).replace(/[^0-9]/g, '');
        const actCond = cols.has('estado') ? "AND UPPER(COALESCE(estado, 'VIGENTE')) != 'REVERTIDO'" : '';
        const rows = schema.safeAll(
            `SELECT modulo, diferencial_no_realizado_bs FROM cierres_cambiarios_mensuales
             WHERE ${cf.sql} ${actCond} AND REPLACE(COALESCE(periodo_aaaamm, ''), '-', '') <= ? ORDER BY REPLACE(COALESCE(periodo_aaaamm, ''), '-', '') DESC LIMIT 2`,
            [...cf.params, periodoYm]
        );
        if (rows.length > 0) {
            usadoCierreMensual = true;
            fuenteNoRealizado = 'CIERRE_CAMBIARIO_MENSUAL';
            for (const cr of rows) {
                const sign = String(cr.modulo || '').toUpperCase() === 'CXP' ? -1 : 1;
                diferencialNoRealizadoBs += toNum(cr.diferencial_no_realizado_bs, 0) * sign;
            }
        }
    }

    if (!usadoCierreMensual) {
        // Calculo en vivo sobre CxC y CxP abiertas
        for (const c of cuentasCxcAll) {
            if (c.saldo_usd > 0.01) {
                diferencialNoRealizadoBs += c.saldo_usd * (tasaActiva - c.tasa_emision);
            }
        }
        for (const p of cuentasCxpAbiertas) {
            diferencialNoRealizadoBs -= p.saldoUsd * (tasaActiva - p.tasaEm);
        }
    }

    const diferencialNoRealizadoUsd = safeDiv(diferencialNoRealizadoBs, tasaActiva, 0);
    const resultadoCombinadoAbs = Math.abs(utilidadComercialBrutaUsd) + Math.abs(diferencialRealizadoUsd);
    const pesoCambiarioPct = resultadoCombinadoAbs > 0 ? round2((Math.abs(diferencialRealizadoUsd) / resultadoCombinadoAbs) * 100) : 0;

    // ---------------- D. RAZONES DE LIQUIDEZ ----------------
    const activoCorrienteUsd = efectivoAjustadoUsd + cxcAbiertaUsd + inventarioCostoUsd;
    const pasivoCorrienteUsd = cxpAbiertaUsd + anticiposCxcUsd;
    const razonCorriente = pasivoCorrienteUsd > 0.01 ? round2(activoCorrienteUsd / pasivoCorrienteUsd) : null;
    const pruebaAcida = pasivoCorrienteUsd > 0.01 ? round2((efectivoAjustadoUsd + cxcAbiertaUsd) / pasivoCorrienteUsd) : null;
    const razonEfectivo = pasivoCorrienteUsd > 0.01 ? round2(efectivoAjustadoUsd / pasivoCorrienteUsd) : null;

    // ---------------- E. CAPITAL EN LIMBO LOGISTICO (GUIAS SIN FACTURAR) Y DRAF ----------------
    let capitalLimboUsd = 0;
    let capitalLimboBs = 0;
    let guiasPendientesCount = 0;
    let guiasFacturadasCount = 0;
    let drafAbiertasSum = 0;
    let drafFacturadasSum = 0;
    const detalleGuias = [];

    const tablaGuias = schema.hasTable('guias_despacho') ? 'guias_despacho' : (schema.hasTable('guia_despacho') ? 'guia_despacho' : null);
    if (tablaGuias) {
        const gcols = schema.getCols(tablaGuias);
        const cf = companyPredicate('', companyId, gcols);
        const fechaCol = gcols.has('fecha') ? 'fecha' : (gcols.has('fecha_emision') ? 'fecha_emision' : null);
        const sel = ['id', 'numero_guia', 'cliente_nombre', 'cliente_rif', 'factura_asociada', 'datos_json'];
        if (fechaCol) sel.push(`${fechaCol} AS fecha_guia`);

        const gRows = schema.safeAll(`SELECT ${sel.join(', ')} FROM ${tablaGuias} WHERE ${cf.sql}`, cf.params);
        for (const g of gRows) {
            const fGuia = dateOnly(g.fecha_guia) || hoyISO;
            const facAsoc = String(g.factura_asociada || '').trim();
            const parsed = safeJsonParse(g.datos_json, {}) || {};
            const totalBsRaw = toNum(
                parsed?.documentoElectronico?.Encabezado?.Totales?.TotalAPagar
                ?? parsed?.documentoElectronico?.Encabezado?.Totales?.Subtotal
                ?? parsed?.total_bs
                ?? 0,
                0
            );
            const monedaGuia = String(parsed?.documentoElectronico?.Encabezado?.IdentificacionDocumento?.Moneda || 'VES').toUpperCase();
            const tasaGuia = tasaCtx.tasaParaFecha(fGuia);
            const valorUsd = (monedaGuia === 'USD') ? totalBsRaw : safeDiv(totalBsRaw, tasaGuia, 0);
            const valorBs = (monedaGuia === 'USD') ? (totalBsRaw * tasaGuia) : totalBsRaw;

            if (!facAsoc) {
                guiasPendientesCount += 1;
                const diasLimbo = Math.max(0, daysBetweenISO(fGuia, hoyISO));
                drafAbiertasSum += diasLimbo;
                capitalLimboUsd += valorUsd;
                capitalLimboBs += valorBs;
                detalleGuias.push({
                    numero_guia: g.numero_guia || g.id,
                    cliente: g.cliente_nombre || 'Sin cliente',
                    rif: g.cliente_rif || '',
                    fecha: fGuia,
                    dias_en_limbo: diasLimbo,
                    valor_bs: round2(valorBs),
                    valor_usd: round2(valorUsd)
                });
            } else {
                const fFactura = ventasFacturaFechaMap.get(facAsoc);
                if (fFactura) {
                    guiasFacturadasCount += 1;
                    drafFacturadasSum += Math.max(0, daysBetweenISO(fGuia, fFactura));
                }
            }
        }
    }

    detalleGuias.sort((a, b) => b.dias_en_limbo - a.dias_en_limbo || b.valor_usd - a.valor_usd);
    cxcTopVencidas.sort((a, b) => b.dias_vencido - a.dias_vencido || b.saldo_usd - a.saldo_usd);
    cxpTopVencidas.sort((a, b) => b.dias_vencido - a.dias_vencido || b.saldo_usd - a.saldo_usd);

    const formatAging = (buckets, totalBase) => {
        const out = {};
        for (const [k, v] of Object.entries(buckets)) {
            out[k] = {
                usd: round2(v.usd),
                docs: v.docs,
                pct: round2(safeDiv(v.usd, totalBase, 0) * 100)
            };
        }
        return out;
    };

    return {
        periodo: {
            fecha_inicio: fechaInicio,
            fecha_fin: fechaFin,
            dias: diasPeriodo
        },
        tasa_bcv: {
            activa: tasaActiva,
            devaluacion_diaria_pct: round4(devalDiariaPct),
            variacion_30d_pct: tasaCtx.variacion30dPct,
            fuente_devaluacion: tasaCtx.fuenteDevaluacion,
            historial_30d: tasaCtx.historial30d
        },
        tesoreria_slapr: {
            saldo_usd: round2(saldoUsd),
            saldo_bs: round2(saldoBs),
            saldo_bs_en_usd: round2(saldoBsEnUsd),
            saldo_bruto_usd: round2(saldoBrutoUsd),
            friccion_bs_pct: round2(friccionBsPct),
            dias_inmovilizacion_bs: diasInmovilizacionBs,
            devaluacion_diaria_pct: round4(devalDiariaPct),
            friccion_total_pct: friccionTotalPct,
            perdida_friccion_usd: round2(perdidaFriccionUsd),
            efectivo_ajustado_usd: round2(efectivoAjustadoUsd),
            opex_90d_usd: round2(opex90.totalUsd),
            opex_semanal_promedio_usd: round2(opexSemanalPromedioUsd),
            opex_desglose: opex90.porFuente,
            opex_categorias: opex90.porCategoria,
            slapr_semanas: slaprSemanas !== null ? round2(slaprSemanas) : null,
            slapr_estado: slaprEstado,
            slapr_etiqueta: slaprEtiqueta,
            cuentas_resumen: cuentasResumen
        },
        liquidez: {
            activo_corriente_usd: round2(activoCorrienteUsd),
            pasivo_corriente_usd: round2(pasivoCorrienteUsd),
            inventario_costo_usd: round2(inventarioCostoUsd),
            razon_corriente: razonCorriente,
            prueba_acida: pruebaAcida,
            razon_efectivo: razonEfectivo
        },
        cartera_cxc_cxp: {
            cxc_inicial_usd: round2(cxcInicialUsd),
            cxc_final_usd: round2(cxcFinalUsd),
            ventas_credito_periodo_usd: round2(ventasCreditoPeriodoUsd),
            abonos_periodo_usd: round2(abonosPeriodoUsd),
            cei_pct: ceiPct,
            dso_credito_dias: dsoCreditoDias,
            dso_total_dias: dsoTotalDias,
            plazo_promedio_credito_dias: plazoPromedioCreditoDias,
            add_dias: addDias,
            cxc_abierta_usd: round2(cxcAbiertaUsd),
            cxp_abierta_usd: round2(cxpAbiertaUsd),
            anticipos_cxc_usd: round2(anticiposCxcUsd),
            anticipos_cxp_usd: round2(anticiposCxpUsd),
            aging_cxc: formatAging(agingCxcBuckets, cxcAbiertaUsd),
            aging_cxp: formatAging(agingCxpBuckets, cxpAbiertaUsd),
            cxc_top_vencidas: cxcTopVencidas.slice(0, 50),
            cxp_top_vencidas: cxpTopVencidas.slice(0, 50)
        },
        resultado_comercial_vs_cambiario: {
            ingresos_netos_usd: round2(ingresosNetosUsd),
            cogs_usd: round2(cogsPeriodoUsd),
            utilidad_comercial_bruta_usd: round2(utilidadComercialBrutaUsd),
            margen_comercial_pct: margenComercialPct,
            diferencial_abonos_bs: round2(diferencialAbonosPeriodoBs),
            diferencial_notas_bs: round2(diferencialNotasRealizadoBs),
            diferencial_realizado_bs: round2(diferencialRealizadoBs),
            diferencial_realizado_usd: round2(diferencialRealizadoUsd),
            diferencial_no_realizado_bs: round2(diferencialNoRealizadoBs),
            diferencial_no_realizado_usd: round2(diferencialNoRealizadoUsd),
            fuente_no_realizado: fuenteNoRealizado,
            peso_cambiario_pct: pesoCambiarioPct
        },
        capital_limbo_logistico: {
            guias_pendientes_count: guiasPendientesCount,
            capital_limbo_usd: round2(capitalLimboUsd),
            capital_limbo_bs: round2(capitalLimboBs),
            draf_abiertas_dias: guiasPendientesCount > 0 ? round2(drafAbiertasSum / guiasPendientesCount) : 0,
            draf_facturadas_dias: guiasFacturadasCount > 0 ? round2(drafFacturadasSum / guiasFacturadasCount) : null,
            guias_facturadas_count: guiasFacturadasCount,
            detalle_guias: detalleGuias.slice(0, 100)
        }
    };
}

// ============================================================================
// 2. ESTADISTICAS ESPECIFICAS BI (PROFUNDA OPERACION Y RENTABILIDAD)
// ============================================================================

function obtenerCostoReposicionPorSku(schema, companyId, prodMap, tasaCtx) {
    const ultCostoPorSku = new Map(); // id -> { costoUsd, fecha, fuente }
    let skusConFacturaCompra = 0;

    // 1. Buscar ultima factura de compra real en movimientos_cuentas_pagar.contenido_fac
    if (schema.hasTable('movimientos_cuentas_pagar')) {
        const cols = schema.getCols('movimientos_cuentas_pagar');
        if (cols.has('contenido_fac')) {
            const cf = companyPredicate('', companyId, cols);
            const rows = schema.safeAll(
                `SELECT fecha, tasa_bcv, monto, monto_bs, contenido_fac
                 FROM movimientos_cuentas_pagar
                 WHERE ${cf.sql} AND contenido_fac IS NOT NULL AND TRIM(contenido_fac) != ''
                 ORDER BY fecha DESC, rowid DESC LIMIT 600`,
                cf.params
            );
            for (const r of rows) {
                const items = safeJsonParse(r.contenido_fac, null);
                if (!Array.isArray(items) || items.length === 0) continue;

                const tasaFac = toNum(r.tasa_bcv, 0) > 0 ? toNum(r.tasa_bcv) : tasaCtx.tasaParaFecha(r.fecha);
                // Detectar si los costos en contenido_fac estan en Bs comparando suma contra monto vs monto_bs
                const sumaSub = items.reduce((acc, it) => acc + toNum(it?.subtotal, 0), 0);
                const mUsd = toNum(r.monto, 0);
                const mBs = toNum(r.monto_bs, 0);
                const contenidoEnBs = mUsd > 0 && mBs > mUsd * 1.5 && sumaSub > mUsd * 1.5;

                for (const it of items) {
                    if (!it) continue;
                    const pid = String(it.id || it.producto_id || '').trim();
                    const cod = String(it.codigo || '').trim();
                    const prod = prodMap.byId.get(pid) || (cod ? prodMap.byCodigo.get(cod.toUpperCase()) : null);
                    const key = prod ? prod.id : pid;
                    if (!key || ultCostoPorSku.has(key)) continue;

                    const rawC = toNum(it.costo !== undefined ? it.costo : it.precio, 0);
                    if (rawC <= 0) continue;
                    const cUsd = contenidoEnBs ? safeDiv(rawC, tasaFac, 0) : rawC;
                    if (cUsd > 0) {
                        ultCostoPorSku.set(key, {
                            costoUsd: round4(cUsd),
                            fecha: dateOnly(r.fecha),
                            fuente: 'FACTURA_COMPRA'
                        });
                        skusConFacturaCompra += 1;
                    }
                }
            }
        }
    }

    // 2. Respaldo secundario si entradas_inventario tiene filas
    if (schema.hasTable('entradas_inventario')) {
        const cols = schema.getCols('entradas_inventario');
        const cf = companyPredicate('', companyId, cols);
        const rows = schema.safeAll(
            `SELECT product_id, costo_unitario, fecha_modificacion FROM entradas_inventario
             WHERE ${cf.sql} AND costo_unitario > 0 ORDER BY fecha_modificacion DESC LIMIT 500`,
            cf.params
        );
        for (const r of rows) {
            const key = String(r.product_id || '').trim();
            if (!key || ultCostoPorSku.has(key)) continue;
            ultCostoPorSku.set(key, {
                costoUsd: round4(toNum(r.costo_unitario, 0)),
                fecha: dateOnly(r.fecha_modificacion),
                fuente: 'ENTRADAS_INVENTARIO'
            });
        }
    }

    return { ultCostoPorSku, skusConFacturaCompra };
}

function capitalizarNombreCajero(str) {
    return String(str || '')
        .trim()
        .replace(/[._-]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

function obtenerMapaNombresCajeros(schema, companyId) {
    const map = new Map();
    if (schema.hasTable('empleados')) {
        const cols = schema.getCols('empleados');
        const cf = companyPredicate('', companyId, cols);
        const sel = [];
        if (cols.has('ID_empleado')) sel.push('ID_empleado');
        if (cols.has('id')) sel.push('id');
        if (cols.has('nombre')) sel.push('nombre');
        if (cols.has('usuario_uid')) sel.push('usuario_uid');
        if (cols.has('email')) sel.push('email');
        if (sel.length && cols.has('nombre')) {
            const rows = schema.safeAll(`SELECT ${sel.join(', ')} FROM empleados WHERE ${cf.sql}`, cf.params);
            for (const r of rows) {
                const nom = String(r.nombre || '').trim();
                if (!nom) continue;
                if (r.ID_empleado) map.set(String(r.ID_empleado).trim(), nom);
                if (r.id) map.set(String(r.id).trim(), nom);
                if (r.usuario_uid) map.set(String(r.usuario_uid).trim(), nom);
                if (r.email) map.set(String(r.email).trim().toLowerCase(), nom);
            }
        }
    }
    if (schema.hasTable('usuarios_locales')) {
        const cols = schema.getCols('usuarios_locales');
        const cf = companyPredicate('', companyId, cols);
        const idCol = cols.has('uid') ? 'uid' : (cols.has('id') ? 'id' : null);
        const nameCol = cols.has('nombre') ? 'nombre' : (cols.has('username') ? 'username' : (cols.has('usuario') ? 'usuario' : null));
        const sel = [];
        if (idCol) sel.push(`${idCol} AS cid`);
        if (nameCol) sel.push(`${nameCol} AS nombre`);
        if (cols.has('email')) sel.push('email');
        if (cols.has('role')) sel.push('role');
        if (idCol && sel.length) {
            const rows = schema.safeAll(`SELECT ${sel.join(', ')} FROM usuarios_locales WHERE ${cf.sql}`, cf.params);
            for (const r of rows) {
                const cid = String(r.cid || '').trim();
                if (!cid) continue;
                let nom = r.nombre ? String(r.nombre).trim() : '';
                if (!nom && r.email) {
                    const base = String(r.email).split('@')[0];
                    nom = String(r.role || '').toLowerCase() === 'admin' ? 'Administrador' : capitalizarNombreCajero(base);
                }
                if (nom && !map.has(cid)) map.set(cid, nom);
                if (nom && r.email && !map.has(String(r.email).trim().toLowerCase())) {
                    map.set(String(r.email).trim().toLowerCase(), nom);
                }
            }
        }
    }
    return map;
}

function obtenerEstadisticasEspecificasBiDb(conn, opts = {}) {
    if (!conn) throw new Error('Conexion SQLite requerida');

    const schema = createSchemaInspector(conn);
    const companyId = String(opts.companyId || opts.company_id || '').trim();
    const hoyISO = getHoyCaracasISO();
    const fechaFin = dateOnly(opts.fechaFin || opts.fecha_fin) || hoyISO;
    const fechaInicio = dateOnly(opts.fechaInicio || opts.fecha_inicio) || shiftDaysISO(fechaFin, -29);
    const diasPeriodo = Math.max(1, daysBetweenISO(fechaInicio, fechaFin) + 1);

    // Periodo anterior inmediato de igual longitud para detectar tijera OpEx vs Ingresos
    const prevFin = shiftDaysISO(fechaInicio, -1);
    const prevInicio = shiftDaysISO(prevFin, -(diasPeriodo - 1));

    // Ventana amplia unica para alimentar 90d, 30d STR, TTM cohortes/concentracion y elasticidad
    const inicio90d = shiftDaysISO(fechaFin, -89);
    const inicio30d = shiftDaysISO(fechaFin, -29);
    const inicio365d = shiftDaysISO(fechaFin, -364);
    const minLoadFecha = [fechaInicio, prevInicio, inicio365d].sort()[0];

    const tasaCtx = obtenerContextoTasas(schema);
    const tasaActiva = tasaCtx.tasaActiva;
    const prodMap = construirMapaProductos(schema, companyId, tasaActiva);
    const cajerosMap = obtenerMapaNombresCajeros(schema, companyId);
    const metodosMap = construirMapaMetodosPago(schema);
    const { ultCostoPorSku, skusConFacturaCompra } = obtenerCostoReposicionPorSku(schema, companyId, prodMap, tasaCtx);

    // Cashea data desde cuentas_por_cobrar
    const casheaFacturasSet = new Set();
    let casheaOperacionesCount = 0;
    let casheaSaldoFinanciadoUsd = 0;
    let casheaInicialCxcUsd = 0;
    let casheaComisionUsd = 0;
    let casheaCobradoLiquidadoUsd = 0;
    const cxcAbiertasPorCliente = new Map();

    if (schema.hasTable('cuentas_por_cobrar')) {
        const cols = schema.getCols('cuentas_por_cobrar');
        const cf = companyPredicate('', companyId, cols);
        const rows = schema.safeAll(`SELECT * FROM cuentas_por_cobrar WHERE ${cf.sql}`, cf.params);
        for (const r of rows) {
            const est = String(r.estado || 'PENDIENTE').toUpperCase();
            if (est === 'ANULADA' || est === 'ANULADO') continue;
            const fechaEm = dateOnly(r.fecha);
            const tasaEm = toNum(r.tasa_emision, 0) > 0 ? toNum(r.tasa_emision) : tasaCtx.tasaParaFecha(fechaEm);
            const montoUsd = toNum(r.monto_usd, 0) > 0
                ? toNum(r.monto_usd)
                : safeDiv(toNum(r.monto_bs !== undefined && r.monto_bs !== null ? r.monto_bs : r.monto, 0), tasaEm, 0);
            const pagRaw = toNum(r.monto_pagado, 0);
            const pagUsd = montoUsd > 0 && pagRaw > montoUsd * 1.5 && tasaEm > 2 ? safeDiv(pagRaw, tasaEm, 0) : pagRaw;

            if (Number(r.es_cashea) === 1) {
                if (r.factura_nro) casheaFacturasSet.add(String(r.factura_nro).trim());
                if (!fechaEm || (fechaEm >= fechaInicio && fechaEm <= fechaFin)) {
                    casheaOperacionesCount += 1;
                    casheaSaldoFinanciadoUsd += montoUsd;
                    casheaInicialCxcUsd += toNum(r.cashea_inicial_usd, 0);
                    casheaComisionUsd += toNum(r.cashea_comision_usd, 0);
                    casheaCobradoLiquidadoUsd += Math.min(montoUsd, pagUsd);
                }
            }

            // Acumular perfil crediticio por cliente para Score TEHC
            const cid = normalizarIdentificadorCliente(r.cliente_rif || r.rif_cliente || r.cliente_id, r.cliente_nombre);
            if (!cxcAbiertasPorCliente.has(cid)) {
                cxcAbiertasPorCliente.set(cid, {
                    cliente_rif: r.cliente_rif || r.rif_cliente || r.cliente_id || '',
                    cliente_nombre: r.cliente_nombre || cid,
                    cuentas_count: 0,
                    saldo_abierto_usd: 0,
                    total_credito_usd: 0,
                    dias_mora_sum: 0,
                    cuentas_vencidas: 0
                });
            }
            const cli = cxcAbiertasPorCliente.get(cid);
            cli.cuentas_count += 1;
            cli.total_credito_usd += montoUsd;
            const saldo = (est === 'PAGADO' || est === 'COBRADA' || est === 'PAGADA') ? 0 : Math.max(0, montoUsd - pagUsd);
            cli.saldo_abierto_usd += saldo;
            if (saldo > 0.01) {
                const ag = fiscal.calcularAgingDocumento({
                    fechaEmision: fechaEm || hoyISO,
                    fechaVencimiento: r.fecha_vencimiento || null,
                    diasCredito: parseInt(r.dias_credito || 30, 10),
                    fechaCorte: fechaFin
                });
                if (ag.dias_vencido > 0) {
                    cli.dias_mora_sum += ag.dias_vencido;
                    cli.cuentas_vencidas += 1;
                }
            }
        }
    }

    // ---------------- CARGA UNICA DE VENTAS ----------------
    // Acumuladores del periodo seleccionado
    let ingresosBrutosConImpUsd = 0;
    let ingresosNetosUsd = 0;
    let cogsPeriodoUsd = 0;
    let igtfPeriodoBs = 0;
    let prevIngresosNetosUsd = 0;

    // Canales en el periodo
    const canalesMap = {
        CONTADO: { facturas: 0, ingresosUsd: 0, gananciaUsd: 0 },
        CREDITO: { facturas: 0, ingresosUsd: 0, gananciaUsd: 0 },
        CASHEA: { facturas: 0, ingresosUsd: 0, gananciaUsd: 0 }
    };

    // Serie diaria 90d
    const serie90Map = new Map();
    for (let i = 0; i < 90; i++) {
        const f = shiftDaysISO(inicio90d, i);
        serie90Map.set(f, { fecha: f, ingresosUsd: 0, gananciaUsd: 0, opexUsd: 0 });
    }

    // Inventario & ABC-XYZ & STR 30d & Elasticidad & Basket & Cajeros & TTM Cohortes
    const skuStats90d = new Map(); // ABC-XYZ + dias stock
    const skuVentas30d = new Map(); // STR 30d
    const skuRegimenesPrecio = new Map(); // Elasticidad sobre ventana amplia
    const skuMbrrPeriodo = new Map(); // MBRR / IECCM del periodo
    const cajerosPeriodo = new Map();
    const canastasPeriodo = []; // Market basket: Array de Set<productId> + mapa nombres
    const prodNombresGlobal = new Map();

    // TTM concentracion + cohortes (ultimos 12 meses)
    const ttmClientesTotal = new Map();
    let totalTtmUsd = 0;
    const clienteMesesCompra = new Map(); // clientKey -> { firstMonth, months: Set<YYYY-MM> }

    if (schema.hasTable('ventas_locales')) {
        const cols = schema.getCols('ventas_locales');
        const cf = companyPredicate('', companyId, cols);
        const extraFilters = [];
        if (cols.has('es_anulada')) extraFilters.push('COALESCE(es_anulada, 0) = 0');
        if (cols.has('estado')) extraFilters.push("UPPER(COALESCE(estado, '')) != 'ANULADA'");
        const anulaSql = extraFilters.length ? `AND ${extraFilters.join(' AND ')}` : '';

        const sel = [
            'id', 'cashier_id', 'numero_factura', 'cliente_nombre', 'cliente_rif',
            'base_imponible', 'monto_exento', 'monto_iva', 'monto_total', 'tasa_bcv',
            'metodo_pago', 'datos_json', 'fecha_emision', 'ganancia_venta'
        ];
        if (cols.has('monto_igtf')) sel.push('monto_igtf');
        if (cols.has('es_nota_credito')) sel.push('es_nota_credito');

        const ventasRows = schema.safeAll(
            `SELECT ${sel.join(', ')} FROM ventas_locales
             WHERE ${cf.sql} ${anulaSql} AND substr(fecha_emision, 1, 10) >= ? AND substr(fecha_emision, 1, 10) <= ?
             ORDER BY fecha_emision ASC`,
            [...cf.params, minLoadFecha, fechaFin]
        );

        for (const v of ventasRows) {
            const f = dateOnly(v.fecha_emision);
            if (!f) continue;
            const tasaV = toNum(v.tasa_bcv, 0) > 0 ? toNum(v.tasa_bcv) : tasaCtx.tasaParaFecha(f);
            const signo = Number(v.es_nota_credito) === 1 ? -1 : 1;

            const totalBs = toNum(v.monto_total, 0);
            const baseExBs = toNum(v.base_imponible, 0) + toNum(v.monto_exento, 0);
            const netSinImpBs = baseExBs > 0 ? baseExBs : Math.max(0, totalBs - toNum(v.monto_iva, 0) - toNum(v.monto_igtf, 0));

            const totalUsd = safeDiv(totalBs, tasaV, 0) * signo;
            const netUsd = safeDiv(netSinImpBs, tasaV, 0) * signo;

            const { items, cogsItemsSumUsd } = extraerItemsVenta(v, tasaV, prodMap);
            let cogsV = cogsItemsSumUsd;
            if (cogsV === 0 && items.length === 0 && toNum(v.ganancia_venta, 0) > 0) {
                cogsV = Math.max(0, Math.abs(netUsd) - toNum(v.ganancia_venta, 0)) * signo;
            }
            const ganV = netUsd - cogsV;

            // A. Periodo anterior inmediato
            if (f >= prevInicio && f <= prevFin) {
                prevIngresosNetosUsd += netUsd;
            }

            // B. Serie 90 dias & ABC-XYZ 90d
            if (f >= inicio90d && f <= fechaFin) {
                const sDia = serie90Map.get(f);
                if (sDia) {
                    sDia.ingresosUsd += netUsd;
                    sDia.gananciaUsd += ganV;
                }
                const weekIdx = Math.min(12, Math.max(0, Math.floor(daysBetweenISO(inicio90d, f) / 7)));
                for (const it of items) {
                    prodNombresGlobal.set(it.productId, it.nombre);
                    if (!skuStats90d.has(it.productId)) {
                        skuStats90d.set(it.productId, {
                            productId: it.productId,
                            codigo: it.codigo,
                            nombre: it.nombre,
                            categoria: it.categoria,
                            ingresosUsd: 0,
                            margenUsd: 0,
                            unidades: 0,
                            weeklyQty: new Array(13).fill(0)
                        });
                    }
                    const st = skuStats90d.get(it.productId);
                    st.ingresosUsd += it.ingresoUsd;
                    st.margenUsd += it.gananciaUsd;
                    st.unidades += it.qty;
                    st.weeklyQty[weekIdx] += it.qty;
                }
            }

            // C. Ventana 30 dias para STR y cobertura de stock
            if (f >= inicio30d && f <= fechaFin) {
                for (const it of items) {
                    skuVentas30d.set(it.productId, (skuVentas30d.get(it.productId) || 0) + it.qty);
                }
            }

            // D. Ventana TTM (365 dias) para concentracion y cohortes (excluye notas credito negativas para cohorte)
            if (f >= inicio365d && f <= fechaFin) {
                totalTtmUsd += netUsd;
                const cKey = normalizarIdentificadorCliente(v.cliente_rif, v.cliente_nombre);
                if (!ttmClientesTotal.has(cKey)) {
                    ttmClientesTotal.set(cKey, {
                        key: cKey,
                        rif: v.cliente_rif || '',
                        nombre: v.cliente_nombre || 'Consumidor Final',
                        ingresosUsd: 0,
                        facturas: 0
                    });
                }
                const tc = ttmClientesTotal.get(cKey);
                tc.ingresosUsd += netUsd;
                if (signo > 0) tc.facturas += 1;

                if (signo > 0 && cKey !== 'CONSUMIDOR_FINAL' && !cKey.startsWith('NOM:CONSUMIDOR')) {
                    const ym = f.slice(0, 7);
                    if (!clienteMesesCompra.has(cKey)) {
                        clienteMesesCompra.set(cKey, { firstMonth: ym, months: new Set([ym]) });
                    } else {
                        const cm = clienteMesesCompra.get(cKey);
                        if (ym < cm.firstMonth) cm.firstMonth = ym;
                        cm.months.add(ym);
                    }
                }
            }

            // E. Elasticidad (ventana completa cargada, ventas positivas)
            if (signo > 0) {
                for (const it of items) {
                    if (it.precioUnitUsd <= 0 || it.qtyAbs <= 0) continue;
                    prodNombresGlobal.set(it.productId, it.nombre);
                    const pBucket = Math.round(it.precioUnitUsd * 20) / 20; // Agrupa en saltos de $0.05
                    if (!skuRegimenesPrecio.has(it.productId)) skuRegimenesPrecio.set(it.productId, new Map());
                    const rMap = skuRegimenesPrecio.get(it.productId);
                    if (!rMap.has(pBucket)) {
                        rMap.set(pBucket, { precioUsd: pBucket, qtyTotal: 0, ventasCount: 0, fechas: new Set() });
                    }
                    const reg = rMap.get(pBucket);
                    reg.qtyTotal += it.qtyAbs;
                    reg.ventasCount += 1;
                    reg.fechas.add(f);
                }
            }

            // F. Periodo seleccionado exacto: Cascada, Canales, Cajeros, Market Basket, MBRR
            if (f >= fechaInicio && f <= fechaFin) {
                ingresosBrutosConImpUsd += totalUsd;
                ingresosNetosUsd += netUsd;
                cogsPeriodoUsd += cogsV;
                igtfPeriodoBs += toNum(v.monto_igtf, 0) * signo;

                const canal = resolverCanalVenta(v.metodo_pago, v.numero_factura, casheaFacturasSet, metodosMap);
                const cObj = canalesMap[canal] || canalesMap.CONTADO;
                if (signo > 0) cObj.facturas += 1;
                cObj.ingresosUsd += netUsd;
                cObj.gananciaUsd += ganV;

                // Cajero
                const cashId = String(v.cashier_id || 'SIN_CAJERO').trim() || 'SIN_CAJERO';
                if (!cajerosPeriodo.has(cashId)) {
                    cajerosPeriodo.set(cashId, {
                        cashier_id: cashId,
                        cajero_nombre: cajerosMap.get(cashId) || cashId,
                        facturas: 0,
                        ingresosUsd: 0,
                        gananciaUsd: 0
                    });
                }
                const caj = cajerosPeriodo.get(cashId);
                if (signo > 0) caj.facturas += 1;
                caj.ingresosUsd += netUsd;
                caj.gananciaUsd += ganV;

                // Canasta Market Basket (solo facturas positivas con >= 2 items distintos)
                if (signo > 0 && items.length >= 2) {
                    const skusFactura = Array.from(new Set(items.map((x) => x.productId)));
                    if (skusFactura.length >= 2 && skusFactura.length <= 35) {
                        canastasPeriodo.push(skusFactura);
                    }
                }

                // MBRR / Reposicion por item vendido en el periodo
                for (const it of items) {
                    if (it.qty <= 0 || it.ingresoUsd <= 0) continue;
                    const cat = prodMap.byId.get(it.productId);
                    const compDirect = ultCostoPorSku.get(it.productId);
                    let costoRepUnitUsd = 0;
                    let fuente = 'COSTO_VENTA';

                    if (compDirect && compDirect.costoUsd > 0) {
                        costoRepUnitUsd = compDirect.costoUsd;
                        fuente = compDirect.fuente;
                    } else if (cat && cat.costoUsd > 0) {
                        // Si el catalogo tiene costo vigente distinto al de venta, o ajuste BCV relativo si tasa subio
                        const ratioBcv = tasaV > 0 && tasaActiva > tasaV ? (tasaActiva / tasaV) : 1;
                        costoRepUnitUsd = Math.max(cat.costoUsd, it.costoUnitUsd * ratioBcv);
                        fuente = ratioBcv > 1.005 ? 'CATALOGO_AJUSTE_BCV' : 'CATALOGO_VIGENTE';
                    } else {
                        costoRepUnitUsd = it.costoUnitUsd * (tasaV > 0 ? Math.max(1, tasaActiva / tasaV) : 1);
                        fuente = 'PROXIED_BCV';
                    }

                    if (!skuMbrrPeriodo.has(it.productId)) {
                        skuMbrrPeriodo.set(it.productId, {
                            productId: it.productId,
                            nombre: it.nombre,
                            qty: 0,
                            ingresoUsd: 0,
                            cogsHistUsd: 0,
                            costoReposicionUsd: 0,
                            fuente
                        });
                    }
                    const mr = skuMbrrPeriodo.get(it.productId);
                    mr.qty += it.qty;
                    mr.ingresoUsd += it.ingresoUsd;
                    mr.cogsHistUsd += it.cogsUsd;
                    mr.costoReposicionUsd += costoRepUnitUsd * it.qty;
                    if (fuente === 'FACTURA_COMPRA') mr.fuente = fuente;
                }
            }
        }
    }

    // ---------------- 1. OPEX, CASCADA Y TIJERA ----------------
    const opexActual = calcularOpexPeriodo(schema, { companyId, fechaInicio, fechaFin, tasaCtx });
    const opexPrevio = calcularOpexPeriodo(schema, { companyId, fechaInicio: prevInicio, fechaFin: prevFin, tasaCtx });
    const opex90 = calcularOpexPeriodo(schema, { companyId, fechaInicio: inicio90d, fechaFin, tasaCtx });

    for (const [f, val] of opex90.eventosDiarios.entries()) {
        const sDia = serie90Map.get(f);
        if (sDia) sDia.opexUsd += val;
    }

    const serie90Sorted = Array.from(serie90Map.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));
    const tendencia90d = serie90Sorted.map((row, idx) => {
        const slice7 = serie90Sorted.slice(Math.max(0, idx - 6), idx + 1);
        const slice30 = serie90Sorted.slice(Math.max(0, idx - 29), idx + 1);
        const ma7Ing = slice7.reduce((s, x) => s + x.ingresosUsd, 0) / slice7.length;
        const ma30Ing = slice30.reduce((s, x) => s + x.ingresosUsd, 0) / slice30.length;
        const ma30Gan = slice30.reduce((s, x) => s + x.gananciaUsd, 0) / slice30.length;
        return {
            fecha: row.fecha,
            ingresos_usd: round2(row.ingresosUsd),
            ganancia_usd: round2(row.gananciaUsd),
            opex_usd: round2(row.opexUsd),
            ma7_ingresos_usd: round2(ma7Ing),
            ma30_ingresos_usd: round2(ma30Ing),
            ma30_ganancia_usd: round2(ma30Gan)
        };
    });

    const utilidadBrutaUsd = ingresosNetosUsd - cogsPeriodoUsd;
    const margenBrutoPct = round2(safeDiv(utilidadBrutaUsd, ingresosNetosUsd, 0) * 100);
    const ebitUsd = utilidadBrutaUsd - opexActual.totalUsd;
    const margenOperativoPct = round2(safeDiv(ebitUsd, ingresosNetosUsd, 0) * 100);
    const igtfUsd = safeDiv(igtfPeriodoBs, tasaActiva, 0);
    const utilidadNetaEstimadaUsd = ebitUsd - casheaComisionUsd;
    const margenNetoPct = round2(safeDiv(utilidadNetaEstimadaUsd, ingresosNetosUsd, 0) * 100);

    const ingresosDeltaPct = prevIngresosNetosUsd > 0.01
        ? round2(((ingresosNetosUsd - prevIngresosNetosUsd) / prevIngresosNetosUsd) * 100)
        : null;
    const opexDeltaPct = opexPrevio.totalUsd > 0.01
        ? round2(((opexActual.totalUsd - opexPrevio.totalUsd) / opexPrevio.totalUsd) * 100)
        : null;
    const tijeraAlerta = (ingresosDeltaPct !== null && opexDeltaPct !== null && opexDeltaPct > ingresosDeltaPct && opexActual.totalUsd > 0);

    // ---------------- 2. INVENTARIO: GMROI, STR 30D, DIAS STOCK, MERMAS, ABC-XYZ ----------------
    const inventarioCostoActualUsd = prodMap.lista.reduce((s, p) => s + (Math.max(0, p.stockActual) * Math.max(0, p.costoUsd)), 0);
    const factorAnual = 365 / diasPeriodo;
    const margenBrutoAnualizadoUsd = utilidadBrutaUsd * factorAnual;
    const gmroi = inventarioCostoActualUsd > 0.01 ? round2(margenBrutoAnualizadoUsd / inventarioCostoActualUsd) : null;
    let gmroiEstado = 'SIN_INVENTARIO';
    if (gmroi !== null) {
        if (gmroi >= 2.0) gmroiEstado = 'VERDE';
        else if (gmroi >= 1.0) gmroiEstado = 'AMARILLO';
        else gmroiEstado = 'ROJO';
    }

    let totalUnidadesVendidas30d = 0;
    let totalStockActualUnidades = 0;
    const riesgoQuiebre = [];
    const huesoInmovilizado = [];

    for (const p of prodMap.lista) {
        const u30 = Math.max(0, skuVentas30d.get(p.id) || 0);
        const st = Math.max(0, p.stockActual);
        totalUnidadesVendidas30d += u30;
        totalStockActualUnidades += st;

        const strSkuPct = (u30 + st) > 0 ? round2((u30 / (u30 + st)) * 100) : 0;
        const velDiaria = u30 / 30;
        const diasRestantes = velDiaria > 0 ? round2(st / velDiaria) : null;

        if (u30 > 0 && diasRestantes !== null && diasRestantes < 15) {
            riesgoQuiebre.push({
                product_id: p.id,
                nombre: p.nombre,
                stock_actual: round2(st),
                venta_30d: round2(u30),
                dias_stock: diasRestantes,
                str_30d_pct: strSkuPct
            });
        }
        if (st > 0 && strSkuPct < 15) {
            const capitalInmov = st * p.costoUsd;
            huesoInmovilizado.push({
                product_id: p.id,
                nombre: p.nombre,
                stock_actual: round2(st),
                venta_30d: round2(u30),
                str_30d_pct: strSkuPct,
                capital_inmovilizado_usd: round2(capitalInmov)
            });
        }
    }

    riesgoQuiebre.sort((a, b) => a.dias_stock - b.dias_stock || b.venta_30d - a.venta_30d);
    huesoInmovilizado.sort((a, b) => b.capital_inmovilizado_usd - a.capital_inmovilizado_usd || b.stock_actual - a.stock_actual);

    const str30dGlobalPct = (totalUnidadesVendidas30d + totalStockActualUnidades) > 0
        ? round2((totalUnidadesVendidas30d / (totalUnidadesVendidas30d + totalStockActualUnidades)) * 100)
        : 0;
    const diasStockGlobal = totalUnidadesVendidas30d > 0
        ? round2(totalStockActualUnidades / (totalUnidadesVendidas30d / 30))
        : null;

    // Mermas desde salidas_inventario
    let mermasTotalUsd = 0;
    let mermasTotalUnidades = 0;
    const mermasPorMotivoMap = new Map();
    const mermasPorProdMap = new Map();

    if (schema.hasTable('salidas_inventario')) {
        const cols = schema.getCols('salidas_inventario');
        const cf = companyPredicate('', companyId, cols);
        const fCol = cols.has('fecha_modificacion') ? 'fecha_modificacion' : null;
        const dateFilter = fCol ? `AND substr(${fCol}, 1, 10) >= ? AND substr(${fCol}, 1, 10) <= ?` : '';
        const params = fCol ? [...cf.params, fechaInicio, fechaFin] : cf.params;
        const rows = schema.safeAll(
            `SELECT product_id, cantidad, motivo, observacion ${fCol ? `, ${fCol} AS fecha` : ''}
             FROM salidas_inventario WHERE ${cf.sql} ${dateFilter}`,
            params
        );
        for (const s of rows) {
            const mot = String(s.motivo || 'Sin Motivo').trim() || 'Sin Motivo';
            const motLower = mot.toLowerCase();
            // Venta y Devolucion a proveedor no son merma destructiva de inventario
            if (motLower === 'venta' || motLower.includes('devoluci')) continue;
            const qty = Math.max(0, toNum(s.cantidad, 0));
            if (qty <= 0) continue;
            const p = prodMap.byId.get(String(s.product_id || ''));
            const costoU = p ? p.costoUsd : 0;
            const valUsd = qty * costoU;

            mermasTotalUnidades += qty;
            mermasTotalUsd += valUsd;
            if (!mermasPorMotivoMap.has(mot)) mermasPorMotivoMap.set(mot, { motivo: mot, eventos: 0, unidades: 0, usd: 0 });
            const mm = mermasPorMotivoMap.get(mot);
            mm.eventos += 1;
            mm.unidades += qty;
            mm.usd += valUsd;

            const pKey = String(s.product_id || mot);
            if (!mermasPorProdMap.has(pKey)) {
                mermasPorProdMap.set(pKey, { product_id: pKey, nombre: p ? p.nombre : pKey, motivo: mot, unidades: 0, usd: 0 });
            }
            const mp = mermasPorProdMap.get(pKey);
            mp.unidades += qty;
            mp.usd += valUsd;
        }
    }

    const mermasPorMotivo = Array.from(mermasPorMotivoMap.values())
        .map((x) => ({ ...x, unidades: round2(x.unidades), usd: round2(x.usd) }))
        .sort((a, b) => b.usd - a.usd || b.unidades - a.unidades);
    const mermasTopProductos = Array.from(mermasPorProdMap.values())
        .map((x) => ({ ...x, unidades: round2(x.unidades), usd: round2(x.usd) }))
        .sort((a, b) => b.usd - a.usd || b.unidades - a.unidades)
        .slice(0, 30);

    // Matriz ABC-XYZ (90d ingresos + CV semanal)
    const abcListaRaw = Array.from(skuStats90d.values()).filter((x) => x.ingresosUsd > 0);
    abcListaRaw.sort((a, b) => b.ingresosUsd - a.ingresosUsd);
    const totalIng90d = abcListaRaw.reduce((s, x) => s + x.ingresosUsd, 0);

    const resumenMatriz = {};
    ['A', 'B', 'C'].forEach((a) => ['X', 'Y', 'Z'].forEach((z) => {
        resumenMatriz[`${a}${z}`] = { skus: 0, valor_inventario_usd: 0, ingresos_usd: 0 };
    }));

    let acumIng = 0;
    const skusAbcXyz = [];
    for (const item of abcListaRaw) {
        const sharePrev = totalIng90d > 0 ? (acumIng / totalIng90d) : 0;
        acumIng += item.ingresosUsd;
        let abc = 'C';
        if (sharePrev < 0.80) abc = 'A';
        else if (sharePrev < 0.95) abc = 'B';

        // Calcular CV sobre las semanas con actividad desde la primera aparicion o todas las 13 semanas
        const nWeeks = item.weeklyQty.length;
        const mean = item.weeklyQty.reduce((s, q) => s + q, 0) / nWeeks;
        const variance = item.weeklyQty.reduce((s, q) => s + Math.pow(q - mean, 2), 0) / nWeeks;
        const stdDev = Math.sqrt(variance);
        const cv = mean > 0 ? (stdDev / mean) : 9.99;

        let xyz = 'Z';
        if (cv <= 0.5) xyz = 'X';
        else if (cv <= 1.0) xyz = 'Y';

        const clase = `${abc}${xyz}`;
        const catP = prodMap.byId.get(item.productId);
        const stockActual = catP ? catP.stockActual : 0;
        const capUsd = stockActual * (catP ? catP.costoUsd : 0);
        const u30 = skuVentas30d.get(item.productId) || 0;
        const str30 = (u30 + stockActual) > 0 ? round2((u30 / (u30 + stockActual)) * 100) : 0;
        const dStock = u30 > 0 ? round2(stockActual / (u30 / 30)) : null;

        resumenMatriz[clase].skus += 1;
        resumenMatriz[clase].valor_inventario_usd += capUsd;
        resumenMatriz[clase].ingresos_usd += item.ingresosUsd;

        skusAbcXyz.push({
            producto_id: item.productId,
            codigo: item.codigo,
            nombre: item.nombre,
            abc,
            xyz,
            clase,
            ingresos_usd: round2(item.ingresosUsd),
            margen_usd: round2(item.margenUsd),
            stock_actual: round2(stockActual),
            capital_usd: round2(capUsd),
            cv: round2(cv),
            str_30d_pct: str30,
            dias_stock: dStock
        });
    }
    for (const k of Object.keys(resumenMatriz)) {
        resumenMatriz[k].valor_inventario_usd = round2(resumenMatriz[k].valor_inventario_usd);
        resumenMatriz[k].ingresos_usd = round2(resumenMatriz[k].ingresos_usd);
    }

    // ---------------- 3. PROTECCION CAMBIARIA (MBRR / IECCM), CASHEA Y EMBUDO ----------------
    let mbrrIngresosEvalUsd = 0;
    let mbrrCogsHistUsd = 0;
    let mbrrCostoReposUsd = 0;
    const topErosionados = [];

    for (const mr of skuMbrrPeriodo.values()) {
        mbrrIngresosEvalUsd += mr.ingresoUsd;
        mbrrCogsHistUsd += mr.cogsHistUsd;
        mbrrCostoReposUsd += mr.costoReposicionUsd;

        const mNom = safeDiv(mr.ingresoUsd - mr.cogsHistUsd, mr.ingresoUsd, 0) * 100;
        const mReal = safeDiv(mr.ingresoUsd - mr.costoReposicionUsd, mr.ingresoUsd, 0) * 100;
        const erosionUsd = mr.costoReposicionUsd - mr.cogsHistUsd;
        topErosionados.push({
            producto_id: mr.productId,
            nombre: mr.nombre,
            ingresos_usd: round2(mr.ingresoUsd),
            margen_nominal_pct: round2(mNom),
            mbrr_pct: round2(mReal),
            erosion_pp: round2(mNom - mReal),
            deficit_reposicion_usd: round2(erosionUsd),
            fuente: mr.fuente
        });
    }
    topErosionados.sort((a, b) => b.deficit_reposicion_usd - a.deficit_reposicion_usd || a.mbrr_pct - b.mbrr_pct);

    const mbrrMargenNominalPct = round2(safeDiv(mbrrIngresosEvalUsd - mbrrCogsHistUsd, mbrrIngresosEvalUsd, 0) * 100);
    const mbrrRealPct = round2(safeDiv(mbrrIngresosEvalUsd - mbrrCostoReposUsd, mbrrIngresosEvalUsd, 0) * 100);
    const ieccmErosionPp = round2(mbrrMargenNominalPct - mbrrRealPct);
    const deficitReposicionUsd = round2(mbrrCostoReposUsd - mbrrCogsHistUsd);

    // Cashea Net Yield
    const casheaTotalFacturadoBrutoUsd = casheaSaldoFinanciadoUsd + casheaInicialCxcUsd;
    const casheaBrutoFinal = casheaTotalFacturadoBrutoUsd > 0 ? casheaTotalFacturadoBrutoUsd : canalesMap.CASHEA.ingresosUsd;
    const casheaGananciaBruta = canalesMap.CASHEA.gananciaUsd > 0
        ? canalesMap.CASHEA.gananciaUsd
        : (casheaBrutoFinal * (margenBrutoPct / 100));
    const casheaYieldNetoPct = casheaBrutoFinal > 0
        ? round2(safeDiv(casheaGananciaBruta - casheaComisionUsd, casheaBrutoFinal, 0) * 100)
        : null;
    const margenContadoPct = canalesMap.CONTADO.ingresosUsd > 0
        ? round2(safeDiv(canalesMap.CONTADO.gananciaUsd, canalesMap.CONTADO.ingresosUsd, 0) * 100)
        : margenBrutoPct;

    // Embudo de Presupuestos
    let presEmitidosCount = 0;
    let presConvertidosCount = 0;
    let presMontoEmitidoUsd = 0;
    let presMontoConvertidoUsd = 0;

    if (schema.hasTable('presupuestos_locales')) {
        const cols = schema.getCols('presupuestos_locales');
        const cf = companyPredicate('', companyId, cols);
        const rows = schema.safeAll(
            `SELECT monto_total, subtotal, tasa_bcv, moneda, estado, fecha_emision
             FROM presupuestos_locales
             WHERE ${cf.sql} AND substr(fecha_emision, 1, 10) >= ? AND substr(fecha_emision, 1, 10) <= ?`,
            [...cf.params, fechaInicio, fechaFin]
        );
        for (const p of rows) {
            const est = String(p.estado || 'EMITIDO').toUpperCase();
            if (est === 'ANULADO') continue;
            const mon = String(p.moneda || 'USD').toUpperCase();
            const mRaw = toNum(p.monto_total, 0) || toNum(p.subtotal, 0);
            const tP = toNum(p.tasa_bcv, 0) > 0 ? toNum(p.tasa_bcv) : tasaCtx.tasaParaFecha(p.fecha_emision);
            const mUsd = (mon === 'BS' || mon === 'VES') ? safeDiv(mRaw, tP, 0) : mRaw;
            presEmitidosCount += 1;
            presMontoEmitidoUsd += mUsd;
            if (est.includes('CONVERTID') || est === 'FACTURADO') {
                presConvertidosCount += 1;
                presMontoConvertidoUsd += mUsd;
            }
        }
    }

    const canalesVenta = Object.entries(canalesMap).map(([canal, d]) => ({
        canal,
        facturas: d.facturas,
        ingresos_usd: round2(d.ingresosUsd),
        participacion_pct: round2(safeDiv(d.ingresosUsd, ingresosNetosUsd, 0) * 100),
        ticket_promedio_usd: round2(safeDiv(d.ingresosUsd, d.facturas, 0)),
        margen_pct: round2(safeDiv(d.gananciaUsd, d.ingresosUsd, 0) * 100)
    }));

    // ---------------- 4. MARKET BASKET (2-WAY & 3-WAY) ----------------
    const freqItem = new Map();
    const freqPair = new Map();
    const freqTrio = new Map();
    const nCanastas = canastasPeriodo.length;

    for (const skus of canastasPeriodo) {
        const sorted = [...skus].sort();
        for (const s of sorted) freqItem.set(s, (freqItem.get(s) || 0) + 1);

        for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
                const pKey = `${sorted[i]}||${sorted[j]}`;
                freqPair.set(pKey, (freqPair.get(pKey) || 0) + 1);
                if (sorted.length <= 20) {
                    for (let k = j + 1; k < sorted.length; k++) {
                        const tKey = `${sorted[i]}||${sorted[j]}||${sorted[k]}`;
                        freqTrio.set(tKey, (freqTrio.get(tKey) || 0) + 1);
                    }
                }
            }
        }
    }

    const minSupport = nCanastas >= 15 ? 2 : 1;
    const paresBasket = [];
    for (const [key, count] of freqPair.entries()) {
        if (count < minSupport || nCanastas === 0) continue;
        const [a, b] = key.split('||');
        const pA = (freqItem.get(a) || 0) / nCanastas;
        const pB = (freqItem.get(b) || 0) / nCanastas;
        const pAB = count / nCanastas;
        const lift = pA * pB > 0 ? pAB / (pA * pB) : 0;
        const confAB = pA > 0 ? (pAB / pA) * 100 : 0;
        if (lift >= 1.01 || count >= 2) {
            paresBasket.push({
                items: [a, b],
                nombres: [prodNombresGlobal.get(a) || a, prodNombresGlobal.get(b) || b],
                soporte_count: count,
                soporte_pct: round2(pAB * 100),
                confianza_pct: round2(confAB),
                lift: round2(lift)
            });
        }
    }
    paresBasket.sort((a, b) => b.lift - a.lift || b.soporte_count - a.soporte_count);

    const triosBasket = [];
    for (const [key, count] of freqTrio.entries()) {
        if (count < 2 || nCanastas === 0) continue;
        const [a, b, c] = key.split('||');
        const pA = (freqItem.get(a) || 0) / nCanastas;
        const pB = (freqItem.get(b) || 0) / nCanastas;
        const pC = (freqItem.get(c) || 0) / nCanastas;
        const pABC = count / nCanastas;
        const lift = pA * pB * pC > 0 ? pABC / (pA * pB * pC) : 0;
        const conf = pA > 0 ? (pABC / pA) * 100 : 0;
        if (lift >= 1.05) {
            triosBasket.push({
                items: [a, b, c],
                nombres: [prodNombresGlobal.get(a) || a, prodNombresGlobal.get(b) || b, prodNombresGlobal.get(c) || c],
                soporte_count: count,
                soporte_pct: round2(pABC * 100),
                confianza_pct: round2(conf),
                lift: round2(lift)
            });
        }
    }
    triosBasket.sort((a, b) => b.lift - a.lift || b.soporte_count - a.soporte_count);

    // ---------------- 5. CONCENTRACION TTM Y COHORTES ----------------
    const clientesTtmList = Array.from(ttmClientesTotal.values())
        .filter((c) => c.ingresosUsd > 0 && !c.key.startsWith('NOM:CONSUMIDOR') && c.key !== 'CONSUMIDOR_FINAL')
        .sort((a, b) => b.ingresosUsd - a.ingresosUsd);

    const topClientesTtm = clientesTtmList.slice(0, 15).map((c) => ({
        rif: c.rif || c.key,
        nombre: c.nombre,
        facturas: c.facturas,
        ingresos_usd: round2(c.ingresosUsd),
        participacion_pct: round2(safeDiv(c.ingresosUsd, totalTtmUsd, 0) * 100)
    }));

    const top1Pct = topClientesTtm.length > 0 ? topClientesTtm[0].participacion_pct : 0;
    const top3Pct = round2(topClientesTtm.slice(0, 3).reduce((s, c) => s + c.participacion_pct, 0));

    // Cohortes mensuales ultimos 6 meses
    const addMonths = (ym, delta) => {
        const [y, m] = ym.split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 1 + delta, 1));
        return d.toISOString().slice(0, 7);
    };
    const cohorteGroups = new Map();
    for (const cm of clienteMesesCompra.values()) {
        if (!cohorteGroups.has(cm.firstMonth)) cohorteGroups.set(cm.firstMonth, []);
        cohorteGroups.get(cm.firstMonth).push(cm.months);
    }
    const maxYmFin = fechaFin.slice(0, 7);
    const cohortesMensuales = Array.from(cohorteGroups.keys())
        .sort()
        .slice(-6)
        .map((ym0) => {
            const listaMeses = cohorteGroups.get(ym0);
            const totalIni = listaMeses.length;
            const retenidos = [0, 1, 2, 3].map((offset) => {
                const targetYm = addMonths(ym0, offset);
                if (targetYm > maxYmFin) return null;
                const hits = listaMeses.filter((mSet) => mSet.has(targetYm)).length;
                return round2((hits / totalIni) * 100);
            });
            return { cohorte: ym0, clientes_iniciales: totalIni, retenidos };
        });

    // ---------------- 6. SCORE TEHC (EXPOSICION CAMBIARIA POR CLIENTE) ----------------
    const abonosTehePorCliente = new Map();
    if (schema.hasTable('abonos_cuentas_cobrar')) {
        const cols = schema.getCols('abonos_cuentas_cobrar');
        const cf = companyPredicate('', companyId, cols);
        const rows = schema.safeAll(`SELECT * FROM abonos_cuentas_cobrar WHERE ${cf.sql}`, cf.params);

        // Detectar dias con salto BCV > 0.3% respecto al dia anterior en historial
        const diasSaltoBcv = new Set();
        for (let i = 1; i < tasaCtx.serieAsc.length; i++) {
            const prev = tasaCtx.serieAsc[i - 1].valor;
            const curr = tasaCtx.serieAsc[i].valor;
            if (prev > 0 && ((curr - prev) / prev) >= 0.003) {
                diasSaltoBcv.add(tasaCtx.serieAsc[i].fecha);
            }
        }

        for (const ab of rows) {
            const cKey = normalizarIdentificadorCliente(ab.cliente_id, ab.cliente_nombre);
            const fAb = dateOnly(ab.fecha);
            const tasaAb = toNum(ab.tasa_bcv, 0) > 0 ? toNum(ab.tasa_bcv) : tasaCtx.tasaParaFecha(fAb);
            const usd = toNum(ab.monto_usd, 0) > 0 ? toNum(ab.monto_usd) : safeDiv(toNum(ab.monto_bs, 0), tasaAb, 0);
            const met = String(ab.metodo_pago || '').toUpperCase();
            const esEnBs = toNum(ab.monto_bs, 0) > 0 && !met.includes('USD') && !met.includes('ZELLE') && !met.includes('DIVISA');
            const postSalto = diasSaltoBcv.has(fAb) || diasSaltoBcv.has(shiftDaysISO(fAb, -1));

            if (!abonosTehePorCliente.has(cKey)) {
                abonosTehePorCliente.set(cKey, { totalUsd: 0, enBsUsd: 0, postDevalUsd: 0, difBs: 0 });
            }
            const tObj = abonosTehePorCliente.get(cKey);
            tObj.totalUsd += usd;
            if (esEnBs) tObj.enBsUsd += usd;
            if (postSalto) tObj.postDevalUsd += usd;
            tObj.difBs += Math.max(0, toNum(ab.diferencial_cambiario_bs, 0));
        }
    }

    const scoreTehc = [];
    for (const [cKey, cli] of cxcAbiertasPorCliente.entries()) {
        const ab = abonosTehePorCliente.get(cKey) || { totalUsd: 0, enBsUsd: 0, postDevalUsd: 0, difBs: 0 };
        const pctBs = ab.totalUsd > 0 ? (ab.enBsUsd / ab.totalUsd) * 100 : (cli.saldo_abierto_usd > 0 ? 50 : 0);
        const pctPostDeval = ab.totalUsd > 0 ? (ab.postDevalUsd / ab.totalUsd) * 100 : 0;
        const moraProm = cli.cuentas_vencidas > 0 ? (cli.dias_mora_sum / cli.cuentas_vencidas) : 0;
        const saldoExp = cli.total_credito_usd > 0 ? Math.min(100, (cli.saldo_abierto_usd / cli.total_credito_usd) * 100) : 0;

        // Indice 0..100 ponderando pago post-devaluacion (35%), pago en Bs (25%), mora (25%) y saldo abierto (15%)
        const score = Math.min(100, Math.max(0,
            (pctPostDeval * 0.35) + (pctBs * 0.25) + (Math.min(100, moraProm * 2) * 0.25) + (saldoExp * 0.15)
        ));
        let nivelRiesgo = 'BAJO';
        if (score >= 60) nivelRiesgo = 'ALTO';
        else if (score >= 30) nivelRiesgo = 'MEDIO';

        if (cli.total_credito_usd > 0 || ab.totalUsd > 0) {
            scoreTehc.push({
                cliente_rif: cli.cliente_rif || cKey,
                cliente_nombre: cli.cliente_nombre,
                cuentas_count: cli.cuentas_count,
                saldo_abierto_usd: round2(cli.saldo_abierto_usd),
                total_abonado_usd: round2(ab.totalUsd),
                pagos_post_devaluacion_pct: round2(pctPostDeval),
                dias_mora_prom: round2(moraProm),
                score_tehc: round2(score),
                nivel_riesgo: nivelRiesgo
            });
        }
    }
    scoreTehc.sort((a, b) => b.score_tehc - a.score_tehc || b.saldo_abierto_usd - a.saldo_abierto_usd);

    // ---------------- 7. ELASTICIDAD PRECIO-DEMANDA (Ed) ----------------
    const elasticidadPrecio = [];
    for (const [pid, regMap] of skuRegimenesPrecio.entries()) {
        const regimenesValidos = Array.from(regMap.values())
            .filter((r) => r.ventasCount >= 2 || r.qtyTotal >= 2)
            .sort((a, b) => a.precioUsd - b.precioUsd);
        if (regimenesValidos.length < 2) continue;

        const rBajo = regimenesValidos[0];
        const rAlto = regimenesValidos[regimenesValidos.length - 1];
        const deltaPPct = safeDiv(rAlto.precioUsd - rBajo.precioUsd, rBajo.precioUsd, 0) * 100;
        if (deltaPPct < 3) continue; // Variacion muy pequena suele ser ruido de redondeo

        const qDiariaBajo = rBajo.qtyTotal / Math.max(1, rBajo.fechas.size);
        const qDiariaAlto = rAlto.qtyTotal / Math.max(1, rAlto.fechas.size);
        const deltaQPct = safeDiv(qDiariaAlto - qDiariaBajo, qDiariaBajo, 0) * 100;
        const edRaw = safeDiv(deltaQPct, deltaPPct, 0);
        const ed = Math.max(-15, Math.min(15, edRaw));

        let clasificacion = 'UNITARIO';
        let recomendacion = 'Equilibrio precio-volumen';
        if (Math.abs(ed) < 0.85) {
            clasificacion = 'INELASTICO';
            recomendacion = ed <= 0 ? 'Baja sensibilidad: admite ajuste gradual de margen' : 'Alta fidelidad / demanda rigida';
        } else if (Math.abs(ed) > 1.15) {
            clasificacion = 'ELASTICO';
            recomendacion = ed < 0 ? 'Muy sensible al precio: priorizar combos o promociones de volumen' : 'Demanda expansiva: monitorear inventario';
        }

        elasticidadPrecio.push({
            producto_id: pid,
            nombre: prodNombresGlobal.get(pid) || pid,
            observaciones: regimenesValidos.reduce((s, r) => s + r.ventasCount, 0),
            precio_min_usd: round2(rBajo.precioUsd),
            precio_max_usd: round2(rAlto.precioUsd),
            delta_precio_pct: round2(deltaPPct),
            delta_demanda_pct: round2(deltaQPct),
            ed: round2(ed),
            clasificacion,
            recomendacion
        });
    }
    elasticidadPrecio.sort((a, b) => Math.abs(b.observaciones) - Math.abs(a.observaciones) || Math.abs(b.delta_precio_pct) - Math.abs(a.delta_precio_pct));

    // ---------------- 8. RENTABILIDAD POR CAJERO ----------------
    const rendimientoCajeros = Array.from(cajerosPeriodo.values())
        .map((c) => ({
            cashier_id: c.cashier_id,
            cajero_nombre: c.cajero_nombre,
            facturas: c.facturas,
            ingresos_usd: round2(c.ingresosUsd),
            ganancia_usd: round2(c.gananciaUsd),
            margen_pct: round2(safeDiv(c.gananciaUsd, c.ingresosUsd, 0) * 100),
            ticket_promedio_usd: round2(safeDiv(c.ingresosUsd, c.facturas, 0))
        }))
        .sort((a, b) => b.ganancia_usd - a.ganancia_usd || b.ingresos_usd - a.ingresos_usd);

    return {
        periodo: {
            fecha_inicio: fechaInicio,
            fecha_fin: fechaFin,
            dias: diasPeriodo
        },
        tasa_bcv_activa: tasaActiva,
        cascada_y_tijera: {
            ingresos_brutos_usd: round2(ingresosBrutosConImpUsd),
            ingresos_netos_sin_impuesto_usd: round2(ingresosNetosUsd),
            cogs_usd: round2(cogsPeriodoUsd),
            utilidad_bruta_usd: round2(utilidadBrutaUsd),
            margen_bruto_pct: margenBrutoPct,
            opex_total_usd: round2(opexActual.totalUsd),
            opex_desglose: opexActual.porFuente,
            opex_categorias: opexActual.porCategoria,
            ebit_usd: round2(ebitUsd),
            margen_operativo_pct: margenOperativoPct,
            comisiones_cashea_usd: round2(casheaComisionUsd),
            igtf_bs: round2(igtfPeriodoBs),
            igtf_usd: round2(igtfUsd),
            utilidad_neta_estimada_usd: round2(utilidadNetaEstimadaUsd),
            margen_neto_pct: margenNetoPct,
            comparativo_anterior: {
                prev_inicio: prevInicio,
                prev_fin: prevFin,
                prev_ingresos_usd: round2(prevIngresosNetosUsd),
                prev_opex_usd: round2(opexPrevio.totalUsd),
                ingresos_delta_pct: ingresosDeltaPct,
                opex_delta_pct: opexDeltaPct,
                tijera_alerta: tijeraAlerta,
                tijera_mensaje: tijeraAlerta
                    ? `Alerta Tijera: Los gastos operativos (+${opexDeltaPct}%) crecieron mas rapido que los ingresos (${ingresosDeltaPct >= 0 ? '+' : ''}${ingresosDeltaPct}%).`
                    : 'Sin efecto tijera desfavorable en el periodo.'
            }
        },
        tendencia_90d: tendencia90d,
        inventario_inteligencia: {
            inventario_costo_actual_usd: round2(inventarioCostoActualUsd),
            margen_bruto_anualizado_usd: round2(margenBrutoAnualizadoUsd),
            gmroi,
            gmroi_estado: gmroiEstado,
            str_30d_pct: str30dGlobalPct,
            dias_stock_global: diasStockGlobal,
            mermas: {
                total_usd: round2(mermasTotalUsd),
                total_unidades: round2(mermasTotalUnidades),
                pct_sobre_cogs: round2(safeDiv(mermasTotalUsd, cogsPeriodoUsd, 0) * 100),
                por_motivo: mermasPorMotivo,
                top_productos: mermasTopProductos
            },
            riesgo_quiebre: riesgoQuiebre.slice(0, 40),
            hueso_inmovilizado: huesoInmovilizado.slice(0, 40),
            abc_xyz: {
                resumen_matriz: resumenMatriz,
                skus: skusAbcXyz.slice(0, 200)
            }
        },
        proteccion_cambiaria_y_canales: {
            mbrr: {
                margen_nominal_pct: mbrrMargenNominalPct,
                mbrr_pct: mbrrRealPct,
                ieccm_erosion_pp: ieccmErosionPp,
                deficit_reposicion_usd: deficitReposicionUsd,
                fuente_reposicion: skusConFacturaCompra > 0 ? 'FACTURAS_COMPRA_Y_CATALOGO' : 'CATALOGO_Y_VARIACION_BCV',
                skus_con_compra_real: skusConFacturaCompra,
                total_skus_evaluados: skuMbrrPeriodo.size,
                top_erosionados: topErosionados.slice(0, 50)
            },
            cashea_net_yield: {
                operaciones_count: casheaOperacionesCount || canalesMap.CASHEA.facturas,
                bruto_facturado_usd: round2(casheaBrutoFinal),
                inicial_usd: round2(casheaInicialCxcUsd),
                comision_usd: round2(casheaComisionUsd),
                saldo_financiado_usd: round2(casheaSaldoFinanciadoUsd),
                cobrado_liquidado_usd: round2(casheaCobradoLiquidadoUsd),
                yield_neto_pct: casheaYieldNetoPct,
                margen_contado_pct: margenContadoPct,
                diferencial_yield_pp: casheaYieldNetoPct !== null ? round2(casheaYieldNetoPct - margenContadoPct) : null
            },
            embudo_presupuestos: {
                emitidos_count: presEmitidosCount,
                convertidos_count: presConvertidosCount,
                tasa_conversion_pct: presEmitidosCount > 0 ? round2((presConvertidosCount / presEmitidosCount) * 100) : 0,
                monto_emitido_usd: round2(presMontoEmitidoUsd),
                monto_convertido_usd: round2(presMontoConvertidoUsd),
                valor_perdido_usd: round2(Math.max(0, presMontoEmitidoUsd - presMontoConvertidoUsd))
            },
            canales_venta: canalesVenta
        },
        comercial_clientes_cajeros: {
            market_basket: {
                total_canastas_analizadas: nCanastas,
                pares: paresBasket.slice(0, 30),
                trios: triosBasket.slice(0, 20)
            },
            concentracion_ttm: {
                total_ttm_usd: round2(totalTtmUsd),
                top_clientes: topClientesTtm,
                top1_pct: top1Pct,
                top3_pct: top3Pct,
                alerta_concentracion: top1Pct >= 25
            },
            cohortes_mensuales: cohortesMensuales,
            score_tehc: scoreTehc.slice(0, 50),
            elasticidad_precio: elasticidadPrecio.slice(0, 40),
            rendimiento_cajeros: rendimientoCajeros
        }
    };
}

module.exports = {
    obtenerEstadisticasGeneralesBiDb,
    obtenerEstadisticasEspecificasBiDb
};
