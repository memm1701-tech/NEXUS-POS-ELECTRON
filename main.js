
const decodificarErrorHKA = (sts2) => {
    let errors = [];
    if (sts2 & 0x01) errors.push("Sin papel en diario / ticket.");
    if (sts2 & 0x02) errors.push("Tasa de impuestos no programada.");
    if (sts2 & 0x04) errors.push("Memoria de trabajo llena.");
    if (sts2 & 0x08) errors.push("Memoria fiscal llena.");
    if (sts2 & 0x10) errors.push("Comando inválido / Error de formato.");
    if (sts2 & 0x20) errors.push("Parámetro inválido.");
    return errors.length > 0 ? errors.join(" | ") : "Error desconocido o sin detalles (STS2=" + sts2.toString(16) + ")";
};

const calcularLRC = (buffer, etx) => {
    let lrc = 0;
    for (let i = 0; i < buffer.length; i++) {
        lrc ^= buffer[i];
    }
    lrc ^= etx[0];
    return lrc;
};
const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork, exec } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const server = express();
const PORT = 3000;
const ENCRYPTION_KEY = crypto.scryptSync("NexusGlobalSecretoAdmin2026", "saltingNexus", 32);
const IV_LENGTH = 16;
const baseDataDir = process.env.APPDATA 
    ? path.join(process.env.APPDATA, 'nexus-pos') 
    : path.join(process.platform === 'darwin' ? path.join(process.env.HOME, 'Library/Application Support') : process.env.HOME, '.config', 'nexus-pos');

const dbDir = path.join(baseDataDir, 'data');
const configDir = path.join(baseDataDir, 'config'); 

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

const envPath = path.join(configDir, '.env');

// --- NUEVA LÃ“GICA: Auto-crear archivo si no existe ---
if (!fs.existsSync(envPath)) {
    const contenidoInicial = 
`SERVER_IP=68.168.218.147
SERVER_PORT=4010
respaldo_datos=false
NEXUS_PLAN=SIN_PLAN
clave_aud_fis=1098827382M`;

    fs.writeFileSync(envPath, contenidoInicial, 'utf8');
    console.log("ðŸ†• ARCHIVO .ENV CREADO AUTOMÃTICAMENTE EN:", envPath);
} else {
    // Si existe, verificar si le falta la clave de auditorÃ­a fiscal
    let contenido = fs.readFileSync(envPath, 'utf8');
    if (!contenido.includes('clave_aud_fis=')) {
        fs.appendFileSync(envPath, '\nclave_aud_fis=1098827382M\n', 'utf8');
        console.log("ðŸ”’ CLAVE DE AUDITORÃA FISCAL AÃ‘ADIDA AL ARCHIVO .ENV");
    }
}

// Cargar las variables de entorno (ahora estamos seguros de que el archivo siempre existe)
require('dotenv').config({ path: envPath });
console.log("âœ… CONFIGURACIÃ“N EXTERNA CARGADA DESDE:", envPath);
console.log("ðŸŒ IP DEL SERVIDOR:", process.env.SERVER_IP || 'No configurada (Modo Local Aisado)');

// Puente para el Frontend
ipcMain.handle('get-config', () => {
    return {
        serverIp: process.env.SERVER_IP || '',
        serverPort: process.env.SERVER_PORT || 4010,
        respaldo_datos: process.env.respaldo_datos === 'true' 
    };
});

ipcMain.handle('validar-clave-fiscal', (event, clave) => {
    const claveCorrecta = process.env.clave_aud_fis || '1098827382M';
    return clave === claveCorrecta;
});

const configPath = path.join(dbDir, 'config.json');
let config = { 
    isServer: false, 
    serverIP: '', 
    allowNoStock: false, 
    showConsole: false,
    geminiApiKey: "AIzaSyAPKpaQrze48wBpt2CwXxGDvATb8lgYpFo" 
};

// --- LOG FORWARDING (main.js -> DevTools) ---
var win = null;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function sendLogToDevTools(type, args) {
    if (typeof win !== 'undefined' && win && win.webContents && !win.webContents.isDestroyed()) {
        try {
            const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            win.webContents.executeJavaScript(`console.${type}(${JSON.stringify('[MAIN] ' + text)})`).catch(() => {});
        } catch (e) {}
    }
}

console.log = function(...args) {
    originalConsoleLog.apply(console, args);
    sendLogToDevTools('log', args);
};
console.error = function(...args) {
    originalConsoleError.apply(console, args);
    sendLogToDevTools('error', args);
};
console.warn = function(...args) {
    originalConsoleWarn.apply(console, args);
    sendLogToDevTools('warn', args);
};

