/**
 * Motor Unificado Contable, Fiscal y de Tesorería Bimonetaria para Venezuela — NEXUS POS
 *
 * Cumplimiento normativo validado:
 * - PA SNAT/2026/00093 (G.O. N° 43.484): Numeración de comprobantes de retención de 14 dígitos (AAAAMMSSSSSSSS),
 *   hora legible HH.MM.SS a.m./p.m., indicador (E) exento y expresión bimonetaria.
 * - PA SNAT/2025/000054 (G.O. N° 43.171): Retenciones de IVA (75% / 100%) y exportación TXT SENIAT de 16 columnas (\t).
 * - Decreto 1808 + U.T. SNAT/2025/000048 (G.O. N° 43.140, U.T. = Bs. 43,00): Retenciones ISLR PNR con sustraendo
 *   (Base > 83.3334 * UT) vs PJD directo, y exportación XML <RelacionRetencionesISLR>.
 * - Art. 51 Reglamento Ley del IVA vs VEN-NIF (NIC 21 / NIIF PYMES Sec. 30): Asimetría Cambiaria CxC vs CxP y Cierre Mensual.
 * - Ley IGTF (3%): Causación al cobro/pago en divisas con prelación sobre retenciones.
 */

const { generarTxtDispersionBancariaVE, CATALOGO_BANCOS_VE } = require('./nomina-ve');

const CONSTANTES_FISCALES_VE = {
    UNIDAD_TRIBUTARIA_BS: 43.00,
    FACTOR_MINIMO_ISLR_PNR: 83.3334,
    IGTF_PORCENTAJE: 3.00,
    IVA_GENERAL: 16.00,
    IVA_REDUCIDA: 8.00,
    IVA_ADICIONAL: 31.00
};

const CATALOGO_CONCEPTOS_ISLR = [
    { codigo: '001', nombre: 'Honorarios Profesionales (No Mercantiles)', pct_pnr: 3, pct_pjd: 5, aplica_sustraendo_pnr: true },
    { codigo: '011', nombre: 'Fletes y Transporte Nacional de Carga', pct_pnr: 1, pct_pjd: 3, aplica_sustraendo_pnr: true },
    { codigo: '015', nombre: 'Arrendamiento de Bienes Inmuebles', pct_pnr: 3, pct_pjd: 5, aplica_sustraendo_pnr: true },
    { codigo: '016', nombre: 'Arrendamiento de Bienes Muebles / Equipos', pct_pnr: 3, pct_pjd: 5, aplica_sustraendo_pnr: true },
    { codigo: '022', nombre: 'Publicidad, Propaganda y Mercadeo', pct_pnr: 3, pct_pjd: 5, aplica_sustraendo_pnr: true },
    { codigo: '026', nombre: 'Comisiones Mercantiles / Intermediación', pct_pnr: 1, pct_pjd: 2, aplica_sustraendo_pnr: true },
    { codigo: '030', nombre: 'Servicios de Mantenimiento y Reparación', pct_pnr: 1, pct_pjd: 2, aplica_sustraendo_pnr: true },
    { codigo: '053', nombre: 'Empresas Contratistas / Ejecución de Obras y Servicios', pct_pnr: 1, pct_pjd: 2, aplica_sustraendo_pnr: true },
    { codigo: '008', nombre: 'Primas de Seguros y Reaseguros', pct_pnr: 1, pct_pjd: 3, aplica_sustraendo_pnr: true },
    { codigo: '055', nombre: 'Servicios de Tecnología / Licencias / Consultoría', pct_pnr: 3, pct_pjd: 5, aplica_sustraendo_pnr: true }
];

const CATEGORIAS_GASTOS_OPERATIVOS = [
    'Alquiler y Condominio',
    'Servicios Públicos (Electricidad/Agua/Aseo)',
    'Telecomunicaciones e Internet',
    'Fletes, Aduana y Logística',
    'Honorarios Profesionales (Contabilidad/Legal)',
    'Mantenimiento, Repuestos y Reparaciones',
    'Publicidad, Redes y Mercadeo',
    'Insumos Administrativos y Papelería',
    'Seguros y Vigilancia',
    'Impuestos Municipales y Tasas',
    'Otros Gastos Operativos'
];

const ESQUEMA_EXTENSION_COLUMNAS_CXC_CXP = {
    clientes: {
        tipo_contribuyente: "TEXT DEFAULT 'ORDINARIO'",
        limite_credito_usd: "REAL DEFAULT 0",
        dias_credito: "INTEGER DEFAULT 15",
        dias_gracia: "INTEGER DEFAULT 3",
        descuento_pronto_pago_pct: "REAL DEFAULT 0",
        saldo_a_favor_usd: "REAL DEFAULT 0",
        saldo_a_favor_bs: "REAL DEFAULT 0",
        bloqueado_credito: "INTEGER DEFAULT 0"
    },
    cuentas_por_cobrar: {
        fecha_vencimiento: "TEXT",
        dias_credito: "INTEGER DEFAULT 15",
        moneda_contrato: "TEXT DEFAULT 'USD'",
        monto_iva_bs: "REAL DEFAULT 0",
        monto_exento_bs: "REAL DEFAULT 0",
        base_imponible_bs: "REAL DEFAULT 0",
        numero_control: "TEXT DEFAULT ''",
        es_giro: "INTEGER DEFAULT 0",
        giro_nro: "TEXT DEFAULT ''",
        es_cashea: "INTEGER DEFAULT 0",
        cashea_inicial_usd: "REAL DEFAULT 0",
        cashea_comision_usd: "REAL DEFAULT 0",
        cashea_estado: "TEXT DEFAULT ''"
    },
    abonos_cuentas_cobrar: {
        igtf_usd: "REAL DEFAULT 0",
        igtf_bs: "REAL DEFAULT 0",
        retencion_iva_bs: "REAL DEFAULT 0",
        retencion_islr_bs: "REAL DEFAULT 0",
        descuento_pronto_pago_usd: "REAL DEFAULT 0",
        diferencial_cambiario_bs: "REAL DEFAULT 0",
        tipo_abono: "TEXT DEFAULT 'NORMAL'",
        observacion_conciliacion: "TEXT DEFAULT ''"
    },
    proveedores: {
        tipo_contribuyente: "TEXT DEFAULT 'ORDINARIO'",
        porcentaje_retencion_iva: "REAL DEFAULT 75",
        aplica_islr_default: "INTEGER DEFAULT 0",
        codigo_islr_default: "TEXT DEFAULT '053'",
        banco_codigo: "TEXT DEFAULT ''",
        banco_nombre: "TEXT DEFAULT ''",
        cuenta_bancaria: "TEXT DEFAULT ''",
        rif_titular_cuenta: "TEXT DEFAULT ''",
        telefono_pago_movil: "TEXT DEFAULT ''",
        dias_credito_default: "INTEGER DEFAULT 15",
        saldo_a_favor_usd: "REAL DEFAULT 0",
        saldo_a_favor_bs: "REAL DEFAULT 0"
    },
    movimientos_cuentas_pagar: {
        fecha_vencimiento: "TEXT",
        dias_credito: "INTEGER DEFAULT 15",
        moneda_origen: "TEXT DEFAULT 'USD'",
        orden_compra_ref: "TEXT DEFAULT ''",
        islr_retenido_bs: "REAL DEFAULT 0",
        porcentaje_islr: "REAL DEFAULT 0",
        codigo_concepto_islr: "TEXT DEFAULT ''",
        sustraendo_islr_bs: "REAL DEFAULT 0",
        comprobante_islr: "TEXT DEFAULT ''",
        igtf_bs: "REAL DEFAULT 0",
        neto_a_pagar_usd: "REAL DEFAULT 0",
        neto_a_pagar_bs: "REAL DEFAULT 0",
        forma80_json: "TEXT DEFAULT ''",
        aprobado_pago: "INTEGER DEFAULT 1",
        lote_pago_id: "TEXT DEFAULT ''",
        nota_debito_nro: "TEXT DEFAULT ''"
    }
};

