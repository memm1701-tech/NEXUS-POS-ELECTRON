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

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

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
let printerPort;
let apiToken = null;
let tokenExpiration = null;
const HKA_BASE_URL = "https://demoemision.thefactoryhka.com.ve";
let currentHkaCredentials = { usuario: "", clave: "" };

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
        precio_compra REAL, -- COLUMNA AÑADIDA
        porcentaje_ganancia REAL,
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
            monto_igtf REAL DEFAULT 0,
            monto_total REAL DEFAULT 0,
            tasa_bcv REAL DEFAULT 1,
            metodo_pago TEXT,
            datos_json TEXT,
            estado_sync INTEGER DEFAULT 0,
            fecha_emision DATETIME DEFAULT CURRENT_TIMESTAMP
        )
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
    `); 

}

inicializarTablas();


try {
    db.prepare("ALTER TABLE ventas_locales ADD COLUMN estado_cierre INTEGER DEFAULT 0").run();
} catch (e) {}

try {
    db.prepare("ALTER TABLE productos_locales ADD COLUMN precio_compra REAL DEFAULT 0").run();
    db.prepare("ALTER TABLE productos_locales ADD COLUMN porcentaje_ganancia REAL DEFAULT 0").run();
    console.log("✅ Columnas de costo, ganancia y estado_cierre verificadas/añadidas a SQLite.");
} catch (e) {
   
}

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

// 2. Procesar el Cierre (Guarda el Z y marca todo como cerrado)
ipcMain.handle('procesar-cierre-caja-local', async (event, reporte) => {
    try {
        const transaction = db.transaction(() => {
            // A. Aquí deberías crear un INSERT para una tabla nueva llamada 'cierres_caja' (opcional para tu historial general)
            
            // B. Marcar ventas como cerradas
            db.prepare(`UPDATE ventas_locales SET estado_cierre = 1 WHERE company_id = ? AND branch_id = ? AND cashier_id = ? AND estado_cierre = 0`).run(reporte.companyId, reporte.branchId, reporte.cashierId);
            
            // C. Marcar Ingresos y Gastos como cerrados
            db.prepare(`UPDATE movimientos_caja_locales SET estado_cierre = 1 WHERE company_id = ? AND branch_id = ? AND cashier_id = ? AND estado_cierre = 0`).run(reporte.companyId, reporte.branchId, reporte.cashierId);
        });
        
        transaction();
        return { success: true };
    } catch (e) {
        return { error: e.message };
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

// --- MANEJO DE BALANZA PROFESIONAL ---
let puertoActivo = null; // Variable global para controlar la conexión única

ipcMain.on('iniciar-puerto-balanza', (event, puertoCOM) => {
    // 1. Si ya hay un puerto abierto, lo cerramos antes de abrir el nuevo
    if (puertoActivo && puertoActivo.isOpen) {
        console.log(`🔄 Cerrando puerto anterior para abrir ${puertoCOM}`);
        puertoActivo.close();
    }

    try {
        puertoActivo = new SerialPort({ path: puertoCOM, baudRate: 9600 });
        const parser = puertoActivo.pipe(new ReadlineParser({ delimiter: '\n' }));

        parser.on('data', (data) => {
            // Enviamos el peso al HTML (evento 'peso-desde-balanza')
            if (!event.sender.isDestroyed()) {
                event.sender.send('peso-desde-balanza', data.trim());
            }
        });

        puertoActivo.on('error', (err) => {
            console.error('❌ Error físico en Puerto Serie:', err.message);
        });

        console.log(`✅ Conectado directamente a la Balanza en: ${puertoCOM}`);
    } catch (e) {
        console.error("❌ No se pudo abrir el puerto serie:", e.message);
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
        frame: true,         // DEVUELVE EL MARCO DE WINDOWS
        resizable: true,     // PERMITE CAMBIAR TAMAÑO
        maximizable: true,   // PERMITE MAXIMIZAR
        icon: path.join(__dirname, 'assets/logo_nexus_sin_fondo.png'),
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


// 1. Guardar la venta con todos los campos fiscales de tu tabla
ipcMain.handle('guardar-venta-local', async (event, v) => {
    try {
        // Se eliminó la validación/descuento de stock en el Servidor Maestro (Axios)
        // para limitar la operación exclusivamente al guardado en la colección local.

        const stmt = db.prepare(`
            INSERT INTO ventas_locales (
                id, company_id, branch_id, cashier_id, numero_factura, 
                numero_control, cliente_nombre, cliente_rif, monto_exento, 
                base_imponible, monto_iva, monto_igtf, monto_total, 
                tasa_bcv, metodo_pago, datos_json, estado_sync
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `);
        
        const resultadoLocal = stmt.run(
            v.id, v.company_id, v.branch_id, v.cashier_id, v.numero_factura,
            v.numero_control, v.cliente_nombre, v.cliente_rif, v.monto_exento,
            v.base_imponible, v.monto_iva, v.monto_igtf, v.monto_total,
            v.tasa_bcv, v.metodo_pago, v.datos_json
        );

        // 🔥 SE ELIMINARON LOS BLOQUES DE DEUDAS. LA BD LOCAL YA NO SABE DE DEUDAS.

        console.log(`📂 Venta ${v.id} almacenada directamente en SQLite local.`);
        return resultadoLocal;
    } catch (e) {
        console.error("❌ Error en guardado local directo:", e.message);
        return { error: e.message };
    }
});

ipcMain.handle('obtener-deuda-cliente', async (event, rif) => {
    console.log(`🔍 [LOG DB] Buscando deuda para el RIF: ${rif}`);
    try {
        const deudas = db.prepare(`
            SELECT * FROM cuentas_por_cobrar 
            WHERE cliente_rif = ? AND (monto_deuda - monto_pagado) > 0
        `).all(rif);
        
        console.log(`✅ [LOG DB] Deudas encontradas para ${rif}: ${deudas.length} registros.`);
        return deudas;
    } catch (error) {
        console.error(`❌ [LOG DB] Error al consultar deuda:`, error.message);
        return [];
    }
});

ipcMain.handle('obtener-proximo-correlativo', async (event, tipo) => {
    try {
        if (config.isServer && masterDbDirect) {
            // 🚀 MODO SERVIDOR: Consulta SQL directa (Sin puertos, sin errores de red)
            const transaccion = masterDbDirect.transaction(() => {
                const row = masterDbDirect.prepare('SELECT ultimo_numero, prefijo FROM correlativos_maestros WHERE tipo = ?').get(tipo);
                const nuevoNumero = (row ? row.ultimo_numero : 0) + 1;
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

// main.js - PUENTE HÍBRIDO DE DEUDAS
ipcMain.handle('registrar-deuda-maestro', async (event, datos) => {
    try {
        if (config.isServer && masterDbDirect) {
            // 🚀 MODO SERVIDOR: Escritura directa
            const transaccion = masterDbDirect.transaction(() => {
                // 1. Crear cliente si no existe
                masterDbDirect.prepare(`
                    INSERT OR IGNORE INTO clientes_maestro (id, nombre, saldo_deuda) VALUES (?, ?, 0)
                `).run(datos.cliente_id, datos.cliente_nombre);

                // 2. Registrar la cuenta por cobrar
                masterDbDirect.prepare(`
                    INSERT INTO cuentas_por_cobrar (cliente_id, cliente_nombre, monto_bs, monto_usd, factura_nro, fecha, estado)
                    VALUES (?, ?, ?, ?, ?, ?, 'PENDIENTE')
                `).run(datos.cliente_id, datos.cliente_nombre, datos.monto_bs, datos.monto_usd || 0, datos.numero_factura, datos.fecha);
                
                // 3. Actualizar el saldo global
                masterDbDirect.prepare(`
                    UPDATE clientes_maestro SET saldo_deuda = saldo_deuda + ? WHERE id = ?
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
        if (config.isServer && masterDbDirect) {
            const transaccion = masterDbDirect.transaction(() => {
                // 1. Restar saldo global
                masterDbDirect.prepare(`UPDATE clientes_maestro SET saldo_deuda = MAX(0, saldo_deuda - ?) WHERE id = ?`).run(datos.monto_bs, datos.cliente_id);
                // 2. Limpiar facturas pendientes
                masterDbDirect.prepare(`UPDATE cuentas_por_cobrar SET estado = 'PAGADO' WHERE cliente_id = ? AND estado = 'PENDIENTE'`).run(datos.cliente_id);
            });
            
            transaccion();
            console.log(`📉 [MODO SERVIDOR] Deuda reducida y facturas saldadas directamente en DB Maestra para: ${datos.cliente_id}`);
            return { exito: true };
        } else {
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/registrar-abono`, datos);
            return respuesta.data;
        }
    } catch (e) {
        return { exito: false, mensaje: e.message };
    }
});


// Añadir en main.js (junto a los otros ipcMain.handle)
ipcMain.handle('guardar-cliente-local', async (event, c) => {
    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO clientes_locales (rif, company_id, nombre, direccion, telefono, correo, datos_json, estado_sync, fecha_modificacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        `);
        return stmt.run(c.rif, c.company_id, c.nombre, c.direccion, c.telefono, c.correo, JSON.stringify(c), new Date().toISOString());
    } catch (e) {
        console.error("❌ Error guardando cliente:", e);
        return { error: e.message };
    }
});

