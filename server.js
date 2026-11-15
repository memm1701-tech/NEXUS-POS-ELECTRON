process.env.TZ = 'America/Caracas';

function getCaracasTime() {
    const d = new Date();
    const utcMillis = d.getTime() + (d.getTimezoneOffset() * 60000);
    const cDate = new Date(utcMillis - (4 * 60 * 60 * 1000));
    const pad = (n) => String(n).padStart(2, '0');
    return `${cDate.getFullYear()}-${pad(cDate.getMonth() + 1)}-${pad(cDate.getDate())} ${pad(cDate.getHours())}:${pad(cDate.getMinutes())}:${pad(cDate.getSeconds())}`;
}
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const axios = /** @type {import('axios').AxiosStatic} */ (/** @type {unknown} */ (require('axios')));
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const {
    ESQUEMA_EMPLEADOS_Y_NOMINA,
    construirFiltroEmpresaEmpleados,
    upsertEmpleadoDb,
    upsertMovimientoEmpleadoDb,
    recalcularSaldoEmpleadoDb,
    upsertPrestamoDb,
    upsertAsistenciaDb,
    upsertNominaPeriodoDb
} = require('./services/nomina-ve');
const fiscalCxcCxp = require('./services/contabilidad-fiscal-ve');
const opsCxcCxp = require('./services/operaciones-cxc-cxp');
const estadisticasBi = require('./services/estadisticas-bi');
const tasasGrafica = require('./services/tasas-grafica');

// --- 1. CONFIGURACIÓN DE RUTAS (UNIFICADO CON APPDATA) ---
const dbDir = path.join(process.env.APPDATA, 'nexus-pos', 'data');
const configPath = path.join(dbDir, 'config.json');
const serverDbPath = path.join(dbDir, 'nexus-local-server.db');
const posDbPath = path.join(dbDir, 'nexus_pos.db');

let posDb = null;
function getPosDb() {
    if (!posDb && fs.existsSync(posDbPath)) {
        try {
            posDb = new Database(posDbPath, { timeout: 15000 });
            posDb.pragma('journal_mode = WAL');
            posDb.pragma('busy_timeout = 10000');
        } catch(e) {
            console.error("❌ Error abriendo nexus_pos.db en server.js:", e.message);
        }
    }
    return posDb;
}

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const server = express();
const PORT = 3000;

// Habilitar CORS para que otras computadoras de la red puedan entrar
server.use(cors());
server.use(express.json());

// Endpoint ultraligero de ping para identificación automática de servidor maestro en la red local
server.get('/api/nexus-ping', (req, res) => {
    res.json({
        status: 'ok',
        app: 'NEXUS-POS-SERVER',
        port: PORT,
        serverTime: Date.now()
    });
});

// Configuración de Axios para el BCV (Scraping)
const axiosConfigBCV = {
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
};

// 2. CARGA DE CONFIGURACIÓN
let config = { isServer: false };
let cajasEscuchando = [];
if (fs.existsSync(configPath)) {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        console.error("Error al leer config.json:", error.message);
    }
}