const ESQUEMA_TABLAS_AVANZADAS_CXC_CXP = {
    correlativos_retenciones_ve: {
        clave: "TEXT PRIMARY KEY",
        company_id: "TEXT NOT NULL",
        tipo: "TEXT NOT NULL",
        periodo_aaaamm: "TEXT NOT NULL",
        ultimo_consecutivo: "INTEGER DEFAULT 0",
        fecha_actualizacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))"
    },
    retenciones_emitidas: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT NOT NULL",
        tipo_impuesto: "TEXT NOT NULL",
        numero_comprobante: "TEXT NOT NULL",
        periodo_aaaamm: "TEXT NOT NULL",
        fecha_emision: "TEXT NOT NULL",
        fecha_documento: "TEXT NOT NULL",
        movimiento_cxp_id: "TEXT",
        sujeto_rif: "TEXT NOT NULL",
        sujeto_nombre: "TEXT NOT NULL",
        tipo_persona: "TEXT DEFAULT 'PJD'",
        tipo_documento: "TEXT DEFAULT '01'",
        numero_documento: "TEXT NOT NULL",
        numero_control: "TEXT DEFAULT ''",
        documento_afectado: "TEXT DEFAULT '0'",
        expediente_importacion: "TEXT DEFAULT '0'",
        monto_total_bs: "REAL DEFAULT 0",
        monto_exento_bs: "REAL DEFAULT 0",
        base_imponible_bs: "REAL DEFAULT 0",
        alicuota_iva: "REAL DEFAULT 16",
        impuesto_causado_bs: "REAL DEFAULT 0",
        codigo_concepto_islr: "TEXT DEFAULT ''",
        porcentaje_retencion: "REAL DEFAULT 75",
        sustraendo_bs: "REAL DEFAULT 0",
        monto_retenido_bs: "REAL DEFAULT 0",
        monto_retenido_usd: "REAL DEFAULT 0",
        tasa_bcv: "REAL DEFAULT 1",
        estatus: "TEXT DEFAULT 'EMITIDO'",
        datos_json: "TEXT",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    },
    notas_ajuste_cambiario: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT NOT NULL",
        modulo: "TEXT NOT NULL",
        tipo_ajuste: "TEXT NOT NULL",
        estado: "TEXT DEFAULT 'REGISTRADO'",
        tercero_rif: "TEXT NOT NULL",
        tercero_nombre: "TEXT",
        documento_origen_id: "TEXT",
        documento_origen_nro: "TEXT",
        numero_nd_fiscal: "TEXT DEFAULT ''",
        numero_control_nd: "TEXT DEFAULT ''",
        fecha_operacion: "TEXT NOT NULL",
        tasa_original: "REAL DEFAULT 1",
        tasa_liquidacion: "REAL DEFAULT 1",
        monto_usd_base: "REAL DEFAULT 0",
        variacion_bruta_bs: "REAL DEFAULT 0",
        base_imponible_nd_bs: "REAL DEFAULT 0",
        iva_nd_bs: "REAL DEFAULT 0",
        alicuota_iva: "REAL DEFAULT 16",
        regimen_aplicado: "TEXT DEFAULT 'FISCAL_ND_ART51'",
        venta_id_generada: "TEXT DEFAULT ''",
        movimiento_cxp_generado_id: "TEXT DEFAULT ''",
        nota: "TEXT DEFAULT ''",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    },
    cierres_cambiarios_mensuales: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT NOT NULL",
        modulo: "TEXT NOT NULL",
        periodo_aaaamm: "TEXT NOT NULL",
        fecha_cierre: "TEXT NOT NULL",
        tasa_cierre_bcv: "REAL NOT NULL",
        saldo_abierto_usd: "REAL DEFAULT 0",
        costo_historico_bs: "REAL DEFAULT 0",
        valor_reexpresado_bs: "REAL DEFAULT 0",
        diferencial_no_realizado_bs: "REAL DEFAULT 0",
        diferencial_realizado_mes_bs: "REAL DEFAULT 0",
        estado: "TEXT DEFAULT 'VIGENTE'",
        fecha_reverso: "TEXT DEFAULT ''",
        detalle_json: "TEXT",
        usuario: "TEXT DEFAULT ''",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    },
    anticipos_saldos_favor: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT NOT NULL",
        modulo: "TEXT NOT NULL",
        tercero_rif: "TEXT NOT NULL",
        tercero_nombre: "TEXT",
        tipo_registro: "TEXT DEFAULT 'ANTICIPO'",
        modalidad_contrato: "TEXT DEFAULT 'INDEXADO_USD'",
        fecha: "TEXT NOT NULL",
        tasa_bcv: "REAL DEFAULT 1",
        monto_original_usd: "REAL DEFAULT 0",
        monto_original_bs: "REAL DEFAULT 0",
        saldo_disponible_usd: "REAL DEFAULT 0",
        saldo_disponible_bs: "REAL DEFAULT 0",
        metodo_pago: "TEXT DEFAULT 'EFECTIVO'",
        referencia: "TEXT DEFAULT ''",
        documento_origen: "TEXT DEFAULT ''",
        nota: "TEXT DEFAULT ''",
        estado: "TEXT DEFAULT 'DISPONIBLE'",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    },
    ordenes_pago_cxp: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT NOT NULL",
        codigo_orden: "TEXT NOT NULL",
        fecha_programada: "TEXT NOT NULL",
        banco_origen_alias: "TEXT DEFAULT 'BANESCO'",
        tasa_bcv: "REAL DEFAULT 1",
        cantidad_facturas: "INTEGER DEFAULT 0",
        total_neto_usd: "REAL DEFAULT 0",
        total_neto_bs: "REAL DEFAULT 0",
        semaforo_recomendacion: "TEXT DEFAULT 'PROGRAMAR'",
        estado: "TEXT DEFAULT 'BORRADOR'",
        detalle_json: "TEXT",
        usuario_aprobador: "TEXT DEFAULT ''",
        fecha_ejecucion: "TEXT DEFAULT ''",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    },
    cuentas_tesoreria: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT NOT NULL",
        nombre: "TEXT NOT NULL",
        tipo_cuenta: "TEXT DEFAULT 'BANCO_BS'",
        moneda: "TEXT DEFAULT 'BS'",
        banco_codigo: "TEXT DEFAULT ''",
        numero_cuenta: "TEXT DEFAULT ''",
        titular: "TEXT DEFAULT ''",
        saldo_actual: "REAL DEFAULT 0",
        activa: "INTEGER DEFAULT 1",
        fecha_actualizacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    },
    movimientos_tesoreria: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT NOT NULL",
        cuenta_id: "TEXT NOT NULL",
        modulo_origen: "TEXT DEFAULT 'MANUAL'",
        referencia_origen_id: "TEXT DEFAULT ''",
        tercero_rif: "TEXT DEFAULT ''",
        tercero_nombre: "TEXT DEFAULT ''",
        tipo: "TEXT NOT NULL",
        moneda: "TEXT DEFAULT 'BS'",
        monto: "REAL DEFAULT 0",
        monto_usd_eq: "REAL DEFAULT 0",
        tasa_bcv: "REAL DEFAULT 1",
        metodo_pago: "TEXT DEFAULT ''",
        referencia_bancaria: "TEXT DEFAULT ''",
        conciliado: "INTEGER DEFAULT 0",
        fecha: "TEXT NOT NULL",
        concepto: "TEXT DEFAULT ''",
        usuario: "TEXT DEFAULT ''",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    },
    giros_cheques_cxc: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT NOT NULL",
        cliente_rif: "TEXT NOT NULL",
        cliente_nombre: "TEXT",
        cuenta_cxc_id: "INTEGER",
        factura_nro: "TEXT",
        tipo_instrumento: "TEXT DEFAULT 'CHEQUE'",
        numero_instrumento: "TEXT NOT NULL",
        banco_emisor: "TEXT DEFAULT ''",
        fecha_recepcion: "TEXT NOT NULL",
        fecha_vencimiento: "TEXT NOT NULL",
        monto_usd: "REAL DEFAULT 0",
        monto_bs: "REAL DEFAULT 0",
        tasa_bcv: "REAL DEFAULT 1",
        comision_devolucion_usd: "REAL DEFAULT 0",
        estado: "TEXT DEFAULT 'EN_CARTERA'",
        observacion: "TEXT DEFAULT ''",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    }
};

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

