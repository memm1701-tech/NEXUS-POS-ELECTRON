const { app, BrowserWindow, ipcMain, Menu } = require('electron');
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

// --- NUEVA LÓGICA: Auto-crear archivo si no existe ---
if (!fs.existsSync(envPath)) {
    const contenidoInicial = 
`SERVER_IP=68.168.218.147
SERVER_PORT=4010
respaldo_datos=false
NEXUS_PLAN=SIN_PLAN`;

    fs.writeFileSync(envPath, contenidoInicial, 'utf8');
    console.log("🆕 ARCHIVO .ENV CREADO AUTOMÁTICAMENTE EN:", envPath);
}

// Cargar las variables de entorno (ahora estamos seguros de que el archivo siempre existe)
require('dotenv').config({ path: envPath });
console.log("✅ CONFIGURACIÓN EXTERNA CARGADA DESDE:", envPath);
console.log("🌐 IP DEL SERVIDOR:", process.env.SERVER_IP || 'No configurada (Modo Local Aisado)');

// Puente para el Frontend
ipcMain.handle('get-config', () => {
    return {
        serverIp: process.env.SERVER_IP || '',
        serverPort: process.env.SERVER_PORT || 4010,
        respaldo_datos: process.env.respaldo_datos === 'true' 
    };
});

const configPath = path.join(dbDir, 'config.json');
let config = { 
    isServer: false, 
    serverIP: 'localhost', 
    allowNoStock: false, 
    geminiApiKey: "AIzaSyAPKpaQrze48wBpt2CwXxGDvATb8lgYpFo" 
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
    console.log(`\n=========================================================`);
    console.log(`💻 [NEXUS NODE] Base de Datos Local: ${dbPath}`);
    console.log(`👑 [NEXUS MASTER] Iniciando Cerebro Maestro: ${serverDbPath}`);

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
            console.log("✅ [NEXUS MASTER] Servidor Maestro ejecutándose correctamente.");
        });

        cerebroProcess.on('error', (err) => {
            console.error("❌ [NEXUS MASTER] Error al arrancar:", err.message);
        });
        if (app) {
            app.on('before-quit', () => {
                console.log("🛑 Apagando Servidor Maestro...");
                cerebroProcess.kill();
            });
        }

    } catch (error) {
        console.error("❌ Fallo crítico al intentar automatizar server.js:", error);
    }
    console.log(`=========================================================\n`);
}



let win;   
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
        const prefijo = esError ? "❌ [AUTH-HKA ERROR]:" : "ℹ️ [AUTH-HKA INFO]:";
        console[esError ? 'error' : 'log'](`${prefijo} ${mensaje}`);
        
        if (event && event.sender) {
            event.sender.send('hka-auth-log', { mensaje, esError });
        }
    };

    try {
        if (!credentials || !credentials.usuario || !credentials.clave) {
            return enviarLogAlFrontend("Faltan credenciales del cliente para la API.", true);
        }

        enviarLogAlFrontend(`Iniciando autenticación para el usuario: ${credentials.usuario}...`);

        
        const response = await axios.post(`${HKA_BASE_URL}/api/Autenticacion`, {
            usuario: credentials.usuario,
            clave: credentials.clave
        });

        if (response.data.codigo === 0 || response.data.token) {
            apiToken = response.data.token;
            tokenExpiration = new Date(response.data.expiracion);
            
            enviarLogAlFrontend(`Éxito: Token obtenido. Expira: ${tokenExpiration.toLocaleString()}`);
            
            if (global.servidorLocal) {
                global.servidorLocal.setHkaToken(apiToken);
                enviarLogAlFrontend("Token sincronizado con el núcleo de Nexus POS.");
            }
        } else {
            enviarLogAlFrontend(`Respuesta HKA: Código ${response.data.codigo} - ${response.data.mensaje}`, true);
        }
    } catch (error) {
        enviarLogAlFrontend(`Fallo de conexión con The Factory: ${error.message}`, true);
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

            -- 💵 Índices para Movimientos de Caja (Ingresos/Gastos)
            CREATE INDEX IF NOT EXISTS idx_movimientos_cierre 
            ON movimientos_caja_locales(company_id, tipo, estado_cierre);

            -- 🤝 Índices para Cuentas por Cobrar (Créditos)
            CREATE INDEX IF NOT EXISTS idx_cxc_cliente ON cuentas_por_cobrar(cliente_rif, estado);
        `);
        console.log("⚡ Índices de base de datos SQLite verificados y optimizados.");
    } catch (error) {
        console.error("⚠️ Error creando los índices:", error.message);
    }
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS usuarios_locales (
            uid TEXT PRIMARY KEY,
            email TEXT UNIQUE,
            role TEXT,
            companyId TEXT,
            branchId TEXT,
            company_data TEXT,
            last_login DATETIME
        );
    `);

db.exec(`
    CREATE TABLE IF NOT EXISTS movimientos_caja_locales (
        id TEXT PRIMARY KEY,
        tipo TEXT,           -- 'INGRESO' o 'GASTO'
        concepto TEXT,
        monto REAL,          -- Monto en Bs para el cuadre
        monto_usd REAL,      -- Monto referencial en Divisa
        metodo_pago TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
        cashier_id TEXT,
        company_id TEXT,
        branch_id TEXT,
        estado_cierre INTEGER DEFAULT 0 -- 0: Pendiente para el Z, 1: Cerrado
    );
`);

db.exec(`
        CREATE TABLE IF NOT EXISTS pagos_moviles_locales (
            id TEXT PRIMARY KEY,
            venta_id TEXT,
            numero_factura TEXT,
            banco_receptor TEXT,
            referencia TEXT,
            telefono_origen TEXT,
            monto REAL,
            fecha_pago DATETIME,
            company_id TEXT,
            branch_id TEXT,
            cashier_id TEXT,
            estado_cierre INTEGER DEFAULT 0
        );
    `);