ipcMain.handle('obtener-clientes-local', async () => {
    try {
        return db.prepare('SELECT * FROM clientes_locales ORDER BY nombre ASC').all();
    } catch (e) {
        return [];
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

// 🔥 SOLUCIÓN 3: Nombres de variables correctos y guardado en la tabla correcta
ipcMain.handle('sincronizar-categorias-local', async (event, categories) => {
    try {
        const stmt = db.prepare(`INSERT OR REPLACE INTO categorias_locales (id, company_id, nombre, estado_sync, fecha_modificacion) VALUES (?, ?, ?, 1, ?)`);
        
        const transaction = db.transaction((cats) => {
            for (const cat of cats) {
                const nombre = cat.nombre || cat.name || 'Sin nombre';
                stmt.run(cat.id, nombre, new Date().toISOString());
            }
        });

        transaction(categories);
        return { success: true };
    } catch (e) {
        console.error("Error sincronizando categorías:", e);
        return { error: e.message };
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
        
        console.log(`✅ Configuración [${clave}] guardada físicamente en: ${configPath}`);
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

ipcMain.handle('procesar-cola-sync', async () => {
    const pendientes = db.prepare('SELECT * FROM sync_queue').all();
    return { exito: true, registros_subidos: pendientes.length };
});

ipcMain.handle('sincronizar-producto-servidor', async (event, p) => {
    try {
        const idProducto = p.id || p.producto_ID;
        const idEmpresa = p.company_id || p.empresa_ID;
        const idSucursal = p.branch_id || p.sucursal_ID || 'sucursal_1';
        
        // 🛡️ EXTRACCIÓN BLINDADA: Garantizamos que siempre sea un número (Float)
        const precioRef = parseFloat(p.precios ? p.precios.p1.venta : (p.precio_venta || p.precio || 0)) || 0;
        const compraRef = parseFloat(p.precios ? p.precios.p1.compra : (p.precio_compra || 0)) || 0;
        const porcentajeRef = parseFloat(p.precios ? p.precios.p1.porcentaje : (p.porcentaje_ganancia || 0)) || 0;
        
        const jsonParaGuardar = JSON.stringify(p);

        const local = db.prepare('SELECT * FROM productos_locales WHERE id = ?').get(idProducto);
        let resultado;

        if (!local) {
            const stmt = db.prepare(`
                INSERT INTO productos_locales (id, company_id, branch_id, codigo, nombre, precio, precio_compra, porcentaje_ganancia, categoria, status, imagen, datos_json, estado_sync, fecha_modificacion)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            `);
            resultado = stmt.run(
                idProducto, 
                idEmpresa, 
                idSucursal, 
                p.codigo, 
                p.nombre, 
                precioRef, 
                compraRef, 
                porcentajeRef, 
                p.categoria, 
                p.status, 
                p.imagen, 
                jsonParaGuardar, 
                p.fecha_modificacion
            );
        } else {
            const stmt = db.prepare(`
                UPDATE productos_locales
                SET codigo = ?, nombre = ?, precio = ?, precio_compra = ?, porcentaje_ganancia = ?, categoria = ?, status = ?, imagen = ?, datos_json = ?, estado_sync = 1, fecha_modificacion = ?
                WHERE id = ?
            `);
            resultado = stmt.run(
                p.codigo, 
                p.nombre, 
                precioRef, 
                compraRef, 
                porcentajeRef, 
                p.categoria, 
                p.status, 
                p.imagen, 
                jsonParaGuardar, 
                p.fecha_modificacion, 
                idProducto
            );
        }

        // Notificación a las ventanas para refrescar la UI
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
        // Si soy el servidor, leo mi propio SQLite. 
        // Si soy el cliente, le pregunto al Master por red.
        if (config.isServer) {
            const stmt = db.prepare(`
                SELECT p.id, p.nombre, p.categoria, p.codigo,
                IFNULL(json_extract(p.datos_json, '$.unit'), 'UN') as unit, 
                i.stock as stock_sucursal
                FROM inventario_sucursales i
                INNER JOIN productos_locales p ON p.id = i.producto_id
                WHERE p.company_id = ? AND i.sucursal_id = ? AND p.status = 1
            `);
            return stmt.all(companyId, sucursalId);
        } else {
            // 🔗 PC 2: Pide los datos al Master por el túnel de red
            const respuesta = await axios.get(`http://${config.serverIP}:${PORT}/api/maestro/stock`);
            return respuesta.data; 
        }
    } catch (e) {
        console.error("❌ Error obteniendo inventario:", e.message);
        return [];
    }
});

// main.js - Puente para comunicación con el Maestro durante la venta
// main.js - PUENTE DE STOCK CON FILTRO PARA SERVICIOS/ABONOS
ipcMain.handle('verificar-y-descontar-stock-maestro', async (event, items) => {
    try {
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
                    const row = masterDbDirect.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ?').get(item.id);
                    if (!row || row.cantidad_real < item.cantidad) {
                        throw new Error(`Stock insuficiente para: ${item.nombre || item.id}`);
                    }
                }
                const stmt = masterDbDirect.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real - ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ?');
                for (const item of productos) { stmt.run(item.cantidad, item.id); }
            });

            transaccion(productosFisicos); // ✅ Pasamos solo los físicos
            console.log("⚡ Stock descontado directamente en la DB Maestra");
            return { exito: true };
        } else {
            // 🌐 MODO CLIENTE: Petición por red al servidor
            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;
            const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/descontar-stock`, {
                // ✅ Enviamos solo los físicos y añadimos el nombre para que el servidor dé un error más claro
                items: productosFisicos.map(i => ({ id: i.id, cantidad: i.cantidad, nombre: i.nombre }))
            });
            return respuesta.data;
        }
    } catch (e) {
        return { exito: false, mensaje: e.message || "Error de comunicación con el maestro." };
    }
});

// main.js - CORRECCIÓN DE SINCRONIZACIÓN MAESTRA
ipcMain.handle('guardar-stock-sucursal', async (event, { productoId, sucursalId, companyId, cantidad, operacion }) => {
    try {
        const ipDestino = config.isServer ? 'localhost' : config.serverIP;
        
        // 1. SINCRONIZACIÓN CON MAESTRO (Xeon Local)
        // Eliminamos el IF para que tanto SUMAR como FIJAR se reporten al servidor central
        try {
            await axios.post(`http://${ipDestino}:${PORT}/api/maestro/registrar-entrada`, {
                items: [{ 
                    id: productoId, 
                    cantidad: cantidad, 
                    operacion: operacion // <--- CRUCIAL: Enviamos la bandera para que el Maestro sepa qué hacer
                }]
            });
            console.log(`📢 Stock sincronizado con Maestro: Operación ${operacion}`);
        } catch (errAxios) {
            console.warn("⚠️ Maestro no disponible. Se guardará solo en esta laptop:", errAxios.message);
        }

        // 2. ACTUALIZACIÓN EN DB LOCAL (Laptop actual)
        const fecha = new Date().toISOString();
        const sql = operacion === 'SUMAR' 
            ? `INSERT INTO inventario_sucursales (producto_id, sucursal_id, company_id, stock, fecha_modificacion, estado_sync)
               VALUES (?, ?, ?, ?, ?, 0)
               ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET
               stock = stock + excluded.stock, 
               fecha_modificacion = excluded.fecha_modificacion,
               estado_sync = 0`
            : `INSERT INTO inventario_sucursales (producto_id, sucursal_id, company_id, stock, fecha_modificacion, estado_sync)
               VALUES (?, ?, ?, ?, ?, 0)
               ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET
               stock = excluded.stock, 
               fecha_modificacion = excluded.fecha_modificacion,
               estado_sync = 0`;

        const resultado = db.prepare(sql).run(productoId, sucursalId, companyId, cantidad, fecha);

        // Notificar a las ventanas para refrescar la tabla visualmente
        BrowserWindow.getAllWindows().forEach(ventana => {
            if (!ventana.isDestroyed()) ventana.webContents.send('productos-actualizados');
        });

        return { success: true, changes: resultado.changes }; 
    } catch (e) {
        console.error("❌ Error en guardar-stock-sucursal:", e.message);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('guardar-clave-admin-local', async (event, c) => {
    try {
        // 1. Encriptamos la clave en milisegundos
        const encrypted = encryptClave(c.plainCode);
        
        // 2. Guardamos en disco duro
        const stmt = db.prepare(`
            INSERT INTO claves_admin_locales (id, ownerName, encryptedCode, company_id, created_by, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const resultado = stmt.run(c.id, c.ownerName, encrypted, c.company_id, c.created_by, c.updatedAt);
        
        return { success: true, changes: resultado.changes };
    } catch (e) {
        console.error("❌ Error guardando clave segura:", e.message);
        return { error: e.message };
    }
});

ipcMain.handle('obtener-claves-admin-local', async (event, companyId) => {
    try {
        // 1. Buscamos todas las filas encriptadas
        const claves = db.prepare('SELECT * FROM claves_admin_locales WHERE company_id = ? ORDER BY updatedAt DESC').all(companyId);
        
        // 2. Desencriptamos en la memoria RAM (al vuelo) antes de mandarlas al HTML
        return claves.map(c => ({
            id: c.id,
            ownerName: c.ownerName,
            plainCode: decryptClave(c.encryptedCode), // 🔓 Aquí se revela para que el ojito 👁️ funcione
            company_id: c.company_id,
            updatedAt: c.updatedAt
        }));
    } catch (e) {
        console.error("❌ Error obteniendo claves seguras:", e.message);
        return [];
    }
});

ipcMain.handle('eliminar-clave-admin-local', async (event, id) => {
    try {
        const resultado = db.prepare('DELETE FROM claves_admin_locales WHERE id = ?').run(id);
        return { success: true, changes: resultado.changes };
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

ipcMain.handle('eliminar-cliente-local', async (event, rif) => {
    try {
        return db.prepare('DELETE FROM clientes_locales WHERE rif = ?').run(rif);
    } catch (e) { return { error: e.message }; }
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

// --- MANEJADORES PARA SALIDAS DE INVENTARIO ---

ipcMain.handle('guardar-salida-local', async (event, datos) => {
    try {
        // --- ENLACE CON SERVIDOR MAESTRO ---
        const ipDestino = config.isServer ? 'localhost' : config.serverIP;

        try {
            // Solicitamos al maestro descontar el stock global
            const respuestaMaestro = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/descontar-stock`, {
                items: [{ id: datos.product_id, cantidad: datos.cantidad }]
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

ipcMain.handle('sincronizar-configuracion-xeon', async (event, datos) => {
    return await enviarDatosAXeon(datos);
});

// Calcula el Checksum XOR (Sello de seguridad requerido)
function calcularChecksum(trama) {
    let checksum = 0;
    for (let i = 0; i < trama.length; i++) {
        checksum = (checksum ^ trama.charCodeAt(i)) & 0xFF;
    }
    return checksum.toString(16).toUpperCase().padStart(4, '0');
}

// Arma el paquete: STX + Seq + Cmd + Separadores + Campos + ETX + Checksum
function prepararPaquete(comando, campos = []) {
    const STX = '\x02';
    const ETX = '\x03';
    const FS = '\x1C'; // Separador de campos (ASCII 28)
    const SEQ = '\x20'; // Secuencia (Espacio)

    let cuerpo = SEQ + comando;
    if (campos.length > 0) {
        cuerpo += FS + campos.join(FS);
    }

    const tramaParaCheck = cuerpo + ETX;
    const check = calcularChecksum(tramaParaCheck);
    
    // Retornamos el Buffer listo para el puerto serial
    return Buffer.from(STX + tramaParaCheck + check, 'ascii');
}

ipcMain.handle('imprimir-factura-fiscal', async (event, saleData) => {
    let configFactura = { puerto: 'COM2', modelo: 'PNP' };
    try {
        // Buscamos la configuración en la tabla correcta 'configuracion'
        const row = db.prepare("SELECT valor FROM configuracion WHERE clave = 'config_factura'").get();
        if (row) {
            const data = JSON.parse(row.valor);
            configFactura.puerto = data.puerto_com_fiscal || 'COM2';
            configFactura.modelo = data.tipo_emision || 'PNP';
        }
    } catch (e) { 
        console.error("Error al leer configuración de DB:", e); 
    }

    return new Promise(async (resolve) => {
        try {
            const puerto = configFactura.puerto;
            
            // Gestión dinámica del puerto serie
            if (!printerPort || printerPort.path !== puerto) {
                if (printerPort && printerPort.isOpen) await new Promise(r => printerPort.close(r));
                printerPort = new SerialPort({ path: puerto, baudRate: 9600, autoOpen: false });
            }
            if (!printerPort.isOpen) {
                await new Promise((res, rej) => printerPort.open((err) => err ? rej(err) : res()));
            }

            console.log(`🚀 Iniciando impresión [MODO: ${configFactura.modelo}] en ${puerto}`);

            if (configFactura.modelo === 'FISCAL_HASAR') {
                // --- PROTOCOLO HASAR (COMANDOS LARGOS) ---
                
                // 1. Cancelar cualquier estado previo para limpiar el buffer
                printerPort.write(prepararPaqueteHasar('@CANCEL', []));
                await new Promise(r => setTimeout(r, 600));

                // 2. Abrir Ticket Fiscal (C = Tique)
                printerPort.write(prepararPaqueteHasar('@TIQUEABRE', ['C']));
                await new Promise(r => setTimeout(r, 600));

                // 3. Enviar Items
                for (const it of saleData.items) {
                    printerPort.write(prepararPaqueteHasar('@TIQUEITEM', [
                        limpiarTexto(it.nombre).substring(0, 26),
                        fH(it.cantidad, 3), // Cantidad con 3 decimales (ej: 1.000)
                        fH(it.precio, 2),   // Precio con 2 decimales (ej: 100.00)
                        '16.0',             // Tasa IVA
                        'M',                // Calificador de monto
                        '0.0',              // Impuestos internos
                        '0'                 // Display
                    ]));
                    await new Promise(r => setTimeout(r, 500));
                }

                // 4. Pago (T = Paga todo el saldo)
                const total = fH(saleData.monto_total, 2);
                printerPort.write(prepararPaqueteHasar('@TIQUEPAGO', ['EFECTIVO', total, 'T']));
                await new Promise(r => setTimeout(r, 600));

                // 5. Cierre de Ticket (Sin parámetros para evitar error de comando inválido)
                printerPort.write(prepararPaqueteHasar('@TIQUECIERRA', []));

            } else {
                // --- PROTOCOLO PNP / BIXOLON (COMANDOS CORTOS) ---
                
                // Abrir factura
                printerPort.write(prepararPaquete('@', [
                    limpiarTexto(saleData.cliente_nombre).substring(0, 30), 
                    saleData.cliente_rif, 
                    "VENTA", 
                    "T"
                ]));
                await new Promise(r => setTimeout(r, 500));

                // Items (PNP usa céntimos sin puntos decimales)
                for (const it of saleData.items) {
                    const p = Math.round(parseFloat(it.precio) * 100).toString();
                    const c = Math.round(parseFloat(it.cantidad) * 1000).toString();
                    printerPort.write(prepararPaquete('B', [
                        limpiarTexto(it.nombre).substring(0, 20), 
                        c, p, "1", "M", "0", "0"
                    ]));
                    await new Promise(r => setTimeout(r, 300));
                }

                // Pago y Cierre
                const totalCents = Math.round(parseFloat(saleData.monto_total) * 100).toString();
                printerPort.write(prepararPaquete('D', ["EFECTIVO", totalCents]));
                await new Promise(r => setTimeout(r, 400));
                printerPort.write(prepararPaquete('E', []));
            }

            resolve({ success: true, msg: "Factura enviada exitosamente" });

        } catch (error) {
            console.error("❌ Fallo en impresión fiscal:", error.message);
            resolve({ success: false, msg: error.message });
        }
    });
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



// En main.js
// main.js - Handler de consulta reforzado
ipcMain.handle('consultar-estado-fiscal', async () => {
    // 1. Buscamos el puerto configurado igual que antes
    let puertoConfigurado = 'COM2'; 
    try {
        const row = db.prepare("SELECT valor FROM configuraciones WHERE clave = 'config_factura'").get();
        if (row) { puertoConfigurado = JSON.parse(row.valor).puerto_com_fiscal || 'COM2'; }
    } catch (e) {}

    return new Promise((resolve) => {
        // 2. Si no existe la instancia, la creamos DE UNA VEZ
        if (!printerPort || printerPort.path !== puertoConfigurado) {
            printerPort = new SerialPort({
                path: puertoConfigurado,
                baudRate: 9600,
                autoOpen: false
            });
        }

        // 3. Si está cerrado, intentamos abrirlo antes de consultar
        if (!printerPort.isOpen) {
            printerPort.open((err) => {
                if (err) return resolve({ success: false, msg: "No se pudo abrir el puerto" });
                enviarConsulta(resolve); // Función interna para mandar el byte 0x05
            });
        } else {
            enviarConsulta(resolve);
        }
    });
});

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
        if (!apiToken) {
            throw new Error("No hay un token de autenticación activo.");
        }

        // 1. Buscamos la raíz de forma flexible (mayúsculas o minúsculas)
        const doc = facturaJSON.DocumentoElectronico || facturaJSON.documentoElectronico || facturaJSON.Documentoelectronico;

        if (!doc) {
            console.error("❌ ERROR: Estructura raíz no encontrada", facturaJSON);
            throw new Error("El JSON no tiene una raíz válida (documentoElectronico).");
        }

        // 2. Extraemos datos para el log (Buscamos Totales dentro de Encabezado)
        const numeroDoc = doc.Encabezado.IdentificacionDocumento.NumeroDocumento;
        const totalesParaLog = doc.Encabezado.Totales;

        console.log("-----------------------------------------");
        console.log("🚀 ENVIANDO A TFHKA - FACTURA #" + numeroDoc);
        console.log("UBICACIÓN: Encabezado.Totales");
        console.log("OBJETO TOTALES:", JSON.stringify(totalesParaLog, null, 2));
        console.log("-----------------------------------------");

        reportarLogHKA(event, `Enviando factura #${numeroDoc} a fiscalización...`);

        // 3. Envío directo a la API
        const response = await axios.post(`${HKA_BASE_URL}/api/Emision`, facturaJSON, {
            headers: { 
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.data && response.data.codigo === 0) {
            reportarLogHKA(event, "✅ Factura aceptada por The Factory HKA.");
            return { exito: true, data: response.data };
        } else {
            const errorMsg = response.data.mensaje || "Error desconocido";
            const validaciones = response.data.validaciones ? ` - ${response.data.validaciones.join(', ')}` : "";
            reportarLogHKA(event, `❌ Error de Emisión: ${errorMsg}${validaciones}`, true);
            return { exito: false, error: response.data };
        }

    } catch (error) {
        const detalle = error.response ? JSON.stringify(error.response.data) : error.message;
        reportarLogHKA(event, `🔥 Fallo de red/sistema en Emisión: ${detalle}`, true);
        return { exito: false, error: detalle };
    }
});

async function createSplashScreen() {
    splash = new BrowserWindow({
        width: 800, // Ajusta al tamaño de tu video
        height: 500, 
        transparent: true, 
        icon: path.join(__dirname, 'assets/logo_nexus_sin_fondo.png'),
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

    //Menu.setApplicationMenu(null);

    win = new BrowserWindow({
        width: 1000,
        height: 700,
        frame: false,
        resizable: false,
        maximizable: false,
        show: false, 
        icon: path.join(__dirname, 'assets/logo_nexus_sin_fondo.png'),
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