function obtenerHoyCaracasISO() {
    return new Date(Date.now() - (4 * 3600 * 1000)).toISOString().slice(0, 10);
}

/**
 * Formato obligatorio PA SNAT/2026/00093: HH.MM.SS a.m. / p.m.
 */
function formatearHoraSNAT2026(fechaInput = null) {
    let dt;
    let useLocalNaive = false;
    if (fechaInput instanceof Date && !Number.isNaN(fechaInput.getTime())) {
        dt = new Date(fechaInput.getTime() - (4 * 3600 * 1000));
    } else if (typeof fechaInput === 'string' && fechaInput.trim()) {
        const raw = fechaInput.trim();
        const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
        if (!hasTz) {
            const m = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
            if (m) {
                const hours = parseInt(m[1], 10);
                const mins = parseInt(m[2], 10);
                const secs = m[3] ? parseInt(m[3], 10) : 0;
                if (hours >= 0 && hours <= 23 && mins >= 0 && mins <= 59 && secs >= 0 && secs <= 59) {
                    const sufijo = hours >= 12 ? 'p.m.' : 'a.m.';
                    const h12 = hours % 12 === 0 ? 12 : hours % 12;
                    return `${String(h12).padStart(2, '0')}.${String(mins).padStart(2, '0')}.${String(secs).padStart(2, '0')} ${sufijo}`;
                }
            }
        }
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) {
            dt = hasTz ? new Date(parsed.getTime() - (4 * 3600 * 1000)) : parsed;
            useLocalNaive = !hasTz;
        } else {
            dt = new Date(Date.now() - (4 * 3600 * 1000));
        }
    } else {
        dt = new Date(Date.now() - (4 * 3600 * 1000));
    }
    const hours = useLocalNaive ? dt.getHours() : dt.getUTCHours();
    const mins = useLocalNaive ? dt.getMinutes() : dt.getUTCMinutes();
    const secs = useLocalNaive ? dt.getSeconds() : dt.getUTCSeconds();
    const sufijo = hours >= 12 ? 'p.m.' : 'a.m.';
    const h12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${String(h12).padStart(2, '0')}.${String(mins).padStart(2, '0')}.${String(secs).padStart(2, '0')} ${sufijo}`;
}

/**
 * Normaliza RIF venezolano en formato SENIAT sin guiones (ej. J123456789) o con formato legible.
 */
function normalizarRifSENIAT(rif = '', conGuiones = false) {
    const clean = String(rif || '').toUpperCase().replace(/[^VEJGCP0-9]/g, '');
    if (!clean) return '';
    if (!conGuiones) return clean;
    if (clean.length >= 9) {
        return `${clean[0]}-${clean.slice(1, -1)}-${clean.slice(-1)}`;
    }
    return clean;
}

/**
 * Clasifica sujeto para Decreto 1808 ISLR: PNR vs PJD.
 */
function clasificarPersonaPorRif(rif = '', tipoExplicito = '') {
    const exp = String(tipoExplicito || '').toUpperCase().trim();
    if (exp === 'PNR' || exp === 'PNNR' || exp === 'PJD' || exp === 'PJND') return exp;
    const clean = normalizarRifSENIAT(rif, false);
    if (clean.startsWith('V') || clean.startsWith('E')) return 'PNR';
    return 'PJD';
}

/**
 * PA SNAT/2026/00093 Art. 18: Número de comprobante de 14 caracteres AAAAMMSSSSSSSS.
 */
function construirComprobante14Digitos(periodoAAAAMM = '', consecutivo = 1) {
    const cleanPer = String(periodoAAAAMM || obtenerHoyCaracasISO().slice(0, 7)).replace(/[^0-9]/g, '');
    const aaaamm = cleanPer.length >= 6 ? cleanPer.slice(0, 6) : obtenerHoyCaracasISO().slice(0, 7).replace('-', '');
    const seq = Math.max(1, parseInt(consecutivo, 10) || 1);
    return `${aaaamm}${String(seq).padStart(8, '0')}`;
}

/**
 * Calcula Retención de IVA conforme a PA SNAT/2025/000054 (G.O. 43.171).
 */
function calcularRetencionIvaVE({
    montoIvaBs = 0,
    alicuotaIva = 16,
    tieneControl = true,
    ivaDiscriminado = true,
    proveedorPctDefault = 75,
    proveedorEnRif = true,
    esMetalOPiedraPreciosa = false,
    porcentajeForzado = null
} = {}) {
    const ivaBs = Math.max(0, round2(montoIvaBs));
    const advertencias = [];
    let porcentajeAplicado = porcentajeForzado !== null && porcentajeForzado !== undefined
        ? Number(porcentajeForzado)
        : Number(proveedorPctDefault ?? 75);

    if (![0, 75, 100].includes(porcentajeAplicado)) {
        porcentajeAplicado = porcentajeAplicado >= 90 ? 100 : (porcentajeAplicado > 0 ? 75 : 0);
    }

    if (ivaBs > 0 && porcentajeAplicado > 0) {
        if (!ivaDiscriminado) {
            porcentajeAplicado = 100;
            advertencias.push('SNAT/2025/000054: IVA no discriminado en factura → Retención automática 100%.');
        }
        if (!tieneControl) {
            porcentajeAplicado = 100;
            advertencias.push('SNAT/2025/000054: Documento sin N° de Control válido → Retención 100% por incumplimiento formal.');
        }
        if (!proveedorEnRif) {
            porcentajeAplicado = 100;
            advertencias.push('SNAT/2025/000054: Proveedor no inscrito/verificado en RIF → Retención 100%.');
        }
        if (esMetalOPiedraPreciosa) {
            porcentajeAplicado = 100;
            advertencias.push('SNAT/2025/000054: Metales/piedras preciosas → Retención obligatoria 100%.');
        }
    }

    const montoRetenidoBs = round2(ivaBs * (porcentajeAplicado / 100));
    return {
        iva_factura_bs: ivaBs,
        alicuota_iva: Number(alicuotaIva || 0),
        porcentaje_retencion: porcentajeAplicado,
        monto_retenido_bs: montoRetenidoBs,
        iva_no_retenido_bs: round2(ivaBs - montoRetenidoBs),
        advertencias
    };
}

/**
 * Calcula Retención de ISLR según Decreto 1808 y U.T. vigente (SNAT/2025/000048: Bs. 43,00).
 */
function calcularRetencionIslrDecreto1808({
    baseImponibleBs = 0,
    rifRetenido = '',
    tipoPersona = '',
    codigoConcepto = '053',
    porcentajeManual = null,
    utBs = CONSTANTES_FISCALES_VE.UNIDAD_TRIBUTARIA_BS
} = {}) {
    const base = Math.max(0, round2(baseImponibleBs));
    const ut = Math.max(0.01, Number(utBs || CONSTANTES_FISCALES_VE.UNIDAD_TRIBUTARIA_BS));
    const persona = clasificarPersonaPorRif(rifRetenido, tipoPersona);
    const concepto = CATALOGO_CONCEPTOS_ISLR.find(c => c.codigo === String(codigoConcepto || '').padStart(3, '0'))
        || CATALOGO_CONCEPTOS_ISLR[0];

    let pct = porcentajeManual !== null && porcentajeManual !== undefined && porcentajeManual !== ''
        ? Math.max(0, Number(porcentajeManual))
        : (persona === 'PNR' ? concepto.pct_pnr : concepto.pct_pjd);

    const factorMinimo = CONSTANTES_FISCALES_VE.FACTOR_MINIMO_ISLR_PNR;
    const minimoTributableBs = round2(factorMinimo * ut);

    let aplicaSustraendo = false;
    let sustraendoBs = 0;
    let superaMinimo = true;
    let impuestoBrutoBs = round2(base * (pct / 100));
    let montoRetenidoBs = impuestoBrutoBs;

    if (persona === 'PNR' && concepto.aplica_sustraendo_pnr) {
        aplicaSustraendo = true;
        sustraendoBs = round2(minimoTributableBs * (pct / 100));
        if (base <= minimoTributableBs) {
            superaMinimo = false;
            montoRetenidoBs = 0;
        } else {
            montoRetenidoBs = Math.max(0, round2(impuestoBrutoBs - sustraendoBs));
        }
    }

    return {
        codigo_concepto: concepto.codigo,
        concepto_nombre: concepto.nombre,
        tipo_persona: persona,
        ut_bs: ut,
        base_imponible_bs: base,
        porcentaje_retencion: pct,
        minimo_tributable_bs: persona === 'PNR' ? minimoTributableBs : 0,
        supera_minimo: superaMinimo,
        aplica_sustraendo: aplicaSustraendo,
        sustraendo_bs: sustraendoBs,
        impuesto_bruto_bs: impuestoBrutoBs,
        monto_retenido_bs: montoRetenidoBs
    };
}

/**
 * Orden de prelación en Cobranza CxC:
 * 1) Retenciones IVA/ISLR recibidas del cliente.
 * 2) Descuento por pronto pago.
 * 3) Abono en Bs y Divisas.
 * 4) Percepción IGTF (3%) exclusivamente sobre el monto efectivamente pagado en divisas.
 * Si el cliente entrega divisas en exceso, la fracción IGTF no infla su amortización a capital y el excedente va a Saldo a Favor.
 */
function calcularPrelacionCobroIgtfVE({
    saldoPendienteUsd = 0,
    tasaCobro = 1,
    montoRetencionIvaBs = 0,
    montoRetencionIslrBs = 0,
    descuentoProntoPagoUsd = 0,
    montoPagadoBs = 0,
    montoPagadoDivisasUsd = 0,
    divisaIncluyeIgtf = false,
    empresaEsSpeIgtf = false,
    pctIgtf = CONSTANTES_FISCALES_VE.IGTF_PORCENTAJE
} = {}) {
    const tasa = Math.max(0.0001, Number(tasaCobro || 1));
    const saldoObjUsd = Math.max(0, round2(saldoPendienteUsd));
    const retIvaUsd = round2(Math.max(0, Number(montoRetencionIvaBs || 0)) / tasa);
    const retIslrUsd = round2(Math.max(0, Number(montoRetencionIslrBs || 0)) / tasa);
    const descUsd = Math.max(0, round2(descuentoProntoPagoUsd));
    const bsUsd = round2(Math.max(0, Number(montoPagadoBs || 0)) / tasa);

    const creditosPreviosUsd = round2(retIvaUsd + retIslrUsd + descUsd + bsUsd);
    const remanenteDespuesPreviosUsd = Math.max(0, round2(saldoObjUsd - creditosPreviosUsd));

    const divisaRecibidaUsd = Math.max(0, round2(montoPagadoDivisasUsd));
    let baseDivisaParaCapitalUsd = divisaRecibidaUsd;
    let igtfUsd = 0;

    if (empresaEsSpeIgtf && divisaRecibidaUsd > 0 && Number(pctIgtf) > 0) {
        const factorIgtf = Number(pctIgtf) / 100;
        if (divisaIncluyeIgtf) {
            const baseNeta = round2(divisaRecibidaUsd / (1 + factorIgtf));
            const baseAplicable = Math.min(baseNeta, remanenteDespuesPreviosUsd > 0 ? remanenteDespuesPreviosUsd : baseNeta);
            igtfUsd = round2(baseAplicable * factorIgtf);
            baseDivisaParaCapitalUsd = round2(divisaRecibidaUsd - igtfUsd);
        } else {
            const baseAplicable = Math.min(divisaRecibidaUsd, remanenteDespuesPreviosUsd > 0 ? remanenteDespuesPreviosUsd : divisaRecibidaUsd);
            igtfUsd = round2(baseAplicable * factorIgtf);
            baseDivisaParaCapitalUsd = divisaRecibidaUsd;
        }
    }

    const totalAplicadoADeudaUsd = round2(creditosPreviosUsd + baseDivisaParaCapitalUsd);
    const amortizacionCapitalUsd = saldoObjUsd > 0 ? Math.min(saldoObjUsd, totalAplicadoADeudaUsd) : totalAplicadoADeudaUsd;
    const excedenteSaldoAFavorUsd = saldoObjUsd > 0 ? Math.max(0, round2(totalAplicadoADeudaUsd - saldoObjUsd)) : 0;

    return {
        tasa_cobro: tasa,
        retencion_iva_usd: retIvaUsd,
        retencion_islr_usd: retIslrUsd,
        descuento_pronto_pago_usd: descUsd,
        pago_bs_en_usd: bsUsd,
        divisa_base_capital_usd: baseDivisaParaCapitalUsd,
        igtf_usd: igtfUsd,
        igtf_bs: round2(igtfUsd * tasa),
        total_recibido_con_igtf_usd: round2(baseDivisaParaCapitalUsd + bsUsd + igtfUsd),
        amortizacion_capital_usd: amortizacionCapitalUsd,
        amortizacion_capital_bs: round2(amortizacionCapitalUsd * tasa),
        excedente_saldo_a_favor_usd: excedenteSaldoAFavorUsd,
        excedente_saldo_a_favor_bs: round2(excedenteSaldoAFavorUsd * tasa)
    };
}

/**
 * Regla de Asimetría Cambiaria CxC vs CxP (Art. 51 Regl. IVA + VEN-NIF NIC 21).
 */
function evaluarAsimetriaDiferencialCambiario({
    modulo = 'CXC',
    modoFiscalEmpresa = 'FISCAL_ND_ART51',
    montoUsdAmortizado = 0,
    tasaOriginal = 1,
    tasaLiquidacion = 1,
    alicuotaIva = 16,
    esOperacionGravada = true
} = {}) {
    const mod = String(modulo || 'CXC').toUpperCase();
    const modo = String(modoFiscalEmpresa || 'FISCAL_ND_ART51').toUpperCase();
    const usd = Math.max(0, round2(montoUsdAmortizado));
    const tOrig = Math.max(0.0001, Number(tasaOriginal || 1));
    const tLiq = Math.max(0.0001, Number(tasaLiquidacion || 1));
    const alic = Math.max(0, Number(alicuotaIva || 0));

    const valorOriginalBs = round2(usd * tOrig);
    const valorLiquidacionBs = round2(usd * tLiq);
    const variacionBrutaBs = round2(valorLiquidacionBs - valorOriginalBs);

    if (Math.abs(variacionBrutaBs) < 0.01 || usd <= 0) {
        return {
            modulo: mod,
            regimen_aplicado: modo,
            variacion_bruta_bs: 0,
            requiere_nota_debito_fiscal: false,
            enviar_a_nd_en_transito_cxp: false,
            base_imponible_nd_bs: 0,
            iva_nd_bs: 0,
            diferencial_financiero_islr_bs: 0
        };
    }

    let baseNdBs = 0;
    let ivaNdBs = 0;
    if (esOperacionGravada && alic > 0 && variacionBrutaBs > 0) {
        baseNdBs = round2(variacionBrutaBs / (1 + (alic / 100)));
        ivaNdBs = round2(variacionBrutaBs - baseNdBs);
    } else {
        baseNdBs = variacionBrutaBs;
    }

    if (mod === 'CXC') {
        const esFiscalEstricto = modo === 'FISCAL_ND_ART51' && variacionBrutaBs > 0;
        return {
            modulo: 'CXC',
            regimen_aplicado: esFiscalEstricto ? 'FISCAL_ND_ART51' : 'VEN_NIF_RESULTADO',
            variacion_bruta_bs: variacionBrutaBs,
            requiere_nota_debito_fiscal: esFiscalEstricto,
            enviar_a_nd_en_transito_cxp: false,
            base_imponible_nd_bs: esFiscalEstricto ? baseNdBs : 0,
            iva_nd_bs: esFiscalEstricto ? ivaNdBs : 0,
            diferencial_financiero_islr_bs: esFiscalEstricto ? baseNdBs : variacionBrutaBs
        };
    }

    // CXP: JAMÁS autogenerar Crédito Fiscal IVA sin ND del proveedor
    return {
        modulo: 'CXP',
        regimen_aplicado: modo,
        variacion_bruta_bs: variacionBrutaBs,
        requiere_nota_debito_fiscal: false,
        enviar_a_nd_en_transito_cxp: Boolean(esOperacionGravada && alic > 0 && variacionBrutaBs > 0),
        base_imponible_nd_bs: variacionBrutaBs > 0 ? baseNdBs : 0,
        iva_nd_bs: variacionBrutaBs > 0 ? ivaNdBs : 0,
        diferencial_financiero_islr_bs: variacionBrutaBs
    };
}

/**
 * Anticipos Bimoneda: INDEXADO_USD (mantiene poder adquisitivo) vs NOMINAL_BS (mantiene nominal en Bs).
 */
function calcularCruceAnticipoBimoneda({
    saldoDisponibleUsd = 0,
    saldoDisponibleBs = 0,
    tasaOriginal = 1,
    modalidadContrato = 'INDEXADO_USD',
    tasaCruce = 1,
    montoObjetivoUsd = 0
} = {}) {
    const mod = String(modalidadContrato || 'INDEXADO_USD').toUpperCase();
    const tOrig = Math.max(0.0001, Number(tasaOriginal || 1));
    const tCruce = Math.max(0.0001, Number(tasaCruce || 1));
    const objetivoUsd = Math.max(0, round2(montoObjetivoUsd));

    if (mod === 'NOMINAL_BS') {
        const dispBs = Math.max(0, round2(saldoDisponibleBs));
        const maxAplicableUsd = round2(dispBs / tCruce);
        const aplicadoUsd = objetivoUsd > 0 ? Math.min(objetivoUsd, maxAplicableUsd) : maxAplicableUsd;
        const aplicadoBs = round2(aplicadoUsd * tCruce);
        const equivalenteOriginalUsd = round2(aplicadoBs / tOrig);
        return {
            modalidad_contrato: 'NOMINAL_BS',
            aplicado_usd: aplicadoUsd,
            aplicado_bs: aplicadoBs,
            diferencia_devaluacion_usd: round2(equivalenteOriginalUsd - aplicadoUsd),
            nuevo_saldo_disponible_bs: round2(Math.max(0, dispBs - aplicadoBs)),
            nuevo_saldo_disponible_usd: round2(Math.max(0, (dispBs - aplicadoBs) / tCruce))
        };
    }

    const dispUsd = Math.max(0, round2(saldoDisponibleUsd));
    const aplicadoUsd = objetivoUsd > 0 ? Math.min(objetivoUsd, dispUsd) : dispUsd;
    const aplicadoBs = round2(aplicadoUsd * tCruce);
    const reexpresionBs = round2(aplicadoUsd * (tCruce - tOrig));
    const nuevoSaldoUsd = round2(Math.max(0, dispUsd - aplicadoUsd));
    return {
        modalidad_contrato: 'INDEXADO_USD',
        aplicado_usd: aplicadoUsd,
        aplicado_bs: aplicadoBs,
        diferencia_reexpresion_bs: reexpresionBs,
        nuevo_saldo_disponible_usd: nuevoSaldoUsd,
        nuevo_saldo_disponible_bs: round2(nuevoSaldoUsd * tCruce)
    };
}

/**
 * Partición Tripartita Cashea (BNPL).
 */
function calcularParticionCashea({
    montoTotalUsd = 0,
    montoInicialUsd = 0,
    comisionPct = 6.5,
    tasaBcv = 1
} = {}) {
    const total = Math.max(0, round2(montoTotalUsd));
    const inicial = Math.min(total, Math.max(0, round2(montoInicialUsd)));
    const financiadoCasheaUsd = round2(total - inicial);
    const comisionUsd = round2(total * (Math.max(0, Number(comisionPct || 0)) / 100));
    const netoLiquidarPorCasheaUsd = round2(Math.max(0, financiadoCasheaUsd - comisionUsd));
    const tasa = Math.max(0.0001, Number(tasaBcv || 1));

    return {
        total_venta_usd: total,
        inicial_cliente_usd: inicial,
        inicial_cliente_bs: round2(inicial * tasa),
        saldo_cxc_cashea_usd: financiadoCasheaUsd,
        saldo_cxc_cashea_bs: round2(financiadoCasheaUsd * tasa),
        comision_cashea_usd: comisionUsd,
        comision_cashea_bs: round2(comisionUsd * tasa),
        neto_esperado_plataforma_usd: netoLiquidarPorCasheaUsd
    };
}

/**
 * Clasificación Aging (Antigüedad de Saldos): POR_VENCER, 0_30, 31_60, 61_90, MAS_90.
 */
function calcularAgingDocumento({ fechaEmision = '', fechaVencimiento = '', diasCredito = 15, fechaCorte = '' } = {}) {
    const corteStr = String(fechaCorte || obtenerHoyCaracasISO()).slice(0, 10);
    const emiStr = String(fechaEmision || corteStr).slice(0, 10);
    let venceStr = String(fechaVencimiento || '').slice(0, 10);

    const parseUtc = (s) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (!m) return null;
        return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    };

    const tEmi = parseUtc(emiStr) || parseUtc(corteStr);
    const diasCred = Math.max(0, parseInt(diasCredito, 10) || 0);
    if (!venceStr && tEmi) {
        venceStr = new Date(tEmi + (diasCred * 86400000)).toISOString().slice(0, 10);
    }
    const tVence = parseUtc(venceStr) || tEmi;
    const tCorte = parseUtc(corteStr) || tVence;

    const diasVencido = Math.floor((tCorte - tVence) / 86400000);
    let bucket = 'POR_VENCER';
    if (diasVencido > 90) bucket = 'MAS_90';
    else if (diasVencido > 60) bucket = '61_90';
    else if (diasVencido > 30) bucket = '31_60';
    else if (diasVencido > 0) bucket = '0_30';

    return {
        fecha_vencimiento: venceStr,
        dias_vencido: diasVencido,
        vencida: diasVencido > 0,
        bucket
    };
}

/**
 * Semáforo Financiero BCV para Programación de Pagos CxP.
 */
function calcularSemaforoBcvPago({
    saldoUsd = 0,
    tasaEmision = 1,
    tasaHoy = 1,
    monedaOrigen = 'USD',
    diasVencido = 0,
    descuentoProntoPagoPct = 0
} = {}) {
    const usd = Math.max(0, round2(saldoUsd));
    const tEmi = Math.max(0.0001, Number(tasaEmision || 1));
    const tHoy = Math.max(0.0001, Number(tasaHoy || 1));
    const varPct = round2(((tHoy - tEmi) / tEmi) * 100);
    const ahorroProntoPagoUsd = round2(usd * (Math.max(0, Number(descuentoProntoPagoPct || 0)) / 100));

    if (diasVencido > 15) {
        return {
            color: 'ROJO',
            codigo: 'URGENTE_MORA',
            etiqueta: 'URGENTE / MORA (+15d)',
            variacion_bcv_pct: varPct,
            ahorro_pronto_pago_usd: ahorroProntoPagoUsd,
            recomendacion: 'Priorizar pago inmediato para evitar bloqueo de despacho o recargos moratorios.'
        };
    }
    if (String(monedaOrigen).toUpperCase() === 'BS' && varPct > 2) {
        return {
            color: 'VERDE',
            codigo: 'PAGAR_BS_VENTAJA',
            etiqueta: 'VENTAJA EN BOLÍVARES',
            variacion_bcv_pct: varPct,
            ahorro_pronto_pago_usd: ahorroProntoPagoUsd,
            recomendacion: `Factura pactada en Bs nominales con depreciación de ${varPct}% frente al BCV: conviene liquidar en Bs.`
        };
    }
    if (ahorroProntoPagoUsd > 0 && diasVencido <= 0) {
        return {
            color: 'VERDE',
            codigo: 'APROVECHAR_PRONTO_PAGO',
            etiqueta: `PRONTO PAGO (${descuentoProntoPagoPct}%)`,
            variacion_bcv_pct: varPct,
            ahorro_pronto_pago_usd: ahorroProntoPagoUsd,
            recomendacion: `Ahorro directo de $ ${ahorroProntoPagoUsd.toFixed(2)} si se liquida dentro del plazo comercial.`
        };
    }
    if (varPct >= 3) {
        return {
            color: 'AMARILLO',
            codigo: 'EXPOSICION_ALZA_BCV',
            etiqueta: `EXPOSICIÓN ALZA (+${varPct}%)`,
            variacion_bcv_pct: varPct,
            ahorro_pronto_pago_usd: 0,
            recomendacion: 'Deuda indexada USD ante subida BCV: liquide con excedente en divisas o cubra en Bs hoy.'
        };
    }
    return {
        color: 'AZUL',
        codigo: 'PROGRAMABLE_NORMAL',
        etiqueta: 'EN PLAZO / NORMAL',
        variacion_bcv_pct: varPct,
        ahorro_pronto_pago_usd: 0,
        recomendacion: 'Mantener en flujo regular según fecha de vencimiento.'
    };
}

/**
 * Desglose Aduanero Importación Forma 80 SENIAT.
 */
function calcularForma80AduanaVE({
    fobUsd = 0,
    fleteUsd = 0,
    seguroUsd = 0,
    tasaAduanaBcv = 1,
    arancelPct = 0,
    tasaServicioPct = 1,
    alicuotaIva = 16
} = {}) {
    const fob = Math.max(0, round2(fobUsd));
    const flete = Math.max(0, round2(fleteUsd));
    const seguro = Math.max(0, round2(seguroUsd));
    const tasa = Math.max(0.0001, Number(tasaAduanaBcv || 1));

    const cifUsd = round2(fob + flete + seguro);
    const cifBs = round2(cifUsd * tasa);
    const arancelBs = round2(cifBs * (Math.max(0, Number(arancelPct || 0)) / 100));
    const tasaServicioBs = round2(cifBs * (Math.max(0, Number(tasaServicioPct || 0)) / 100));
    const baseImponibleAduanaBs = round2(cifBs + arancelBs + tasaServicioBs);
    const ivaAduanaBs = round2(baseImponibleAduanaBs * (Math.max(0, Number(alicuotaIva || 0)) / 100));
    const totalTributosAduanaBs = round2(arancelBs + tasaServicioBs + ivaAduanaBs);

    return {
        fob_usd: fob,
        flete_usd: flete,
        seguro_usd: seguro,
        cif_usd: cifUsd,
        cif_bs: cifBs,
        tasa_aduana_bcv: tasa,
        arancel_pct: Number(arancelPct || 0),
        arancel_bs: arancelBs,
        tasa_servicio_pct: Number(tasaServicioPct || 0),
        tasa_servicio_bs: tasaServicioBs,
        base_imponible_aduana_bs: baseImponibleAduanaBs,
        alicuota_iva: Number(alicuotaIva || 0),
        iva_aduana_bs: ivaAduanaBs,
        total_tributos_aduana_bs: totalTributosAduanaBs
    };
}

/**
 * Manual Técnico SENIAT Forma 99035 — Exportación TXT de Retenciones de IVA (16 columnas exactas separadas por TAB \t, sin encabezados).
 */
function generarTxtRetencionesIvaSENIAT({ rifAgente = '', periodoAAAAMM = '', filas = [] } = {}) {
    const rifAgenteClean = normalizarRifSENIAT(rifAgente, false);
    const periodoClean = String(periodoAAAAMM || '').replace(/[^0-9]/g, '').slice(0, 6);
    const advertencias = [];
    if (!rifAgenteClean) advertencias.push('Falta el RIF de la empresa Agente de Retención.');
    if (periodoClean.length !== 6) advertencias.push('El período debe tener formato AAAAMM.');

    const lineas = [];
    (Array.isArray(filas) ? filas : []).forEach((f, idx) => {
        if (String(f.estatus || '').toUpperCase() === 'ANULADO') return;
        const tipoOp = String(f.tipo_operacion || 'C').toUpperCase() === 'V' ? 'V' : 'C';
        const tipoDocRaw = String(f.tipo_documento || '01').toUpperCase();
        let tipoDoc = '01';
        if (tipoDocRaw === '02' || tipoDocRaw.includes('DEBITO')) tipoDoc = '02';
        else if (tipoDocRaw === '03' || tipoDocRaw.includes('CREDITO')) tipoDoc = '03';

        const fechaDoc = String(f.fecha_documento || f.fecha_emision || '').slice(0, 10);
        const rifSujeto = normalizarRifSENIAT(f.sujeto_rif || f.proveedor_rif || '', false) || 'V000000000';
        const nroDoc = String(f.numero_documento || f.comprobante || '').trim().replace(/\s+/g, '') || `DOC${idx + 1}`;
        const nroCtrl = String(f.numero_control || '').trim().replace(/\s+/g, '') || '0';
        const docAfectado = (tipoDoc === '02' || tipoDoc === '03')
            ? (String(f.documento_afectado || f.factura_afectada || '0').trim() || '0')
            : '0';
        const nroComp = String(f.numero_comprobante || '').trim();
        const expediente = String(f.expediente_importacion || '0').trim() || '0';

        if (!/^\d{14}$/.test(nroComp)) {
            advertencias.push(`Fila ${idx + 1} (${nroDoc}): Comprobante "${nroComp}" no tiene 14 dígitos exactos AAAAMMSSSSSSSS.`);
        }

        const totalBs = round2(f.monto_total_bs || 0).toFixed(2);
        const baseBs = round2(f.base_imponible_bs || 0).toFixed(2);
        const retBs = round2(f.monto_retenido_bs || 0).toFixed(2);
        const exentoBs = round2(f.monto_exento_bs || 0).toFixed(2);
        const alic = round2(f.alicuota_iva !== undefined ? f.alicuota_iva : 16).toFixed(2);

        const cols = [
            rifAgenteClean || 'J000000000',
            periodoClean,
            fechaDoc,
            tipoOp,
            tipoDoc,
            rifSujeto,
            nroDoc,
            nroCtrl,
            totalBs,
            baseBs,
            retBs,
            docAfectado,
            nroComp,
            exentoBs,
            alic,
            expediente
        ];
        lineas.push(cols.join('\t'));
    });

    return {
        contenido: lineas.join('\r\n'),
        cantidadRegistros: lineas.length,
        advertencias
    };
}

/**
 * Manual Técnico XML Retenciones ISLR SENIAT (<RelacionRetencionesISLR>, UTF-8 sin BOM, DD/MM/AAAA).
 */
function generarXmlRetencionesIslrSENIAT({ rifAgente = '', periodoAAAAMM = '', detalles = [] } = {}) {
    const rifAgenteClean = normalizarRifSENIAT(rifAgente, false) || 'J000000000';
    const periodoClean = String(periodoAAAAMM || '').replace(/[^0-9]/g, '').slice(0, 6);
    const escXml = (v) => String(v === null || v === undefined ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const toDdMmYyyy = (iso) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        if (m) return `${m[3]}/${m[2]}/${m[1]}`;
        return String(iso || '');
    };

    const nodos = [];
    const advertencias = [];
    (Array.isArray(detalles) ? detalles : []).forEach((d, idx) => {
        if (String(d.estatus || '').toUpperCase() === 'ANULADO') return;
        const rifRet = normalizarRifSENIAT(d.sujeto_rif || '', false);
        const nroFac = String(d.numero_documento || '').trim() || '0';
        const nroCtrl = String(d.numero_control || '').trim() || '0';
        const fechaOp = toDdMmYyyy(d.fecha_documento || d.fecha_emision);
        const codConc = String(d.codigo_concepto_islr || '053').replace(/[^0-9]/g, '').padStart(3, '0').slice(0, 3);
        const montoOp = round2(d.base_imponible_bs || 0).toFixed(2);
        const pctRet = round2(d.porcentaje_retencion || 0).toFixed(2);

        if (!rifRet) advertencias.push(`Detalle ${idx + 1}: Falta RIF retenido.`);
        nodos.push([
            '  <DetalleRetencion>',
            `    <RifRetenido>${escXml(rifRet)}</RifRetenido>`,
            `    <NumeroFactura>${escXml(nroFac)}</NumeroFactura>`,
            `    <NumeroControl>${escXml(nroCtrl)}</NumeroControl>`,
            `    <FechaOperacion>${escXml(fechaOp)}</FechaOperacion>`,
            `    <CodigoConcepto>${escXml(codConc)}</CodigoConcepto>`,
            `    <MontoOperacion>${montoOp}</MontoOperacion>`,
            `    <PorcentajeRetencion>${pctRet}</PorcentajeRetencion>`,
            '  </DetalleRetencion>'
        ].join('\n'));
    });

    const xml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<RelacionRetencionesISLR RifAgente="${escXml(rifAgenteClean)}" Periodo="${escXml(periodoClean)}">`,
        ...nodos,
        '</RelacionRetencionesISLR>'
    ].join('\n');

    return {
        contenido: xml,
        cantidadRegistros: nodos.length,
        advertencias
    };
}