db.exec(`
        CREATE TABLE IF NOT EXISTS claves_admin_locales (
            id TEXT PRIMARY KEY,
            ownerName TEXT,
            encryptedCode TEXT,
            company_id TEXT,
            created_by TEXT,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    db.exec(`
    CREATE TABLE IF NOT EXISTS productos_locales (
        id TEXT PRIMARY KEY,
        company_id TEXT,
        branch_id TEXT,
        codigo TEXT,
        nombre TEXT,
        precio REAL,
        precio_compra REAL DEFAULT 0,
        porcentaje_ganancia REAL DEFAULT 0,
        categoria TEXT,
        status INTEGER,
        imagen TEXT,
        datos_json TEXT,
        estado_sync INTEGER DEFAULT 0,
        fecha_modificacion DATETIME
    );
`);


    db.exec(`
    CREATE TABLE IF NOT EXISTS categorias_locales (
        id TEXT PRIMARY KEY,           
        company_id TEXT,               
        nombre TEXT,                   
        estado_sync INTEGER DEFAULT 0, 
        fecha_modificacion DATETIME
    );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS correlativos (
    tipo TEXT PRIMARY KEY, 
    ultimo_numero INTEGER DEFAULT 0,
    prefijo TEXT DEFAULT ''
  )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS clientes_locales (
        rif TEXT PRIMARY KEY,
        company_id TEXT,
        nombre TEXT,
        direccion TEXT,
        telefono TEXT,
        correo TEXT,
        datos_json TEXT,
        es_contribuyente_especial INTEGER DEFAULT 0,
        estado_sync INTEGER DEFAULT 0,
        fecha_modificacion DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

    db.exec(`
    CREATE TABLE IF NOT EXISTS configuracion (
        clave TEXT PRIMARY KEY,
        valor TEXT,
        fecha_actualizacion DATETIME
    );
`);


    db.exec(`
        CREATE TABLE IF NOT EXISTS historial_tasas (
            fecha DATE PRIMARY KEY, 
            valor DECIMAL(18, 8) NOT NULL,
            fuente TEXT DEFAULT 'BCV'
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS ventas_locales (
            id TEXT PRIMARY KEY,
            company_id TEXT,
            branch_id TEXT,
            cashier_id TEXT,
            numero_factura TEXT,
            numero_control TEXT,
            cliente_nombre TEXT,
            cliente_rif TEXT,
            monto_exento REAL DEFAULT 0,
            base_imponible REAL DEFAULT 0,
            monto_iva REAL DEFAULT 0,
            total_iva REAL DEFAULT 0,
            monto_igtf REAL DEFAULT 0,
            monto_total REAL DEFAULT 0,
            tasa_bcv REAL DEFAULT 1,
            metodo_pago TEXT,
            datos_json TEXT,
            estado_sync INTEGER DEFAULT 0,
            fecha_emision DATETIME DEFAULT CURRENT_TIMESTAMP,
            estado_cierre INTEGER DEFAULT 0,
            es_nota_credito INTEGER DEFAULT 0,
            es_nota_debito INTEGER DEFAULT 0,
            factura_afectada TEXT,
            monto_factura_afectada REAL,
            fecha_factura_afectada TEXT,
            comprobante_retencion_id TEXT DEFAULT NULL
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS cuentas_por_cobrar (
            id TEXT PRIMARY KEY,
            company_id TEXT,
            branch_id TEXT,
            cliente_rif TEXT,
            cliente_nombre TEXT,
            monto_deuda REAL,
            monto_pagado REAL DEFAULT 0,
            estado TEXT DEFAULT 'PENDIENTE', 
            fecha_emision DATETIME DEFAULT CURRENT_TIMESTAMP,
            venta_id TEXT
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operacion TEXT,
            tabla TEXT,
            datos TEXT,
            fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    db.exec(`
    CREATE TABLE IF NOT EXISTS inventario_sucursales (
        producto_id TEXT,
        sucursal_id TEXT,
        company_id TEXT,
        stock REAL DEFAULT 0,
        estado_sync INTEGER DEFAULT 0,
        fecha_modificacion DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (producto_id, sucursal_id)
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS cierres_caja_locales (
        id TEXT PRIMARY KEY,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
        company_id TEXT,
        branch_id TEXT,
        cashier_id TEXT,
        total_ventas_bs REAL,
        total_ventas_usd REAL,
        total_gastos_bs REAL,
        total_gastos_usd REAL,
        total_ingresos_bs REAL,
        total_diferencia_bs REAL,
        total_diferencia_usd REAL,
        detalle_pagos_json TEXT, -- Aquí guardamos la conciliación completa
        estado_sync INTEGER DEFAULT 0
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS unidades_empaque (
        id TEXT PRIMARY KEY,
        company_id TEXT,
        product_id TEXT,
        nombre_unidad TEXT, -- Ej: 'Bulto', 'Cesta'
        tipo_medida TEXT,   -- Ej: 'Kilos', 'Unidades'
        factor_cantidad REAL, -- Ej: 24.0
        estado_sync INTEGER DEFAULT 0,
        fecha_modificacion DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS comprobantes_retencion (
        id TEXT PRIMARY KEY,
        datos_json TEXT NOT NULL,
        fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP,
        estatus TEXT DEFAULT 'EMITIDO'
    );
`);



        db.prepare(`
            CREATE TABLE IF NOT EXISTS sucursales (
                id TEXT PRIMARY KEY,
                company_id TEXT,
                nombre TEXT,
                direccion TEXT,
                telefono TEXT,
                estado_sync INTEGER DEFAULT 0,
                fecha_modificacion TEXT
            )
        `).run();

    db.exec(`
        CREATE TABLE IF NOT EXISTS salidas_inventario (
            id TEXT PRIMARY KEY,
            company_id TEXT,
            branch_id TEXT,
            product_id TEXT,
            cantidad REAL,
            unidad TEXT,
            motivo TEXT,
            observacion TEXT,
            usuario_id TEXT,
            estado_sync INTEGER DEFAULT 0,
            fecha_modificacion DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    
    
    CREATE TABLE IF NOT EXISTS configuracion_cajera (
        clave TEXT PRIMARY KEY,
        valor TEXT,
        fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS plan_empresa (
            company_id TEXT PRIMARY KEY,
            datos_encriptados TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );


    CREATE TABLE IF NOT EXISTS auditoria_administrador (
        id TEXT PRIMARY KEY,
        company_id TEXT,
        branch_id TEXT,
        cashier_id TEXT,
        admin_name TEXT,
        accion TEXT,
        detalles TEXT,
        estado_sync INTEGER DEFAULT 0,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    `); 

}

inicializarTablas();

ipcMain.handle('guardar-guia-despacho-maestro', async (event, datos) => {
    try {
        // Asegurarnos de que la tabla exista (por si acaso no la has creado en la inicialización de tu DB)
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

        // Preparar la inserción de los datos usando better-sqlite3
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

        // Ejecutar la inserción
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

        console.log(`✅ [NEXUS MASTER] Guía de Despacho guardada localmente: ${datos.numero_guia}`);
        
        return { exito: true, id: datos.id, numero_guia: datos.numero_guia };

    } catch (error) {
        console.error("❌ [ERROR] Falló al guardar la Guía de Despacho en SQLite:", error);
        return { exito: false, error: error.message };
    }
});

ipcMain.on('confirmar-cierre-seguro', () => {
    cierreAutorizado = true;
    app.quit(); // Ejecuta el cierre definitivo del sistema
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

        console.log(`🛡️ Auditoría registrada: [${datos.accion}] autorizada por ${datos.admin_name || 'Admin'}`);
        return { success: true, changes: resultado.changes };
    } catch (e) {
        console.error("❌ Error al guardar auditoría de administrador:", e.message);
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
        console.error("❌ Error leyendo logs de auditoría en SQLite:", e.message);
        return [];
    }
});

server.use(cors());
server.use(express.json({ limit: '100mb' }));

// Configuración de Axios para el BCV
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
        return null; // Si alguien manipuló la base de datos, esto falla y retorna null
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
        
        console.log(`🔍 [DEBUG] RIF buscado: ${rifBusqueda}`);
        console.log(`🔍 [DEBUG] Facturas encontradas: ${resultados.length}`);
        
        if (resultados.length > 0) {
            console.log(`✅ Primera factura encontrada ID: ${resultados[0].id}`);
        }

        return resultados;
    } catch (e) {
        console.error("❌ Error profundo obteniendo facturas:", e.message);
        return [];
    }
});

ipcMain.handle('registrar-retencion-iva', async (event, { datosRetencion, listaFacturasIds, retencionId }) => {
    try {
        console.log("🛠 Registrando retención:", retencionId);
        console.log("📑 Facturas a actualizar:", listaFacturasIds); // <--- ESTO ES CLAVE

        if (!listaFacturasIds || listaFacturasIds.length === 0) {
            console.warn("⚠️ Advertencia: listaFacturasIds está vacío, no se actualizarán facturas.");
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
                console.log(`✅ Factura ${idVenta} actualizada. Cambios: ${info.changes}`);
            }
        });

        transaction();
        return { success: true };
    } catch (e) {
        console.error("❌ ERROR EN TRANSACCIÓN DE RETENCIÓN:", e);
        return { success: false, error: e.message };
    }
});

// main.js - Función para eliminar sucursales localmente
ipcMain.handle('eliminar-sucursal-local', async (event, id) => {
    try {
        const stmt = db.prepare('DELETE FROM sucursales WHERE id = ?');
        const resultado = stmt.run(id);
        
        if (resultado.changes > 0) {
            console.log(`✅ Sucursal eliminada localmente: ${id}`);
            return { success: true, changes: resultado.changes };
        } else {
            return { success: false, error: "No se encontró la sucursal en la base de datos local." };
        }
    } catch (e) {
        console.error("❌ Error al eliminar sucursal local:", e.message);
        return { success: false, error: e.message };
    }
});

// Guardar el plan encriptado
ipcMain.handle('guardar-plan-local', (event, planData) => {
    try {
        const companyId = planData.companyId;
        const jsonString = JSON.stringify(planData);
        
        // AQUÍ LLAMA A LA FUNCIÓN (Ahora sí la encontrará)
        const datosEncriptados = encriptarPlan(jsonString); 

        const stmt = db.prepare(`
            INSERT INTO plan_empresa (company_id, datos_encriptados, updated_at)
            VALUES (@company_id, @datos_encriptados, CURRENT_TIMESTAMP)
            ON CONFLICT(company_id) DO UPDATE SET
                datos_encriptados = excluded.datos_encriptados,
                updated_at = CURRENT_TIMESTAMP
        `);

        stmt.run({ company_id: companyId, datos_encriptados: datosEncriptados });
        console.log(`🔒 Plan de la empresa ${companyId} encriptado y guardado en bóveda local.`);
        return { success: true };
    } catch (error) {
        console.error("❌ Error guardando el plan encriptado:", error);
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
                console.error("⚠️ ALERTA DE SEGURIDAD: El archivo del plan fue manipulado.");
                return null; 
            }
        }
        return null;
    } catch (error) {
        console.error("❌ Error obteniendo el plan encriptado:", error);
        return null;
    }
});

// handler UNIFICADO: Guarda registro histórico local, marca como cerrado y sincroniza con el Maestro
ipcMain.handle('procesar-cierre-caja-local', async (event, reporte) => {
    try {
        const transaction = db.transaction(() => {
            // A. INSERTAR EL REGISTRO HISTÓRICO DEL CIERRE EN TABLA LOCAL
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
            
            // D. MARCAR PAGOS MÓVILES COMO CERRADOS
            db.prepare(`UPDATE pagos_moviles_locales SET estado_cierre = 1 
                        WHERE company_id = ? AND branch_id = ? AND cashier_id = ? AND estado_cierre = 0`)
              .run(reporte.companyId, reporte.branchId, reporte.cashierId);
        });
        
        // Ejecutamos la transacción local
        transaction();
        console.log(`✅ Cierre Z almacenado localmente: ${reporte.id}`);

        // --- E. SINCRONIZACIÓN CON EL SERVIDOR MAESTRO (PUERTO 3000) ---
        try {
            const ipMaestro = config.isServer ? 'localhost' : config.serverIP; //[cite: 5]
            // Usamos axios para enviar los datos al endpoint que creamos en server.js
            await axios.post(`http://${ipMaestro}:3000/api/maestro/registrar-cierre`, reporte, { timeout: 4000 });
            console.log("📡 Cierre sincronizado con el Servidor Maestro exitosamente.");
        } catch (errSync) {
            console.warn("⚠️ No se pudo sincronizar con el Maestro (Modo Offline o Servidor Apagado):", errSync.message);
            // No retornamos error aquí para que el usuario pueda seguir trabajando, 
            // el registro ya quedó seguro en la base de datos local.
        }

        return { success: true };

    } catch (e) {
        console.error("❌ Error en proceso de cierre:", e.message);
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
        console.error("❌ Error al leer historial de cierres:", e.message);
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
        console.error("❌ Error guardando pago móvil local:", e.message);
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
        return []; // Retornamos un array vacío en caso de fallo para no romper el frontend
    }
});

ipcMain.handle('consultar-ia-nexus', async (event, { mensaje, contexto }) => {
    try {
        console.log("🚀 Nexus AI: Conectando con Google Gemini...");
        
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `Eres un consultor financiero experto de Nexus POS en Venezuela. 
        Tono: Profesional y técnico. Contexto: ${contexto}. Pregunta: ${mensaje}`;
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();

    } catch (error) {
        console.error("❌ Error Crítico en Gemini:", error.message);
        
        if (error.message.includes("404")) {
             return "Reintentando conexión con nodo secundario de IA...";
        }
        
        return "El núcleo de IA no está disponible actualmente.";
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
        console.error("❌ Error guardando movimiento local:", e.message);
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
        console.error("❌ Error consultando movimientos:", e.message);
        return [];
    }
});

ipcMain.handle('validar-saldo-nc', async (event, nroFactura) => {
    try {
        // 🔥 CORRECCIÓN: La tabla real se llama ventas_locales
        const stmt = db.prepare("SELECT SUM(monto_total) as devuelto FROM ventas_locales WHERE es_nota_credito = 1 AND factura_afectada = ?");
        const row = stmt.get(nroFactura);
        
        return { exito: true, totalDevuelto: row.devuelto || 0 };
    } catch (error) {
        console.error("Error al validar saldo histórico NC:", error);
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
    console.log(`⚖️ Báscula Tareada (Software). Nuevo Offset: ${taraOffset}`);
});

ipcMain.on('iniciar-puerto-bascula', (event, puertoCOM) => {
    // 1. SIEMPRE actualizamos a quién le vamos a enviar la data (la nueva ventana)
    senderBasculaActivo = event.sender;

    // 🛡️ PROTECCIÓN ANTI-PUERTOS ZOMBIES
    if (basculaPort) {
        if (basculaPort.path === puertoCOM && basculaPort.isOpen) {
            console.log(`⚖️ El puerto ${puertoCOM} ya está abierto. Redirigiendo datos a la nueva ventana...`);
            return; // Cortamos aquí, pero como actualizamos senderBasculaActivo, ahora sí funcionará
        } else {
            console.log(`⚖️ Cerrando puerto viejo para abrir uno nuevo...`);
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
            console.log(`✅ Puerto de báscula abierto de forma segura: ${puertoCOM}`);
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
            console.error('❌ Error crítico en puerto COM:', err.message);
        });

        basculaPort.on('close', () => {
            console.log('🔌 Puerto COM cerrado correctamente.');
            basculaPort = null;
        });

    } catch (error) {
        console.error("❌ Error al inicializar báscula:", error);
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
        resizable: true,     // PERMITE CAMBIAR TAMAÑO
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
        console.error("❌ Error al guardar tasa:", error);
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
        
        // Extraemos todas las tasas de una vez para que tu tabla no salga vacía
        const rates = {
            'USD': parseFloat($('#dolar strong').text().trim().replace(',', '.')),
            'EUR': parseFloat($('#euro strong').text().trim().replace(',', '.')),
            'CNY': parseFloat($('#yuan strong').text().trim().replace(',', '.')),
            'TRY': parseFloat($('#lira strong').text().trim().replace(',', '.')),
            'RUB': parseFloat($('#rublo strong').text().trim().replace(',', '.'))
        };

        if (!isNaN(rates.USD)) {
            const hoy = new Date().toISOString().split('T')[0];
            
            // GUARDADO AUTOMÁTICO EN EL HISTORIAL (Solo USD para el gráfico)
            db.prepare(`INSERT OR IGNORE INTO historial_tasas (fecha, valor, fuente) VALUES (?, ?, 'BCV')`)
              .run(hoy, rates.USD);
            
            // Retornamos el objeto completo para que el dashboard funcione
            return { success: true, rates };
        }
        return { success: false, error: "Datos no numéricos" };
    } catch (error) {
        console.error('❌ Error en Scraping Nexus:', error.message);
        return { success: false, error: error.message };
    }
});

// SOLO ESTA LÍNEA PARA EL TÚNEL (Sin lógica extra, solo redirige al handle de arriba)
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
    
    // Crear la ventana de login idéntica a la original
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
});

ipcMain.handle('obtener-productos-local', async (event, empresaId) => {
    try {
        console.log(`📂 Solicitando productos locales para la empresa: ${empresaId}`);
        
        let stmt;
        if (empresaId) {

            stmt = db.prepare(`SELECT * FROM productos_locales WHERE company_id = ?`);
            return stmt.all(empresaId);
        } else {

            stmt = db.prepare(`SELECT * FROM productos_locales`);
            return stmt.all();
        }
        
    } catch (e) {
        console.error("❌ Error en obtener-productos-local:", e);
        return []; 
    }
});

ipcMain.handle('guardar-venta-local', async (event, v) => {
    try {
        const stmt = db.prepare(`
            INSERT INTO ventas_locales (
                id, company_id, branch_id, cashier_id, numero_factura, 
                numero_control, cliente_nombre, cliente_rif, monto_exento, 
                base_imponible, monto_iva, monto_igtf, monto_total, 
                tasa_bcv, metodo_pago, datos_json, estado_sync, estado_cierre,
                es_nota_credito, es_nota_debito, factura_afectada, monto_factura_afectada, fecha_factura_afectada
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
        `);
        
        const resultadoLocal = stmt.run(
            v.id, v.company_id, v.branch_id, v.cashier_id, v.numero_factura,
            v.numero_control, v.cliente_nombre, v.cliente_rif, v.monto_exento,
            v.base_imponible, v.monto_iva, v.monto_igtf, v.monto_total,
            v.tasa_bcv, v.metodo_pago, v.datos_json,
            v.es_nota_credito || 0,
            v.es_nota_debito || 0,
            v.factura_afectada || null,
            v.monto_factura_afectada || null,
            v.fecha_factura_afectada || null
        );

        // 2. SINCRONIZACIÓN CON EL SERVIDOR MAESTRO (Red Local)
        try {
            const ipMaestro = config.isServer ? 'localhost' : config.serverIP;
            await axios.post(`http://${ipMaestro}:3000/api/maestro/registrar-venta`, v, { timeout: 3000 });
            console.log(`📡 Venta ${v.numero_factura} sincronizada con Maestro.`);
        } catch (errSync) {
            console.warn(`⚠️ Maestro no disponible. Venta ${v.numero_factura} guardada solo local.`);
        }

        return resultadoLocal;
    } catch (e) {
        console.error("❌ Error en guardado de venta:", e.message);
        return { error: e.message };
    }
});


ipcMain.handle('obtener-deuda-cliente-maestro', async (event, rif) => {
    try {
        const configLocal = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const ipMaestro = configLocal.isServer ? 'localhost' : (configLocal.serverIP || 'localhost');

        const response = await axios.get(`http://${ipMaestro}:3000/api/maestro/consultar-deuda/${rif}`, { 
            timeout: 3000 
        });
        
        return response.data;
    } catch (error) {
        console.error("❌ Error consultando deuda en Maestro desde Main:", error.message);
        return { existe: false, monto_bs: 0, error: "Servidor Maestro no responde" };
    }
});

ipcMain.handle('obtener-proximo-correlativo', async (event, tipo) => {
    try {
        if (config.isServer && masterDbDirect) {
            // 🚀 MODO SERVIDOR: Consulta SQL directa (Sin puertos, sin errores de red)
            const transaccion = masterDbDirect.transaction(() => {
                let row = masterDbDirect.prepare('SELECT ultimo_numero, prefijo FROM correlativos_maestros WHERE tipo = ?').get(tipo);
                
                // 🔥 SOLUCIÓN: Si la fila no existe (Ej: NOTA_CREDITO), se crea al vuelo
                if (!row) {
                    console.log(`⚠️ Correlativo [${tipo}] no encontrado. Creándolo automáticamente...`);
                    let prefijo = 'DOC-';
                    if (tipo === 'NOTA_CREDITO') prefijo = 'NC-';
                    else if (tipo === 'NOTA_DEBITO') prefijo = 'ND-'; // <--- LÍNEA NUEVA AÑADIDA
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
            console.log("⚡ Correlativo generado localmente (Directo de DB)");
            return transaccion();
        } else {
            // 🌐 MODO CLIENTE: Sigue usando la red para buscar al Xeon
            const respuesta = await axios.post(`http://${config.serverIP}:${PORT}/api/maestro/obtener-correlativo`, { tipo });
            return respuesta.data;
        }
    } catch (e) { 
        console.error("❌ Error obteniendo correlativo:", e.message);
        return { error: "No se pudo obtener el correlativo." }; 
    }
});

// 3. Obtener una venta específica (Para reimpresiones)
ipcMain.handle('obtener-venta-por-id', async (event, id) => {
    return db.prepare('SELECT * FROM ventas_locales WHERE id = ?').get(id);
});

ipcMain.handle('obtener-factura-local', async (event, numFactura) => {
    try {
        let serverIp = 'localhost';
        if (fs.existsSync(configPath)) {
            const configLocal = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            serverIp = configLocal.isServer ? 'localhost' : (configLocal.serverIP || 'localhost');
        }
        const response = await axios.get(`http://${serverIp}:3000/api/maestro/buscar-factura/${numFactura}`);
        return response.data; 

    } catch (error) {
        console.error("❌ Error de comunicación con el Maestro:", error.message);
        return { 
            error: true, 
            mensaje: "No se pudo conectar al Servidor Central para buscar la factura." 
        };
    }
});


ipcMain.handle('guardar-sesion-local', async (event, datos) => {
    // datos.role debería ser 'cajera' o 'admin'
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO usuarios_locales (uid, email, role, companyId, branchId, company_data, last_login)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(datos.uid, datos.email, datos.role, datos.companyId, datos.branchId, JSON.stringify(datos.company_data), new Date().toISOString());
});

// Agrega esto en tu archivo main.js junto a los otros ipcMain.handle
ipcMain.handle('cerrar-sesion-local', async () => {
    try {
        // Eliminamos todos los registros de la tabla de sesión para obligar a un nuevo login
        const stmt = db.prepare('DELETE FROM usuarios_locales');
        const resultado = stmt.run();
        console.log("🔒 Sesión local eliminada correctamente de SQLite.");
        return { exito: true, filas_borradas: resultado.changes };
    } catch (e) {
        console.error("❌ Error al eliminar sesión en SQLite:", e);
        return { exito: false, error: e.message };
    }
});

ipcMain.handle('registrar-deuda-maestro', async (event, datos) => {
    try {
        if (config.isServer && masterDbDirect) {
            // 🚀 MODO SERVIDOR: Escritura directa
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
            // 🌐 MODO CLIENTE: Enviar por red
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/registrar-deuda`, datos);
            return respuesta.data;
        }
    } catch (e) {
        return { exito: false, mensaje: e.message };
    }
});

// main.js - PUENTE DE ABONOS (REDUCCIÓN DE DEUDA EN MAESTRO)
ipcMain.handle('registrar-abono-maestro', async (event, datos) => {
    try {
        // 🔥 CORRECCIÓN ARQUITECTÓNICA: 
        // Eliminamos la lógica duplicada de SQLite aquí. 
        // Ahora TODOS (incluyendo el servidor) pasan por la API de server.js
        const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
        
        console.log(`[MAIN] Redirigiendo pago de deuda al servidor local (${ipDestino})...`);
        
        const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/registrar-abono`, datos);
        return respuesta.data;
    } catch (e) {
        console.error("[MAIN] Error en puente de abonos:", e.message);
        return { exito: false, mensaje: e.message };
    }
});


ipcMain.handle('guardar-cliente-local', async (event, cliente) => {
    try {
        if (config.isServer && masterDbDirect) {
            // 🚀 MODO SERVIDOR: Escribe directamente en el maestro
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
            // 🌐 MODO CLIENTE: Envía por red al Servidor Maestro
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/guardar-cliente`, cliente);
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
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.get(`http://${ipDestino}:${PORT}/api/maestro/obtener-clientes`);
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
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.delete(`http://${ipDestino}:${PORT}/api/maestro/eliminar-cliente/${rif}`);
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

        // 3. Escribir en el archivo físico config.json (Recreándolo si no existe)
        const llavesFisicas = ['isServer', 'serverIP', 'allowNoStock', 'geminiApiKey'];
        if (llavesFisicas.includes(clave)) {
            // 🔥 CORRECCIÓN: Escribimos el objeto 'config' directamente para asegurar que el archivo se cree/actualice
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

            // 4. Lógica de PM2 (Solo si cambia isServer)
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
        console.error(`❌ Error crítico al guardar configuración:`, error.message);
        return { error: error.message };
    }
});

ipcMain.handle('imprimir-texto-libre', async (event, textoTicket, nombreImpresora) => {
    try {
        // 1. Creamos el archivo temporal
        const rutaArchivo = path.join(app.getPath('userData'), 'ticket_temporal.txt');
        // Escribimos en latin1 para que los acentos y la "ñ" salgan bien en la tiquera
        fs.writeFileSync(rutaArchivo, textoTicket, 'latin1');
        
        // 2. Preparamos el comando RAW (Copiar archivo crudo al puerto de red local)
        // OJO: nombreImpresora ahora DEBE ser el nombre con el que compartiste la impresora (Ej: POS58)
        const comandoCMD = `copy /B "${rutaArchivo}" "\\\\localhost\\${nombreImpresora}"`;

        // 3. Ejecutamos la impresión directamente en CMD
        return new Promise((resolve) => {
            console.log(`💻 Ejecutando impresión RAW: ${comandoCMD}`);

            exec(comandoCMD, (error, stdout, stderr) => {
                // Borramos el archivo temporal a los 2 segundos
                setTimeout(() => {
                    if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
                }, 2000);

                if (error) {
                    console.error("❌ Error al enviar RAW a impresora:", error.message);
                    console.error("Detalles:", stderr);
                    resolve({ exito: false, mensaje: error.message });
                } else {
                    console.log(`🖨️ Ticket enviado exitosamente a: \\\\localhost\\${nombreImpresora}`);
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
        // Leemos la cola ordenada por fecha (los más viejos primero)
        const stmt = db.prepare('SELECT * FROM sync_queue ORDER BY fecha_creacion ASC');
        return stmt.all();
    } catch (e) {
        console.error("❌ Error al leer la cola de sincronización:", e);
        return [];
    }
});

// 2. El motor borra un registro porque el VPS confirmó que lo recibió
ipcMain.handle('eliminar-de-cola', async (event, id) => {
    try {
        const stmt = db.prepare('DELETE FROM sync_queue WHERE id = ?');
        const resultado = stmt.run(id);
        return { success: true, changes: resultado.changes };
    } catch (e) {
        console.error(`❌ Error al eliminar el registro ${id} de la cola:`, e);
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
        console.error("❌ Error en sincronizar-producto-servidor:", e);
        return { error: e.message };
    }
});

// --- VERIFICADOR DE ACTUALIZACIONES GITHUB (CORREGIDO) ---
// Función Helper matemática para comparar versiones (Ej: "v1.2.0" vs "v1.0.0")
function esVersionMayor(versionNube, versionLocal) {
    // Limpiamos todo lo que no sea número o punto y separamos por bloques
    const vNube = versionNube.replace(/[^0-9.]/g, '').split('.').map(Number);
    const vLocal = versionLocal.replace(/[^0-9.]/g, '').split('.').map(Number);
    
    const longitud = Math.max(vNube.length, vLocal.length);
    
    for (let i = 0; i < longitud; i++) {
        const numNube = vNube[i] || 0;
        const numLocal = vLocal[i] || 0;
        
        if (numNube > numLocal) return true;  // La nube tiene una versión más nueva
        if (numNube < numLocal) return false; // La nube tiene una versión más vieja (Omitir)
    }
    return false; // Son exactamente iguales (Omitir)
}

// --- VERIFICADOR DE ACTUALIZACIONES GITHUB ---
// Ahora recibe la versión que tiene instalada el cliente actualmente
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
                break; // Encontramos una actualización válida, detenemos la búsqueda
            }
        }

        // Si encontramos una versión superior
        if (actualizacionEncontrada) {
            const urlDescargaFichero = (actualizacionEncontrada.assets && actualizacionEncontrada.assets.length > 0) 
                                        ? actualizacionEncontrada.assets[0].browser_download_url 
                                        : "";

            return {
                success: true,
                hayActualizacion: true, // Bandera para el frontend
                nuevaVersion: actualizacionEncontrada.tag_name,
                notas: actualizacionEncontrada.body || "Sin notas de actualización.",
                urlDescarga: urlDescargaFichero
            };
        } else {
            // Si no encontró nada mayor (O estamos iguales, o Github tiene una versión más vieja)
            return {
                success: true,
                hayActualizacion: false // Bandera de seguridad
            };
        }

    } catch (error) {
        console.error("❌ Error en Conexión GitHub:", error.response?.status || error.message);
        return { 
            success: false, 
            error: error.response?.status === 404 ? "Repositorio no encontrado o privado sin acceso" : (error.response?.status === 403 ? "Límite de API excedido o Token inválido" : error.message) 
        };
    }
});

ipcMain.handle('editar-env-local', async (event, nuevaConfig) => {
    // USAMOS LA MISMA LÓGICA DE RUTA DINÁMICA QUE EN LA LECTURA
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
        console.log(`✅ Archivo .env físicamente actualizado en: ${envPath}`);
        return true;
    } catch (err) {
        console.error("Error al actualizar el .env:", err);
        return false;
    }
});

ipcMain.handle('obtener-version-app', () => {
    return app.getVersion();
});

// --- DESCARGA E INSTALACIÓN AUTOMÁTICA ---
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
            // Le avisamos al frontend (HTML) en qué porcentaje vamos
            event.sender.send('download-progress', progress);
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            
            // Reemplazamos 'finish' por 'close'
            writer.on('close', () => {
                
                // Pausa táctica de 1.5 segundos para que Windows libere el archivo
                setTimeout(() => {
                    try {
                        const { spawn } = require('child_process');
                        
                        // 🔥 LA MEJOR PRÁCTICA: Instalación silenciosa con auto-reinicio.
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
        }
        
        // Avisar a la pantalla de inventario que refresque la tabla
        BrowserWindow.getAllWindows().forEach(ventana => {
            if (!ventana.isDestroyed()) ventana.webContents.send('productos-actualizados');
        });
        
        return { success: true };
    } catch (e) {
        console.error("❌ Error al marcar como sincronizado:", e.message);
        return { error: e.message };
    }
});

ipcMain.handle('obtener-categorias-local', async () => {
    try {
        const stmt = db.prepare('SELECT * FROM categorias_locales ORDER BY nombre ASC');
        return stmt.all();
    } catch (e) {
        console.error("Error al obtener categorías locales:", e);
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

            const fechaServidor = new Date(cat.fecha_modificacion).getTime();
            const fechaLocal = new Date(check.fecha_modificacion).getTime();
            
            if (fechaServidor > fechaLocal) {
                const update = db.prepare(`
                    UPDATE categorias_locales 
                    SET nombre = ?, fecha_modificacion = ?, estado_sync = 1
                    WHERE id = ?
                `);
                return update.run(cat.nombre, cat.fecha_modificacion, cat.id);
            }
        }
        return { skipping: true };
    } catch (e) {
        console.error("Error al sincronizar categoría:", e);
        return { error: e.message };
    }
});


ipcMain.handle('eliminar-categoria-local', async (event, id) => {
    try {
        const stmt = db.prepare('DELETE FROM categorias_locales WHERE id = ?');
        return stmt.run(id);
    } catch (e) {
        console.error("Error al eliminar categoría local:", e);
        return { error: e.message };
    }
});

ipcMain.handle('guardar-sucursal-local', async (event, sucursal) => {
    try {
        // CORRECCIÓN: Respetar la fecha y el estado de sync si provienen de la nube
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
            sucursal.id,           // ID único de la sucursal
            sucursal.company_id,   // ID de la empresa dueña
            sucursal.nombre,
            sucursal.direccion,
            sucursal.telefono,
            estadoSync,            // Usar el estado dinámico (0 o 1)
            fechaAUsar             // Usar la fecha correcta
        );
    } catch (e) {
        console.error("❌ Error al guardar sucursal:", e);
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
            // 🔥 MODO SERVIDOR: Lee directo del Cerebro
            const stmt = masterDbDirect.prepare(`
                SELECT producto_id, cantidad_real
                FROM stock_maestro
                WHERE company_id = ? AND sucursal_id = ?
            `);
            return stmt.all(companyId, sucursalId);
        } else {
            // 🌐 MODO CLIENTE: Intenta consultar por red al puerto 3000
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.get(`http://${ipDestino}:${PORT}/api/maestro/stock`, {
                params: { sucursalId: sucursalId, companyId: companyId }
            });
            return respuesta.data; 
        }
    } catch (e) {
        console.warn("⚠️ Puerto 3000 bloqueado o Maestro offline. Leyendo stock desde respaldo local SQLite...");
        // 🛡️ FALLBACK: Si falla (por Expo o red), lee directamente de la base de datos local
        try {
            const stmt = db.prepare(`
                SELECT producto_id, stock as cantidad_real
                FROM inventario_sucursales
                WHERE company_id = ? AND sucursal_id = ?
            `);
            return stmt.all(companyId, sucursalId);
        } catch (errorLocal) {
            console.error("❌ Error profundo leyendo inventario local:", errorLocal.message);
            return [];
        }
    }
});

ipcMain.handle('verificar-y-descontar-stock-maestro', async (event, datos) => {
    try {
        const items = Array.isArray(datos) ? datos : datos.items;
        const sucursalId = Array.isArray(datos) ? null : datos.sucursalId;

        // 🔥 FILTRO INTELIGENTE: Separamos productos físicos de los servicios
        const productosFisicos = items.filter(item => {
            const nombre = String(item.nombre || '').toUpperCase();
            const id = String(item.id || '').toUpperCase();
            
            // Si el nombre contiene ABONO, DEUDA o SERVICIO, lo sacamos de la lista de stock
            return !nombre.includes('ABONO') && !nombre.includes('DEUDA') && !nombre.includes('SERVICIO');
        });

        // Si el carrito SOLO tenía abonos (ej. el cliente solo vino a pagar), damos luz verde inmediata
        if (productosFisicos.length === 0) {
            console.log("⚡ Venta de puro servicio/abono. Stock verificado automáticamente.");
            return { exito: true };
        }

        // --- LÓGICA DE DESCUENTO (Solo procesará los productosFisicos) ---
        if (config.isServer && masterDbDirect) {
            // 🚀 MODO SERVIDOR: Descuento directo en el archivo
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
                
                for (const item of productos) { 
                    if (sucursalId) {
                        stmtConSucursal.run(item.cantidad, item.id, sucursalId);
                    } else {
                        stmtSinSucursal.run(item.cantidad, item.id);
                    }
                }
            });

            transaccion(productosFisicos); // ✅ Pasamos solo los físicos
            console.log("⚡ Stock descontado directamente en la DB Maestra");
            return { exito: true };
        } else {
            // 🌐 MODO CLIENTE: Petición por red al servidor
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/descontar-stock`, {
                sucursalId: sucursalId,
                items: productosFisicos.map(i => ({ id: i.id, cantidad: i.cantidad, nombre: i.nombre }))
            });
            return respuesta.data;
        }
    } catch (e) {
        return { exito: false, mensaje: e.message || "Error de comunicación con el maestro." };
    }
});


ipcMain.handle('guardar-stock-sucursal', async (event, { productoId, sucursalId, companyId, cantidad, operacion }) => {
    try {
        if (config.isServer && masterDbDirect) {
            // 🔥 SOLUCIÓN: Escribimos directamente en el Cerebro Maestro (stock_maestro) saltándonos el puerto 3000
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

            // Notificar a las ventanas para refrescar la tabla visualmente
            BrowserWindow.getAllWindows().forEach(ventana => {
                if (!ventana.isDestroyed()) ventana.webContents.send('productos-actualizados');
            });

            console.log(`📢 Stock Maestro actualizado vía IPC local: Operación ${operacion}`);
            return { success: true, changes: resultado.changes }; 
            
        } else {
            // Lógica para cuando es una Laptop secundaria (Cliente) comunicándose por red
            const ipDestino = config.serverIP;
            const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/registrar-entrada`, {
                sucursalId: sucursalId, 
                companyId: companyId,   
                items: [{ id: productoId, cantidad: cantidad, operacion: operacion, sucursalId: sucursalId, companyId: companyId }]
            });
            return { success: true, changes: 1 };
        }
    } catch (e) {
        console.error("❌ Error en guardar-stock-sucursal:", e.message);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('guardar-clave-admin-maestro', async (event, c) => {
    try {
        // 1. Encriptamos la clave en la computadora local ANTES de enviarla por la red
        const encrypted = encryptClave(c.plainCode);
        const datos = {
            id: c.id, ownerName: c.ownerName, encryptedCode: encrypted,
            company_id: c.company_id, created_by: c.created_by, updatedAt: c.updatedAt
        };

        if (config.isServer && masterDbDirect) {
            // 🚀 MODO SERVIDOR: Escribe directo en la DB Maestra
            masterDbDirect.prepare(`
                INSERT INTO claves_admin_maestras (id, ownerName, encryptedCode, company_id, created_by, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(datos.id, datos.ownerName, datos.encryptedCode, datos.company_id, datos.created_by, datos.updatedAt);
            return { success: true };
        } else {
            // 🌐 MODO CLIENTE: Envía por red al puerto 3000
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/guardar-clave-admin`, datos);
            return { success: respuesta.data.exito };
        }
    } catch (e) {
        console.error("❌ Error guardando clave segura en Maestro:", e.message);
        return { error: e.message };
    }
});

ipcMain.handle('obtener-claves-admin-maestro', async (event, companyId) => {
    try {
        let claves = [];
        
        if (config.isServer && masterDbDirect) {
            // 🚀 MODO SERVIDOR: Lee directo
            claves = masterDbDirect.prepare('SELECT * FROM claves_admin_maestras WHERE company_id = ? ORDER BY updatedAt DESC').all(companyId);
        } else {
            // 🌐 MODO CLIENTE: Lee desde la red
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.get(`http://${ipDestino}:${PORT}/api/maestro/obtener-claves-admin/${companyId}`);
            claves = respuesta.data;
        }

        // 2. Desencriptamos localmente en RAM para mandarlas al frontend
        return claves.map(c => ({
            id: c.id,
            ownerName: c.ownerName,
            plainCode: decryptClave(c.encryptedCode), // 🔓 Revela
            company_id: c.company_id,
            updatedAt: c.updatedAt
        }));
    } catch (e) {
        console.error("❌ Error obteniendo claves seguras del Maestro:", e.message);
        return [];
    }
});

ipcMain.handle('eliminar-clave-admin-maestro', async (event, id) => {
    try {
        if (config.isServer && masterDbDirect) {
            masterDbDirect.prepare('DELETE FROM claves_admin_maestras WHERE id = ?').run(id);
            return { success: true };
        } else {
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.delete(`http://${ipDestino}:${PORT}/api/maestro/eliminar-clave-admin/${id}`);
            return { success: respuesta.data.exito };
        }
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('crear-respaldo-local', async () => {
    try {
        const backupsDir = path.join(dbDir, 'backups');
        // Crear la carpeta si no existe
        if (!fs.existsSync(backupsDir)) {
            fs.mkdirSync(backupsDir, { recursive: true });
        }

        // Generar nombre de archivo con fecha y hora (Ej: nexus_pos_2026-04-17_15-30-00.db)
        const fecha = new Date();
        const timestamp = fecha.toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
        const backupFileName = `nexus_pos_backup_${timestamp}.db`;
        const backupPath = path.join(backupsDir, backupFileName);

        // Copiar el archivo
        fs.copyFileSync(dbPath, backupPath);

        // Obtener el tamaño del nuevo archivo
        const stats = fs.statSync(backupPath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        return { success: true, fileName: backupFileName, size: sizeMB, path: backupPath };
    } catch (e) {
        console.error("❌ Error creando respaldo:", e.message);
        return { error: e.message };
    }
});

ipcMain.handle('obtener-respaldos-locales', async () => {
    try {
        const backupsDir = path.join(dbDir, 'backups');
        if (!fs.existsSync(backupsDir)) return [];

        // Leer los archivos de la carpeta
        const files = fs.readdirSync(backupsDir);
        const respaldos = [];

        for (const file of files) {
            if (file.endsWith('.db')) {
                const filePath = path.join(backupsDir, file);
                const stats = fs.statSync(filePath);
                respaldos.push({
                    fileName: file,
                    size: (stats.size / (1024 * 1024)).toFixed(2), // Tamaño en MB
                    createdAt: stats.birthtime // Fecha de creación
                });
            }
        }
        
        // Ordenar del más reciente al más antiguo
        return respaldos.sort((a, b) => b.createdAt - a.createdAt);
    } catch (e) {
        console.error("❌ Error leyendo respaldos:", e.message);
        return [];
    }
});

ipcMain.handle('eliminar-respaldo-local', async (event, fileName) => {
    try {
        const backupPath = path.join(dbDir, 'backups', fileName);
        if (fs.existsSync(backupPath)) {
            fs.unlinkSync(backupPath);
            return { success: true };
        } else {
            throw new Error("El archivo no existe.");
        }
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('restaurar-respaldo-local', async (event, fileName) => {
    return new Promise((resolve) => {
        try {
            const backupPath = path.join(dbDir, 'backups', fileName);
            if (!fs.existsSync(backupPath)) {
                resolve({ error: "El archivo de respaldo no existe." });
                return;
            }

            console.log("🔒 Preparando restauración... Cerrando base de datos actual.");
            // 1. CERRAR LA CONEXIÓN (La orden se envía a SQLite)
            db.close(); 

            // 2. PAUSA TÁCTICA: Le damos a Windows 1 segundo para liberar el archivo físicamente
            setTimeout(() => {
                try {
                    console.log("⏳ Candado liberado. Copiando respaldo...");
                    // 3. SOBRESCRIBIR EL ARCHIVO
                    fs.copyFileSync(backupPath, dbPath);
                    console.log("✅ Base de datos restaurada con éxito.");

                    // 4. CIERRE SEGURO (3 segundos después de la copia)
                    setTimeout(() => {
                        app.quit();
                    }, 3000);

                    // Respondemos al HTML que todo salió bien
                    resolve({ success: true });
                    
                } catch (fsError) {
                    // Si falla aquí, capturamos el error exacto de Windows
                    console.error("❌ Error del sistema de archivos:", fsError.message);
                    resolve({ error: "Error al sobrescribir: " + fsError.message });
                }
            }, 1000); // <-- 1000 milisegundos de espera mágica

        } catch (e) {
            console.error("❌ Error general:", e.message);
            resolve({ error: e.message });
        }
    });
});

ipcMain.on('apagar-sistema', () => {
    console.log("🛑 Apagando el sistema por cierre de sesión seguro...");
    app.quit();
});

ipcMain.handle('reiniciar-aplicacion', () => {
    console.log("🔄 Reiniciando Nexus POS Global para aplicar nueva configuración de Plan...");
    app.relaunch();
    app.quit();
});



ipcMain.handle('obtener-unidades-empaque-local', async (event, companyId) => {
    try {
        // Hacemos un JOIN con productos_locales para mostrar el nombre real del producto en la tabla
        const stmt = db.prepare(`
            SELECT u.*, p.nombre as nombre_producto 
            FROM unidades_empaque u
            LEFT JOIN productos_locales p ON u.product_id = p.id
            WHERE u.company_id = ?
            ORDER BY u.fecha_modificacion DESC
        `);
        return stmt.all(companyId);
    } catch (e) {
        console.error("❌ Error al obtener empaques locales:", e.message);
        return { error: e.message };
    }
});

// 2. Guardar o Actualizar una unidad de empaque (Upsert)
ipcMain.handle('guardar-unidad-empaque-local', async (event, datos) => {
    try {
        const fechaActual = new Date().toISOString();
        
        // INSERT OR REPLACE (o ON CONFLICT) para evitar duplicados
        const stmt = db.prepare(`
            INSERT INTO unidades_empaque (
                id, company_id, product_id, nombre_unidad, 
                tipo_medida, factor_cantidad, estado_sync, fecha_modificacion
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT(id) DO UPDATE SET
                nombre_unidad = excluded.nombre_unidad,
                tipo_medida = excluded.tipo_medida,
                factor_cantidad = excluded.factor_cantidad,
                estado_sync = 0, -- Marcamos para subir al Xeon
                fecha_modificacion = excluded.fecha_modificacion
        `);

        const resultado = stmt.run(
            datos.id, 
            datos.company_id, 
            datos.product_id, 
            datos.nombre_unidad, 
            datos.tipo_medida, 
            datos.factor_cantidad, 
            fechaActual
        );

        // Notificar a las ventanas que hubo cambios (opcional)
        BrowserWindow.getAllWindows().forEach(ventana => {
            if (!ventana.isDestroyed()) ventana.webContents.send('empaques-actualizados');
        });

        return { success: true, changes: resultado.changes };
    } catch (e) {
        console.error("❌ Error al guardar empaque local:", e.message);
        return { success: false, error: e.message };
    }
});

// 3. Eliminar unidad de empaque localmente
ipcMain.handle('eliminar-unidad-empaque-local', async (event, id) => {
    try {
        const resultado = db.prepare('DELETE FROM unidades_empaque WHERE id = ?').run(id);
        return { success: true, changes: resultado.changes };
    } catch (e) {
        console.error("❌ Error al eliminar empaque local:", e.message);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('obtener-empaque-por-producto', async (event, productId) => {
    try {
        return db.prepare('SELECT * FROM unidades_empaque WHERE product_id = ?').all(productId);
    } catch (e) {
        return [];
    }
});


ipcMain.handle('guardar-salida-local', async (event, datos) => {
    try {
        // --- ENLACE CON SERVIDOR MAESTRO ---
        const ipDestino = config.isServer ? 'localhost' : config.serverIP;

        try {
            // 🔥 FIX: Añadimos sucursalId en el cuerpo y dentro de items para asegurar la ruta correcta
            const respuestaMaestro = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/descontar-stock`, {
                sucursalId: datos.branch_id,
                items: [{ 
                    id: datos.product_id, 
                    cantidad: datos.cantidad,
                    sucursalId: datos.branch_id
                }]
            });

            if (!respuestaMaestro.data.exito) {
                return { success: false, error: "El Maestro rechazó la salida: Stock insuficiente." };
            }
            console.log("📉 Stock descontado correctamente en el Servidor Maestro.");
        } catch (errAxios) {
            // Si el servidor maestro no está disponible, lanzamos error para proteger la integridad
            return { success: false, error: "Error de conexión con el Servidor Maestro: " + errAxios.message };
        }

        // --- LÓGICA LOCAL ORIGINAL ---
        const stmt = db.prepare(`
            INSERT INTO salidas_inventario (
                id, company_id, branch_id, product_id, cantidad, 
                unidad, motivo, observacion, usuario_id, estado_sync, fecha_modificacion
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `);

        const resultado = stmt.run(
            datos.id,
            datos.company_id,
            datos.branch_id,
            datos.product_id,
            datos.cantidad,
            datos.unidad,
            datos.motivo,
            datos.observacion,
            datos.usuario_id,
            datos.fecha_modificacion || new Date().toISOString()
        );

        return { success: true, changes: resultado.changes };
    } catch (e) {
        console.error("❌ Error al guardar salida local:", e.message);
        return { success: false, error: e.message };
    }
});

// 2. Obtener el historial de salidas local (con JOIN para ver nombres de productos)
ipcMain.handle('obtener-salidas-local', async (event, { companyId, branchId }) => {
    try {
        const stmt = db.prepare(`
            SELECT s.*, p.nombre as nombre_producto 
            FROM salidas_inventario s
            LEFT JOIN productos_locales p ON s.product_id = p.id
            WHERE s.company_id = ? AND s.branch_id = ?
            ORDER BY s.fecha_modificacion DESC
            LIMIT 50
        `);
        return stmt.all(companyId, branchId);
    } catch (e) {
        console.error("❌ Error al obtener historial de salidas:", e.message);
        return [];
    }
});


ipcMain.handle('obtener-configuracion-cajera', async (event, clave) => {
    try {
        const stmt = db.prepare('SELECT valor FROM configuracion_cajera WHERE clave = ?');
        const resultado = stmt.get(clave);
        

        return resultado ? resultado.valor : null;
    } catch (error) {
        console.error(`❌ Error al obtener configuracion_cajera [${clave}]:`, error.message);
        return null;
    }
});


ipcMain.handle('guardar-configuracion-cajera', async (event, clave, valor) => {
    try {
        const fechaActual = new Date().toISOString();

        const valorTexto = typeof valor === 'string' ? valor : JSON.stringify(valor);

        const stmt = db.prepare(`
            INSERT INTO configuracion_cajera (clave, valor, fecha_actualizacion)
            VALUES (?, ?, ?)
            ON CONFLICT(clave) DO UPDATE SET
                valor = excluded.valor,
                fecha_actualizacion = excluded.fecha_actualizacion
        `);
        
        const resultado = stmt.run(clave, valorTexto, fechaActual);
        console.log(`✅ Ajustes de cajera guardados bajo la clave: ${clave}`);
        
        return { success: true, changes: resultado.changes };
    } catch (error) {
        console.error(`❌ Error al guardar en configuracion_cajera [${clave}]:`, error.message);
        return { success: false, error: error.message };
    }
});



ipcMain.handle('guardar-config-maestra', async (event, datos) => {
    try {
        let serverIpDestino = 'localhost';
        if (fs.existsSync(configPath)) {
            const configLocal = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            serverIpDestino = configLocal.isServer ? 'localhost' : (configLocal.serverIP || 'localhost');
        }

        const url = `http://${serverIpDestino}:3000/api/maestro/configuracion`;
        const response = await axios.post(url, datos);
        return response.data;
    } catch (error) {
        console.error("❌ Error guardando config en el Maestro:", error.message);
        return { exito: false, error: error.message };
    }
});


ipcMain.handle('leer-config-maestra', async (event, clave) => {
    try {
        let serverIpDestino = 'localhost';
        if (fs.existsSync(configPath)) {
            const configLocal = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            serverIpDestino = configLocal.isServer ? 'localhost' : (configLocal.serverIP || 'localhost');
        }

        const url = `http://${serverIpDestino}:3000/api/maestro/configuracion/${clave}`;
        const response = await axios.get(url);
        return response.data; 
    } catch (error) {
        console.error("❌ Error leyendo config del Maestro:", error.message);
        return { exito: false, error: error.message };
    }
});

function calcularLRC(bufferDatos, bufferEtx) {
    let lrc = 0;
    const toCalc = Buffer.concat([bufferDatos, bufferEtx]);
    for (let i = 0; i < toCalc.length; i++) {
        lrc ^= toCalc[i];
    }
    return lrc;
}

ipcMain.handle('consultar-estado-fiscal', async (event, puerto) => {
    return new Promise((resolve) => {
        const portName = puerto || 'COM99'; 
        const port = new SerialPort({ path: portName, baudRate: 9600, autoOpen: false });

        // 🔥 CERRADURA SINCRONIZADA: Obliga a esperar que Windows suelte el puerto antes de avanzar
        const closeAndResolve = (resultado) => {
            if (port.isOpen) {
                port.close(() => resolve(resultado));
            } else {
                resolve(resultado);
            }
        };

        port.open((err) => {
            if (err) return resolve({ success: false, msg: `No se pudo abrir ${portName}` });

            const STX = Buffer.from([0x02]);
            const ETX = Buffer.from([0x03]);
            const comandoS1 = Buffer.from('S1', 'latin1');
            const lrcS1 = calcularLRC(comandoS1, ETX);
            const tramaS1 = Buffer.concat([STX, comandoS1, ETX, Buffer.from([lrcS1])]);
            
            let bufferRecepcion = "";

            port.on('data', (data) => {
                bufferRecepcion += data.toString('latin1');
                
                if (data.includes(0x15)) {
                    closeAndResolve({ success: false, msg: "Impresora rechazó consulta inicial (NAK)." });
                }
                
                if (data.includes(0x03)) {
                    try {
                        const contenido = bufferRecepcion.split('\x02')[1].split('\x03')[0];
                        let serial = "DESC";
                        
                        if (contenido.includes('\n')) {
                            const partes = contenido.split('\n').map(p => p.trim()); 
                            serial = partes[13] ? partes[13] : "DESC";        
                        } else {
                            if (contenido.length >= 63) {
                                serial = contenido.substring(53, 63);
                            }
                        }
                        closeAndResolve({ success: true, msg: "Máquina en línea", serial: serial });
                    } catch (e) {
                        closeAndResolve({ success: true, msg: "Máquina en línea (Serial no leído)" });
                    }
                }
            });

            setTimeout(() => {
                closeAndResolve({ success: false, msg: "Timeout al consultar estado inicial S1." });
            }, 3000);

            port.write(tramaS1);
        });
    });
});

ipcMain.handle('emitir-tramas-hka', async (event, tramas, puerto) => {
    return new Promise((resolve) => {
        const portName = puerto || 'COM99';
        const port = new SerialPort({ path: portName, baudRate: 9600, autoOpen: false });

        // 🔥 CERRADURA SINCRONIZADA
        const closeAndResolve = (resultado) => {
            if (port.isOpen) {
                port.close(() => resolve(resultado));
            } else {
                resolve(resultado);
            }
        };

        const tienePagos = tramas.some(cmd => /^[12](0[1-9]|1[0-9]|2[0-4])/.test(cmd));
        if (tienePagos && !tramas.includes("199")) {
            tramas.push("199");
            console.log("[FISCAL] 🛠️ Comando 199 inyectado automáticamente para cierre con IGTF (Flag 50=01).");
        }

        port.open((err) => {
            if (err) return resolve({ success: false, msg: `Error abriendo puerto: ${err.message}` });
            
            let index = 0;
            const STX = Buffer.from([0x02]);
            const ETX = Buffer.from([0x03]);
            let timeoutOperacion; 
            let leyendoStatusFinal = false; 

            console.log(`\n[FISCAL] 🚀 Iniciando facturación con ${tramas.length} comandos.`);

            const enviarSiguienteComando = () => {
                clearTimeout(timeoutOperacion); 

                if (index >= tramas.length) {
                    console.log("[FISCAL] 🎉 Todas las tramas enviadas con éxito. Ticket Cerrado.");
                    
                    leyendoStatusFinal = true;
                    console.log(`[FISCAL] 📤 Solicitando estado S1...`);
                    
                    const comandoS1 = Buffer.from('S1', 'latin1');
                    const lrcS1 = calcularLRC(comandoS1, ETX);
                    const tramaS1 = Buffer.concat([STX, comandoS1, ETX, Buffer.from([lrcS1])]);
                    
                    port.write(tramaS1);
                    
                    timeoutOperacion = setTimeout(() => {
                        console.error(`[FISCAL] ⚠️ TIMEOUT leyendo S1. Se guardará sin número oficial.`);
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
                        return closeAndResolve({ success: false, msg: 'Error de escritura' });
                    }
                    console.log(`[FISCAL] 📤 Enviado -> ${comandoAscii}`);
                });

                timeoutOperacion = setTimeout(() => {
                    console.error(`[FISCAL] ⚠️ TIMEOUT: La impresora no respondió al comando: ${comandoAscii}`);
                    closeAndResolve({ success: false, msg: `Timeout en: ${comandoAscii}` });
                }, 15000);
            };

            let bufferRecepcion = "";

            port.on('data', (data) => {
                if (!leyendoStatusFinal) {
                    if (data.includes(0x06)) {
                        index++;
                        setTimeout(enviarSiguienteComando, 250); 
                    } 
                    else if (data.includes(0x15)) { 
                        clearTimeout(timeoutOperacion);
                        console.error(`[FISCAL] ❌ NAK recibido.`);
                        closeAndResolve({ success: false, msg: `La impresora rechazó el comando: ${tramas[index]}` });
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
                                if (contenido.length >= 63) {
                                    const facturaReal = parseInt(contenido.substring(28, 36), 10);
                                    serial = contenido.substring(53, 63);
                                    nroFac = (facturaReal === 0 || isNaN(facturaReal)) ? "TEST-X" : facturaReal.toString();
                                }
                            }

                            console.log(`[FISCAL] ✅ Número Oficial Procesado: ${nroFac} | Serial: ${serial}`);
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
function getIpServidor() {
    try {
        const configLocal = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const esMaestro = (configLocal.isServer === true || configLocal.isServer === 'true');      
        return esMaestro ? '127.0.0.1' : (configLocal.serverIP || '127.0.0.1'); 
    } catch (e) {
        return '127.0.0.1';
    }
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
    
    // Checksum de 2 dígitos (Universal para Venezuela)
    const bcc = xor.toString(16).toUpperCase().padStart(2, '0');
    return Buffer.from(STX + cuerpoParaCheck + bcc, 'ascii');
}

// --- UTILIDADES MULTIMARCA ---

// Elimina acentos y eñes (Vital para impresoras viejas)
function limpiarTexto(texto) {
    if (!texto) return "";
    return texto.normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9 ]/g, "")
        .toUpperCase();
}



function enviarConsulta(resolve) {
    console.log(`[FISCAL] ⚠️ El puerto abrió bien. Saltando el saludo 0x05 porque el emulador exige tramas completas.`);
    console.log(`[FISCAL] ✅ Dando LUZ VERDE para probar la facturación real.`);
    
    // Le decimos al frontend que todo está OK para que nos deje facturar
    resolve({ success: true, msg: "Puerto abierto y listo para comandos" });
}

function enviarConsulta(resolve) {
    console.log(`[FISCAL] ⚠️ El puerto abrió bien. Saltando el saludo 0x05 porque el emulador exige tramas completas.`);
    console.log(`[FISCAL] ✅ Dando LUZ VERDE para probar la facturación real.`);
    
    // Le decimos al frontend que todo está OK para que nos deje facturar
    resolve({ success: true, msg: "Puerto abierto y listo para comandos" });
}

// Función auxiliar para reportar logs al frontend
function reportarLogHKA(event, mensaje, esError = false) {
    if (event && event.sender) {
        event.sender.send('hka-auth-log', { mensaje, esError });
    }
}



// MODO DE facturacion HKA IMPRENTA DIGITAL "FACTURACION ELECTRÓNICA" - FASE 2: Sincronización y Validación de Numeración

// 🟢 FUNCIÓN 1: Consultar último número y sincronizar con server.js
async function sincronizarUltimoNumero(event, tipoDoc = "01") {
    try {
        reportarLogHKA(event, `Consultando último correlativo (${tipoDoc}) en la nube...`);
        
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

            reportarLogHKA(event, `Sincronización exitosa: Última factura en nube #${ultimoNro}. DB Local actualizada.`);
        }
    } catch (error) {
        reportarLogHKA(event, `Error sincronizando números: ${error.message}`, true);
    }
}

// 🟢 FUNCIÓN 2: Verificar rangos disponibles (ConsultaNumeraciones)
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

// 🟢 INTERCEPCIÓN DEL AUTH EXITOSO PARA DISPARAR FASE 2
ipcMain.on('ejecutar-auth-hka', async (event) => {
    // Primero hacemos el login (Fase 1)
    await iniciarAuthWorkerHKA(event); 
    
    // Si tenemos token, disparamos la Fase 2 automáticamente
    if (apiToken) {
        await sincronizarUltimoNumero(event, "01"); // Sincroniza el número
        await verificarRangosDisponibles(event);    // Valida que hay números libres
    }
});

// --- FASE 3: EMISIÓN DE FACTURA ELECTRÓNICA ---
ipcMain.handle('emitir-factura-hka', async (event, facturaJSON) => {
    try {
        if (!apiToken) throw new Error("No hay token de autenticación activo.");

        // 1. Ubicar la raíz del documento
        const doc = facturaJSON.DocumentoElectronico || facturaJSON.documentoElectronico;
        if (!doc) throw new Error("Estructura raíz 'DocumentoElectronico' no encontrada en el JSON.");

        const nroDoc = doc.Encabezado.IdentificacionDocumento.NumeroDocumento;
        
        // CORRECCIÓN: Usamos TotalesRetencion
        console.log(`🚀 ENVIANDO A TFHKA - FACTURA #${nroDoc}`);
        console.log("📦 payload completo:", JSON.stringify(facturaJSON, null, 2)); 
        
        reportarLogHKA(event, `Enviando factura #${nroDoc} a fiscalización...`);

        // 2. Envío a la API
        const response = await axios.post(`${HKA_BASE_URL}/api/Emision`, facturaJSON, {
            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' }
        });

        const data = response.data; // Axios guarda la respuesta en .data

        // 3. Validación
        if (data && [0, 200, '0', '200'].includes(data.codigo)) {
            reportarLogHKA(event, "✅ Factura aceptada por The Factory HKA.");
            return { exito: true, data };
        } 
        
        // 4. Manejo de errores de negocio (HKA devolvió algo pero no fue éxito)
        const errorMsg = `${data.mensaje || "Error desconocido"}`;
        console.error("❌ HKA rechazó la factura:", data);
        reportarLogHKA(event, `❌ Error de Emisión HKA: ${errorMsg}`, true);
        return { exito: false, error: errorMsg };

    } catch (error) {
        // Axios lanza error si el status code no es 2xx
        let detalle = error.message;
        if (error.response) {
            detalle = JSON.stringify(error.response.data);
            console.error("❌ Respuesta completa de HKA:", error.response.data);
        }
        
        reportarLogHKA(event, `🔥 Fallo de conexión HKA: ${detalle}`, true);
        return { exito: false, error: detalle };
    }
});

async function createSplashScreen() {
    splash = new BrowserWindow({
        width: 800, // Ajusta al tamaño de tu video
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

    // Asegúrate de que el archivo esté en la raíz o en /public
    splash.loadFile('splash.html'); 
}

async function enviarDatosAXeon(datos) { 
    try {
        console.log("📡 Intentando sincronizar con Xeon...");
        
        // Se mantiene la URL con HTTPS para evitar bloqueos del túnel de Cloudflare
        const urlFinal = `https://configuracioncajera.nexusposgobal.com/api/xeon/registrar-entrada`;

        // 🔥 CORRECCIÓN CRUCIAL: Enviamos 'datos' directamente. 
        // configuracion.html ya estructuró el objeto con companyId, tipo_configuracion y payload
        const respuesta = await axios.post(urlFinal, datos, { 
            timeout: 15000,
            maxRedirects: 5 
        });

        console.log("📥 Respuesta del Xeon:", respuesta.data);

        if (respuesta.data.exito) {
            console.log(`☁️ Sincronización Exitosa: ${respuesta.data.id_referencia}`);
            return { success: true, ref: respuesta.data.id_referencia };
        } else {
            console.error("❌ El Xeon rechazó los datos:", respuesta.data.error);
            return { success: false, error: respuesta.data.error };
        }
    } catch (error) {
        if (error.response) {
            console.error("🔥 Error de Respuesta Xeon:", error.response.status);
            return { success: false, error: `Error ${error.response.status}: Asegúrate de usar HTTPS en el código.` };
        } else if (error.request) {
            console.error("📡 Error de Red (Sin respuesta):", error.message);
            return { success: false, error: "Servidor no responde. Verifica el estado del túnel." };
        } else {
            console.error("⚠️ Error Configuración Axios:", error.message);
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
            nodeIntegration: true,
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: true,
            devTools: false
        }
    });

    async function ejecutarScrapingYGuardar() {
    const tasaBcv = await obtenerTasaDesdeWeb(); // Tu función actual que usa axios/cheerio
    
    if (tasaBcv) {
        const hoy = new Date().toISOString().split('T')[0]; // Formato YYYY-MM-DD
        
        // GUARDADO AUTOMÁTICO: Cada vez que el sistema hace scraping, "siembra" el dato
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
            console.log("🌱 Nueva instalación detectada. Sincronizando historial inicial de red...");
            
            // 2. Llamar a la API gratuita para el BCV
            // Esta API devuelve el historial de los últimos días
            const response = await axios.get('https://ve.dolarapi.com/v1/dolares/bcv');
            const data = response.data;

            if (data && data.fecha) {
                const hoy = new Date().toISOString().split('T')[0];
                const valor = data.promedio; // O el valor que devuelva la API

                // Guardamos al menos el valor actual como punto de partida
                db.prepare(`INSERT OR IGNORE INTO historial_tasas (fecha, valor, fuente) VALUES (?, ?, 'API_INICIAL')`)
                  .run(hoy, valor);
                
                // NOTA: Como la mayoría de APIs gratis solo dan el "Hoy", 
                // el rellenador de huecos que ya hicimos hará el resto:
                rellenarHuecosHistorial(); 
                
                console.log("✅ Historial inicial sincronizado.");
            }
        }
    } catch (error) {
        console.error("❌ No se pudo sincronizar el historial inicial:", error.message);
    }
}

async function rellenarHuecosHistorial() {
    console.log("🔍 Nexus POS: Verificando integridad del historial...");
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
                console.log(`✅ Día ${fechaIso} rellenado.`);
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
        // 🔥 MEJORA: Definimos la transacción para insertar todo en un solo bloque
        const insert = db.prepare("INSERT OR IGNORE INTO historial_tasas (fecha, valor, fuente) VALUES (?, ?, 'BCV')");
        
        const sembrarTodo = db.transaction((datos) => {
            for (const d of datos) insert.run(d.f, d.v);
        });

        sembrarTodo(datosBCV);
        console.log("🌱 Datos históricos sembrados correctamente.");
    } catch (error) {
        console.error("⚠️ Error al sembrar datos (Base de datos ocupada):", error.message);
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

app.whenReady().then(() => {
    createSplashScreen(); // 1. Primero mostramos el video
    createWindow();       // 2. Preparamos la app en segundo plano
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});