// --- 3. LÓGICA DEL SERVIDOR MAESTRO ---
if (config.isServer) {
    const serverDb = new Database(serverDbPath, { timeout: 15000 });
    serverDb.pragma('journal_mode = WAL');
    serverDb.pragma('busy_timeout = 10000');
    getPosDb();
    
    // Inicialización de Tablas Maestras automatizada con ESQUEMA_MAESTRO
    const ESQUEMA_MAESTRO = {
        stock_maestro: { producto_id: "TEXT", sucursal_id: "TEXT", company_id: "TEXT", cantidad_real: "REAL DEFAULT 0", ultima_sincronizacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))", "PRIMARY KEY": "(producto_id, sucursal_id)" },
        movimientos_stock_maestro: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", company_id: "TEXT NOT NULL", sucursal_id: "TEXT", producto_id: "TEXT NOT NULL", cantidad: "REAL DEFAULT 0", tipo_movimiento: "TEXT", fecha_movimiento: "DATETIME DEFAULT (datetime('now', '-4 hours'))", referencia_id: "TEXT", estado_sync: "INTEGER DEFAULT 0" },
        correlativos_maestros: { tipo: "TEXT PRIMARY KEY", prefijo: "TEXT DEFAULT ''", ultimo_numero: "INTEGER DEFAULT 0", correlativo_nc_actual: "INTEGER DEFAULT 0" },
        clientes_maestro: { rif: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT NOT NULL", direccion: "TEXT", telefono: "TEXT", correo: "TEXT", datos_json: "TEXT", es_contribuyente_especial: "INTEGER DEFAULT 0", status: "INTEGER DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))", saldo_deuda: "REAL DEFAULT 0", saldo_deuda_usd: "REAL DEFAULT 0" },
        cuentas_por_cobrar: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", company_id: "TEXT", branch_id: "TEXT", cliente_id: "TEXT", cliente_rif: "TEXT", rif_cliente: "TEXT", cliente_nombre: "TEXT", monto_bs: "REAL DEFAULT 0", monto_usd: "REAL DEFAULT 0", tasa_emision: "REAL DEFAULT 0", monto: "REAL DEFAULT 0", factura_nro: "TEXT", monto_pagado: "REAL DEFAULT 0", fecha: "TEXT", estado: "TEXT DEFAULT 'PENDIENTE'", concepto: "TEXT", tipo_movimiento: "TEXT", metodo_pago: "TEXT", referencia: "TEXT", estado_sync: "INTEGER DEFAULT 0" },
        abonos_cuentas_cobrar: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cuenta_id: "INTEGER", factura_nro: "TEXT", cliente_id: "TEXT", cliente_nombre: "TEXT", monto_bs: "REAL DEFAULT 0", monto_usd: "REAL DEFAULT 0", tasa_bcv: "REAL DEFAULT 1", metodo_pago: "TEXT DEFAULT 'EFECTIVO'", referencia: "TEXT DEFAULT ''", nota: "TEXT DEFAULT ''", usuario: "TEXT DEFAULT ''", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estado_sync: "INTEGER DEFAULT 0" },
        facturas_borradores: { id: "TEXT PRIMARY KEY", cliente_nombre: "TEXT", cliente_id: "TEXT", items: "TEXT", subtotal: "REAL DEFAULT 0", iva: "REAL DEFAULT 0", total: "REAL DEFAULT 0", metodos_pago: "TEXT", fecha: "INTEGER", usuario_id: "TEXT", sucursal_id: "TEXT", company_id: "TEXT" },
        cierres_caja_maestros: { id: "TEXT PRIMARY KEY", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", total_ventas_bs: "REAL DEFAULT 0", total_ventas_usd: "REAL DEFAULT 0", total_gastos_bs: "REAL DEFAULT 0", total_gastos_usd: "REAL DEFAULT 0", total_ingresos_bs: "REAL DEFAULT 0", total_diferencia_bs: "REAL DEFAULT 0", total_diferencia_usd: "REAL DEFAULT 0", detalle_pagos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },
        reportes_fiscales_cierre: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", tipo_reporte: "TEXT", numero_z: "TEXT", fecha_emision: "TEXT", hora_emision: "TEXT", ultima_factura: "TEXT", exento: "REAL DEFAULT 0", base_imponible_tasa_1: "REAL DEFAULT 0", impuesto_tasa_1: "REAL DEFAULT 0", base_imponible_tasa_2: "REAL DEFAULT 0", impuesto_tasa_2: "REAL DEFAULT 0", base_imponible_tasa_3: "REAL DEFAULT 0", impuesto_tasa_3: "REAL DEFAULT 0", igtf: "REAL DEFAULT 0", raw_data: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_registro: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },
        movimientos_caja_locales: { id: "TEXT PRIMARY KEY", tipo: "TEXT", concepto: "TEXT", monto: "REAL DEFAULT 0", monto_usd: "REAL DEFAULT 0", metodo_pago: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", cashier_id: "TEXT", company_id: "TEXT", branch_id: "TEXT", estado_cierre: "INTEGER DEFAULT 0" },
        ventas_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_factura: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", monto_exento: "REAL DEFAULT 0", base_imponible: "REAL DEFAULT 0", monto_iva: "REAL DEFAULT 0", total_iva: "REAL DEFAULT 0", monto_igtf: "REAL DEFAULT 0", monto_total: "REAL DEFAULT 0", tasa_bcv: "REAL DEFAULT 1", metodo_pago: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", estado_sync_maestro: "INTEGER DEFAULT 1", sync_server: "INTEGER DEFAULT 0", fecha_emision: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estado_cierre: "INTEGER DEFAULT 0", es_nota_credito: "INTEGER DEFAULT 0", es_nota_debito: "INTEGER DEFAULT 0", factura_afectada: "TEXT", monto_factura_afectada: "REAL DEFAULT 0", fecha_factura_afectada: "TEXT", comprobante_retencion_id: "TEXT DEFAULT NULL", ganancia_venta: "REAL DEFAULT 0", estado: "TEXT DEFAULT 'EMITIDA'", es_anulada: "INTEGER DEFAULT 0", alicuota_iva: "REAL DEFAULT 16", ventas_exportacion: "REAL DEFAULT 0", iva_retenido_cliente: "REAL DEFAULT 0", numero_comprobante_retencion_cliente: "TEXT DEFAULT ''", fecha_retencion_cliente: "TEXT DEFAULT ''", ultima_sincronizacion: "TEXT DEFAULT NULL" },
        presupuestos_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_presupuesto: "TEXT UNIQUE", cliente_nombre: "TEXT", cliente_rif: "TEXT", cliente_direccion: "TEXT", cliente_telefono: "TEXT", subtotal: "REAL DEFAULT 0", monto_iva: "REAL DEFAULT 0", monto_total: "REAL DEFAULT 0", tasa_bcv: "REAL DEFAULT 1", moneda: "TEXT DEFAULT 'USD'", validez_dias: "INTEGER DEFAULT 1", estado: "TEXT DEFAULT 'EMITIDO'", fecha_emision: "DATETIME DEFAULT (datetime('now', '-4 hours'))", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0" },
        configuraciones_maestras: { clave: "TEXT PRIMARY KEY", valor: "TEXT" },
        auditoria_fiscal: { id: "TEXT PRIMARY KEY", usuario: "TEXT", accion: "TEXT", valores: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },
        metodos_pago_maestro: { id: "TEXT PRIMARY KEY", nombre: "TEXT NOT NULL", tecla: "TEXT", tipo_moneda: "TEXT DEFAULT 'BS'", naturaleza: "TEXT DEFAULT 'CONTADO'", activo: "INTEGER DEFAULT 1", flag_impresora: "TEXT DEFAULT '00'" },
        claves_admin_maestras: { id: "TEXT PRIMARY KEY", ownerName: "TEXT", encryptedCode: "TEXT", company_id: "TEXT", created_by: "TEXT", updatedAt: "DATETIME DEFAULT (datetime('now', '-4 hours'))", permisos: "TEXT", is_master: "INTEGER DEFAULT 0", code_hash: "TEXT" },
        guia_despacho: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_guia: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", factura_asociada: "TEXT", fecha_emision: "DATETIME DEFAULT (datetime('now', '-4 hours'))", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0" },
        guias_despacho: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_guia: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", factura_asociada: "TEXT", datos_json: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },
        ...ESQUEMA_EMPLEADOS_Y_NOMINA,
        proveedores: { rif: "TEXT PRIMARY KEY", id: "TEXT", company_id: "TEXT", nombre: "TEXT", telefono: "TEXT", contacto: "TEXT", direccion: "TEXT", correo: "TEXT", saldo_deuda: "REAL DEFAULT 0", status: "INTEGER DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },
        movimientos_cuentas_pagar: { id: "TEXT PRIMARY KEY", company_id: "TEXT", proveedor_id: "TEXT", proveedor_rif: "TEXT", monto: "REAL DEFAULT 0", motivo: "TEXT", razon: "TEXT", nota: "TEXT", comprobante: "TEXT", estado: "TEXT DEFAULT 'PENDIENTE'", monto_abonado: "REAL DEFAULT 0", metodo_pago: "TEXT", referencia: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estado_sync: "INTEGER DEFAULT 0", contenido_fac: "TEXT", numero_control: "TEXT DEFAULT ''", tipo_documento: "TEXT DEFAULT 'FACTURA'", tipo_transaccion: "TEXT DEFAULT '01-REGISTRO'", nota_credito_nro: "TEXT DEFAULT ''", nota_debito_nro: "TEXT DEFAULT ''", factura_afectada: "TEXT DEFAULT ''", es_gasto_operativo: "INTEGER DEFAULT 0", categoria_gasto: "TEXT DEFAULT ''", es_importacion: "INTEGER DEFAULT 0", planilla_importacion: "TEXT DEFAULT ''", expediente_importacion: "TEXT DEFAULT ''", tasa_bcv: "REAL DEFAULT 1", monto_bs: "REAL DEFAULT 0", monto_exento: "REAL DEFAULT 0", base_imponible: "REAL DEFAULT 0", alicuota_iva: "REAL DEFAULT 16", monto_iva: "REAL DEFAULT 0", iva_retenido: "REAL DEFAULT 0", porcentaje_retencion: "REAL DEFAULT 0", comprobante_retencion: "TEXT DEFAULT ''", fecha_retencion: "TEXT DEFAULT ''" },
        productos_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", codigo: "TEXT", nombre: "TEXT", precio: "REAL DEFAULT 0", precio_compra: "REAL DEFAULT 0", porcentaje_ganancia: "REAL DEFAULT 0", categoria: "TEXT", status: "INTEGER DEFAULT 1", imagen: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },
        categorias_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", status: "INTEGER DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },
        sucursales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", direccion: "TEXT", telefono: "TEXT", status: "INTEGER DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "TEXT" },
        unidades_empaque: { id: "TEXT PRIMARY KEY", company_id: "TEXT", product_id: "TEXT", nombre_producto: "TEXT DEFAULT ''", nombre_unidad: "TEXT", tipo_medida: "TEXT", factor_cantidad: "REAL DEFAULT 1", status: "INTEGER DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))", ultima_sincronizacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },
        historial_tasas: { fecha: "DATE PRIMARY KEY", valor: "DECIMAL(18, 8) DEFAULT 0", fuente: "TEXT DEFAULT 'BCV'", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },
        ...tasasGrafica.ESQUEMA_GRAFICA_TASAS,
        comprobantes_retencion: { id: "TEXT PRIMARY KEY", datos_json: "TEXT", fecha_registro: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estatus: "TEXT DEFAULT 'EMITIDO'" },
        salidas_inventario: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", product_id: "TEXT", cantidad: "REAL DEFAULT 0", unidad: "TEXT", motivo: "TEXT", observacion: "TEXT", usuario_id: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },
        entradas_inventario: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", product_id: "TEXT", cantidad: "REAL DEFAULT 0", costo_unitario: "REAL DEFAULT 0", precio_venta: "REAL DEFAULT 0", proveedor_id: "TEXT", factura_referencia: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" }
    };

    function asegurarEsquema(dbConnection, esquema) {
        if (!dbConnection) return;
        for (const [tabla, columnas] of Object.entries(esquema)) {
            const colDefs = [];
            for (const [colName, colType] of Object.entries(columnas)) {
                if (colName === "PRIMARY KEY" || colName === "FOREIGN KEY") {
                    colDefs.push(`${colName} ${colType}`);
                } else {
                    colDefs.push(`${colName} ${colType}`);
                }
            }
            const createQuery = `CREATE TABLE IF NOT EXISTS ${tabla} (${colDefs.join(", ")})`;
            dbConnection.exec(createQuery);

            const tableInfo = dbConnection.prepare(`PRAGMA table_info(${tabla})`).all();
            const columnasExistentes = tableInfo.map(col => col.name);

            for (const [colName, colType] of Object.entries(columnas)) {
                if (colName === "PRIMARY KEY" || colName === "FOREIGN KEY") continue;

                if (!columnasExistentes.includes(colName)) {
                    let cleanType = colType
                        .replace(/PRIMARY KEY/gi, "")
                        .replace(/UNIQUE/gi, "")
                        .replace(/CHECK\s*\([^)]*\)/gi, "")
                        .trim();
                    
                    if (/NOT\s+NULL/i.test(cleanType) && !/DEFAULT/i.test(cleanType)) {
                        cleanType = cleanType.replace(/NOT\s+NULL/gi, "").trim();
                    }

                    // SQLite no permite non-constant defaults (CURRENT_TIMESTAMP, CURRENT_DATE, etc.) en ALTER TABLE ADD COLUMN
                    const hasDynamicDefault = /DEFAULT\s+(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|\(datetime\(.*?\)\)|\(strftime\(.*?\)\))/i.test(cleanType);
                    if (hasDynamicDefault) {
                        cleanType = cleanType.replace(/DEFAULT\s+(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|\(datetime\(.*?\)\)|\(strftime\(.*?\)\))/gi, "").trim();
                    }

                    const alterQuery = `ALTER TABLE ${tabla} ADD COLUMN ${colName} ${cleanType}`;
                    try {
                        dbConnection.prepare(alterQuery).run();
                        if (hasDynamicDefault) {
                            try {
                                dbConnection.prepare(`UPDATE ${tabla} SET ${colName} = datetime('now', '-4 hours') WHERE ${colName} IS NULL`).run();
                            } catch (eUp) {
                                console.warn(`[DB AUTO-SYNC] Aviso backfill '${colName}' en '${tabla}':`, eUp.message);
                            }
                        }
                        console.log(`[DB AUTO-SYNC] Columna añadida: '${colName}' (${cleanType}) en la tabla '${tabla}'`);
                    } catch (error) {
                        console.error(`[DB AUTO-SYNC] Error añadiendo columna '${colName}' a '${tabla}':`, error.message);
                    }
                }
            }
        }
    }

    fiscalCxcCxp.aplicarExtensionesEsquemaCxcCxp(ESQUEMA_MAESTRO);
    asegurarEsquema(serverDb, ESQUEMA_MAESTRO);

    try {
        serverDb.exec(`
            CREATE INDEX IF NOT EXISTS idx_ventas_cierre_compuesto ON ventas_locales(company_id, branch_id, cashier_id, estado_cierre);
            CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas_locales(fecha_emision);
            CREATE INDEX IF NOT EXISTS idx_ventas_factura ON ventas_locales(numero_factura);
            CREATE INDEX IF NOT EXISTS idx_ventas_estado ON ventas_locales(estado);
            CREATE INDEX IF NOT EXISTS idx_ventas_sync_server ON ventas_locales(sync_server);
            CREATE INDEX IF NOT EXISTS idx_movimientos_cierre ON movimientos_caja_locales(company_id, tipo, estado_cierre);
            CREATE INDEX IF NOT EXISTS idx_movimientos_fecha ON movimientos_caja_locales(fecha);
            CREATE INDEX IF NOT EXISTS idx_presupuestos_nro ON presupuestos_locales(numero_presupuesto);
            CREATE INDEX IF NOT EXISTS idx_presupuestos_empresa ON presupuestos_locales(company_id, estado);
            CREATE INDEX IF NOT EXISTS idx_cxc_empresa ON cuentas_por_cobrar(company_id, estado);
            CREATE INDEX IF NOT EXISTS idx_abonos_cxc_factura ON abonos_cuentas_cobrar(factura_nro, company_id);
            CREATE INDEX IF NOT EXISTS idx_abonos_cxc_cliente ON abonos_cuentas_cobrar(cliente_id, company_id);
            CREATE INDEX IF NOT EXISTS idx_cxp_movs_fecha_empresa ON movimientos_cuentas_pagar(company_id, fecha);
            CREATE INDEX IF NOT EXISTS idx_retenciones_emitidas_comp ON retenciones_emitidas(company_id, tipo_impuesto, periodo_aaaamm);
            CREATE INDEX IF NOT EXISTS idx_notas_ajuste_comp ON notas_ajuste_cambiario(company_id, modulo, estado);
            CREATE INDEX IF NOT EXISTS idx_anticipos_comp ON anticipos_saldos_favor(company_id, modulo, tercero_rif);
            CREATE INDEX IF NOT EXISTS idx_metodos_pago_maestro_nat ON metodos_pago_maestro(naturaleza, activo);
            ${tasasGrafica.INDICES_GRAFICA_TASAS}
            DROP VIEW IF EXISTS cuentas_por_pagar;
            CREATE VIEW IF NOT EXISTS cuentas_por_pagar AS SELECT * FROM movimientos_cuentas_pagar;
        `);
    } catch(eIdx) {
        console.warn("Aviso creando índices en serverDb:", eIdx.message);
    }

    const WHERE_RIF_CXC_SQL = `(
        REPLACE(UPPER(TRIM(COALESCE(cliente_id, ''))), '-', '') = REPLACE(UPPER(TRIM(?)), '-', '')
        OR REPLACE(UPPER(TRIM(COALESCE(cliente_rif, ''))), '-', '') = REPLACE(UPPER(TRIM(?)), '-', '')
        OR REPLACE(UPPER(TRIM(COALESCE(rif_cliente, ''))), '-', '') = REPLACE(UPPER(TRIM(?)), '-', '')
    )`;

    /** Obtiene la tasa BCV activa consultando las fuentes locales del servidor en orden de frescura. */
    function obtenerTasaActivaServidor(tasaManual = null) {
        const manual = parseFloat(tasaManual);
        if (!isNaN(manual) && manual > 0) return manual;

        const activeDb = getPosDb();
        if (activeDb) {
            try {
                const row = activeDb.prepare("SELECT valor FROM configuracion WHERE clave IN ('TASA_BCV', 'dollarRate') ORDER BY fecha_actualizacion DESC LIMIT 1").get();
                if (row && parseFloat(row.valor) > 0) return parseFloat(row.valor);
            } catch (eCfg) {
                console.warn("⚠️ [TASA] Error leyendo configuracion en posDb:", eCfg.message);
            }
            try {
                const rowHist = activeDb.prepare("SELECT valor FROM historial_tasas ORDER BY fecha DESC LIMIT 1").get();
                if (rowHist && parseFloat(rowHist.valor) > 0) return parseFloat(rowHist.valor);
            } catch (eHist) {
                console.warn("⚠️ [TASA] Error leyendo historial_tasas en posDb:", eHist.message);
            }
        }
        try {
            const rowM = serverDb.prepare("SELECT valor FROM configuraciones_maestras WHERE clave IN ('TASA_BCV', 'dollarRate') LIMIT 1").get();
            if (rowM && parseFloat(rowM.valor) > 0) return parseFloat(rowM.valor);
        } catch (eM) {
            console.warn("⚠️ [TASA] Error leyendo configuraciones_maestras:", eM.message);
        }
        try {
            if (fs.existsSync(configPath)) {
                const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (cfg && parseFloat(cfg.tasa_bcv) > 0) return parseFloat(cfg.tasa_bcv);
            }
        } catch (eJson) {
            console.warn("⚠️ [TASA] Error leyendo config.json:", eJson.message);
        }
        return 1;
    }

    /** Construye filtro de aislamiento por company_id en cuentas_por_cobrar; permite huérfanos solo si la BD es mono-empresa. */
    function construirFiltroEmpresaCxc(companyId, alias = '') {
        if (!companyId || companyId === 'undefined' || companyId === 'null' || String(companyId).trim() === '') {
            return { clause: '1=1', params: [] };
        }
        const compStr = String(companyId).trim();
        const prefix = alias ? `${alias}.` : '';
        try {
            const otraEnCxc = serverDb.prepare(`
                SELECT 1 FROM cuentas_por_cobrar
                WHERE company_id IS NOT NULL AND company_id != '' AND company_id != ?
                LIMIT 1
            `).get(compStr);
            if (otraEnCxc) {
                return { clause: `${prefix}company_id = ?`, params: [compStr] };
            }
            const posDbConn = getPosDb();
            if (posDbConn) {
                const otraEnPos = posDbConn.prepare(`
                    SELECT 1 FROM ventas_locales
                    WHERE company_id IS NOT NULL AND company_id != '' AND company_id != ?
                    LIMIT 1
                `).get(compStr);
                if (otraEnPos) {
                    return { clause: `${prefix}company_id = ?`, params: [compStr] };
                }
            }
        } catch (eFiltro) {
            console.warn("⚠️ [CXC FILTRO] Aviso verificando multi-empresa:", eFiltro.message);
        }
        return {
            clause: `(${prefix}company_id = ? OR ${prefix}company_id IS NULL OR ${prefix}company_id = '')`,
            params: [compStr]
        };
    }

    /** Genera un ID dinámico alfanumérico único por empresa y factura para sincronización segura con el VPS. */
    function generarIdDinamicoCxcServidor(companyId, facturaNro, fallbackId = null) {
        const compClean = String(companyId || 'GEN').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'GEN';
        const facClean = String(facturaNro || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
        const sufijo = fallbackId !== null && fallbackId !== undefined
            ? String(fallbackId)
            : `${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        return facClean ? `CXC-${compClean}-${facClean}-${sufijo}` : `CXC-${compClean}-${sufijo}`;
    }

    /** Repara registros antiguos de cuentas_por_cobrar sin company_id o tasa_emision cruzándolos con ventas y clientes. */
    function migrarCuentasPorCobrarHuerfanas() {
        try {
            serverDb.prepare(`
                UPDATE cuentas_por_cobrar
                SET
                    company_id = COALESCE(NULLIF(company_id, ''), (
                        SELECT v.company_id FROM ventas_locales v
                        WHERE v.numero_factura = cuentas_por_cobrar.factura_nro
                        AND v.company_id IS NOT NULL AND v.company_id != ''
                        LIMIT 1
                    )),
                    branch_id = COALESCE(NULLIF(branch_id, ''), (
                        SELECT v.branch_id FROM ventas_locales v
                        WHERE v.numero_factura = cuentas_por_cobrar.factura_nro
                        AND v.branch_id IS NOT NULL AND v.branch_id != ''
                        LIMIT 1
                    )),
                    tasa_emision = CASE
                        WHEN (tasa_emision IS NULL OR tasa_emision <= 0) THEN COALESCE((
                            SELECT v.tasa_bcv FROM ventas_locales v
                            WHERE v.numero_factura = cuentas_por_cobrar.factura_nro
                            AND v.tasa_bcv > 0
                            LIMIT 1
                        ), tasa_emision)
                        ELSE tasa_emision
                    END
                WHERE (company_id IS NULL OR company_id = '' OR tasa_emision IS NULL OR tasa_emision <= 0)
                AND factura_nro IS NOT NULL AND factura_nro != ''
            `).run();

            const posDbConn = getPosDb();
            if (posDbConn) {
                const huerfanas = serverDb.prepare(`
                    SELECT id, factura_nro, cliente_id, cliente_rif, rif_cliente
                    FROM cuentas_por_cobrar
                    WHERE (company_id IS NULL OR company_id = '' OR tasa_emision IS NULL OR tasa_emision <= 0)
                `).all();

                if (huerfanas.length > 0) {
                    const buscarVentaPos = posDbConn.prepare(`
                        SELECT company_id, branch_id, tasa_bcv FROM ventas_locales
                        WHERE numero_factura = ? AND (company_id IS NOT NULL AND company_id != '')
                        ORDER BY fecha_emision DESC LIMIT 1
                    `);
                    const buscarCliPos = posDbConn.prepare(`
                        SELECT company_id FROM clientes_locales
                        WHERE REPLACE(UPPER(TRIM(rif)), '-', '') = REPLACE(UPPER(TRIM(?)), '-', '')
                        AND company_id IS NOT NULL AND company_id != ''
                        LIMIT 1
                    `);
                    const upd = serverDb.prepare(`
                        UPDATE cuentas_por_cobrar
                        SET
                            company_id = COALESCE(NULLIF(company_id, ''), ?),
                            branch_id = COALESCE(NULLIF(branch_id, ''), ?),
                            tasa_emision = CASE WHEN (tasa_emision IS NULL OR tasa_emision <= 0) AND ? > 0 THEN ? ELSE tasa_emision END
                        WHERE id = ?
                    `);
                    serverDb.transaction(() => {
                        for (const h of huerfanas) {
                            let cId = null;
                            let bId = null;
                            let tEm = 0;
                            if (h.factura_nro) {
                                const v = buscarVentaPos.get(h.factura_nro);
                                if (v) {
                                    cId = v.company_id || null;
                                    bId = v.branch_id || null;
                                    tEm = parseFloat(v.tasa_bcv || 0);
                                }
                            }
                            if (!cId) {
                                const rifRef = h.cliente_id || h.cliente_rif || h.rif_cliente;
                                if (rifRef) {
                                    const cli = buscarCliPos.get(rifRef);
                                    if (cli) cId = cli.company_id || null;
                                }
                            }
                            if (cId || bId || tEm > 0) {
                                upd.run(cId, bId, tEm, tEm, h.id);
                            }
                        }
                    })();
                }
            }

            serverDb.prepare(`
                UPDATE cuentas_por_cobrar
                SET company_id = (
                    SELECT c.company_id FROM clientes_maestro c
                    WHERE REPLACE(UPPER(TRIM(c.rif)), '-', '') = REPLACE(UPPER(TRIM(COALESCE(cuentas_por_cobrar.cliente_id, cuentas_por_cobrar.cliente_rif, cuentas_por_cobrar.rif_cliente))), '-', '')
                    AND c.company_id IS NOT NULL AND c.company_id != ''
                    LIMIT 1
                )
                WHERE (company_id IS NULL OR company_id = '')
            `).run();

            serverDb.prepare(`
                UPDATE cuentas_por_cobrar
                SET tasa_emision = ROUND(monto_bs / monto_usd, 4)
                WHERE (tasa_emision IS NULL OR tasa_emision <= 0) AND monto_bs > 0 AND monto_usd > 0
            `).run();

            const sinRefDinamica = serverDb.prepare(`
                SELECT id, company_id, factura_nro, referencia
                FROM cuentas_por_cobrar
            `).all().filter(r => {
                const ref = String(r.referencia || '').trim();
                return !ref || /^\d+$/.test(ref);
            });
            if (sinRefDinamica.length > 0) {
                const updRef = serverDb.prepare(`
                    UPDATE cuentas_por_cobrar
                    SET referencia = ?, concepto = COALESCE(NULLIF(concepto, ''), ?), estado_sync = 0
                    WHERE id = ?
                `);
                serverDb.transaction(() => {
                    for (const r of sinRefDinamica) {
                        const refDinamica = generarIdDinamicoCxcServidor(r.company_id, r.factura_nro, r.id);
                        updRef.run(refDinamica, refDinamica, r.id);
                    }
                })();
            }
        } catch (eMig) {
            console.warn("⚠️ [MIGRACION CXC] Aviso al reparar huérfanos:", eMig.message);
        }
    }

    /** Recalcula saldo_deuda_usd y saldo_deuda en Bs (a tasa activa) para un cliente en clientes_maestro. */
    function recalcularSaldoClienteMaestro(rif, companyId = null, tasaActualOverride = null) {
        if (!rif) return { saldoUsd: 0, saldoBs: 0 };
        const rate = (tasaActualOverride && tasaActualOverride > 0) ? parseFloat(tasaActualOverride) : obtenerTasaActivaServidor();
        const filtroEmp = construirFiltroEmpresaCxc(companyId);

        const rowUsd = serverDb.prepare(`
            SELECT COALESCE(SUM(
                CASE
                    WHEN (COALESCE(monto_usd, 0) - COALESCE(monto_pagado, 0)) > 0.01
                    THEN (COALESCE(monto_usd, 0) - COALESCE(monto_pagado, 0))
                    ELSE 0
                END
            ), 0) AS total_usd
            FROM cuentas_por_cobrar
            WHERE ${WHERE_RIF_CXC_SQL}
              AND UPPER(TRIM(COALESCE(estado, ''))) NOT IN ('PAGADA', 'PAGADO')
              AND ${filtroEmp.clause}
        `).get(rif, rif, rif, ...filtroEmp.params);

        const saldoUsd = parseFloat((rowUsd ? (rowUsd.total_usd || 0) : 0).toFixed(2));
        const saldoBs = parseFloat((saldoUsd * rate).toFixed(2));

        serverDb.prepare(`
            UPDATE clientes_maestro
            SET saldo_deuda_usd = ?, saldo_deuda = ?, estado_sync = 0
            WHERE REPLACE(UPPER(TRIM(rif)), '-', '') = REPLACE(UPPER(TRIM(?)), '-', '')
        `).run(saldoUsd, saldoBs, rif);

        return { saldoUsd, saldoBs };
    }

    migrarCuentasPorCobrarHuerfanas();


const checkCorr = serverDb.prepare("SELECT COUNT(*) as count FROM correlativos_maestros").get();

const checkPagos = serverDb.prepare("SELECT COUNT(*) as count FROM metodos_pago_maestro").get();
if (checkPagos.count === 0) {
    console.log("⚠️ Inicializando métodos de pago por defecto...");
    const defaultMethods = [
        { id: '1000001', nombre: 'Efectivo', tecla: 'F5', tipo_moneda: 'BS', naturaleza: 'CONTADO', activo: 1, flag_impresora: '01' },
        { id: '1000002', nombre: 'Débito', tecla: 'F6', tipo_moneda: 'BS', naturaleza: 'CONTADO', activo: 1, flag_impresora: '12' },
        { id: '1000003', nombre: 'Pago Móvil', tecla: 'F7', tipo_moneda: 'BS', naturaleza: 'CONTADO', activo: 1, flag_impresora: '07' },
        { id: '1000004', nombre: 'Biopago', tecla: 'F8', tipo_moneda: 'BS', naturaleza: 'CONTADO', activo: 1, flag_impresora: '08' },
        { id: '1000005', nombre: 'Dólares Físicos', tecla: 'F9', tipo_moneda: 'USD', naturaleza: 'CONTADO', activo: 1, flag_impresora: '20' },
        { id: '1000008', nombre: 'Crédito', tecla: 'F12', tipo_moneda: 'BS', naturaleza: 'CREDITO', activo: 1, flag_impresora: '08' }
    ];
    const stmtPagos = serverDb.prepare(`INSERT INTO metodos_pago_maestro (id, nombre, tecla, tipo_moneda, naturaleza, activo, flag_impresora) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    serverDb.transaction(() => {
        for (const m of defaultMethods) {
            stmtPagos.run(m.id, m.nombre, m.tecla, m.tipo_moneda, m.naturaleza, m.activo, m.flag_impresora);
        }
    })();
}

// Backfill único de naturaleza (CONTADO / CREDITO / CASHEA) para métodos de pago preexistentes
try {
    const yaMigradoNat = serverDb.prepare("SELECT valor FROM configuraciones_maestras WHERE clave = 'MIGRACION_NATURALEZA_METODOS_V1'").get();
    if (!yaMigradoNat) {
        serverDb.transaction(() => {
            serverDb.prepare(`
                UPDATE metodos_pago_maestro
                SET naturaleza = 'CREDITO'
                WHERE (id = '1000008' OR UPPER(COALESCE(nombre, '')) LIKE '%CREDITO%' OR UPPER(COALESCE(nombre, '')) LIKE '%CRÉDITO%')
                  AND COALESCE(UPPER(TRIM(naturaleza)), '') IN ('', 'CONTADO')
            `).run();
            serverDb.prepare(`
                UPDATE metodos_pago_maestro
                SET naturaleza = 'CASHEA'
                WHERE UPPER(COALESCE(nombre, '')) LIKE '%CASHEA%'
                  AND COALESCE(UPPER(TRIM(naturaleza)), '') IN ('', 'CONTADO')
            `).run();
            serverDb.prepare(`
                UPDATE metodos_pago_maestro
                SET naturaleza = 'CONTADO'
                WHERE naturaleza IS NULL OR TRIM(naturaleza) = ''
            `).run();
            serverDb.prepare("INSERT OR REPLACE INTO configuraciones_maestras (clave, valor) VALUES ('MIGRACION_NATURALEZA_METODOS_V1', '1')").run();
        })();
    }
} catch (eMigNat) {
    console.warn("Aviso migrando naturaleza de métodos de pago:", eMigNat.message);
}

if (checkCorr.count === 0) {
    const insertStmt = serverDb.prepare("INSERT INTO correlativos_maestros (tipo, prefijo, ultimo_numero, correlativo_nc_actual) VALUES (?, ?, ?, ?)");
    
    // Inicialización de los 4 modos con NC en 0
    insertStmt.run('TICKET_NO_FISCAL', 'TICK-', 0, 0);
    insertStmt.run('FISCAL_HKA', 'FIS-', 0, 0);
    insertStmt.run('FORMA_LIBRE', 'FL-', 0, 0);
    insertStmt.run('ELECTRONICA', 'TFHKA-', 0, 0);
    insertStmt.run('GUIA_DESPACHO', 'GD-', 0, 0);
    
    console.log("🌱 Correlativos maestros inicializados con soporte para Notas de Crédito.");
}

// Endpoint Maestro: Registrar Guía de Despacho
server.post('/api/maestro/registrar-guia-despacho', (req, res) => {
    const datos = req.body;
    try {
        // Validación de creación de tabla en la base de datos local del servidor
        serverDb.exec(`
            CREATE TABLE IF NOT EXISTS guias_despacho (
                id TEXT PRIMARY KEY,
                company_id TEXT,
                branch_id TEXT,
                cashier_id TEXT,
                numero_guia TEXT,
                numero_control TEXT,
                cliente_nombre TEXT,
                cliente_rif TEXT,
                factura_asociada TEXT,
                datos_json TEXT,
                fecha DATETIME DEFAULT (datetime('now', '-4 hours'))
            )
        `);

        // Preparación para inserción en nexus-local-server.db
        const stmt = serverDb.prepare(`
            INSERT INTO guias_despacho (
                id, company_id, branch_id, cashier_id, numero_guia, 
                numero_control, cliente_nombre, cliente_rif, 
                factura_asociada, datos_json
            ) VALUES (
                @id, @company_id, @branch_id, @cashier_id, @numero_guia, 
                @numero_control, @cliente_nombre, @cliente_rif, 
                @factura_asociada, @datos_json
            )
        `);

        stmt.run({
            id: datos.id,
            company_id: datos.company_id,
            branch_id: datos.branch_id,
            cashier_id: datos.cashier_id,
            numero_guia: datos.numero_guia,
            numero_control: datos.numero_control,
            cliente_nombre: datos.cliente_nombre,
            cliente_rif: datos.cliente_rif,
            factura_asociada: datos.factura_asociada || null,
            datos_json: datos.datos_json
        });

        console.log(`✅ [SERVER] Guía de Despacho recibida y guardada: ${datos.numero_guia}`);
        res.status(200).json({ exito: true, id: datos.id });

    } catch (error) {
        console.error("❌ [ERROR SERVER] Falló la inserción en nexus-local-server.db:", error);
        res.status(500).json({ exito: false, error: error.message });
    }
});



server.post('/api/maestro/guardar-clave-admin', (req, res) => {
        const c = req.body;
        try {
            // Asegurar que la tabla tenga las columnas permisos, is_master y code_hash
            try {
                serverDb.prepare("ALTER TABLE claves_admin_maestras ADD COLUMN permisos TEXT").run();
            } catch(e) { /* Columna opcional ya existente en migración */ }
            try {
                serverDb.prepare("ALTER TABLE claves_admin_maestras ADD COLUMN is_master INTEGER DEFAULT 0").run();
            } catch(e) { /* Columna opcional ya existente en migración */ }
            try {
                serverDb.prepare("ALTER TABLE claves_admin_maestras ADD COLUMN code_hash TEXT").run();
            } catch(e) { /* Columna opcional ya existente en migración */ }

            const permisosStr = typeof c.permisos === 'object' ? JSON.stringify(c.permisos) : (c.permisos || null);
            const isMasterVal = (c.is_master === 1 || c.is_master === true || c.is_master === '1' || c.is_master === 'true' || c.isMaster === true || c.isMaster === 1) ? 1 : 0;

            const stmt = serverDb.prepare(`
                INSERT INTO claves_admin_maestras (id, ownerName, encryptedCode, company_id, created_by, updatedAt, permisos, is_master, code_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    ownerName = excluded.ownerName,
                    encryptedCode = COALESCE(NULLIF(excluded.encryptedCode, ''), claves_admin_maestras.encryptedCode),
                    permisos = excluded.permisos,
                    is_master = excluded.is_master,
                    code_hash = COALESCE(NULLIF(excluded.code_hash, ''), claves_admin_maestras.code_hash),
                    updatedAt = excluded.updatedAt
            `);
            stmt.run(c.id, c.ownerName, c.encryptedCode || null, c.company_id, c.created_by, c.updatedAt, permisosStr, isMasterVal, c.code_hash || null);
            res.json({ exito: true });
        } catch (e) {
            console.error("❌ Error guardando clave en Maestro:", e.message);
            res.status(500).json({ exito: false, error: e.message });
        }
    });

    server.get('/api/maestro/obtener-claves-admin/:companyId', (req, res) => {
        try {
            // Asegurar columnas existentes
            try {
                serverDb.prepare("ALTER TABLE claves_admin_maestras ADD COLUMN permisos TEXT").run();
            } catch(e) { /* Columna opcional ya existente en migración */ }
            try {
                serverDb.prepare("ALTER TABLE claves_admin_maestras ADD COLUMN is_master INTEGER DEFAULT 0").run();
            } catch(e) { /* Columna opcional ya existente en migración */ }
            try {
                serverDb.prepare("ALTER TABLE claves_admin_maestras ADD COLUMN code_hash TEXT").run();
            } catch(e) { /* Columna opcional ya existente en migración */ }

            const claves = serverDb.prepare('SELECT * FROM claves_admin_maestras WHERE company_id = ? ORDER BY updatedAt DESC').all(req.params.companyId);
            res.json(claves);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    server.delete('/api/maestro/eliminar-clave-admin/:id', (req, res) => {
        try {
            serverDb.prepare('DELETE FROM claves_admin_maestras WHERE id = ?').run(req.params.id);
            res.json({ exito: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });


server.get('/api/maestro/buscar-factura/:criterio', (req, res) => {
    try {
        const criterio = req.params.criterio;
        const soloNumeros = criterio.replace(/[^0-9]/g, '');
        const busquedaLike = `%-${soloNumeros.padStart(8, '0')}`;

        // BUSCAMOS SOLO EN LA DB CENTRALIZADA
        const stmt = serverDb.prepare(`
            SELECT * FROM ventas_locales 
            WHERE id = ? OR numero_factura = ? OR numero_factura LIKE ?
            ORDER BY fecha_emision DESC
        `);
        
        const resultados = stmt.all(criterio, criterio, busquedaLike);
        res.json({ total: resultados.length, data: resultados });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

    server.get('/api/tasas', async (req, res) => {
        const url = 'https://www.bcv.org.ve/';
        try {
            console.log("🌐 Master: Solicitando tasas al BCV...");
            const { data } = await axios.get(url, axiosConfigBCV);
            const $ = cheerio.load(data);
            
            const rates = {};
            const currencyMap = { 'dolar': 'USD', 'euro': 'EUR', 'yuan': 'CNY', 'lira': 'TRY', 'rublo': 'RUB' };

            Object.keys(currencyMap).forEach(id => {
                const currencyDiv = $(`#${id}`);
                if (currencyDiv.length > 0) {
                    const currencyValue = currencyDiv.find('strong').text().trim();
                    const label = currencyMap[id];
                    if (currencyValue) rates[label] = currencyValue;
                }
            });
            res.json({ rates });
        } catch (error) {
            res.status(500).json({ error: 'Error en conexión BCV.' });
        }
    });

    server.post('/api/maestro/configuracion', (req, res) => {
    try {
        const { clave, valor } = req.body;
        const stmt = serverDb.prepare(`
            INSERT INTO configuraciones_maestras (clave, valor) 
            VALUES (?, ?) 
            ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
        `);
        stmt.run(clave, String(valor));
        res.json({ exito: true });
    } catch (error) {
        console.error("❌ Error al guardar configuración maestra:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

// 3. Ruta para LEER una configuración (Usada por las cajeras)
server.get('/api/maestro/configuracion/:clave', (req, res) => {
    try {
        const { clave } = req.params;
        let valor = null;
        const stmt = serverDb.prepare(`SELECT valor FROM configuraciones_maestras WHERE clave = ?`);
        const resultado = stmt.get(clave);
        if (resultado && resultado.valor !== undefined && resultado.valor !== null) {
            valor = resultado.valor;
        } else {
            const activeDb = getPosDb();
            if (activeDb) {
                try {
                    const row = activeDb.prepare(`SELECT valor FROM configuracion WHERE clave = ?`).get(clave);
                    if (row && row.valor !== undefined && row.valor !== null) {
                        valor = row.valor;
                    }
                } catch (eCfg) {
                    console.warn("⚠️ [CONFIG] Error leyendo configuracion en posDb:", eCfg.message);
                }
            }
        }
        res.json({ exito: true, valor: valor });
    } catch (error) {
        console.error("❌ Error al leer configuración maestra:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

// --- AUDITORIA FISCAL ---
server.post('/api/maestro/auditoria-fiscal', (req, res) => {
    try {
        const { id, usuario, accion, valores, fecha } = req.body;
        const stmt = serverDb.prepare(`
            INSERT INTO auditoria_fiscal (id, usuario, accion, valores, fecha) 
            VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(
            id || `FISCAL-AUDIT-${Date.now()}`,
            usuario || 'Desconocido',
            accion,
            valores || 'Sin valores',
            fecha || getCaracasTime()
        );
        res.json({ exito: true });
    } catch (error) {
        console.error("❌ Error al guardar auditoria fiscal:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

server.get('/api/maestro/auditoria-fiscal', (req, res) => {
    try {
        const stmt = serverDb.prepare('SELECT * FROM auditoria_fiscal ORDER BY fecha DESC LIMIT 1000');
        res.json({ exito: true, data: stmt.all() });
    } catch (error) {
        console.error("❌ Error al leer auditoria fiscal:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

// --- METODOS DE PAGO MAESTROS ---
server.get('/api/maestro/metodos-pago', (req, res) => {
    try {
        const stmt = serverDb.prepare('SELECT * FROM metodos_pago_maestro ORDER BY id ASC');
        const rows = stmt.all().map((m) => {
            const nat = String(m.naturaleza || '').trim().toUpperCase();
            const validNat = (nat === 'CONTADO' || nat === 'CREDITO' || nat === 'CASHEA')
                ? nat
                : (String(m.nombre || '').toUpperCase().includes('CASHEA') ? 'CASHEA'
                    : (m.id === '1000008' || String(m.nombre || '').toUpperCase().includes('CREDITO') || String(m.nombre || '').toUpperCase().includes('CRÉDITO')) ? 'CREDITO' : 'CONTADO');
            return { ...m, naturaleza: validNat };
        });
        res.json({ exito: true, data: rows });
    } catch (error) {
        console.error("❌ Error al leer metodos de pago:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

server.post('/api/maestro/metodos-pago', (req, res) => {
    try {
        const { id, nombre, tecla, tipo_moneda, naturaleza, tipo_canal, activo, flag_impresora } = req.body;
        // Generar un ID numérico aleatorio de 7 dígitos si no existe
        const finalId = id || Math.floor(1000000 + Math.random() * 9000000).toString();
        const rawNat = String(naturaleza || tipo_canal || '').trim().toUpperCase();
        const nomUp = String(nombre || '').toUpperCase();
        const natFinal = (rawNat === 'CONTADO' || rawNat === 'CREDITO' || rawNat === 'CASHEA')
            ? rawNat
            : (nomUp.includes('CASHEA') ? 'CASHEA' : ((nomUp.includes('CREDITO') || nomUp.includes('CRÉDITO')) ? 'CREDITO' : 'CONTADO'));
        
        const stmt = serverDb.prepare(`
            INSERT INTO metodos_pago_maestro (id, nombre, tecla, tipo_moneda, naturaleza, activo, flag_impresora) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
                nombre = excluded.nombre,
                tecla = excluded.tecla,
                tipo_moneda = excluded.tipo_moneda,
                naturaleza = excluded.naturaleza,
                activo = excluded.activo,
                flag_impresora = excluded.flag_impresora
        `);
        stmt.run(finalId, nombre, tecla || null, tipo_moneda || 'BS', natFinal, activo !== undefined ? activo : 1, flag_impresora || '00');
        res.json({ exito: true, id: finalId, naturaleza: natFinal });
    } catch (error) {
        console.error("❌ Error al guardar metodo de pago:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

server.delete('/api/maestro/metodos-pago/:id', (req, res) => {
    try {
        const { id } = req.params;
        const stmt = serverDb.prepare('DELETE FROM metodos_pago_maestro WHERE id = ?');
        stmt.run(id);
        res.json({ exito: true });
    } catch (error) {
        console.error("❌ Error al eliminar metodo de pago:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

server.put('/api/maestro/metodos-pago/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { flag_impresora } = req.body;
        const stmt = serverDb.prepare('UPDATE metodos_pago_maestro SET flag_impresora = ? WHERE id = ?');
        stmt.run(flag_impresora, id);
        res.json({ exito: true });
    } catch (error) {
        console.error("❌ Error al actualizar flag de metodo de pago:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

    // --- 2. ENDPOINT: SINCRONIZAR DESDE XEON (Nube a Maestro) ---

    server.post('/api/sincronizar-desde-xeon', (req, res) => {
        const productos = req.body; 
        try {
            const stmt = serverDb.prepare(`
                INSERT OR REPLACE INTO stock_maestro (producto_id, cantidad_real, ultima_sincronizacion)
                VALUES (?, ?, CURRENT_TIMESTAMP)
            `);
            const transaccion = serverDb.transaction((lista) => {
                for (const p of lista) {
                    stmt.run(p.id || p.producto_ID, p.stock || p.existencia || 0);
                }
            });
            transaccion(productos);
            res.json({ exito: true, mensaje: "Stock maestro actualizado desde Xeon." });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    server.post('/api/maestro/obtener-correlativo', (req, res) => {
    const { tipo } = req.body;
    try {
        const transaccion = serverDb.transaction(() => {
            let row = serverDb.prepare('SELECT ultimo_numero, prefijo FROM correlativos_maestros WHERE tipo = ?').get(tipo);

            if (!row) {
                console.log(`⚠️ Correlativo [${tipo}] no encontrado. Creándolo automáticamente...`);
                let prefijo = 'DOC-';
                if (tipo === 'NOTA_CREDITO') prefijo = 'NC-';
                else if (tipo === 'NOTA_DEBITO') prefijo = 'ND-'; 
                else if (tipo === 'PRESUPUESTO' || tipo === 'COTIZACION') prefijo = 'PRE-';
                else if (tipo === 'RETENCION_IVA') prefijo = 'RET-';
                else if (tipo === 'GUIA_DESPACHO') prefijo = 'GD-';
                else if (tipo === 'TICKET_NO_FISCAL') prefijo = 'TICK-';
                else if (tipo === 'FORMA_LIBRE') prefijo = 'FL-';
                else if (tipo === 'ELECTRONICA') prefijo = 'TFHKA-';
                else if (tipo === 'FISCAL_HKA') prefijo = 'FIS-';

                serverDb.prepare('INSERT INTO correlativos_maestros (tipo, prefijo, ultimo_numero) VALUES (?, ?, 0)').run(tipo, prefijo);
                row = { ultimo_numero: 0, prefijo: prefijo };
            }

            const nuevoNumero = row.ultimo_numero + 1;
            serverDb.prepare('UPDATE correlativos_maestros SET ultimo_numero = ? WHERE tipo = ?').run(nuevoNumero, tipo);
            
            return { 
                numero: nuevoNumero, 
                formato: `${row.prefijo}${String(nuevoNumero).padStart(8, '0')}` 
            };
        });
        
        res.json(transaccion());
    } catch (e) { 
        console.error("❌ Error en Maestro (obtener-correlativo):", e.message);
        res.status(500).json({ error: e.message }); 
    }
});

    // 1. ENDPOINT: SINCRONIZAR / CREAR / EDITAR PRODUCTO (UPSERT)
    server.post(['/api/maestro/inventario/sincronizar', '/api/maestro/sincronizar-producto'], (req, res) => {
        try {
            const prod = req.body;
            const id = prod.id || prod.producto_ID;
            const companyId = prod.company_id || prod.empresa_ID;
            if (!id || !companyId) {
                return res.status(400).json({ error: "Faltan campos obligatorios: id o company_id" });
            }

            const activeDb = getPosDb() || serverDb;
            const stmt = activeDb.prepare(`
                INSERT INTO productos_locales (
                    id, company_id, branch_id, codigo, nombre, precio, precio_compra,
                    porcentaje_ganancia, categoria, status, imagen, datos_json,
                    estado_sync, fecha_modificacion
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET
                    company_id = excluded.company_id,
                    branch_id = excluded.branch_id,
                    codigo = excluded.codigo,
                    nombre = excluded.nombre,
                    precio = excluded.precio,
                    precio_compra = excluded.precio_compra,
                    porcentaje_ganancia = excluded.porcentaje_ganancia,
                    categoria = excluded.categoria,
                    status = excluded.status,
                    imagen = excluded.imagen,
                    datos_json = excluded.datos_json,
                    estado_sync = 1,
                    fecha_modificacion = CURRENT_TIMESTAMP
            `);

            const datosJsonStr = typeof prod.datos_json === 'string' ? prod.datos_json : JSON.stringify(prod);
            stmt.run(
                id,
                companyId,
                prod.branch_id || 'principal',
                prod.codigo || '',
                prod.nombre || '',
                parseFloat(prod.precio_venta || prod.precio || 0),
                parseFloat(prod.precio_compra || (prod.precios && prod.precios.p1 && prod.precios.p1.compra) || 0),
                parseFloat(prod.porcentaje_ganancia || (prod.precios && prod.precios.p1 && prod.precios.p1.porcentaje) || 0),
                prod.categoria || 'General',
                prod.status !== undefined ? prod.status : 1,
                prod.imagen || '',
                datosJsonStr
            );

            // Notificar a cajas hijas conectadas por SSE (con debounce para evitar ráfagas en lotes)
            if (Array.isArray(cajasEscuchando) && cajasEscuchando.length > 0) {
                if (global.__timerCambioProductosSSE) clearTimeout(global.__timerCambioProductosSSE);
                global.__timerCambioProductosSSE = setTimeout(() => {
                    global.__timerCambioProductosSSE = null;
                    if (Array.isArray(cajasEscuchando)) {
                        cajasEscuchando.forEach(caja => {
                            try {
                                caja.write('data: CAMBIO_PRODUCTOS\n\n');
                            } catch (e) { /* Cliente SSE desconectado */ }
                        });
                    }
                }, 400);
            }

            res.json({ success: true, id: id });
        } catch (e) {
            console.error("❌ Error en servidor Maestro (inventario/sincronizar):", e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // 2. ENDPOINT: REGISTRAR ENTRADA / AJUSTES DE STOCK MASIVOS
    server.post(['/api/maestro/inventario/registrar-entrada', '/api/maestro/registrar-entrada'], (req, res) => {
        const { items, sucursalId, sucursal_id, companyId, company_id } = req.body; 
        const sIdGlobal = sucursalId || sucursal_id;
        const cIdGlobal = companyId || company_id;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ exito: false, error: "Datos de entrada malformados" });
        }

        console.log(`\n📦 [API MAESTRO] --- NUEVA PETICIÓN DE ALTERACIÓN DE STOCK ---`);
        console.log(`➡️ Sucursal: ${sIdGlobal || 'No enviada'} | Empresa: ${cIdGlobal || 'No enviada'}`);

        try {
            const transaccion = serverDb.transaction((productos) => {
                for (const item of productos) {
                    const sId = sIdGlobal || item.sucursalId || item.sucursal_id || 'principal';
                    const cId = cIdGlobal || item.companyId || item.company_id || 'DEFAULT';
                    const itemId = item.id || item.producto_id;
                    const op = String(item.operacion || 'SUMAR').toUpperCase();

                    // OBTENER STOCK PREVIO
                    let stockPrevio = 0;
                    const rowStock = serverDb.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ? AND sucursal_id = ?').get(itemId, sId);
                    if (rowStock) stockPrevio = parseFloat(rowStock.cantidad_real || 0);

                    const sql = (op === 'FIJAR') 
                        ? `INSERT INTO stock_maestro (producto_id, sucursal_id, company_id, cantidad_real, ultima_sincronizacion)
                        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET
                        cantidad_real = excluded.cantidad_real,
                        ultima_sincronizacion = CURRENT_TIMESTAMP`
                        : `INSERT INTO stock_maestro (producto_id, sucursal_id, company_id, cantidad_real, ultima_sincronizacion)
                        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET
                        cantidad_real = stock_maestro.cantidad_real + excluded.cantidad_real,
                        ultima_sincronizacion = CURRENT_TIMESTAMP`;

                    serverDb.prepare(sql).run(itemId, sId, cId, item.cantidad);

                    // REGISTRAR MOVIMIENTO KARDEX
                    let diferencia = 0;
                    let tipoMov = '';
                    if (op === 'FIJAR') {
                        diferencia = parseFloat(item.cantidad) - stockPrevio;
                        tipoMov = diferencia >= 0 ? 'AJUSTE_POSITIVO' : 'AJUSTE_NEGATIVO';
                    } else {
                        diferencia = parseFloat(item.cantidad);
                        tipoMov = 'ENTRADA';
                    }

                    if (diferencia !== 0) {
                        try {
                            serverDb.prepare(`INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento) VALUES (?, ?, ?, ?, ?)`)
                                    .run(cId, sId, itemId, diferencia, tipoMov);
                        } catch(e) { console.error("Error guardando movimiento:", e.message); }
                    }
                    console.log(`✅ Base de datos actualizada para: ${itemId}`);
                }
            });
            transaccion(items);
            console.log(`🏁 Transacción de stock finalizada con éxito.\n`);
            if (process.send) {
                try { process.send({ tipo: 'stock-actualizado' }); } catch (e) { /* Canal IPC no disponible */ }
            }
            res.json({ exito: true });
        } catch (e) {
            console.error("❌ Error en servidor Maestro (registrar-entrada):", e.message);
            res.status(500).json({ exito: false, error: e.message });
        }
    });

    // 2.1 ENDPOINT: ACTUALIZAR STOCK INDIVIDUAL O MASIVO (SUMAR, RESTAR O FIJAR)
    server.post(['/api/maestro/stock/actualizar', '/api/maestro/inventario/actualizar-stock'], (req, res) => {
        try {
            const body = req.body;
            let items = [];

            if (body.items && Array.isArray(body.items)) {
                items = body.items;
            } else if (body.producto_id || body.productoId || body.id) {
                items = [{
                    producto_id: body.producto_id || body.productoId || body.id,
                    sucursal_id: body.sucursal_id || body.sucursalId || body.branch_id || body.branchId || 'principal',
                    company_id: body.company_id || body.companyId || 'DEFAULT',
                    operacion: body.operacion || 'sumar',
                    cantidad: parseFloat(body.cantidad) || 0
                }];
            } else {
                return res.status(400).json({ exito: false, error: "Payload incompleto" });
            }

            console.log(`\n📦 [API MAESTRO] --- ACTUALIZACIÓN DE STOCK (stock/actualizar) ---`);

            const transaccion = serverDb.transaction((lista) => {
                for (const item of lista) {
                    const itemId = item.producto_id || item.productoId || item.id;
                    const sId = item.sucursal_id || item.sucursalId || item.branch_id || item.branchId || 'principal';
                    const cId = item.company_id || item.companyId || 'DEFAULT';
                    const op = String(item.operacion || 'sumar').toLowerCase();
                    const cant = Math.abs(parseFloat(item.cantidad) || 0);

                    // OBTENER STOCK PREVIO
                    let stockPrevio = 0;
                    const rowStock = serverDb.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ? AND sucursal_id = ?').get(itemId, sId);
                    if (rowStock) stockPrevio = parseFloat(rowStock.cantidad_real || 0);

                    let sql = '';
                    let diferencia = 0;
                    let tipoMov = '';

                    if (op === 'fijar') {
                        sql = `INSERT INTO stock_maestro (producto_id, sucursal_id, company_id, cantidad_real, ultima_sincronizacion)
                            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                            ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET
                            cantidad_real = excluded.cantidad_real,
                            ultima_sincronizacion = CURRENT_TIMESTAMP`;
                        serverDb.prepare(sql).run(itemId, sId, cId, cant);
                        diferencia = cant - stockPrevio;
                        tipoMov = diferencia >= 0 ? 'AJUSTE_POSITIVO' : 'AJUSTE_NEGATIVO';
                    } else if (op === 'restar') {
                        sql = `INSERT INTO stock_maestro (producto_id, sucursal_id, company_id, cantidad_real, ultima_sincronizacion)
                            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                            ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET
                            cantidad_real = stock_maestro.cantidad_real + excluded.cantidad_real,
                            ultima_sincronizacion = CURRENT_TIMESTAMP`;
                        serverDb.prepare(sql).run(itemId, sId, cId, -cant);
                        diferencia = -cant;
                        tipoMov = 'SALIDA';
                    } else { // sumar
                        sql = `INSERT INTO stock_maestro (producto_id, sucursal_id, company_id, cantidad_real, ultima_sincronizacion)
                            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                            ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET
                            cantidad_real = stock_maestro.cantidad_real + excluded.cantidad_real,
                            ultima_sincronizacion = CURRENT_TIMESTAMP`;
                        serverDb.prepare(sql).run(itemId, sId, cId, cant);
                        diferencia = cant;
                        tipoMov = 'ENTRADA';
                    }

                    if (diferencia !== 0) {
                        try {
                            serverDb.prepare(`INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento) VALUES (?, ?, ?, ?, ?)`)
                                    .run(cId, sId, itemId, diferencia, tipoMov);
                        } catch (eMov) {
                            console.warn("⚠️ [KARDEX] Error registrando movimiento en stock/actualizar:", eMov.message);
                        }
                    }
                    console.log(`✅ [stock/actualizar] Item: ${itemId} | Op: ${op} | Cant: ${cant} | Dif: ${diferencia}`);
                }
            });

            transaccion(items);

            if (process.send) {
                try { process.send({ tipo: 'stock-actualizado' }); } catch (e) { /* Canal IPC no disponible */ }
            }

            return res.json({ exito: true, success: true });
        } catch (e) {
            console.error("❌ Error en servidor Maestro (stock/actualizar):", e.message);
            return res.status(500).json({ exito: false, success: false, error: e.message });
        }
    });

    // 3. ENDPOINT: DESCONTAR STOCK POR VENTA (CON KARDEX)
    server.post(['/api/maestro/inventario/descontar-stock-venta', '/api/maestro/descontar-stock'], (req, res) => {
        const { items, sucursalId, sucursal_id, companyId, company_id, factura_ref, tipo_movimiento } = req.body;
        const sIdGlobal = sucursalId || sucursal_id;
        const cIdGlobal = companyId || company_id;
        const refFactura = factura_ref || req.body.ventaId || req.body.id || '';
        const tipoMovimiento = tipo_movimiento || 'VENTA';
        
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ exito: false, error: "Payload incompleto" });
        }

        // 🛡️ CANDADO DE IDEMPOTENCIA EN API MAESTRO: Si la transacción ya descontó stock, no volver a descontar
        if (refFactura) {
            try {
                serverDb.prepare("ALTER TABLE movimientos_stock_maestro ADD COLUMN referencia_id TEXT").run();
            } catch (eAlter) { /* Columna referencia_id ya existente en migración */ }

            try {
                const yaDescontado = serverDb.prepare(`
                    SELECT id FROM movimientos_stock_maestro 
                    WHERE referencia_id = ? AND tipo_movimiento = 'VENTA' LIMIT 1
                `).get(String(refFactura));

                if (yaDescontado) {
                    console.log(`🛡️ [IDEMPOTENCIA API MAESTRO] Transacción ${refFactura} ya descontó stock previamente. Omitiendo duplicado.`);
                    return res.json({ exito: true, idempotente: true, mensaje: "Stock ya descontado previamente para esta transacción." });
                }
            } catch(eCheck) {
                console.warn("Aviso verificando idempotencia en API Maestro:", eCheck.message);
            }
        }

        console.log(`\n🛒 [API MAESTRO] --- NUEVA PETICIÓN DE VENTA (DESCUENTO) --- Ref: ${refFactura || 'Sin Ref'}`);
        
        try {
            const transaccion = serverDb.transaction((productos) => {
                // Validación de existencias
                for (const item of productos) {
                    const itemId = item.id || item.producto_id;
                    const sIdTarget = sIdGlobal || item.sucursalId || item.sucursal_id;
                    
                    let row;
                    if (sIdTarget) {
                        row = serverDb.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ? AND sucursal_id = ?').get(itemId, sIdTarget);
                    } else {
                        row = serverDb.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ?').get(itemId);
                    }

                    if (!row || row.cantidad_real < item.cantidad) {
                        throw new Error(`Stock insuficiente para: ${item.nombre || itemId}. Actual: ${row ? row.cantidad_real : 0}, Solicitado: ${item.cantidad}`);
                    }
                }
                
                // Descuento y registro en Kardex
                for (const item of productos) { 
                    const itemId = item.id || item.producto_id;
                    const sIdTarget = sIdGlobal || item.sucursalId || item.sucursal_id;
                    console.log(`📉 VENTA - DESCONTANDO: ${item.cantidad} unidades | ID: ${itemId}`);
                    
                    const rowComp = serverDb.prepare('SELECT company_id FROM stock_maestro WHERE producto_id = ? LIMIT 1').get(itemId);
                    const compId = cIdGlobal || (rowComp ? rowComp.company_id : 'DEFAULT');

                    if (sIdTarget) {
                        serverDb.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real - ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ? AND sucursal_id = ?').run(item.cantidad, itemId, sIdTarget);
                        try {
                            serverDb.prepare(`INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento, referencia_id) VALUES (?, ?, ?, ?, ?, ?)`)
                                    .run(compId, sIdTarget, itemId, -Math.abs(item.cantidad), tipoMovimiento, refFactura);
                        } catch (eMov) {
                            console.warn("⚠️ [KARDEX] Error registrando descuento de stock por sucursal:", eMov.message);
                        }
                    } else {
                        serverDb.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real - ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ?').run(item.cantidad, itemId);
                        try {
                            serverDb.prepare(`INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento, referencia_id) VALUES (?, ?, ?, ?, ?, ?)`)
                                    .run(compId, 'GLOBAL', itemId, -Math.abs(item.cantidad), tipoMovimiento, refFactura);
                        } catch (eMov) {
                            console.warn("⚠️ [KARDEX] Error registrando descuento de stock global:", eMov.message);
                        }
                    }
                }
            });
            transaccion(items);
            console.log(`✅ [API MAESTRO] Descuento de stock por venta exitoso.\n`);
            if (process.send) {
                try { process.send({ tipo: 'stock-actualizado' }); } catch (e) { /* Canal IPC no disponible */ }
            }
            res.json({ exito: true });
        } catch (e) { 
            console.error("❌ [API MAESTRO] Error en descuento global:", e.message);
            res.status(400).json({ exito: false, error: e.message, mensaje: e.message }); 
        }
    });


// server.js - BUSCA Y REEMPLAZA ESTE ENDPOINT
server.get('/api/maestro/stock', (req, res) => {
    const { sucursalId, companyId } = req.query;
    try {
        let query;
        let params;

        // Si se envía sucursal (usado en Entradas de Inventario)
        if (sucursalId && sucursalId !== 'undefined' && sucursalId !== 'null') {
            query = `SELECT producto_id, cantidad_real FROM stock_maestro WHERE sucursal_id = ? AND company_id = ?`;
            params = [sucursalId, companyId];
        } 
        // SI NO SE ENVÍA SUCURSAL (Para Estadísticas Generales): Suma todo el stock de la empresa
        else {
            query = `SELECT producto_id, SUM(cantidad_real) as cantidad_real 
                     FROM stock_maestro 
                     WHERE company_id = ? 
                     GROUP BY producto_id`;
            params = [companyId];
        }

        const filas = serverDb.prepare(query).all(...params);
        res.json(filas);
    } catch (e) {
        console.error("❌ Error en stock maestro:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Sincronización de stock modificados/creados
server.get('/api/maestro/stock/sincronizar', (req, res) => {
    const { company_id, desde } = req.query;
    try {
        let query = `SELECT producto_id, sucursal_id, company_id, cantidad_real, ultima_sincronizacion FROM stock_maestro WHERE company_id = ?`;
        const params = [company_id];
        if (desde && desde !== '2000-01-01T00:00:00.000Z') {
            query += ` AND (ultima_sincronizacion > ? OR ultima_sincronizacion IS NULL)`;
            params.push(desde);
        }
        const filas = serverDb.prepare(query).all(...params);
        res.json(filas);
    } catch (e) {
        console.error("❌ Error en stock/sincronizar:", e.message);
        res.json([]);
    }
});

// Endpoints de gestión de sucursales
server.get('/api/maestro/sucursales/:companyId', (req, res) => {
    const { companyId } = req.params;
    try {
        const sucursales = serverDb.prepare("SELECT * FROM sucursales WHERE company_id = ? AND COALESCE(status, 1) != -1 ORDER BY nombre ASC").all(companyId);
        res.json(sucursales);
    } catch (e) {
        res.json([]);
    }
});

server.get('/api/maestro/sucursales', (req, res) => {
    const { empresaId, companyId, company_id } = req.query;
    const comp = empresaId || companyId || company_id;
    try {
        if (comp && comp !== 'undefined' && comp !== 'null') {
            const sucursales = serverDb.prepare("SELECT * FROM sucursales WHERE company_id = ? AND COALESCE(status, 1) != -1 ORDER BY nombre ASC").all(comp);
            res.json(sucursales);
        } else {
            const sucursales = serverDb.prepare("SELECT * FROM sucursales WHERE COALESCE(status, 1) != -1 ORDER BY nombre ASC").all();
            res.json(sucursales);
        }
    } catch (e) {
        res.json([]);
    }
});

server.post('/api/maestro/sucursales/sincronizar', (req, res) => {
    const body = req.body || {};
    const lista = Array.isArray(body.items) ? body.items : (Array.isArray(body) ? body : [body]);
    try {
        const stmt = serverDb.prepare(`
            INSERT INTO sucursales (id, company_id, nombre, direccion, telefono, status, estado_sync, fecha_modificacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                nombre = excluded.nombre,
                direccion = excluded.direccion,
                telefono = excluded.telefono,
                status = excluded.status,
                fecha_modificacion = excluded.fecha_modificacion,
                estado_sync = excluded.estado_sync
        `);
        const idsProcesados = [];
        const tx = serverDb.transaction((items) => {
            for (const s of items) {
                if (!s || !s.id) continue;
                const statusVal = s.status !== undefined && s.status !== null ? Number(s.status) : 1;
                const syncVal = s.estado_sync === 1 ? 1 : 0;
                stmt.run(
                    s.id,
                    s.company_id || s.empresa_ID || null,
                    s.nombre || '',
                    s.direccion || '',
                    s.telefono || '',
                    statusVal,
                    syncVal,
                    s.fecha_modificacion || getCaracasTime()
                );
                idsProcesados.push(String(s.id));
            }
        });
        tx(lista);
        res.json({ exito: true, success: true, ids_procesados: idsProcesados });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

server.delete('/api/maestro/sucursales/:id', (req, res) => {
    const { id } = req.params;
    const rawComp = req.query.companyId || req.query.company_id || (req.body && (req.body.company_id || req.body.companyId));
    const compId = (rawComp && rawComp !== 'undefined' && rawComp !== 'null' && String(rawComp).trim() !== '') ? String(rawComp).trim() : null;
    try {
        const ahora = getCaracasTime();
        if (compId) {
            serverDb.prepare("UPDATE sucursales SET status = -1, estado_sync = 0, fecha_modificacion = ? WHERE id = ? AND (company_id = ? OR company_id IS NULL OR company_id = '')").run(ahora, id, compId);
        } else {
            serverDb.prepare("UPDATE sucursales SET status = -1, estado_sync = 0, fecha_modificacion = ? WHERE id = ?").run(ahora, id);
        }
        res.json({ exito: true, success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

    // server.js - Endpoint para recibir deudas de Laptops
    server.post('/api/maestro/registrar-deuda', (req, res) => {
        const { company_id, branch_id, cliente_id, cliente_nombre, monto_bs, monto_usd, numero_factura, fecha, tasa_bcv, id_dinamico, referencia, dias_credito, fecha_vencimiento, monto_iva_bs, base_imponible_bs, monto_exento_bs, numero_control } = req.body;
        const compId = company_id && company_id !== 'undefined' && company_id !== 'null' ? String(company_id).trim() : null;
        const bId = branch_id && branch_id !== 'undefined' && branch_id !== 'null' ? String(branch_id).trim() : null;
        const mBs = parseFloat(monto_bs) || 0;
        const mUsd = parseFloat(monto_usd) || 0;
        const tasaEmision = (tasa_bcv && parseFloat(tasa_bcv) > 0)
            ? parseFloat(parseFloat(tasa_bcv).toFixed(4))
            : ((mBs > 0 && mUsd > 0) ? parseFloat((mBs / mUsd).toFixed(4)) : obtenerTasaActivaServidor());
        const refCandidate = (referencia && !/^\d+$/.test(String(referencia).trim()))
            ? String(referencia).trim()
            : ((id_dinamico && !/^\d+$/.test(String(id_dinamico).trim())) ? String(id_dinamico).trim() : '');
        const refDinamica = refCandidate || generarIdDinamicoCxcServidor(compId, numero_factura);
        const cliCredRow = serverDb.prepare(`SELECT dias_credito FROM clientes_maestro WHERE REPLACE(UPPER(TRIM(COALESCE(rif,''))), '-', '') = ? LIMIT 1`).get(fiscalCxcCxp.normalizarRifSENIAT(cliente_id || '', false));
        const diasCredFinal = parseInt(dias_credito || (cliCredRow && cliCredRow.dias_credito) || 15, 10);
        const fechaVenceFinal = fecha_vencimiento || fiscalCxcCxp.calcularAgingDocumento({ fechaEmision: fecha, diasCredito: diasCredFinal }).fecha_vencimiento;

        console.log(`\n📡 [API RED] Recibiendo deuda para: ${cliente_nombre} (Emp: ${compId || 'N/A'}) por ${mBs} Bs / $${mUsd} | ID: ${refDinamica}`);

        try {
            const transaccion = serverDb.transaction(() => {
                // 1. Si el cliente no existe en el Maestro, lo creamos manteniendo su company_id
                serverDb.prepare(`
                    INSERT INTO clientes_maestro (rif, company_id, nombre, saldo_deuda, saldo_deuda_usd, estado_sync)
                    VALUES (?, ?, ?, 0, 0, 0)
                    ON CONFLICT(rif) DO UPDATE SET
                        nombre = COALESCE(NULLIF(excluded.nombre, ''), clientes_maestro.nombre),
                        company_id = COALESCE(clientes_maestro.company_id, excluded.company_id),
                        estado_sync = 0
                `).run(cliente_id, compId, cliente_nombre);

                // 2. Insertar el ticket de la deuda aislado por empresa, sucursal e ID dinámico
                serverDb.prepare(`
                    INSERT INTO cuentas_por_cobrar (
                        company_id, branch_id, cliente_id, cliente_rif, rif_cliente,
                        cliente_nombre, monto_bs, monto_usd, tasa_emision, monto, factura_nro, fecha,
                        fecha_vencimiento, dias_credito, monto_iva_bs, base_imponible_bs, monto_exento_bs, numero_control,
                        estado, concepto, referencia, estado_sync
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?, ?, 0)
                `).run(
                    compId, bId, cliente_id, cliente_id, cliente_id, cliente_nombre,
                    mBs, mUsd, tasaEmision, mBs, numero_factura, fecha,
                    fechaVenceFinal, diasCredFinal, parseFloat(monto_iva_bs || 0), parseFloat(base_imponible_bs || 0), parseFloat(monto_exento_bs || 0), numero_control || '',
                    refDinamica, refDinamica
                );

                // 3. Recalcular saldo global en USD y Bs a la tasa vigente
                recalcularSaldoClienteMaestro(cliente_id, compId, tasaEmision);
            });

            transaccion();
            console.log(`✅ [API RED] Deuda guardada exitosamente en nexus-local-server.db (Tasa emisión: ${tasaEmision} | ID dinámico: ${refDinamica})`);
            res.json({ exito: true, id_dinamico: refDinamica });
        } catch (e) {
            console.error(`❌ [API RED] Error al guardar deuda:`, e.message);
            res.status(500).json({ exito: false, mensaje: e.message });
        }
    });


server.get('/api/maestro/consultar-deuda/:rif', (req, res) => {
    const rif = req.params.rif;
    const companyId = req.query.companyId || req.query.company_id || null;
    if (!rif || rif === 'null' || rif === 'undefined' || String(rif).trim() === '') {
        return res.json({ existe: false, monto_bs: 0, monto_deuda_usd: 0, detalles: [] });
    }
    try {
        const tasaActual = obtenerTasaActivaServidor(req.query.tasa);
        const filtroEmp = construirFiltroEmpresaCxc(companyId);

        const facturasHistorial = serverDb.prepare(`
            SELECT
                id,
                company_id,
                branch_id,
                factura_nro,
                fecha,
                monto_bs,
                monto_usd,
                tasa_emision,
                monto_pagado,
                estado
            FROM cuentas_por_cobrar
            WHERE ${WHERE_RIF_CXC_SQL}
              AND ${filtroEmp.clause}
            ORDER BY fecha DESC
        `).all(rif, rif, rif, ...filtroEmp.params);

        let abonosCliente = [];
        try {
            const filtroAbonoEmp = construirFiltroEmpresaCxc(companyId);
            abonosCliente = serverDb.prepare(`
                SELECT * FROM abonos_cuentas_cobrar
                WHERE REPLACE(UPPER(TRIM(COALESCE(cliente_id, ''))), '-', '') = REPLACE(UPPER(TRIM(?)), '-', '')
                  AND ${filtroAbonoEmp.clause}
                ORDER BY fecha DESC
            `).all(rif, ...filtroAbonoEmp.params);
        } catch (eAbonos) {
            console.warn("⚠️ [CXC] Error consultando abonos_cuentas_cobrar:", eAbonos.message);
        }

        if (facturasHistorial.length > 0) {
            let saldo_total_usd = 0;

            facturasHistorial.forEach(f => {
                const usdReal = (f.monto_usd && f.monto_usd > 0) ? f.monto_usd : parseFloat(((f.monto_bs || 0) / tasaActual).toFixed(2));
                f.monto_usd = usdReal;
                if (!f.tasa_emision || f.tasa_emision <= 0) {
                    f.tasa_emision = (f.monto_bs > 0 && usdReal > 0) ? parseFloat((f.monto_bs / usdReal).toFixed(4)) : tasaActual;
                }
                f.abonos = abonosCliente.filter(a =>
                    (a.cuenta_id && String(a.cuenta_id) === String(f.id)) ||
                    (f.factura_nro && a.factura_nro && String(a.factura_nro).trim() === String(f.factura_nro).trim())
                );
                const yaPagado = parseFloat(f.monto_pagado || 0);
                const resta = Math.max(0, parseFloat((usdReal - yaPagado).toFixed(2)));
                const estadoUpper = String(f.estado || '').toUpperCase().trim();

                if (resta <= 0.01 || estadoUpper === 'PAGADA' || estadoUpper === 'PAGADO') {
                    f.estado = 'PAGADA';
                } else {
                    f.estado = 'PENDIENTE';
                    saldo_total_usd += resta;
                }
            });

            saldo_total_usd = parseFloat(saldo_total_usd.toFixed(2));
            const montoEnBs = parseFloat((saldo_total_usd * tasaActual).toFixed(2));

            try {
                recalcularSaldoClienteMaestro(rif, companyId, tasaActual);
            } catch (eRecalc) {
                console.warn("⚠️ [CXC] Error recalculando saldo de cliente:", eRecalc.message);
            }

            let evalCred = {};
            try {
                evalCred = opsCxcCxp.evaluarLimiteCreditoClienteDb(serverDb, {
                    companyId: companyId || 'DEFAULT',
                    clienteRif: rif,
                    montoNuevaFacturaUsd: parseFloat(req.query.montoNuevaUsd || 0),
                    tasaBcv: tasaActual
                });
            } catch (_) {}

            res.json({
                existe: saldo_total_usd > 0,
                monto_bs: montoEnBs,
                monto_deuda_usd: saldo_total_usd,
                tasa_actual: tasaActual,
                detalles: facturasHistorial,
                evaluacion_credito: evalCred
            });
        } else {
            let evalCred = {};
            try {
                evalCred = opsCxcCxp.evaluarLimiteCreditoClienteDb(serverDb, {
                    companyId: companyId || 'DEFAULT',
                    clienteRif: rif,
                    montoNuevaFacturaUsd: parseFloat(req.query.montoNuevaUsd || 0),
                    tasaBcv: tasaActual
                });
            } catch (_) {}
            res.json({ existe: false, monto_bs: 0, monto_deuda_usd: 0, tasa_actual: tasaActual, detalles: [], evaluacion_credito: evalCred });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


    // --- ENDPOINT DE VERIFICACIÓN (El que usas en Chrome) ---
    server.get('/api/maestro/verificar', (req, res) => {
        try {
            // Opcional: Podrías incluso contar los productos para estar seguro de que la DB responde
            const count = serverDb.prepare('SELECT COUNT(*) as total FROM stock_maestro').get();
            
            res.json({
                estado: "CONECTADO ✅",
                servidor: "Nexus Master Cerebro",
                documento: "nexus-local-server.db",
                productos_en_maestro: count ? count.total : 0,
                hora_servidor: new Date().toLocaleTimeString()
            });
        } catch (e) {
            // Si hay un error con la base de datos, te lo dirá aquí
            res.json({
                estado: "CONECTADO PERO CON ERROR ⚠️",
                error: e.message
            });
        }
    });

server.post('/api/maestro/registrar-abono', (req, res) => {
    const { cliente_id, factura_nro, monto_bs, tasa, company_id, branch_id, metodo_pago, referencia, nota, usuario } = req.body;

    if (!cliente_id || String(cliente_id).trim() === '' || cliente_id === 'null' || cliente_id === 'undefined') {
        return res.json({ exito: false, mensaje: "Identificador de cliente inválido o no proporcionado." });
    }

    const compId = company_id && company_id !== 'undefined' && company_id !== 'null' ? String(company_id).trim() : null;
    const bId = branch_id && branch_id !== 'undefined' && branch_id !== 'null' ? String(branch_id).trim() : null;

    console.log(`\n💳 [API MAESTRO] --- NUEVO PAGO DE DEUDA RECIBIDO (Emp: ${compId || 'N/A'}) ---`);
    console.log(`   - Cliente ID: ${cliente_id}`);
    console.log(`   - Factura específica: ${factura_nro || 'Cualquiera (Cascada)'}`);
    console.log(`   - Monto abonado: Bs. ${monto_bs}`);
    console.log(`   - Tasa recibida: ${tasa}`);

    try {
        if (!tasa || tasa <= 0) {
            console.log(`❌ ERROR: Tasa inválida recibida. Bloqueando pago para proteger los datos.`);
            return res.json({ exito: false, mensaje: "Error crítico: El servidor no recibió la tasa de cambio válida." });
        }

        const rate = parseFloat(tasa);
        const abonoUSD = parseFloat((monto_bs / rate).toFixed(2));

        console.log(`   - 💵 Abono convertido a USD: $${abonoUSD}`);

        if (abonoUSD <= 0) return res.json({ exito: false, mensaje: "Monto inválido." });

        const filtroEmp = construirFiltroEmpresaCxc(compId);

        // Búsqueda aislada por empresa e inmune a estados ('PENDIENTE', 'ABONADO', etc.) con RIF normalizado
        let deudas = serverDb.prepare(`
            SELECT * FROM cuentas_por_cobrar
            WHERE ${WHERE_RIF_CXC_SQL}
              AND ${filtroEmp.clause}
              AND UPPER(TRIM(COALESCE(estado, ''))) NOT IN ('PAGADA', 'PAGADO')
            ORDER BY fecha ASC
        `).all(cliente_id, cliente_id, cliente_id, ...filtroEmp.params);

        // Filtrar deudas que realmente tengan saldo pendiente (> 0.01 USD)
        deudas = deudas.filter(f => {
            const origUSD = (f.monto_usd && f.monto_usd > 0) ? f.monto_usd : parseFloat(((f.monto_bs || 0) / rate).toFixed(2));
            const pagUSD = parseFloat(f.monto_pagado || 0);
            return (origUSD - pagUSD) > 0.01;
        });

        if (deudas.length === 0) {
            console.log(`   - ⚠️ El cliente no tiene deudas pendientes con saldo por pagar.`);
            return res.json({ exito: false, mensaje: "Sin deudas pendientes." });
        }

        // Si el usuario seleccionó una factura específica, la priorizamos al inicio del array
        if (factura_nro) {
            const idx = deudas.findIndex(d => String(d.factura_nro || '').trim() === String(factura_nro).trim());
            if (idx > -1) {
                const facturaTarget = deudas.splice(idx, 1)[0];
                deudas.unshift(facturaTarget);
                console.log(`   - 🎯 Factura objetivo [${factura_nro}] priorizada para pago primero.`);
            }
        }

        console.log(`   - 📋 Facturas pendientes a procesar: ${deudas.length}`);
        const fechaAbono = getCaracasTime();
        const abonosInsertados = [];
        let saldoFinal = { saldoUsd: 0, saldoBs: 0 };

        const procesoCascada = serverDb.transaction((lista, montoAPagarUSD) => {
            const update = serverDb.prepare(`
                UPDATE cuentas_por_cobrar
                SET monto_pagado = ?, estado = ?, estado_sync = 0
                WHERE id = ?
            `);
            const insertAbono = serverDb.prepare(`
                INSERT INTO abonos_cuentas_cobrar (
                    id, company_id, branch_id, cuenta_id, factura_nro, cliente_id, cliente_nombre,
                    monto_bs, monto_usd, tasa_bcv, metodo_pago, referencia, nota, usuario, fecha, estado_sync
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            `);

            let saldoRestantePago = montoAPagarUSD;
            let idxSeq = 1;

            for (let factura of lista) {
                if (saldoRestantePago <= 0) break;

                const originalUSD = (factura.monto_usd && factura.monto_usd > 0)
                    ? factura.monto_usd
                    : parseFloat(((factura.monto_bs || 0) / rate).toFixed(2));

                const yaPagadoUSD = parseFloat(factura.monto_pagado || 0);
                const loQueFaltaUSD = parseFloat((originalUSD - yaPagadoUSD).toFixed(2));

                console.log(`      > Evaluando Factura ${factura.factura_nro} | Debe: $${loQueFaltaUSD} | Saldo disponible: $${saldoRestantePago}`);

                if (loQueFaltaUSD <= 0.01) {
                    update.run(originalUSD, 'PAGADA', factura.id);
                    continue;
                }

                let aplicadoUSD = 0;
                if (saldoRestantePago >= loQueFaltaUSD - 0.01) {
                    console.log(`        ✅ Pagando COMPLETA la factura ${factura.factura_nro}.`);
                    aplicadoUSD = loQueFaltaUSD;
                    update.run(originalUSD, 'PAGADA', factura.id);
                    saldoRestantePago = parseFloat(Math.max(0, saldoRestantePago - loQueFaltaUSD).toFixed(2));
                } else {
                    aplicadoUSD = parseFloat(saldoRestantePago.toFixed(2));
                    const nuevoAcumuladoUSD = parseFloat((yaPagadoUSD + saldoRestantePago).toFixed(2));
                    console.log(`        ⏳ Pago PARCIAL en factura ${factura.factura_nro}. Se abonó $${aplicadoUSD}. Acumulado pagado: $${nuevoAcumuladoUSD}`);
                    update.run(nuevoAcumuladoUSD, 'PENDIENTE', factura.id);
                    saldoRestantePago = 0;
                }

                if (aplicadoUSD > 0) {
                    const aplicadoBs = parseFloat((aplicadoUSD * rate).toFixed(2));
                    const abonoRow = {
                        id: `ABONO-CXC-${Date.now()}-${idxSeq++}-${Math.floor(Math.random() * 1000)}`,
                        company_id: factura.company_id || compId || null,
                        branch_id: factura.branch_id || bId || null,
                        cuenta_id: factura.id,
                        factura_nro: factura.factura_nro || '',
                        cliente_id: factura.cliente_id || cliente_id,
                        cliente_nombre: factura.cliente_nombre || '',
                        monto_bs: aplicadoBs,
                        monto_usd: aplicadoUSD,
                        tasa_bcv: rate,
                        metodo_pago: metodo_pago || 'EFECTIVO',
                        referencia: referencia || '',
                        nota: nota || `Abono a factura ${factura.factura_nro || ''}`.trim(),
                        usuario: usuario || 'ADMIN',
                        fecha: fechaAbono
                    };
                    insertAbono.run(
                        abonoRow.id, abonoRow.company_id, abonoRow.branch_id, abonoRow.cuenta_id,
                        abonoRow.factura_nro, abonoRow.cliente_id, abonoRow.cliente_nombre,
                        abonoRow.monto_bs, abonoRow.monto_usd, abonoRow.tasa_bcv,
                        abonoRow.metodo_pago, abonoRow.referencia, abonoRow.nota,
                        abonoRow.usuario, abonoRow.fecha
                    );
                    abonosInsertados.push(abonoRow);
                }
            }

            saldoFinal = recalcularSaldoClienteMaestro(cliente_id, compId, rate);
            console.log(`   - 🔄 Saldo global deudor actualizado: $${saldoFinal.saldoUsd.toFixed(2)} (Bs. ${saldoFinal.saldoBs.toFixed(2)})`);
        });

        procesoCascada(deudas, abonoUSD);
        console.log(`✅ [API MAESTRO] Cascada de pagos finalizada con éxito (${abonosInsertados.length} abono(s) registrados).\n`);
        res.json({
            exito: true,
            mensaje: "Abono aplicado correctamente.",
            abonos: abonosInsertados,
            tasa_aplicada: rate,
            saldo_usd: saldoFinal.saldoUsd,
            saldo_bs: saldoFinal.saldoBs
        });

    } catch (e) {
        console.error("❌ Error en registrar-abono:", e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

server.post('/api/maestro/guardar-cliente', (req, res) => {
    const cliente = req.body || {};
    try {
        const datosJsonStr = cliente.datos_json !== undefined && cliente.datos_json !== null
            ? (typeof cliente.datos_json === 'string' ? cliente.datos_json : JSON.stringify(cliente.datos_json))
            : null;
        const stmt = serverDb.prepare(`
            INSERT INTO clientes_maestro (
                rif, company_id, nombre, direccion, telefono, correo, datos_json, es_contribuyente_especial,
                tipo_contribuyente, limite_credito_usd, dias_credito, dias_gracia, descuento_pronto_pago_pct, bloqueado_credito,
                saldo_deuda, saldo_deuda_usd, status, estado_sync, fecha_modificacion
            )
            VALUES (
                @rif, @company_id, @nombre, @direccion, @telefono, @correo, @datos_json, @es_contribuyente_especial,
                @tipo_contribuyente, @limite_credito_usd, @dias_credito, @dias_gracia, @descuento_pronto_pago_pct, @bloqueado_credito,
                0, 0, @status, 0, @fecha_modificacion
            )
            ON CONFLICT(rif) DO UPDATE SET 
            nombre = excluded.nombre,
            direccion = excluded.direccion,
            telefono = excluded.telefono,
            correo = excluded.correo,
            datos_json = COALESCE(excluded.datos_json, clientes_maestro.datos_json),
            es_contribuyente_especial = excluded.es_contribuyente_especial,
            tipo_contribuyente = COALESCE(excluded.tipo_contribuyente, clientes_maestro.tipo_contribuyente),
            limite_credito_usd = COALESCE(excluded.limite_credito_usd, clientes_maestro.limite_credito_usd),
            dias_credito = COALESCE(excluded.dias_credito, clientes_maestro.dias_credito),
            dias_gracia = COALESCE(excluded.dias_gracia, clientes_maestro.dias_gracia),
            descuento_pronto_pago_pct = COALESCE(excluded.descuento_pronto_pago_pct, clientes_maestro.descuento_pronto_pago_pct),
            bloqueado_credito = COALESCE(excluded.bloqueado_credito, clientes_maestro.bloqueado_credito),
            company_id = COALESCE(excluded.company_id, clientes_maestro.company_id),
            status = excluded.status,
            estado_sync = 0,
            fecha_modificacion = excluded.fecha_modificacion
        `);

        stmt.run({
            rif: String(cliente.rif || '').trim().toUpperCase(),
            nombre: cliente.nombre || '',
            direccion: cliente.direccion || 'No especificada',
            telefono: cliente.telefono || '',
            correo: cliente.correo || '',
            datos_json: datosJsonStr,
            es_contribuyente_especial: cliente.es_contribuyente_especial ? 1 : 0,
            tipo_contribuyente: cliente.tipo_contribuyente || (cliente.es_contribuyente_especial ? 'ESPECIAL' : 'ORDINARIO'),
            limite_credito_usd: parseFloat(cliente.limite_credito_usd) || 0,
            dias_credito: parseInt(cliente.dias_credito || 15, 10),
            dias_gracia: parseInt(cliente.dias_gracia !== undefined ? cliente.dias_gracia : 3, 10),
            descuento_pronto_pago_pct: parseFloat(cliente.descuento_pronto_pago_pct) || 0,
            bloqueado_credito: cliente.bloqueado_credito ? 1 : 0,
            company_id: cliente.company_id || null,
            status: cliente.status !== undefined && cliente.status !== null ? Number(cliente.status) : 1,
            fecha_modificacion: cliente.fecha_modificacion || getCaracasTime()
        });

        res.json({ success: true });
    } catch (error) {
        console.error("❌ Error guardando cliente en Maestro:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

server.get('/api/maestro/obtener-clientes', (req, res) => {
    try {
        const rawComp = req.query.companyId || req.query.company_id;
        const compId = (rawComp && rawComp !== 'undefined' && rawComp !== 'null' && String(rawComp).trim() !== '') ? String(rawComp).trim() : null;
        let clientes = compId
            ? serverDb.prepare('SELECT * FROM clientes_maestro WHERE COALESCE(status, 1) != -1 AND (company_id = ? OR company_id IS NULL OR company_id = \'\') ORDER BY nombre ASC').all(compId)
            : serverDb.prepare('SELECT * FROM clientes_maestro WHERE COALESCE(status, 1) != -1 ORDER BY nombre ASC').all();
        if ((!clientes || clientes.length === 0) && getPosDb()) {
            try {
                clientes = compId
                    ? getPosDb().prepare('SELECT * FROM clientes_locales WHERE COALESCE(status, 1) != -1 AND (company_id = ? OR company_id IS NULL OR company_id = \'\') ORDER BY nombre ASC').all(compId)
                    : getPosDb().prepare('SELECT * FROM clientes_locales WHERE COALESCE(status, 1) != -1 ORDER BY nombre ASC').all();
            } catch (ePos) {
                console.warn("⚠️ [CLIENTES] Error consultando clientes_locales en posDb:", ePos.message);
            }
        }
        res.json(clientes || []);
    } catch (error) {
        console.error("❌ Error obteniendo clientes del Maestro:", error.message);
        res.status(500).json({ error: error.message });
    }
});

server.get('/api/maestro/buscar-cliente', (req, res) => {
    try {
        const query = (req.query.query || '').trim();
        if (!query) return res.json([]);
        const term = `%${query}%`;
        const cleanQuery = query.replace(/[-\s]/g, '').toUpperCase();
        const cleanTerm = `%${cleanQuery}%`;

        let results = [];
        try {
            const stmt = serverDb.prepare(`
                SELECT * FROM clientes_maestro 
                WHERE COALESCE(status, 1) != -1
                  AND (rif LIKE ? 
                       OR REPLACE(REPLACE(UPPER(rif), '-', ''), ' ', '') LIKE ?
                       OR UPPER(nombre) LIKE ? 
                       OR telefono LIKE ?)
                ORDER BY nombre ASC LIMIT 30
            `);
            results = stmt.all(term, cleanTerm, `%${query.toUpperCase()}%`, term);
        } catch (eDb) {
            console.warn("⚠️ [CLIENTES] Error buscando en clientes_maestro:", eDb.message);
        }

        if ((!results || results.length === 0) && getPosDb()) {
            try {
                const stmtLocal = getPosDb().prepare(`
                    SELECT * FROM clientes_locales 
                    WHERE COALESCE(status, 1) != -1
                      AND (rif LIKE ? 
                           OR REPLACE(REPLACE(UPPER(rif), '-', ''), ' ', '') LIKE ?
                           OR UPPER(nombre) LIKE ? 
                           OR telefono LIKE ?)
                    ORDER BY nombre ASC LIMIT 30
                `);
                results = stmtLocal.all(term, cleanTerm, `%${query.toUpperCase()}%`, term);
            } catch (ePos) {
                console.warn("⚠️ [CLIENTES] Error buscando en clientes_locales:", ePos.message);
            }
        }

        res.json(results || []);
    } catch (error) {
        console.error("❌ Error en Maestro buscando cliente:", error.message);
        res.status(500).json({ error: error.message });
    }
});

server.get('/api/maestro/inventario/:companyId', (req, res) => {
    try {
        const companyId = req.params.companyId;
        const desde = req.query.desde;
        const activeDb = getPosDb() || serverDb;
        let query = 'SELECT * FROM productos_locales WHERE 1=1';
        let params = [];
        if (companyId && companyId !== 'undefined') {
            query += ' AND company_id = ?';
            params.push(companyId);
        }
        if (desde && desde !== 'undefined') {
            query += ' AND fecha_modificacion > ?';
            params.push(desde);
        }
        query += ' ORDER BY nombre ASC';
        const rows = activeDb.prepare(query).all(...params);
        res.json(rows || []);
    } catch(e) {
        res.json([]);
    }
});

server.get('/api/maestro/categorias-local', (req, res) => {
    try {
        const empresaId = req.query.empresaId || req.query.companyId;
        const activeDb = getPosDb() || serverDb;
        let stmt;
        if (empresaId && empresaId !== 'undefined' && empresaId !== 'null') {
            stmt = activeDb.prepare('SELECT * FROM categorias_locales WHERE company_id = ? AND COALESCE(status, 1) != -1 ORDER BY nombre ASC');
            res.json(stmt.all(empresaId));
        } else {
            stmt = activeDb.prepare('SELECT * FROM categorias_locales WHERE COALESCE(status, 1) != -1 ORDER BY nombre ASC');
            res.json(stmt.all());
        }
    } catch (error) {
        console.error("❌ Error en Maestro obteniendo categorias locales:", error.message);
        res.status(500).json({ error: error.message });
    }
});

server.post('/api/maestro/categorias/sincronizar', (req, res) => {
    try {
        const body = req.body || {};
        const lista = Array.isArray(body.items) ? body.items : (Array.isArray(body) ? body : [body]);
        const validos = lista.filter(c => c && c.id && c.nombre);
        if (validos.length === 0) {
            return res.status(400).json({ error: 'Datos de categoría incompletos' });
        }
        const conns = [getPosDb(), serverDb].filter(Boolean);
        const idsProcesados = [];
        const aplicar = (conn) => {
            const upsert = conn.prepare(`
                INSERT INTO categorias_locales (id, company_id, nombre, status, estado_sync, fecha_modificacion)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    nombre = excluded.nombre,
                    company_id = excluded.company_id,
                    status = excluded.status,
                    fecha_modificacion = excluded.fecha_modificacion,
                    estado_sync = excluded.estado_sync
            `);
            conn.transaction((items) => {
                for (const cat of items) {
                    const st = cat.status !== undefined && cat.status !== null ? Number(cat.status) : 1;
                    const es = cat.estado_sync === 1 ? 1 : 0;
                    upsert.run(cat.id, cat.company_id || cat.empresa_ID || null, cat.nombre, st, es, cat.fecha_modificacion || getCaracasTime());
                }
            })(validos);
        };
        for (const conn of conns) {
            try { aplicar(conn); } catch (eC) {
                console.warn('⚠️ [CATEGORIAS LAN] Error escribiendo en DB:', eC.message);
            }
        }
        validos.forEach(c => idsProcesados.push(String(c.id)));
        res.json({ success: true, exito: true, id: validos[0].id, ids_procesados: idsProcesados });
    } catch (error) {
        console.error("❌ Error en Maestro sincronizando categoría:", error.message);
        res.status(500).json({ error: error.message });
    }
});

server.delete('/api/maestro/categorias/:id', (req, res) => {
    try {
        const { id } = req.params;
        const ahora = getCaracasTime();
        const conns = [getPosDb(), serverDb].filter(Boolean);
        for (const conn of conns) {
            try {
                conn.prepare('UPDATE categorias_locales SET status = -1, estado_sync = 0, fecha_modificacion = ? WHERE id = ?').run(ahora, id);
            } catch (eDel) {
                console.warn('⚠️ [CATEGORIAS DELETE] Error en DB:', eDel.message);
            }
        }
        res.json({ success: true, exito: true, id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

server.get('/api/maestro/buscar-productos-local', (req, res) => {
    try {
        const query = req.query.query || '';
        const empresaId = req.query.empresaId;
        const term = `%${query.trim()}%`;
        const activeDb = getPosDb() || serverDb;
        let stmt;
        if (empresaId && empresaId !== 'undefined') {
            stmt = activeDb.prepare(`
                SELECT * FROM productos_locales
                WHERE company_id = ? AND status != -1
                AND (nombre LIKE ? OR codigo LIKE ? OR categoria LIKE ?)
                ORDER BY nombre ASC LIMIT 60
            `);
            res.json(stmt.all(empresaId, term, term, term));
        } else {
            stmt = activeDb.prepare(`
                SELECT * FROM productos_locales
                WHERE status != -1
                AND (nombre LIKE ? OR codigo LIKE ? OR categoria LIKE ?)
                ORDER BY nombre ASC LIMIT 60
            `);
            res.json(stmt.all(term, term, term));
        }
    } catch (error) {
        console.error("❌ Error en Maestro buscando productos locales:", error.message);
        res.status(500).json({ error: error.message });
    }
});

server.get('/api/maestro/buscar-producto-por-codigo', (req, res) => {
    try {
        const codigo = req.query.codigo || '';
        const empresaId = req.query.empresaId;
        const codigoLimpio = String(codigo).trim();
        if (!codigoLimpio) return res.json(null);

        // 🛡️ PROTECCIÓN ANTI-COLISIÓN: Si el código es genérico, NO buscar por columna codigo
        const codigosGenericos = ['sin código', 'sin codigo', 's/c', 'sc', 'none', 'null', 'undefined'];
        const esGenerico = codigosGenericos.includes(codigoLimpio.toLowerCase());

        const activeDb = getPosDb() || serverDb;
        let stmt;
        if (empresaId && empresaId !== 'undefined' && empresaId.trim() !== '') {
            if (esGenerico) {
                stmt = activeDb.prepare(`
                    SELECT * FROM productos_locales
                    WHERE company_id = ? AND id = ? AND status != -1 AND status != 0
                    LIMIT 1
                `);
                res.json(stmt.get(empresaId, codigoLimpio) || null);
            } else {
                stmt = activeDb.prepare(`
                    SELECT * FROM productos_locales
                    WHERE company_id = ? AND (codigo = ? OR id = ?) AND status != -1 AND status != 0
                    LIMIT 1
                `);
                res.json(stmt.get(empresaId, codigoLimpio, codigoLimpio) || null);
            }
        } else {
            if (esGenerico) {
                stmt = activeDb.prepare(`
                    SELECT * FROM productos_locales
                    WHERE id = ? AND status != -1 AND status != 0
                    LIMIT 1
                `);
                res.json(stmt.get(codigoLimpio) || null);
            } else {
                stmt = activeDb.prepare(`
                    SELECT * FROM productos_locales
                    WHERE (codigo = ? OR id = ?) AND status != -1 AND status != 0
                    LIMIT 1
                `);
                res.json(stmt.get(codigoLimpio, codigoLimpio) || null);
            }
        }
    } catch (error) {
        console.error("❌ Error en Maestro buscando producto por código:", error.message);
        res.status(500).json({ error: error.message });
    }
});

server.get('/api/maestro/obtener-productos', (req, res) => {
    try {
        const empresaId = req.query.empresaId;
        const activeDb = getPosDb() || serverDb;
        let stmt;
        if (empresaId && empresaId !== 'undefined') {
            stmt = activeDb.prepare(`SELECT * FROM productos_locales WHERE company_id = ? AND status != -1 ORDER BY nombre ASC`);
            res.json(stmt.all(empresaId));
        } else {
            stmt = activeDb.prepare(`SELECT * FROM productos_locales WHERE status != -1 ORDER BY nombre ASC`);
            res.json(stmt.all());
        }
    } catch (error) {
        console.error("❌ Error en Maestro obteniendo productos:", error.message);
        res.status(500).json({ error: error.message });
    }
});

server.get('/api/maestro/obtener-productos-paginados', (req, res) => {
    try {
        const empresaId = req.query.empresaId;
        const limit = parseInt(req.query.limit) || 350;
        const offset = parseInt(req.query.offset) || 0;
        const letterFilter = req.query.letterFilter || '';
        const searchQuery = req.query.searchQuery || '';
        const activeDb = getPosDb() || serverDb;

        let baseQuery = `FROM productos_locales WHERE status != -1`;
        const params = [];

        if (empresaId && empresaId !== 'undefined') {
            baseQuery += ` AND company_id = ?`;
            params.push(empresaId);
        }

        if (searchQuery) {
            const term = `%${searchQuery.trim()}%`;
            baseQuery += ` AND (nombre LIKE ? OR codigo LIKE ? OR categoria LIKE ?)`;
            params.push(term, term, term);
        } else if (letterFilter) {
            if (letterFilter === '#') {
                baseQuery += ` AND (UPPER(SUBSTR(nombre, 1, 1)) < 'A' OR UPPER(SUBSTR(nombre, 1, 1)) > 'Z')`;
            } else {
                baseQuery += ` AND nombre LIKE ?`;
                params.push(`${letterFilter}%`);
            }
        }

        const countStmt = activeDb.prepare(`SELECT COUNT(*) as total ${baseQuery}`);
        const countResult = countStmt.get(...params);
        const totalCount = countResult ? countResult.total : 0;

        let data = [];
        if (limit === -1) {
            const dataStmt = activeDb.prepare(`SELECT * ${baseQuery} ORDER BY nombre ASC`);
            data = dataStmt.all(...params);
        } else {
            const dataStmt = activeDb.prepare(`SELECT * ${baseQuery} ORDER BY nombre ASC LIMIT ? OFFSET ?`);
            data = dataStmt.all(...params, limit, offset);
        }

        res.json({ data, totalCount });
    } catch (error) {
        console.error("❌ Error en Maestro obteniendo productos paginados:", error.message);
        res.status(500).json({ data: [], totalCount: 0, error: error.message });
    }
});

server.get(['/api/maestro/tasa', '/api/maestro/tasa/:companyId'], (req, res) => {
    try {
        let tasa = null;
        const activeDb = getPosDb();
        if (activeDb) {
            try {
                const row = activeDb.prepare("SELECT valor FROM configuracion WHERE clave = 'TASA_BCV' OR clave = 'dollarRate' ORDER BY fecha_actualizacion DESC LIMIT 1").get();
                if (row && row.valor) tasa = parseFloat(row.valor);
            } catch (eCfg) {
                console.warn("⚠️ [TASA] Error leyendo configuracion en posDb:", eCfg.message);
            }
            if (!tasa) {
                try {
                    const rowTasa = activeDb.prepare("SELECT valor FROM historial_tasas ORDER BY fecha DESC LIMIT 1").get();
                    if (rowTasa && rowTasa.valor) tasa = parseFloat(rowTasa.valor);
                } catch (eHist) {
                    console.warn("⚠️ [TASA] Error leyendo historial_tasas en posDb:", eHist.message);
                }
            }
        }
        if (!tasa) {
            try {
                const rowM = serverDb.prepare("SELECT valor FROM configuraciones_maestras WHERE clave = 'TASA_BCV' OR clave = 'dollarRate' LIMIT 1").get();
                if (rowM && rowM.valor) tasa = parseFloat(rowM.valor);
            } catch (eM) {
                console.warn("⚠️ [TASA] Error leyendo configuraciones_maestras:", eM.message);
            }
        }
        if (!tasa && config && config.tasa_bcv) {
            tasa = parseFloat(config.tasa_bcv);
        }
        res.json({ tasa: tasa || 1, success: true });
    } catch(error) {
        console.error("❌ Error en Maestro obteniendo tasa:", error.message);
        res.status(500).json({ error: error.message, tasa: 1 });
    }
});

server.get('/api/maestro/configuracion-fiscal', (req, res) => {
    try {
        const activeDb = getPosDb();
        if (activeDb) {
            const row = activeDb.prepare('SELECT * FROM configuracion_fiscal WHERE id = 1').get();
            if (row) return res.json(row);
        }
        res.json({ id: 1, iva_exento: 0, iva_general: 16, iva_reducido: 8, iva_anadida: 31, igtf_porcentaje: 3 });
    } catch (error) {
        res.json({ id: 1, iva_exento: 0, iva_general: 16, iva_reducido: 8, iva_anadida: 31, igtf_porcentaje: 3 });
    }
});

server.get(['/api/maestro/unidades-empaque', '/api/maestro/unidades-empaque/:productId'], (req, res) => {
    try {
        const productId = req.params.productId;
        const rawComp = req.query.companyId || req.query.company_id;
        const compId = (rawComp && rawComp !== 'undefined' && rawComp !== 'null' && String(rawComp).trim() !== '') ? String(rawComp).trim() : null;
        const activeDb = getPosDb() || serverDb;
        const conds = ['COALESCE(status, 1) != -1'];
        const params = [];
        if (productId) {
            conds.push('product_id = ?');
            params.push(productId);
        }
        if (compId) {
            conds.push("(company_id = ? OR company_id IS NULL OR company_id = '')");
            params.push(compId);
        }
        const rows = activeDb.prepare(`SELECT * FROM unidades_empaque WHERE ${conds.join(' AND ')} ORDER BY factor_cantidad ASC`).all(...params);
        res.json(rows || []);
    } catch (error) {
        res.json([]);
    }
});

server.post('/api/maestro/unidades-empaque/sincronizar', (req, res) => {
    try {
        const body = req.body || {};
        const lista = Array.isArray(body.items) ? body.items : (Array.isArray(body) ? body : [body]);
        const validos = lista.filter(u => u && u.id && u.product_id);
        if (validos.length === 0) {
            return res.status(400).json({ success: false, error: 'Datos de unidad de empaque incompletos' });
        }
        const ahora = getCaracasTime();
        const conns = [getPosDb(), serverDb].filter(Boolean);
        const aplicar = (conn) => {
            const stmt = conn.prepare(`
                INSERT INTO unidades_empaque (id, company_id, product_id, nombre_producto, nombre_unidad, tipo_medida, factor_cantidad, status, estado_sync, fecha_modificacion, ultima_sincronizacion)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    company_id = COALESCE(excluded.company_id, unidades_empaque.company_id),
                    product_id = excluded.product_id,
                    nombre_producto = excluded.nombre_producto,
                    nombre_unidad = excluded.nombre_unidad,
                    tipo_medida = excluded.tipo_medida,
                    factor_cantidad = excluded.factor_cantidad,
                    status = excluded.status,
                    estado_sync = excluded.estado_sync,
                    fecha_modificacion = excluded.fecha_modificacion,
                    ultima_sincronizacion = excluded.ultima_sincronizacion
            `);
            conn.transaction((items) => {
                for (const u of items) {
                    stmt.run(
                        u.id,
                        u.company_id || null,
                        u.product_id,
                        u.nombre_producto || '',
                        u.nombre_unidad || '',
                        u.tipo_medida || 'UNIDAD',
                        parseFloat(u.factor_cantidad) || 1,
                        u.status !== undefined && u.status !== null ? Number(u.status) : 1,
                        u.estado_sync === 1 ? 1 : 0,
                        u.fecha_modificacion || ahora,
                        ahora
                    );
                }
            })(validos);
        };
        for (const conn of conns) {
            try { aplicar(conn); } catch (eC) {
                console.warn('⚠️ [EMPAQUE LAN] Error escribiendo en DB:', eC.message);
            }
        }
        res.json({ success: true, exito: true, ids_procesados: validos.map(u => String(u.id)) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

server.delete('/api/maestro/unidades-empaque/:id', (req, res) => {
    try {
        const { id } = req.params;
        const ahora = getCaracasTime();
        const conns = [getPosDb(), serverDb].filter(Boolean);
        for (const conn of conns) {
            try {
                conn.prepare('UPDATE unidades_empaque SET status = -1, estado_sync = 0, fecha_modificacion = ? WHERE id = ?').run(ahora, id);
            } catch (eDel) {
                console.warn('⚠️ [EMPAQUE DELETE] Error en DB:', eDel.message);
            }
        }
        res.json({ success: true, exito: true, id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

server.delete('/api/maestro/eliminar-cliente/:rif', (req, res) => {
    try {
        const rawComp = req.query.companyId || req.query.company_id || (req.body && (req.body.company_id || req.body.companyId));
        const compId = (rawComp && rawComp !== 'undefined' && rawComp !== 'null' && String(rawComp).trim() !== '') ? String(rawComp).trim() : null;
        const ahora = getCaracasTime();
        if (compId) {
            serverDb.prepare('UPDATE clientes_maestro SET status = -1, estado_sync = 0, fecha_modificacion = ? WHERE (rif = ? OR UPPER(rif) = UPPER(?)) AND company_id = ?').run(ahora, req.params.rif, req.params.rif, compId);
        } else {
            serverDb.prepare('UPDATE clientes_maestro SET status = -1, estado_sync = 0, fecha_modificacion = ? WHERE rif = ? OR UPPER(rif) = UPPER(?)').run(ahora, req.params.rif, req.params.rif);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


    server.post('/api/maestro/guardar-borrador', (req, res) => {
    emitirPulsoBorrador();
    const b = req.body;
    try {
        const stmt = serverDb.prepare(`
            INSERT OR REPLACE INTO facturas_borradores 
            (id, cliente_nombre, cliente_id, items, subtotal, iva, total, metodos_pago, fecha, usuario_id, sucursal_id, company_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(b.id, b.customerName, b.customerIdNumber, b.items, b.subtotal, b.iva, b.total, b.payments, b.createdAt, b.userId, b.branchId, b.companyId);
        res.json({ exito: true, mensaje: "Borrador guardado en el Cerebro." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Endpoint: Obtener todos los borradores de la sucursal
server.get('/api/maestro/obtener-borradores', (req, res) => {
    const { sucursalId, companyId } = req.query;
    try {
        // Seleccionamos todos los campos de la tabla local
        const rows = serverDb.prepare(`
            SELECT * FROM facturas_borradores 
            WHERE sucursal_id = ? AND company_id = ?
            ORDER BY fecha DESC
        `).all(sucursalId, companyId);
        
        // Parseamos los campos JSON para que el frontend los reciba como objetos
        const facturas = rows.map(r => ({
            ...r,
            items: r.items ? JSON.parse(r.items) : [],
            payments: r.metodos_pago ? JSON.parse(r.metodos_pago) : {}
        }));
        res.json(facturas);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Endpoint: Eliminar Borrador
server.delete('/api/maestro/eliminar-borrador/:id', (req, res) => {
    emitirPulsoBorrador();
    try {
        serverDb.prepare('DELETE FROM facturas_borradores WHERE id = ?').run(req.params.id);
        res.json({ exito: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

server.get('/api/maestro/notificar-cambio/:tipo', (req, res) => {
    const { tipo } = req.params;
    cajasEscuchando.forEach(caja => {
        try {
            caja.write(`data: CAMBIO_${tipo.toUpperCase()}\n\n`);
        } catch (e) { /* Cliente SSE desconectado */ }
    });
    res.json({ exito: true });
});

server.get('/api/maestro/borradores-stream', (req, res) => {
    // Configuramos la respuesta como un flujo continuo (túnel abierto)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Evita buffering en proxies/nginx
    res.flushHeaders();

    cajasEscuchando.push(res); // Registramos la computadora que se conectó
    console.log(`📡 [SSE] Nueva caja conectada. Total activas: ${cajasEscuchando.length}`);

    // Heartbeat cada 20s para mantener la conexión viva en routers con idle timeout
    const heartbeatInterval = setInterval(() => {
        try {
            res.write(':heartbeat\n\n');
        } catch (e) {
            // Si falla el write, la conexión ya murió — la limpiamos
            clearInterval(heartbeatInterval);
            cajasEscuchando = cajasEscuchando.filter(caja => caja !== res);
        }
    }, 20000);

    // Si la caja se apaga o cierra, la quitamos de la lista y limpiamos el timer
    req.on('close', () => {
        clearInterval(heartbeatInterval);
        cajasEscuchando = cajasEscuchando.filter(caja => caja !== res);
        console.log(`📴 [SSE] Caja desconectada. Total activas: ${cajasEscuchando.length}`);
    });
});

server.get('/api/cuentas_por_cobrar', (req, res) => {
    try {
        const companyId = req.query.companyId || req.query.company_id || null;
        migrarCuentasPorCobrarHuerfanas();
        const filtroEmp = construirFiltroEmpresaCxc(companyId);
        const sql = `SELECT * FROM cuentas_por_cobrar WHERE ${filtroEmp.clause} ORDER BY fecha DESC`;
        const rows = serverDb.prepare(sql).all(...filtroEmp.params);
        rows.forEach(r => {
            const mUsd = parseFloat(r.monto_usd || 0);
            const mBs = parseFloat(r.monto_bs || 0);
            const pagado = parseFloat(r.monto_pagado || 0);
            const estadoUpper = String(r.estado || '').toUpperCase().trim();
            if ((!r.tasa_emision || r.tasa_emision <= 0) && mBs > 0 && mUsd > 0) {
                r.tasa_emision = parseFloat((mBs / mUsd).toFixed(4));
            }
            if ((mUsd > 0 && (mUsd - pagado) <= 0.01) || estadoUpper === 'PAGADA' || estadoUpper === 'PAGADO') {
                r.estado = 'PAGADA';
            } else if (pagado > 0) {
                r.estado = 'ABONADO';
            } else {
                r.estado = 'PENDIENTE';
            }
        });
        res.json(rows);
    } catch (error) {
        console.error("❌ Error consultando la tabla cuentas_por_cobrar:", error.message);
        res.status(500).json({ error: "Error al extraer las deudas." });
    }
});

server.get('/api/maestro/cxc/abonos', (req, res) => {
    try {
        const companyId = req.query.companyId || req.query.company_id || null;
        const facturaNro = req.query.factura_nro || req.query.facturaNro || null;
        const cuentaId = req.query.cuenta_id || req.query.cuentaId || null;
        const clienteId = req.query.cliente_id || req.query.clienteId || null;

        const filtroEmp = construirFiltroEmpresaCxc(companyId);
        const conds = [filtroEmp.clause];
        const params = [...filtroEmp.params];

        if (cuentaId) {
            conds.push('cuenta_id = ?');
            params.push(cuentaId);
        }
        if (facturaNro) {
            conds.push('TRIM(COALESCE(factura_nro, \'\')) = TRIM(?)');
            params.push(String(facturaNro));
        }
        if (clienteId) {
            conds.push(`REPLACE(UPPER(TRIM(COALESCE(cliente_id, ''))), '-', '') = REPLACE(UPPER(TRIM(?)), '-', '')`);
            params.push(String(clienteId));
        }

        const sql = `SELECT * FROM abonos_cuentas_cobrar WHERE ${conds.join(' AND ')} ORDER BY fecha DESC`;
        const rows = serverDb.prepare(sql).all(...params);
        res.json(rows);
    } catch (error) {
        console.error("❌ Error consultando historial de abonos CXC:", error.message);
        res.status(500).json({ error: "Error al extraer el historial de abonos." });
    }
});

// Endpoint para recibir cierres de las laptops de la red
server.post('/api/maestro/registrar-cierre', (req, res) => {
    const c = req.body;
    console.log(`\n🏁 [API MAESTRO] Recibiendo Cierre Z de Caja: ${c.cashierId} | Sucursal: ${c.branchId}`);

    try {
        const stmt = serverDb.prepare(`
            INSERT OR REPLACE INTO cierres_caja_maestros (
                id, fecha, company_id, branch_id, cashier_id,
                total_ventas_bs, total_ventas_usd, total_gastos_bs,
                total_gastos_usd, total_ingresos_bs, total_diferencia_bs,
                total_diferencia_usd, detalle_pagos_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            c.id,
            c.fecha || getCaracasTime(),
            c.companyId,
            c.branchId,
            c.cashierId,
            c.totalSalesBs || 0,
            c.totalSalesDollars || 0,
            c.totalExpensesBs || 0,
            c.totalExpensesDollars || 0,
            c.totalIncomes || 0,
            c.totalDifferenceBs || 0,
            c.totalDifferenceDollars || 0,
            c.paymentsConciliation || '{}'
        );

        console.log(`✅ Cierre ${c.id} guardado en Servidor Maestro.`);
        res.json({ exito: true });
    } catch (e) {
        console.error("❌ Error guardando cierre en Maestro:", e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

// 🛡️ FUNCIÓN LIMPIADORA ANTI-BASE64 PARA REDUCIR PESO DE VENTAS
function sanitizarDatosJsonVenta(datosJsonRaw) {
    if (!datosJsonRaw) return '{}';
    try {
        let obj = typeof datosJsonRaw === 'string' ? JSON.parse(datosJsonRaw) : datosJsonRaw;
        if (!obj || typeof obj !== 'object') return '{}';
        delete obj.imagen;
        delete obj.image;
        const prods = obj.productos || obj.items;
        if (Array.isArray(prods)) {
            const limpios = prods.map(p => {
                if (!p || typeof p !== 'object') return p;
                const { imagen, image, datos_json, ...resto } = p;
                for (const k of Object.keys(resto)) {
                    if (typeof resto[k] === 'string' && (resto[k].startsWith('data:image') || resto[k].length > 500)) {
                        delete resto[k];
                    }
                }
                return resto;
            });
            if (obj.productos) obj.productos = limpios;
            if (obj.items) obj.items = limpios;
        }
        return JSON.stringify(obj);
    } catch (e) {
        return typeof datosJsonRaw === 'string' ? datosJsonRaw : JSON.stringify(datosJsonRaw);
    }
}

// Las estadísticas filtran con BETWEEN 'YYYY-MM-DD 00:00:00' AND 'YYYY-MM-DD 23:59:59' (comparación de texto).
// Una fecha ISO ('2026-10-04T10:22:36.599Z') queda fuera de ese rango y además está en UTC.
// Se normaliza SIEMPRE a hora local 'YYYY-MM-DD HH:MM:SS'.
function normalizarFechaLocalVenta(fecha) {
    const pad = (n) => String(n).padStart(2, '0');
    let d = null;
    if (fecha && typeof fecha === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(fecha.trim())) {
        return fecha.trim(); // Ya está en formato local correcto
    }
    if (fecha) {
        const parsed = new Date(fecha);
        if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d) d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

server.post('/api/maestro/registrar-venta', (req, res) => {
    const v = req.body || {};
    console.log(`\n🛒 [API MAESTRO] Recibiendo Venta/NC: ${v.numero_factura} de Sucursal: ${v.branch_id}`);

    try {
        // Sanitizar payload JSON para evitar almacenar imágenes Base64 pesadas
        v.datos_json = sanitizarDatosJsonVenta(v.datos_json);

        const ventaId = v.id || v.numero_factura || `VTA-${Date.now()}`;
        const syncServerVal = v.origen_maestro ? (v.sync_server ? 1 : 0) : 0;
        const estadoVal = v.estado || 'EMITIDA';
        const esAnuladaVal = (v.es_anulada !== undefined && v.es_anulada !== null)
            ? (v.es_anulada ? 1 : 0)
            : (String(estadoVal).toUpperCase() === 'ANULADA' ? 1 : 0);
        const totalIvaVal = (v.total_iva !== undefined && v.total_iva !== null) ? v.total_iva : (v.monto_iva || 0);
        const alicuotaIvaVal = (v.alicuota_iva !== undefined && v.alicuota_iva !== null) ? v.alicuota_iva : 16;

        const stmt = serverDb.prepare(`
            INSERT INTO ventas_locales (
                id, company_id, branch_id, cashier_id, numero_factura,
                numero_control, cliente_nombre, cliente_rif, monto_exento,
                base_imponible, monto_iva, total_iva, monto_igtf, monto_total,
                tasa_bcv, metodo_pago, datos_json, estado_sync, estado_sync_maestro,
                sync_server, fecha_emision, estado_cierre, es_nota_credito, es_nota_debito,
                factura_afectada, monto_factura_afectada, fecha_factura_afectada,
                comprobante_retencion_id, ganancia_venta, estado, es_anulada,
                alicuota_iva, ventas_exportacion, iva_retenido_cliente,
                numero_comprobante_retencion_cliente, fecha_retencion_cliente, ultima_sincronizacion
            ) VALUES (
                @id, @company_id, @branch_id, @cashier_id, @numero_factura,
                @numero_control, @cliente_nombre, @cliente_rif, @monto_exento,
                @base_imponible, @monto_iva, @total_iva, @monto_igtf, @monto_total,
                @tasa_bcv, @metodo_pago, @datos_json, @estado_sync, @estado_sync_maestro,
                @sync_server, @fecha_emision, @estado_cierre, @es_nota_credito, @es_nota_debito,
                @factura_afectada, @monto_factura_afectada, @fecha_factura_afectada,
                @comprobante_retencion_id, @ganancia_venta, @estado, @es_anulada,
                @alicuota_iva, @ventas_exportacion, @iva_retenido_cliente,
                @numero_comprobante_retencion_cliente, @fecha_retencion_cliente, @ultima_sincronizacion
            )
            ON CONFLICT(id) DO UPDATE SET
                company_id = excluded.company_id,
                branch_id = excluded.branch_id,
                cashier_id = excluded.cashier_id,
                numero_factura = excluded.numero_factura,
                numero_control = excluded.numero_control,
                cliente_nombre = excluded.cliente_nombre,
                cliente_rif = excluded.cliente_rif,
                monto_exento = excluded.monto_exento,
                base_imponible = excluded.base_imponible,
                monto_iva = excluded.monto_iva,
                total_iva = excluded.total_iva,
                monto_igtf = excluded.monto_igtf,
                monto_total = excluded.monto_total,
                tasa_bcv = excluded.tasa_bcv,
                metodo_pago = excluded.metodo_pago,
                datos_json = excluded.datos_json,
                estado_sync = excluded.estado_sync,
                estado_sync_maestro = 1,
                sync_server = CASE WHEN excluded.sync_server = 0 THEN 0 ELSE ventas_locales.sync_server END,
                fecha_emision = excluded.fecha_emision,
                estado_cierre = excluded.estado_cierre,
                es_nota_credito = excluded.es_nota_credito,
                es_nota_debito = excluded.es_nota_debito,
                factura_afectada = excluded.factura_afectada,
                monto_factura_afectada = excluded.monto_factura_afectada,
                fecha_factura_afectada = excluded.fecha_factura_afectada,
                comprobante_retencion_id = COALESCE(NULLIF(excluded.comprobante_retencion_id, ''), ventas_locales.comprobante_retencion_id),
                ganancia_venta = excluded.ganancia_venta,
                estado = excluded.estado,
                es_anulada = excluded.es_anulada,
                alicuota_iva = excluded.alicuota_iva,
                ventas_exportacion = excluded.ventas_exportacion,
                iva_retenido_cliente = CASE WHEN excluded.iva_retenido_cliente > 0 THEN excluded.iva_retenido_cliente ELSE ventas_locales.iva_retenido_cliente END,
                numero_comprobante_retencion_cliente = COALESCE(NULLIF(excluded.numero_comprobante_retencion_cliente, ''), ventas_locales.numero_comprobante_retencion_cliente),
                fecha_retencion_cliente = COALESCE(NULLIF(excluded.fecha_retencion_cliente, ''), ventas_locales.fecha_retencion_cliente),
                ultima_sincronizacion = COALESCE(excluded.ultima_sincronizacion, ventas_locales.ultima_sincronizacion)
        `);

        stmt.run({
            id: ventaId,
            company_id: v.company_id || null,
            branch_id: v.branch_id || null,
            cashier_id: v.cashier_id || null,
            numero_factura: v.numero_factura || null,
            numero_control: v.numero_control || null,
            cliente_nombre: v.cliente_nombre || null,
            cliente_rif: v.cliente_rif || null,
            monto_exento: v.monto_exento || 0,
            base_imponible: v.base_imponible || 0,
            monto_iva: v.monto_iva || 0,
            total_iva: totalIvaVal,
            monto_igtf: v.monto_igtf || 0,
            monto_total: v.monto_total || 0,
            tasa_bcv: v.tasa_bcv || 1,
            metodo_pago: v.metodo_pago || null,
            datos_json: v.datos_json || '{}',
            estado_sync: (v.estado_sync !== undefined && v.estado_sync !== null) ? v.estado_sync : 1,
            estado_sync_maestro: 1,
            sync_server: syncServerVal,
            fecha_emision: normalizarFechaLocalVenta(v.fecha_emision),
            estado_cierre: v.estado_cierre || 0,
            es_nota_credito: v.es_nota_credito || 0,
            es_nota_debito: v.es_nota_debito || 0,
            factura_afectada: v.factura_afectada || null,
            monto_factura_afectada: v.monto_factura_afectada || null,
            fecha_factura_afectada: v.fecha_factura_afectada || null,
            comprobante_retencion_id: v.comprobante_retencion_id || null,
            ganancia_venta: v.ganancia_venta || 0,
            estado: estadoVal,
            es_anulada: esAnuladaVal,
            alicuota_iva: alicuotaIvaVal,
            ventas_exportacion: v.ventas_exportacion || 0,
            iva_retenido_cliente: v.iva_retenido_cliente || 0,
            numero_comprobante_retencion_cliente: v.numero_comprobante_retencion_cliente || '',
            fecha_retencion_cliente: v.fecha_retencion_cliente || '',
            ultima_sincronizacion: v.ultima_sincronizacion || null
        });

        // ☁️ Encolar descuento de stock para el VPS (para ventas originadas en caja hija)
        if (!v.origen_maestro) {
            try {
                const activeDb = getPosDb() || serverDb;
                let prodArray = [];
                if (v.datos_json) {
                    const parsed = typeof v.datos_json === 'string' ? JSON.parse(v.datos_json) : v.datos_json;
                    prodArray = Array.isArray(parsed) ? parsed : (parsed.productos || parsed.items || []);
                }
                const itemsDescuento = prodArray
                    .filter(p => {
                        const nombre = String(p.nombre || '').toUpperCase();
                        return !nombre.includes('ABONO') && !nombre.includes('DEUDA') && !nombre.includes('SERVICIO');
                    })
                    .map(p => ({
                        id: p.id || p.producto_ID || p.producto_id,
                        cantidad: parseFloat(p.cantidad || p.quantity || 1)
                    }))
                    .filter(p => Boolean(p.id));

                if (itemsDescuento.length > 0) {
                    const idRegistro = String(v.id || v.numero_factura || '');
                    const payloadDescuento = {
                        company_id: v.company_id,
                        sucursal_id: v.branch_id,
                        items: itemsDescuento,
                        tipo_movimiento: 'VENTA',
                        factura_ref: v.numero_factura
                    };
                    activeDb.prepare(`CREATE TABLE IF NOT EXISTS sync_queue (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        operacion TEXT,
                        tabla TEXT,
                        id_registro TEXT,
                        datos TEXT,
                        fecha_creacion DATETIME DEFAULT (datetime('now', '-4 hours')),
                        intentos INTEGER DEFAULT 0,
                        ultimo_error TEXT,
                        estado TEXT DEFAULT 'PENDIENTE'
                    )`).run();

                    // Asegurar columnas de reintento si sync_queue existía con esquema legado
                    const colsQueue = activeDb.prepare('PRAGMA table_info(sync_queue)').all().map(c => c.name);
                    if (!colsQueue.includes('intentos')) activeDb.prepare("ALTER TABLE sync_queue ADD COLUMN intentos INTEGER DEFAULT 0").run();
                    if (!colsQueue.includes('ultimo_error')) activeDb.prepare("ALTER TABLE sync_queue ADD COLUMN ultimo_error TEXT").run();
                    if (!colsQueue.includes('estado')) activeDb.prepare("ALTER TABLE sync_queue ADD COLUMN estado TEXT DEFAULT 'PENDIENTE'").run();

                    const yaEnCola = idRegistro
                        ? activeDb.prepare(`SELECT id FROM sync_queue WHERE tabla = 'ventas_descuento_vps' AND id_registro = ? LIMIT 1`).get(idRegistro)
                        : null;
                    if (!yaEnCola) {
                        activeDb.prepare('INSERT INTO sync_queue (operacion, tabla, id_registro, datos) VALUES (?, ?, ?, ?)')
                            .run('CREAR', 'ventas_descuento_vps', idRegistro, JSON.stringify(payloadDescuento));
                        console.log(`📦 Venta de caja hija ${v.numero_factura} encolada en Servidor Maestro para sync VPS (${itemsDescuento.length} productos).`);
                    }
                }
            } catch (eQueue) {
                console.warn("⚠️ No se pudo encolar venta de caja hija para VPS:", eQueue.message);
            }
        }

        res.json({ exito: true });
    } catch (e) {
        console.error("❌ Error guardando venta en Maestro:", e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

server.post('/api/maestro/anular-venta', (req, res) => {
    const { facturaId, numeroFactura, companyId, branchId, cashierId, productos, metodosReintegro, motivo, clienteNombre } = req.body || {};
    const rawComp = companyId || (req.body && req.body.company_id);
    const rawBranch = branchId || (req.body && req.body.branch_id);
    const compIdClean = (rawComp && rawComp !== 'undefined' && rawComp !== 'null' && String(rawComp).trim() !== '') ? String(rawComp).trim() : null;
    const branchIdClean = (rawBranch && rawBranch !== 'undefined' && rawBranch !== 'null' && String(rawBranch).trim() !== '') ? String(rawBranch).trim() : null;
    const fIdClean = (facturaId && facturaId !== 'undefined' && facturaId !== 'null' && String(facturaId).trim() !== '') ? String(facturaId).trim() : null;
    const numFacClean = (numeroFactura && numeroFactura !== 'undefined' && numeroFactura !== 'null' && String(numeroFactura).trim() !== '') ? String(numeroFactura).trim() : null;

    console.log(`\n🚫 [API MAESTRO] Anulando Venta/Ticket: ${numFacClean || fIdClean} de Sucursal: ${branchIdClean || 'N/A'}`);

    try {
        const transaccion = serverDb.transaction(() => {
            // 1. Marcar venta como ANULADA y ganancia a 0 (aislado por company_id y branch_id)
            if (fIdClean || numFacClean) {
                const matchClauses = [];
                const matchParams = [];
                if (fIdClean) {
                    matchClauses.push('id = ?');
                    matchParams.push(fIdClean);
                }
                if (numFacClean) {
                    if (branchIdClean) {
                        matchClauses.push('(numero_factura = ? AND branch_id = ?)');
                        matchParams.push(numFacClean, branchIdClean);
                    } else {
                        matchClauses.push('numero_factura = ?');
                        matchParams.push(numFacClean);
                    }
                }

                let whereSql = `(${matchClauses.join(' OR ')})`;
                if (compIdClean) {
                    whereSql += ' AND company_id = ?';
                    matchParams.push(compIdClean);
                } else {
                    console.warn(`⚠️ [API MAESTRO] anular-venta sin companyId para ${numFacClean || fIdClean}; aplicando fallback controlado.`);
                }

                serverDb.prepare(`
                    UPDATE ventas_locales 
                    SET estado = 'ANULADA', es_anulada = 1, ganancia_venta = 0, estado_sync = 0, sync_server = 0
                    WHERE ${whereSql}
                `).run(...matchParams);
            }

            // 2. Reintegrar stock de los productos físicos
            if (Array.isArray(productos) && productos.length > 0) {
                const stmtStockSuc = serverDb.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real + ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ? AND sucursal_id = ?');
                const stmtStockGlobal = serverDb.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real + ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ?');
                const stmtKardex = serverDb.prepare('INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento, referencia_id, estado_sync) VALUES (?, ?, ?, ?, ?, ?, 1)');

                productos.forEach(item => {
                    const cant = parseFloat(item.cantidad || item.qty || 1);
                    const prodId = item.id || item.producto_id || item.producto_ID;
                    const nombre = String(item.nombre || item.name || '').toUpperCase();
                    
                    if (prodId && cant > 0 && !nombre.includes('ABONO') && !nombre.includes('DEUDA') && !nombre.includes('SERVICIO')) {
                        if (branchIdClean) {
                            const resSuc = stmtStockSuc.run(cant, prodId, branchIdClean);
                            if (resSuc.changes === 0) stmtStockGlobal.run(cant, prodId);
                        } else {
                            stmtStockGlobal.run(cant, prodId);
                        }
                        try {
                            stmtKardex.run(compIdClean || 'DEFAULT', branchIdClean || 'GLOBAL', prodId, cant, 'ANULACION_VENTA', numFacClean || fIdClean);
                        } catch (eK) {
                            console.warn("⚠️ [KARDEX] Error registrando anulación en movimientos_stock_maestro:", eK.message);
                        }
                    }
                });
            }

            // 3. Registrar salidas de dinero (GASTO) en movimientos de caja
            if (Array.isArray(metodosReintegro) && metodosReintegro.length > 0) {
                const stmtMovCaja = serverDb.prepare(`
                    INSERT INTO movimientos_caja_locales (
                        id, tipo, concepto, monto, monto_usd, metodo_pago, fecha, cashier_id, company_id, branch_id, estado_cierre
                    ) VALUES (?, 'GASTO', ?, ?, ?, ?, datetime('now', '-4 hours'), ?, ?, ?, 0)
                `);

                metodosReintegro.forEach(m => {
                    const montoBs = parseFloat(m.montoBs || m.monto || 0);
                    const montoUsd = parseFloat(m.montoUsd || m.monto_usd || 0);
                    if (montoBs > 0 || montoUsd > 0) {
                        const idMov = `ANUL-${Date.now()}-${Math.floor(Math.random()*1000)}`;
                        const concepto = `Anulación Ticket No Fiscal #${numFacClean || fIdClean} - ${clienteNombre || 'Cliente'}`;
                        stmtMovCaja.run(idMov, concepto, montoBs, montoUsd, m.metodo || m.metodo_pago || 'Efectivo', cashierId || 'SISTEMA', compIdClean || 'DEFAULT', branchIdClean || 'GLOBAL');
                    }
                });
            }
        });

        transaccion();

        try { process.send({ tipo: 'stock-actualizado' }); } catch (e) { /* Canal IPC no disponible */ }
        console.log(`✅ [API MAESTRO] Venta ${numFacClean || fIdClean} anulada y stock reintegrado con éxito.`);
        res.json({ exito: true });
    } catch (e) {
        console.error("❌ Error anulando venta en Maestro:", e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

// ==========================================
// 📑 ENDPOINTS MAESTROS PARA PRESUPUESTOS / COTIZACIONES
// ==========================================
server.post('/api/maestro/guardar-presupuesto', (req, res) => {
    const datos = req.body;
    try {
        const stmt = serverDb.prepare(`
            INSERT OR REPLACE INTO presupuestos_locales (
                id, company_id, branch_id, cashier_id, numero_presupuesto,
                cliente_nombre, cliente_rif, cliente_direccion, cliente_telefono,
                subtotal, monto_iva, monto_total, tasa_bcv, moneda, validez_dias,
                estado, fecha_emision, datos_json, estado_sync
            ) VALUES (
                @id, @company_id, @branch_id, @cashier_id, @numero_presupuesto,
                @cliente_nombre, @cliente_rif, @cliente_direccion, @cliente_telefono,
                @subtotal, @monto_iva, @monto_total, @tasa_bcv, @moneda, @validez_dias,
                @estado, @fecha_emision, @datos_json, 1
            )
        `);

        stmt.run({
            id: datos.id || `PRE-${Date.now()}`,
            company_id: datos.company_id || '',
            branch_id: datos.branch_id || '',
            cashier_id: datos.cashier_id || '',
            numero_presupuesto: datos.numero_presupuesto,
            cliente_nombre: datos.cliente_nombre || 'CONSUMIDOR FINAL',
            cliente_rif: datos.cliente_rif || 'V-00000000',
            cliente_direccion: datos.cliente_direccion || '',
            cliente_telefono: datos.cliente_telefono || '',
            subtotal: datos.subtotal || 0,
            monto_iva: datos.monto_iva || 0,
            monto_total: datos.monto_total || 0,
            tasa_bcv: datos.tasa_bcv || 1,
            moneda: datos.moneda || 'USD',
            validez_dias: datos.validez_dias || 1,
            estado: datos.estado || 'EMITIDO',
            fecha_emision: datos.fecha_emision || getCaracasTime(),
            datos_json: typeof datos.datos_json === 'object' ? JSON.stringify(datos.datos_json) : (datos.datos_json || '{}')
        });

        console.log(`✅ [API MAESTRO] Presupuesto guardado en cerebro: ${datos.numero_presupuesto}`);
        res.json({ success: true, id: datos.id, numero_presupuesto: datos.numero_presupuesto });
    } catch (e) {
        console.error("❌ Error guardando presupuesto en Cerebro:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

server.get('/api/maestro/obtener-presupuestos', (req, res) => {
    const { filtro, companyId, branchId } = req.query;
    try {
        let query = `SELECT * FROM presupuestos_locales WHERE 1=1`;
        const params = [];

        if (companyId) {
            query += ` AND company_id = ?`;
            params.push(companyId);
        }

        if (filtro && filtro.trim()) {
            const f = `%${filtro.trim()}%`;
            query += ` AND (numero_presupuesto LIKE ? OR cliente_nombre LIKE ? OR cliente_rif LIKE ?)`;
            params.push(f, f, f);
        }

        query += ` ORDER BY fecha_emision DESC LIMIT 100`;

        const rows = serverDb.prepare(query).all(...params);
        res.json(rows || []);
    } catch (e) {
        console.error("❌ Error obteniendo presupuestos en Cerebro:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

server.post('/api/maestro/marcar-presupuesto-facturado', (req, res) => {
    const { id } = req.body;
    try {
        serverDb.prepare(`
            UPDATE presupuestos_locales 
            SET estado = 'CONVERTIDO_A_VENTA' 
            WHERE id = ? OR numero_presupuesto = ?
        `).run(id, id);
        res.json({ success: true });
    } catch (e) {
        console.error("❌ Error marcando presupuesto como facturado:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

server.post('/api/maestro/registrar-reporte-fiscal', (req, res) => {
    const b = req.body || {};
    const tipoReporte = b.tipoReporte || b.tipo_reporte || b.tipo || 'Z';
    const numeroZ = b.numeroZ || b.numero_z || b.z_number || '';
    const companyId = b.companyId || b.company_id || null;
    const branchId = b.branchId || b.branch_id || null;
    const cashierId = b.cashierId || b.cashier_id || null;
    const fechaEmision = b.fechaEmision || b.fecha_emision || getCaracasTime().split(' ')[0];
    const horaEmision = b.horaEmision || b.hora_emision || getCaracasTime().split(' ')[1] || '';
    const ultimaFactura = b.ultimaFactura || b.ultima_factura || '';
    const exento = parseFloat(b.exento) || 0;
    const base1 = parseFloat(b.base_imponible_tasa_1 ?? b.base1) || 0;
    const impuesto1 = parseFloat(b.impuesto_tasa_1 ?? b.impuesto1) || 0;
    const base2 = parseFloat(b.base_imponible_tasa_2 ?? b.base2) || 0;
    const impuesto2 = parseFloat(b.impuesto_tasa_2 ?? b.impuesto2) || 0;
    const base3 = parseFloat(b.base_imponible_tasa_3 ?? b.base3) || 0;
    const impuesto3 = parseFloat(b.impuesto_tasa_3 ?? b.impuesto3) || 0;
    const igtf = parseFloat(b.igtf) || 0;
    const rawInput = b.rawData !== undefined ? b.rawData : (b.raw_data !== undefined ? b.raw_data : b.json_data);
    const rawData = typeof rawInput === 'string' ? rawInput : (rawInput ? JSON.stringify(rawInput) : '');
    const repId = String(b.id || `REP-${Date.now()}-${Math.floor(Math.random() * 1000)}`);

    console.log(`\n📄 [API MAESTRO] Recibiendo Reporte Fiscal: ${tipoReporte} (${numeroZ}) de Sucursal: ${branchId}`);

    try {
        serverDb.prepare(`
            INSERT INTO reportes_fiscales_cierre (
                id, company_id, branch_id, cashier_id, tipo_reporte, numero_z,
                fecha_emision, hora_emision, ultima_factura, exento,
                base_imponible_tasa_1, impuesto_tasa_1, base_imponible_tasa_2, impuesto_tasa_2,
                base_imponible_tasa_3, impuesto_tasa_3, igtf, raw_data, estado_sync
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(id) DO UPDATE SET
                company_id = COALESCE(excluded.company_id, reportes_fiscales_cierre.company_id),
                branch_id = COALESCE(excluded.branch_id, reportes_fiscales_cierre.branch_id),
                cashier_id = COALESCE(excluded.cashier_id, reportes_fiscales_cierre.cashier_id),
                tipo_reporte = excluded.tipo_reporte,
                numero_z = excluded.numero_z,
                fecha_emision = excluded.fecha_emision,
                hora_emision = excluded.hora_emision,
                ultima_factura = excluded.ultima_factura,
                exento = excluded.exento,
                base_imponible_tasa_1 = excluded.base_imponible_tasa_1,
                impuesto_tasa_1 = excluded.impuesto_tasa_1,
                base_imponible_tasa_2 = excluded.base_imponible_tasa_2,
                impuesto_tasa_2 = excluded.impuesto_tasa_2,
                base_imponible_tasa_3 = excluded.base_imponible_tasa_3,
                impuesto_tasa_3 = excluded.impuesto_tasa_3,
                igtf = excluded.igtf,
                raw_data = excluded.raw_data,
                estado_sync = 0
        `).run(
            repId, companyId, branchId, cashierId, tipoReporte, numeroZ,
            fechaEmision, horaEmision, ultimaFactura, exento,
            base1, impuesto1, base2, impuesto2,
            base3, impuesto3, igtf, rawData
        );

        // Retrocompatibilidad opcional si existe la tabla legada cierres_caja
        try {
            const existeLegacy = serverDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cierres_caja'").get();
            if (existeLegacy) {
                let mTotal = exento + base1 + impuesto1 + base2 + impuesto2 + base3 + impuesto3 + igtf;
                let vTotal = 0;
                const trimmedRaw = String(rawData || '').trim();
                if (trimmedRaw.startsWith('{') || trimmedRaw.startsWith('[')) {
                    try {
                        const parsed = JSON.parse(trimmedRaw);
                        if (parsed && parsed.ventasTotales !== undefined) mTotal = parsed.ventasTotales;
                        if (parsed && parsed.cantidadVentas !== undefined) vTotal = parsed.cantidadVentas;
                    } catch (eJson) {
                        console.warn("⚠️ [REPORTE FISCAL] Error parseando JSON para cierres_caja legacy:", eJson.message);
                    }
                }
                serverDb.prepare(`
                    INSERT INTO cierres_caja (
                        company_id, branch_id, numero_z, tipo_reporte, monto_total, ventas_totales, fecha, notas
                    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
                `).run(companyId, branchId, numeroZ, tipoReporte, mTotal, vTotal, rawData);
            }
        } catch (eLegacy) {
            console.warn("⚠️ [REPORTE FISCAL] Aviso escribiendo retrocompatibilidad cierres_caja:", eLegacy.message);
        }

        res.json({ exito: true, id: repId });
    } catch (e) {
        console.error("❌ Error guardando reporte fiscal en Maestro:", e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

server.get('/api/maestro/ventas/:branchId/:companyId', (req, res) => {
    try {
        const { branchId, companyId } = req.params;
        console.log(`📡 Consultando historial de ventas para la sucursal: ${branchId}`);

        // Buscamos todas las ventas de esta sucursal en la tabla central 'ventas_locales'
        // (Ordenadas de la más nueva a la más vieja)
        const stmt = serverDb.prepare(`
            SELECT * FROM ventas_locales 
            WHERE branch_id = ? AND company_id = ?
            ORDER BY id DESC
        `);
        
        const ventas = stmt.all(branchId, companyId);
        
        // Entregamos las ventas al frontend
        res.json(ventas);
        
    } catch (error) {
        console.error("❌ Error al consultar las ventas en el Maestro:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

// ENDPOINT: Obtener Historial de Cierres por Sucursal
    server.get('/api/maestro/cierres/:branchId/:companyId', (req, res) => {
        try {
            const { branchId, companyId } = req.params;
            console.log(`📡 Consultando historial de cierres para la sucursal: ${branchId}`);

            const stmt = serverDb.prepare(`
                SELECT * FROM cierres_caja_maestros 
                WHERE branch_id = ? AND company_id = ?
                ORDER BY fecha DESC
            `);
            
            const cierres = stmt.all(branchId, companyId);
            res.json(cierres);
            
        } catch (error) {
            console.error("❌ Error al consultar los cierres en el Maestro:", error.message);
            res.status(500).json({ exito: false, error: error.message });
        }
    });
// --- API ESTADÍSTICAS ---
server.get('/api/maestro/estadisticas', (req, res) => {
    try {
        const { fecha_inicio, fecha_fin, companyId, periodo } = req.query;
        if (!fecha_inicio || !fecha_fin || !companyId) {
            return res.status(400).json({ exito: false, error: "Faltan parámetros (fecha_inicio, fecha_fin, companyId)" });
        }

        const fechaIni = `${fecha_inicio} 00:00:00`;
        const fechaFin = `${fecha_fin} 23:59:59`;

        // 1. Ganancias estimadas
        const gananciaResult = serverDb.prepare(`
            SELECT SUM(ganancia_venta) as total_ganancia 
            FROM ventas_locales 
            WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
              AND (estado != 'ANULADA' OR estado IS NULL)
              AND (es_nota_credito = 0 OR es_nota_credito IS NULL)
        `).get(companyId, fechaIni, fechaFin);
        const total_ganancia = gananciaResult?.total_ganancia || 0;

        // 1.1 Ventas Totales (USD y Bs)
        const ventaResult = serverDb.prepare(`
            SELECT 
                SUM(monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1)) as total_venta,
                SUM(monto_total) as total_venta_bs
            FROM ventas_locales 
            WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
              AND (estado != 'ANULADA' OR estado IS NULL)
              AND (es_nota_credito = 0 OR es_nota_credito IS NULL)
        `).get(companyId, fechaIni, fechaFin);
        const total_venta = ventaResult?.total_venta || 0;
        const total_venta_bs = ventaResult?.total_venta_bs || 0;

        // 1.1 Costo de Mercancía Vendida (COGS) en USD
        const cogsResult = serverDb.prepare(`
            SELECT SUM((monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1)) - ganancia_venta) as total_cogs
            FROM ventas_locales
            WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
              AND (estado != 'ANULADA' OR estado IS NULL)
              AND (es_nota_credito = 0 OR es_nota_credito IS NULL)
        `).get(companyId, fechaIni, fechaFin);
        const total_cogs = Math.max(0, cogsResult?.total_cogs || 0);

        // 2. Top Clientes (Ranking Completo con normalización a USD por tasa de cada venta)
        const topClientes = serverDb.prepare(`
            SELECT cliente_nombre, cliente_rif, COUNT(*) as total_compras_count, 
                   SUM(monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1)) as total_comprado_usd,
                   SUM(monto_total) as total_comprado
            FROM ventas_locales
            WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
              AND (estado != 'ANULADA' OR estado IS NULL)
              AND (es_nota_credito = 0 OR es_nota_credito IS NULL)
            GROUP BY cliente_rif
            ORDER BY total_comprado_usd DESC
        `).all(companyId, fechaIni, fechaFin);

        // 3. Top Productos (con Unidad de Medida Inteligente y Ranking Completo)
        const topProductos = [];
        try {
            const prodsDb = serverDb.prepare(`SELECT id, datos_json FROM productos_locales WHERE company_id = ?`).all(companyId);
            const mapaUnidadesCatalogo = {};
            prodsDb.forEach(p => {
                try {
                    const d = typeof p.datos_json === 'string'
                        ? (p.datos_json.trim() ? JSON.parse(p.datos_json) : {})
                        : (p.datos_json || {});
                    mapaUnidadesCatalogo[p.id] = d.unit || d.unidad || p.unit || 'UN';
                } catch (e) {
                    console.warn('⚠️ [ESTADISTICAS] JSON inválido en producto:', p.id, e.message);
                }
            });

            // Cruzar con la tabla unidades_empaque para detectar medidas configuradas (ej: KG, Litro, etc.)
            try {
                const empaquesDb = serverDb.prepare(`SELECT product_id, tipo_medida, nombre_unidad FROM unidades_empaque WHERE company_id = ?`).all(companyId);
                empaquesDb.forEach(emp => {
                    const idProd = emp.product_id;
                    const u = emp.tipo_medida || emp.nombre_unidad;
                    if (idProd && u) {
                        mapaUnidadesCatalogo[idProd] = u;
                    }
                });
            } catch (eEmp) {
                console.warn('⚠️ [ESTADISTICAS] Error leyendo unidades_empaque:', eEmp.message);
            }

            const ventas = serverDb.prepare(`
                SELECT datos_json FROM ventas_locales 
                WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
                  AND (estado != 'ANULADA' OR estado IS NULL)
                  AND (es_nota_credito = 0 OR es_nota_credito IS NULL)
            `).all(companyId, fechaIni, fechaFin);
            const mapa = {};
            ventas.forEach(v => {
                try {
                    const parsed = typeof v.datos_json === 'string'
                        ? (v.datos_json.trim() ? JSON.parse(v.datos_json) : [])
                        : (v.datos_json || []);
                    const prodArray = Array.isArray(parsed) ? parsed : (parsed.productos || parsed.items || []);
                    prodArray.forEach(item => {
                        const nombreItem = String(item.nombre || item.id || '').toUpperCase();
                        if (item.id === 'PAGO-DEUDA' || nombreItem.includes('ABONO') || nombreItem.includes('DEUDA') || nombreItem.includes('SERVICIO')) {
                            return;
                        }
                        const qty = parseFloat(item.cantidad || item.quantity) || 0;
                        const unitProd = mapaUnidadesCatalogo[item.id] || item.unit || item.unidad || 'UN';
                        if (!mapa[item.id]) {
                            mapa[item.id] = { 
                                id: item.id,
                                producto_nombre: item.nombre || item.id, 
                                cantidad_vendida: 0,
                                unidad: unitProd
                            };
                        }
                        mapa[item.id].cantidad_vendida += qty;
                        if (mapaUnidadesCatalogo[item.id]) {
                            mapa[item.id].unidad = mapaUnidadesCatalogo[item.id];
                        } else if (unitProd && unitProd !== 'UN') {
                            mapa[item.id].unidad = unitProd;
                        }
                    });
                } catch (e) {
                    console.warn('⚠️ [ESTADISTICAS] Error parseando datos_json de venta:', v.id || '', e.message);
                }
            });
            const array = Object.values(mapa).sort((a,b) => b.cantidad_vendida - a.cantidad_vendida);
            topProductos.push(...array);
        } catch (e) {
            console.warn('⚠️ [ESTADISTICAS] Error calculando topProductos:', e.message);
        }

        // 3.1 Top Sucursales (con Resolución de Nombre y Ranking Completo)
        const topSucursales = serverDb.prepare(`
            SELECT COALESCE(NULLIF(v.branch_id, ''), 'principal') as branch_id,
                   COALESCE(s.nombre, NULLIF(v.branch_id, ''), 'Sucursal Principal') as sucursal_nombre,
                   COUNT(*) as total_ventas_count,
                   SUM(v.monto_total / COALESCE(NULLIF(v.tasa_bcv, 0), 1)) as total_usd,
                   SUM(v.ganancia_venta) as total_ganancia
            FROM ventas_locales v
            LEFT JOIN sucursales s ON s.id = v.branch_id
            WHERE v.company_id = ? AND v.fecha_emision BETWEEN ? AND ?
              AND (v.estado != 'ANULADA' OR v.estado IS NULL)
              AND (v.es_nota_credito = 0 OR v.es_nota_credito IS NULL)
            GROUP BY v.branch_id
            ORDER BY total_usd DESC
        `).all(companyId, fechaIni, fechaFin);

        // 4. Serie de tiempo (horaria si es 1 día, diaria si son múltiples días)
        let serieTiempo;
        if (periodo === 'dia' || fecha_inicio === fecha_fin) {
            serieTiempo = serverDb.prepare(`
                SELECT strftime('%Y-%m-%d %H:00:00', fecha_emision) as fecha, 
                       SUM(ganancia_venta) as total_ganancia,
                       SUM(monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1)) as total_venta
                FROM ventas_locales
                WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
                  AND (estado != 'ANULADA' OR estado IS NULL)
                  AND (es_nota_credito = 0 OR es_nota_credito IS NULL)
                GROUP BY strftime('%Y-%m-%d %H', fecha_emision)
                ORDER BY fecha ASC
            `).all(companyId, fechaIni, fechaFin);
        } else {
            serieTiempo = serverDb.prepare(`
                SELECT date(fecha_emision) as fecha, 
                       SUM(ganancia_venta) as total_ganancia,
                       SUM(monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1)) as total_venta
                FROM ventas_locales
                WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
                  AND (estado != 'ANULADA' OR estado IS NULL)
                  AND (es_nota_credito = 0 OR es_nota_credito IS NULL)
                GROUP BY date(fecha_emision)
                ORDER BY fecha ASC
            `).all(companyId, fechaIni, fechaFin);
        }

        // 5. Histórico de Stock Promedio (KARDEX)
        let stocks_promedio = [];
        try {
            const rowsActual = serverDb.prepare('SELECT producto_id, SUM(cantidad_real) as cant FROM stock_maestro WHERE company_id = ? GROUP BY producto_id').all(companyId);
            
            const movimientos = serverDb.prepare(`
                SELECT producto_id, SUM(cantidad) as mov_total
                FROM movimientos_stock_maestro
                WHERE company_id = ? AND fecha_movimiento >= ?
                GROUP BY producto_id
            `).all(companyId, fechaIni);

            const mapaMov = {};
            movimientos.forEach(m => { mapaMov[m.producto_id] = m.mov_total; });

            rowsActual.forEach(r => {
                const stockActual = r.cant;
                const movsRevertir = mapaMov[r.producto_id] || 0;
                const stockInicio = stockActual - movsRevertir;
                const promedio = (stockInicio + stockActual) / 2;
                stocks_promedio.push({
                    producto_id: r.producto_id,
                    stock_promedio: Math.max(0, promedio)
                });
            });
        } catch(e) { console.error("Error calculando stocks_promedio", e.message); }

        res.json({
            exito: true,
            data: {
                total_ganancia,
                total_venta,
                total_venta_bs,
                total_cogs,
                top_clientes: topClientes,
                top_productos: topProductos,
                top_sucursales: topSucursales,
                serie_tiempo: serieTiempo,
                stocks_promedio: stocks_promedio
            }
        });
    } catch (e) {
        console.error("❌ Error en /api/maestro/estadisticas:", e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

server.get('/api/maestro/estadisticas/pagos-mes', (req, res) => {
    const { companyId, fecha_inicio, fecha_fin } = req.query;
    if (!companyId) return res.status(400).json({ error: "companyId requerido" });

    try {
        let whereClause = "WHERE company_id = ?";
        const params = [companyId];

        if (fecha_inicio && fecha_fin) {
            whereClause += " AND date(fecha) >= date(?) AND date(fecha) <= date(?)";
            params.push(fecha_inicio, fecha_fin);
        } else {
            whereClause += " AND fecha >= date('now', 'start of month') AND fecha <= date('now', '+1 day')";
        }

        const query = `
            SELECT 
                id AS id,
                detalle_pagos_json AS detalle_pagos_json, 
                total_ventas_usd AS total_ventas_usd, 
                total_ventas_bs AS total_ventas_bs, 
                total_diferencia_usd AS total_diferencia_usd, 
                total_diferencia_bs AS total_diferencia_bs,
                fecha AS fecha
            FROM cierres_caja_maestros 
            ${whereClause}
        `;

        const rows = serverDb.prepare(query).all(...params);
        console.log(`📊 [SERVER] Cierres encontrados en DB: ${rows.length}`);
        
        // Log adicional para que veas en la terminal del servidor si los $8 y $63 están saliendo
        rows.forEach(r => {
            if(r.total_ventas_usd > 0) console.log(`💵 [SERVER] Detectado cierre con Divisa: ID ${r.id} | $${r.total_ventas_usd}`);
        });

        res.json(rows || []);

    } catch (error) {
        console.error("❌ Error en pagos-mes:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// 📊 ENDPOINTS BI DE SOLO LECTURA (ESTADÍSTICAS GENERALES Y ESPECÍFICAS)
// ============================================================================
server.get('/api/maestro/estadisticas/generales-bi', (req, res) => {
    try {
        if (!serverDb) {
            return res.status(503).json({ exito: false, error: 'Base de datos maestra no inicializada.' });
        }
        const data = estadisticasBi.obtenerEstadisticasGeneralesBiDb(serverDb, {
            companyId: req.query.companyId || req.query.company_id || '',
            fechaInicio: req.query.fecha_inicio || req.query.fechaInicio || '',
            fechaFin: req.query.fecha_fin || req.query.fechaFin || '',
            friccionBsPct: req.query.friccion_bs_pct,
            diasInmovilizacionBs: req.query.dias_inmovilizacion_bs,
            tasaDevalDiariaPct: req.query.tasa_deval_diaria_pct
        });
        res.json({ exito: true, data });
    } catch (error) {
        console.error('❌ Error en /api/maestro/estadisticas/generales-bi:', error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

server.get('/api/maestro/estadisticas/especificas-bi', (req, res) => {
    try {
        if (!serverDb) {
            return res.status(503).json({ exito: false, error: 'Base de datos maestra no inicializada.' });
        }
        const data = estadisticasBi.obtenerEstadisticasEspecificasBiDb(serverDb, {
            companyId: req.query.companyId || req.query.company_id || '',
            fechaInicio: req.query.fecha_inicio || req.query.fechaInicio || '',
            fechaFin: req.query.fecha_fin || req.query.fechaFin || '',
            periodo: req.query.periodo || 'mes'
        });
        res.json({ exito: true, data });
    } catch (error) {
        console.error('❌ Error en /api/maestro/estadisticas/especificas-bi:', error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});


// ============================================================================
// 📚 MÓDULO LIBRO DE COMPRAS, LIBRO DE VENTAS Y PUENTES CXP EN SERVIDOR MAESTRO
// ============================================================================
function limpiarRifClave(rif) {
    return String(rif || '').replace(/[^A-Z0-9]/gi, '').toUpperCase().trim();
}

function obtenerMapaTasasServidor(posDbConn) {
    const mapa = {};
    const cargar = (conn) => {
        if (!conn) return;
        try {
            const rows = conn.prepare(`SELECT date(fecha) as f, valor FROM historial_tasas ORDER BY fecha DESC LIMIT 730`).all();
            rows.forEach(r => {
                if (r.f && parseFloat(r.valor) > 0 && !mapa[r.f]) mapa[r.f] = parseFloat(r.valor);
            });
        } catch (e) {
            console.warn('⚠️ [LIBRO TASAS] Error leyendo historial_tasas:', e.message);
        }
    };
    cargar(posDbConn);
    cargar(serverDb);
    return mapa;
}

function resolverTasaFechaMapa(mapaTasas, fechaStr, tasaDefecto) {
    const f = String(fechaStr || '').slice(0, 10);
    if (f && mapaTasas[f] > 0) return mapaTasas[f];
    const fechas = Object.keys(mapaTasas).sort().reverse();
    for (const fd of fechas) {
        if (fd <= f && mapaTasas[fd] > 0) return mapaTasas[fd];
    }
    return tasaDefecto > 0 ? tasaDefecto : 1;
}

function obtenerMapaClientesServidor(posDbConn, companyId) {
    const mapa = {};
    const cargar = (conn, tabla) => {
        if (!conn) return;
        try {
            const rows = conn.prepare(`SELECT rif, nombre, es_contribuyente_especial FROM ${tabla} WHERE company_id = ? OR company_id IS NULL OR company_id = ''`).all(companyId);
            rows.forEach(c => {
                const k = limpiarRifClave(c.rif);
                if (k && !mapa[k]) mapa[k] = c;
            });
        } catch (e) {
            console.warn(`⚠️ [LIBRO CLIENTES] Error leyendo ${tabla}:`, e.message);
        }
    };
    cargar(serverDb, 'clientes_maestro');
    cargar(posDbConn, 'clientes_locales');
    return mapa;
}

function obtenerMapaZetasServidor(posDbConn, companyId) {
    const mapa = {};
    const cargar = (conn) => {
        if (!conn) return;
        try {
            const rows = conn.prepare(`SELECT date(fecha_emision) as fecha_dia, branch_id, cashier_id, numero_z FROM reportes_fiscales_cierre WHERE (company_id = ? OR company_id IS NULL) AND numero_z IS NOT NULL AND numero_z != ''`).all(companyId);
            rows.forEach(r => {
                const key = `${r.fecha_dia || ''}|${r.branch_id || ''}|${r.cashier_id || ''}`;
                if (!mapa[key]) mapa[key] = r.numero_z;
                const keyDia = `${r.fecha_dia || ''}|${r.branch_id || ''}`;
                if (!mapa[keyDia]) mapa[keyDia] = r.numero_z;
            });
        } catch (e) {
            console.warn('⚠️ [LIBRO ZETAS] Error leyendo reportes_fiscales_cierre:', e.message);
        }
        try {
            const rowsC = conn.prepare(`SELECT date(fecha) as fecha_dia, branch_id, numero_z FROM cierres_caja WHERE company_id = ? AND numero_z IS NOT NULL AND numero_z != ''`).all(companyId);
            rowsC.forEach(r => {
                const keyDia = `${r.fecha_dia || ''}|${r.branch_id || ''}`;
                if (!mapa[keyDia]) mapa[keyDia] = r.numero_z;
            });
        } catch (e) {
            // Tabla legacy opcional; solo advertir si falla por motivo distinto a tabla inexistente
            if (!/no such table/i.test(String(e.message || ''))) {
                console.warn('⚠️ [LIBRO ZETAS] Error leyendo cierres_caja legacy:', e.message);
            }
        }
    };
    cargar(posDbConn);
    cargar(serverDb);
    return mapa;
}

function construirLibroVentasData({ companyId, branchId = null, desde = null, hasta = null, tipo = 'TODOS' }) {
    const posDbConn = getPosDb();
    const hoy = new Date().toISOString().slice(0, 10);
    const fDesde = desde || `${hoy.slice(0, 8)}01`;
    const fHasta = hasta || hoy;
    const tasaActiva = obtenerTasaActivaServidor();
    const mapaTasas = obtenerMapaTasasServidor(posDbConn);
    const mapaClientes = obtenerMapaClientesServidor(posDbConn, companyId);
    const mapaZetas = obtenerMapaZetasServidor(posDbConn, companyId);

    const retencionesMap = {};
    const cargarRetenciones = (conn) => {
        if (!conn) return;
        try {
            const rets = conn.prepare(`SELECT id, datos_json FROM comprobantes_retencion`).all();
            rets.forEach(r => {
                try {
                    const dj = typeof r.datos_json === 'string'
                        ? (r.datos_json.trim() ? JSON.parse(r.datos_json) : {})
                        : (r.datos_json || {});
                    if (r.id && !retencionesMap[r.id]) retencionesMap[r.id] = dj;
                } catch (e) {
                    console.warn('⚠️ [LIBRO VENTAS] JSON inválido en comprobantes_retencion:', r.id, e.message);
                }
            });
        } catch (e) {
            console.warn('⚠️ [LIBRO VENTAS] Error leyendo comprobantes_retencion:', e.message);
        }
    };
    cargarRetenciones(serverDb);
    cargarRetenciones(posDbConn);

    const sucursalesMap = {};
    [serverDb, posDbConn].forEach(conn => {
        if (!conn) return;
        try {
            conn.prepare(`SELECT id, nombre FROM sucursales WHERE company_id = ? OR company_id IS NULL`).all(companyId).forEach(s => {
                if (s.id && !sucursalesMap[s.id]) sucursalesMap[s.id] = s.nombre;
            });
        } catch (e) {
            console.warn('⚠️ [LIBRO VENTAS] Error leyendo sucursales:', e.message);
        }
    });

    const ventasPorId = new Map();
    const consultarVentasConn = (conn) => {
        if (!conn) return;
        try {
            let sql = `SELECT * FROM ventas_locales WHERE company_id = ? AND date(fecha_emision) BETWEEN date(?) AND date(?)`;
            const params = [companyId, fDesde, fHasta];
            if (branchId && branchId !== 'TODAS' && branchId !== 'ALL') {
                sql += ` AND branch_id = ?`;
                params.push(branchId);
            }
            sql += ` ORDER BY fecha_emision ASC, numero_factura ASC`;
            const rows = conn.prepare(sql).all(...params);
            rows.forEach(r => {
                if (!ventasPorId.has(r.id)) ventasPorId.set(r.id, r);
            });
        } catch (e) {
            console.warn('⚠️ [LIBRO VENTAS] Error consultando ventas_locales:', e.message);
        }
    };
    consultarVentasConn(serverDb);
    consultarVentasConn(posDbConn);

    const ventas = [];
    for (const v of ventasPorId.values()) {
        let dj = {};
        try {
            dj = v.datos_json
                ? (typeof v.datos_json === 'string' ? (v.datos_json.trim() ? JSON.parse(v.datos_json) : {}) : v.datos_json)
                : {};
        } catch (e) {
            console.warn('⚠️ [LIBRO VENTAS] JSON inválido en venta:', v.id || v.numero_factura || '', e.message);
        }

        const esAnulada = String(v.estado || '').toUpperCase() === 'ANULADA' || Number(v.es_anulada || 0) === 1;
        const esNC = Number(v.es_nota_credito || 0) === 1;
        const esND = Number(v.es_nota_debito || 0) === 1;
        const tipoDoc = esNC ? 'NOTA_CREDITO' : (esND ? 'NOTA_DEBITO' : 'FACTURA');
        const tipoTrans = esAnulada ? '03-ANULADA' : (esNC ? '04-AJUSTE' : (esND ? '02-COMPLEMENTO' : '01-REGISTRO'));

        if (tipo && tipo !== 'TODOS') {
            if (tipo === 'ANULADA' && !esAnulada) continue;
            if (tipo !== 'ANULADA' && (esAnulada || tipoDoc !== tipo)) continue;
        }

        const numControl = String(v.numero_control || (dj.hka && (dj.hka.hka_nro_control || dj.hka.numeroControl)) || '').trim();
        const tieneHka = Boolean(dj.hka && (dj.hka.hka_nro_control || dj.hka.hka_nro_doc || dj.hka.numeroFactura || dj.hka.numeroControl || dj.hka.serialImpresora));
        const esFiscal = tieneHka || (numControl !== '' && numControl !== 'MAESTRO-001' && numControl !== 'N/A' && !numControl.startsWith('NO-FISCAL') && !numControl.startsWith('INT-'));

        const rifKey = limpiarRifClave(v.cliente_rif);
        const cliInfo = mapaClientes[rifKey];
        let tipoContrib = 'No Contribuyente';
        if (cliInfo && Number(cliInfo.es_contribuyente_especial) === 1) {
            tipoContrib = 'Contribuyente Especial';
        } else if (/^(J|G)/i.test(String(v.cliente_rif || '').trim())) {
            tipoContrib = 'Contribuyente Ordinario';
        }

        const fechaDia = String(v.fecha_emision || '').slice(0, 10);
        const tasa = parseFloat(v.tasa_bcv) > 1 ? parseFloat(v.tasa_bcv) : resolverTasaFechaMapa(mapaTasas, fechaDia, tasaActiva);
        const signo = esAnulada ? 0 : (esNC ? -1 : 1);

        const exentoBs = esAnulada ? 0 : Math.abs(parseFloat(v.monto_exento || 0));
        const baseBs = esAnulada ? 0 : Math.abs(parseFloat(v.base_imponible || 0));
        const ivaBs = esAnulada ? 0 : Math.abs(parseFloat(v.monto_iva || v.total_iva || 0));
        const igtfBs = esAnulada ? 0 : Math.abs(parseFloat(v.monto_igtf || 0));
        const exportacionBs = esAnulada ? 0 : Math.abs(parseFloat(v.ventas_exportacion || 0));
        const totalBsRaw = Math.abs(parseFloat(v.monto_total || 0)) || (exentoBs + baseBs + ivaBs + igtfBs);
        const totalBs = esAnulada ? 0 : totalBsRaw;

        let alicuota = parseFloat(v.alicuota_iva || 0);
        if (baseBs > 0 && ivaBs > 0) {
            const calc = Math.round((ivaBs / baseBs) * 100);
            if ([8, 16, 31].includes(calc)) alicuota = calc;
            else if (!alicuota) alicuota = parseFloat(((ivaBs / baseBs) * 100).toFixed(2));
        } else if (baseBs === 0) {
            alicuota = 0;
        } else if (!alicuota) {
            alicuota = 16;
        }

        const retBackup = v.comprobante_retencion_id ? retencionesMap[v.comprobante_retencion_id] : null;
        let ivaRetenidoBs = parseFloat(v.iva_retenido_cliente || 0);
        if (!ivaRetenidoBs && retBackup) {
            ivaRetenidoBs = parseFloat(retBackup.montoRetenido || retBackup.iva_retenido || 0);
        }
        const compRet = v.numero_comprobante_retencion_cliente || (retBackup ? (retBackup.numeroComprobante || retBackup.numero_comprobante || v.comprobante_retencion_id) : '') || v.comprobante_retencion_id || '';
        const fechaRet = v.fecha_retencion_cliente || (retBackup ? (retBackup.fechaComprobante || retBackup.fecha_retencion || '') : '') || '';

        const numeroZ = (dj.hka && dj.hka.numeroZ) || mapaZetas[`${fechaDia}|${v.branch_id || ''}|${v.cashier_id || ''}`] || mapaZetas[`${fechaDia}|${v.branch_id || ''}`] || '';

        ventas.push({
            id: v.id,
            company_id: v.company_id,
            branch_id: v.branch_id || 'principal',
            sucursal_nombre: sucursalesMap[v.branch_id] || v.branch_id || 'Principal',
            cashier_id: v.cashier_id || '',
            fecha_emision: v.fecha_emision,
            cliente_rif: v.cliente_rif || 'V-00000000',
            cliente_nombre: v.cliente_nombre || 'CONSUMIDOR FINAL',
            tipo_contribuyente: tipoContrib,
            es_contribuyente_especial: cliInfo ? Number(cliInfo.es_contribuyente_especial || 0) : 0,
            tipo_documento: tipoDoc,
            tipo_transaccion: tipoTrans,
            numero_factura: esNC ? '' : (v.numero_factura || ''),
            numero_nota_credito: esNC ? (v.numero_factura || '') : '',
            numero_nota_debito: esND ? (v.numero_factura || '') : '',
            numero_documento: v.numero_factura || '',
            numero_control: numControl,
            factura_afectada: v.factura_afectada || '',
            numero_z: numeroZ,
            es_fiscal: esFiscal,
            es_anulada: esAnulada,
            signo,
            tasa_bcv: parseFloat(tasa.toFixed(4)),
            monto_total_bs: parseFloat((totalBs * signo).toFixed(2)),
            monto_total_usd: parseFloat(((totalBs / (tasa || 1)) * signo).toFixed(2)),
            ventas_exportacion_bs: parseFloat((exportacionBs * signo).toFixed(2)),
            monto_exento_bs: parseFloat((exentoBs * signo).toFixed(2)),
            monto_exento_usd: parseFloat(((exentoBs / (tasa || 1)) * signo).toFixed(2)),
            base_imponible_bs: parseFloat((baseBs * signo).toFixed(2)),
            base_imponible_usd: parseFloat(((baseBs / (tasa || 1)) * signo).toFixed(2)),
            alicuota_iva: alicuota,
            monto_iva_bs: parseFloat((ivaBs * signo).toFixed(2)),
            monto_iva_usd: parseFloat(((ivaBs / (tasa || 1)) * signo).toFixed(2)),
            monto_igtf_bs: parseFloat((igtfBs * signo).toFixed(2)),
            monto_igtf_usd: parseFloat(((igtfBs / (tasa || 1)) * signo).toFixed(2)),
            iva_retenido_cliente_bs: parseFloat((Math.abs(ivaRetenidoBs) * (esAnulada ? 0 : (esNC ? -1 : 1))).toFixed(2)),
            numero_comprobante_retencion_cliente: compRet,
            fecha_retencion_cliente: fechaRet,
            estado: v.estado || 'EMITIDA'
        });
    }

    ventas.sort((a, b) => String(a.fecha_emision || '').localeCompare(String(b.fecha_emision || '')) || String(a.numero_documento || '').localeCompare(String(b.numero_documento || '')));

    return {
        exito: true,
        ventas,
        tasa_activa: tasaActiva,
        desde: fDesde,
        hasta: fHasta
    };
}

function construirLibroComprasData({ companyId, desde = null, hasta = null, tipo = 'TODOS' }) {
    const posDbConn = getPosDb();
    const hoy = new Date().toISOString().slice(0, 10);
    const fDesde = desde || `${hoy.slice(0, 8)}01`;
    const fHasta = hasta || hoy;
    const tasaActiva = obtenerTasaActivaServidor();
    const mapaTasas = obtenerMapaTasasServidor(posDbConn);

    const proveedoresMap = {};
    [serverDb, posDbConn].forEach(conn => {
        if (!conn) return;
        try {
            conn.prepare(`SELECT rif, nombre, direccion FROM proveedores WHERE company_id = ? OR company_id IS NULL`).all(companyId).forEach(p => {
                const k = limpiarRifClave(p.rif);
                if (k && !proveedoresMap[k]) proveedoresMap[k] = p;
            });
        } catch (e) {
            console.warn('⚠️ [LIBRO COMPRAS] Error leyendo proveedores:', e.message);
        }
    });

    const docsPorId = new Map();
    const consultarDocsConn = (conn) => {
        if (!conn) return;
        try {
            const rows = conn.prepare(`
                SELECT m.*, p.nombre as prov_nombre_join
                FROM movimientos_cuentas_pagar m
                LEFT JOIN proveedores p ON REPLACE(UPPER(TRIM(m.proveedor_rif)), '-', '') = REPLACE(UPPER(TRIM(p.rif)), '-', '') AND p.company_id = m.company_id
                WHERE m.company_id = ?
                  AND UPPER(COALESCE(m.motivo, '')) != 'PAGO'
                  AND date(m.fecha) BETWEEN date(?) AND date(?)
                ORDER BY m.fecha ASC, m.id ASC
            `).all(companyId, fDesde, fHasta);
            rows.forEach(r => {
                if (!docsPorId.has(String(r.id))) docsPorId.set(String(r.id), r);
            });
        } catch (e) {
            console.warn('⚠️ [LIBRO COMPRAS] Error consultando movimientos_cuentas_pagar:', e.message);
        }
    };
    consultarDocsConn(serverDb);
    consultarDocsConn(posDbConn);

    const compras = [];
    for (const m of docsPorId.values()) {
        const motivoUp = String(m.motivo || 'FACTURA').toUpperCase();
        const tipoDoc = String(m.tipo_documento || (motivoUp === 'DEVOLUCION_PROVEEDOR' || motivoUp === 'NOTA_CREDITO' ? 'NOTA_CREDITO' : (motivoUp === 'NOTA_DEBITO' ? 'NOTA_DEBITO' : (Number(m.es_gasto_operativo) === 1 || motivoUp === 'GASTO_OPERATIVO' ? 'GASTO' : 'FACTURA')))).toUpperCase();
        const esNC = tipoDoc === 'NOTA_CREDITO' || motivoUp === 'DEVOLUCION_PROVEEDOR' || motivoUp === 'NOTA_CREDITO';
        const esND = tipoDoc === 'NOTA_DEBITO' || motivoUp === 'NOTA_DEBITO';
        const esGasto = Number(m.es_gasto_operativo || 0) === 1 || tipoDoc === 'GASTO' || motivoUp === 'GASTO_OPERATIVO';

        if (tipo && tipo !== 'TODOS') {
            if (tipo === 'NOTA_CREDITO' && !esNC) continue;
            if (tipo === 'GASTO' && !esGasto) continue;
            if (tipo === 'FACTURA' && (esNC || esND || esGasto)) continue;
        }

        const fechaDia = String(m.fecha || '').slice(0, 10);
        const tasa = parseFloat(m.tasa_bcv) > 1 ? parseFloat(m.tasa_bcv) : resolverTasaFechaMapa(mapaTasas, fechaDia, tasaActiva);
        const montoUsdRaw = Math.abs(parseFloat(m.monto || 0));
        let montoBsRaw = Math.abs(parseFloat(m.monto_bs || 0));
        if (montoBsRaw <= 0 && montoUsdRaw > 0) {
            montoBsRaw = parseFloat((montoUsdRaw * tasa).toFixed(2));
        }

        const numControl = String(m.numero_control || '').trim();
        const ncNro = String(m.nota_credito_nro || '').trim();
        const ndNro = String(m.nota_debito_nro || '').trim();
        const facAfectada = String(m.factura_afectada || '').trim();
        const comprobante = String(m.comprobante || '').trim();
        const alicuota = (m.alicuota_iva !== null && m.alicuota_iva !== undefined && !isNaN(parseFloat(m.alicuota_iva))) ? parseFloat(m.alicuota_iva) : 16;

        let exentoBs = Math.abs(parseFloat(m.monto_exento || 0));
        let baseBs = Math.abs(parseFloat(m.base_imponible || 0));
        let ivaBs = Math.abs(parseFloat(m.monto_iva || 0));

        // Reconstrucción automática para compras históricas de Entradas de Inventario sin desglose previo
        if (exentoBs === 0 && baseBs === 0 && ivaBs === 0 && montoBsRaw > 0) {
            if (numControl && alicuota > 0) {
                baseBs = parseFloat((montoBsRaw / (1 + alicuota / 100)).toFixed(2));
                ivaBs = parseFloat((montoBsRaw - baseBs).toFixed(2));
            } else {
                exentoBs = montoBsRaw;
            }
        }

        const signo = esNC ? -1 : 1;
        const tipoTrans = String(m.tipo_transaccion || (esNC ? '04-AJUSTE' : (esND ? '02-COMPLEMENTO' : '01-REGISTRO')));

        // Validación legal SENIAT (Reglamento IVA Art. 75 / Providencia SNAT/2011/0071):
        // Devolución / Nota de Crédito solo deduce Crédito Fiscal si posee N° NC oficial y N° Control del proveedor + Factura afectada.
        const tieneFacturaBase = Boolean(comprobante && numControl);
        const tieneNcLegal = Boolean((ncNro || (comprobante && !comprobante.startsWith('DEV-'))) && numControl && facAfectada);
        const esFiscalValido = esNC ? tieneNcLegal : (tieneFacturaBase && (baseBs > 0 || ivaBs > 0 || exentoBs > 0));

        const rifKey = limpiarRifClave(m.proveedor_rif);
        const provInfo = proveedoresMap[rifKey];
        const proveedorNombre = m.prov_nombre_join || (provInfo ? provInfo.nombre : '') || m.razon || m.proveedor_rif || 'Proveedor General';

        compras.push({
            id: String(m.id),
            company_id: m.company_id,
            fecha: m.fecha,
            proveedor_rif: m.proveedor_rif || '',
            proveedor_nombre: proveedorNombre,
            motivo: motivoUp,
            tipo_documento: tipoDoc,
            tipo_transaccion: tipoTrans,
            comprobante: comprobante,
            numero_control: numControl,
            nota_credito_nro: ncNro,
            nota_debito_nro: ndNro,
            factura_afectada: facAfectada,
            es_gasto_operativo: esGasto ? 1 : 0,
            categoria_gasto: m.categoria_gasto || '',
            es_importacion: Number(m.es_importacion || 0),
            planilla_importacion: m.planilla_importacion || '',
            expediente_importacion: m.expediente_importacion || '',
            tasa_bcv: parseFloat(tasa.toFixed(4)),
            monto_usd: parseFloat((montoUsdRaw * signo).toFixed(2)),
            monto_bs: parseFloat((montoBsRaw * signo).toFixed(2)),
            monto_exento_bs: parseFloat((exentoBs * signo).toFixed(2)),
            base_imponible_bs: parseFloat((baseBs * signo).toFixed(2)),
            alicuota_iva: baseBs > 0 ? alicuota : 0,
            monto_iva_bs: parseFloat((ivaBs * signo).toFixed(2)),
            iva_retenido_bs: parseFloat((Math.abs(parseFloat(m.iva_retenido || 0)) * signo).toFixed(2)),
            porcentaje_retencion: parseFloat(m.porcentaje_retencion || 0),
            comprobante_retencion: m.comprobante_retencion || '',
            fecha_retencion: m.fecha_retencion || '',
            estado: m.estado || 'PENDIENTE',
            monto_abonado: parseFloat(m.monto_abonado || 0),
            nota: m.nota || '',
            signo,
            es_fiscal_valido: esFiscalValido
        });
    }

    compras.sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')) || String(a.id || '').localeCompare(String(b.id || '')));

    return {
        exito: true,
        compras,
        tasa_activa: tasaActiva,
        desde: fDesde,
        hasta: fHasta
    };
}

// --- Puentes Cuentas por Pagar & Proveedores LAN ---
server.post('/api/maestro/proveedores/guardar', (req, res) => {
    const p = req.body || {};
    try {
        if (!p.rif || !p.nombre) return res.status(400).json({ success: false, error: 'RIF y nombre requeridos' });
        serverDb.prepare(`
            INSERT INTO proveedores (
                rif, id, company_id, nombre, telefono, contacto, direccion, correo,
                tipo_contribuyente, porcentaje_retencion_iva, aplica_islr_default, codigo_islr_default,
                banco_codigo, banco_nombre, cuenta_bancaria, rif_titular_cuenta, telefono_pago_movil, dias_credito_default,
                status, estado_sync
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
            ON CONFLICT(rif) DO UPDATE SET
                nombre = excluded.nombre,
                telefono = excluded.telefono,
                contacto = excluded.contacto,
                direccion = excluded.direccion,
                correo = COALESCE(excluded.correo, proveedores.correo),
                tipo_contribuyente = COALESCE(excluded.tipo_contribuyente, proveedores.tipo_contribuyente),
                porcentaje_retencion_iva = COALESCE(excluded.porcentaje_retencion_iva, proveedores.porcentaje_retencion_iva),
                aplica_islr_default = COALESCE(excluded.aplica_islr_default, proveedores.aplica_islr_default),
                codigo_islr_default = COALESCE(excluded.codigo_islr_default, proveedores.codigo_islr_default),
                banco_codigo = COALESCE(excluded.banco_codigo, proveedores.banco_codigo),
                banco_nombre = COALESCE(excluded.banco_nombre, proveedores.banco_nombre),
                cuenta_bancaria = COALESCE(excluded.cuenta_bancaria, proveedores.cuenta_bancaria),
                rif_titular_cuenta = COALESCE(excluded.rif_titular_cuenta, proveedores.rif_titular_cuenta),
                telefono_pago_movil = COALESCE(excluded.telefono_pago_movil, proveedores.telefono_pago_movil),
                dias_credito_default = COALESCE(excluded.dias_credito_default, proveedores.dias_credito_default),
                status = 1,
                company_id = COALESCE(excluded.company_id, proveedores.company_id),
                estado_sync = 0
        `).run(
            p.rif, p.id || p.rif, p.company_id || '', p.nombre, p.telefono || '', p.contacto || '', p.direccion || '', p.correo || '',
            p.tipo_contribuyente || 'ORDINARIO',
            p.porcentaje_retencion_iva !== undefined ? parseFloat(p.porcentaje_retencion_iva) : 75,
            p.aplica_islr_default ? 1 : 0,
            p.codigo_islr_default || '053',
            p.banco_codigo || '', p.banco_nombre || '', p.cuenta_bancaria || '', p.rif_titular_cuenta || '',
            p.telefono_pago_movil || '', parseInt(p.dias_credito_default || 15, 10)
        );
        res.json({ success: true });
    } catch (e) {
        console.error('❌ [SERVER PROV] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

server.delete('/api/maestro/proveedores/:rif', (req, res) => {
    try {
        const rif = String(req.params.rif || '').trim();
        const companyId = String(
            (req.query && (req.query.companyId || req.query.company_id)) ||
            (req.body && (req.body.company_id || req.body.companyId)) ||
            ''
        ).trim();
        if (companyId) {
            serverDb.prepare('UPDATE proveedores SET status = -1, estado_sync = 0 WHERE rif = ? AND company_id = ?').run(rif, companyId);
        } else {
            console.warn('⚠️ [SERVER PROVEEDOR DELETE] Solicitud sin companyId para RIF:', rif);
            serverDb.prepare('UPDATE proveedores SET status = -1, estado_sync = 0 WHERE rif = ?').run(rif);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

server.post('/api/maestro/cuentas-pagar/movimiento', (req, res) => {
    const m = req.body || {};
    try {
        const compId = m.company_id || '';
        const montoNum = parseFloat(m.monto) || 0;
        const abonadoNum = parseFloat(m.monto_abonado) || 0;
        const motivoReal = (m.motivo || '').toUpperCase() === 'COMPRA' ? 'FACTURA' : (m.motivo || 'FACTURA').toUpperCase();
        const estadoReal = m.estado || 'PENDIENTE';
        const contenidoFacStr = m.contenido_fac ? (typeof m.contenido_fac === 'string' ? m.contenido_fac : JSON.stringify(m.contenido_fac)) : null;

        serverDb.transaction(() => {
            serverDb.prepare(`
                INSERT OR REPLACE INTO movimientos_cuentas_pagar (
                    id, company_id, proveedor_rif, motivo, razon, nota, monto, comprobante, estado, monto_abonado,
                    metodo_pago, referencia, fecha, contenido_fac, numero_control, tipo_documento, tipo_transaccion,
                    nota_credito_nro, nota_debito_nro, factura_afectada, es_gasto_operativo, categoria_gasto,
                    es_importacion, planilla_importacion, expediente_importacion, tasa_bcv, monto_bs,
                    monto_exento, base_imponible, alicuota_iva, monto_iva, iva_retenido, porcentaje_retencion,
                    comprobante_retencion, fecha_retencion, estado_sync
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            `).run(
                String(m.id || `CXP-${Date.now()}`), compId, m.proveedor_rif || '', motivoReal, m.razon || '',
                m.nota || '', montoNum, m.comprobante || m.id || '', estadoReal, abonadoNum,
                m.metodo_pago || '', m.referencia || '', m.fecha || getCaracasTime(), contenidoFacStr,
                m.numero_control || '', m.tipo_documento || 'FACTURA', m.tipo_transaccion || '01-REGISTRO',
                m.nota_credito_nro || '', m.nota_debito_nro || '', m.factura_afectada || '',
                m.es_gasto_operativo ? 1 : 0, m.categoria_gasto || '', m.es_importacion ? 1 : 0,
                m.planilla_importacion || '', m.expediente_importacion || '',
                parseFloat(m.tasa_bcv) || 1, parseFloat(m.monto_bs) || 0,
                parseFloat(m.monto_exento) || 0, parseFloat(m.base_imponible) || 0,
                m.alicuota_iva !== undefined && m.alicuota_iva !== null ? parseFloat(m.alicuota_iva) : 16,
                parseFloat(m.monto_iva) || 0, parseFloat(m.iva_retenido) || 0,
                parseFloat(m.porcentaje_retencion) || 0, m.comprobante_retencion || '', m.fecha_retencion || ''
            );

            const noSumaDeuda = motivoReal === 'DEVOLUCION_PROVEEDOR' || String(m.tipo_documento || '').toUpperCase() === 'NOTA_CREDITO';
            if (!noSumaDeuda && estadoReal !== 'PAGADO' && estadoReal !== 'PAGADA' && m.proveedor_rif) {
                const deudaAgregar = montoNum - abonadoNum;
                if (deudaAgregar > 0) {
                    serverDb.prepare(`UPDATE proveedores SET saldo_deuda = COALESCE(saldo_deuda, 0) + ?, estado_sync = 0 WHERE rif = ? AND company_id = ?`).run(deudaAgregar, m.proveedor_rif, compId);
                }
            }
        })();

        res.json({ success: true });
    } catch (e) {
        console.error('❌ [SERVER MOV CXP] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

server.post('/api/maestro/cuentas-pagar/abono', (req, res) => {
    const pago = req.body || {};
    try {
        const compId = pago.company_id || '';
        const montoPago = parseFloat(pago.monto) || 0;
        const horaPago = pago.fecha || getCaracasTime();
        serverDb.transaction(() => {
            const factura = serverDb.prepare('SELECT * FROM movimientos_cuentas_pagar WHERE id = ? AND company_id = ?').get(String(pago.factura_id), compId);
            if (!factura) throw new Error('Factura no encontrada en Servidor Maestro');
            const pagoId = `PAGO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            serverDb.prepare(`
                INSERT INTO movimientos_cuentas_pagar (id, proveedor_rif, motivo, nota, monto, company_id, comprobante, estado, metodo_pago, referencia, fecha, estado_sync)
                VALUES (?, ?, 'PAGO', ?, ?, ?, ?, 'PAGADO', ?, ?, ?, 0)
            `).run(pagoId, factura.proveedor_rif, pago.nota || ('Abono a factura ' + factura.comprobante), montoPago, compId, factura.comprobante, pago.metodo_pago || '', pago.referencia || '', horaPago);

            const nuevoAbonado = (parseFloat(factura.monto_abonado) || 0) + montoPago;
            const nuevoEstado = nuevoAbonado >= (parseFloat(factura.monto) - 0.01) ? 'PAGADO' : 'ABONADO';
            serverDb.prepare('UPDATE movimientos_cuentas_pagar SET monto_abonado = ?, estado = ?, estado_sync = 0 WHERE id = ?').run(nuevoAbonado, nuevoEstado, String(pago.factura_id));
            serverDb.prepare('UPDATE proveedores SET saldo_deuda = MAX(0, COALESCE(saldo_deuda, 0) - ?), estado_sync = 0 WHERE rif = ? AND company_id = ?').run(montoPago, factura.proveedor_rif, compId);
        })();
        res.json({ exito: true });
    } catch (e) {
        console.error('❌ [SERVER ABONO CXP] Error:', e.message);
        res.status(500).json({ exito: false, mensaje: e.message });
    }
});

// --- Endpoints Libro de Ventas y Libro de Compras ---
server.get('/api/maestro/libro-ventas', (req, res) => {
    try {
        const { companyId, branchId, desde, hasta, tipo } = req.query;
        if (!companyId) return res.status(400).json({ exito: false, error: 'companyId requerido' });
        res.json(construirLibroVentasData({ companyId, branchId, desde, hasta, tipo }));
    } catch (e) {
        console.error('❌ [SERVER LIBRO VENTAS] Error:', e.message);
        res.status(500).json({ exito: false, error: e.message, ventas: [] });
    }
});

server.post('/api/maestro/libro-ventas/retencion', (req, res) => {
    const d = req.body || {};
    try {
        if (!d.venta_id || !d.company_id) return res.status(400).json({ exito: false, error: 'venta_id y company_id requeridos' });
        const compNro = String(d.numero_comprobante || '').trim();
        const fechaRet = String(d.fecha_retencion || '').trim();
        const ivaRet = parseFloat(d.iva_retenido) || 0;
        const posDbConn = getPosDb();

        const actualizarConn = (conn) => {
            if (!conn) return;
            conn.prepare(`
                UPDATE ventas_locales
                SET iva_retenido_cliente = ?,
                    numero_comprobante_retencion_cliente = ?,
                    fecha_retencion_cliente = ?,
                    comprobante_retencion_id = COALESCE(NULLIF(?, ''), comprobante_retencion_id),
                    alicuota_iva = COALESCE(?, alicuota_iva),
                    estado_sync = 0,
                    sync_server = 0
                WHERE id = ? AND company_id = ?
            `).run(ivaRet, compNro, fechaRet, compNro, (d.alicuota_iva !== undefined && d.alicuota_iva !== null) ? parseFloat(d.alicuota_iva) : null, d.venta_id, d.company_id);

            if (compNro) {
                const payloadRet = JSON.stringify({
                    numeroComprobante: compNro,
                    fechaComprobante: fechaRet,
                    montoRetenido: ivaRet,
                    ventaId: d.venta_id,
                    companyId: d.company_id
                });
                conn.prepare(`
                    INSERT INTO comprobantes_retencion (id, datos_json, estatus)
                    VALUES (?, ?, 'EMITIDO')
                    ON CONFLICT(id) DO UPDATE SET datos_json = excluded.datos_json
                `).run(compNro, payloadRet);
            }
        };
        serverDb.transaction(() => actualizarConn(serverDb))();
        if (posDbConn) {
            try {
                posDbConn.transaction(() => actualizarConn(posDbConn))();
            } catch (ePos) {
                console.warn('⚠️ [SERVER RETENCION VENTA] Error replicando retención en posDb:', ePos.message);
            }
        }
        res.json({ exito: true });
    } catch (e) {
        console.error('❌ [SERVER RETENCION VENTA] Error:', e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

server.get('/api/maestro/libro-compras', (req, res) => {
    try {
        const { companyId, desde, hasta, tipo } = req.query;
        if (!companyId) return res.status(400).json({ exito: false, error: 'companyId requerido' });
        res.json(construirLibroComprasData({ companyId, desde, hasta, tipo }));
    } catch (e) {
        console.error('❌ [SERVER LIBRO COMPRAS] Error:', e.message);
        res.status(500).json({ exito: false, error: e.message, compras: [] });
    }
});

server.post('/api/maestro/libro-compras/guardar-fiscal', (req, res) => {
    const d = req.body || {};
    try {
        const compId = d.company_id;
        if (!compId) return res.status(400).json({ exito: false, error: 'company_id requerido' });
        const posDbConn = getPosDb();
        const idDoc = String(d.id || `COMP-${Date.now()}-${Math.floor(Math.random() * 1000)}`);

        const tasa = parseFloat(d.tasa_bcv) > 0 ? parseFloat(d.tasa_bcv) : obtenerTasaActivaServidor();
        const exentoBs = Math.max(0, parseFloat(d.monto_exento) || 0);
        const baseBs = Math.max(0, parseFloat(d.base_imponible) || 0);
        const alicuota = (d.alicuota_iva !== undefined && d.alicuota_iva !== null) ? parseFloat(d.alicuota_iva) : 16;
        const ivaBs = Math.max(0, parseFloat(d.monto_iva) || 0);
        const montoBsFinal = parseFloat(d.monto_bs) > 0 ? parseFloat(d.monto_bs) : parseFloat((exentoBs + baseBs + ivaBs).toFixed(2));
        const montoUsdFinal = parseFloat(d.monto) > 0 ? parseFloat(d.monto) : parseFloat((montoBsFinal / (tasa || 1)).toFixed(2));
        const ivaRetBs = Math.max(0, parseFloat(d.iva_retenido) || 0);
        const pctRet = parseFloat(d.porcentaje_retencion) || (ivaBs > 0 && ivaRetBs > 0 ? Math.round((ivaRetBs / ivaBs) * 100) : 0);

        const tipoDoc = String(d.tipo_documento || (d.es_gasto_operativo ? 'GASTO' : 'FACTURA')).toUpperCase();
        const motivoFinal = String(d.motivo || (tipoDoc === 'NOTA_CREDITO' ? 'NOTA_CREDITO' : (tipoDoc === 'GASTO' ? 'GASTO_OPERATIVO' : 'FACTURA'))).toUpperCase();
        const tipoTrans = String(d.tipo_transaccion || (tipoDoc === 'NOTA_CREDITO' ? '04-AJUSTE' : (tipoDoc === 'NOTA_DEBITO' ? '02-COMPLEMENTO' : '01-REGISTRO')));

        const aplicarEscritura = (conn) => {
            if (!conn) return;
            const existeEnConn = conn.prepare(`SELECT 1 FROM movimientos_cuentas_pagar WHERE id = ? AND company_id = ?`).get(idDoc, compId);
            if (d.proveedor_rif && d.proveedor_nombre) {
                conn.prepare(`
                    INSERT INTO proveedores (rif, id, company_id, nombre, status, estado_sync)
                    VALUES (?, ?, ?, ?, 1, 0)
                    ON CONFLICT(rif) DO UPDATE SET nombre = COALESCE(NULLIF(excluded.nombre, ''), proveedores.nombre)
                `).run(d.proveedor_rif, d.proveedor_rif, compId, d.proveedor_nombre);
            }

            if (existeEnConn) {
                conn.prepare(`
                    UPDATE movimientos_cuentas_pagar
                    SET proveedor_rif = COALESCE(NULLIF(?, ''), proveedor_rif),
                        comprobante = COALESCE(NULLIF(?, ''), comprobante),
                        numero_control = ?,
                        tipo_documento = ?,
                        tipo_transaccion = ?,
                        nota_credito_nro = ?,
                        nota_debito_nro = ?,
                        factura_afectada = ?,
                        es_gasto_operativo = ?,
                        categoria_gasto = ?,
                        es_importacion = ?,
                        planilla_importacion = ?,
                        expediente_importacion = ?,
                        tasa_bcv = ?,
                        monto_bs = ?,
                        monto = CASE WHEN ? > 0 THEN ? ELSE monto END,
                        monto_exento = ?,
                        base_imponible = ?,
                        alicuota_iva = ?,
                        monto_iva = ?,
                        iva_retenido = ?,
                        porcentaje_retencion = ?,
                        comprobante_retencion = ?,
                        fecha_retencion = ?,
                        nota = COALESCE(NULLIF(?, ''), nota),
                        fecha = COALESCE(NULLIF(?, ''), fecha),
                        estado_sync = 0
                    WHERE id = ? AND company_id = ?
                `).run(
                    d.proveedor_rif || '', d.comprobante || '', d.numero_control || '', tipoDoc, tipoTrans,
                    d.nota_credito_nro || '', d.nota_debito_nro || '', d.factura_afectada || '',
                    d.es_gasto_operativo ? 1 : 0, d.categoria_gasto || '', d.es_importacion ? 1 : 0,
                    d.planilla_importacion || '', d.expediente_importacion || '',
                    tasa, montoBsFinal, montoUsdFinal, montoUsdFinal, exentoBs, baseBs, alicuota, ivaBs,
                    ivaRetBs, pctRet, d.comprobante_retencion || '', d.fecha_retencion || '',
                    d.nota || '', d.fecha || '', idDoc, compId
                );
            } else {
                const estadoDoc = d.estado || (d.condicion === 'CREDITO' ? 'PENDIENTE' : 'PAGADO');
                const abonadoDoc = estadoDoc === 'PENDIENTE' ? 0 : montoUsdFinal;
                conn.prepare(`
                    INSERT INTO movimientos_cuentas_pagar (
                        id, company_id, proveedor_rif, motivo, razon, nota, monto, comprobante, estado, monto_abonado,
                        metodo_pago, referencia, fecha, numero_control, tipo_documento, tipo_transaccion,
                        nota_credito_nro, nota_debito_nro, factura_afectada, es_gasto_operativo, categoria_gasto,
                        es_importacion, planilla_importacion, expediente_importacion, tasa_bcv, monto_bs,
                        monto_exento, base_imponible, alicuota_iva, monto_iva, iva_retenido, porcentaje_retencion,
                        comprobante_retencion, fecha_retencion, estado_sync
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                `).run(
                    idDoc, compId, d.proveedor_rif || '', motivoFinal, d.proveedor_nombre || '', d.nota || '',
                    montoUsdFinal, d.comprobante || d.nota_credito_nro || idDoc, estadoDoc, abonadoDoc,
                    d.metodo_pago || 'CONTADO', d.referencia || '', d.fecha || getCaracasTime(),
                    d.numero_control || '', tipoDoc, tipoTrans, d.nota_credito_nro || '', d.nota_debito_nro || '',
                    d.factura_afectada || '', d.es_gasto_operativo ? 1 : 0, d.categoria_gasto || '',
                    d.es_importacion ? 1 : 0, d.planilla_importacion || '', d.expediente_importacion || '',
                    tasa, montoBsFinal, exentoBs, baseBs, alicuota, ivaBs, ivaRetBs, pctRet,
                    d.comprobante_retencion || '', d.fecha_retencion || ''
                );

                if (estadoDoc === 'PENDIENTE' && tipoDoc !== 'NOTA_CREDITO' && d.proveedor_rif && montoUsdFinal > 0) {
                    conn.prepare(`UPDATE proveedores SET saldo_deuda = COALESCE(saldo_deuda, 0) + ?, estado_sync = 0 WHERE rif = ? AND company_id = ?`).run(montoUsdFinal, d.proveedor_rif, compId);
                }
            }
        };

        serverDb.transaction(() => aplicarEscritura(serverDb))();
        if (posDbConn) {
            try {
                posDbConn.transaction(() => aplicarEscritura(posDbConn))();
            } catch (ePos) {
                console.warn('⚠️ [SERVER LIBRO COMPRAS] Error replicando movimiento fiscal en posDb:', ePos.message);
            }
        }

        res.json({ exito: true, id: idDoc });
    } catch (e) {
        console.error('❌ [SERVER GUARDAR COMPRA FISCAL] Error:', e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

// =========================================================
// 🧑‍💼 MÓDULO EMPLEADOS & NÓMINA LOTTT (RED LOCAL LAN)
// =========================================================
server.get('/api/maestro/empleados/:companyId', (req, res) => {
    try {
        const compId = String(req.params.companyId || '').trim();
        const posConn = getPosDb();
        const filtro = construirFiltroEmpresaEmpleados([serverDb, posConn], compId);
        const rows = serverDb.prepare(`
            SELECT * FROM empleados
            WHERE (status != -1 OR status IS NULL)
              AND ${filtro.clause}
            ORDER BY nombre ASC
        `).all(...filtro.params);
        res.json({ success: true, empleados: rows });
    } catch (e) {
        console.error('❌ [SERVER GET EMPLEADOS] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

server.post('/api/maestro/empleados/guardar', (req, res) => {
    const emp = req.body || {};
    try {
        const compId = String(emp.company_id || emp.companyId || '').trim();
        if (!compId) return res.status(400).json({ success: false, error: 'company_id requerido' });
        if (!emp.nombre) return res.status(400).json({ success: false, error: 'nombre requerido' });

        const ahora = getCaracasTime();
        const empId = String(emp.ID_empleado || emp.id || `EMP-${Date.now()}`).trim();
        const payload = { ...emp, ID_empleado: empId, company_id: compId };

        serverDb.transaction(() => {
            upsertEmpleadoDb(serverDb, payload, ahora, 0);
        })();

        const posConn = getPosDb();
        if (posConn) {
            try { upsertEmpleadoDb(posConn, payload, ahora, 0); } catch (ePos) {
                console.warn('⚠️ [SERVER GUARDAR EMPLEADO] Error replicando en posDb:', ePos.message);
            }
        }

        res.json({ success: true, ID_empleado: empId });
    } catch (e) {
        console.error('❌ [SERVER GUARDAR EMPLEADO] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

server.delete('/api/maestro/empleados/:id', (req, res) => {
    try {
        const idEmp = String(req.params.id || '').trim();
        const compId = String(req.query.company_id || (req.body && req.body.company_id) || '').trim();
        const ahora = getCaracasTime();
        const posConn = getPosDb();

        const aplicarBaja = (conn) => {
            const f = construirFiltroEmpresaEmpleados([conn], compId);
            conn.prepare(`
                UPDATE empleados
                SET status = -1, activo = 0, estatus_laboral = 'EGRESADO', fecha_modificacion = ?, estado_sync = 0
                WHERE ID_empleado = ? AND ${f.clause}
            `).run(ahora, idEmp, ...f.params);
        };

        aplicarBaja(serverDb);
        if (posConn) {
            try { aplicarBaja(posConn); } catch (ePos) {
                console.warn('⚠️ [SERVER DELETE EMPLEADO] Error replicando en posDb:', ePos.message);
            }
        }
        res.json({ success: true });
    } catch (e) {
        console.error('❌ [SERVER DELETE EMPLEADO] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

server.post('/api/maestro/empleados/movimiento', (req, res) => {
    const mov = req.body || {};
    try {
        const compId = String(mov.company_id || mov.companyId || '').trim();
        const empId = String(mov.empleado_id || mov.empId || '').trim();
        if (!compId || !empId) return res.status(400).json({ success: false, error: 'company_id y empleado_id requeridos' });

        const ahora = getCaracasTime();
        const tasa = Math.max(0.01, parseFloat(mov.tasa_bcv || 1));
        const posConn = getPosDb();

        let saldoNuevo = 0;
        serverDb.transaction(() => {
            upsertMovimientoEmpleadoDb(serverDb, { ...mov, company_id: compId, empleado_id: empId }, ahora, 0);
            saldoNuevo = recalcularSaldoEmpleadoDb(serverDb, empId, compId, tasa, ahora, [serverDb, posConn]).saldoPendiente;
        })();

        if (posConn) {
            try {
                upsertMovimientoEmpleadoDb(posConn, { ...mov, company_id: compId, empleado_id: empId }, ahora, 0);
                recalcularSaldoEmpleadoDb(posConn, empId, compId, tasa, ahora, [posConn, serverDb]);
            } catch (ePos) {
                console.warn('⚠️ [SERVER MOV EMPLEADO] Error replicando en posDb:', ePos.message);
            }
        }

        res.json({ success: true, saldo_pendiente: saldoNuevo });
    } catch (e) {
        console.error('❌ [SERVER MOV EMPLEADO] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

server.get('/api/maestro/empleados/movimientos/:companyId', (req, res) => {
    try {
        const compId = String(req.params.companyId || '').trim();
        const empId = String(req.query.empleado_id || '').trim();
        const posConn = getPosDb();
        const f = construirFiltroEmpresaEmpleados([serverDb, posConn], compId);
        let sql = `SELECT * FROM empleados_movimientos WHERE ${f.clause}`;
        const params = [...f.params];
        if (empId) {
            sql += ` AND empleado_id = ?`;
            params.push(empId);
        }
        sql += ` ORDER BY fecha DESC LIMIT 300`;
        const rows = serverDb.prepare(sql).all(...params);
        res.json({ success: true, movimientos: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

server.post('/api/maestro/empleados/prestamo', (req, res) => {
    const p = req.body || {};
    try {
        const compId = String(p.company_id || '').trim();
        if (!compId || !p.empleado_id) return res.status(400).json({ success: false, error: 'company_id y empleado_id requeridos' });
        const ahora = getCaracasTime();
        const id = upsertPrestamoDb(serverDb, p, ahora, 0);
        const posConn = getPosDb();
        if (posConn) {
            try { upsertPrestamoDb(posConn, { ...p, id }, ahora, 0); } catch (ePos) {
                console.warn('⚠️ [SERVER PRESTAMO EMPLEADO] Error replicando en posDb:', ePos.message);
            }
        }
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

server.post('/api/maestro/empleados/asistencia', (req, res) => {
    const a = req.body || {};
    try {
        const compId = String(a.company_id || '').trim();
        if (!compId || !a.empleado_id) return res.status(400).json({ success: false, error: 'company_id y empleado_id requeridos' });
        const ahora = getCaracasTime();
        const id = upsertAsistenciaDb(serverDb, a, ahora, 0);
        const posConn = getPosDb();
        if (posConn) {
            try { upsertAsistenciaDb(posConn, { ...a, id }, ahora, 0); } catch (ePos) {
                console.warn('⚠️ [SERVER ASISTENCIA EMPLEADO] Error replicando en posDb:', ePos.message);
            }
        }
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

server.post('/api/maestro/empleados/nomina/guardar', (req, res) => {
    const { periodo, detalles } = req.body || {};
    try {
        if (!periodo || !periodo.id || !periodo.company_id) {
            return res.status(400).json({ success: false, error: 'Datos de período de nómina incompletos' });
        }
        const ahora = getCaracasTime();
        const guardarEnConn = (conn) => {
            conn.transaction(() => {
                upsertNominaPeriodoDb(conn, periodo, detalles || [], ahora, 0);
            })();
        };

        guardarEnConn(serverDb);
        const posConn = getPosDb();
        if (posConn) {
            try { guardarEnConn(posConn); } catch (ePos) {
                console.warn('⚠️ [SERVER NOMINA] Error replicando en posDb:', ePos.message);
            }
        }
        res.json({ success: true, periodo_id: periodo.id });
    } catch (e) {
        console.error('❌ [SERVER NOMINA] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

server.get('/api/maestro/empleados/prestamos/:companyId', (req, res) => {
    try {
        const f = construirFiltroEmpresaEmpleados([serverDb, getPosDb()], req.params.companyId);
        const rows = serverDb.prepare(`SELECT * FROM empleados_prestamos WHERE ${f.clause} ORDER BY fecha_otorgamiento DESC`).all(...f.params);
        res.json({ success: true, prestamos: rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

server.get('/api/maestro/empleados/asistencia/:companyId', (req, res) => {
    try {
        const f = construirFiltroEmpresaEmpleados([serverDb, getPosDb()], req.params.companyId);
        const rows = serverDb.prepare(`SELECT * FROM empleados_asistencia WHERE ${f.clause} ORDER BY fecha DESC LIMIT 400`).all(...f.params);
        res.json({ success: true, asistencias: rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

server.get('/api/maestro/empleados/nominas/:companyId', (req, res) => {
    try {
        const f = construirFiltroEmpresaEmpleados([serverDb, getPosDb()], req.params.companyId);
        const rows = serverDb.prepare(`SELECT * FROM nominas_periodos WHERE ${f.clause} ORDER BY fecha_creacion DESC LIMIT 100`).all(...f.params);
        res.json({ success: true, nominas: rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

server.get('/api/maestro/empleados/nomina/:periodoId/detalle', (req, res) => {
    try {
        const compId = String(req.query.company_id || '').trim();
        const f = construirFiltroEmpresaEmpleados([serverDb, getPosDb()], compId);
        const rows = serverDb.prepare(`SELECT * FROM nominas_detalle WHERE periodo_id = ? AND ${f.clause} ORDER BY empleado_nombre ASC`).all(req.params.periodoId, ...f.params);
        res.json({ success: true, detalles: rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

server.get('/api/maestro/historial-cierres/:companyId', (req, res) => {
    try {
        const { companyId } = req.params;
        const branchId = req.query.branchId || req.query.branch_id;
        let query = 'SELECT * FROM cierres_caja_maestros WHERE company_id = ?';
        const params = [companyId];
        if (branchId && branchId !== 'undefined' && branchId !== 'null' && branchId !== 'todas') {
            query += ' AND branch_id = ?';
            params.push(branchId);
        }
        query += ' ORDER BY fecha DESC LIMIT 300';
        const rows = serverDb.prepare(query).all(...params);
        res.json(rows || []);
    } catch (e) {
        res.status(500).json({ exito: false, error: e.message });
    }
});

server.post('/api/maestro/inventario/salidas/guardar', (req, res) => {
    try {
        const s = req.body || {};
        if (!s.id || !s.product_id) {
            return res.status(400).json({ success: false, error: 'Datos de salida incompletos' });
        }
        const ahora = getCaracasTime();
        const conns = [serverDb, getPosDb()].filter(Boolean);
        for (const conn of conns) {
            try {
                conn.prepare(`
                    INSERT INTO salidas_inventario (id, company_id, branch_id, product_id, cantidad, unidad, motivo, observacion, usuario_id, estado_sync, fecha_modificacion)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        cantidad = excluded.cantidad,
                        unidad = excluded.unidad,
                        motivo = excluded.motivo,
                        observacion = excluded.observacion,
                        estado_sync = excluded.estado_sync,
                        fecha_modificacion = excluded.fecha_modificacion
                `).run(
                    s.id, s.company_id || null, s.branch_id || null, s.product_id,
                    parseFloat(s.cantidad) || 0, s.unidad || 'UNIDAD', s.motivo || '',
                    s.observacion || '', s.usuario_id || '', s.estado_sync === 1 ? 1 : 0,
                    s.fecha_modificacion || ahora
                );
            } catch (eDb) {
                console.warn('⚠️ [SALIDAS LAN] Error guardando salida:', eDb.message);
            }
        }
        res.json({ success: true, exito: true, id: s.id });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

server.get('/api/maestro/inventario/salidas', (req, res) => {
    try {
        const compId = req.query.companyId || req.query.company_id;
        const branchId = req.query.branchId || req.query.branch_id;
        const activeDb = getPosDb() || serverDb;
        const conds = [];
        const params = [];
        if (compId && compId !== 'undefined') {
            conds.push('company_id = ?');
            params.push(compId);
        }
        if (branchId && branchId !== 'undefined' && branchId !== 'todas') {
            conds.push('branch_id = ?');
            params.push(branchId);
        }
        const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
        const rows = activeDb.prepare(`SELECT * FROM salidas_inventario ${where} ORDER BY rowid DESC LIMIT 200`).all(...params);
        res.json(rows || []);
    } catch (e) {
        res.json([]);
    }
});

server.get('/api/maestro/tasa/historial', (req, res) => {
    try {
        const activeDb = getPosDb() || serverDb;
        const rows = activeDb.prepare('SELECT fecha, valor, fuente FROM historial_tasas ORDER BY fecha DESC LIMIT 730').all();
        res.json(rows || []);
    } catch (e) {
        res.json([]);
    }
});

server.get('/api/maestro/tasa/grafica', (req, res) => {
    try {
        const activeDb = getPosDb() || serverDb;
        const dias = parseInt(req.query.dias, 10) || 95;
        const rows = tasasGrafica.obtenerDatosGraficaTasas(activeDb, dias);
        res.json({ success: true, datos: rows || [] });
    } catch (e) {
        res.json({ success: false, datos: [], error: e.message });
    }
});

server.post('/api/maestro/tasa/guardar', (req, res) => {
    try {
        const { fecha, valor, fuente } = req.body || {};
        if (!fecha || !(parseFloat(valor) > 0)) {
            return res.status(400).json({ success: false, error: 'Fecha y valor válidos requeridos' });
        }
        const ahora = getCaracasTime();
        const conns = [getPosDb(), serverDb].filter(Boolean);
        for (const conn of conns) {
            try {
                conn.prepare(`
                    INSERT INTO historial_tasas (fecha, valor, fuente, estado_sync, fecha_modificacion)
                    VALUES (?, ?, ?, 0, ?)
                    ON CONFLICT(fecha) DO UPDATE SET
                        valor = excluded.valor,
                        fuente = COALESCE(excluded.fuente, historial_tasas.fuente),
                        estado_sync = 0,
                        fecha_modificacion = excluded.fecha_modificacion
                `).run(fecha, parseFloat(valor), fuente || 'MANUAL', ahora);
            } catch (eDb) {
                console.warn('⚠️ [TASA HISTORIAL LAN] Error guardando:', eDb.message);
            }
        }
        res.json({ success: true, exito: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Endpoints Avanzados CxC / CxP / Retenciones / Tesorería / Cierre Cambiario ---
server.get('/api/maestro/cxc-cxp/parametros-fiscales', (req, res) => {
    try {
        const compId = req.query.companyId || req.query.company_id || 'DEFAULT';
        res.json({ exito: true, parametros: opsCxcCxp.obtenerParametrosFiscalesAvanzadosDb(serverDb, compId) });
    } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/parametros-fiscales', (req, res) => {
    try {
        const d = req.body || {};
        const compId = d.company_id || d.companyId || 'DEFAULT';
        const resParam = opsCxcCxp.guardarParametrosFiscalesAvanzadosDb(serverDb, compId, d);
        if (getPosDb()) try { opsCxcCxp.guardarParametrosFiscalesAvanzadosDb(getPosDb(), compId, d); } catch (_) {}
        res.json({ exito: true, parametros: resParam });
    } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

server.get('/api/maestro/cxc-cxp/evaluar-credito/:rif', (req, res) => {
    try {
        const compId = req.query.companyId || req.query.company_id || 'DEFAULT';
        const tasa = parseFloat(req.query.tasaBcv || 0) || opsCxcCxp.resolverTasaActivaDb(serverDb);
        res.json({ exito: true, ...opsCxcCxp.evaluarLimiteCreditoClienteDb(serverDb, {
            companyId: compId, clienteRif: req.params.rif,
            montoNuevaFacturaUsd: parseFloat(req.query.montoNuevaUsd || 0), tasaBcv: tasa
        }) });
    } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

server.get('/api/maestro/cxc-cxp/cxc-avanzado', (req, res) => {
    try {
        const compId = req.query.companyId || req.query.company_id;
        if (!compId) return res.status(400).json({ exito: false, error: 'companyId requerido' });
        res.json(opsCxcCxp.obtenerCarteraAvanzadaCxcDb(serverDb, { companyId: compId }));
    } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/cxc-abono-avanzado', (req, res) => {
    try {
        res.json(opsCxcCxp.registrarAbonoCxcAvanzadoDb(serverDb, req.body || {}, getPosDb()));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/cxc-cashea', (req, res) => {
    try {
        res.json(opsCxcCxp.registrarCasheaVentaCxcDb(serverDb, req.body || {}));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/cxc-giro', (req, res) => {
    try {
        res.json(opsCxcCxp.registrarGiroOChequeDevueltoCxcDb(serverDb, req.body || {}));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.get('/api/maestro/cxc-cxp/cxp-avanzado', (req, res) => {
    try {
        const compId = req.query.companyId || req.query.company_id;
        if (!compId) return res.status(400).json({ exito: false, error: 'companyId requerido' });
        const incluirPagados = req.query.incluirPagados !== '0';
        res.json(opsCxcCxp.obtenerDocumentosAvanzadosCxpDb(serverDb, { companyId: compId, incluirPagados }));
    } catch (e) { res.status(500).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/cxp-documento', (req, res) => {
    try {
        res.json(opsCxcCxp.guardarDocumentoCxpCompletoDb(serverDb, req.body || {}, getPosDb()));
    } catch (e) { res.status(400).json({ exito: false, code: e.code || 'ERROR', error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/cxp-pago-avanzado', (req, res) => {
    try {
        res.json(opsCxcCxp.registrarPagoCxpAvanzadoDb(serverDb, req.body || {}, getPosDb()));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/cxp-retencion', (req, res) => {
    try {
        res.json(opsCxcCxp.emitirRetencionCxpIndependienteDb(serverDb, req.body || {}));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/cxp-resolver-nd', (req, res) => {
    try {
        const d = req.body || {};
        res.json(opsCxcCxp.resolverNdTransitoCxpDb(serverDb, {
            companyId: d.company_id || d.companyId,
            ajusteId: d.ajuste_id || d.ajusteId,
            numeroNdProveedor: d.numero_nd_proveedor,
            numeroControlNd: d.numero_control_nd,
            fechaNd: d.fecha_nd
        }));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/cxp-orden-pago', (req, res) => {
    try {
        res.json(opsCxcCxp.crearOEjecutarOrdenPagoCxpDb(serverDb, req.body || {}));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/anticipo', (req, res) => {
    try {
        res.json(opsCxcCxp.registrarAnticipoOSaldoFavorDb(serverDb, req.body || {}));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/cierre-cambiario', (req, res) => {
    try {
        const d = req.body || {};
        res.json(opsCxcCxp.ejecutarCierreCambiarioMensualDb(serverDb, {
            companyId: d.company_id || d.companyId,
            modulo: d.modulo || 'CXC',
            periodoAAAAMM: d.periodo_aaaamm,
            tasaCierreBcv: d.tasa_cierre_bcv,
            usuario: d.usuario || ''
        }));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/cierre-cambiario/revertir', (req, res) => {
    try {
        const d = req.body || {};
        res.json(opsCxcCxp.revertirCierreCambiarioDiaUnoDb(serverDb, {
            companyId: d.company_id || d.companyId,
            cierreId: d.cierre_id || d.id,
            fechaReverso: d.fecha_reverso || ''
        }));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.post('/api/maestro/cxc-cxp/tesoreria', (req, res) => {
    try {
        res.json(opsCxcCxp.gestionarCuentaTesoreriaDb(serverDb, req.body || {}));
    } catch (e) { res.status(400).json({ exito: false, error: e.message }); }
});

server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n👑 [NEXUS MASTER] Cerebro Maestro inicializado.`);
        console.log(`📂 DB Maestra: ${serverDbPath}`);
        console.log(`🚀 Puerto: ${PORT} (Disponible para la red local)`);
    });

} else {
    console.log("💻 [NEXUS NODO] Esta máquina está configurada como CLIENTE. Servidor Maestro desactivado.");
}

function emitirPulsoBorrador() {
    cajasEscuchando.forEach(caja => {
        try {
            caja.write(`data: CAMBIO_DETECTADO\n\n`);
        } catch (e) { /* Cliente SSE desconectado */ }
    });
}
