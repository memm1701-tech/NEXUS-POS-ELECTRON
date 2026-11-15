/**
 * Capa Transaccional Compartida (Local + Maestro LAN) para CxC, CxP, Retenciones,
 * Diferencial Cambiario, Anticipos/Saldos a Favor y Tesorería Bimonetaria — NEXUS POS
 */

const crypto = require('crypto');
const fiscal = require('./contabilidad-fiscal-ve');

function genId(pref = 'ID') {
    if (typeof crypto.randomUUID === 'function') {
        return `${pref}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
    }
    return `${pref}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function resolverTasaActivaDb(conn) {
    if (!conn) return 1;
    try {
        const h = conn.prepare(`SELECT valor FROM historial_tasas ORDER BY date(fecha) DESC LIMIT 1`).get();
        if (h && Number(h.valor) > 0) return Number(h.valor);
    } catch (_) {}
    try {
        const c = conn.prepare(`SELECT valor FROM configuracion WHERE clave IN ('tasa_bcv', 'dolar_bcv') LIMIT 1`).get();
        if (c && Number(c.valor) > 0) return Number(c.valor);
    } catch (_) {}
    return 1;
}

function leerClaveConfigDb(conn, clave) {
    if (!conn) return null;
    for (const tabla of ['configuraciones_maestras', 'configuracion', 'configuracion_cajera']) {
        try {
            const row = conn.prepare(`SELECT valor FROM ${tabla} WHERE clave = ? LIMIT 1`).get(clave);
            if (row && row.valor !== undefined && row.valor !== null) return row.valor;
        } catch (_) {}
    }
    return null;
}

function guardarClaveConfigDb(conn, clave, valorStr) {
    if (!conn) return;
    for (const tabla of ['configuraciones_maestras', 'configuracion']) {
        try {
            conn.prepare(`
                INSERT INTO ${tabla} (clave, valor) VALUES (?, ?)
                ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
            `).run(clave, String(valorStr));
        } catch (_) {}
    }
}

function obtenerParametrosFiscalesAvanzadosDb(conn, companyId) {
    const cid = String(companyId || 'DEFAULT').trim();
    const rawSpe = leerClaveConfigDb(conn, 'isSujetoEspecial');
    const esSpe = rawSpe === true || rawSpe === 'true' || rawSpe === '1' || rawSpe === 1;

    let tasas = { iva_general: 16, iva_reducido: 8, iva_anadida: 31, igtf_porcentaje: 3 };
    try {
        const cf = conn.prepare(`SELECT * FROM configuracion_fiscal WHERE id = 1`).get();
        if (cf) {
            tasas = {
                iva_general: Number(cf.iva_general || 16),
                iva_reducido: Number(cf.iva_reducido || 8),
                iva_anadida: Number(cf.iva_anadida || 31),
                igtf_porcentaje: Number(cf.igtf_porcentaje || 3)
            };
        }
    } catch (_) {}

    let adv = {};
    try {
        const rawAdv = leerClaveConfigDb(conn, `cxc_cxp_parametros_fiscales::${cid}`)
            || leerClaveConfigDb(conn, 'cxc_cxp_parametros_fiscales');
        if (rawAdv) adv = JSON.parse(rawAdv);
    } catch (_) {}

    return {
        company_id: cid,
        is_sujeto_especial: esSpe,
        es_agente_retencion_iva: adv.es_agente_retencion_iva !== undefined ? Boolean(adv.es_agente_retencion_iva) : esSpe,
        es_agente_retencion_islr: adv.es_agente_retencion_islr !== undefined ? Boolean(adv.es_agente_retencion_islr) : true,
        modo_ajuste_cambiario: String(adv.modo_ajuste_cambiario || 'FISCAL_ND_ART51').toUpperCase(),
        unidad_tributaria_bs: Math.max(0.01, Number(adv.unidad_tributaria_bs || fiscal.CONSTANTES_FISCALES_VE.UNIDAD_TRIBUTARIA_BS)),
        emitir_nd_automatica_libro_ventas: adv.emitir_nd_automatica_libro_ventas !== undefined ? Boolean(adv.emitir_nd_automatica_libro_ventas) : true,
        comision_cashea_default_pct: Number(adv.comision_cashea_default_pct !== undefined ? adv.comision_cashea_default_pct : 6.5),
        dias_credito_cxc_default: parseInt(adv.dias_credito_cxc_default || 15, 10),
        dias_gracia_cxc_default: parseInt(adv.dias_gracia_cxc_default || 3, 10),
        ...tasas
    };
}

function guardarParametrosFiscalesAvanzadosDb(conn, companyId, datos = {}) {
    const cid = String(companyId || 'DEFAULT').trim();
    const actual = obtenerParametrosFiscalesAvanzadosDb(conn, cid);
    const merged = {
        es_agente_retencion_iva: datos.es_agente_retencion_iva !== undefined ? Boolean(datos.es_agente_retencion_iva) : actual.es_agente_retencion_iva,
        es_agente_retencion_islr: datos.es_agente_retencion_islr !== undefined ? Boolean(datos.es_agente_retencion_islr) : actual.es_agente_retencion_islr,
        modo_ajuste_cambiario: ['FISCAL_ND_ART51', 'VEN_NIF_RESULTADO'].includes(String(datos.modo_ajuste_cambiario || '').toUpperCase())
            ? String(datos.modo_ajuste_cambiario).toUpperCase()
            : actual.modo_ajuste_cambiario,
        unidad_tributaria_bs: Math.max(0.01, Number(datos.unidad_tributaria_bs || actual.unidad_tributaria_bs)),
        emitir_nd_automatica_libro_ventas: datos.emitir_nd_automatica_libro_ventas !== undefined
            ? Boolean(datos.emitir_nd_automatica_libro_ventas)
            : actual.emitir_nd_automatica_libro_ventas,
        comision_cashea_default_pct: Number(datos.comision_cashea_default_pct !== undefined ? datos.comision_cashea_default_pct : actual.comision_cashea_default_pct),
        dias_credito_cxc_default: parseInt(datos.dias_credito_cxc_default || actual.dias_credito_cxc_default, 10),
        dias_gracia_cxc_default: parseInt(datos.dias_gracia_cxc_default || actual.dias_gracia_cxc_default, 10)
    };
    guardarClaveConfigDb(conn, `cxc_cxp_parametros_fiscales::${cid}`, JSON.stringify(merged));
    return obtenerParametrosFiscalesAvanzadosDb(conn, cid);
}

function verificarDuplicadoDocumentoCxpDb(conn, { companyId, proveedorRif, tipoDocumento = 'FACTURA', comprobante, excludeId = null }) {
    const compClean = String(comprobante || '').trim().toUpperCase();
    const rifClean = fiscal.normalizarRifSENIAT(proveedorRif || '', false);
    if (!compClean || !rifClean) return { duplicado: false, registroExistente: null };
    const tipoUp = String(tipoDocumento || 'FACTURA').toUpperCase();

    try {
        const rows = conn.prepare(`
            SELECT id, comprobante, numero_control, fecha, monto, monto_bs, estado, tipo_documento
            FROM movimientos_cuentas_pagar
            WHERE company_id = ?
              AND UPPER(COALESCE(motivo, '')) != 'PAGO'
              AND UPPER(TRIM(COALESCE(comprobante, ''))) = ?
              AND REPLACE(UPPER(TRIM(COALESCE(proveedor_rif, ''))), '-', '') = ?
              AND (? IS NULL OR id != ?)
        `).all(companyId, compClean, rifClean, excludeId || null, excludeId || null);

        const match = rows.find(r => String(r.tipo_documento || 'FACTURA').toUpperCase() === tipoUp) || rows[0];
        if (match) {
            return { duplicado: true, registroExistente: match };
        }
    } catch (_) {}
    return { duplicado: false, registroExistente: null };
}

function tablaClientesEnConn(conn) {
    try {
        const r = conn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='clientes_maestro'`).get();
        if (r) return 'clientes_maestro';
    } catch (_) {}
    return 'clientes_locales';
}

function evaluarLimiteCreditoClienteDb(conn, { companyId, clienteRif, montoNuevaFacturaUsd = 0, tasaBcv = 1 }) {
    const tablaCli = tablaClientesEnConn(conn);
    const rifClean = fiscal.normalizarRifSENIAT(clienteRif || '', false);
    let cli = null;
    try {
        cli = conn.prepare(`
            SELECT * FROM ${tablaCli}
            WHERE REPLACE(UPPER(TRIM(COALESCE(rif,''))), '-', '') = ?
              AND (company_id = ? OR company_id IS NULL OR company_id = '')
            LIMIT 1
        `).get(rifClean, companyId);
    } catch (_) {}

    const params = obtenerParametrosFiscalesAvanzadosDb(conn, companyId);
    const limiteUsd = Number(cli && cli.limite_credito_usd ? cli.limite_credito_usd : 0);
    const diasCredCli = parseInt((cli && cli.dias_credito) || params.dias_credito_cxc_default || 15, 10);
    const diasGraciaCli = parseInt((cli && cli.dias_gracia !== undefined && cli.dias_gracia !== null) ? cli.dias_gracia : (params.dias_gracia_cxc_default || 3), 10);
    const bloqueadoManual = Number(cli && cli.bloqueado_credito ? cli.bloqueado_credito : 0) === 1;

    let abiertas = [];
    try {
        abiertas = conn.prepare(`
            SELECT id, factura_nro, fecha, fecha_vencimiento, dias_credito, monto_usd, monto_bs, monto_pagado, tasa_emision, estado
            FROM cuentas_por_cobrar
            WHERE (company_id = ? OR company_id IS NULL OR company_id = '')
              AND REPLACE(UPPER(TRIM(COALESCE(cliente_id, cliente_rif, rif_cliente))), '-', '') = ?
              AND UPPER(TRIM(COALESCE(estado,''))) NOT IN ('PAGADA','PAGADO','ANULADA')
        `).all(companyId, rifClean);
    } catch (_) {}

    let deudaAbiertaUsd = 0;
    let saldoVencidoConGraciaUsd = 0;
    let diasMoraMax = 0;

    abiertas.forEach(c => {
        const origUsd = Number(c.monto_usd || 0) > 0
            ? Number(c.monto_usd)
            : (Number(c.tasa_emision || 1) > 0 ? Number(c.monto_bs || 0) / Number(c.tasa_emision || 1) : 0);
        const pagUsd = Number(c.monto_pagado || 0);
        const saldo = fiscal.round2(Math.max(0, origUsd - pagUsd));
        if (saldo <= 0.01) return;
        deudaAbiertaUsd = fiscal.round2(deudaAbiertaUsd + saldo);

        const ag = fiscal.calcularAgingDocumento({
            fechaEmision: c.fecha,
            fechaVencimiento: c.fecha_vencimiento,
            diasCredito: c.dias_credito || diasCredCli
        });
        if (ag.dias_vencido > diasMoraMax) diasMoraMax = ag.dias_vencido;
        if (ag.dias_vencido > diasGraciaCli) {
            saldoVencidoConGraciaUsd = fiscal.round2(saldoVencidoConGraciaUsd + saldo);
        }
    });

    let saldoFavorUsd = Number((cli && cli.saldo_a_favor_usd) || 0);
    try {
        const antRow = conn.prepare(`
            SELECT COALESCE(SUM(saldo_disponible_usd), 0) AS total
            FROM anticipos_saldos_favor
            WHERE company_id = ? AND modulo = 'CXC'
              AND REPLACE(UPPER(TRIM(tercero_rif)), '-', '') = ?
              AND estado = 'DISPONIBLE'
        `).get(companyId, rifClean);
        if (antRow) saldoFavorUsd = Math.max(saldoFavorUsd, fiscal.round2(antRow.total));
    } catch (_) {}

    const nuevaUsd = Math.max(0, Number(montoNuevaFacturaUsd || 0));
    const creditoDisponibleUsd = limiteUsd > 0 ? fiscal.round2(limiteUsd - deudaAbiertaUsd) : null;
    const excedeLimite = limiteUsd > 0 && (deudaAbiertaUsd + nuevaUsd) > (limiteUsd + 0.01);
    const tieneMoraVencida = saldoVencidoConGraciaUsd > 0.01;
    const bloqueadoPorRegla = bloqueadoManual || excedeLimite || tieneMoraVencida;

    let motivoBloqueo = '';
    if (bloqueadoManual) motivoBloqueo = 'Cliente con crédito bloqueado manualmente en ficha administrativa.';
    else if (tieneMoraVencida) motivoBloqueo = `Cliente posee $ ${saldoVencidoConGraciaUsd.toFixed(2)} vencidos (${diasMoraMax}d mora > ${diasGraciaCli}d gracia).`;
    else if (excedeLimite) motivoBloqueo = `Excede límite de crédito ($ ${limiteUsd.toFixed(2)}). Deuda actual $ ${deudaAbiertaUsd.toFixed(2)} + Nueva $ ${nuevaUsd.toFixed(2)}.`;

    return {
        rif: clienteRif,
        nombre: (cli && cli.nombre) || '',
        tipo_contribuyente: (cli && cli.tipo_contribuyente) || (cli && cli.es_contribuyente_especial ? 'ESPECIAL' : 'ORDINARIO'),
        limite_credito_usd: limiteUsd,
        deuda_actual_usd: deudaAbiertaUsd,
        credito_disponible_usd: creditoDisponibleUsd,
        dias_credito: diasCredCli,
        dias_gracia: diasGraciaCli,
        descuento_pronto_pago_pct: Number((cli && cli.descuento_pronto_pago_pct) || 0),
        dias_mora_max: diasMoraMax,
        saldo_vencido_usd: saldoVencidoConGraciaUsd,
        tiene_mora_vencida: tieneMoraVencida,
        bloqueado_manual: bloqueadoManual,
        excede_limite: excedeLimite,
        bloqueado_credito: bloqueadoPorRegla,
        motivo_bloqueo: motivoBloqueo,
        saldo_a_favor_usd: fiscal.round2(saldoFavorUsd),
        saldo_a_favor_bs: fiscal.round2(saldoFavorUsd * Math.max(0.01, Number(tasaBcv || 1)))
    };
}

function asegurarCuentaTesoreriaDefaultDb(conn, companyId, moneda = 'BS') {
    const monUp = String(moneda || 'BS').toUpperCase() === 'USD' ? 'USD' : 'BS';
    const defId = `CTA-${monUp}-${String(companyId || 'DEF').slice(0, 8).toUpperCase()}`;
    const ex = conn.prepare(`SELECT * FROM cuentas_tesoreria WHERE company_id = ? AND moneda = ? AND activa = 1 ORDER BY id ASC LIMIT 1`).get(companyId, monUp);
    if (ex) return ex;
    const nombre = monUp === 'USD' ? 'Caja / Custodia Divisas USD (Principal)' : 'Caja / Banco Bolívares Principal';
    const tipo = monUp === 'USD' ? 'CAJA_DIVISAS' : 'BANCO_BS';
    conn.prepare(`
        INSERT OR IGNORE INTO cuentas_tesoreria (id, company_id, nombre, tipo_cuenta, moneda, saldo_actual, activa, estado_sync)
        VALUES (?, ?, ?, ?, ?, 0, 1, 0)
    `).run(defId, companyId, nombre, tipo, monUp);
    return conn.prepare(`SELECT * FROM cuentas_tesoreria WHERE id = ?`).get(defId);
}

function registrarMovimientoTesoreriaInternoDb(conn, {
    companyId,
    cuentaId = null,
    moduloOrigen = 'MANUAL',
    referenciaOrigenId = '',
    terceroRif = '',
    terceroNombre = '',
    tipo = 'INGRESO',
    moneda = 'BS',
    monto = 0,
    tasaBcv = 1,
    metodoPago = 'EFECTIVO',
    referenciaBancaria = '',
    fecha = '',
    concepto = '',
    usuario = ''
}) {
    const val = fiscal.round2(Math.abs(Number(monto || 0)));
    if (val <= 0) return null;
    const mon = String(moneda || 'BS').toUpperCase() === 'USD' ? 'USD' : 'BS';
    const tasa = Math.max(0.0001, Number(tasaBcv || resolverTasaActivaDb(conn)));
    const montoUsdEq = mon === 'USD' ? val : fiscal.round2(val / tasa);

    let cta = null;
    if (cuentaId) {
        cta = conn.prepare(`SELECT * FROM cuentas_tesoreria WHERE id = ? AND company_id = ?`).get(cuentaId, companyId);
    }
    if (!cta) cta = asegurarCuentaTesoreriaDefaultDb(conn, companyId, mon);

    const movId = genId('TES');
    const tipoUp = String(tipo || 'INGRESO').toUpperCase() === 'EGRESO' ? 'EGRESO' : 'INGRESO';
    const delta = tipoUp === 'INGRESO' ? val : -val;
    const fechaOp = String(fecha || fiscal.obtenerHoyCaracasISO()).slice(0, 10);

    conn.prepare(`
        INSERT INTO movimientos_tesoreria (
            id, company_id, cuenta_id, modulo_origen, referencia_origen_id, tercero_rif, tercero_nombre,
            tipo, moneda, monto, monto_usd_eq, tasa_bcv, metodo_pago, referencia_bancaria, conciliado, fecha, concepto, usuario, estado_sync
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
        movId, companyId, cta.id, moduloOrigen, referenciaOrigenId, terceroRif, terceroNombre,
        tipoUp, mon, val, montoUsdEq, tasa, metodoPago, referenciaBancaria,
        String(referenciaBancaria || '').trim() ? 1 : 0, fechaOp, concepto, usuario
    );

    conn.prepare(`
        UPDATE cuentas_tesoreria SET saldo_actual = ROUND(COALESCE(saldo_actual, 0) + ?, 2), fecha_actualizacion = datetime('now', '-4 hours'), estado_sync = 0
        WHERE id = ?
    `).run(delta, cta.id);

    return { movId, cuenta_id: cta.id, tipo: tipoUp, monto: val, moneda: mon };
}

function registrarAnticipoOSaldoFavorDb(conn, d = {}) {
    const compId = String(d.company_id || d.companyId || '').trim();
    if (!compId || !d.tercero_rif) throw new Error('company_id y tercero_rif son requeridos para anticipo/saldo a favor.');
    const modulo = String(d.modulo || 'CXC').toUpperCase() === 'CXP' ? 'CXP' : 'CXC';
    const modalidad = String(d.modalidad_contrato || 'INDEXADO_USD').toUpperCase() === 'NOMINAL_BS' ? 'NOMINAL_BS' : 'INDEXADO_USD';
    const tasa = Math.max(0.01, Number(d.tasa_bcv || resolverTasaActivaDb(conn)));
    let usd = fiscal.round2(d.monto_usd || 0);
    let bs = fiscal.round2(d.monto_bs || 0);
    if (usd <= 0 && bs > 0) usd = fiscal.round2(bs / tasa);
    if (bs <= 0 && usd > 0) bs = fiscal.round2(usd * tasa);
    if (usd <= 0 && bs <= 0) throw new Error('El monto del anticipo o saldo a favor debe ser mayor a cero.');

    const id = d.id || genId(modulo === 'CXC' ? 'ANTC' : 'ANTP');
    const fecha = String(d.fecha || fiscal.obtenerHoyCaracasISO()).slice(0, 10);
    const tipoReg = String(d.tipo_registro || 'ANTICIPO').toUpperCase();
    const rifClean = fiscal.normalizarRifSENIAT(d.tercero_rif, false);

    const execTx = conn.transaction(() => {
        conn.prepare(`
            INSERT INTO anticipos_saldos_favor (
                id, company_id, modulo, tercero_rif, tercero_nombre, tipo_registro, modalidad_contrato,
                fecha, tasa_bcv, monto_original_usd, monto_original_bs, saldo_disponible_usd, saldo_disponible_bs,
                metodo_pago, referencia, documento_origen, nota, estado, estado_sync
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISPONIBLE', 0)
        `).run(
            id, compId, modulo, d.tercero_rif, d.tercero_nombre || d.tercero_rif, tipoReg, modalidad,
            fecha, tasa, usd, bs, usd, bs,
            d.metodo_pago || 'EFECTIVO', d.referencia || '', d.documento_origen || '', d.nota || ''
        );

        // Sincronizar resumen en ficha Cliente o Proveedor
        if (modulo === 'CXC') {
            const tablaCli = tablaClientesEnConn(conn);
            try {
                conn.prepare(`
                    UPDATE ${tablaCli}
                    SET saldo_a_favor_usd = ROUND(COALESCE(saldo_a_favor_usd, 0) + ?, 2),
                        saldo_a_favor_bs = ROUND(COALESCE(saldo_a_favor_bs, 0) + ?, 2),
                        estado_sync = 0
                    WHERE REPLACE(UPPER(TRIM(COALESCE(rif,''))), '-', '') = ? AND (company_id = ? OR company_id IS NULL)
                `).run(usd, bs, rifClean, compId);
            } catch (_) {}
        } else {
            try {
                conn.prepare(`
                    UPDATE proveedores
                    SET saldo_a_favor_usd = ROUND(COALESCE(saldo_a_favor_usd, 0) + ?, 2),
                        saldo_a_favor_bs = ROUND(COALESCE(saldo_a_favor_bs, 0) + ?, 2),
                        estado_sync = 0
                    WHERE REPLACE(UPPER(TRIM(COALESCE(rif,''))), '-', '') = ? AND (company_id = ? OR company_id IS NULL)
                `).run(usd, bs, rifClean, compId);
            } catch (_) {}
        }

        if (d.afectar_tesoreria) {
            const esDivisa = String(d.moneda_pago || '').toUpperCase() === 'USD' || /USD|ZELLE|EFECTIVO_\$/i.test(String(d.metodo_pago || ''));
            registrarMovimientoTesoreriaInternoDb(conn, {
                companyId: compId,
                cuentaId: d.cuenta_tesoreria_id || null,
                moduloOrigen: `${modulo}_ANTICIPO`,
                referenciaOrigenId: id,
                terceroRif: d.tercero_rif,
                terceroNombre: d.tercero_nombre || '',
                tipo: modulo === 'CXC' ? 'INGRESO' : 'EGRESO',
                moneda: esDivisa ? 'USD' : 'BS',
                monto: esDivisa ? usd : bs,
                tasaBcv: tasa,
                metodoPago: d.metodo_pago || 'EFECTIVO',
                referenciaBancaria: d.referencia || '',
                fecha,
                concepto: `${tipoReg} ${modulo} (${modalidad}) - ${d.tercero_nombre || d.tercero_rif}`,
                usuario: d.usuario || ''
            });
        }
    });

    execTx();
    return { exito: true, id, monto_usd: usd, monto_bs: bs, modalidad };
}

function consumirSaldoAFavorInternoDb(conn, { companyId, modulo, terceroRif, montoSolicitadoUsd = 0, tasaCruce = 1 }) {
    let porCubrirUsd = Math.max(0, fiscal.round2(montoSolicitadoUsd));
    if (porCubrirUsd <= 0) return { aplicado_usd: 0, aplicado_bs: 0 };
    const rifClean = fiscal.normalizarRifSENIAT(terceroRif, false);

    const disponibles = conn.prepare(`
        SELECT * FROM anticipos_saldos_favor
        WHERE company_id = ? AND modulo = ?
          AND REPLACE(UPPER(TRIM(tercero_rif)), '-', '') = ?
          AND estado = 'DISPONIBLE'
          AND (saldo_disponible_usd > 0.005 OR saldo_disponible_bs > 0.05)
        ORDER BY fecha ASC, id ASC
    `).all(companyId, modulo, rifClean);

    let totalAplicadoUsd = 0;
    let totalAplicadoBs = 0;

    for (const ant of disponibles) {
        if (porCubrirUsd <= 0.005) break;
        const cruce = fiscal.calcularCruceAnticipoBimoneda({
            saldoDisponibleUsd: ant.saldo_disponible_usd,
            saldoDisponibleBs: ant.saldo_disponible_bs,
            tasaOriginal: ant.tasa_bcv,
            modalidadContrato: ant.modalidad_contrato,
            tasaCruce,
            montoObjetivoUsd: porCubrirUsd
        });

        if (cruce.aplicado_usd <= 0) continue;
        const agoto = cruce.nuevo_saldo_disponible_usd <= 0.01 && cruce.nuevo_saldo_disponible_bs <= 0.1;
        conn.prepare(`
            UPDATE anticipos_saldos_favor
            SET saldo_disponible_usd = ?, saldo_disponible_bs = ?, estado = ?, estado_sync = 0
            WHERE id = ?
        `).run(cruce.nuevo_saldo_disponible_usd, cruce.nuevo_saldo_disponible_bs, agoto ? 'CONSUMIDO' : 'DISPONIBLE', ant.id);

        totalAplicadoUsd = fiscal.round2(totalAplicadoUsd + cruce.aplicado_usd);
        totalAplicadoBs = fiscal.round2(totalAplicadoBs + cruce.aplicado_bs);
        porCubrirUsd = fiscal.round2(porCubrirUsd - cruce.aplicado_usd);
    }

    if (totalAplicadoUsd > 0) {
        if (modulo === 'CXC') {
            const tablaCli = tablaClientesEnConn(conn);
            try {
                conn.prepare(`
                    UPDATE ${tablaCli}
                    SET saldo_a_favor_usd = MAX(0, ROUND(COALESCE(saldo_a_favor_usd, 0) - ?, 2)),
                        saldo_a_favor_bs = MAX(0, ROUND(COALESCE(saldo_a_favor_bs, 0) - ?, 2)),
                        estado_sync = 0
                    WHERE REPLACE(UPPER(TRIM(COALESCE(rif,''))), '-', '') = ? AND (company_id = ? OR company_id IS NULL)
                `).run(totalAplicadoUsd, totalAplicadoBs, rifClean, companyId);
            } catch (_) {}
        } else {
            try {
                conn.prepare(`
                    UPDATE proveedores
                    SET saldo_a_favor_usd = MAX(0, ROUND(COALESCE(saldo_a_favor_usd, 0) - ?, 2)),
                        saldo_a_favor_bs = MAX(0, ROUND(COALESCE(saldo_a_favor_bs, 0) - ?, 2)),
                        estado_sync = 0
                    WHERE REPLACE(UPPER(TRIM(COALESCE(rif,''))), '-', '') = ? AND (company_id = ? OR company_id IS NULL)
                `).run(totalAplicadoUsd, totalAplicadoBs, rifClean, companyId);
            } catch (_) {}
        }
    }

    return { aplicado_usd: totalAplicadoUsd, aplicado_bs: totalAplicadoBs };
}

function registrarAbonoCxcAvanzadoDb(conn, d = {}, espejoConn = null) {
    const compId = String(d.company_id || d.companyId || '').trim();
    if (!compId || !d.cliente_id) throw new Error('company_id y cliente_id son requeridos para el abono CxC.');
    const params = obtenerParametrosFiscalesAvanzadosDb(conn, compId);
    const tasa = Math.max(0.01, Number(d.tasa_bcv || d.tasa || resolverTasaActivaDb(conn)));
    const rifClean = fiscal.normalizarRifSENIAT(d.cliente_id, false);
    const fechaOp = String(d.fecha || fiscal.obtenerHoyCaracasISO()).slice(0, 10);

    const execTx = conn.transaction(() => {
        let pendientes = conn.prepare(`
            SELECT * FROM cuentas_por_cobrar
            WHERE (company_id = ? OR company_id IS NULL OR company_id = '')
              AND REPLACE(UPPER(TRIM(COALESCE(cliente_id, cliente_rif, rif_cliente))), '-', '') = ?
              AND UPPER(TRIM(COALESCE(estado,''))) NOT IN ('PAGADA','PAGADO','ANULADA')
            ORDER BY fecha ASC, id ASC
        `).all(compId, rifClean);

        if (d.cuenta_id || d.factura_nro) {
            const idx = pendientes.findIndex(r =>
                (d.cuenta_id && String(r.id) === String(d.cuenta_id))
                || (d.factura_nro && String(r.factura_nro || '').trim() === String(d.factura_nro).trim())
            );
            if (idx > 0) {
                const target = pendientes.splice(idx, 1)[0];
                pendientes.unshift(target);
            }
        }

        const totalSaldoPendienteUsd = fiscal.round2(pendientes.reduce((acc, r) => {
            const mUsd = Number(r.monto_usd || 0) > 0
                ? Number(r.monto_usd)
                : (Number(r.tasa_emision || tasa) > 0 ? Number(r.monto_bs || 0) / Number(r.tasa_emision || tasa) : 0);
            return acc + Math.max(0, mUsd - Number(r.monto_pagado || 0));
        }, 0));

        const consumoFavor = Number(d.usar_saldo_a_favor_usd || 0) > 0
            ? consumirSaldoAFavorInternoDb(conn, {
                companyId: compId,
                modulo: 'CXC',
                terceroRif: d.cliente_id,
                montoSolicitadoUsd: Number(d.usar_saldo_a_favor_usd),
                tasaCruce: tasa
            })
            : { aplicado_usd: 0, aplicado_bs: 0 };

        const montoBsInput = Math.max(0, Number(d.monto_bs || 0)) + consumoFavor.aplicado_bs;
        const prelacion = fiscal.calcularPrelacionCobroIgtfVE({
            saldoPendienteUsd: totalSaldoPendienteUsd > 0 ? totalSaldoPendienteUsd : 0,
            tasaCobro: tasa,
            montoRetencionIvaBs: Number(d.retencion_iva_bs || 0),
            montoRetencionIslrBs: Number(d.retencion_islr_bs || 0),
            descuentoProntoPagoUsd: Number(d.descuento_pronto_pago_usd || 0),
            montoPagadoBs: montoBsInput,
            montoPagadoDivisasUsd: Number(d.monto_divisas_usd || 0),
            divisaIncluyeIgtf: Boolean(d.divisa_incluye_igtf),
            empresaEsSpeIgtf: d.aplicar_igtf !== undefined ? Boolean(d.aplicar_igtf) : params.is_sujeto_especial,
            pctIgtf: params.igtf_porcentaje || 3
        });

        let porDistribuirUsd = prelacion.amortizacion_capital_usd;
        let diferencialTotalBs = 0;
        let ndGeneradas = [];

        for (const fac of pendientes) {
            if (porDistribuirUsd <= 0.005) break;
            const tOrig = Math.max(0.01, Number(fac.tasa_emision || tasa));
            const mUsd = Number(fac.monto_usd || 0) > 0 ? Number(fac.monto_usd) : fiscal.round2(Number(fac.monto_bs || 0) / tOrig);
            const pagPrevUsd = Number(fac.monto_pagado || 0);
            const saldoFacUsd = fiscal.round2(Math.max(0, mUsd - pagPrevUsd));
            if (saldoFacUsd <= 0.005) continue;

            const abonoFacUsd = Math.min(saldoFacUsd, porDistribuirUsd);
            const nuevoPagadoUsd = fiscal.round2(pagPrevUsd + abonoFacUsd);
            const pagada = nuevoPagadoUsd >= (mUsd - 0.01);

            conn.prepare(`
                UPDATE cuentas_por_cobrar
                SET monto_pagado = ?, estado = ?, estado_sync = 0
                WHERE id = ?
            `).run(nuevoPagadoUsd, pagada ? 'PAGADA' : 'ABONADO', fac.id);

            const evalDiff = fiscal.evaluarAsimetriaDiferencialCambiario({
                modulo: 'CXC',
                modoFiscalEmpresa: params.modo_ajuste_cambiario,
                montoUsdAmortizado: abonoFacUsd,
                tasaOriginal: tOrig,
                tasaLiquidacion: tasa,
                alicuotaIva: params.iva_general || 16,
                esOperacionGravada: Number(fac.monto_iva_bs || 0) > 0 || Number(fac.base_imponible_bs || 0) >= 0
            });

            if (Math.abs(evalDiff.variacion_bruta_bs) >= 0.01) {
                diferencialTotalBs = fiscal.round2(diferencialTotalBs + evalDiff.variacion_bruta_bs);
                const adjId = genId('AJC');
                let nroNd = '';
                let ventaIdNd = '';

                if (evalDiff.requiere_nota_debito_fiscal && params.emitir_nd_automatica_libro_ventas) {
                    nroNd = d.numero_nd_fiscal || `ND-DC-${String(Date.now()).slice(-7)}`;
                    ventaIdNd = genId('NDV');
                    try {
                        conn.prepare(`
                            INSERT INTO ventas_locales (
                                id, company_id, branch_id, cashier_id, numero_factura, numero_control,
                                cliente_nombre, cliente_rif, monto_exento, base_imponible, monto_iva, total_iva,
                                monto_igtf, monto_total, tasa_bcv, metodo_pago, datos_json, estado_sync,
                                es_nota_credito, es_nota_debito, factura_afectada, monto_factura_afectada,
                                fecha_factura_afectada, alicuota_iva, fecha_emision, estado
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, 'AJUSTE_CAMBIARIO', ?, 0, 0, 1, ?, ?, ?, ?, datetime('now', '-4 hours'), 'EMITIDA')
                        `).run(
                            ventaIdNd, compId, fac.branch_id || d.branch_id || 'PRINCIPAL', d.usuario || 'ADMIN',
                            nroNd, d.numero_control_nd || '',
                            fac.cliente_nombre || d.cliente_nombre || '', fac.cliente_rif || d.cliente_id,
                            evalDiff.base_imponible_nd_bs, evalDiff.iva_nd_bs, evalDiff.iva_nd_bs,
                            evalDiff.variacion_bruta_bs, tasa,
                            JSON.stringify({ origen: 'DIFERENCIAL_CAMBIARIO_ART51', cuenta_cxc_id: fac.id, hora: fiscal.formatearHoraSNAT2026() }),
                            fac.factura_nro || '', Number(fac.monto_bs || 0), String(fac.fecha || '').slice(0, 10),
                            params.iva_general || 16
                        );
                    } catch (_) {}
                }

                conn.prepare(`
                    INSERT INTO notas_ajuste_cambiario (
                        id, company_id, modulo, tipo_ajuste, estado, tercero_rif, tercero_nombre,
                        documento_origen_id, documento_origen_nro, numero_nd_fiscal, numero_control_nd,
                        fecha_operacion, tasa_original, tasa_liquidacion, monto_usd_base,
                        variacion_bruta_bs, base_imponible_nd_bs, iva_nd_bs, alicuota_iva,
                        regimen_aplicado, venta_id_generada, nota, estado_sync
                    ) VALUES (?, ?, 'CXC', ?, 'REGISTRADO', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                `).run(
                    adjId, compId,
                    evalDiff.requiere_nota_debito_fiscal ? 'NOTA_DEBITO_FISCAL' : 'DIFERENCIAL_VEN_NIF',
                    d.cliente_id, d.cliente_nombre || fac.cliente_nombre || '',
                    String(fac.id), fac.factura_nro || '', nroNd, d.numero_control_nd || '',
                    fechaOp, tOrig, tasa, abonoFacUsd,
                    evalDiff.variacion_bruta_bs, evalDiff.base_imponible_nd_bs, evalDiff.iva_nd_bs,
                    params.iva_general || 16, evalDiff.regimen_aplicado, ventaIdNd,
                    d.nota || `Ajuste cambiario cobro factura ${fac.factura_nro || fac.id}`
                );

                ndGeneradas.push({ id: adjId, numero_nd: nroNd, variacion_bs: evalDiff.variacion_bruta_bs, iva_bs: evalDiff.iva_nd_bs, regimen: evalDiff.regimen_aplicado });
            }

            porDistribuirUsd = fiscal.round2(porDistribuirUsd - abonoFacUsd);
        }

        // Registrar retención de cliente en Libro de Ventas si fue vinculada
        if (Number(d.retencion_iva_bs || 0) > 0 && d.factura_nro) {
            try {
                conn.prepare(`
                    UPDATE ventas_locales
                    SET iva_retenido_cliente = ?, numero_comprobante_retencion_cliente = ?, fecha_retencion_cliente = ?, estado_sync = 0
                    WHERE numero_factura = ? AND company_id = ?
                `).run(
                    fiscal.round2(d.retencion_iva_bs),
                    String(d.comprobante_retencion_iva || d.referencia || '').trim(),
                    fechaOp,
                    d.factura_nro,
                    compId
                );
            } catch (_) {}
        }

        const abonoId = d.id || genId('ABC');
        conn.prepare(`
            INSERT INTO abonos_cuentas_cobrar (
                id, company_id, branch_id, cuenta_id, factura_nro, cliente_id, cliente_nombre,
                monto_bs, monto_usd, tasa_bcv, metodo_pago, referencia, nota, usuario, fecha, estado_sync,
                igtf_usd, igtf_bs, retencion_iva_bs, retencion_islr_bs, descuento_pronto_pago_usd,
                diferencial_cambiario_bs, tipo_abono, observacion_conciliacion
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-4 hours'), 0, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            abonoId, compId, d.branch_id || 'PRINCIPAL',
            d.cuenta_id || (pendientes[0] ? pendientes[0].id : null),
            d.factura_nro || (pendientes[0] ? pendientes[0].factura_nro : ''),
            d.cliente_id, d.cliente_nombre || '',
            prelacion.amortizacion_capital_bs, prelacion.amortizacion_capital_usd,
            tasa, d.metodo_pago || 'MIXTO', d.referencia || '', d.nota || '', d.usuario || 'ADMIN',
            prelacion.igtf_usd, prelacion.igtf_bs,
            fiscal.round2(d.retencion_iva_bs || 0), fiscal.round2(d.retencion_islr_bs || 0),
            prelacion.descuento_pronto_pago_usd, diferencialTotalBs,
            d.tipo_abono || 'NORMAL', d.observacion_conciliacion || ''
        );

        // Sobrepago a Saldo a Favor (nunca se descarta)
        if (prelacion.excedente_saldo_a_favor_usd > 0.01) {
            registrarAnticipoOSaldoFavorDb(conn, {
                company_id: compId,
                modulo: 'CXC',
                tercero_rif: d.cliente_id,
                tercero_nombre: d.cliente_nombre || '',
                tipo_registro: 'SALDO_FAVOR',
                modalidad_contrato: 'INDEXADO_USD',
                fecha: fechaOp,
                tasa_bcv: tasa,
                monto_usd: prelacion.excedente_saldo_a_favor_usd,
                monto_bs: prelacion.excedente_saldo_a_favor_bs,
                metodo_pago: d.metodo_pago || 'MIXTO',
                referencia: d.referencia || '',
                documento_origen: d.factura_nro || abonoId,
                nota: `Excedente generado en abono ${abonoId}`,
                afectar_tesoreria: false
            });
        }

        // Registrar ingresos reales en Tesorería Bimonetaria
        if (d.registrar_en_tesoreria !== false) {
            const pagoBsExterno = Math.max(0, Number(d.monto_bs || 0));
            const pagoDivisasTotalUsd = fiscal.round2(prelacion.divisa_base_capital_usd + prelacion.igtf_usd);
            if (pagoBsExterno > 0) {
                registrarMovimientoTesoreriaInternoDb(conn, {
                    companyId: compId,
                    cuentaId: d.cuenta_tesoreria_bs_id || null,
                    moduloOrigen: 'CXC_COBRO',
                    referenciaOrigenId: abonoId,
                    terceroRif: d.cliente_id,
                    terceroNombre: d.cliente_nombre || '',
                    tipo: 'INGRESO',
                    moneda: 'BS',
                    monto: pagoBsExterno,
                    tasaBcv: tasa,
                    metodoPago: d.metodo_pago || 'BS',
                    referenciaBancaria: d.referencia || '',
                    fecha: fechaOp,
                    concepto: `Cobranza CxC Bs - ${d.cliente_nombre || d.cliente_id} (${d.factura_nro || 'Varias'})`,
                    usuario: d.usuario || ''
                });
            }
            if (pagoDivisasTotalUsd > 0) {
                registrarMovimientoTesoreriaInternoDb(conn, {
                    companyId: compId,
                    cuentaId: d.cuenta_tesoreria_usd_id || null,
                    moduloOrigen: 'CXC_COBRO',
                    referenciaOrigenId: abonoId,
                    terceroRif: d.cliente_id,
                    terceroNombre: d.cliente_nombre || '',
                    tipo: 'INGRESO',
                    moneda: 'USD',
                    monto: pagoDivisasTotalUsd,
                    tasaBcv: tasa,
                    metodoPago: d.metodo_pago || 'DIVISAS',
                    referenciaBancaria: d.referencia || '',
                    fecha: fechaOp,
                    concepto: `Cobranza CxC Divisas${prelacion.igtf_usd > 0 ? ` (incl. IGTF $${prelacion.igtf_usd.toFixed(2)})` : ''} - ${d.cliente_nombre || d.cliente_id}`,
                    usuario: d.usuario || ''
                });
            }
        }

        // Recalcular saldo deuda en ficha cliente
        const nuevoSaldo = conn.prepare(`
            SELECT COALESCE(SUM(MAX(0, (CASE WHEN monto_usd > 0 THEN monto_usd ELSE (monto_bs / CASE WHEN tasa_emision > 0 THEN tasa_emision ELSE 1 END) END) - COALESCE(monto_pagado, 0))), 0) AS saldo
            FROM cuentas_por_cobrar
            WHERE (company_id = ? OR company_id IS NULL OR company_id = '')
              AND REPLACE(UPPER(TRIM(COALESCE(cliente_id, cliente_rif, rif_cliente))), '-', '') = ?
              AND UPPER(TRIM(COALESCE(estado,''))) NOT IN ('PAGADA','PAGADO','ANULADA')
        `).get(compId, rifClean);
        const sUsd = fiscal.round2((nuevoSaldo && nuevoSaldo.saldo) || 0);
        const tablaCli = tablaClientesEnConn(conn);
        try {
            conn.prepare(`
                UPDATE ${tablaCli}
                SET saldo_deuda_usd = ?, saldo_deuda = ?, estado_sync = 0
                WHERE REPLACE(UPPER(TRIM(COALESCE(rif,''))), '-', '') = ? AND (company_id = ? OR company_id IS NULL)
            `).run(sUsd, fiscal.round2(sUsd * tasa), rifClean, compId);
        } catch (_) {}

        return {
            exito: true,
            abono_id: abonoId,
            prelacion,
            diferencial_cambiario_bs: diferencialTotalBs,
            notas_debito_generadas: ndGeneradas,
            saldo_restante_usd: sUsd,
            saldo_a_favor_generado_usd: prelacion.excedente_saldo_a_favor_usd
        };
    });

    const resultado = execTx();
    if (espejoConn && espejoConn !== conn) {
        try { registrarAbonoCxcAvanzadoDb(espejoConn, { ...d, id: resultado.abono_id }, null); } catch (_) {}
    }
    return resultado;
}

function guardarDocumentoCxpCompletoDb(conn, d = {}, espejoConn = null) {
    const compId = String(d.company_id || d.companyId || '').trim();
    if (!compId || !d.proveedor_rif) throw new Error('company_id y proveedor_rif son obligatorios.');
    const rif = String(d.proveedor_rif).trim().toUpperCase();
    const rifClean = fiscal.normalizarRifSENIAT(rif, false);
    const tipoDoc = String(d.tipo_documento || 'FACTURA').toUpperCase();
    const motivo = String(d.motivo || (tipoDoc === 'GASTO' ? 'GASTO_OPERATIVO' : (tipoDoc === 'NOTA_CREDITO' ? 'NOTA_CREDITO' : (tipoDoc === 'NOTA_DEBITO' ? 'NOTA_DEBITO' : 'FACTURA')))).toUpperCase();
    const comprobante = String(d.comprobante || d.nota_credito_nro || d.nota_debito_nro || '').trim();

    if (!d.id && !d.permitir_duplicado && comprobante && motivo !== 'PAGO') {
        const dup = verificarDuplicadoDocumentoCxpDb(conn, {
            companyId: compId,
            proveedorRif: rif,
            tipoDocumento: tipoDoc,
            comprobante,
            excludeId: d.id || null
        });
        if (dup.duplicado) {
            const err = new Error(`Documento duplicado detectado: ya existe ${dup.registroExistente.tipo_documento} #${dup.registroExistente.comprobante} para este proveedor.`);
            err.code = 'DUPLICADO_CXP';
            throw err;
        }
    }

    const params = obtenerParametrosFiscalesAvanzadosDb(conn, compId);
    const provRow = conn.prepare(`SELECT * FROM proveedores WHERE REPLACE(UPPER(TRIM(COALESCE(rif,''))), '-', '') = ? AND (company_id = ? OR company_id IS NULL) LIMIT 1`).get(rifClean, compId);
    const provNombre = String(d.proveedor_nombre || d.razon || (provRow && provRow.nombre) || rif).trim();

    const tasa = Math.max(0.01, Number(d.tasa_bcv || resolverTasaActivaDb(conn)));
    const fecha = String(d.fecha || fiscal.obtenerHoyCaracasISO()).slice(0, 10);
    const diasCred = parseInt(d.dias_credito !== undefined ? d.dias_credito : ((provRow && provRow.dias_credito_default) || 15), 10);
    const fechaVenc = d.fecha_vencimiento || fiscal.calcularAgingDocumento({ fechaEmision: fecha, diasCredito: diasCred }).fecha_vencimiento;

    let exentoBs = Math.max(0, fiscal.round2(d.monto_exento || 0));
    let baseBs = Math.max(0, fiscal.round2(d.base_imponible || 0));
    let alic = Number(d.alicuota_iva !== undefined ? d.alicuota_iva : 16);
    let ivaBs = Math.max(0, fiscal.round2(d.monto_iva || 0));
    let montoBs = Math.max(0, fiscal.round2(d.monto_bs || 0));
    let montoUsd = Math.max(0, fiscal.round2(d.monto || d.monto_usd || 0));

    let forma80Resumen = null;
    if (d.es_importacion && d.forma80 && !d.forma80_json) {
        forma80Resumen = fiscal.calcularForma80AduanaVE(d.forma80);
        if (baseBs <= 0) baseBs = forma80Resumen.base_imponible_aduana_bs;
        if (ivaBs <= 0) ivaBs = forma80Resumen.iva_aduana_bs;
    }

    if (ivaBs === 0 && baseBs > 0 && alic > 0) ivaBs = fiscal.round2(baseBs * (alic / 100));
    if (montoBs === 0 && (exentoBs > 0 || baseBs > 0 || ivaBs > 0)) montoBs = fiscal.round2(exentoBs + baseBs + ivaBs);
    if (montoBs === 0 && montoUsd > 0) {
        montoBs = fiscal.round2(montoUsd * tasa);
        if (String(d.numero_control || '').trim() && alic > 0) {
            baseBs = fiscal.round2(montoBs / (1 + alic / 100));
            ivaBs = fiscal.round2(montoBs - baseBs);
        } else {
            exentoBs = montoBs;
        }
    }
    if (montoUsd === 0 && montoBs > 0) montoUsd = fiscal.round2(montoBs / tasa);

    // Retenciones al causarse (opcionales o automáticas si se indica)
    let pctRetIva = Number(d.porcentaje_retencion !== undefined ? d.porcentaje_retencion : 0);
    let ivaRetBs = fiscal.round2(d.iva_retenido || 0);
    let compRetIva = String(d.comprobante_retencion || '').trim();
    let fechaRet = String(d.fecha_retencion || '').trim();
    const docId = d.id || genId('CXP');

    const execTx = conn.transaction(() => {
        if (!provRow) {
            conn.prepare(`
                INSERT INTO proveedores (rif, id, company_id, nombre, status, estado_sync)
                VALUES (?, ?, ?, ?, 1, 0)
                ON CONFLICT(rif) DO NOTHING
            `).run(rif, genId('PRV'), compId, provNombre);
        }

        if (d.auto_retener_iva && ivaBs > 0) {
            const calcIva = fiscal.calcularRetencionIvaVE({
                montoIvaBs: ivaBs,
                alicuotaIva: alic,
                tieneControl: Boolean(String(d.numero_control || '').trim()),
                ivaDiscriminado: ivaBs > 0,
                proveedorPctDefault: d.porcentaje_retencion !== undefined ? Number(d.porcentaje_retencion) : Number(provRow?.porcentaje_retencion_iva ?? 75),
                proveedorEnRif: d.proveedor_en_rif !== false
            });
            pctRetIva = calcIva.porcentaje_retencion;
            ivaRetBs = calcIva.monto_retenido_bs;
            if (ivaRetBs > 0 && !compRetIva) {
                const corr = fiscal.obtenerSiguienteComprobante14Db(conn, compId, 'IVA', fecha);
                compRetIva = corr.numero_comprobante;
                fechaRet = fecha;
                conn.prepare(`
                    INSERT INTO retenciones_emitidas (
                        id, company_id, tipo_impuesto, numero_comprobante, periodo_aaaamm, fecha_emision, fecha_documento,
                        movimiento_cxp_id, sujeto_rif, sujeto_nombre, tipo_persona, tipo_documento, numero_documento,
                        numero_control, documento_afectado, expediente_importacion, monto_total_bs, monto_exento_bs,
                        base_imponible_bs, alicuota_iva, impuesto_causado_bs, porcentaje_retencion, monto_retenido_bs,
                        monto_retenido_usd, tasa_bcv, estatus, datos_json, estado_sync
                    ) VALUES (?, ?, 'IVA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EMITIDO', ?, 0)
                `).run(
                    genId('RETIVA'), compId, compRetIva, corr.periodo_aaaamm, fecha, fecha,
                    docId, rif, provNombre, fiscal.clasificarPersonaPorRif(rif, provRow && provRow.tipo_contribuyente),
                    tipoDoc === 'NOTA_DEBITO' ? '02' : (tipoDoc === 'NOTA_CREDITO' ? '03' : '01'),
                    comprobante || docId, d.numero_control || '', d.factura_afectada || '0', d.expediente_importacion || '0',
                    montoBs, exentoBs, baseBs, alic, ivaBs, pctRetIva, ivaRetBs, fiscal.round2(ivaRetBs / tasa), tasa,
                    JSON.stringify({ advertencias: calcIva.advertencias })
                );
            }
        }

        let islrRetBs = fiscal.round2(d.islr_retenido_bs || 0);
        let pctIslr = Number(d.porcentaje_islr || 0);
        let codIslr = String(d.codigo_concepto_islr || '').trim();
        let sustraendoBs = fiscal.round2(d.sustraendo_islr_bs || 0);
        let compIslr = String(d.comprobante_islr || '').trim();

        if (d.auto_retener_islr && (baseBs > 0 || exentoBs > 0)) {
            const baseOperacionIslr = baseBs > 0 ? baseBs : montoBs;
            const calcIslr = fiscal.calcularRetencionIslrDecreto1808({
                baseImponibleBs: baseOperacionIslr,
                rifRetenido: rif,
                tipoPersona: d.tipo_persona_islr || (provRow && provRow.tipo_contribuyente === 'PNR' ? 'PNR' : ''),
                codigoConcepto: codIslr || (provRow && provRow.codigo_islr_default) || '053',
                porcentajeManual: d.porcentaje_islr || null,
                utBs: params.unidad_tributaria_bs
            });
            codIslr = calcIslr.codigo_concepto;
            pctIslr = calcIslr.porcentaje_retencion;
            sustraendoBs = calcIslr.sustraendo_bs;
            islrRetBs = calcIslr.monto_retenido_bs;
            if (islrRetBs > 0 && !compIslr) {
                const corrIslr = fiscal.obtenerSiguienteComprobante14Db(conn, compId, 'ISLR', fecha);
                compIslr = corrIslr.numero_comprobante;
                conn.prepare(`
                    INSERT INTO retenciones_emitidas (
                        id, company_id, tipo_impuesto, numero_comprobante, periodo_aaaamm, fecha_emision, fecha_documento,
                        movimiento_cxp_id, sujeto_rif, sujeto_nombre, tipo_persona, tipo_documento, numero_documento,
                        numero_control, monto_total_bs, monto_exento_bs, base_imponible_bs, codigo_concepto_islr,
                        porcentaje_retencion, sustraendo_bs, monto_retenido_bs, monto_retenido_usd, tasa_bcv, estatus, datos_json, estado_sync
                    ) VALUES (?, ?, 'ISLR', ?, ?, ?, ?, ?, ?, ?, ?, '01', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EMITIDO', ?, 0)
                `).run(
                    genId('RETISLR'), compId, compIslr, corrIslr.periodo_aaaamm, fecha, fecha,
                    docId, rif, provNombre, calcIslr.tipo_persona, comprobante || docId, d.numero_control || '',
                    montoBs, exentoBs, baseOperacionIslr, codIslr, pctIslr, sustraendoBs, islrRetBs,
                    fiscal.round2(islrRetBs / tasa), tasa, JSON.stringify(calcIslr)
                );
            }
        }

        const netoPagarBs = Math.max(0, fiscal.round2(montoBs - ivaRetBs - islrRetBs));
        const netoPagarUsd = fiscal.round2(netoPagarBs / tasa);
        const esContado = String(d.condicion || d.condicionPago || '').toUpperCase() === 'CONTADO' || String(d.estado || '').toUpperCase() === 'PAGADO';
        const estadoFinal = d.estado ? String(d.estado).toUpperCase() : (esContado ? 'PAGADO' : 'PENDIENTE');
        const montoAbonadoInit = estadoFinal === 'PAGADO' ? netoPagarUsd : fiscal.round2(d.monto_abonado || 0);
        const tipoTrans = String(d.tipo_transaccion || (tipoDoc === 'NOTA_CREDITO' ? '04-AJUSTE' : (tipoDoc === 'NOTA_DEBITO' ? '02-COMPLEMENTO' : '01-REGISTRO')));

        conn.prepare(`
            INSERT OR REPLACE INTO movimientos_cuentas_pagar (
                id, company_id, proveedor_id, proveedor_rif, monto, motivo, razon, nota, comprobante,
                estado, monto_abonado, metodo_pago, referencia, fecha, estado_sync, contenido_fac,
                numero_control, tipo_documento, tipo_transaccion, nota_credito_nro, nota_debito_nro,
                factura_afectada, es_gasto_operativo, categoria_gasto, es_importacion, planilla_importacion,
                expediente_importacion, tasa_bcv, monto_bs, monto_exento, base_imponible, alicuota_iva,
                monto_iva, iva_retenido, porcentaje_retencion, comprobante_retencion, fecha_retencion,
                fecha_vencimiento, dias_credito, moneda_origen, orden_compra_ref, islr_retenido_bs,
                porcentaje_islr, codigo_concepto_islr, sustraendo_islr_bs, comprobante_islr,
                neto_a_pagar_usd, neto_a_pagar_bs, forma80_json, aprobado_pago
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            docId, compId, d.proveedor_id || (provRow && provRow.id) || rif, rif, montoUsd, motivo, provNombre,
            d.nota || '', comprobante || docId, estadoFinal, montoAbonadoInit,
            d.metodo_pago || '', d.referencia || '', fecha, d.contenido_fac || '',
            d.numero_control || '', tipoDoc, tipoTrans, d.nota_credito_nro || '', d.nota_debito_nro || '',
            d.factura_afectada || '', Number(d.es_gasto_operativo || (tipoDoc === 'GASTO' ? 1 : 0)),
            d.categoria_gasto || '', Number(d.es_importacion || 0), d.planilla_importacion || '',
            d.expediente_importacion || '', tasa, montoBs, exentoBs, baseBs, alic, ivaBs,
            ivaRetBs, pctRetIva, compRetIva, fechaRet,
            fechaVenc, diasCred, String(d.moneda_origen || 'USD').toUpperCase(),
            d.orden_compra_ref || '', islrRetBs, pctIslr, codIslr, sustraendoBs, compIslr,
            netoPagarUsd, netoPagarBs,
            d.forma80_json || (forma80Resumen ? JSON.stringify(forma80Resumen) : ''),
            d.aprobado_pago !== undefined ? Number(d.aprobado_pago) : 1
        );

        recalcularSaldoProveedorDb(conn, compId, rif);
    });

    execTx();
    if (espejoConn && espejoConn !== conn) {
        try { guardarDocumentoCxpCompletoDb(espejoConn, { ...d, id: docId, auto_retener_iva: false, auto_retener_islr: false, permitir_duplicado: true }, null); } catch (_) {}
    }

    const saved = conn.prepare(`SELECT * FROM movimientos_cuentas_pagar WHERE id = ?`).get(docId);
    return { exito: true, id: docId, documento: saved };
}

function recalcularSaldoProveedorDb(conn, companyId, rif) {
    const rifClean = fiscal.normalizarRifSENIAT(rif, false);
    const docs = conn.prepare(`
        SELECT monto, neto_a_pagar_usd, monto_abonado, estado, tipo_documento, motivo
        FROM movimientos_cuentas_pagar
        WHERE company_id = ?
          AND REPLACE(UPPER(TRIM(COALESCE(proveedor_rif,''))), '-', '') = ?
          AND UPPER(COALESCE(motivo, '')) != 'PAGO'
          AND UPPER(COALESCE(estado, '')) NOT IN ('PAGADO', 'PAGADA', 'ANULADO')
    `).all(companyId, rifClean);

    let totalDeuda = 0;
    docs.forEach(r => {
        const up = String(r.tipo_documento || r.motivo || 'FACTURA').toUpperCase();
        if (up === 'NOTA_CREDITO' || up === 'DEVOLUCION_PROVEEDOR') return;
        const baseUsd = Number(r.neto_a_pagar_usd || 0) > 0 ? Number(r.neto_a_pagar_usd) : Number(r.monto || 0);
        const pend = Math.max(0, baseUsd - Number(r.monto_abonado || 0));
        totalDeuda = fiscal.round2(totalDeuda + pend);
    });

    try {
        conn.prepare(`
            UPDATE proveedores SET saldo_deuda = ?, estado_sync = 0
            WHERE REPLACE(UPPER(TRIM(COALESCE(rif,''))), '-', '') = ? AND (company_id = ? OR company_id IS NULL)
        `).run(totalDeuda, rifClean, companyId);
    } catch (_) {}
    return totalDeuda;
}

function emitirRetencionCxpIndependienteDb(conn, d = {}) {
    const compId = String(d.company_id || d.companyId || '').trim();
    if (!compId || !d.movimiento_cxp_id) throw new Error('company_id y movimiento_cxp_id son requeridos.');
    const doc = conn.prepare(`SELECT * FROM movimientos_cuentas_pagar WHERE id = ? AND company_id = ?`).get(d.movimiento_cxp_id, compId);
    if (!doc) throw new Error('Documento CxP no encontrado.');
    const params = obtenerParametrosFiscalesAvanzadosDb(conn, compId);
    const prov = conn.prepare(`SELECT * FROM proveedores WHERE REPLACE(UPPER(TRIM(COALESCE(rif,''))), '-', '') = ? LIMIT 1`).get(fiscal.normalizarRifSENIAT(doc.proveedor_rif, false));
    const tasa = Math.max(0.01, Number(d.tasa_bcv || doc.tasa_bcv || resolverTasaActivaDb(conn)));
    const fechaEmi = String(d.fecha_emision || fiscal.obtenerHoyCaracasISO()).slice(0, 10);
    const tipoImp = String(d.tipo_impuesto || 'IVA').toUpperCase() === 'ISLR' ? 'ISLR' : 'IVA';

    const execTx = conn.transaction(() => {
        const corr = fiscal.obtenerSiguienteComprobante14Db(conn, compId, tipoImp, fechaEmi);
        const retId = genId(`RET${tipoImp}`);

        if (tipoImp === 'IVA') {
            const calc = fiscal.calcularRetencionIvaVE({
                montoIvaBs: Number(d.monto_iva_bs !== undefined ? d.monto_iva_bs : doc.monto_iva),
                alicuotaIva: Number(doc.alicuota_iva || 16),
                tieneControl: Boolean(String(doc.numero_control || '').trim()),
                ivaDiscriminado: Number(doc.monto_iva || 0) > 0,
                proveedorPctDefault: Number(d.porcentaje_retencion !== undefined ? d.porcentaje_retencion : (prov?.porcentaje_retencion_iva ?? 75)),
                proveedorEnRif: d.proveedor_en_rif !== false,
                porcentajeForzado: d.porcentaje_retencion !== undefined ? Number(d.porcentaje_retencion) : null
            });

            const retUsd = fiscal.round2(calc.monto_retenido_bs / tasa);
            conn.prepare(`
                INSERT INTO retenciones_emitidas (
                    id, company_id, tipo_impuesto, numero_comprobante, periodo_aaaamm, fecha_emision, fecha_documento,
                    movimiento_cxp_id, sujeto_rif, sujeto_nombre, tipo_persona, tipo_documento, numero_documento,
                    numero_control, documento_afectado, expediente_importacion, monto_total_bs, monto_exento_bs,
                    base_imponible_bs, alicuota_iva, impuesto_causado_bs, porcentaje_retencion, monto_retenido_bs,
                    monto_retenido_usd, tasa_bcv, estatus, datos_json, estado_sync
                ) VALUES (?, ?, 'IVA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EMITIDO', ?, 0)
            `).run(
                retId, compId, corr.numero_comprobante, corr.periodo_aaaamm, fechaEmi, String(doc.fecha || '').slice(0, 10),
                doc.id, doc.proveedor_rif, doc.razon || (prov && prov.nombre) || doc.proveedor_rif,
                fiscal.clasificarPersonaPorRif(doc.proveedor_rif, prov && prov.tipo_contribuyente),
                doc.tipo_documento === 'NOTA_DEBITO' ? '02' : (doc.tipo_documento === 'NOTA_CREDITO' ? '03' : '01'),
                doc.comprobante || doc.id, doc.numero_control || '', doc.factura_afectada || '0', doc.expediente_importacion || '0',
                Number(doc.monto_bs || 0), Number(doc.monto_exento || 0), Number(doc.base_imponible || 0),
                Number(doc.alicuota_iva || 16), Number(doc.monto_iva || 0), calc.porcentaje_retencion,
                calc.monto_retenido_bs, retUsd, tasa, JSON.stringify(calc)
            );

            const nuevoNetoBs = Math.max(0, fiscal.round2(Number(doc.monto_bs || 0) - calc.monto_retenido_bs - Number(doc.islr_retenido_bs || 0)));
            const nuevoNetoUsd = fiscal.round2(nuevoNetoBs / tasa);
            conn.prepare(`
                UPDATE movimientos_cuentas_pagar
                SET iva_retenido = ?, porcentaje_retencion = ?, comprobante_retencion = ?, fecha_retencion = ?,
                    neto_a_pagar_bs = ?, neto_a_pagar_usd = ?, estado_sync = 0
                WHERE id = ?
            `).run(calc.monto_retenido_bs, calc.porcentaje_retencion, corr.numero_comprobante, fechaEmi, nuevoNetoBs, nuevoNetoUsd, doc.id);

            recalcularSaldoProveedorDb(conn, compId, doc.proveedor_rif);
            return { exito: true, id: retId, numero_comprobante: corr.numero_comprobante, calculo: calc };
        }

        const baseOp = Number(d.base_imponible_bs !== undefined ? d.base_imponible_bs : (Number(doc.base_imponible || 0) > 0 ? doc.base_imponible : doc.monto_bs));
        const calcIslr = fiscal.calcularRetencionIslrDecreto1808({
            baseImponibleBs: baseOp,
            rifRetenido: doc.proveedor_rif,
            tipoPersona: d.tipo_persona || (prov && prov.tipo_contribuyente === 'PNR' ? 'PNR' : ''),
            codigoConcepto: d.codigo_concepto_islr || (prov && prov.codigo_islr_default) || '053',
            porcentajeManual: d.porcentaje_retencion !== undefined && d.porcentaje_retencion !== '' ? Number(d.porcentaje_retencion) : null,
            utBs: params.unidad_tributaria_bs
        });
        const retUsd = fiscal.round2(calcIslr.monto_retenido_bs / tasa);

        conn.prepare(`
            INSERT INTO retenciones_emitidas (
                id, company_id, tipo_impuesto, numero_comprobante, periodo_aaaamm, fecha_emision, fecha_documento,
                movimiento_cxp_id, sujeto_rif, sujeto_nombre, tipo_persona, tipo_documento, numero_documento,
                numero_control, monto_total_bs, monto_exento_bs, base_imponible_bs, codigo_concepto_islr,
                porcentaje_retencion, sustraendo_bs, monto_retenido_bs, monto_retenido_usd, tasa_bcv, estatus, datos_json, estado_sync
            ) VALUES (?, ?, 'ISLR', ?, ?, ?, ?, ?, ?, ?, ?, '01', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EMITIDO', ?, 0)
        `).run(
            retId, compId, corr.numero_comprobante, corr.periodo_aaaamm, fechaEmi, String(doc.fecha || '').slice(0, 10),
            doc.id, doc.proveedor_rif, doc.razon || (prov && prov.nombre) || doc.proveedor_rif,
            calcIslr.tipo_persona, doc.comprobante || doc.id, doc.numero_control || '',
            Number(doc.monto_bs || 0), Number(doc.monto_exento || 0), calcIslr.base_imponible_bs,
            calcIslr.codigo_concepto, calcIslr.porcentaje_retencion, calcIslr.sustraendo_bs,
            calcIslr.monto_retenido_bs, retUsd, tasa, JSON.stringify(calcIslr)
        );

        const nuevoNetoBs = Math.max(0, fiscal.round2(Number(doc.monto_bs || 0) - Number(doc.iva_retenido || 0) - calcIslr.monto_retenido_bs));
        const nuevoNetoUsd = fiscal.round2(nuevoNetoBs / tasa);
        conn.prepare(`
            UPDATE movimientos_cuentas_pagar
            SET islr_retenido_bs = ?, porcentaje_islr = ?, codigo_concepto_islr = ?, sustraendo_islr_bs = ?, comprobante_islr = ?,
                neto_a_pagar_bs = ?, neto_a_pagar_usd = ?, estado_sync = 0
            WHERE id = ?
        `).run(
            calcIslr.monto_retenido_bs, calcIslr.porcentaje_retencion, calcIslr.codigo_concepto,
            calcIslr.sustraendo_bs, corr.numero_comprobante, nuevoNetoBs, nuevoNetoUsd, doc.id
        );

        recalcularSaldoProveedorDb(conn, compId, doc.proveedor_rif);
        return { exito: true, id: retId, numero_comprobante: corr.numero_comprobante, calculo: calcIslr };
    });

    return execTx();
}

function registrarPagoCxpAvanzadoDb(conn, d = {}, espejoConn = null) {
    const compId = String(d.company_id || d.companyId || '').trim();
    if (!compId || !d.proveedor_rif) throw new Error('company_id y proveedor_rif son requeridos.');
    const rifClean = fiscal.normalizarRifSENIAT(d.proveedor_rif, false);
    const tasa = Math.max(0.01, Number(d.tasa_bcv || resolverTasaActivaDb(conn)));
    const fechaOp = String(d.fecha || fiscal.obtenerHoyCaracasISO()).slice(0, 10);
    const params = obtenerParametrosFiscalesAvanzadosDb(conn, compId);

    const execTx = conn.transaction(() => {
        let abiertas = conn.prepare(`
            SELECT * FROM movimientos_cuentas_pagar
            WHERE company_id = ?
              AND REPLACE(UPPER(TRIM(COALESCE(proveedor_rif,''))), '-', '') = ?
              AND UPPER(COALESCE(motivo, '')) != 'PAGO'
              AND UPPER(COALESCE(tipo_documento, 'FACTURA')) NOT IN ('NOTA_CREDITO')
              AND UPPER(COALESCE(estado, '')) NOT IN ('PAGADO', 'PAGADA', 'ANULADO')
            ORDER BY fecha ASC, id ASC
        `).all(compId, rifClean);

        if (d.movimiento_id) {
            const idx = abiertas.findIndex(r => String(r.id) === String(d.movimiento_id));
            if (idx > 0) {
                const target = abiertas.splice(idx, 1)[0];
                abiertas.unshift(target);
            }
        }

        const consumoFavor = Number(d.usar_saldo_a_favor_usd || 0) > 0
            ? consumirSaldoAFavorInternoDb(conn, {
                companyId: compId,
                modulo: 'CXP',
                terceroRif: d.proveedor_rif,
                montoSolicitadoUsd: Number(d.usar_saldo_a_favor_usd),
                tasaCruce: tasa
            })
            : { aplicado_usd: 0, aplicado_bs: 0 };

        let montoPagoUsd = fiscal.round2(Number(d.monto_usd || d.monto || 0) + Number(d.descuento_pronto_pago_usd || 0) + consumoFavor.aplicado_usd);
        const pagoBsRaw = Number(d.monto_bs || 0);
        if (Number(d.monto_usd || d.monto || 0) <= 0 && pagoBsRaw > 0) {
            montoPagoUsd = fiscal.round2((pagoBsRaw / tasa) + Number(d.descuento_pronto_pago_usd || 0) + consumoFavor.aplicado_usd);
        }
        if (montoPagoUsd <= 0) throw new Error('El monto del pago debe ser mayor a cero.');

        let restantePorAplicar = montoPagoUsd;
        let diferencialTotalBs = 0;
        const ndEnTransito = [];

        for (const doc of abiertas) {
            if (restantePorAplicar <= 0.005) break;
            const totalNetoDoc = Number(doc.neto_a_pagar_usd || 0) > 0 ? Number(doc.neto_a_pagar_usd) : Number(doc.monto || 0);
            const pagadoPrev = Number(doc.monto_abonado || 0);
            const saldoDoc = fiscal.round2(Math.max(0, totalNetoDoc - pagadoPrev));
            if (saldoDoc <= 0.005) continue;

            const abonoDoc = Math.min(saldoDoc, restantePorAplicar);
            const nuevoAbonado = fiscal.round2(pagadoPrev + abonoDoc);
            const pagada = nuevoAbonado >= (totalNetoDoc - 0.01);

            conn.prepare(`
                UPDATE movimientos_cuentas_pagar
                SET monto_abonado = ?, estado = ?, estado_sync = 0
                WHERE id = ?
            `).run(nuevoAbonado, pagada ? 'PAGADO' : 'ABONADO', doc.id);

            const tOrig = Math.max(0.01, Number(doc.tasa_bcv || tasa));
            const evalDiff = fiscal.evaluarAsimetriaDiferencialCambiario({
                modulo: 'CXP',
                modoFiscalEmpresa: params.modo_ajuste_cambiario,
                montoUsdAmortizado: abonoDoc,
                tasaOriginal: tOrig,
                tasaLiquidacion: tasa,
                alicuotaIva: Number(doc.alicuota_iva || 16),
                esOperacionGravada: Number(doc.monto_iva || 0) > 0
            });

            if (Math.abs(evalDiff.variacion_bruta_bs) >= 0.01) {
                diferencialTotalBs = fiscal.round2(diferencialTotalBs + evalDiff.variacion_bruta_bs);
                const adjId = genId('AJP');
                const estadoAdj = evalDiff.enviar_a_nd_en_transito_cxp ? 'PENDIENTE_ND_PROVEEDOR' : 'REGISTRADO';
                conn.prepare(`
                    INSERT INTO notas_ajuste_cambiario (
                        id, company_id, modulo, tipo_ajuste, estado, tercero_rif, tercero_nombre,
                        documento_origen_id, documento_origen_nro, fecha_operacion, tasa_original,
                        tasa_liquidacion, monto_usd_base, variacion_bruta_bs, base_imponible_nd_bs,
                        iva_nd_bs, alicuota_iva, regimen_aplicado, nota, estado_sync
                    ) VALUES (?, ?, 'CXP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VEN_NIF_ISLR', ?, 0)
                `).run(
                    adjId, compId,
                    evalDiff.enviar_a_nd_en_transito_cxp ? 'ND_EN_TRANSITO_CXP' : 'DIFERENCIAL_REALIZADO_CXP',
                    estadoAdj, doc.proveedor_rif, doc.razon || doc.proveedor_rif,
                    doc.id, doc.comprobante || doc.id, fechaOp, tOrig, tasa, abonoDoc,
                    evalDiff.variacion_bruta_bs, evalDiff.base_imponible_nd_bs, evalDiff.iva_nd_bs,
                    Number(doc.alicuota_iva || 16),
                    `Pago CxP doc ${doc.comprobante || doc.id} - Diferencial realizado ISLR (sin crédito fiscal hasta ND)`
                );
                if (evalDiff.enviar_a_nd_en_transito_cxp) {
                    ndEnTransito.push({ id: adjId, comprobante: doc.comprobante, iva_potencial_bs: evalDiff.iva_nd_bs });
                }
            }

            restantePorAplicar = fiscal.round2(restantePorAplicar - abonoDoc);
        }

        const pagoId = d.id || genId('PGP');
        const efectivoPagoUsd = fiscal.round2(montoPagoUsd - restantePorAplicar);
        const montoBsPago = pagoBsRaw > 0 ? pagoBsRaw : fiscal.round2(efectivoPagoUsd * tasa);

        conn.prepare(`
            INSERT INTO movimientos_cuentas_pagar (
                id, company_id, proveedor_id, proveedor_rif, monto, monto_bs, tasa_bcv,
                motivo, razon, nota, comprobante, estado, monto_abonado, metodo_pago, referencia,
                igtf_bs, fecha, estado_sync
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PAGO', ?, ?, ?, 'PAGADO', ?, ?, ?, ?, ?, 0)
        `).run(
            pagoId, compId, d.proveedor_id || d.proveedor_rif, d.proveedor_rif,
            efectivoPagoUsd, montoBsPago, tasa, d.razon || d.proveedor_nombre || d.proveedor_rif,
            d.nota || `Pago aplicado (${d.metodo_pago || 'EFECTIVO'})`,
            d.comprobante_doc_afectado || d.referencia || 'ABONO',
            efectivoPagoUsd, d.metodo_pago || 'EFECTIVO', d.referencia || '',
            fiscal.round2(d.igtf_bs || 0), fechaOp
        );

        let saldoFavorGenerado = 0;
        if (restantePorAplicar > 0.01) {
            saldoFavorGenerado = restantePorAplicar;
            registrarAnticipoOSaldoFavorDb(conn, {
                company_id: compId,
                modulo: 'CXP',
                tercero_rif: d.proveedor_rif,
                tercero_nombre: d.razon || d.proveedor_nombre || '',
                tipo_registro: 'SALDO_FAVOR',
                modalidad_contrato: 'INDEXADO_USD',
                fecha: fechaOp,
                tasa_bcv: tasa,
                monto_usd: saldoFavorGenerado,
                monto_bs: fiscal.round2(saldoFavorGenerado * tasa),
                metodo_pago: d.metodo_pago || 'EFECTIVO',
                referencia: d.referencia || '',
                documento_origen: pagoId,
                nota: `Sobrepago en egreso CxP ${pagoId}`,
                afectar_tesoreria: false
            });
        }

        const desembolsoRealUsd = Math.max(0, fiscal.round2(Number(d.monto_usd || d.monto || 0)));
        if (d.registrar_en_tesoreria !== false && (desembolsoRealUsd > 0 || pagoBsRaw > 0)) {
            const esDivisa = String(d.moneda_pago || '').toUpperCase() === 'USD' || /USD|ZELLE|BINANCE/i.test(String(d.metodo_pago || ''));
            registrarMovimientoTesoreriaInternoDb(conn, {
                companyId: compId,
                cuentaId: d.cuenta_tesoreria_id || null,
                moduloOrigen: 'CXP_PAGO',
                referenciaOrigenId: pagoId,
                terceroRif: d.proveedor_rif,
                terceroNombre: d.razon || d.proveedor_nombre || '',
                tipo: 'EGRESO',
                moneda: esDivisa ? 'USD' : 'BS',
                monto: esDivisa ? desembolsoRealUsd : (pagoBsRaw > 0 ? pagoBsRaw : fiscal.round2(desembolsoRealUsd * tasa)),
                tasaBcv: tasa,
                metodoPago: d.metodo_pago || 'TRANSFERENCIA',
                referenciaBancaria: d.referencia || '',
                fecha: fechaOp,
                concepto: `Pago CxP a ${d.razon || d.proveedor_nombre || d.proveedor_rif}`,
                usuario: d.usuario || ''
            });
        }

        const nuevoSaldo = recalcularSaldoProveedorDb(conn, compId, d.proveedor_rif);
        return {
            exito: true,
            pago_id: pagoId,
            aplicado_usd: efectivoPagoUsd,
            diferencial_realizado_bs: diferencialTotalBs,
            nd_en_transito: ndEnTransito,
            saldo_a_favor_generado_usd: saldoFavorGenerado,
            saldo_pendiente_proveedor_usd: nuevoSaldo
        };
    });

    const resultado = execTx();
    if (espejoConn && espejoConn !== conn) {
        try { registrarPagoCxpAvanzadoDb(espejoConn, { ...d, id: resultado.pago_id }, null); } catch (_) {}
    }
    return resultado;
}

function resolverNdTransitoCxpDb(conn, { companyId, ajusteId, numeroNdProveedor, numeroControlNd, fechaNd }) {
    const adj = conn.prepare(`SELECT * FROM notas_ajuste_cambiario WHERE id = ? AND company_id = ?`).get(ajusteId, companyId);
    if (!adj) throw new Error('Registro de N/D en tránsito no encontrado.');
    if (adj.estado === 'RESUELTA_LIBRO_COMPRAS') throw new Error('Esta Nota de Débito en tránsito ya fue aplicada al Libro de Compras.');
    const ndNro = String(numeroNdProveedor || '').trim();
    const ctrl = String(numeroControlNd || '').trim();
    if (!ndNro || !ctrl) throw new Error('Debe ingresar el N° de Nota de Débito y N° de Control del proveedor.');

    const dup = verificarDuplicadoDocumentoCxpDb(conn, {
        companyId,
        proveedorRif: adj.tercero_rif,
        tipoDocumento: 'NOTA_DEBITO',
        comprobante: ndNro
    });
    if (dup.duplicado) throw new Error(`Ya existe registrada una Nota de Débito #${ndNro} para este proveedor.`);

    const movId = genId('NDLC');
    const tasa = Math.max(0.01, Number(adj.tasa_liquidacion || 1));
    const totalBs = fiscal.round2(adj.variacion_bruta_bs);
    const baseBs = fiscal.round2(adj.base_imponible_nd_bs);
    const ivaBs = fiscal.round2(adj.iva_nd_bs);
    const fechaFinal = String(fechaNd || adj.fecha_operacion || fiscal.obtenerHoyCaracasISO()).slice(0, 10);

    const tx = conn.transaction(() => {
        conn.prepare(`
            INSERT INTO movimientos_cuentas_pagar (
                id, company_id, proveedor_id, proveedor_rif, monto, motivo, razon, nota, comprobante,
                estado, monto_abonado, fecha, estado_sync, numero_control, tipo_documento, tipo_transaccion,
                nota_debito_nro, factura_afectada, tasa_bcv, monto_bs, monto_exento, base_imponible,
                alicuota_iva, monto_iva, neto_a_pagar_usd, neto_a_pagar_bs
            ) VALUES (?, ?, ?, ?, ?, 'NOTA_DEBITO', ?, ?, ?, 'PAGADO', ?, ?, 0, ?, 'NOTA_DEBITO', '02-COMPLEMENTO', ?, ?, ?, ?, 0, ?, ?, ?, 0, 0)
        `).run(
            movId, companyId, adj.tercero_rif, adj.tercero_rif,
            fiscal.round2(totalBs / tasa), adj.tercero_nombre || adj.tercero_rif,
            `N/D Proveedor por Diferencial Cambiario (Factura ${adj.documento_origen_nro})`,
            ndNro, fiscal.round2(totalBs / tasa), fechaFinal, ctrl, ndNro, adj.documento_origen_nro || '',
            tasa, totalBs, baseBs, Number(adj.alicuota_iva || 16), ivaBs
        );

        conn.prepare(`
            UPDATE notas_ajuste_cambiario
            SET estado = 'RESUELTA_LIBRO_COMPRAS', numero_nd_fiscal = ?, numero_control_nd = ?, movimiento_cxp_generado_id = ?, estado_sync = 0
            WHERE id = ?
        `).run(ndNro, ctrl, movId, ajusteId);
    });

    tx();
    return { exito: true, movimiento_cxp_id: movId, credito_fiscal_activado_bs: ivaBs };
}

function registrarCasheaVentaCxcDb(conn, d = {}) {
    const compId = String(d.company_id || d.companyId || '').trim();
    if (!compId || !d.cliente_id) throw new Error('company_id y cliente_id son requeridos para Cashea.');
    const params = obtenerParametrosFiscalesAvanzadosDb(conn, compId);
    const tasa = Math.max(0.01, Number(d.tasa_bcv || resolverTasaActivaDb(conn)));
    const fecha = String(d.fecha || fiscal.obtenerHoyCaracasISO()).slice(0, 10);

    const part = fiscal.calcularParticionCashea({
        montoTotalUsd: Number(d.monto_total_usd || 0),
        montoInicialUsd: Number(d.monto_inicial_usd || 0),
        comisionPct: Number(d.comision_pct !== undefined ? d.comision_pct : params.comision_cashea_default_pct),
        tasaBcv: tasa
    });
    if (part.saldo_cxc_cashea_usd <= 0) throw new Error('El saldo financiado por Cashea debe ser mayor a $0.');

    const diasCred = parseInt(d.dias_liquidacion || 14, 10);
    const venc = fiscal.calcularAgingDocumento({ fechaEmision: fecha, diasCredito: diasCred }).fecha_vencimiento;
    const facNro = String(d.factura_nro || `CASHEA-${Date.now()}`).trim();
    const refId = genId('CSH');

    const tx = conn.transaction(() => {
        conn.prepare(`
            INSERT INTO cuentas_por_cobrar (
                company_id, branch_id, cliente_id, cliente_rif, rif_cliente, cliente_nombre,
                monto_bs, monto_usd, tasa_emision, monto, factura_nro, monto_pagado, fecha,
                fecha_vencimiento, dias_credito, estado, concepto, referencia,
                es_cashea, cashea_inicial_usd, cashea_comision_usd, cashea_estado, estado_sync
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'PENDIENTE', ?, ?, 1, ?, ?, 'POR_LIQUIDAR_CASHEA', 0)
        `).run(
            compId, d.branch_id || 'PRINCIPAL', d.cliente_id, d.cliente_id, d.cliente_id,
            d.cliente_nombre || '', part.saldo_cxc_cashea_bs, part.saldo_cxc_cashea_usd, tasa,
            part.saldo_cxc_cashea_bs, facNro, fecha, venc, diasCred,
            `Cashea BNPL Factura ${facNro} (Inicial cobrada $${part.inicial_cliente_usd.toFixed(2)}, Comision $${part.comision_cashea_usd.toFixed(2)})`,
            refId, part.inicial_cliente_usd, part.comision_cashea_usd
        );

        if (part.inicial_cliente_usd > 0 && d.registrar_inicial_tesoreria !== false) {
            registrarMovimientoTesoreriaInternoDb(conn, {
                companyId: compId,
                moduloOrigen: 'CASHEA_INICIAL',
                referenciaOrigenId: refId,
                terceroRif: d.cliente_id,
                terceroNombre: d.cliente_nombre || '',
                tipo: 'INGRESO',
                moneda: 'USD',
                monto: part.inicial_cliente_usd,
                tasaBcv: tasa,
                metodoPago: 'CASHEA_INICIAL',
                fecha,
                concepto: `Inicial Cashea Factura ${facNro}`,
                usuario: d.usuario || ''
            });
        }
    });

    tx();
    return { exito: true, referencia: refId, particion: part };
}

function registrarGiroOChequeDevueltoCxcDb(conn, d = {}) {
    const compId = String(d.company_id || d.companyId || '').trim();
    if (!compId) throw new Error('company_id requerido.');
    const accion = String(d.accion || 'CREAR').toUpperCase();
    const tasa = Math.max(0.01, Number(d.tasa_bcv || resolverTasaActivaDb(conn)));
    const fechaHoy = fiscal.obtenerHoyCaracasISO();

    if (accion === 'CREAR') {
        if (!d.cliente_rif || !d.numero_instrumento || Number(d.monto_usd || 0) <= 0) {
            throw new Error('cliente_rif, numero_instrumento y monto_usd > 0 son obligatorios.');
        }
        const id = genId('GIR');
        const mUsd = fiscal.round2(d.monto_usd);
        const mBs = fiscal.round2(d.monto_bs || (mUsd * tasa));
        conn.prepare(`
            INSERT INTO giros_cheques_cxc (
                id, company_id, cliente_rif, cliente_nombre, cuenta_cxc_id, factura_nro,
                tipo_instrumento, numero_instrumento, banco_emisor, fecha_recepcion, fecha_vencimiento,
                monto_usd, monto_bs, tasa_bcv, estado, observacion, estado_sync
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EN_CARTERA', ?, 0)
        `).run(
            id, compId, d.cliente_rif, d.cliente_nombre || '', d.cuenta_cxc_id || null,
            d.factura_nro || '', d.tipo_instrumento || 'CHEQUE', d.numero_instrumento,
            d.banco_emisor || '', d.fecha_recepcion || fechaHoy, d.fecha_vencimiento || fechaHoy,
            mUsd, mBs, tasa, d.observacion || ''
        );
        return { exito: true, id };
    }

    const giro = conn.prepare(`SELECT * FROM giros_cheques_cxc WHERE id = ? AND company_id = ?`).get(d.id, compId);
    if (!giro) throw new Error('Giro/Cheque no encontrado.');

    if (accion === 'COBRAR') {
        const resCobro = registrarAbonoCxcAvanzadoDb(conn, {
            company_id: compId,
            cliente_id: giro.cliente_rif,
            cliente_nombre: giro.cliente_nombre,
            cuenta_id: giro.cuenta_cxc_id,
            factura_nro: giro.factura_nro,
            monto_divisas_usd: giro.monto_usd,
            tasa_bcv: tasa,
            metodo_pago: `${giro.tipo_instrumento}_${giro.banco_emisor || 'BANCO'}`,
            referencia: giro.numero_instrumento,
            nota: `Liquidación de ${giro.tipo_instrumento} #${giro.numero_instrumento}`,
            aplicar_igtf: false
        });
        conn.prepare(`UPDATE giros_cheques_cxc SET estado = 'COBRADO', estado_sync = 0 WHERE id = ?`).run(giro.id);
        return { exito: true, giro_estado: 'COBRADO', cobro: resCobro };
    }

    if (accion === 'DEVUELTO') {
        if (giro.estado === 'DEVUELTO') throw new Error('Este instrumento ya fue marcado como devuelto.');
        const comisionUsd = Math.max(0, fiscal.round2(d.comision_devolucion_usd || 0));
        const tx = conn.transaction(() => {
            conn.prepare(`
                UPDATE giros_cheques_cxc
                SET estado = 'DEVUELTO', comision_devolucion_usd = ?, observacion = ?, estado_sync = 0
                WHERE id = ?
            `).run(comisionUsd, d.observacion || 'Cheque/Giro devuelto por banco - Cargo de reposición y comisión generado', giro.id);

            const recargoTotalUsd = fiscal.round2(Number(giro.monto_usd || 0) + comisionUsd);
            const recargoBs = fiscal.round2(recargoTotalUsd * tasa);
            const ndRef = `DEV-${giro.numero_instrumento}`;
            conn.prepare(`
                INSERT INTO cuentas_por_cobrar (
                    company_id, branch_id, cliente_id, cliente_rif, rif_cliente, cliente_nombre,
                    monto_bs, monto_usd, tasa_emision, monto, factura_nro, monto_pagado, fecha,
                    fecha_vencimiento, dias_credito, estado, concepto, tipo_movimiento, referencia,
                    es_giro, giro_nro, estado_sync
                ) VALUES (?, 'PRINCIPAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, 'PENDIENTE', ?, 'NOTA_DEBITO_DEVOLUCION', ?, 1, ?, 0)
            `).run(
                compId, giro.cliente_rif, giro.cliente_rif, giro.cliente_rif, giro.cliente_nombre || '',
                recargoBs, recargoTotalUsd, tasa, recargoBs, ndRef, fechaHoy, fechaHoy,
                `Reversión ${giro.tipo_instrumento} devuelto #${giro.numero_instrumento} (Capital $${giro.monto_usd} + Comisión $${comisionUsd})`,
                genId('NDDEV'), giro.numero_instrumento
            );
        });
        tx();
        return { exito: true, giro_estado: 'DEVUELTO', cargo_reabierto_usd: fiscal.round2(Number(giro.monto_usd || 0) + comisionUsd) };
    }

    throw new Error('Acción no válida para giro/cheque.');
}

function ejecutarCierreCambiarioMensualDb(conn, { companyId, modulo = 'CXC', periodoAAAAMM, tasaCierreBcv, usuario = '' }) {
    const compId = String(companyId || '').trim();
    const modUp = String(modulo || 'CXC').toUpperCase() === 'CXP' ? 'CXP' : 'CXC';
    const perClean = String(periodoAAAAMM || fiscal.obtenerHoyCaracasISO().slice(0, 7)).replace(/[^0-9]/g, '').slice(0, 6);
    const tasaCierre = Math.max(0.01, Number(tasaCierreBcv || resolverTasaActivaDb(conn)));

    let saldoAbiertoUsd = 0;
    let costoHistoricoBs = 0;
    let detalleDocs = [];

    if (modUp === 'CXC') {
        const rows = conn.prepare(`
            SELECT id, factura_nro, cliente_nombre, monto_usd, monto_bs, monto_pagado, tasa_emision
            FROM cuentas_por_cobrar
            WHERE (company_id = ? OR company_id IS NULL OR company_id = '')
              AND UPPER(TRIM(COALESCE(estado,''))) NOT IN ('PAGADA','PAGADO','ANULADA')
        `).all(compId);
        rows.forEach(r => {
            const tOrig = Math.max(0.01, Number(r.tasa_emision || tasaCierre));
            const origUsd = Number(r.monto_usd || 0) > 0 ? Number(r.monto_usd) : fiscal.round2(Number(r.monto_bs || 0) / tOrig);
            const saldo = fiscal.round2(Math.max(0, origUsd - Number(r.monto_pagado || 0)));
            if (saldo <= 0.01) return;
            const histBs = fiscal.round2(saldo * tOrig);
            const reexpBs = fiscal.round2(saldo * tasaCierre);
            saldoAbiertoUsd = fiscal.round2(saldoAbiertoUsd + saldo);
            costoHistoricoBs = fiscal.round2(costoHistoricoBs + histBs);
            detalleDocs.push({ doc: r.factura_nro || r.id, tercero: r.cliente_nombre, saldo_usd: saldo, tasa_orig: tOrig, diff_no_realizado_bs: fiscal.round2(reexpBs - histBs) });
        });
    } else {
        const rows = conn.prepare(`
            SELECT id, comprobante, razon, proveedor_rif, monto, neto_a_pagar_usd, monto_abonado, tasa_bcv
            FROM movimientos_cuentas_pagar
            WHERE company_id = ?
              AND UPPER(COALESCE(motivo,'')) != 'PAGO'
              AND UPPER(COALESCE(tipo_documento,'FACTURA')) != 'NOTA_CREDITO'
              AND UPPER(COALESCE(estado,'')) NOT IN ('PAGADO','PAGADA','ANULADO')
        `).all(compId);
        rows.forEach(r => {
            const tOrig = Math.max(0.01, Number(r.tasa_bcv || tasaCierre));
            const origUsd = Number(r.neto_a_pagar_usd || 0) > 0 ? Number(r.neto_a_pagar_usd) : Number(r.monto || 0);
            const saldo = fiscal.round2(Math.max(0, origUsd - Number(r.monto_abonado || 0)));
            if (saldo <= 0.01) return;
            const histBs = fiscal.round2(saldo * tOrig);
            const reexpBs = fiscal.round2(saldo * tasaCierre);
            saldoAbiertoUsd = fiscal.round2(saldoAbiertoUsd + saldo);
            costoHistoricoBs = fiscal.round2(costoHistoricoBs + histBs);
            detalleDocs.push({ doc: r.comprobante || r.id, tercero: r.razon || r.proveedor_rif, saldo_usd: saldo, tasa_orig: tOrig, diff_no_realizado_bs: fiscal.round2(reexpBs - histBs) });
        });
    }

    const valorReexpresadoBs = fiscal.round2(saldoAbiertoUsd * tasaCierre);
    const noRealizadoBs = fiscal.round2(valorReexpresadoBs - costoHistoricoBs);

    let realizadoMesBs = 0;
    try {
        const prefix = `${perClean.slice(0, 4)}-${perClean.slice(4, 6)}`;
        const rMes = conn.prepare(`
            SELECT COALESCE(SUM(variacion_bruta_bs), 0) AS total
            FROM notas_ajuste_cambiario
            WHERE company_id = ? AND modulo = ? AND substr(fecha_operacion, 1, 7) = ?
        `).get(compId, modUp, prefix);
        realizadoMesBs = fiscal.round2((rMes && rMes.total) || 0);
    } catch (_) {}

    const id = genId('CIECAM');
    const fechaHoy = fiscal.obtenerHoyCaracasISO();
    conn.prepare(`
        INSERT INTO cierres_cambiarios_mensuales (
            id, company_id, modulo, periodo_aaaamm, fecha_cierre, tasa_cierre_bcv,
            saldo_abierto_usd, costo_historico_bs, valor_reexpresado_bs,
            diferencial_no_realizado_bs, diferencial_realizado_mes_bs, estado, detalle_json, usuario, estado_sync
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VIGENTE', ?, ?, 0)
    `).run(
        id, compId, modUp, perClean, fechaHoy, tasaCierre,
        saldoAbiertoUsd, costoHistoricoBs, valorReexpresadoBs,
        noRealizadoBs, realizadoMesBs, JSON.stringify(detalleDocs), usuario
    );

    return {
        exito: true,
        id,
        modulo: modUp,
        periodo_aaaamm: perClean,
        tasa_cierre_bcv: tasaCierre,
        saldo_abierto_usd: saldoAbiertoUsd,
        costo_historico_bs: costoHistoricoBs,
        valor_reexpresado_bs: valorReexpresadoBs,
        diferencial_no_realizado_bs: noRealizadoBs,
        diferencial_realizado_mes_bs: realizadoMesBs,
        documentos: detalleDocs.length
    };
}

function revertirCierreCambiarioDiaUnoDb(conn, { companyId, cierreId, fechaReverso = '' }) {
    const c = conn.prepare(`SELECT * FROM cierres_cambiarios_mensuales WHERE id = ? AND company_id = ?`).get(cierreId, companyId);
    if (!c) throw new Error('Cierre cambiario no encontrado.');
    if (c.estado === 'REVERTIDO') throw new Error('Este cierre ya fue revertido.');
    const fRev = String(fechaReverso || fiscal.obtenerHoyCaracasISO()).slice(0, 10);
    conn.prepare(`
        UPDATE cierres_cambiarios_mensuales SET estado = 'REVERTIDO', fecha_reverso = ?, estado_sync = 0 WHERE id = ?
    `).run(fRev, cierreId);
    return { exito: true, id: cierreId, fecha_reverso: fRev };
}

function obtenerDocumentosAvanzadosCxpDb(conn, { companyId, incluirPagados = true }) {
    const tasaHoy = resolverTasaActivaDb(conn);
    const fechaCorte = fiscal.obtenerHoyCaracasISO();

    // Evita el antiguo bug LIMIT 100 cargando todos los documentos abiertos + historial reciente ordenado
    const docs = conn.prepare(`
        SELECT m.*, p.nombre AS prov_nombre, p.tipo_contribuyente AS prov_tipo_contribuyente,
               p.porcentaje_retencion_iva AS prov_pct_ret_default, p.banco_nombre AS prov_banco,
               p.cuenta_bancaria AS prov_cuenta_bancaria, p.rif_titular_cuenta AS prov_rif_titular,
               p.dias_credito_default AS prov_dias_credito, p.saldo_a_favor_usd AS prov_saldo_favor_usd
        FROM movimientos_cuentas_pagar m
        LEFT JOIN proveedores p ON REPLACE(UPPER(TRIM(m.proveedor_rif)), '-', '') = REPLACE(UPPER(TRIM(p.rif)), '-', '')
          AND (p.company_id = m.company_id OR p.company_id IS NULL)
        WHERE m.company_id = ?
          AND (? = 1 OR UPPER(COALESCE(m.estado,'')) NOT IN ('PAGADO', 'PAGADA'))
        ORDER BY
          CASE WHEN UPPER(COALESCE(m.motivo,'')) != 'PAGO' AND UPPER(COALESCE(m.estado,'')) NOT IN ('PAGADO','PAGADA') THEN 0 ELSE 1 END ASC,
          m.fecha DESC, m.rowid DESC
    `).all(companyId, incluirPagados ? 1 : 0);

    const agingTotales = { POR_VENCER: 0, '0_30': 0, '31_60': 0, '61_90': 0, MAS_90: 0 };
    let totalDeudaNetaUsd = 0;

    const enriquecidos = docs.map(d => {
        const esPago = String(d.motivo || '').toUpperCase() === 'PAGO';
        const esNC = String(d.tipo_documento || '').toUpperCase() === 'NOTA_CREDITO' || String(d.motivo || '').toUpperCase() === 'DEVOLUCION_PROVEEDOR';
        const tasaDoc = Math.max(0.01, Number(d.tasa_bcv || tasaHoy));
        const netoOrigUsd = Number(d.neto_a_pagar_usd || 0) > 0
            ? Number(d.neto_a_pagar_usd)
            : (Number(d.monto || 0) > 0 ? Number(d.monto) : fiscal.round2(Math.max(0, Number(d.monto_bs || 0) - Number(d.iva_retenido || 0) - Number(d.islr_retenido_bs || 0)) / tasaDoc));
        const saldoPendUsd = (!esPago && !esNC && !['PAGADO', 'PAGADA', 'ANULADO'].includes(String(d.estado || '').toUpperCase()))
            ? fiscal.round2(Math.max(0, netoOrigUsd - Number(d.monto_abonado || 0)))
            : 0;

        const ag = fiscal.calcularAgingDocumento({
            fechaEmision: d.fecha,
            fechaVencimiento: d.fecha_vencimiento,
            diasCredito: d.dias_credito || d.prov_dias_credito || 15,
            fechaCorte
        });

        if (saldoPendUsd > 0.01) {
            agingTotales[ag.bucket] = fiscal.round2((agingTotales[ag.bucket] || 0) + saldoPendUsd);
            totalDeudaNetaUsd = fiscal.round2(totalDeudaNetaUsd + saldoPendUsd);
        }

        const semaforo = saldoPendUsd > 0.01
            ? fiscal.calcularSemaforoBcvPago({
                saldoUsd: saldoPendUsd,
                tasaEmision: tasaDoc,
                tasaHoy,
                monedaOrigen: d.moneda_origen || 'USD',
                diasVencido: ag.dias_vencido
            })
            : null;

        return {
            ...d,
            proveedor_nombre: d.prov_nombre || d.razon || d.proveedor_rif,
            neto_pagar_usd_efectivo: netoOrigUsd,
            saldo_pendiente_usd: saldoPendUsd,
            saldo_pendiente_bs_hoy: fiscal.round2(saldoPendUsd * tasaHoy),
            fecha_vencimiento: ag.fecha_vencimiento,
            dias_vencido: ag.dias_vencido,
            vencida: saldoPendUsd > 0.01 && ag.vencida,
            aging_bucket: ag.bucket,
            semaforo
        };
    });

    const retenciones = conn.prepare(`SELECT * FROM retenciones_emitidas WHERE company_id = ? ORDER BY fecha_emision DESC, id DESC LIMIT 300`).all(companyId);
    const ndTransito = conn.prepare(`SELECT * FROM notas_ajuste_cambiario WHERE company_id = ? AND modulo = 'CXP' ORDER BY fecha_operacion DESC, id DESC LIMIT 200`).all(companyId);
    const anticipos = conn.prepare(`SELECT * FROM anticipos_saldos_favor WHERE company_id = ? AND modulo = 'CXP' ORDER BY fecha DESC, id DESC`).all(companyId);
    const ordenesPago = conn.prepare(`SELECT * FROM ordenes_pago_cxp WHERE company_id = ? ORDER BY fecha_programada DESC, id DESC LIMIT 100`).all(companyId);
    const cierres = conn.prepare(`SELECT * FROM cierres_cambiarios_mensuales WHERE company_id = ? AND modulo = 'CXP' ORDER BY periodo_aaaamm DESC, id DESC LIMIT 24`).all(companyId);

    return {
        exito: true,
        tasa_bcv: tasaHoy,
        total_deuda_neta_usd: totalDeudaNetaUsd,
        total_deuda_neta_bs: fiscal.round2(totalDeudaNetaUsd * tasaHoy),
        aging: agingTotales,
        movimientos: enriquecidos,
        retenciones,
        notas_ajuste: ndTransito,
        anticipos,
        ordenes_pago: ordenesPago,
        cierres_cambiarios: cierres
    };
}

function obtenerCarteraAvanzadaCxcDb(conn, { companyId }) {
    const tasaHoy = resolverTasaActivaDb(conn);
    const fechaCorte = fiscal.obtenerHoyCaracasISO();
    const tablaCli = tablaClientesEnConn(conn);

    const clientes = conn.prepare(`SELECT * FROM ${tablaCli} WHERE company_id = ? OR company_id IS NULL`).all(companyId);
    const mapaCli = new Map();
    clientes.forEach(c => mapaCli.set(fiscal.normalizarRifSENIAT(c.rif, false), c));

    const cuentas = conn.prepare(`
        SELECT * FROM cuentas_por_cobrar
        WHERE company_id = ? OR company_id IS NULL OR company_id = ''
        ORDER BY fecha DESC, id DESC
    `).all(companyId);

    const agingTotales = { POR_VENCER: 0, '0_30': 0, '31_60': 0, '61_90': 0, MAS_90: 0 };
    let totalPorCobrarUsd = 0;

    const cuentasEnriquecidas = cuentas.map(c => {
        const rifClean = fiscal.normalizarRifSENIAT(c.cliente_id || c.cliente_rif || c.rif_cliente, false);
        const cli = mapaCli.get(rifClean);
        const tOrig = Math.max(0.01, Number(c.tasa_emision || tasaHoy));
        const mUsd = Number(c.monto_usd || 0) > 0 ? Number(c.monto_usd) : fiscal.round2(Number(c.monto_bs || 0) / tOrig);
        const pagUsd = Number(c.monto_pagado || 0);
        const pagada = ['PAGADA', 'PAGADO', 'ANULADA'].includes(String(c.estado || '').toUpperCase()) || pagUsd >= (mUsd - 0.01);
        const saldoUsd = pagada ? 0 : fiscal.round2(Math.max(0, mUsd - pagUsd));
        const ag = fiscal.calcularAgingDocumento({
            fechaEmision: c.fecha,
            fechaVencimiento: c.fecha_vencimiento,
            diasCredito: c.dias_credito || (cli && cli.dias_credito) || 15,
            fechaCorte
        });
        if (saldoUsd > 0.01) {
            agingTotales[ag.bucket] = fiscal.round2((agingTotales[ag.bucket] || 0) + saldoUsd);
            totalPorCobrarUsd = fiscal.round2(totalPorCobrarUsd + saldoUsd);
        }
        return {
            ...c,
            cliente_nombre: c.cliente_nombre || (cli && cli.nombre) || 'Cliente General',
            cliente_telefono: (cli && cli.telefono) || '',
            monto_usd: mUsd,
            saldo_pendiente_usd: saldoUsd,
            saldo_pendiente_bs_hoy: fiscal.round2(saldoUsd * tasaHoy),
            diferencial_cambiario_estimado_bs: saldoUsd > 0.01 ? fiscal.round2(saldoUsd * (tasaHoy - tOrig)) : 0,
            fecha_vencimiento: ag.fecha_vencimiento,
            dias_vencido: ag.dias_vencido,
            vencida: saldoUsd > 0.01 && ag.vencida,
            aging_bucket: ag.bucket,
            limite_credito_usd: Number((cli && cli.limite_credito_usd) || 0),
            descuento_pronto_pago_pct: Number((cli && cli.descuento_pronto_pago_pct) || 0),
            saldo_a_favor_usd: Number((cli && cli.saldo_a_favor_usd) || 0)
        };
    });

    const abonos = conn.prepare(`SELECT * FROM abonos_cuentas_cobrar WHERE company_id = ? OR company_id IS NULL ORDER BY fecha DESC LIMIT 400`).all(companyId);
    const anticipos = conn.prepare(`SELECT * FROM anticipos_saldos_favor WHERE company_id = ? AND modulo = 'CXC' ORDER BY fecha DESC, id DESC`).all(companyId);
    const notasAjuste = conn.prepare(`SELECT * FROM notas_ajuste_cambiario WHERE company_id = ? AND modulo = 'CXC' ORDER BY fecha_operacion DESC, id DESC LIMIT 200`).all(companyId);
    const giros = conn.prepare(`SELECT * FROM giros_cheques_cxc WHERE company_id = ? ORDER BY fecha_vencimiento ASC, id DESC LIMIT 200`).all(companyId);
    const cierres = conn.prepare(`SELECT * FROM cierres_cambiarios_mensuales WHERE company_id = ? AND modulo = 'CXC' ORDER BY periodo_aaaamm DESC, id DESC LIMIT 24`).all(companyId);
    const parametros = obtenerParametrosFiscalesAvanzadosDb(conn, companyId);

    return {
        exito: true,
        tasa_bcv: tasaHoy,
        total_por_cobrar_usd: totalPorCobrarUsd,
        total_por_cobrar_bs: fiscal.round2(totalPorCobrarUsd * tasaHoy),
        aging: agingTotales,
        cuentas: cuentasEnriquecidas,
        abonos,
        anticipos,
        notas_ajuste: notasAjuste,
        giros,
        cierres_cambiarios: cierres,
        parametros
    };
}

function gestionarCuentaTesoreriaDb(conn, d = {}) {
    const compId = String(d.company_id || d.companyId || '').trim();
    if (!compId) throw new Error('company_id requerido.');
    const accion = String(d.accion || 'LISTAR').toUpperCase();

    if (accion === 'LISTAR') {
        asegurarCuentaTesoreriaDefaultDb(conn, compId, 'BS');
        asegurarCuentaTesoreriaDefaultDb(conn, compId, 'USD');
        const cuentas = conn.prepare(`SELECT * FROM cuentas_tesoreria WHERE company_id = ? ORDER BY moneda ASC, nombre ASC`).all(compId);
        const movimientos = conn.prepare(`
            SELECT m.*, c.nombre AS cuenta_nombre
            FROM movimientos_tesoreria m
            LEFT JOIN cuentas_tesoreria c ON c.id = m.cuenta_id
            WHERE m.company_id = ?
            ORDER BY m.fecha DESC, m.fecha_creacion DESC LIMIT 250
        `).all(compId);
        return { exito: true, cuentas, movimientos };
    }

    if (accion === 'CREAR_CUENTA') {
        const id = d.id || genId('CTA');
        conn.prepare(`
            INSERT OR REPLACE INTO cuentas_tesoreria (id, company_id, nombre, tipo_cuenta, moneda, banco_codigo, numero_cuenta, titular, saldo_actual, activa, estado_sync)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
        `).run(
            id, compId, d.nombre || 'Cuenta Nueva', d.tipo_cuenta || 'BANCO_BS',
            String(d.moneda || 'BS').toUpperCase() === 'USD' ? 'USD' : 'BS',
            d.banco_codigo || '', d.numero_cuenta || '', d.titular || '',
            fiscal.round2(d.saldo_inicial || 0)
        );
        return { exito: true, id };
    }

    if (accion === 'MOVIMIENTO_MANUAL') {
        const res = registrarMovimientoTesoreriaInternoDb(conn, {
            companyId: compId,
            cuentaId: d.cuenta_id,
            moduloOrigen: 'MANUAL_TESORERIA',
            tipo: d.tipo || 'INGRESO',
            moneda: d.moneda || 'BS',
            monto: Number(d.monto || 0),
            tasaBcv: Number(d.tasa_bcv || resolverTasaActivaDb(conn)),
            metodoPago: d.metodo_pago || 'TRANSFERENCIA',
            referenciaBancaria: d.referencia_bancaria || '',
            fecha: d.fecha || fiscal.obtenerHoyCaracasISO(),
            concepto: d.concepto || 'Ajuste Manual Tesorería',
            usuario: d.usuario || ''
        });
        return { exito: true, movimiento: res };
    }

    if (accion === 'CONCILIAR') {
        conn.prepare(`UPDATE movimientos_tesoreria SET conciliado = ?, estado_sync = 0 WHERE id = ? AND company_id = ?`).run(d.conciliado ? 1 : 0, d.movimiento_id, compId);
        return { exito: true };
    }

    throw new Error('Acción de tesorería no reconocida.');
}

function crearOEjecutarOrdenPagoCxpDb(conn, d = {}) {
    const compId = String(d.company_id || d.companyId || '').trim();
    if (!compId) throw new Error('company_id requerido.');
    const accion = String(d.accion || 'CREAR').toUpperCase();
    const tasa = Math.max(0.01, Number(d.tasa_bcv || resolverTasaActivaDb(conn)));

    if (accion === 'CREAR') {
        const ids = Array.isArray(d.movimiento_ids) ? d.movimiento_ids : [];
        if (ids.length === 0) throw new Error('Seleccione al menos una factura CxP para programar la Orden de Pago.');
        const placeholders = ids.map(() => '?').join(',');
        const rows = conn.prepare(`
            SELECT m.*, p.nombre AS prov_nombre, p.banco_nombre, p.cuenta_bancaria, p.rif_titular_cuenta
            FROM movimientos_cuentas_pagar m
            LEFT JOIN proveedores p ON REPLACE(UPPER(TRIM(m.proveedor_rif)), '-', '') = REPLACE(UPPER(TRIM(p.rif)), '-', '')
            WHERE m.company_id = ? AND m.id IN (${placeholders})
        `).all(compId, ...ids);

        const detalles = rows.map(r => {
            const netoUsd = fiscal.round2(Math.max(0, (Number(r.neto_a_pagar_usd || 0) > 0 ? Number(r.neto_a_pagar_usd) : Number(r.monto || 0)) - Number(r.monto_abonado || 0)));
            return {
                movimiento_id: r.id,
                proveedor_rif: r.proveedor_rif,
                proveedor_nombre: r.prov_nombre || r.razon || r.proveedor_rif,
                rif_titular_cuenta: r.rif_titular_cuenta || r.proveedor_rif,
                banco_nombre: r.banco_nombre || '',
                cuenta_bancaria: r.cuenta_bancaria || '',
                comprobante: r.comprobante || r.id,
                neto_usd: netoUsd,
                neto_bs: fiscal.round2(netoUsd * tasa),
                tasa_bcv: tasa
            };
        }).filter(x => x.neto_usd > 0.01);

        const totalUsd = fiscal.round2(detalles.reduce((s, x) => s + x.neto_usd, 0));
        const totalBs = fiscal.round2(totalUsd * tasa);
        const ordId = genId('OPG');
        const codigo = `OP-${fiscal.obtenerHoyCaracasISO().replace(/-/g, '')}-${String(Date.now()).slice(-4)}`;

        conn.prepare(`
            INSERT INTO ordenes_pago_cxp (
                id, company_id, codigo_orden, fecha_programada, banco_origen_alias, tasa_bcv,
                cantidad_facturas, total_neto_usd, total_neto_bs, semaforo_recomendacion,
                estado, detalle_json, usuario_aprobador, estado_sync
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APROBADA', ?, ?, 0)
        `).run(
            ordId, compId, codigo, d.fecha_programada || fiscal.obtenerHoyCaracasISO(),
            d.banco_origen_alias || 'BANESCO', tasa, detalles.length, totalUsd, totalBs,
            d.semaforo_recomendacion || 'PROGRAMADA', JSON.stringify(detalles), d.usuario || ''
        );

        conn.prepare(`UPDATE movimientos_cuentas_pagar SET lote_pago_id = ?, estado_sync = 0 WHERE company_id = ? AND id IN (${placeholders})`).run(ordId, compId, ...ids);
        return { exito: true, id: ordId, codigo_orden: codigo, detalles, total_neto_usd: totalUsd, total_neto_bs: totalBs };
    }

    if (accion === 'EJECUTAR') {
        const ord = conn.prepare(`SELECT * FROM ordenes_pago_cxp WHERE id = ? AND company_id = ?`).get(d.id, compId);
        if (!ord) throw new Error('Orden de Pago no encontrada.');
        if (ord.estado === 'EJECUTADA') throw new Error('Esta Orden de Pago ya fue ejecutada.');
        const detalles = JSON.parse(ord.detalle_json || '[]');
        const tx = conn.transaction(() => {
            for (const det of detalles) {
                registrarPagoCxpAvanzadoDb(conn, {
                    company_id: compId,
                    movimiento_id: det.movimiento_id,
                    proveedor_rif: det.proveedor_rif,
                    razon: det.proveedor_nombre,
                    monto_usd: det.neto_usd,
                    tasa_bcv: tasa,
                    metodo_pago: d.metodo_pago || `TRANSFERENCIA_${ord.banco_origen_alias}`,
                    referencia: d.referencia || ord.codigo_orden,
                    cuenta_tesoreria_id: d.cuenta_tesoreria_id || null,
                    nota: `Ejecución Orden de Pago ${ord.codigo_orden}`
                });
            }
            conn.prepare(`UPDATE ordenes_pago_cxp SET estado = 'EJECUTADA', fecha_ejecucion = ?, estado_sync = 0 WHERE id = ?`).run(fiscal.obtenerHoyCaracasISO(), ord.id);
        });
        tx();
        return { exito: true, codigo_orden: ord.codigo_orden, facturas_liquidadas: detalles.length };
    }

    throw new Error('Acción no válida para Orden de Pago.');
}

module.exports = {
    genId,
    resolverTasaActivaDb,
    obtenerParametrosFiscalesAvanzadosDb,
    guardarParametrosFiscalesAvanzadosDb,
    verificarDuplicadoDocumentoCxpDb,
    evaluarLimiteCreditoClienteDb,
    registrarAnticipoOSaldoFavorDb,
    registrarAbonoCxcAvanzadoDb,
    guardarDocumentoCxpCompletoDb,
    emitirRetencionCxpIndependienteDb,
    registrarPagoCxpAvanzadoDb,
    resolverNdTransitoCxpDb,
    registrarCasheaVentaCxcDb,
    registrarGiroOChequeDevueltoCxcDb,
    ejecutarCierreCambiarioMensualDb,
    revertirCierreCambiarioDiaUnoDb,
    obtenerDocumentosAvanzadosCxpDb,
    obtenerCarteraAvanzadaCxcDb,
    gestionarCuentaTesoreriaDb,
    crearOEjecutarOrdenPagoCxpDb,
    recalcularSaldoProveedorDb
};