/**
 * Reutiliza generarTxtDispersionBancariaVE de services/nomina-ve.js para dispersión bancaria masiva CxP.
 */
function generarTxtPagosProveedoresVE({ bancoFormato = 'BANESCO', empresa = {}, fechaEjecucion = '', pagos = [], codigoLote = '' } = {}) {
    const detallesMapeados = (Array.isArray(pagos) ? pagos : []).map((p, idx) => ({
        empleado_cedula: normalizarRifSENIAT(p.rif_titular_cuenta || p.proveedor_rif || p.rif || '', false),
        numero_cuenta: String(p.cuenta_bancaria || '').replace(/\D/g, ''),
        empleado_nombre: p.proveedor_nombre || p.razon || p.nombre || `PROVEEDOR_${idx + 1}`,
        banco: p.banco_nombre || p.banco_codigo || bancoFormato,
        neto_bs: round2(p.neto_bs || p.monto_bs || 0),
        neto_usd: round2(p.neto_usd || p.monto_usd || 0),
        tasa_bcv: Number(p.tasa_bcv || 1)
    }));

    return generarTxtDispersionBancariaVE({
        bancoFormato,
        empresa,
        periodo: {
            fecha_fin: fechaEjecucion || obtenerHoyCaracasISO(),
            codigo: codigoLote || `CXP-${obtenerHoyCaracasISO().replace(/-/g, '')}`,
            titulo: `LOTE PAGOS ${codigoLote || ''}`.trim()
        },
        detalles: detallesMapeados,
        conceptoPrefijo: 'PROVEEDOR'
    });
}