if (fs.existsSync(configPath)) {
    try {
        const contenido = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(contenido);
    } catch (e) { 
        console.error("❌ Error al leer config.json:", e);
    }
} else {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

const dbPath = path.join(dbDir, 'nexus_pos.db');
const serverDbPath = path.join(dbDir, 'nexus-local-server.db');
const db = new Database(dbPath, { timeout: 10000 });
let masterDbDirect = null;
if (config.isServer) {
    masterDbDirect = new Database(serverDbPath, { timeout: 10000 });
    masterDbDirect.pragma('journal_mode = WAL');
    // Nota: asegurarEsquema(masterDbDirect, ESQUEMA_MAESTRO) se llama desde inicializarTablas()
    console.log(`\n=========================================================`);
    console.log(`ðŸ’» [NEXUS NODE] Base de Datos Local: ${dbPath}`);
    console.log(`ðŸ‘‘ [NEXUS MASTER] Iniciando Cerebro Maestro: ${serverDbPath}`);

    try {
        const serverScriptPath = path.join(__dirname, 'server.js');

        const cerebroProcess = fork(serverScriptPath, [], {
            execPath: process.execPath, 
            env: { 
                ...process.env, 
                ELECTRON_RUN_AS_NODE: '1' 
            },
            stdio: 'inherit'
        });

        cerebroProcess.on('spawn', () => {
            console.log("âœ… [NEXUS MASTER] Servidor Maestro ejecutÃ¡ndose correctamente.");
        });

        cerebroProcess.on('error', (err) => {
            console.error("âŒ [NEXUS MASTER] Error al arrancar:", err.message);
        });
        if (app) {
            app.on('before-quit', () => {
                console.log("ðŸ›‘ Apagando Servidor Maestro...");
                cerebroProcess.kill();
            });
        }

    } catch (error) {
        console.error("âŒ Fallo crÃ­tico al intentar automatizar server.js:", error);
    }
    console.log(`=========================================================\n`);
}



let splash;
let sistemaPrincipalAbierto = false;
let cierreAutorizado = false; // <--- NUEVA VARIABLE DE SEGURIDAD
let printerPort;
let apiToken = null;
let tokenExpiration = null;
const HKA_BASE_URL = "https://demoemision.thefactoryhka.com.ve";
let currentHkaCredentials = { usuario: "", clave: "" };
let basculaPort = null;
let taraOffset = 0.0;
let ultimoPesoBruto = 0.0;
let senderBasculaActivo = null;


async function iniciarAuthWorkerHKA(event, credentials) {
    const enviarLogAlFrontend = (mensaje, esError = false) => {
        const prefijo = esError ? "âŒ [AUTH-HKA ERROR]:" : "â„¹ï¸ [AUTH-HKA INFO]:";
        console[esError ? 'error' : 'log'](`${prefijo} ${mensaje}`);
        
        if (event && event.sender) {
            event.sender.send('hka-auth-log', { mensaje, esError });
        }
    };

    try {
        if (!credentials || !credentials.usuario || !credentials.clave) {
            return enviarLogAlFrontend("Faltan credenciales del cliente para la API.", true);
        }

        enviarLogAlFrontend(`Iniciando autenticaciÃ³n para el usuario: ${credentials.usuario}...`);

        
        const response = await axios.post(`${HKA_BASE_URL}/api/Autenticacion`, {
            usuario: credentials.usuario,
            clave: credentials.clave
        });

        if (response.data.codigo === 0 || response.data.token) {
            apiToken = response.data.token;
            tokenExpiration = new Date(response.data.expiracion);
            
            enviarLogAlFrontend(`Ã‰xito: Token obtenido. Expira: ${tokenExpiration.toLocaleString()}`);
            
            if (global.servidorLocal) {
                global.servidorLocal.setHkaToken(apiToken);
                enviarLogAlFrontend("Token sincronizado con el nÃºcleo de Nexus POS.");
            }
        } else {
            enviarLogAlFrontend(`Respuesta HKA: CÃ³digo ${response.data.codigo} - ${response.data.mensaje}`, true);
        }
    } catch (error) {
        enviarLogAlFrontend(`Fallo de conexiÃ³n con The Factory: ${error.message}`, true);
    }
}

// Escuchador actualizado para recibir argumentos
ipcMain.on('ejecutar-auth-hka', (event, credentials) => {
    iniciarAuthWorkerHKA(event, credentials);
});

try {
    db.pragma('journal_mode = WAL');
} catch (e) {
    console.warn("⚠️ Aviso: La base de datos está ocupada. Iniciando sin modo WAL forzado.");
}

const ESQUEMA_LOCAL = {
    usuarios_locales: { uid: "TEXT PRIMARY KEY", email: "TEXT UNIQUE", role: "TEXT", companyId: "TEXT", branchId: "TEXT", company_data: "TEXT", last_login: "DATETIME" },
    movimientos_caja_locales: { id: "TEXT PRIMARY KEY", tipo: "TEXT", concepto: "TEXT", monto: "REAL", monto_usd: "REAL", metodo_pago: "TEXT", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP", cashier_id: "TEXT", company_id: "TEXT", branch_id: "TEXT", estado_cierre: "INTEGER DEFAULT 0" },
    pagos_moviles_locales: { id: "TEXT PRIMARY KEY", venta_id: "TEXT", numero_factura: "TEXT", banco_receptor: "TEXT", referencia: "TEXT", telefono_origen: "TEXT", monto: "REAL", fecha_pago: "DATETIME", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", estado_cierre: "INTEGER DEFAULT 0" },
    claves_admin_locales: { id: "TEXT PRIMARY KEY", ownerName: "TEXT", encryptedCode: "TEXT", company_id: "TEXT", created_by: "TEXT", updatedAt: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    productos_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", codigo: "TEXT", nombre: "TEXT", precio: "REAL", precio_compra: "REAL DEFAULT 0", porcentaje_ganancia: "REAL DEFAULT 0", categoria: "TEXT", status: "INTEGER", imagen: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME" },
    categorias_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME" },
    correlativos: { tipo: "TEXT PRIMARY KEY", ultimo_numero: "INTEGER DEFAULT 0", prefijo: "TEXT DEFAULT ''" },
    clientes_locales: { rif: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", direccion: "TEXT", telefono: "TEXT", correo: "TEXT", datos_json: "TEXT", es_contribuyente_especial: "INTEGER DEFAULT 0", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    configuracion: { clave: "TEXT PRIMARY KEY", valor: "TEXT", fecha_actualizacion: "DATETIME" },
    historial_tasas: { fecha: "DATE PRIMARY KEY", valor: "DECIMAL(18, 8) NOT NULL", fuente: "TEXT DEFAULT 'BCV'" },
    ventas_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_factura: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", monto_exento: "REAL DEFAULT 0", base_imponible: "REAL DEFAULT 0", monto_iva: "REAL DEFAULT 0", total_iva: "REAL DEFAULT 0", monto_igtf: "REAL DEFAULT 0", monto_total: "REAL DEFAULT 0", tasa_bcv: "REAL DEFAULT 1", metodo_pago: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_emision: "DATETIME DEFAULT CURRENT_TIMESTAMP", estado_cierre: "INTEGER DEFAULT 0", es_nota_credito: "INTEGER DEFAULT 0", es_nota_debito: "INTEGER DEFAULT 0", factura_afectada: "TEXT", monto_factura_afectada: "REAL", fecha_factura_afectada: "TEXT", comprobante_retencion_id: "TEXT DEFAULT NULL", ganancia_venta: "REAL DEFAULT 0" },
    cuentas_por_cobrar: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cliente_rif: "TEXT", cliente_nombre: "TEXT", monto_deuda: "REAL", monto_pagado: "REAL DEFAULT 0", estado: "TEXT DEFAULT 'PENDIENTE'", fecha_emision: "DATETIME DEFAULT CURRENT_TIMESTAMP", venta_id: "TEXT" },
    sync_queue: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", operacion: "TEXT", tabla: "TEXT", datos: "TEXT", fecha_creacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    inventario_sucursales: { producto_id: "TEXT", sucursal_id: "TEXT", company_id: "TEXT", stock: "REAL DEFAULT 0", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP", "PRIMARY KEY": "(producto_id, sucursal_id)" },
    cierres_caja_locales: { id: "TEXT PRIMARY KEY", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", total_ventas_bs: "REAL", total_ventas_usd: "REAL", total_gastos_bs: "REAL", total_gastos_usd: "REAL", total_ingresos_bs: "REAL", total_diferencia_bs: "REAL", total_diferencia_usd: "REAL", detalle_pagos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0" },
    reportes_fiscales_cierre: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", tipo_reporte: "TEXT", numero_z: "TEXT", fecha_emision: "TEXT", hora_emision: "TEXT", ultima_factura: "TEXT", exento: "REAL", base_imponible_tasa_1: "REAL", impuesto_tasa_1: "REAL", base_imponible_tasa_2: "REAL", impuesto_tasa_2: "REAL", base_imponible_tasa_3: "REAL", impuesto_tasa_3: "REAL", igtf: "REAL", raw_data: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_registro: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    unidades_empaque: { id: "TEXT PRIMARY KEY", company_id: "TEXT", product_id: "TEXT", nombre_unidad: "TEXT", tipo_medida: "TEXT", factor_cantidad: "REAL", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    comprobantes_retencion: { id: "TEXT PRIMARY KEY", datos_json: "TEXT NOT NULL", fecha_registro: "DATETIME DEFAULT CURRENT_TIMESTAMP", estatus: "TEXT DEFAULT 'EMITIDO'" },
    sucursales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", direccion: "TEXT", telefono: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "TEXT" },
    salidas_inventario: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", product_id: "TEXT", cantidad: "REAL", unidad: "TEXT", motivo: "TEXT", observacion: "TEXT", usuario_id: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    configuracion_cajera: { clave: "TEXT PRIMARY KEY", valor: "TEXT", fecha_actualizacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    plan_empresa: { company_id: "TEXT PRIMARY KEY", datos_encriptados: "TEXT", updated_at: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    auditoria_fiscal: { id: "TEXT PRIMARY KEY", usuario: "TEXT", accion: "TEXT", valores: "TEXT", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    auditoria_administrador: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", admin_name: "TEXT", accion: "TEXT", detalles: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    configuracion_fiscal: { id: "INTEGER PRIMARY KEY CHECK (id = 1)", iva_exento: "REAL DEFAULT 0", iva_general: "REAL DEFAULT 16", iva_reducido: "REAL DEFAULT 8", iva_anadida: "REAL DEFAULT 31", igtf_porcentaje: "REAL DEFAULT 3", fecha_actualizacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
    guias_despacho: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_guia: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", factura_asociada: "TEXT", datos_json: "TEXT", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP" }
};

function asegurarEsquema(dbConnection, esquema) {
    for (const [tabla, columnas] of Object.entries(esquema)) {
        // 1. Crear tabla si no existe
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

        // 2. Verificar columnas faltantes
        const tableInfo = dbConnection.prepare(`PRAGMA table_info(${tabla})`).all();
        const columnasExistentes = tableInfo.map(col => col.name);

        for (const [colName, colType] of Object.entries(columnas)) {
            if (colName === "PRIMARY KEY" || colName === "FOREIGN KEY") continue;

            if (!columnasExistentes.includes(colName)) {
                const cleanType = colType.replace(/PRIMARY KEY/g, "").replace(/UNIQUE/g, "").trim();
                const alterQuery = `ALTER TABLE ${tabla} ADD COLUMN ${colName} ${cleanType}`;
                try {
                    dbConnection.prepare(alterQuery).run();
                    console.log(`[DB AUTO-SYNC] Columna añadida: '${colName}' en la tabla '${tabla}'`);
                } catch (error) {
                    console.error(`[DB AUTO-SYNC] Error añadiendo columna '${colName}' a '${tabla}':`, error.message);
                }
            }
        }
    }
}

function inicializarTablas() {

    try {
        db.exec(`
            -- 📦 Índices para Inventario (Búsquedas en milisegundos)
            CREATE INDEX IF NOT EXISTS idx_productos_codigo ON productos_locales(codigo);
            CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos_locales(categoria);
            CREATE INDEX IF NOT EXISTS idx_productos_empresa ON productos_locales(company_id);

            -- 🧾 Índices para Ventas (Vital para que el Cierre Z sea instantáneo)
            -- Este índice compuesto agrupa exactamente lo que busca tu función de cierre
            CREATE INDEX IF NOT EXISTS idx_ventas_cierre_compuesto 
            ON ventas_locales(company_id, branch_id, cashier_id, estado_cierre);
            
            -- Índice para buscar facturas por fecha rápidamente (Reportes)
            CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas_locales(fecha_emision);

            -- 💸 Índices para Movimientos de Caja (Ingresos/Gastos)
            CREATE INDEX IF NOT EXISTS idx_movimientos_cierre 
            ON movimientos_caja_locales(company_id, tipo, estado_cierre);

            -- 🤝 Índices para Cuentas por Cobrar (Créditos)
            CREATE INDEX IF NOT EXISTS idx_cxc_cliente ON cuentas_por_cobrar(cliente_rif, estado);
        `);
        console.log("⚡ Índices de base de datos SQLite verificados y optimizados.");
    } catch (error) {
        console.error("⚠️ Error creando los índices:", error.message);
    }
    
    // Auto-sincronizar el esquema de tablas completo (DB local)
    asegurarEsquema(db, ESQUEMA_LOCAL);

    // Si este nodo es el servidor, sincronizar también el acceso directo a la DB maestra
    if (masterDbDirect) {
        const ESQUEMA_MAESTRO_LOCAL = {
            stock_maestro: { producto_id: "TEXT", sucursal_id: "TEXT", company_id: "TEXT", cantidad_real: "REAL DEFAULT 0", ultima_sincronizacion: "DATETIME", "PRIMARY KEY": "(producto_id, sucursal_id)" },
            movimientos_stock_maestro: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", company_id: "TEXT NOT NULL", sucursal_id: "TEXT", producto_id: "TEXT NOT NULL", cantidad: "REAL NOT NULL", tipo_movimiento: "TEXT NOT NULL", fecha_movimiento: "DATETIME DEFAULT CURRENT_TIMESTAMP", referencia_id: "TEXT", estado_sync: "INTEGER DEFAULT 0" },
            correlativos_maestros: { tipo: "TEXT PRIMARY KEY", prefijo: "TEXT", ultimo_numero: "INTEGER DEFAULT 0", correlativo_nc_actual: "INTEGER DEFAULT 0" },
            clientes_maestro: { rif: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT NOT NULL", direccion: "TEXT", telefono: "TEXT", correo: "TEXT", datos_json: "TEXT", es_contribuyente_especial: "INTEGER DEFAULT 0", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP", saldo_deuda: "REAL DEFAULT 0" },
            cuentas_por_cobrar: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", cliente_id: "TEXT NOT NULL", cliente_nombre: "TEXT", monto_bs: "REAL DEFAULT 0", monto_usd: "REAL DEFAULT 0", factura_nro: "TEXT", monto_pagado: "REAL DEFAULT 0", fecha: "TEXT", estado: "TEXT DEFAULT 'PENDIENTE'" },
            facturas_borradores: { id: "TEXT PRIMARY KEY", cliente_nombre: "TEXT", cliente_id: "TEXT", items: "TEXT", subtotal: "REAL", iva: "REAL", total: "REAL", metodos_pago: "TEXT", fecha: "INTEGER", usuario_id: "TEXT", sucursal_id: "TEXT", company_id: "TEXT" },
            cierres_caja_maestros: { id: "TEXT PRIMARY KEY", fecha: "DATETIME", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", total_ventas_bs: "REAL", total_ventas_usd: "REAL", total_gastos_bs: "REAL", total_gastos_usd: "REAL", total_ingresos_bs: "REAL", total_diferencia_bs: "REAL", total_diferencia_usd: "REAL", detalle_pagos_json: "TEXT" },
            ventas_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_factura: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", monto_exento: "REAL DEFAULT 0", base_imponible: "REAL DEFAULT 0", monto_iva: "REAL DEFAULT 0", total_iva: "REAL DEFAULT 0", monto_igtf: "REAL DEFAULT 0", monto_total: "REAL DEFAULT 0", tasa_bcv: "REAL DEFAULT 1", metodo_pago: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_emision: "DATETIME DEFAULT CURRENT_TIMESTAMP", estado_cierre: "INTEGER DEFAULT 0", es_nota_credito: "INTEGER DEFAULT 0", es_nota_debito: "INTEGER DEFAULT 0", factura_afectada: "TEXT", monto_factura_afectada: "REAL", fecha_factura_afectada: "TEXT", comprobante_retencion_id: "TEXT DEFAULT NULL" },
            configuraciones_maestras: { clave: "TEXT PRIMARY KEY", valor: "TEXT" },
            auditoria_fiscal: { id: "TEXT PRIMARY KEY", usuario: "TEXT NOT NULL", accion: "TEXT NOT NULL", valores: "TEXT NOT NULL", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
            metodos_pago_maestro: { id: "TEXT PRIMARY KEY", nombre: "TEXT NOT NULL", tecla: "TEXT", tipo_moneda: "TEXT DEFAULT 'BS'", activo: "INTEGER DEFAULT 1", flag_impresora: "TEXT DEFAULT '00'" },
            claves_admin_maestras: { id: "TEXT PRIMARY KEY", ownerName: "TEXT", encryptedCode: "TEXT", company_id: "TEXT", created_by: "TEXT", updatedAt: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
            guia_despacho: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_guia: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", factura_asociada: "TEXT", fecha_emision: "DATETIME DEFAULT CURRENT_TIMESTAMP", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0" },
            guias_despacho: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_guia: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", factura_asociada: "TEXT", datos_json: "TEXT", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP" }
        };
        asegurarEsquema(masterDbDirect, ESQUEMA_MAESTRO_LOCAL);
        console.log("[DB AUTO-SYNC] Esquema maestro sincronizado en masterDbDirect.");
    }

    db.exec(`
        INSERT OR IGNORE INTO configuracion_fiscal (id, iva_exento, iva_general, iva_reducido, iva_anadida, igtf_porcentaje)
        VALUES (1, 0, 16, 8, 31, 3);
    `); 

}


inicializarTablas();

ipcMain.handle('guardar-guia-despacho-maestro', async (event, datos) => {
    try {
        // Asegurarnos de que la tabla exista (por si acaso no la has creado en la inicializaciÃ³n de tu DB)
        db.exec(`
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
                fecha DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Preparar la inserciÃ³n de los datos usando better-sqlite3
        const stmt = db.prepare(`
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

        // Ejecutar la inserciÃ³n
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

        console.log(`âœ… [NEXUS MASTER] GuÃ­a de Despacho guardada localmente: ${datos.numero_guia}`);
        
        return { exito: true, id: datos.id, numero_guia: datos.numero_guia };

    } catch (error) {
        console.error("â Œ [ERROR] FallÃ³ al guardar la GuÃ­a de Despacho en SQLite:", error);
        return { exito: false, error: error.message };
    }
});

ipcMain.on('confirmar-cierre-seguro', () => {
    cierreAutorizado = true;
    app.quit(); // Ejecuta el cierre definitivo del sistema
});

ipcMain.handle('guardar-auditoria-fiscal', async (event, datos) => {
    try {
        const serverUrl = store.get('serverUrl') || 'http://localhost:3000';
        // Se usa fetch nativo de Node/Electron
        
        const response = await fetch(`${serverUrl}/api/maestro/auditoria-fiscal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(datos)
        });

        const result = await response.json();
        if (result.exito) {
            console.log(`Auditoría fiscal registrada en maestro: [${datos.accion}] por ${datos.usuario || 'Admin'}`);
            return { success: true };
        } else {
            throw new Error(result.error);
        }
    } catch (e) {
        console.error("Error guardando auditoría fiscal en maestro:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('guardar-auditoria-admin', async (event, datos) => {
    try {
        const stmt = db.prepare(`
            INSERT INTO auditoria_administrador (
                id, company_id, branch_id, cashier_id, 
                admin_name, accion, detalles, estado_sync, fecha
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
        `);
        
        const resultado = stmt.run(
            datos.id || `AUDIT-${Date.now()}`,
            datos.company_id,
            datos.branch_id,
            datos.cashier_id,
            datos.admin_name || 'Desconocido',
            datos.accion,
            datos.detalles || 'Sin detalles',
            datos.fecha || new Date().toISOString()
        );

        console.log(`ðŸ›¡ï¸  AuditorÃ­a registrada: [${datos.accion}] autorizada por ${datos.admin_name || 'Admin'}`);
        return { success: true, changes: resultado.changes };
    } catch (e) {
        console.error("â Œ Error al guardar auditorÃ­a de administrador:", e.message);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('obtener-auditoria-admin', async (event, companyId) => {
    try {
        const stmt = db.prepare(`
            SELECT * FROM auditoria_administrador 
            WHERE company_id = ? 
            ORDER BY fecha DESC 
            LIMIT 200
        `);
        return stmt.all(companyId);
    } catch (e) {
        console.error("â Œ Error leyendo logs de auditorÃ­a en SQLite:", e.message);
        return [];
    }
});

server.use(cors());
server.use(express.json({ limit: '100mb' }));

// ConfiguraciÃ³n de Axios para el BCV
const axiosConfigBCV = {
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
};

const stmtCheck = db.prepare("SELECT COUNT(*) as count FROM correlativos");
if (stmtCheck.get().count === 0) {
    db.prepare("INSERT INTO correlativos (tipo, ultimo_numero, prefijo) VALUES (?, ?, ?)").run('FISCAL_HKA', 0, 'TFHKA-');
    db.prepare("INSERT INTO correlativos (tipo, ultimo_numero, prefijo) VALUES (?, ?, ?)").run('FORMA_LIBRE', 0, 'FL-');
    db.prepare("INSERT INTO correlativos (tipo, ultimo_numero, prefijo) VALUES (?, ?, ?)").run('NOTA_ENTREGA', 0, 'NE-');
}

const GEMINI_API_KEY = "AIzaSyAPKpaQrze48wBpt2CwXxGDvATb8lgYpFo"; 
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);


// 1. Obtener ventas del turno actual (Pendientes de Z)
ipcMain.handle('obtener-ventas-pendientes-caja', async (event, { companyId, branchId, cashierId }) => {
    try {
        const stmt = db.prepare(`
            SELECT * FROM ventas_locales 
            WHERE company_id = ? AND branch_id = ? AND cashier_id = ? AND estado_cierre = 0
        `);
        return stmt.all(companyId, branchId, cashierId);
    } catch (e) {
        return [];
    }
});



function encriptarPlan(texto) {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(texto);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function desencriptarPlan(texto) {
    try {
        let textParts = texto.split(':');
        let iv = Buffer.from(textParts.shift(), 'hex');
        let encryptedText = Buffer.from(textParts.join(':'), 'hex');
        let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        return null; // Si alguien manipulÃ³ la base de datos, esto falla y retorna null
    }
}



ipcMain.handle('obtener-facturas-pendientes-retencion', async (event, { rif }) => {
    try {
        let rifBusqueda = rif.trim().toUpperCase();
        if (!rifBusqueda.startsWith('V-') && !rifBusqueda.startsWith('J-') && !rifBusqueda.startsWith('G-')) {
            rifBusqueda = 'V-' + rifBusqueda;
        }
        const stmt = db.prepare(`
            SELECT * FROM ventas_locales 
            WHERE (
                cliente_rif = ? 
                OR json_extract(datos_json, '$.cliente.rif') = ?
            )
            AND es_nota_credito = 0 
            AND (comprobante_retencion_id IS NULL OR comprobante_retencion_id = '')
            ORDER BY fecha_emision DESC
        `);
        
        const resultados = stmt.all(rifBusqueda, rifBusqueda);
        
        console.log(`ðŸ”  [DEBUG] RIF buscado: ${rifBusqueda}`);
        console.log(`ðŸ”  [DEBUG] Facturas encontradas: ${resultados.length}`);
        
        if (resultados.length > 0) {
            console.log(`âœ… Primera factura encontrada ID: ${resultados[0].id}`);
        }

        return resultados;
    } catch (e) {
        console.error("â Œ Error profundo obteniendo facturas:", e.message);
        return [];
    }
});

ipcMain.handle('registrar-retencion-iva', async (event, { datosRetencion, listaFacturasIds, retencionId }) => {
    try {
        console.log("ðŸ›  Registrando retenciÃ³n:", retencionId);
        console.log("ðŸ“‘ Facturas a actualizar:", listaFacturasIds); // <--- ESTO ES CLAVE

        if (!listaFacturasIds || listaFacturasIds.length === 0) {
            console.warn("âš ï¸  Advertencia: listaFacturasIds estÃ¡ vacÃ­o, no se actualizarÃ¡n facturas.");
        }

        const transaction = db.transaction(() => {
            // A. Insertar comprobante
            const stmtInsert = db.prepare(`
                INSERT INTO comprobantes_retencion (id, datos_json) VALUES (?, ?)
            `);
            stmtInsert.run(retencionId, JSON.stringify(datosRetencion));

            // B. Actualizar facturas
            const stmtUpdate = db.prepare(`
                UPDATE ventas_locales 
                SET comprobante_retencion_id = ? 
                WHERE id = ?
            `);
            
            for (const idVenta of listaFacturasIds) {
                const info = stmtUpdate.run(retencionId, idVenta);
                console.log(`âœ… Factura ${idVenta} actualizada. Cambios: ${info.changes}`);
            }
        });

        transaction();
        return { success: true };
    } catch (e) {
        console.error("â Œ ERROR EN TRANSACCIÃ“N DE RETENCIÃ“N:", e);
        return { success: false, error: e.message };
    }
});

// main.js - FunciÃ³n para eliminar sucursales localmente
ipcMain.handle('eliminar-sucursal-local', async (event, id) => {
    try {
        const stmt = db.prepare('DELETE FROM sucursales WHERE id = ?');
        const resultado = stmt.run(id);
        
        if (resultado.changes > 0) {
            console.log(`âœ… Sucursal eliminada localmente: ${id}`);
            return { success: true, changes: resultado.changes };
        } else {
            return { success: false, error: "No se encontrÃ³ la sucursal en la base de datos local." };
        }
    } catch (e) {
        console.error("â Œ Error al eliminar sucursal local:", e.message);
        return { success: false, error: e.message };
    }
});

// Guardar el plan encriptado
ipcMain.handle('guardar-plan-local', (event, planData) => {
    try {
        const companyId = planData.companyId;
        const jsonString = JSON.stringify(planData);
        
        // AQUÃ  LLAMA A LA FUNCIÃ“N (Ahora sÃ­ la encontrarÃ¡)
        const datosEncriptados = encriptarPlan(jsonString); 

        const stmt = db.prepare(`
            INSERT INTO plan_empresa (company_id, datos_encriptados, updated_at)
            VALUES (@company_id, @datos_encriptados, CURRENT_TIMESTAMP)
            ON CONFLICT(company_id) DO UPDATE SET
                datos_encriptados = excluded.datos_encriptados,
                updated_at = CURRENT_TIMESTAMP
        `);

        stmt.run({ company_id: companyId, datos_encriptados: datosEncriptados });
        console.log(`ðŸ”’ Plan de la empresa ${companyId} encriptado y guardado en bÃ³veda local.`);
        return { success: true };
    } catch (error) {
        console.error("â Œ Error guardando el plan encriptado:", error);
        return { success: false, error: error.message };
    }
});

// Leer y desencriptar el plan
ipcMain.handle('obtener-plan-local', (event, companyId) => {
    try {
        const stmt = db.prepare(`SELECT datos_encriptados FROM plan_empresa WHERE company_id = ?`);
        const row = stmt.get(companyId);
        
        if (row && row.datos_encriptados) {
            const jsonDesencriptado = desencriptarPlan(row.datos_encriptados); // Rompemos el sello
            if (jsonDesencriptado) {
                return JSON.parse(jsonDesencriptado);
            } else {
                console.error("âš ï¸  ALERTA DE SEGURIDAD: El archivo del plan fue manipulado.");
                return null; 
            }
        }
        return null;
    } catch (error) {
        console.error("â Œ Error obteniendo el plan encriptado:", error);
        return null;
    }
});

// handler UNIFICADO: Guarda registro histÃ³rico local, marca como cerrado y sincroniza con el Maestro
ipcMain.handle('procesar-cierre-caja-local', async (event, reporte) => {
    try {
        const transaction = db.transaction(() => {
            // A. INSERTAR EL REGISTRO HISTÃ“RICO DEL CIERRE EN TABLA LOCAL
            const stmtCierre = db.prepare(`
                INSERT INTO cierres_caja_locales (
                    id, fecha, company_id, branch_id, cashier_id,
                    total_ventas_bs, total_ventas_usd, total_gastos_bs,
                    total_gastos_usd, total_ingresos_bs, total_diferencia_bs,
                    total_diferencia_usd, detalle_pagos_json, estado_sync
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            `);

            stmtCierre.run(
                reporte.id,
                reporte.fecha,
                reporte.companyId,
                reporte.branchId,
                reporte.cashierId,
                reporte.totalSalesBs,
                reporte.totalSalesDollars,
                reporte.totalExpensesBs,
                reporte.totalExpensesDollars,
                reporte.totalIncomes,
                reporte.totalDifferenceBs,
                reporte.totalDifferenceDollars,
                reporte.paymentsConciliation 
            );

            // B. MARCAR VENTAS COMO CERRADAS
            db.prepare(`UPDATE ventas_locales SET estado_cierre = 1 
                        WHERE company_id = ? AND branch_id = ? AND cashier_id = ? AND estado_cierre = 0`)
              .run(reporte.companyId, reporte.branchId, reporte.cashierId);
            
            // C. MARCAR INGRESOS Y GASTOS COMO CERRADOS
            db.prepare(`UPDATE movimientos_caja_locales SET estado_cierre = 1 
                        WHERE company_id = ? AND cashier_id = ? AND estado_cierre = 0`)
              .run(reporte.companyId, reporte.cashierId);
            
            // D. MARCAR PAGOS MÃ“VILES COMO CERRADOS
            db.prepare(`UPDATE pagos_moviles_locales SET estado_cierre = 1 
                        WHERE company_id = ? AND branch_id = ? AND cashier_id = ? AND estado_cierre = 0`)
              .run(reporte.companyId, reporte.branchId, reporte.cashierId);
        });
        
        // Ejecutamos la transacciÃ³n local
        transaction();
        console.log(`âœ… Cierre Z almacenado localmente: ${reporte.id}`);

        // --- E. SINCRONIZACIÃ“N CON EL SERVIDOR MAESTRO (PUERTO 3000) ---
        try {
            const ipMaestro = config.isServer ? '127.0.0.1' : getIpMaestro();
            if (ipMaestro) {
                await llamarMaestro('POST', '/api/maestro/registrar-cierre', reporte, { timeout: 6000, reintentos: 2 });
                console.log("📡 Cierre sincronizado con el Servidor Maestro exitosamente.");
            } else {
                console.warn('⚠️ [RED] Cierre no sincronizado: IP del maestro no configurada.');
            }
        } catch (errSync) {
            console.warn("âš ï¸  No se pudo sincronizar con el Maestro (Modo Offline o Servidor Apagado):", errSync.message);
            // No retornamos error aquÃ­ para que el usuario pueda seguir trabajando, 
            // el registro ya quedÃ³ seguro en la base de datos local.
        }

        return { success: true };

    } catch (e) {
        console.error("â Œ Error en proceso de cierre:", e.message);
        return { error: e.message };
    }
});

// main.js - Manejador para leer el historial de la nueva tabla
ipcMain.handle('obtener-historial-cierres', async (event, { companyId }) => {
    try {
        const stmt = db.prepare(`
            SELECT * FROM cierres_caja_locales 
            WHERE company_id = ? 
            ORDER BY fecha DESC 
            LIMIT 50
        `);
        return stmt.all(companyId);
    } catch (e) {
        console.error("â Œ Error al leer historial de cierres:", e.message);
        return [];
    }
});

ipcMain.handle('guardar-pago-movil', async (event, p) => {
    try {
        const stmt = db.prepare(`
            INSERT INTO pagos_moviles_locales (
                id, venta_id, numero_factura, banco_receptor, referencia, 
                telefono_origen, monto, fecha_pago, company_id, branch_id, 
                cashier_id, estado_cierre
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `);
        return stmt.run(
            p.id, p.venta_id, p.numero_factura, p.banco_receptor, p.referencia,
            p.telefono_origen, p.monto, p.fecha_pago, p.company_id, p.branch_id,
            p.cashier_id
        );
    } catch (e) {
        console.error("â Œ Error guardando pago mÃ³vil local:", e.message);
        return { error: e.message };
    }
});


ipcMain.handle('obtener-pagos-moviles-caja', async (event, datos) => {
    try {
        const { companyId, branchId, cashierId } = datos;
        
        // Usamos db.prepare().all() que es la sintaxis correcta para better-sqlite3
        // y apuntamos a la tabla correcta: pagos_moviles_locales
        const stmt = db.prepare(`
            SELECT * FROM pagos_moviles_locales 
            WHERE company_id = ? 
            AND branch_id = ? 
            AND cashier_id = ? 
            AND estado_cierre = 0
            ORDER BY fecha_pago DESC
        `);
        
        return stmt.all(companyId, branchId, cashierId);
        
    } catch (error) {
        console.error("Error en el handler de obtener-pagos-moviles-caja:", error);
        return []; // Retornamos un array vacÃ­o en caso de fallo para no romper el frontend
    }
});

ipcMain.handle('consultar-ia-nexus', async (event, { mensaje, contexto }) => {
    try {
        console.log("ðŸš€ Nexus AI: Conectando con Google Gemini...");
        
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `Eres un consultor financiero experto de Nexus POS en Venezuela. 
        Tono: Profesional y tÃ©cnico. Contexto: ${contexto}. Pregunta: ${mensaje}`;
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();

    } catch (error) {
        console.error("â Œ Error CrÃ­tico en Gemini:", error.message);
        
        if (error.message.includes("404")) {
             return "Reintentando conexiÃ³n con nodo secundario de IA...";
        }
        
        return "El nÃºcleo de IA no estÃ¡ disponible actualmente.";
    }
});

ipcMain.handle('guardar-movimiento-caja', async (event, m) => {
    try {
        const stmt = db.prepare(`
            INSERT INTO movimientos_caja_locales (
                id, tipo, concepto, monto, monto_usd, metodo_pago, 
                fecha, cashier_id, company_id, branch_id, estado_cierre
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `);
        
        return stmt.run(
            m.id, m.tipo, m.concepto, m.monto, m.monto_usd, m.metodo_pago,
            m.fecha, m.cashier_id, m.company_id, m.branch_id
        );
    } catch (e) {
        console.error("â Œ Error guardando movimiento local:", e.message);
        return { error: e.message };
    }
});

// 2. Obtener movimientos pendientes de cierre
ipcMain.handle('obtener-movimientos-caja', async (event, { tipo, companyId }) => {
    try {
        // Solo traemos los que NO han entrado en un Cierre Z (estado_cierre = 0)
        const stmt = db.prepare(`
            SELECT * FROM movimientos_caja_locales 
            WHERE tipo = ? AND company_id = ? AND estado_cierre = 0
            ORDER BY fecha DESC
        `);
        return stmt.all(tipo, companyId);
    } catch (e) {
        console.error("â Œ Error consultando movimientos:", e.message);
        return [];
    }
});

ipcMain.handle('validar-saldo-nc', async (event, nroFactura) => {
    try {
        // ðŸ”¥ CORRECCIÃ“N: La tabla real se llama ventas_locales
        const stmt = db.prepare("SELECT SUM(monto_total) as devuelto FROM ventas_locales WHERE es_nota_credito = 1 AND factura_afectada = ?");
        const row = stmt.get(nroFactura);
        
        return { exito: true, totalDevuelto: row.devuelto || 0 };
    } catch (error) {
        console.error("Error al validar saldo histÃ³rico NC:", error);
        return { exito: false, error: error.message };
    }
});

ipcMain.handle('obtener-historial-tasas', async () => {
    try {
        return db.prepare(`
            SELECT fecha, valor 
            FROM historial_tasas 
            ORDER BY fecha DESC 
            LIMIT 30
        `).all().reverse(); 
    } catch (e) {
        console.error("Error al obtener historial:", e);
        return [];
    }
});


let puertoActivo = null; 

ipcMain.on('tarear-bascula', () => {
    taraOffset = ultimoPesoBruto; 
    console.log(`âš–ï¸  BÃ¡scula Tareada (Software). Nuevo Offset: ${taraOffset}`);
});

ipcMain.on('iniciar-puerto-bascula', (event, puertoCOM) => {
    // 1. SIEMPRE actualizamos a quiÃ©n le vamos a enviar la data (la nueva ventana)
    senderBasculaActivo = event.sender;

    // ðŸ›¡ï¸  PROTECCIÃ“N ANTI-PUERTOS ZOMBIES
    if (basculaPort) {
        if (basculaPort.path === puertoCOM && basculaPort.isOpen) {
            console.log(`âš–ï¸  El puerto ${puertoCOM} ya estÃ¡ abierto. Redirigiendo datos a la nueva ventana...`);
            return; // Cortamos aquÃ­, pero como actualizamos senderBasculaActivo, ahora sÃ­ funcionarÃ¡
        } else {
            console.log(`âš–ï¸  Cerrando puerto viejo para abrir uno nuevo...`);
            basculaPort.close();
        }
    }

    try {
        basculaPort = new SerialPort({
            path: puertoCOM,
            baudRate: 9600, 
            autoOpen: true
        });


        const parser = basculaPort.pipe(new ReadlineParser({ delimiter: '\n' }));

        basculaPort.on('open', () => {
            console.log(`âœ… Puerto de bÃ¡scula abierto de forma segura: ${puertoCOM}`);
            taraOffset = 0.0; 
        });

        parser.on('data', (data) => {
            const rawStr = data.toString().trim();
            const rawWeight = parseFloat(rawStr);

            if (!isNaN(rawWeight)) {
                ultimoPesoBruto = rawWeight;
                
                let pesoNeto = rawWeight - taraOffset;
                
                if (pesoNeto < 0) pesoNeto = 0; 

                if (senderBasculaActivo && !senderBasculaActivo.isDestroyed()) {
                    senderBasculaActivo.send('peso-recibido', pesoNeto.toFixed(3));
                }
            }
        });

        basculaPort.on('error', (err) => {
            console.error('â Œ Error crÃ­tico en puerto COM:', err.message);
        });

        basculaPort.on('close', () => {
            console.log('ðŸ”Œ Puerto COM cerrado correctamente.');
            basculaPort = null;
        });

    } catch (error) {
        console.error("â Œ Error al inicializar bÃ¡scula:", error);
    }
});


// Handler para guardar una tasa manualmente o por scraping
ipcMain.handle('guardar-tasa-historial', async (event, { fecha, valor }) => {
    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO historial_tasas (fecha, valor) 
            VALUES (?, ?)
        `);
        return stmt.run(fecha, valor);
    } catch (e) {
        return { error: e.message };
    }
});


ipcMain.on('minimize-login-window', (event) => {
    const webContents = event.sender;
    const currentWindow = BrowserWindow.fromWebContents(webContents);
    if (currentWindow) currentWindow.minimize();
});

ipcMain.on('close-login-window', (event) => {
    const webContents = event.sender;
    const currentWindow = BrowserWindow.fromWebContents(webContents);
    if (currentWindow) currentWindow.close();
});

ipcMain.on('abrir-ventana-principal', (event, ruta) => {
    sistemaPrincipalAbierto = true;

    win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,  // Impide que se reduzca a menos de 1024px de ancho
        minHeight: 768, // Impide que se reduzca a menos de 768px de alto
        frame: true,         // DEVUELVE EL MARCO DE WINDOWS
        resizable: true,     // PERMITE CAMBIAR TAMAÃ‘O
        maximizable: true,   // PERMITE MAXIMIZAR
        icon: path.join(__dirname, 'assets/icono_redondeado.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            spellcheck: true,
            devTools: true   // HABILITA LA CONSOLA NUEVAMENTE
        }
    });

    win.loadFile(`public/${ruta}`);
    win.maximize();

    win.on('close', (e) => {
        if (!cierreAutorizado) {
            e.preventDefault(); 
            win.webContents.send('solicitar-verificacion-cierre');
        }
    });

    const webContents = event.sender;
    const loginWindow = BrowserWindow.fromWebContents(webContents);
    if (loginWindow) loginWindow.close();
});
ipcMain.handle('guardar-usuario-local', async (event, datos) => {
    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO usuarios_locales (uid, email, role, companyId, branchId, company_data, last_login)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        return stmt.run(datos.uid, datos.email, datos.role, datos.companyId, datos.branchId, datos.companyData);
    } catch (e) { return null; }
});

ipcMain.handle('encolar-sincronizacion', async (event, { operacion, tabla, datos }) => {
    try {
        const stmt = db.prepare(`
            INSERT INTO sync_queue (operacion, tabla, datos) 
            VALUES (?, ?, ?)
        `);
        return stmt.run(operacion, tabla, JSON.stringify(datos));
    } catch (e) {
        console.error("Error al encolar:", e);
        return { error: e.message };
    }
});

ipcMain.handle('guardar-tasa-bcv', async (event, tasa) => {
    try {
        const stmt = db.prepare(`INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion) VALUES ('TASA_BCV', ?, ?)`);
        stmt.run(tasa.toString(), new Date().toISOString());
        return { success: true };
    } catch (error) {
        console.error("â Œ Error al guardar tasa:", error);
        return { error: error.message };
    }
});

// --- RUTA UNIFICADA: SCRAPING, HISTORIAL Y RESPUESTA ---
ipcMain.handle('obtener-tasa-bcv', async () => {
    try {
        const url = 'https://www.bcv.org.ve/';
        const response = await axios.get(url, {
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });

        const $ = cheerio.load(response.data);
        
        // Extraemos todas las tasas de una vez para que tu tabla no salga vacÃ­a
        const rates = {
            'USD': parseFloat($('#dolar strong').text().trim().replace(',', '.')),
            'EUR': parseFloat($('#euro strong').text().trim().replace(',', '.')),
            'CNY': parseFloat($('#yuan strong').text().trim().replace(',', '.')),
            'TRY': parseFloat($('#lira strong').text().trim().replace(',', '.')),
            'RUB': parseFloat($('#rublo strong').text().trim().replace(',', '.'))
        };

        if (!isNaN(rates.USD)) {
            const hoy = new Date().toISOString().split('T')[0];
            
            // GUARDADO AUTOMÃ TICO EN EL HISTORIAL (Solo USD para el grÃ¡fico)
            db.prepare(`INSERT OR IGNORE INTO historial_tasas (fecha, valor, fuente) VALUES (?, ?, 'BCV')`)
              .run(hoy, rates.USD);
            
            // Retornamos el objeto completo para que el dashboard funcione
            return { success: true, rates };
        }
        return { success: false, error: "Datos no numÃ©ricos" };
    } catch (error) {
        console.error('â Œ Error en Scraping Nexus:', error.message);
        return { success: false, error: error.message };
    }
});

// SOLO ESTA LÃ NEA PARA EL TÃšNEL (Sin lÃ³gica extra, solo redirige al handle de arriba)
server.get('/api/tasas', async (req, res) => {
    try {
        const response = await axios.get('https://www.bcv.org.ve/', axiosConfigBCV);
        const $ = cheerio.load(response.data);
        const usd = parseFloat($('#dolar strong').text().trim().replace(',', '.'));
        res.json({ success: true, rates: { USD: usd } });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

ipcMain.on('cerrar-y-volver-login', (event) => {
    const currentWin = BrowserWindow.fromWebContents(event.sender);
    
    // Autorizamos el cierre solo de esta ventana (sin hacer app.quit)
    cierreAutorizado = true;

    // Crear la ventana de login idÃ©ntica a la original
    let loginWin = new BrowserWindow({
        width: 1100,
        height: 700,
        frame: false,
        resizable: false,
        maximizable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    loginWin.loadFile('public/index.html');
    loginWin.center();
    
    if (currentWin) currentWin.close();
    
    // Restauramos la seguridad de cierre para la prÃ³xima vez
    cierreAutorizado = false;
});

ipcMain.handle('obtener-productos-local', async (event, empresaId) => {
    try {
        console.log(`ðŸ“‚ Solicitando productos locales para la empresa: ${empresaId}`);
        
        let stmt;
        if (empresaId) {

            stmt = db.prepare(`SELECT * FROM productos_locales WHERE company_id = ?`);
            return stmt.all(empresaId);
        } else {

            stmt = db.prepare(`SELECT * FROM productos_locales`);
            return stmt.all();
        }
        
    } catch (e) {
        console.error("â Œ Error en obtener-productos-local:", e);
        return []; 
    }
});

ipcMain.handle('guardar-venta-local', async (event, v) => {
    try {
        // --- ðŸ”’ CALCULO ROBUSTO DE GANANCIA EN EL BACKEND ---
        try {
            let gananciaTotal = 0;
            let parsedData = JSON.parse(v.datos_json);
            let productos = parsedData.productos || [];
            
            for (let prod of productos) {
                let costo = 0;
                let stmtProd = db.prepare("SELECT precio_compra, datos_json, porcentaje_ganancia FROM productos_locales WHERE id = ?");
                let dbProd = stmtProd.get(prod.id);
                
                if (dbProd) {
                    if (dbProd.precio_compra) costo = parseFloat(dbProd.precio_compra);
                    else if (dbProd.datos_json) {
                        try {
                            let dj = JSON.parse(dbProd.datos_json);
                            if (dj.costo) costo = parseFloat(dj.costo);
                        } catch(e){}
                    }
                }
                
                let precioVenta = parseFloat(prod.precio) || 0;
                let monedaProd = (prod.moneda || 'USD').toUpperCase();
                let tasaBcv = parseFloat(v.tasa_bcv) || 1;
                let ganancia = 0;

                // Tomamos la ganancia pre-calculada del carrito, si no existe calculamos por costo DB
                if (prod.ganancia_unitaria !== undefined) {
                    ganancia = parseFloat(prod.ganancia_unitaria) || 0;
                } else {
                    ganancia = precioVenta - costo;
                }

                // Normalización vital a USD para evitar sumar papas con manzanas
                if (monedaProd === 'BS') {
                    ganancia = ganancia / tasaBcv;
                }

                // REGLA DE NEGOCIO: Los abonos a deudas no generan ganancias
                if (prod.id === 'PAGO-DEUDA' || prod.codigo === 'DEUDA') {
                    ganancia = 0;
                }

                let cantidad = parseFloat(prod.cantidad || prod.quantity || 1);
                gananciaTotal += (ganancia * cantidad);
            }
            v.ganancia_venta = parseFloat(gananciaTotal.toFixed(2));
            console.log("âœ… Ganancia calculada de forma segura en el backend:", v.ganancia_venta);
        } catch(e) {
            console.error("â Œ Error calculando ganancia en backend:", e);
        }
        // ----------------------------------------------------
        // ðŸ”’ RED DE SEGURIDAD: Si el frontend envÃ­a datos_hka separado, fusionarlo dentro de datos_json
        if (v.datos_hka && v.datos_json) {
            try {
                let parsedJson = JSON.parse(v.datos_json);
                if (!parsedJson.hka) {
                    parsedJson.hka = v.datos_hka;
                    v.datos_json = JSON.stringify(parsedJson);
                    console.log(`ðŸ”§ [FISCAL] Datos HKA inyectados en datos_json para ${v.numero_factura}`);
                }
            } catch(e) { /* datos_json no era JSON vÃ¡lido, se deja como estÃ¡ */ }
        }
        
        console.log(`ðŸ“‹ [GUARDAR] Factura: ${v.numero_factura} | Control: ${v.numero_control} | HKA: ${v.datos_hka ? JSON.stringify(v.datos_hka) : 'N/A'}`);

        const stmt = db.prepare(`
            INSERT INTO ventas_locales (
                id, company_id, branch_id, cashier_id, numero_factura, 
                numero_control, cliente_nombre, cliente_rif, monto_exento, 
                base_imponible, monto_iva, monto_igtf, monto_total, 
                tasa_bcv, metodo_pago, datos_json, ganancia_venta, estado_sync, estado_cierre,
                es_nota_credito, es_nota_debito, factura_afectada, monto_factura_afectada, fecha_factura_afectada, fecha_emision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
        `);
        
        const resultadoLocal = stmt.run(
            v.id, v.company_id, v.branch_id, v.cashier_id, v.numero_factura,
            v.numero_control, v.cliente_nombre, v.cliente_rif, v.monto_exento,
            v.base_imponible, v.monto_iva, v.monto_igtf, v.monto_total,
            v.tasa_bcv, v.metodo_pago, v.datos_json,
            v.ganancia_venta || 0,
            v.es_nota_credito || 0,
            v.es_nota_debito || 0,
            v.factura_afectada || null,
            v.monto_factura_afectada || null,
            v.fecha_factura_afectada || null
        );

        // 2. ENCOLAMIENTO PARA SINCRONIZACIÓN VPS (No bloquea a la cajera)
        try {
            let parsedDatos = JSON.parse(v.datos_json);
            let productosVenta = parsedDatos.productos || [];
            
            // Payload ultra-ligero: solo IDs y cantidades de productos físicos
            let itemsDescuento = productosVenta
                .filter(p => {
                    const nombre = String(p.nombre || '').toUpperCase();
                    return !nombre.includes('ABONO') && !nombre.includes('DEUDA') && !nombre.includes('SERVICIO');
                })
                .map(p => ({
                    id: p.id,
                    cantidad: parseFloat(p.cantidad || p.quantity || 1)
                }));

            if (itemsDescuento.length > 0) {
                const payloadDescuento = {
                    company_id: v.company_id,
                    sucursal_id: v.branch_id,
                    items: itemsDescuento,
                    tipo_movimiento: 'VENTA',
                    factura_ref: v.numero_factura
                };
                
                db.prepare('INSERT INTO sync_queue (operacion, tabla, datos) VALUES (?, ?, ?)')
                    .run('CREAR', 'ventas_descuento_vps', JSON.stringify(payloadDescuento));
                console.log(`📦 Venta ${v.numero_factura} encolada para sync VPS (${itemsDescuento.length} productos).`);
            }
        } catch (eQueue) {
            console.warn(`⚠️ No se pudo encolar venta para VPS:`, eQueue.message);
        }

        // 3. SINCRONIZACIÓN CON EL SERVIDOR MAESTRO (Red Local)
        try {
            if (config.isServer) {
                // Modo servidor: localhost directo
                await axios.post(`http://127.0.0.1:3000/api/maestro/registrar-venta`, v, { timeout: 3000 });
            } else {
                await llamarMaestro('POST', '/api/maestro/registrar-venta', v, { timeout: 6000, reintentos: 2 });
            }
            console.log(`📡 Venta ${v.numero_factura} sincronizada con Maestro.`);
        } catch (errSync) {
            console.warn(`âš ï¸  Maestro no disponible. Venta ${v.numero_factura} guardada solo local.`);
        }

        return resultadoLocal;
    } catch (e) {
        console.error("â Œ Error en guardado de venta:", e.message);
        return { error: e.message };
    }
});


ipcMain.handle('obtener-deuda-cliente-maestro', async (event, rif) => {
    try {
        const ip = config.isServer ? '127.0.0.1' : getIpMaestro();
        if (!ip) return { existe: false, monto_bs: 0, error: 'IP del servidor no configurada' };
        const response = await llamarMaestro('GET', `/api/maestro/consultar-deuda/${rif}`, null, { timeout: 5000, reintentos: 1 });
        return response.data;
    } catch (error) {
        console.error("â Œ Error consultando deuda en Maestro desde Main:", error.message);
        return { existe: false, monto_bs: 0, error: "Servidor Maestro no responde" };
    }
});

ipcMain.handle('obtener-proximo-correlativo', async (event, tipo) => {
    try {
        if (config.isServer && masterDbDirect) {
            // ðŸš€ MODO SERVIDOR: Consulta SQL directa (Sin puertos, sin errores de red)
            const transaccion = masterDbDirect.transaction(() => {
                let row = masterDbDirect.prepare('SELECT ultimo_numero, prefijo FROM correlativos_maestros WHERE tipo = ?').get(tipo);
                
                // ðŸ”¥ SOLUCIÃ“N: Si la fila no existe (Ej: NOTA_CREDITO), se crea al vuelo
                if (!row) {
                    console.log(`âš ï¸  Correlativo [${tipo}] no encontrado. CreÃ¡ndolo automÃ¡ticamente...`);
                    let prefijo = 'DOC-';
                    if (tipo === 'NOTA_CREDITO') prefijo = 'NC-';
                    else if (tipo === 'NOTA_DEBITO') prefijo = 'ND-'; // <--- LÃ NEA NUEVA AÃ‘ADIDA
                    else if (tipo === 'TICKET_NO_FISCAL') prefijo = 'TICK-';
                    else if (tipo === 'FORMA_LIBRE') prefijo = 'FL-';
                    else if (tipo === 'ELECTRONICA') prefijo = 'TFHKA-';
                    else if (tipo === 'FISCAL_HKA') prefijo = 'FIS-';

                    masterDbDirect.prepare('INSERT INTO correlativos_maestros (tipo, prefijo, ultimo_numero) VALUES (?, ?, 0)').run(tipo, prefijo);
                    row = { ultimo_numero: 0, prefijo: prefijo };
                }

                const nuevoNumero = row.ultimo_numero + 1;
                masterDbDirect.prepare('UPDATE correlativos_maestros SET ultimo_numero = ? WHERE tipo = ?').run(nuevoNumero, tipo);
                return { 
                    numero: nuevoNumero, 
                    formato: `${row.prefijo}${String(nuevoNumero).padStart(8, '0')}` 
                };
            });
            console.log("âš¡ Correlativo generado localmente (Directo de DB)");
            return transaccion();
        } else {
            // 🌠 MODO CLIENTE: Red → Servidor Maestro
            const respuesta = await llamarMaestro('POST', '/api/maestro/obtener-correlativo', { tipo }, { timeout: 8000, reintentos: 3 });
            return respuesta.data;
        }
    } catch (e) { 
        console.error("â Œ Error obteniendo correlativo:", e.message);
        return { error: "No se pudo obtener el correlativo." }; 
    }
});

// 3. Obtener una venta especÃ­fica (Para reimpresiones)
ipcMain.handle('obtener-venta-por-id', async (event, id) => {
    return db.prepare('SELECT * FROM ventas_locales WHERE id = ?').get(id);
});

ipcMain.handle('obtener-factura-local', async (event, numFactura) => {
    try {
        const ip = config.isServer ? '127.0.0.1' : getIpMaestro();
        if (!ip) return { error: true, mensaje: 'IP del servidor no configurada' };
        const response = await llamarMaestro('GET', `/api/maestro/buscar-factura/${numFactura}`, null, { timeout: 5000 });
        return response.data;

    } catch (error) {
        console.error("â Œ Error de comunicaciÃ³n con el Maestro:", error.message);
        return { 
            error: true, 
            mensaje: "No se pudo conectar al Servidor Central para buscar la factura." 
        };
    }
});

ipcMain.handle('reiniciar-aplicacion', () => {
    app.relaunch();
    app.quit();
});

ipcMain.handle('guardar-sesion-local', async (event, datos) => {
    // datos.role deberÃ­a ser 'cajera' o 'admin'
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO usuarios_locales (uid, email, role, companyId, branchId, company_data, last_login)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(datos.uid, datos.email, datos.role, datos.companyId, datos.branchId, JSON.stringify(datos.company_data), new Date().toISOString());
});

// Agrega esto en tu archivo main.js junto a los otros ipcMain.handle
ipcMain.handle('cerrar-sesion-local', async () => {
    try {
        // Eliminamos todos los registros de la tabla de sesiÃ³n para obligar a un nuevo login
        const stmt = db.prepare('DELETE FROM usuarios_locales');
        const resultado = stmt.run();
        console.log("ðŸ”’ SesiÃ³n local eliminada correctamente de SQLite.");
        return { exito: true, filas_borradas: resultado.changes };
    } catch (e) {
        console.error("â Œ Error al eliminar sesiÃ³n en SQLite:", e);
        return { exito: false, error: e.message };
    }
});

ipcMain.handle('registrar-deuda-maestro', async (event, datos) => {
    try {
        if (config.isServer && masterDbDirect) {
            // ðŸš€ MODO SERVIDOR: Escritura directa
            const transaccion = masterDbDirect.transaction(() => {
                // 1. Crear cliente si no existe (CAMBIO A RIF)
                masterDbDirect.prepare(`
                    INSERT OR IGNORE INTO clientes_maestro (rif, nombre, saldo_deuda) VALUES (?, ?, 0)
                `).run(datos.cliente_id, datos.cliente_nombre);

                // 2. Registrar la cuenta por cobrar
                masterDbDirect.prepare(`
                    INSERT INTO cuentas_por_cobrar (cliente_id, cliente_nombre, monto_bs, monto_usd, factura_nro, fecha, estado)
                    VALUES (?, ?, ?, ?, ?, ?, 'PENDIENTE')
                `).run(datos.cliente_id, datos.cliente_nombre, datos.monto_bs, datos.monto_usd || 0, datos.numero_factura, datos.fecha);
                
                // 3. Actualizar el saldo global (CAMBIO A RIF)
                masterDbDirect.prepare(`
                    UPDATE clientes_maestro SET saldo_deuda = saldo_deuda + ? WHERE rif = ?
                `).run(datos.monto_bs, datos.cliente_id);
            });

            transaccion();
            return { exito: true };
        } else {
            // 🌠 MODO CLIENTE: Enviar por red al Servidor Maestro
            const respuesta = await llamarMaestro('POST', '/api/maestro/registrar-deuda', datos, { timeout: 8000, reintentos: 2 });
            return respuesta.data;
        }
    } catch (e) {
        return { exito: false, mensaje: e.message };
    }
});

// main.js - PUENTE DE ABONOS (REDUCCIÓN DE DEUDA EN MAESTRO)
ipcMain.handle('registrar-abono-maestro', async (event, datos) => {
    try {
        // ðŸ”¥ CORRECCIÃ“N ARQUITECTÃ“NICA: 
        // Eliminamos la lÃ³gica duplicada de SQLite aquÃ­. 
        // Ahora TODOS (incluyendo el servidor) pasan por la API de server.js
        const respuesta = await llamarMaestro('POST', '/api/maestro/registrar-abono', datos, { timeout: 8000, reintentos: 2 });
        return respuesta.data;
    } catch (e) {
        console.error("[MAIN] Error en puente de abonos:", e.message);
        return { exito: false, mensaje: e.message };
    }
});


ipcMain.handle('guardar-cliente-local', async (event, cliente) => {
    try {
        if (config.isServer && masterDbDirect) {
            // ðŸš€ MODO SERVIDOR: Escribe directamente en el maestro
            const stmt = masterDbDirect.prepare(`
                INSERT INTO clientes_maestro (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda)
                VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0)
                ON CONFLICT(rif) DO UPDATE SET 
                nombre = excluded.nombre,
                direccion = excluded.direccion,
                telefono = excluded.telefono,
                correo = excluded.correo,
                es_contribuyente_especial = excluded.es_contribuyente_especial,
                company_id = excluded.company_id
            `);

            stmt.run({
                rif: cliente.rif,
                nombre: cliente.nombre,
                direccion: cliente.direccion || 'No especificada',
                telefono: cliente.telefono || '',
                correo: cliente.correo || '',
                es_contribuyente_especial: cliente.es_contribuyente_especial ? 1 : 0,
                company_id: cliente.company_id || null
            });

            return { success: true };
        } else {
            // 🌠 MODO CLIENTE: Envía por red al Servidor Maestro
            const respuesta = await llamarMaestro('POST', '/api/maestro/guardar-cliente', cliente, { timeout: 8000, reintentos: 2 });
            return respuesta.data;
        }
    } catch (error) {
        console.error("Error guardando cliente centralizado:", error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('obtener-clientes-local', async () => {
    try {
        if (config.isServer && masterDbDirect) {
            return masterDbDirect.prepare('SELECT * FROM clientes_maestro ORDER BY nombre ASC').all();
        } else {
            const respuesta = await llamarMaestro('GET', '/api/maestro/obtener-clientes', null, { timeout: 8000, reintentos: 1 });
            return respuesta.data;
        }
    } catch (e) {
        console.error("Error al obtener clientes centralizados:", e);
        return [];
    }
});

ipcMain.handle('eliminar-cliente-local', async (event, rif) => {
    try {
        if (config.isServer && masterDbDirect) {
            masterDbDirect.prepare('DELETE FROM clientes_maestro WHERE rif = ?').run(rif);
            return { success: true };
        } else {
            const respuesta = await llamarMaestro('DELETE', `/api/maestro/eliminar-cliente/${rif}`, null, { timeout: 6000, reintentos: 1 });
            return respuesta.data;
        }
    } catch (e) { 
        return { error: e.message }; 
    }
});


ipcMain.handle('login-local', async (event, email) => {
    return db.prepare('SELECT * FROM usuarios_locales WHERE LOWER(email) = LOWER(?)').get(email) || null;
});

ipcMain.handle('obtener-sesion-local', async () => {
    try {
        return db.prepare('SELECT * FROM usuarios_locales ORDER BY last_login DESC LIMIT 1').get();
    } catch (e) {
        console.error("Error al obtener sesión:", e);
        return null;
    }
});

ipcMain.handle('leer-puertos', async () => await SerialPort.list());

ipcMain.handle('sincronizar-categorias-local', async (event, categoriasArray) => {
    try {
        const stmt = db.prepare(`
            INSERT INTO categorias_locales (id, nombre) 
            VALUES (@id, @nombre)
            ON CONFLICT(id) DO UPDATE SET 
            nombre = excluded.nombre
        `);

        const transaccion = db.transaction((categorias) => {
            for (const cat of categorias) {
                stmt.run({
                    id: cat.categoria_id || cat.id, 
                    nombre: cat.nombre || 'Sin Categoría'
                });
            }
        });

        transaccion(categoriasArray);
        return { success: true };
    } catch (error) {
        console.error("❌ Error en sincronizar-categorias-local (main.js):", error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('obtener-auditoria-fiscal', async () => {
    try {
        const stmt = db.prepare('SELECT * FROM auditoria_fiscal ORDER BY fecha DESC LIMIT 1000');
        return stmt.all();
    } catch (error) {
        console.error("❌ Error obteniendo auditoria fiscal:", error.message);
        return [];
    }
});

ipcMain.handle('obtener-configuracion', async (event, clave) => {
    try {
        if (!clave) return config; 
        const stmt = db.prepare('SELECT valor FROM configuracion WHERE clave = ?');
        const resultado = stmt.get(clave);
        return resultado ? resultado.valor : null;
    } catch (error) {
        console.error(`❌ Error obteniendo configuración:`, error.message);
        return null;
    }
});

ipcMain.handle('obtener-configuracion-cajera', async (event, clave) => {
    try {
        if (!clave) return null; 
        const stmt = db.prepare('SELECT valor FROM configuracion_cajera WHERE clave = ?');
        const resultado = stmt.get(clave);
        return resultado ? resultado.valor : null;
    } catch (error) {
        console.error(`❌ Error obteniendo configuracion cajera:`, error.message);
        return null;
    }
});

ipcMain.handle('guardar-configuracion-cajera', async (event, clave, valor) => {
    try {
        const valorTexto = typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO configuracion_cajera (clave, valor, fecha_actualizacion)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `);
        stmt.run(clave, valorTexto);
        return { exito: true };
    } catch (error) {
        console.error("❌ Error guardando configuracion cajera:", error.message);
        return { error: error.message };
    }
});

ipcMain.handle('leer-impresoras', async (event) => {
    try {
        const webContents = event.sender;
        const impresoras = await webContents.getPrintersAsync();
        return impresoras;
    } catch (error) {
        console.error("❌ Error obteniendo impresoras del sistema:", error);
        return [];
    }
});




try { db.exec("ALTER TABLE ventas_locales ADD COLUMN ganancia_venta REAL DEFAULT 0"); } catch(e) {}
try { masterDbDirect.exec("ALTER TABLE movimientos_stock_maestro ADD COLUMN estado_sync INTEGER DEFAULT 0"); } catch(e) {}



ipcMain.handle('guardar-configuracion', async (event, clave, valor) => {
    try {
        const valorTexto = String(valor);
        
        // 1. Guardar en SQLite (Para la persistencia interna)
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion)
            VALUES (?, ?, ?)
        `);
        stmt.run(clave, valorTexto, new Date().toISOString());

        // 2. Sincronizar con el objeto en memoria
        if (clave === 'isServer') config.isServer = (valor === true || valor === "true");
        else if (clave === 'serverIP') config.serverIP = valor;
        else if (clave === 'allowNoStock') config.allowNoStock = (valor === true || valor === "true");
        else if (clave === 'geminiApiKey') config.geminiApiKey = valor;
        else if (clave === 'showConsole' || clave === 'mostrarConsola') config.showConsole = (valor === true || valor === "true");

        // 3. Escribir en el archivo físico config.json (Recreándolo si no existe)
        const llavesFisicas = ['isServer', 'serverIP', 'allowNoStock', 'geminiApiKey', 'showConsole', 'mostrarConsola'];
        if (llavesFisicas.includes(clave)) {
            config.showConsole = (clave === 'showConsole' || clave === 'mostrarConsola') ? (valor === true || valor === "true") : (config.showConsole || false);
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

            // 4. LÃ³gica de PM2 (Solo si cambia isServer)
            if (clave === 'isServer') {
                if (valor === true || valor === "true") {
                    exec(`pm2 start server.js --name "Nexus-Cerebro" --watch && pm2 save`);
                } else {
                    exec(`pm2 delete Nexus-Cerebro && pm2 save --force`);
                }
            }
        }
        
        return { success: true };
    } catch (error) {
        console.error(`â Œ Error crÃ­tico al guardar configuraciÃ³n:`, error.message);
        return { error: error.message };
    }
});

ipcMain.handle('imprimir-texto-libre', async (event, textoTicket, nombreImpresora) => {
    try {
        // 1. Creamos el archivo temporal
        const rutaArchivo = path.join(app.getPath('userData'), 'ticket_temporal.txt');
        // Escribimos en latin1 para que los acentos y la "Ã±" salgan bien en la tiquera
        fs.writeFileSync(rutaArchivo, textoTicket, 'latin1');
        
        // 2. Preparamos el comando RAW (Copiar archivo crudo al puerto de red local)
        // OJO: nombreImpresora ahora DEBE ser el nombre con el que compartiste la impresora (Ej: POS58)
        const comandoCMD = `copy /B "${rutaArchivo}" "\\\\localhost\\${nombreImpresora}"`;

        // 3. Ejecutamos la impresiÃ³n directamente en CMD
        return new Promise((resolve) => {
            console.log(`ðŸ’» Ejecutando impresiÃ³n RAW: ${comandoCMD}`);

            exec(comandoCMD, (error, stdout, stderr) => {
                // Borramos el archivo temporal a los 2 segundos
                setTimeout(() => {
                    if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
                }, 2000);

                if (error) {
                    console.error("â Œ Error al enviar RAW a impresora:", error.message);
                    console.error("Detalles:", stderr);
                    resolve({ exito: false, mensaje: error.message });
                } else {
                    console.log(`ðŸ–¨ï¸  Ticket enviado exitosamente a: \\\\localhost\\${nombreImpresora}`);
                    resolve({ exito: true });
                }
            });
        });
    } catch (error) {
        return { exito: false, mensaje: error.message };
    }
});

ipcMain.handle('obtener-cola-sincronizacion', async () => {
    try {
        // Leemos la cola ordenada por fecha (los mÃ¡s viejos primero)
        const stmt = db.prepare('SELECT * FROM sync_queue ORDER BY fecha_creacion ASC');
        return stmt.all();
    } catch (e) {
        console.error("â Œ Error al leer la cola de sincronizaciÃ³n:", e);
        return [];
    }
});

// 2. El motor borra un registro porque el VPS confirmÃ³ que lo recibiÃ³
ipcMain.handle('eliminar-de-cola', async (event, id) => {
    try {
        const stmt = db.prepare('DELETE FROM sync_queue WHERE id = ?');
        const resultado = stmt.run(id);
        return { success: true, changes: resultado.changes };
    } catch (e) {
        console.error(`â Œ Error al eliminar el registro ${id} de la cola:`, e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('sincronizar-producto-servidor', async (event, p) => {
    try {
        const idProducto = p.id || p.producto_ID;
        const idEmpresa = p.company_id || p.empresa_ID;
        const idSucursal = p.branch_id || p.sucursal_ID || 'sucursal_1';
        const barcodeRef = p.codigo || p.producto_codigo || '';
        p.codigo = barcodeRef;
        p.producto_codigo = barcodeRef;
        
        const precioRef = parseFloat(p.precios ? p.precios.p1.venta : (p.precio_venta || p.precio || 0)) || 0;
        const compraRef = parseFloat(p.precios ? p.precios.p1.compra : (p.precio_compra || 0)) || 0;
        const porcentajeRef = parseFloat(p.precios ? p.precios.p1.porcentaje : (p.porcentaje_ganancia || 0)) || 0;
        
        const jsonParaGuardar = JSON.stringify(p);
        const estadoSyncFinal = p.estado_sync !== undefined ? p.estado_sync : 0; 

        const local = db.prepare('SELECT * FROM productos_locales WHERE id = ?').get(idProducto);
        let resultado;

        if (!local) {
            const stmt = db.prepare(`
                INSERT INTO productos_locales (id, company_id, branch_id, codigo, nombre, precio, precio_compra, porcentaje_ganancia, categoria, status, imagen, datos_json, estado_sync, fecha_modificacion)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            resultado = stmt.run(
                idProducto, idEmpresa, idSucursal, barcodeRef, p.nombre, 
                precioRef, compraRef, porcentajeRef, p.categoria, p.status, 
                p.imagen, jsonParaGuardar, estadoSyncFinal, p.fecha_modificacion
            );
        } else {
            const stmt = db.prepare(`
                UPDATE productos_locales
                SET codigo = ?, nombre = ?, precio = ?, precio_compra = ?, porcentaje_ganancia = ?, categoria = ?, status = ?, imagen = ?, datos_json = ?, estado_sync = ?, fecha_modificacion = ?
                WHERE id = ?
            `);
            resultado = stmt.run(
                barcodeRef, p.nombre, precioRef, compraRef, porcentajeRef, 
                p.categoria, p.status, p.imagen, jsonParaGuardar, 
                estadoSyncFinal, p.fecha_modificacion, idProducto
            );
        }

        if (resultado && resultado.changes > 0) {
            BrowserWindow.getAllWindows().forEach(ventana => {
                if (!ventana.isDestroyed()) ventana.webContents.send('productos-actualizados');
            });
        }

        return resultado;
    } catch (e) {
        console.error("â Œ Error en sincronizar-producto-servidor:", e);
        return { error: e.message };
    }
});

// --- VERIFICADOR DE ACTUALIZACIONES GITHUB (CORREGIDO) ---
// FunciÃ³n Helper matemÃ¡tica para comparar versiones (Ej: "v1.2.0" vs "v1.0.0")
function esVersionMayor(versionNube, versionLocal) {
    // Limpiamos todo lo que no sea nÃºmero o punto y separamos por bloques
    const vNube = versionNube.replace(/[^0-9.]/g, '').split('.').map(Number);
    const vLocal = versionLocal.replace(/[^0-9.]/g, '').split('.').map(Number);
    
    const longitud = Math.max(vNube.length, vLocal.length);
    
    for (let i = 0; i < longitud; i++) {
        const numNube = vNube[i] || 0;
        const numLocal = vLocal[i] || 0;
        
        if (numNube > numLocal) return true;  // La nube tiene una versiÃ³n mÃ¡s nueva
        if (numNube < numLocal) return false; // La nube tiene una versiÃ³n mÃ¡s vieja (Omitir)
    }
    return false; // Son exactamente iguales (Omitir)
}

// --- VERIFICADOR DE ACTUALIZACIONES GITHUB ---
// Ahora recibe la versiÃ³n que tiene instalada el cliente actualmente
ipcMain.handle('verificar-actualizacion-github', async (event, versionActual) => {
    try {
        const repo = "memm1701-tech/NEXUS-POS-ELECTRON";
        const url = `https://api.github.com/repos/${repo}/releases`;
        
        const config = {
            headers: {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Nexus-POS-Global-App' 
            }
        };

        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        if (GITHUB_TOKEN) {
            config.headers['Authorization'] = `token ${GITHUB_TOKEN}`;
        }

        const response = await axios.get(url, config);
        
        if (!response.data || response.data.length === 0) {
            return { success: false, error: "No se encontraron versiones publicadas en el repositorio." };
        }

        // Iteramos sobre todos los releases de Github buscando uno que sea MAYOR al nuestro
        let actualizacionEncontrada = null;
        for (const release of response.data) {
            if (esVersionMayor(release.tag_name, versionActual)) {
                actualizacionEncontrada = release;
                break; // Encontramos una actualizaciÃ³n vÃ¡lida, detenemos la bÃºsqueda
            }
        }

        // Si encontramos una versiÃ³n superior
        if (actualizacionEncontrada) {
            const urlDescargaFichero = (actualizacionEncontrada.assets && actualizacionEncontrada.assets.length > 0) 
                                        ? actualizacionEncontrada.assets[0].browser_download_url 
                                        : "";

            return {
                success: true,
                hayActualizacion: true, // Bandera para el frontend
                nuevaVersion: actualizacionEncontrada.tag_name,
                notas: actualizacionEncontrada.body || "Sin notas de actualizaciÃ³n.",
                urlDescarga: urlDescargaFichero
            };
        } else {
            // Si no encontrÃ³ nada mayor (O estamos iguales, o Github tiene una versiÃ³n mÃ¡s vieja)
            return {
                success: true,
                hayActualizacion: false // Bandera de seguridad
            };
        }

    } catch (error) {
        console.error("â Œ Error en ConexiÃ³n GitHub:", error.response?.status || error.message);
        return { 
            success: false, 
            error: error.response?.status === 404 ? "Repositorio no encontrado o privado sin acceso" : (error.response?.status === 403 ? "LÃ­mite de API excedido o Token invÃ¡lido" : error.message) 
        };
    }
});

ipcMain.handle('editar-env-local', async (event, nuevaConfig) => {
    // USAMOS LA MISMA LÃ“GICA DE RUTA DINÃ MICA QUE EN LA LECTURA
    const baseDataDir = process.env.APPDATA 
        ? path.join(process.env.APPDATA, 'nexus-pos') 
        : path.join(process.platform === 'darwin' ? path.join(process.env.HOME, 'Library/Application Support') : process.env.HOME, '.config', 'nexus-pos');
    
    const envPath = path.join(baseDataDir, 'config', '.env'); // <--- Apunta a la carpeta config

    if (!fs.existsSync(envPath)) return false;

    try {
        let contenido = fs.readFileSync(envPath, 'utf8');

        if (nuevaConfig.respaldo_datos !== undefined) {
            // Reemplaza el valor de respaldo_datos (soporta con o sin comillas)
            contenido = contenido.replace(/respaldo_datos=["']?([^"'\n]+)["']?/g, `respaldo_datos=${nuevaConfig.respaldo_datos}`);
        }

        fs.writeFileSync(envPath, contenido);
        console.log(`âœ… Archivo .env fÃ­sicamente actualizado en: ${envPath}`);
        return true;
    } catch (err) {
        console.error("Error al actualizar el .env:", err);
        return false;
    }
});

ipcMain.handle('obtener-version-app', () => {
    return app.getVersion();
});

// --- DESCARGA E INSTALACIÃ“N AUTOMÃ TICA ---
ipcMain.handle('descargar-update', async (event, urlDescarga) => {
    try {
        // Descargar a la carpeta de Archivos Temporales de Windows (para no ensuciar Descargas)
        const tempDir = app.getPath('temp');
        const filePath = path.join(tempDir, 'Nexus-POS-Update.exe');
        
        const response = await axios({
            method: 'GET',
            url: urlDescarga,
            responseType: 'stream' // Importante para leer byte a byte
        });

        const totalLength = parseInt(response.headers['content-length'], 10);
        let downloaded = 0;

        const writer = fs.createWriteStream(filePath);
        
        response.data.on('data', (chunk) => {
            downloaded += chunk.length;
            // Calculamos el porcentaje
            const progress = Math.round((downloaded / totalLength) * 100);
            // Le avisamos al frontend (HTML) en quÃ© porcentaje vamos
            event.sender.send('download-progress', progress);
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            
            // Reemplazamos 'finish' por 'close'
            writer.on('close', () => {
                
                // Pausa tÃ¡ctica de 1.5 segundos para que Windows libere el archivo
                setTimeout(() => {
                    try {
                        const { spawn } = require('child_process');
                        
                        // ðŸ”¥ LA MEJOR PRÃ CTICA: InstalaciÃ³n silenciosa con auto-reinicio.
                        const installer = spawn(filePath, ['/S', '--force-run'], {
                            detached: true,
                            stdio: 'ignore'
                        });
                        installer.unref(); 
                        
                        // Cerramos NEXUS POS para liberar los archivos y permitir la sobrescritura
                        setTimeout(() => {
                            app.quit();
                        }, 1000);
                        
                        resolve({ success: true });
                    } catch (spawnError) {
                        console.error("Error al ejecutar instalador:", spawnError);
                        reject({ success: false, error: spawnError.message });
                    }
                }, 1500); 
            });
            
            writer.on('error', (err) => {
                reject({ success: false, error: err.message });
            });
        });
    } catch (error) {
        console.error("Error en descarga:", error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('marcar-como-sincronizado', async (event, tabla, idElemento) => {
    try {
        if (tabla === 'productos') {
            db.prepare('UPDATE productos_locales SET estado_sync = 1 WHERE id = ?').run(idElemento);
        } else if (tabla === 'categorias') {
            db.prepare('UPDATE categorias_locales SET estado_sync = 1 WHERE id = ?').run(idElemento);
        } else if (tabla === 'movimientos_stock') {
            try { db.prepare('UPDATE salidas_inventario SET estado_sync = 1 WHERE product_id = ? AND estado_sync = 0').run(idElemento); } catch(e) {}
            try { if (masterDbDirect) masterDbDirect.prepare('UPDATE movimientos_stock_maestro SET estado_sync = 1 WHERE producto_id = ? AND estado_sync = 0').run(idElemento); } catch(e) {}
        }
        
        // Avisar a la pantalla de inventario que refresque la tabla
        BrowserWindow.getAllWindows().forEach(ventana => {
            if (!ventana.isDestroyed()) ventana.webContents.send('productos-actualizados');
        });
        
        return { success: true };
    } catch (e) {
        console.error("â Œ Error al marcar como sincronizado:", e.message);
        return { error: e.message };
    }
});

ipcMain.handle('obtener-categorias-local', async () => {
    try {
        const stmt = db.prepare('SELECT * FROM categorias_locales ORDER BY nombre ASC');
        return stmt.all();
    } catch (e) {
        console.error("Error al obtener categorÃ­as locales:", e);
        return [];
    }
});

ipcMain.handle('sincronizar-categoria-servidor', async (event, cat) => {
    try {
        const check = db.prepare('SELECT fecha_modificacion FROM categorias_locales WHERE id = ?').get(cat.id);
        
        if (!check) {

            const insert = db.prepare(`
                INSERT INTO categorias_locales (id, company_id, nombre, estado_sync, fecha_modificacion)
                VALUES (?, ?, ?, 1, ?)
            `);
            return insert.run(cat.id, cat.company_id, cat.nombre, cat.fecha_modificacion);
        } else {
            const fechaServidor = new Date(cat.fecha_modificacion).getTime() || 0;
            const fechaLocal = (check.fecha_modificacion ? new Date(check.fecha_modificacion).getTime() : 0) || 0;
            
            if (isNaN(fechaLocal) || fechaServidor > fechaLocal) {
                const update = db.prepare(`
                    UPDATE categorias_locales 
                    SET nombre = ?, company_id = ?, fecha_modificacion = ?, estado_sync = 1
                    WHERE id = ?
                `);
                return update.run(cat.nombre, cat.company_id, cat.fecha_modificacion, cat.id);
            }
        }
        return { skipping: true };
    } catch (e) {
        console.error("Error al sincronizar categorÃ­a:", e);
        return { error: e.message };
    }
});


ipcMain.handle('eliminar-categoria-local', async (event, id) => {
    try {
        const stmt = db.prepare('DELETE FROM categorias_locales WHERE id = ?');
        return stmt.run(id);
    } catch (e) {
        console.error("Error al eliminar categorÃ­a local:", e);
        return { error: e.message };
    }
});


// ==========================================
// MÃ“DULO EMPLEADOS (SQLITE LOCAL)
// ==========================================

ipcMain.handle('guardar-empleado-local', async (event, emp) => {
    try {
        const stmt = masterDbDirect.prepare(`
            INSERT INTO empleados (
                ID_empleado, nombre, cedula, cargo, sueldo_base, telefono, sucursal, estado_sync
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ID_empleado) DO UPDATE SET
                nombre = excluded.nombre,
                cedula = excluded.cedula,
                cargo = excluded.cargo,
                sueldo_base = excluded.sueldo_base,
                telefono = excluded.telefono,
                sucursal = excluded.sucursal,
                estado_sync = 0
        `);
        
        stmt.run(
            emp.ID_empleado,
            emp.nombre,
            emp.cedula,
            emp.cargo,
            emp.sueldo_base,
            emp.telefono,
            emp.sucursal,
            0 
        );
        return { success: true };
    } catch (error) {
        console.error("Error al guardar empleado:", error);
        return { error: e.message };
    }
});

ipcMain.handle('guardar-proveedor-local', async (event, prov) => {
    try {
        if (!masterDbDirect) return { success: false, error: "Base de datos no conectada" };
        
        const stmt = masterDbDirect.prepare(`
            INSERT INTO proveedores (rif, company_id, nombre, telefono, contacto, direccion)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(rif) DO UPDATE SET
                nombre = excluded.nombre,
                telefono = excluded.telefono,
                contacto = excluded.contacto,
                direccion = excluded.direccion,
                company_id = excluded.company_id
        `);
        
        stmt.run(prov.rif, prov.company_id || null, prov.nombre, prov.telefono || '', prov.contacto, prov.direccion || '');
        return { success: true };
    } catch (error) {
        console.error("Error guardando proveedor:", error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('obtener-proveedores-local', async () => {
    try {
        if (!masterDbDirect) return [];
        return masterDbDirect.prepare('SELECT * FROM proveedores ORDER BY nombre ASC').all();
    } catch (error) {
        console.error("Error obteniendo proveedores:", error);
        return [];
    }
});

ipcMain.handle('eliminar-proveedor-local', async (event, rif) => {
    try {
        if (!masterDbDirect) return { success: false, error: "Base de datos no conectada" };
        masterDbDirect.prepare('DELETE FROM proveedores WHERE rif = ?').run(rif);
        return { success: true };
    } catch (error) {
        console.error("Error eliminando proveedor:", error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('guardar-movimiento-cxp-local', async (event, mov) => {
    try {
        if (!masterDbDirect) return { success: false, error: "Base de datos no conectada" };

        masterDbDirect.transaction(() => {
            // 1. Insertar movimiento (FACTURA)
            const stmtMov = masterDbDirect.prepare(`
                INSERT INTO movimientos_cuentas_pagar 
                (id, proveedor_rif, motivo, nota, monto, company_id, comprobante, estado, monto_abonado)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', 0)
            `);
            // Asegurar que sea tipo FACTURA
            const motivoReal = (mov.motivo || '').toUpperCase() === 'COMPRA' ? 'FACTURA' : (mov.motivo || 'FACTURA').toUpperCase();
            
            stmtMov.run(mov.id, mov.proveedor_rif, motivoReal, mov.nota, mov.monto, mov.company_id, mov.comprobante || mov.id);

            // 2. Actualizar saldo_deuda en proveedores (Aumenta la deuda)
            const stmtUpdate = masterDbDirect.prepare(`
                UPDATE proveedores 
                SET saldo_deuda = COALESCE(saldo_deuda, 0) + (?)
                WHERE rif = ?
            `);
            stmtUpdate.run(mov.monto, mov.proveedor_rif);
        })();

        return { success: true };
    } catch (err) {
        console.error("[MAIN] Error guardando factura CXP:", err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('registrar-abono-cxp-local', async (event, pago) => {
    try {
        if (!masterDbDirect) return { exito: false, mensaje: "Base de datos no conectada" };

        masterDbDirect.transaction(() => {
            // 1. Obtener la factura de destino
            const factura = masterDbDirect.prepare("SELECT * FROM movimientos_cuentas_pagar WHERE id = ?").get(pago.factura_id);
            if (!factura) throw new Error("Factura no encontrada");

            // 2. Insertar el movimiento del pago
            const pagoId = 'PAGO-' + Date.now();
            const stmtMov = masterDbDirect.prepare(`
                INSERT INTO movimientos_cuentas_pagar 
                (id, proveedor_rif, motivo, nota, monto, company_id, comprobante, estado, metodo_pago, referencia)
                VALUES (?, ?, 'PAGO', ?, ?, ?, ?, 'PAGADO', ?, ?)
            `);
            stmtMov.run(pagoId, factura.proveedor_rif, pago.nota || 'Abono a factura ' + factura.comprobante, pago.monto, factura.company_id, factura.comprobante, pago.metodo_pago, pago.referencia);

            // 3. Actualizar la factura destino (monto abonado y estado)
            const nuevoAbonado = (factura.monto_abonado || 0) + parseFloat(pago.monto);
            let nuevoEstado = 'ABONADO';
            // Tolerancia de 0.01 por decimales
            if (nuevoAbonado >= (factura.monto - 0.01)) {
                nuevoEstado = 'PAGADO';
            }

            const stmtFactura = masterDbDirect.prepare(`
                UPDATE movimientos_cuentas_pagar 
                SET monto_abonado = ?, estado = ?
                WHERE id = ?
            `);
            stmtFactura.run(nuevoAbonado, nuevoEstado, pago.factura_id);

            // 4. Actualizar saldo global del proveedor (Disminuye deuda)
            const stmtProv = masterDbDirect.prepare(`
                UPDATE proveedores 
                SET saldo_deuda = MAX(0, COALESCE(saldo_deuda, 0) - ?)
                WHERE rif = ?
            `);
            stmtProv.run(pago.monto, factura.proveedor_rif);
        })();

        return { exito: true };
    } catch (err) {
        console.error("[MAIN] Error registrando abono CXP:", err);
        return { exito: false, mensaje: err.message };
    }
});

ipcMain.handle('obtener-movimientos-cxp-local', async () => {
    try {
        if (!masterDbDirect) return [];
        // JOIN con proveedores para traer el nombre
        return masterDbDirect.prepare(`
            SELECT m.*, p.nombre as proveedor_nombre 
            FROM movimientos_cuentas_pagar m
            LEFT JOIN proveedores p ON m.proveedor_rif = p.rif
            ORDER BY m.fecha DESC LIMIT 100
        `).all();
    } catch (err) {
        console.error("Error obteniendo movimientos CXP:", err);
        return [];
    }
});

ipcMain.handle('obtener-resumen-cxp-local', async () => {
    try {
        if (!masterDbDirect) return { total_deuda: 0 };
        const row = masterDbDirect.prepare('SELECT SUM(saldo_deuda) as total FROM proveedores').get();
        return { total_deuda: row && row.total ? row.total : 0 };
    } catch (err) {
        console.error("Error obteniendo resumen CXP:", err);
        return { total_deuda: 0 };
    }
});



ipcMain.handle('obtener-empleados-local', async () => {
    try {
        const stmt = masterDbDirect.prepare('SELECT * FROM empleados');
        return stmt.all();
    } catch (error) {
        console.error("Error al obtener empleados:", error);
        return [];
    }
});

ipcMain.handle('eliminar-empleado-local', async (event, id) => {
    try {
        const stmt = masterDbDirect.prepare('DELETE FROM empleados WHERE ID_empleado = ?');
        stmt.run(id);
        return { success: true };
    } catch (error) {
        console.error("Error al eliminar empleado:", error);
        return { error: error.message };
    }
});

ipcMain.handle('guardar-movimiento-empleado-local', async (event, mov) => {
    try {
        // Insertar el movimiento
        const stmt = masterDbDirect.prepare(`
            INSERT INTO empleados_movimientos (
                id, empleado_id, motivo, razon, monto, company_id, estado_sync
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run(
            mov.id,
            mov.empleado_id,
            mov.motivo,
            mov.razon,
            mov.monto,
            mov.company_id,
            0 
        );

        // Actualizar el saldo del empleado
        let updateSql = '';
        if (mov.motivo === 'Ingreso') {
            updateSql = 'UPDATE empleados SET saldo_pendiente = saldo_pendiente + ? WHERE ID_empleado = ?';
        } else if (mov.motivo === 'Egreso') {
            updateSql = 'UPDATE empleados SET saldo_pendiente = saldo_pendiente - ? WHERE ID_empleado = ?';
        }

        if (updateSql) {
            masterDbDirect.prepare(updateSql).run(mov.monto, mov.empleado_id);
        }

        return { success: true };
    } catch (error) {
        console.error("Error al guardar movimiento de empleado:", error);
        return { error: error.message };
    }
});

ipcMain.handle('obtener-movimientos-empleado-local', async (event, empId) => {
    try {
        const stmt = masterDbDirect.prepare('SELECT * FROM empleados_movimientos WHERE empleado_id = ? ORDER BY fecha DESC');
        return stmt.all(empId);
    } catch (error) {
        console.error("Error al obtener movimientos de empleados:", error);
        return [];
    }
});


ipcMain.handle('guardar-sucursal-local', async (event, sucursal) => {
    try {
        // CORRECCIÃ“N: Respetar la fecha y el estado de sync si provienen de la nube
        const fechaAUsar = sucursal.fecha_modificacion || new Date().toISOString();
        const estadoSync = sucursal.estado_sync !== undefined ? sucursal.estado_sync : 0;

        const stmt = db.prepare(`
            INSERT INTO sucursales (
                id, 
                company_id, 
                nombre, 
                direccion, 
                telefono, 
                estado_sync, 
                fecha_modificacion
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                nombre = excluded.nombre,
                direccion = excluded.direccion,
                telefono = excluded.telefono,
                fecha_modificacion = excluded.fecha_modificacion,
                estado_sync = excluded.estado_sync
        `);

        return stmt.run(
            sucursal.id,           // ID Ãºnico de la sucursal
            sucursal.company_id,   // ID de la empresa dueÃ±a
            sucursal.nombre,
            sucursal.direccion,
            sucursal.telefono,
            estadoSync,            // Usar el estado dinÃ¡mico (0 o 1)
            fechaAUsar             // Usar la fecha correcta
        );
    } catch (e) {
        console.error("â Œ Error al guardar sucursal:", e);
        return { error: e.message };
    }
});

ipcMain.handle('obtener-sucursales-local', async (event, companyId) => {
    try {
        return db.prepare("SELECT * FROM sucursales WHERE company_id = ?").all(companyId);
    } catch (e) {
        return { error: e.message };
    }
});


ipcMain.handle('obtener-inventario-sucursal', async (event, { companyId, sucursalId }) => {
    try {
        if (config.isServer && masterDbDirect) {
            // ðŸ”¥ MODO SERVIDOR: Lee directo del Cerebro
            const stmt = masterDbDirect.prepare(`
                SELECT producto_id, cantidad_real
                FROM stock_maestro
                WHERE company_id = ? AND sucursal_id = ?
            `);
            return stmt.all(companyId, sucursalId);
        } else {
            // 🌐 MODO CLIENTE: Petición por red al servidor con retry
            const respuesta = await llamarMaestro('GET', `/api/maestro/stock?sucursalId=${sucursalId}&companyId=${companyId}`, null, { timeout: 8000, reintentos: 2 });
            return respuesta.data;
        }
    } catch (e) {
        console.warn("âš ï¸  Puerto 3000 bloqueado o Maestro offline. Leyendo stock desde respaldo local SQLite...");
        // ðŸ›¡ï¸  FALLBACK: Si falla (por Expo o red), lee directamente de la base de datos local
        try {
            const stmt = db.prepare(`
                SELECT producto_id, stock as cantidad_real
                FROM inventario_sucursales
                WHERE company_id = ? AND sucursal_id = ?
            `);
            return stmt.all(companyId, sucursalId);
        } catch (errorLocal) {
            console.error("â Œ Error profundo leyendo inventario local:", errorLocal.message);
            return [];
        }
    }
});

ipcMain.handle('verificar-y-descontar-stock-maestro', async (event, datos) => {
    try {
        const items = Array.isArray(datos) ? datos : datos.items;
        const sucursalId = Array.isArray(datos) ? null : datos.sucursalId;

        // ðŸ”¥ FILTRO INTELIGENTE: Separamos productos fÃ­sicos de los servicios
        const productosFisicos = items.filter(item => {
            const nombre = String(item.nombre || '').toUpperCase();
            const id = String(item.id || '').toUpperCase();
            
            // Si el nombre contiene ABONO, DEUDA o SERVICIO, lo sacamos de la lista de stock
            return !nombre.includes('ABONO') && !nombre.includes('DEUDA') && !nombre.includes('SERVICIO');
        });

        // Si el carrito SOLO tenÃ­a abonos (ej. el cliente solo vino a pagar), damos luz verde inmediata
        if (productosFisicos.length === 0) {
            console.log("âš¡ Venta de puro servicio/abono. Stock verificado automÃ¡ticamente.");
            return { exito: true };
        }

        // --- LÃ“GICA DE DESCUENTO (Solo procesarÃ¡ los productosFisicos) ---
        if (config.isServer && masterDbDirect) {
            // ðŸš€ MODO SERVIDOR: Descuento directo en el archivo
            masterDbDirect.prepare(`CREATE TABLE IF NOT EXISTS movimientos_stock_maestro (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_id TEXT NOT NULL,
                sucursal_id TEXT,
                producto_id TEXT NOT NULL,
                cantidad REAL NOT NULL,
                tipo_movimiento TEXT NOT NULL,
                fecha_movimiento DATETIME DEFAULT CURRENT_TIMESTAMP,
                referencia_id TEXT,
                estado_sync INTEGER DEFAULT 0
            )`).run();
            try { masterDbDirect.prepare("ALTER TABLE movimientos_stock_maestro ADD COLUMN estado_sync INTEGER DEFAULT 0").run(); } catch(e) {}

            const transaccion = masterDbDirect.transaction((productos) => {
                for (const item of productos) {
                    let row;
                    if (sucursalId) {
                        row = masterDbDirect.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ? AND sucursal_id = ?').get(item.id, sucursalId);
                    } else {
                        row = masterDbDirect.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ?').get(item.id);
                    }

                    if (!row || row.cantidad_real < item.cantidad) {
                        throw new Error(`Stock insuficiente para: ${item.nombre || item.id}`);
                    }
                }
                
                const stmtConSucursal = masterDbDirect.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real - ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ? AND sucursal_id = ?');
                const stmtSinSucursal = masterDbDirect.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real - ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ?');
                const stmtKardex = masterDbDirect.prepare(`INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento, estado_sync) VALUES (?, ?, ?, ?, ?, ?)`);
                
                for (const item of productos) { 
                    // Obtener company_id
                    const rowComp = masterDbDirect.prepare('SELECT company_id FROM stock_maestro WHERE producto_id = ? LIMIT 1').get(item.id);
                    const compId = rowComp ? rowComp.company_id : 'DEFAULT';

                    if (sucursalId) {
                        stmtConSucursal.run(item.cantidad, item.id, sucursalId);
                        try { stmtKardex.run(compId, sucursalId, item.id, -Math.abs(item.cantidad), 'VENTA', 1); } catch(e) {}
                    } else {
                        stmtSinSucursal.run(item.cantidad, item.id);
                        try { stmtKardex.run(compId, 'GLOBAL', item.id, -Math.abs(item.cantidad), 'VENTA', 1); } catch(e) {}
                    }
                }
            });

            transaccion(productosFisicos); // âœ… Pasamos solo los fÃ­sicos
            console.log("âš¡ Stock descontado directamente en la DB Maestra");
            return { exito: true };
        } else {
            // ðŸŒ MODO CLIENTE: PeticiÃ³n por red al servidor
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/descontar-stock`, {
                sucursalId: sucursalId,
                items: productosFisicos.map(i => ({ id: i.id, cantidad: i.cantidad, nombre: i.nombre }))
            });
            return respuesta.data;
        }
    } catch (e) {
        return { exito: false, mensaje: e.message || "Error de comunicaciÃ³n con el maestro." };
    }
});


ipcMain.handle('guardar-stock-sucursal', async (event, { productoId, sucursalId, companyId, cantidad, operacion, datosStock }) => {
    try {
        if (config.isServer && masterDbDirect) {
            // ðŸ”¥ SOLUCIÃ“N: Escribimos directamente en el Cerebro Maestro (stock_maestro) saltÃ¡ndonos el puerto 3000
            // OBTENER STOCK PREVIO
            let stockPrevio = 0;
            const rowStock = masterDbDirect.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ? AND sucursal_id = ?').get(productoId, sucursalId);
            if (rowStock) stockPrevio = parseFloat(rowStock.cantidad_real || 0);

            const sql = operacion === 'FIJAR' 
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

            const resultado = masterDbDirect.prepare(sql).run(productoId, sucursalId, companyId, cantidad);

            // REGISTRAR MOVIMIENTO KARDEX
            let diferencia = 0;
            let tipoMov = '';
            if (operacion === 'FIJAR') {
                diferencia = parseFloat(cantidad) - stockPrevio;
                tipoMov = diferencia >= 0 ? 'AJUSTE_POSITIVO' : 'AJUSTE_NEGATIVO';
            } else {
                diferencia = parseFloat(cantidad);
                tipoMov = 'ENTRADA';
            }

            if (diferencia !== 0) {
                try {
                    masterDbDirect.prepare(`CREATE TABLE IF NOT EXISTS movimientos_stock_maestro (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        company_id TEXT NOT NULL,
                        sucursal_id TEXT,
                        producto_id TEXT NOT NULL,
                        cantidad REAL NOT NULL,
                        tipo_movimiento TEXT NOT NULL,
                        fecha_movimiento DATETIME DEFAULT CURRENT_TIMESTAMP,
                        referencia_id TEXT,
                        estado_sync INTEGER DEFAULT 0
                    )`).run();

                    const estadoSyncParam = operacion === 'FIJAR' ? 1 : (datosStock && datosStock.estado_sync !== undefined ? datosStock.estado_sync : 0);
                    masterDbDirect.prepare(`INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento, estado_sync) VALUES (?, ?, ?, ?, ?, ?)`)
                            .run(companyId, sucursalId, productoId, diferencia, tipoMov, estadoSyncParam);
                } catch(e) { console.error("Error guardando movimiento Kardex IPC local:", e.message); }
            }
            return { success: true, msg: "Stock de sucursal actualizado correctamente." };
        }
        return { success: false, error: "Configuración inválida." };
    } catch (error) {
        console.error("Error actualizando stock de sucursal en BD:", error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('consultar-estado-fiscal', async (event, puerto) => {
    return new Promise((resolve) => {
        const rawPort = puerto || 'COM99';
        const portName = rawPort.toString().toUpperCase().startsWith('COM') ? rawPort.toString().toUpperCase() : `COM${rawPort}`; 
        const port = new SerialPort({ path: portName, baudRate: 9600, autoOpen: false });
        port.on('error', (err) => { console.error('Error hardware atrapado en puerto serial:', err.message); });

        // ðŸ”¥ CERRADURA SINCRONIZADA
        const closeAndResolve = (resultado) => {
            if (port.isOpen) {
                port.close(() => resolve(resultado));
            } else {
                resolve(resultado);
            }
        };

        port.open((err) => {
            if (err) return resolve({ success: false, errorType: "HKA_ERROR", msg: `No se pudo abrir ${portName}` });

            const STX = Buffer.from([0x02]);
            const ETX = Buffer.from([0x03]);
            
            // 1. PRIMERO SOLICITAMOS EL STATUS (ENQ)
            const comandoENQ = Buffer.from([0x05]);
            
            const comandoS1 = Buffer.from("S1", "latin1");
            const lrcS1 = calcularLRC(comandoS1, ETX);
            const tramaS1 = Buffer.concat([STX, comandoS1, ETX, Buffer.from([lrcS1])]);
            
            let bufferRecepcion = "";
            let estadoENQEnviado = true;
            let reintentoENQHecho = false;
            let timeoutConsultas;

            port.on("data", (data) => {
                bufferRecepcion += data.toString("latin1");
                
                if (data.includes(0x15)) {
                    if (estadoENQEnviado && !reintentoENQHecho) {
                        console.log("[FISCAL] NAK inicial en estado-fiscal. Auto-reintentando ENQ tras 200ms...");
                        reintentoENQHecho = true;
                        bufferRecepcion = "";
                        setTimeout(() => { if(port.isOpen) port.write(comandoENQ); }, 200);
                        return;
                    }
                    clearTimeout(timeoutConsultas);
                    return closeAndResolve({ success: false, errorType: "HKA_ERROR", msg: "Impresora rechazÃ³ consulta (NAK)." });
                }
                if (data.includes(0x03)) {
                    if (estadoENQEnviado) {
                        estadoENQEnviado = false;
                        // Extraemos la respuesta de ENQ (STX STS1 STS2 ETX LRC)
                        const stxIndex = bufferRecepcion.indexOf('\x02');
                        const etxIndex = bufferRecepcion.indexOf('\x03');
                        if (stxIndex !== -1 && etxIndex !== -1 && etxIndex > stxIndex + 2) {
                            const sts2 = bufferRecepcion.charCodeAt(stxIndex + 2); // STS2 está justo antes del ETX en un status normal (o es el 2do byte)
                            if (sts2 !== 0x40) {
                                clearTimeout(timeoutConsultas);
                                return closeAndResolve({ success: false, errorType: 'HKA_ERROR', msg: decodificarErrorHKA(sts2) });
                            }
                        }
                        // Si no hay error, pedimos el Serial (S1)
                        bufferRecepcion = "";
                        port.write(tramaS1);
                    } else {
                        // Respuesta del S1
                        clearTimeout(timeoutConsultas);
                        try {
                            const contenido = bufferRecepcion.split('\x02')[1].split('\x03')[0];
                            let serial = "DESC";
                            let nroFac = "S/N";
                            let flag21 = "No detectado";
                            if (contenido.includes('\n')) {
                                const partes = contenido.split('\n').map(p => p.trim()); 
                                serial = partes[13] ? partes[13] : "DESC";        
                                if (partes.length >= 14) {
                                    const facturaReal = parseInt(partes[2], 10);
                                    if (!isNaN(facturaReal) && facturaReal > 0) nroFac = facturaReal.toString().padStart(8, '0');
                                }
                            } else {
                                // Fallback: parseo por posición fija sólo si la trama no tiene saltos de línea
                                // Estrategia 1: buscar serial por patrón conocido (8-10 chars alfanuméricos al final)
                                const serialMatch = contenido.match(/([A-Z0-9]{6,12})\s*$/);
                                if (serialMatch) serial = serialMatch[1];
                                
                                // Estrategia 2: buscar 8 dígitos consecutivos para el número de factura
                                const facMatch = contenido.match(/(\d{8})/g);
                                if (facMatch && facMatch.length >= 3) {
                                    const facturaReal = parseInt(facMatch[2], 10);
                                    if (!isNaN(facturaReal) && facturaReal > 0) nroFac = facturaReal.toString().padStart(8, '0');
                                }
                            }
                            closeAndResolve({ success: true, msg: "Máquina en línea", serial: serial, nroFactura: nroFac, flag21: flag21 });
                        } catch (e) {
                            closeAndResolve({ success: true, msg: "Máquina en línea (Serial no leído)" });
                        }
                    }
                }
            });


            timeoutConsultas = setTimeout(() => {
                closeAndResolve({ success: false, errorType: 'HKA_ERROR', msg: "Timeout al consultar la impresora fiscal." });
            }, 3000);

            // Iniciar flujo con ENQ
            port.write(comandoENQ);
        });
    });
});

ipcMain.handle('consultar-modelo-fiscal', async (event, puerto) => {
    return new Promise((resolve) => {
        const rawPort = puerto || 'COM99';
        const portName = rawPort.toString().toUpperCase().startsWith('COM') ? rawPort.toString().toUpperCase() : `COM${rawPort}`; 
        const port = new SerialPort({ path: portName, baudRate: 9600, autoOpen: false });
        port.on('error', (err) => { console.error('Error hardware atrapado en puerto serial:', err.message); });

        const closeAndResolve = (resultado) => {
            if (port.isOpen) {
                port.close(() => resolve(resultado));
            } else {
                resolve(resultado);
            }
        };

        port.open((err) => {
            if (err) return resolve({ success: false, errorType: 'HKA_ERROR', msg: `No se pudo abrir ${portName}` });

            const STX = Buffer.from([0x02]);
            const ETX = Buffer.from([0x03]);
            
            const comandoENQ = Buffer.from([0x05]);
            const comandoSV = Buffer.from('SV', 'latin1');
            const lrcSV = calcularLRC(comandoSV, ETX);
            const tramaSV = Buffer.concat([STX, comandoSV, ETX, Buffer.from([lrcSV])]);
            
            let bufferRecepcion = "";
            let estadoENQEnviado = true;
            let timeoutConsultas;

            port.on('data', (data) => {
                bufferRecepcion += data.toString('latin1');
                
                if (data.includes(0x15)) {
                    clearTimeout(timeoutConsultas);
                    return closeAndResolve({ success: false, errorType: 'HKA_ERROR', msg: "Impresora rechazÃ³ consulta (NAK)." });
                }
                
                if (data.includes(0x03)) {
                    if (estadoENQEnviado) {
                        estadoENQEnviado = false;
                        const stxIndex = bufferRecepcion.indexOf('\x02');
                        const etxIndex = bufferRecepcion.indexOf('\x03');
                        if (stxIndex !== -1 && etxIndex !== -1 && etxIndex > stxIndex + 2) {
                            const sts2 = bufferRecepcion.charCodeAt(stxIndex + 2);
                            if (sts2 !== 0x40) {
                                clearTimeout(timeoutConsultas);
                                return closeAndResolve({ success: false, errorType: 'HKA_ERROR', msg: decodificarErrorHKA(sts2) });
                            }
                        }
                        bufferRecepcion = "";
                        port.write(tramaSV);
                    } else {
                        clearTimeout(timeoutConsultas);
                        try {
                            const contenido = bufferRecepcion.split('\x02')[1].split('\x03')[0];
                            const MODELOS_SIN_DEBITO = ['SRP-270','SRP-280','SRP-350','HKA-112','TD1125','TALLY','KUBE','HSP7000'];
                            const soportaDebitoND = !MODELOS_SIN_DEBITO.some(m => contenido.includes(m));
                            closeAndResolve({ success: true, modelo: contenido, soportaDebitoND });
                        } catch (e) {
                            closeAndResolve({ success: false, msg: "Error al leer modelo" });
                        }
                    }
                }
            });

            timeoutConsultas = setTimeout(() => {
                closeAndResolve({ success: false, errorType: 'HKA_ERROR', msg: "Timeout al consultar la impresora fiscal." });
            }, 3000);

            port.write(comandoENQ);
        });
    });
});

ipcMain.handle('emitir-tramas-hka', async (event, tramas, puerto) => {
    return new Promise((resolve) => {
        const rawPort = puerto || 'COM99';
        const portName = rawPort.toString().toUpperCase().startsWith('COM') ? rawPort.toString().toUpperCase() : `COM${rawPort}`;
        const port = new SerialPort({ path: portName, baudRate: 9600, autoOpen: false });
        port.on('error', (err) => { console.error('Error hardware atrapado en puerto serial:', err.message); });

        // ðŸ”¥ CERRADURA SINCRONIZADA
        const closeAndResolve = (resultado) => {
            console.log(`[FISCAL] Resultado final de la operaciÃ³n:`, resultado);
            if (port.isOpen) {
                port.close(() => resolve(resultado));
            } else {
                resolve(resultado);
            }
        };

        const tienePagos = tramas.some(cmd => /^[12](0[1-9]|1[0-9]|2[0-4])/.test(cmd));
        if (tienePagos && !tramas.includes("199")) {
            tramas.push("199");
            console.log("[FISCAL] ðŸ› ï¸ Comando 199 inyectado automÃ¡ticamente para cierre con IGTF (Flag 50=01).");
        }

        port.open((err) => {
            if (err) return resolve({ success: false, msg: `Error abriendo puerto: ${err.message}` });
            
            let index = 0;
            const STX = Buffer.from([0x02]);
            const ETX = Buffer.from([0x03]);
            let timeoutOperacion; 
            let leyendoStatusFinal = false; 

            console.log(`\n[FISCAL] ðŸš€ Iniciando facturaciÃ³n con ${tramas.length} comandos.`);

            const enviarSiguienteComando = () => {
                clearTimeout(timeoutOperacion); 

                if (index >= tramas.length) {
                    console.log("[FISCAL] ðŸŽ‰ Todas las tramas enviadas con Ã©xito. Ticket Cerrado.");
                    
                    leyendoStatusFinal = true;
                    console.log(`[FISCAL] ðŸ“¤ Solicitando estado S1...`);
                    
                    const comandoS1 = Buffer.from('S1', 'latin1');
                    const lrcS1 = calcularLRC(comandoS1, ETX);
                    const tramaS1 = Buffer.concat([STX, comandoS1, ETX, Buffer.from([lrcS1])]);
                    
                    port.write(tramaS1);
                    
                    timeoutOperacion = setTimeout(() => {
                        console.error(`[FISCAL] âš ï¸ TIMEOUT leyendo S1. Se guardarÃ¡ sin nÃºmero oficial.`);
                        closeAndResolve({ success: true, numeroFactura: "S/N", serialImpresora: "DESC" });
                    }, 5000);
                    return;
                }

                const comandoAscii = tramas[index];
                const bufferComando = Buffer.from(comandoAscii, 'latin1');
                const lrcByte = calcularLRC(bufferComando, ETX);
                const LRC = Buffer.from([lrcByte]);

                const tramaFinal = Buffer.concat([STX, bufferComando, ETX, LRC]);

                port.write(tramaFinal, (err) => {
                    if (err) {
                        clearTimeout(timeoutOperacion);
                        return closeAndResolve({ success: false, msg: 'Error de escritura' });
                    }
                    console.log(`[FISCAL] ðŸ“¤ Enviado -> ${comandoAscii}`);
                });

                timeoutOperacion = setTimeout(() => {
                    closeAndResolve({ success: false, msg: `Timeout en: ${comandoAscii}` });
                }, 15000);
            };

            let bufferRecepcion = "";
            let leyendoErrorNAK = false;

            port.on('data', (data) => {
                if (leyendoErrorNAK) {
                    bufferRecepcion += data.toString('latin1');
                    if (data.includes(0x03)) {
                        clearTimeout(timeoutOperacion);
                        const stxIndex = bufferRecepcion.indexOf('\x02');
                        const etxIndex = bufferRecepcion.indexOf('\x03');
                        if (stxIndex !== -1 && etxIndex !== -1 && etxIndex > stxIndex + 2) {
                            const sts1 = bufferRecepcion.charCodeAt(stxIndex + 1);
                            const sts2 = bufferRecepcion.charCodeAt(stxIndex + 2);
                            const sts3 = etxIndex > stxIndex + 3 ? bufferRecepcion.charCodeAt(stxIndex + 3) : null;
                            
                            console.error(`[FISCAL] Estado completo de la impresora tras NAK:`);
                            console.error(`         STS1: 0x${sts1.toString(16).toUpperCase()} (${sts1})`);
                            console.error(`         STS2: 0x${sts2.toString(16).toUpperCase()} (${sts2})`);
                            if (sts3 !== null) console.error(`         STS3: 0x${sts3.toString(16).toUpperCase()} (${sts3})`);
                            console.error(`         RAW:`, Buffer.from(bufferRecepcion, 'latin1').toString('hex'));

                            const errMsg = decodificarErrorHKA(sts2);
                            closeAndResolve({ success: false, errorType: 'HKA_ERROR', msg: errMsg });
                        } else {
                            closeAndResolve({ success: false, errorType: 'HKA_ERROR', msg: `Error no identificado tras NAK en: ${tramas[index]}` });
                        }
                    }
                    return;
                }

                if (!leyendoStatusFinal) {
                    if (data.includes(0x06)) {
                        index++;
                        setTimeout(enviarSiguienteComando, 250); 
                    } 
                    else if (data.includes(0x15)) { 
                        clearTimeout(timeoutOperacion);
                        console.error(`[FISCAL] âŒ NAK recibido. Solicitando cÃ³digo de error...`);
                        leyendoErrorNAK = true;
                        bufferRecepcion = "";
                        port.write(Buffer.from([0x05])); // ENQ
                        timeoutOperacion = setTimeout(() => {
                            closeAndResolve({ success: false, errorType: 'HKA_ERROR', msg: `La impresora rechazÃ³ el comando y no respondiÃ³ al ENQ: ${tramas[index]}` });
                        }, 3000);
                    }
                } else {
                    bufferRecepcion += data.toString('latin1');
                    
                    if (data.includes(0x03)) { 
                        clearTimeout(timeoutOperacion);
                        
                        try {
                            const contenido = bufferRecepcion.split('\x02')[1].split('\x03')[0];
                            let nroFac = "S/N";
                            let serial = "DESC";
                            
                            if (contenido.includes('\n')) {
                                const partes = contenido.split('\n').map(p => p.trim()); 
                                if (partes.length >= 14) {
                                    const facturaReal = parseInt(partes[2], 10);      
                                    const docNoFiscal = parseInt(partes[11], 10);     
                                    serial = partes[13] ? partes[13] : "DESC";        
                                    nroFac = (facturaReal === 0 || isNaN(facturaReal)) ? "TEST-" + (isNaN(docNoFiscal) ? "1" : docNoFiscal) : facturaReal.toString();
                                }
                            } else {
                                // Fallback: parseo por posiciÃ³n fija sÃ³lo si la trama no tiene saltos de lÃ­nea


                                // Estrategia 1: buscar serial por patrón conocido (8-10 chars alfanuméricos al final)
                                const serialMatch = contenido.match(/([A-Z0-9]{6,12})\s*$/);
                                if (serialMatch) serial = serialMatch[1];
                                
                                // Estrategia 2: buscar 8 dígitos consecutivos para el número de factura
                                const facMatch = contenido.match(/(\d{8})/g);
                                if (facMatch && facMatch.length >= 3) {
                                    const facturaReal = parseInt(facMatch[2], 10);
                                    nroFac = (facturaReal === 0 || isNaN(facturaReal)) ? 'TEST-X' : facturaReal.toString();
                                }
                            }

                            console.log('[FISCAL] ✅ Número Oficial Procesado: ' + nroFac + ' | Serial: ' + serial);
                            closeAndResolve({ 
                                success: true, 
                                numeroFactura: nroFac.padStart(8, '0'), 
                                serialImpresora: serial 
                            });

                        } catch (e) {
                            console.error("[FISCAL] ⚠️ Error crítico parseando S1:", e);
                            closeAndResolve({ success: true, numeroFactura: "S/N", serialImpresora: "DESC" });
                        }
                    }
                }
            });

            enviarSiguienteComando();
        });
    });
});

ipcMain.handle('guardar-reporte-fiscal-local', async (event, reporte) => {
    try {
        const stmt = db.prepare(`
            INSERT INTO reportes_fiscales_cierre (
                id, company_id, branch_id, cashier_id, tipo_reporte, numero_z,
                fecha_emision, hora_emision, ultima_factura, exento,
                base_imponible_tasa_1, impuesto_tasa_1, base_imponible_tasa_2, impuesto_tasa_2,
                base_imponible_tasa_3, impuesto_tasa_3, igtf, raw_data, estado_sync
            ) VALUES (
                @id, @company_id, @branch_id, @cashier_id, @tipo_reporte, @numero_z,
                @fecha_emision, @hora_emision, @ultima_factura, @exento,
                @base_imponible_tasa_1, @impuesto_tasa_1, @base_imponible_tasa_2, @impuesto_tasa_2,
                @base_imponible_tasa_3, @impuesto_tasa_3, @igtf, @raw_data, 0
            )
        `);

        stmt.run({
            id: reporte.id || 'REP-' + Date.now(),
            company_id: reporte.companyId,
            branch_id: reporte.branchId,
            cashier_id: reporte.cashierId,
            tipo_reporte: reporte.tipoReporte,
            numero_z: reporte.numeroZ,
            fecha_emision: reporte.fechaEmision,
            hora_emision: reporte.horaEmision,
            ultima_factura: reporte.ultimaFactura,
            exento: reporte.exento || 0,
            base_imponible_tasa_1: reporte.base1 || 0,
            impuesto_tasa_1: reporte.impuesto1 || 0,
            base_imponible_tasa_2: reporte.base2 || 0,
            impuesto_tasa_2: reporte.impuesto2 || 0,
            base_imponible_tasa_3: reporte.base3 || 0,
            impuesto_tasa_3: reporte.impuesto3 || 0,
            igtf: reporte.igtf || 0,
            raw_data: reporte.rawData || ''
        });

        try {
            const ipMaestro = config.isServer ? '127.0.0.1' : getIpMaestro();
            if (ipMaestro) {
                const axiosLocal = require('axios');
                await axiosLocal.post('http://' + ipMaestro + ':3000/api/maestro/registrar-reporte-fiscal', reporte, { timeout: 4000 });
                console.log("📡 Reporte fiscal sincronizado con el Servidor Maestro exitosamente.");
                db.prepare('UPDATE reportes_fiscales_cierre SET estado_sync = 1 WHERE id = ?').run(reporte.id || 'REP-' + Date.now());
            } else {
                console.warn('⚠️ [RED] Reporte fiscal no sincronizado: IP del maestro no configurada.');
            }
        } catch (errSync) {
            console.warn("⚠️ No se pudo sincronizar el reporte fiscal con el Maestro:", errSync.message);
        }

        return { success: true };
    } catch (error) {
        console.error("❌ Error al guardar reporte fiscal local:", error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('emitir-reporte-fiscal', async (event, comandosFallbacks, puerto) => {
    return new Promise((resolve) => {
        const rawPort = puerto || 'COM99';
        const portName = rawPort.toString().toUpperCase().startsWith('COM') ? rawPort.toString().toUpperCase() : `COM${rawPort}`;
        const port = new SerialPort({ path: portName, baudRate: 9600, autoOpen: false });
        port.on('error', (err) => { console.error('Error hardware atrapado en puerto serial:', err.message); });

        const comandos = Array.isArray(comandosFallbacks) ? comandosFallbacks : [comandosFallbacks];

        const closeAndResolve = (resultado) => {
            console.log(`[FISCAL-REPORTE] Resultado:`, resultado);
            if (port.isOpen) {
                port.close(() => resolve(resultado));
            } else {
                resolve(resultado);
            }
        };

        const STX = Buffer.from([0x02]);
        const ETX = Buffer.from([0x03]);

        let cmdIndex = 0;
        let retries = 0;
        const MAX_RETRIES = 3;
        let timeoutOperacion;
        let leyendoErrorNAK = false;
        let bufferRecepcion = "";

        port.open((err) => {
            if (err) return closeAndResolve({ success: false, msg: `No se pudo abrir ${portName}: ${err.message}` });

            console.log(`\n[FISCAL-REPORTE] 🚀 Iniciando reporte con ${comandos.length} comando(s) en ${portName}.`);

            const enviarComandoActual = () => {
                clearTimeout(timeoutOperacion);
                leyendoErrorNAK = false;
                bufferRecepcion = "";

                if (cmdIndex >= comandos.length) {
                    return closeAndResolve({ success: false, msg: `Todos los comandos de reporte fallaron.` });
                }

                const cmd = comandos[cmdIndex];
                console.log(`[FISCAL-REPORTE] 🔄 Intentando comando: ${cmd} (Intento ${retries + 1}/${MAX_RETRIES})`);

                const bufferComando = Buffer.from(cmd, 'latin1');
                const lrcByte = calcularLRC(bufferComando, ETX);
                const tramaFinal = Buffer.concat([STX, bufferComando, ETX, Buffer.from([lrcByte])]);

                port.write(tramaFinal, (err) => {
                    if (err) {
                        clearTimeout(timeoutOperacion);
                        return closeAndResolve({ success: false, msg: `Error de escritura: ${err.message}` });
                    }
                    console.log(`[FISCAL-REPORTE] 📤 Enviado -> ${cmd}`);
                });

                timeoutOperacion = setTimeout(() => {
                    console.error(`[FISCAL-REPORTE] ⚠️ Timeout con comando ${cmd}`);
                    retries = 0;
                    cmdIndex++;
                    enviarComandoActual();
                }, 25000);
            };

            port.on('data', (data) => {
                if (leyendoErrorNAK) {
                    bufferRecepcion += data.toString('latin1');
                    if (data.includes(0x03)) {
                        clearTimeout(timeoutOperacion);
                        const stxIndex = bufferRecepcion.indexOf('\x02');
                        const etxIndex = bufferRecepcion.indexOf('\x03');
                        if (stxIndex !== -1 && etxIndex !== -1 && etxIndex > stxIndex + 2) {
                            const sts1 = bufferRecepcion.charCodeAt(stxIndex + 1);
                            const sts2 = bufferRecepcion.charCodeAt(stxIndex + 2);

                            console.error(`[FISCAL-REPORTE] Estado impresora tras NAK:`);
                            console.error(`         STS1: 0x${sts1.toString(16).toUpperCase()} (${sts1})`);
                            console.error(`         STS2: 0x${sts2.toString(16).toUpperCase()} (${sts2})`);
                            console.error(`         RAW:`, Buffer.from(bufferRecepcion, 'latin1').toString('hex'));

                            const cmd = comandos[cmdIndex];
                            if (sts2 === 0x40 && retries < MAX_RETRIES - 1) {
                                retries++;
                                console.log(`[FISCAL-REPORTE] Rechazado (STS1=0x${sts1.toString(16)}, STS2=0x${sts2.toString(16)}). Reintentando en 2 seg...`);
                                setTimeout(() => enviarComandoActual(), 2000);
                            } else {
                                const errMsg = `Comando ${cmd} falló. STS1=0x${sts1.toString(16)}, STS2=0x${sts2.toString(16).toUpperCase()}`;
                                retries = 0;
                                cmdIndex++;
                                if (cmdIndex < comandos.length) {
                                    console.log(`[FISCAL-REPORTE] Probando siguiente comando...`);
                                    enviarComandoActual();
                                } else {
                                    closeAndResolve({ success: false, msg: errMsg });
                                }
                            }
                        } else {
                            retries = 0;
                            cmdIndex++;
                            enviarComandoActual();
                        }
                    }
                    return;
                }

                if (data.includes(0x06)) {
                    clearTimeout(timeoutOperacion);
                    const cmd = comandos[cmdIndex];
                    console.log(`[FISCAL-REPORTE] ✅ ACK recibido para: ${cmd}`);
                    closeAndResolve({ success: true, msg: `Comando ${cmd} ejecutado correctamente.` });
                } else if (data.includes(0x15)) {
                    clearTimeout(timeoutOperacion);
                    const cmd = comandos[cmdIndex];
                    console.error(`[FISCAL-REPORTE] ❌ NAK recibido para: ${cmd}. Solicitando código de error...`);
                    leyendoErrorNAK = true;
                    bufferRecepcion = "";
                    port.write(Buffer.from([0x05])); // ENQ
                    timeoutOperacion = setTimeout(() => {
                        console.error(`[FISCAL-REPORTE] Timeout esperando respuesta al ENQ post-NAK.`);
                        retries = 0;
                        cmdIndex++;
                        enviarComandoActual();
                    }, 3000);
                }
            });

            // Enviar el primer comando DIRECTAMENTE, sin ENQ previo (igual que emitir-tramas-hka)
            enviarComandoActual();
        });
    });
});

// ====================================================
// HANDLER ESPECIALIZADO PARA PROGRAMACIÃ“N DE MÃQUINA FISCAL
// ====================================================
ipcMain.handle('programar-maquina-fiscal', async (event, comandos, puerto) => {
    return new Promise((resolve) => {
        const rawPort = puerto || 'COM99';
        const portName = rawPort.toString().toUpperCase().startsWith('COM') ? rawPort.toString().toUpperCase() : `COM${rawPort}`;
        const port = new SerialPort({ path: portName, baudRate: 9600, autoOpen: false });
        port.on('error', (err) => { console.error('Error hardware atrapado en puerto serial:', err.message); });

        if (!Array.isArray(comandos) || comandos.length === 0) {
            return resolve({ success: false, msg: "No se proporcionaron comandos para programar." });
        }

        const STX = Buffer.from([0x02]);
        const ETX = Buffer.from([0x03]);

        const buildTrama = (cmd) => {
            const buf = Buffer.from(cmd, 'latin1');
            const lrc = calcularLRC(buf, ETX);
            return Buffer.concat([STX, buf, ETX, Buffer.from([lrc])]);
        };

        const closeAndResolve = (resultado) => {
            console.log(`[FISCAL-PROGRAMACION] Resultado:`, resultado);
            if (port.isOpen) {
                port.close(() => resolve(resultado));
            } else {
                resolve(resultado);
            }
        };

        const enviarComandoSequencial = (index) => {
            if (index >= comandos.length) {
                return closeAndResolve({ success: true, msg: "ProgramaciÃ³n completada exitosamente." });
            }

            const cmd = comandos[index];
            console.log(`[FISCAL-PROGRAMACION] ðŸ”„ Enviando: ${cmd} (${index + 1}/${comandos.length})`);
            const trama = buildTrama(cmd);

            let timeout = setTimeout(() => {
                port.removeAllListeners('data');
                closeAndResolve({ success: false, msg: `Timeout esperando respuesta al comando: ${cmd}` });
            }, 5000);

            port.once('data', (data) => {
                clearTimeout(timeout);
                if (data.includes(0x06)) {
                    console.log(`[FISCAL-PROGRAMACION] âœ… ACK para: ${cmd}`);
                    setTimeout(() => enviarComandoSequencial(index + 1), 200); // PequeÃ±a pausa entre comandos
                } else if (data.includes(0x15)) {
                    console.error(`[FISCAL-PROGRAMACION] âŒ NAK para: ${cmd}. Consultando motivo...`);
                    let errorBuffer = '';
                    const errorTimeout = setTimeout(() => {
                        port.removeAllListeners('data');
                        closeAndResolve({ success: false, msg: `NAK recibido en ${cmd}, sin respuesta de error detallada.` });
                    }, 2000);

                    port.once('data', (errData) => {
                        clearTimeout(errorTimeout);
                        errorBuffer = errData.toString('latin1');
                        const stxIdx = errorBuffer.indexOf('\x02');
                        const etxIdx = errorBuffer.indexOf('\x03');
                        if (stxIdx !== -1 && etxIdx !== -1 && etxIdx > stxIdx + 1) {
                            const sts2 = etxIdx > stxIdx + 2 ? errorBuffer.charCodeAt(stxIdx + 2) : 0x00;
                            if (sts2 === 0x40 || sts2 === 0x6A) {
                                console.log(`[FISCAL-PROGRAMACION] Comando ${cmd} rechazado o no soportado (STS2=0x${sts2.toString(16)}). Continuando...`);
                                setTimeout(() => enviarComandoSequencial(index + 1), 200);
                            } else {
                                closeAndResolve({ success: false, msg: `Error en impresora con ${cmd}. STS2=0x${sts2.toString(16).toUpperCase()}` });
                            }
                        } else {
                            closeAndResolve({ success: false, msg: `NAK recibido en ${cmd}.` });
                        }
                    });
                    port.write(Buffer.from([0x05])); // ENQ para pedir error
                } else {
                    closeAndResolve({ success: false, msg: `Respuesta desconocida al comando ${cmd}.` });
                }
            });

            port.write(trama, (err) => {
                if (err) {
                    clearTimeout(timeout);
                    closeAndResolve({ success: false, msg: `Error de escritura: ${err.message}` });
                }
            });
        };

        port.open((err) => {
            if (err) return closeAndResolve({ success: false, msg: `No se pudo abrir ${portName}: ${err.message}` });

            setTimeout(() => {
                enviarComandoSequencial(0);
            }, 500);
        });
    });
});

function calcularChecksum(trama) {
    let checksum = 0;
    for (let i = 0; i < trama.length; i++) {
        checksum = (checksum ^ trama.charCodeAt(i)) & 0xFF;
    }
    return checksum.toString(16).toUpperCase().padStart(4, '0');
}


function prepararPaquete(comando, campos = []) {
    const STX = '\x02';
    const ETX = '\x03';
    const FS = '\x1C'; 
    const SEQ = '\x20'; 

    let cuerpo = SEQ + comando;
    if (campos.length > 0) {
        cuerpo += FS + campos.join(FS);
    }

    const tramaParaCheck = cuerpo + ETX;
    const check = calcularChecksum(tramaParaCheck);
    return Buffer.from(STX + tramaParaCheck + check, 'ascii');
}
// ============================================================
// FUNCIÓN CENTRALIZADA DE IP — Única fuente de verdad para la
// IP del servidor maestro. Úsala en TODOS los lugares.
// ============================================================
function getIpMaestro() {
    try {
        const configLocal = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const esMaestro = (configLocal.isServer === true || configLocal.isServer === 'true');
        if (esMaestro) {
            return '127.0.0.1';
        }
        const ip = configLocal.serverIP;
        if (!ip || ip === 'localhost' || ip.trim() === '') {
            console.error('[RED] ❌ ERROR CRÍTICO: Esta PC está configurada como CLIENTE pero no tiene una IP de servidor válida.');
            console.error('[RED]    Verifica config.json → campo "serverIP" debe tener la IP real del servidor (ej: 192.168.1.100)');
            return null;
        }
        return ip.trim();
    } catch (e) {
        console.error('[RED] ❌ Error leyendo config.json para obtener IP del servidor:', e.message);
        return null;
    }
}

// Alias para compatibilidad con llamadas antiguas
function getIpServidor() {
    return getIpMaestro() || '127.0.0.1';
}

// Helper: llama al servidor maestro con reintentos automáticos
async function llamarMaestro(metodo, ruta, datos = null, opciones = {}) {
    const ip = getIpMaestro();
    if (!ip) {
        throw new Error('IP del servidor maestro no configurada. Verifica config.json → serverIP');
    }
    const url = `http://${ip}:3000${ruta}`;
    const timeout = opciones.timeout || 8000;
    const reintentos = opciones.reintentos !== undefined ? opciones.reintentos : 2;
    let ultimoError;
    for (let i = 0; i <= reintentos; i++) {
        try {
            const cfg = { timeout };
            const res = metodo === 'GET'
                ? await axios.get(url, cfg)
                : metodo === 'DELETE'
                    ? await axios.delete(url, cfg)
                    : await axios.post(url, datos, cfg);
            return res;
        } catch (err) {
            ultimoError = err;
            if (i < reintentos) {
                const espera = 1000 * (i + 1);
                console.warn(`[RED] ⚠️ Intento ${i + 1} fallido para ${url}. Reintentando en ${espera}ms...`);
                await new Promise(r => setTimeout(r, espera));
            }
        }
    }
    throw ultimoError;
}

ipcMain.handle('obtener-borradores-maestro', async (event, { sucursalId, companyId }) => {
    try {
        const ip = getIpServidor();
        const url = `http://${ip}:3000/api/maestro/obtener-borradores?sucursalId=${sucursalId}&companyId=${companyId}`;
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error("Error obteniendo borradores:", error.message);
        return [];
    }
});

ipcMain.handle('obtener-ip-maestro', () => {
    return getIpServidor(); 
});




// 2. Guardar Borrador
ipcMain.handle('guardar-borrador-maestro', async (event, datos) => {
    try {
        const ip = getIpServidor();
        const url = `http://${ip}:3000/api/maestro/guardar-borrador`;
        const response = await axios.post(url, datos);
        return response.data;
    } catch (error) {
        return { error: error.message };
    }
});

// 3. Eliminar Borrador
ipcMain.handle('eliminar-borrador-maestro', async (event, id) => {
    try {
        const ip = getIpServidor();
        const url = `http://${ip}:3000/api/maestro/eliminar-borrador/${id}`;
        const response = await axios.delete(url);
        return response.data;
    } catch (error) {
        return { error: error.message };
    }
});

let secuenciaHasar = 0x21; 

function obtenerSiguienteSecuencia() {
    secuenciaHasar++;
    if (secuenciaHasar > 0x7F) secuenciaHasar = 0x21;
    return String.fromCharCode(secuenciaHasar);
}

function fH(v, dec) {
    return parseFloat(v || 0).toFixed(dec);
}

function prepararPaqueteHasar(comando, campos = []) {
    const STX = '\x02';
    const ETX = '\x03';
    const PIPE = '|';
    const SEQ = obtenerSiguienteSecuencia();

    let trama = SEQ + comando;
    if (campos.length > 0) trama += PIPE + campos.join(PIPE);

    const cuerpoParaCheck = trama + ETX;
    let xor = 0;
    for (let i = 0; i < cuerpoParaCheck.length; i++) {
        xor ^= cuerpoParaCheck.charCodeAt(i);
    }
    
    // Checksum de 2 dÃ­gitos (Universal para Venezuela)
    const bcc = xor.toString(16).toUpperCase().padStart(2, '0');
    return Buffer.from(STX + cuerpoParaCheck + bcc, 'ascii');
}

// --- UTILIDADES MULTIMARCA ---

// Elimina acentos y eÃ±es (Vital para impresoras viejas)
function limpiarTexto(texto) {
    if (!texto) return "";
    return texto.normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9 ]/g, "")
        .toUpperCase();
}



function enviarConsulta(resolve) {
    console.log(`[FISCAL] âš ï¸ El puerto abriÃ³ bien. Saltando el saludo 0x05 porque el emulador exige tramas completas.`);
    console.log(`[FISCAL] âœ… Dando LUZ VERDE para probar la facturaciÃ³n real.`);
    
    // Le decimos al frontend que todo estÃ¡ OK para que nos deje facturar
    resolve({ success: true, msg: "Puerto abierto y listo para comandos" });
}

function enviarConsulta(resolve) {
    console.log(`[FISCAL] âš ï¸ El puerto abriÃ³ bien. Saltando el saludo 0x05 porque el emulador exige tramas completas.`);
    console.log(`[FISCAL] âœ… Dando LUZ VERDE para probar la facturaciÃ³n real.`);
    
    // Le decimos al frontend que todo estÃ¡ OK para que nos deje facturar
    resolve({ success: true, msg: "Puerto abierto y listo para comandos" });
}

// FunciÃ³n auxiliar para reportar logs al frontend
function reportarLogHKA(event, mensaje, esError = false) {
    if (event && event.sender) {
        event.sender.send('hka-auth-log', { mensaje, esError });
    }
}



// MODO DE facturacion HKA IMPRENTA DIGITAL "FACTURACION ELECTRÃ“NICA" - FASE 2: SincronizaciÃ³n y ValidaciÃ³n de NumeraciÃ³n

// ðŸŸ¢ FUNCIÃ“N 1: Consultar Ãºltimo nÃºmero y sincronizar con server.js
async function sincronizarUltimoNumero(event, tipoDoc = "01") {
    try {
        reportarLogHKA(event, `Consultando Ãºltimo correlativo (${tipoDoc}) en la nube...`);
        
        const response = await axios.post(`${hkaCredentials.baseUrl}/api/UltimoDocumento`, 
            { serie: "", tipoDocumento: tipoDoc },
            { headers: { 'Authorization': `Bearer ${apiToken}` } }
        );

        if (response.data && response.data.numeroDocumento !== undefined) {
            const ultimoNro = response.data.numeroDocumento;
            
            // Enviamos el dato a server.js para actualizar la DB local
            await axios.post(LOCAL_SERVER_URL, {
                tipo: 'ELECTRONICA',
                ultimo_numero: ultimoNro
            });

            reportarLogHKA(event, `SincronizaciÃ³n exitosa: Ãšltima factura en nube #${ultimoNro}. DB Local actualizada.`);
        }
    } catch (error) {
        reportarLogHKA(event, `Error sincronizando nÃºmeros: ${error.message}`, true);
    }
}

// ðŸŸ¢ FUNCIÃ“N 2: Verificar rangos disponibles (ConsultaNumeraciones)
async function verificarRangosDisponibles(event) {
    try {
        reportarLogHKA(event, "Validando disponibilidad de correlativos en el portal...");
        
        const response = await axios.post(`${hkaCredentials.baseUrl}/api/ConsultaNumeraciones`, 
            { serie: "", tipoDocumento: "01" },
            { headers: { 'Authorization': `Bearer ${apiToken}` } }
        );

        if (response.data && response.data.numeraciones) {
            const rango = response.data.numeraciones[0]; // Tomamos el primer rango activo
            reportarLogHKA(event, `Rangos validados: Desde ${rango.desde} hasta ${rango.hasta}. Estado: ${rango.estado}`);
        }
    } catch (error) {
        reportarLogHKA(event, `Error validando rangos: ${error.message}`, true);
    }
}

// ðŸŸ¢ INTERCEPCIÃ“N DEL AUTH EXITOSO PARA DISPARAR FASE 2
ipcMain.on('ejecutar-auth-hka', async (event) => {
    // Primero hacemos el login (Fase 1)
    await iniciarAuthWorkerHKA(event); 
    
    // Si tenemos token, disparamos la Fase 2 automÃ¡ticamente
    if (apiToken) {
        await sincronizarUltimoNumero(event, "01"); // Sincroniza el nÃºmero
        await verificarRangosDisponibles(event);    // Valida que hay nÃºmeros libres
    }
});

// --- FASE 3: EMISIÃ“N DE FACTURA ELECTRÃ“NICA ---
ipcMain.handle('emitir-factura-hka', async (event, facturaJSON) => {
    try {
        if (!apiToken) throw new Error("No hay token de autenticaciÃ³n activo.");

        // 1. Ubicar la raÃ­z del documento
        const doc = facturaJSON.DocumentoElectronico || facturaJSON.documentoElectronico;
        if (!doc) throw new Error("Estructura raÃ­z 'DocumentoElectronico' no encontrada en el JSON.");

        const nroDoc = doc.Encabezado.IdentificacionDocumento.NumeroDocumento;
        
        // CORRECCIÃ“N: Usamos TotalesRetencion
        console.log(`ðŸš€ ENVIANDO A TFHKA - FACTURA #${nroDoc}`);
        console.log("ðŸ“¦ payload completo:", JSON.stringify(facturaJSON, null, 2)); 
        
        reportarLogHKA(event, `Enviando factura #${nroDoc} a fiscalizaciÃ³n...`);

        // 2. EnvÃ­o a la API
        const response = await axios.post(`${HKA_BASE_URL}/api/Emision`, facturaJSON, {
            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' }
        });

        const data = response.data; // Axios guarda la respuesta en .data

        // 3. ValidaciÃ³n
        if (data && [0, 200, '0', '200'].includes(data.codigo)) {
            reportarLogHKA(event, "âœ… Factura aceptada por The Factory HKA.");
            return { exito: true, data };
        } 
        
        // 4. Manejo de errores de negocio (HKA devolviÃ³ algo pero no fue Ã©xito)
        const errorMsg = `${data.mensaje || "Error desconocido"}`;
        console.error("âŒ HKA rechazÃ³ la factura:", data);
        reportarLogHKA(event, `âŒ Error de EmisiÃ³n HKA: ${errorMsg}`, true);
        return { exito: false, error: errorMsg };

    } catch (error) {
        // Axios lanza error si el status code no es 2xx
        let detalle = error.message;
        if (error.response) {
            detalle = JSON.stringify(error.response.data);
            console.error("âŒ Respuesta completa de HKA:", error.response.data);
        }
        
        reportarLogHKA(event, `ðŸ”¥ Fallo de conexiÃ³n HKA: ${detalle}`, true);
        return { exito: false, error: detalle };
    }
});

async function createSplashScreen() {
    splash = new BrowserWindow({
        width: 800, // Ajusta al tamaÃ±o de tu video
        height: 500, 
        transparent: true, 
        icon: path.join(__dirname, 'assets/icono_redondeado.ico'),
        frame: false, 
        alwaysOnTop: true,
        resizable: false,
        center: true,
        webPreferences: {
            nodeIntegration: false,
            // IMPORTANTE: Esto permite que el video suene solo al abrir
            autoplayPolicy: 'no-user-gesture-required' 
        }
    });

    // AsegÃºrate de que el archivo estÃ© en la raÃ­z o en /public
    splash.loadFile('splash.html'); 
}

async function enviarDatosAXeon(datos) { 
    try {
        console.log("ðŸ“¡ Intentando sincronizar con Xeon...");
        
        // Se mantiene la URL con HTTPS para evitar bloqueos del tÃºnel de Cloudflare
        const urlFinal = `https://configuracioncajera.nexusposgobal.com/api/xeon/registrar-entrada`;

        // ðŸ”¥ CORRECCIÃ“N CRUCIAL: Enviamos 'datos' directamente. 
        // configuracion.html ya estructurÃ³ el objeto con companyId, tipo_configuracion y payload
        const respuesta = await axios.post(urlFinal, datos, { 
            timeout: 15000,
            maxRedirects: 5 
        });

        console.log("ðŸ“¥ Respuesta del Xeon:", respuesta.data);

        if (respuesta.data.exito) {
            console.log(`â˜ï¸ SincronizaciÃ³n Exitosa: ${respuesta.data.id_referencia}`);
            return { success: true, ref: respuesta.data.id_referencia };
        } else {
            console.error("âŒ El Xeon rechazÃ³ los datos:", respuesta.data.error);
            return { success: false, error: respuesta.data.error };
        }
    } catch (error) {
        if (error.response) {
            console.error("ðŸ”¥ Error de Respuesta Xeon:", error.response.status);
            return { success: false, error: `Error ${error.response.status}: AsegÃºrate de usar HTTPS en el cÃ³digo.` };
        } else if (error.request) {
            console.error("ðŸ“¡ Error de Red (Sin respuesta):", error.message);
            return { success: false, error: "Servidor no responde. Verifica el estado del tÃºnel." };
        } else {
            console.error("âš ï¸ Error ConfiguraciÃ³n Axios:", error.message);
            return { success: false, error: error.message };
        }
    }
}

function encryptClave(text) {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    // Guardamos el vector y el texto encriptado unidos por ":"
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptClave(text) {
    try {
        let textParts = text.split(':');
        let iv = Buffer.from(textParts.shift(), 'hex');
        let encryptedText = Buffer.from(textParts.join(':'), 'hex');
        let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        return "ERROR_DESCIFRADO";
    }
}

async function createWindow() {

    sembrarDatosIniciales();
    await asegurarHistorialInicial();
    await rellenarHuecosHistorial();

    if (app.isPackaged) {
        Menu.setApplicationMenu(null);
    }

    win = new BrowserWindow({
        width: 1000,
        height: 700,
        frame: false,
        resizable: false,
        maximizable: false,
        show: false, 
        icon: path.join(__dirname, 'assets/icono_redondeado.ico'),
        backgroundColor: '#2e2c29',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            spellcheck: true,
            devTools: true
        }
    });

    // --- REVISIÓN Y DESPLIEGUE DE CONSOLA AL INICIALIZAR ---
    let showConsoleEnabled = (config.showConsole === true || config.showConsole === 'true' || config.mostrarConsola === true || config.mostrarConsola === 'true');
    if (!showConsoleEnabled) {
        try {
            const row = db.prepare("SELECT valor FROM configuracion WHERE clave IN ('showConsole', 'mostrarConsola')").get();
            if (row && (row.valor === 'true' || row.valor === true)) {
                showConsoleEnabled = true;
            }
        } catch(e) {}
    }

    if (showConsoleEnabled) {
        win.webContents.openDevTools({ mode: 'detach' });
        console.log("🛠️ Consola de desarrollo desplegada automáticamente al iniciar.");
    }

    async function ejecutarScrapingYGuardar() {
    const tasaBcv = await obtenerTasaDesdeWeb(); // Tu funciÃ³n actual que usa axios/cheerio
    
    if (tasaBcv) {
        const hoy = new Date().toISOString().split('T')[0]; // Formato YYYY-MM-DD
        
        // GUARDADO AUTOMÃTICO: Cada vez que el sistema hace scraping, "siembra" el dato
        db.prepare(`
            INSERT OR IGNORE INTO historial_tasas (fecha, valor) 
            VALUES (?, ?)
        `).run(hoy, tasaBcv);
        
        return tasaBcv;
    }
}

async function asegurarHistorialInicial() {
    try {
        // 1. Verificar si ya tenemos datos
        const conteo = db.prepare("SELECT COUNT(*) as total FROM historial_tasas").get();
        
        if (conteo.total === 0) {
            console.log("ðŸŒ± Nueva instalaciÃ³n detectada. Sincronizando historial inicial de red...");
            
            // 2. Llamar a la API gratuita para el BCV
            // Esta API devuelve el historial de los Ãºltimos dÃ­as
            const response = await axios.get('https://ve.dolarapi.com/v1/dolares/bcv');
            const data = response.data;

            if (data && data.fecha) {
                const hoy = new Date().toISOString().split('T')[0];
                const valor = data.promedio; // O el valor que devuelva la API

                // Guardamos al menos el valor actual como punto de partida
                db.prepare(`INSERT OR IGNORE INTO historial_tasas (fecha, valor, fuente) VALUES (?, ?, 'API_INICIAL')`)
                  .run(hoy, valor);
                
                // NOTA: Como la mayorÃ­a de APIs gratis solo dan el "Hoy", 
                // el rellenador de huecos que ya hicimos harÃ¡ el resto:
                rellenarHuecosHistorial(); 
                
                console.log("âœ… Historial inicial sincronizado.");
            }
        }
    } catch (error) {
        console.error("âŒ No se pudo sincronizar el historial inicial:", error.message);
    }
}

async function rellenarHuecosHistorial() {
    console.log("ðŸ” Nexus POS: Verificando integridad del historial...");
    try {
        const ultimaTasa = db.prepare("SELECT valor FROM historial_tasas ORDER BY fecha DESC LIMIT 1").get();
        if (!ultimaTasa) return;

        for (let i = 1; i <= 7; i++) {
            let d = new Date();
            d.setDate(d.getDate() - i);
            let fechaIso = d.toISOString().split('T')[0];

            const existe = db.prepare("SELECT valor FROM historial_tasas WHERE fecha = ?").get(fechaIso);
            if (!existe) {
                db.prepare("INSERT INTO historial_tasas (fecha, valor, fuente) VALUES (?, ?, 'RELLENO')")
                  .run(fechaIso, ultimaTasa.valor);
                console.log(`âœ… DÃ­a ${fechaIso} rellenado.`);
            }
        }
    } catch (e) { console.error(e); }
}

function sembrarDatosIniciales() {
    const datosBCV = [
        {f: '2026-03-12', v: 440.97},
        {f: '2026-03-11', v: 438.21},
        {f: '2026-03-10', v: 438.21},
        {f: '2026-03-09', v: 433.17},
        {f: '2026-03-08', v: 431.01},
        {f: '2026-03-07', v: 431.01},
        {f: '2026-03-06', v: 431.01}
    ];

    try {
        // ðŸ”¥ MEJORA: Definimos la transacciÃ³n para insertar todo en un solo bloque
        const insert = db.prepare("INSERT OR IGNORE INTO historial_tasas (fecha, valor, fuente) VALUES (?, ?, 'BCV')");
        
        const sembrarTodo = db.transaction((datos) => {
            for (const d of datos) insert.run(d.f, d.v);
        });

        sembrarTodo(datosBCV);
        console.log("ðŸŒ± Datos histÃ³ricos sembrados correctamente.");
    } catch (error) {
        console.error("âš ï¸ Error al sembrar datos (Base de datos ocupada):", error.message);
    }
}


win.webContents.on('context-menu', (e) => e.preventDefault());
win.loadFile('public/index.html');

win.once('ready-to-show', () => {
    setTimeout(() => {
        if (splash && !splash.isDestroyed()) splash.close();
        
        // REGLA INFALIBLE: Solo mostramos el login si no se ha saltado a la ventana principal
        if (win && !win.isDestroyed() && !sistemaPrincipalAbierto) {
            win.center();
            win.show();
        }
    }, 7000); 
});
}


ipcMain.handle('obtener-claves-admin-maestro', async (event, companyId) => {
    try {
        const configPath = require('path').join(__dirname, 'config.json');
        let API_BASE_URL = 'http://localhost:3000';
        if (require('fs').existsSync(configPath)) {
            const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
            API_BASE_URL = config.API_BASE_URL || API_BASE_URL;
        }
        
        // Se usa fetch nativo de Node/Electron
        const res = await fetch(`${API_BASE_URL}/api/maestro/obtener-claves-admin/${companyId}`);
        if (res.ok) {
            const data = await res.json();
            return data.map(c => {
                c.plainCode = decryptClave(c.encryptedCode);
                return c;
            });
        }
        return [];
    } catch (e) {
        console.error('Error obtener-claves-admin-maestro:', e);
        return [];
    }
});

ipcMain.handle('leer-config-maestra', async (event, clave) => {
    try {
        const configPath = require('path').join(__dirname, 'config.json');
        let API_BASE_URL = 'http://localhost:3000';
        if (require('fs').existsSync(configPath)) {
            const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
            API_BASE_URL = config.API_BASE_URL || API_BASE_URL;
        }
        
        // Se usa fetch nativo de Node/Electron
        const res = await fetch(`${API_BASE_URL}/api/maestro/configuracion/${clave}`);
        if (res.ok) {
            const data = await res.json();
            return data;
        }
        return null;
    } catch (e) {
        console.error('Error leer-config-maestra:', e);
        return null;
    }
});

ipcMain.handle('eliminar-clave-admin-maestro', async (event, id) => {
    try {
        const configPath = require('path').join(__dirname, 'config.json');
        let API_BASE_URL = 'http://localhost:3000';
        if (require('fs').existsSync(configPath)) {
            const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
            API_BASE_URL = config.API_BASE_URL || API_BASE_URL;
        }
        
        // Se usa fetch nativo de Node/Electron
        const res = await fetch(`${API_BASE_URL}/api/maestro/eliminar-clave-admin/${id}`, {
            method: 'DELETE'
        });
        if (res.ok) {
            const data = await res.json();
            return data;
        }
        const errText = await res.text();
        return { error: `Error del servidor: HTTP ${res.status} - ${errText}` };
    } catch (e) {
        console.error('Error eliminar-clave-admin-maestro:', e);
        return { error: e.message };
    }
});

ipcMain.handle('guardar-clave-admin-maestro', async (event, datos) => {
    try {
        const configPath = require('path').join(__dirname, 'config.json');
        let API_BASE_URL = 'http://localhost:3000';
        if (require('fs').existsSync(configPath)) {
            const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
            API_BASE_URL = config.API_BASE_URL || API_BASE_URL;
        }
        
        // Se usa fetch nativo de Node/Electron
        
        // Encriptar clave antes de enviar al Maestro
        if (datos.plainCode) {
            datos.encryptedCode = encryptClave(datos.plainCode);
            delete datos.plainCode; // No enviar la contraseña plana
        }
        
        const res = await fetch(`${API_BASE_URL}/api/maestro/guardar-clave-admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(datos)
        });
        if (res.ok) {
            const data = await res.json();
            return data;
        }
        return { error: 'Error del servidor: HTTP ' + res.status };
    } catch (e) {
        console.error('Error guardar-clave-admin-maestro:', e);
        return { error: e.message };
    }
});

ipcMain.handle('guardar-config-maestra', async (event, datos) => {
    try {
        const configPath = require('path').join(__dirname, 'config.json');
        let API_BASE_URL = 'http://localhost:3000';
        if (require('fs').existsSync(configPath)) {
            const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
            API_BASE_URL = config.API_BASE_URL || API_BASE_URL;
        }
        
        // Se usa fetch nativo de Node/Electron
        const res = await fetch(`${API_BASE_URL}/api/maestro/configuracion`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(datos)
        });
        if (res.ok) {
            const data = await res.json();
            return data;
        }
        return { error: 'Error del servidor: HTTP ' + res.status };
    } catch (e) {
        console.error('Error guardar-config-maestra:', e);
        return { error: e.message };
    }
});

ipcMain.handle('obtener-configuracion-fiscal', async () => {
    try {
        const row = db.prepare('SELECT * FROM configuracion_fiscal WHERE id = 1').get();
        return row || null;
    } catch (err) {
        console.error('Error al obtener la configuración fiscal:', err);
        return null;
    }
});

ipcMain.handle('guardar-configuracion-fiscal', async (event, datos) => {
    try {
        const row = db.prepare('SELECT id FROM configuracion_fiscal WHERE id = 1').get();
        if (row) {
            const updateQ = `UPDATE configuracion_fiscal SET 
                iva_exento = ?, iva_general = ?, iva_reducido = ?, 
                iva_anadida = ?, igtf_porcentaje = ?, fecha_actualizacion = CURRENT_TIMESTAMP
                WHERE id = 1`;
            db.prepare(updateQ).run(datos.iva_exento||0, datos.iva_general||16, datos.iva_reducido||8, datos.iva_anadida||31, datos.igtf_porcentaje||3);
        } else {
            const insertQ = `INSERT INTO configuracion_fiscal (id, iva_exento, iva_general, iva_reducido, iva_anadida, igtf_porcentaje)
                VALUES (1, ?, ?, ?, ?, ?)`;
            db.prepare(insertQ).run(datos.iva_exento||0, datos.iva_general||16, datos.iva_reducido||8, datos.iva_anadida||31, datos.igtf_porcentaje||3);
        }
        return { success: true };
    } catch (err) {
        console.error('Error guardando config fiscal:', err);
        return { success: false, msg: err.message };
    }
});
app.whenReady().then(async () => {
    try {
        if (session.defaultSession) {
            await session.defaultSession.clearCache();
            console.log("ðŸ§¹ CachÃ© de la aplicaciÃ³n limpiada automÃ¡ticamente en el arranque.");
        }
    } catch (errCache) {
        console.error("âš ï¸ Error al limpiar el cachÃ© en el arranque:", errCache.message);
    }
    createSplashScreen(); // 1. Primero mostramos el video
    createWindow();       // 2. Preparamos la app en segundo plano
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});



ipcMain.handle('extraer-reporte-fiscal', async (event, tipoReporte, puerto) => {
    return new Promise((resolve) => {
        const rawPort = puerto || 'COM99';
        const portName = rawPort.toString().toUpperCase().startsWith('COM') ? rawPort.toString().toUpperCase() : `COM${rawPort}`;
        const port = new SerialPort({ path: portName, baudRate: 9600, autoOpen: false });
        
        let bufferRecepcion = "";
        let timeoutEspera;

        const closeAndResolve = (resultado) => {
            if (port.isOpen) {
                port.close(() => resolve(resultado));
            } else {
                resolve(resultado);
            }
        };

        port.open((err) => {
            if (err) return closeAndResolve({ success: false, msg: `No se pudo abrir ${portName}` });

            port.on('data', (data) => {
                bufferRecepcion += data.toString('latin1');
                if (data.includes(0x03) || bufferRecepcion.includes('\x03')) {
                    clearTimeout(timeoutEspera);
                    
                    let dataLimpia = bufferRecepcion;
                    try {
                        if (bufferRecepcion.includes('\x02') && bufferRecepcion.includes('\x03')) {
                            dataLimpia = bufferRecepcion.split('\x02')[1].split('\x03')[0];
                        }
                    } catch (e) {}

                    closeAndResolve({ 
                        success: true, 
                        data: {
                            rawData: dataLimpia,
                            numeroZ: "N/A",
                            ultimaFactura: "N/A",
                            fechaEmision: new Date().toISOString().split('T')[0],
                            horaEmision: new Date().toTimeString().split(' ')[0]
                        } 
                    });
                }
            });

            const comando = 'U0' + tipoReporte;
            const STX = Buffer.from([0x02]);
            const ETX = Buffer.from([0x03]);
            
            let lrc = 0;
            const bufCmd = Buffer.from(comando, 'latin1');
            for(let i=0; i<bufCmd.length; i++) lrc ^= bufCmd[i];
            lrc ^= 0x03;
            
            const trama = Buffer.concat([STX, bufCmd, ETX, Buffer.from([lrc])]);

            timeoutEspera = setTimeout(() => {
                closeAndResolve({ success: false, msg: "Timeout esperando extraccion del reporte " + tipoReporte });
            }, 5000);

            port.write(trama);
        });
    });
});

// --- HANDLERS RECUPERADOS: SALIDAS Y EMPAQUES ---
ipcMain.handle('obtener-empaque-por-producto', async (event, productId) => {
    try {
        const query = "SELECT * FROM unidades_empaque WHERE product_id = ?";
        return db.prepare(query).all(productId);
    } catch (e) {
        console.error("? Error obtener empaque:", e);
        return [];
    }
});

ipcMain.handle('obtener-unidades-empaque-local', async (event, companyId) => {
    try {
        const query = "SELECT * FROM unidades_empaque WHERE company_id = ?";
        return db.prepare(query).all(companyId);
    } catch (e) {
        console.error("Error obtener unidades empaque:", e);
        return [];
    }
});

ipcMain.handle('guardar-unidad-empaque-local', async (event, datos) => {
    try {
        const id = datos.id || Date.now().toString();
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO unidades_empaque 
            (id, company_id, product_id, nombre_unidad, tipo_medida, factor_cantidad, estado_sync, fecha_modificacion)
            VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now', 'localtime'))
        `);
        stmt.run(
            id, 
            datos.company_id || datos.companyId, 
            datos.product_id || datos.productId, 
            datos.nombre_unidad || datos.nombre, 
            datos.tipo_medida || 'Unidades', 
            datos.factor_cantidad || datos.factor || 1.0
        );
        return { success: true, id };
    } catch (e) {
        console.error("Error guardar unidad empaque:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('eliminar-unidad-empaque-local', async (event, id) => {
    try {
        db.prepare("DELETE FROM unidades_empaque WHERE id = ?").run(id);
        return { success: true };
    } catch (e) {
        console.error("Error eliminar unidad empaque:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('guardar-salida-local', async (event, salida) => {
    try {
        const id = salida.id || Date.now().toString();
        const branchId = salida.branchId || salida.sucursalId || '0';
        const unidad = salida.unidad || 'UN';
        const motivo = salida.motivo || 'Salida';
        const observacion = salida.observacion || '';
        const usuarioId = salida.usuarioId || 'admin';
        const estado_sync = salida.estado_sync || 0;

        const query = "INSERT INTO salidas_inventario (id, company_id, branch_id, product_id, cantidad, unidad, motivo, observacion, usuario_id, estado_sync) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        
        db.prepare(query).run(
            id,
            salida.companyId,
            branchId,
            salida.productId,
            salida.cantidad,
            unidad,
            motivo,
            observacion,
            usuarioId,
            estado_sync
        );

        return { success: true };
    } catch (e) {
        console.error("? Error guardar salida local:", e);
        return { success: false, message: e.message };
    }
});

ipcMain.handle('obtener-salidas-local', async (event, filtro) => {
    try {
        let query = "SELECT * FROM salidas_inventario WHERE company_id = ?";
        const params = [filtro.companyId];

        if (filtro.branchId) {
            query += " AND branch_id = ?";
            params.push(filtro.branchId);
        }

        query += " ORDER BY rowid DESC LIMIT 200";

        return db.prepare(query).all(params);
    } catch (e) {
        console.error("? Error obtener salidas:", e);
        return [];
    }
});