/**
 * Fusiona extensiones de columnas sobre tablas existentes sin sobrescribir definiciones originales.
 */
function aplicarExtensionesEsquemaCxcCxp(esquemaBase) {
    if (!esquemaBase) return esquemaBase;
    const pares = [
        ['clientes_locales', ESQUEMA_EXTENSION_COLUMNAS_CXC_CXP.clientes],
        ['clientes_maestro', ESQUEMA_EXTENSION_COLUMNAS_CXC_CXP.clientes],
        ['cuentas_por_cobrar', ESQUEMA_EXTENSION_COLUMNAS_CXC_CXP.cuentas_por_cobrar],
        ['abonos_cuentas_cobrar', ESQUEMA_EXTENSION_COLUMNAS_CXC_CXP.abonos_cuentas_cobrar],
        ['proveedores', ESQUEMA_EXTENSION_COLUMNAS_CXC_CXP.proveedores],
        ['movimientos_cuentas_pagar', ESQUEMA_EXTENSION_COLUMNAS_CXC_CXP.movimientos_cuentas_pagar]
    ];
    for (const [tabla, extraCols] of pares) {
        if (esquemaBase[tabla]) {
            Object.assign(esquemaBase[tabla], extraCols);
        }
    }
    Object.assign(esquemaBase, ESQUEMA_TABLAS_AVANZADAS_CXC_CXP);
    return esquemaBase;
}

/**
 * Obtiene siguiente correlativo oficial de 14 dígitos AAAAMMSSSSSSSS de manera atómica en SQLite.
 */
function obtenerSiguienteComprobante14Db(conn, companyId, tipo = 'IVA', fechaRef = '') {
    const cleanFecha = String(fechaRef || obtenerHoyCaracasISO());
    const aaaamm = cleanFecha.slice(0, 7).replace(/[^0-9]/g, '') || obtenerHoyCaracasISO().slice(0, 7).replace('-', '');
    const tipoUp = String(tipo || 'IVA').toUpperCase();
    const clave = `${companyId}::${tipoUp}::${aaaamm}`;

    const actual = conn.prepare(`SELECT ultimo_consecutivo FROM correlativos_retenciones_ve WHERE clave = ?`).get(clave);
    const siguiente = (actual ? Number(actual.ultimo_consecutivo || 0) : 0) + 1;
    conn.prepare(`
        INSERT INTO correlativos_retenciones_ve (clave, company_id, tipo, periodo_aaaamm, ultimo_consecutivo)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(clave) DO UPDATE SET
            ultimo_consecutivo = excluded.ultimo_consecutivo,
            fecha_actualizacion = datetime('now', '-4 hours')
    `).run(clave, companyId, tipoUp, aaaamm, siguiente);

    return {
        periodo_aaaamm: aaaamm,
        consecutivo: siguiente,
        numero_comprobante: construirComprobante14Digitos(aaaamm, siguiente)
    };
}

module.exports = {
    CONSTANTES_FISCALES_VE,
    CATALOGO_CONCEPTOS_ISLR,
    CATEGORIAS_GASTOS_OPERATIVOS,
    CATALOGO_BANCOS_VE,
    ESQUEMA_EXTENSION_COLUMNAS_CXC_CXP,
    ESQUEMA_TABLAS_AVANZADAS_CXC_CXP,
    aplicarExtensionesEsquemaCxcCxp,
    round2,
    round4,
    obtenerHoyCaracasISO,
    formatearHoraSNAT2026,
    normalizarRifSENIAT,
    clasificarPersonaPorRif,
    construirComprobante14Digitos,
    obtenerSiguienteComprobante14Db,
    calcularRetencionIvaVE,
    calcularRetencionIslrDecreto1808,
    calcularPrelacionCobroIgtfVE,
    evaluarAsimetriaDiferencialCambiario,
    calcularCruceAnticipoBimoneda,
    calcularParticionCashea,
    calcularAgingDocumento,
    calcularSemaforoBcvPago,
    calcularForma80AduanaVE,
    generarTxtRetencionesIvaSENIAT,
    generarXmlRetencionesIslrSENIAT,
    generarTxtPagosProveedoresVE
};
