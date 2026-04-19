// 1. Módulos de Sistema y Electron
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const ENCRYPTION_KEY = crypto.scryptSync("NexusGlobalSecretoAdmin2026", "saltingNexus", 32); 
const IV_LENGTH = 16; 
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const Database = require('better-sqlite3');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

// 3. Configuración del Servidor y Base de Datos
// 3. Configuración del Servidor y Base de Datos
const server = express();
const PORT = 3000;

// ✅ CORRECCIÓN: Usar app.getPath('userData') para evitar el error ENOTDIR del .asar
const dbDir = path.join(app.getPath('userData'), 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = path.join(dbDir, 'nexus_pos.db');
const db = new Database(dbPath, { timeout: 10000 });
console.log("🚀 Cerebro Conectado en:", dbPath);

// 4. Variables Globales y Estado
let win;    
let splash;
let sistemaPrincipalAbierto = false;

// 5. Gestión de Configuración (config.json)
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
        console.error("Error al leer config.json:", e); 
    }
} else {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// 6. Optimización de Base de Datos
try {
    db.pragma('journal_mode = WAL');
} catch (e) {
    console.warn("⚠️ Aviso: La base de datos está ocupada por el Servidor Maestro. Iniciando sin modo WAL forzado.");
}

function inicializarTablas() {

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
    db.prepare("ALTER TABLE productos_locales ADD COLUMN precio_compra REAL DEFAULT 0").run();
    db.prepare("ALTER TABLE productos_locales ADD COLUMN porcentaje_ganancia REAL DEFAULT 0").run();
    console.log("✅ Columnas de costo y ganancia verificadas/añadidas a SQLite.");
} catch (e) {
    // Es normal que de error si las columnas ya existen. Pasa silenciosamente.
}


// --- ESTO DEBE IR FUERA DE CUALQUIER IF ---
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

server.listen(PORT, () => {
    console.log(`🔗 Servidor local Express escuchando en el puerto ${PORT}`);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.warn(`⚠️ Nota: El puerto ${PORT} ya está en uso (Normal si el servidor maestro PM2 está encendido).`);
    } else {
        console.error("❌ Error en Express:", err);
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
        // 1. PRE-VALIDACIÓN Y DESCUENTO: Hablar con el Servidor Maestro primero
        const urlServidor = config.isServer ? `http://localhost:${PORT}` : `http://${config.serverIP}:${PORT}`;
        
        // Extraemos los productos
        const ventaData = typeof v.datos_json === 'string' ? JSON.parse(v.datos_json) : v.datos_json;
        const itemsParaDescontar = (ventaData.productos || []).map(p => ({
            id: p.id || p.producto_id,
            cantidad: p.cantidad
        }));

        if (itemsParaDescontar.length > 0) {
            try {
                // Petición al servidor maestro ANTES de guardar localmente
                const respuestaStock = await axios.post(`${urlServidor}/api/maestro/descontar-stock`, { items: itemsParaDescontar });
                
                if (!respuestaStock.data.exito) {
                    return { error: `Venta cancelada: ${respuestaStock.data.mensaje}` };
                }
                console.log("📦 Nexus POS: Stock validado y descontado en el Servidor Maestro.");
                
            } catch (errorAxios) {
                console.error("❌ Error de red o stock al validar:", errorAxios.message);
                // Extraemos el mensaje de error si viene del backend (ej. 400 Stock insuficiente), si no, es caída de red
                const mensajeError = errorAxios.response?.data?.mensaje || "Pérdida de conexión con el Servidor Maestro.";
                return { error: `Venta cancelada: ${mensajeError}` };
            }
        }

        // 2. GUARDADO LOCAL: Solo se ejecuta si el bloque anterior fue exitoso
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

        return resultadoLocal;
    } catch (e) {
        console.error("❌ Error en ciclo de venta (Validación + Local):", e.message);
        return { error: e.message };
    }
});

ipcMain.handle('obtener-proximo-correlativo', async (event, tipo) => {
    try {
        // Ahora siempre le preguntamos al servidor de PM2 (localhost o IP remota)
        const ipDestino = config.isServer ? 'localhost' : config.serverIP;
        const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/obtener-correlativo`, { tipo });
        return respuesta.data;
    } catch (e) { 
        console.error("❌ Error obteniendo correlativo:", e.message);
        return { error: "No se pudo conectar con el servidor maestro de PM2." }; 
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
        const stmt = db.prepare(`INSERT OR REPLACE INTO categorias_locales (id, company_id, nombre, estado_sync, fecha_modificacion) VALUES (?, '', ?, 1, ?)`);
        
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
        // CORRECCIÓN: Usar tabla 'configuracion', no 'productos_locales'
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion)
            VALUES (?, ?, ?)
        `);
        stmt.run(clave, valorTexto, new Date().toISOString());

        const llavesFisicas = ['isServer', 'serverIP', 'allowNoStock', 'geminiApiKey'];
        if (llavesFisicas.includes(clave)) {
            let configActual = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (clave === 'isServer') configActual.isServer = (valor === true || valor === "true");
            else if (clave === 'serverIP') configActual.serverIP = valor;
            else if (clave === 'allowNoStock') configActual.allowNoStock = (valor === true || valor === "true");
            else if (clave === 'geminiApiKey') configActual.geminiApiKey = valor;

            fs.writeFileSync(configPath, JSON.stringify(configActual, null, 2), 'utf8');
            config = configActual;

            if (clave === 'isServer' && configActual.isServer === true) {
                exec(`pm2 start server.js --name "Nexus-Cerebro" --watch && pm2 save`);
            }
            if (clave === 'isServer' && configActual.isServer === false) {
                exec(`pm2 delete Nexus-Cerebro && pm2 save --force`);
            }
        }
        return { success: true };
    } catch (error) {
        console.error(`❌ Error al guardar configuración:`, error.message);
        return { error: error.message };
    }
});

ipcMain.handle('imprimir-texto-libre', async (event, textoTicket, nombreImpresora) => {
    try {
        // 1. Creamos el archivo temporal en la carpeta de datos de la app
        const rutaArchivo = path.join(app.getPath('userData'), 'ticket_temporal.txt');
        fs.writeFileSync(rutaArchivo, textoTicket, 'latin1');
        
        // 2. Preparamos el comando de Windows
        let comandoPowerShell = `powershell -Command "Get-Content '${rutaArchivo}' -Raw | Out-Printer"`;
        if (nombreImpresora) {
            comandoPowerShell = `powershell -Command "Get-Content '${rutaArchivo}' -Raw | Out-Printer -Name '${nombreImpresora}'"`;
        }

        // 3. Ejecutamos la impresión directamente desde main.js
        return new Promise((resolve) => {
            exec(comandoPowerShell, (error) => {
                // Borramos el archivo temporal a los 2 segundos
                setTimeout(() => {
                    if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
                }, 2000);

                if (error) {
                    console.error("❌ Error en PowerShell:", error.message);
                    resolve({ exito: false, mensaje: error.message });
                } else {
                    console.log(`🖨️ Ticket enviado nativamente a: ${nombreImpresora || 'Impresora Predeterminada'}`);
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
        const stmt = db.prepare(`
            SELECT 
                p.id, 
                p.nombre, 
                p.categoria, 
                p.codigo,
                -- 🛠️ CORRECCIÓN: Extraemos la unidad del JSON porque la columna p.unit no existe
                IFNULL(json_extract(p.datos_json, '$.unit'), 'UN') as unit, 
                i.stock as stock_sucursal
            FROM inventario_sucursales i
            INNER JOIN productos_locales p ON p.id = i.producto_id
            WHERE p.company_id = ? AND i.sucursal_id = ? AND p.status = 1
        `);
        return stmt.all(companyId, sucursalId);
    } catch (e) {
        console.error("❌ Error en obtener-inventario-sucursal:", e.message);
        return { error: e.message };
    }
});

ipcMain.handle('guardar-stock-sucursal', async (event, { productoId, sucursalId, companyId, cantidad, operacion }) => {
    try {
        // --- ENLACE CON SERVIDOR MAESTRO ---
        const ipDestino = config.isServer ? 'localhost' : config.serverIP;
        
        // Si estamos sumando stock (Entrada), informamos al Maestro primero
        if (operacion === 'SUMAR') {
            try {
                await axios.post(`http://${ipDestino}:${PORT}/api/maestro/registrar-entrada`, {
                    items: [{ id: productoId, cantidad: cantidad }]
                });
                console.log("📢 Stock sincronizado con el Servidor Maestro (Suma).");
            } catch (errAxios) {
                console.warn("⚠️ No se pudo sincronizar con el Maestro, pero se guardará localmente:", errAxios.message);
            }
        }

        // --- LÓGICA LOCAL ORIGINAL ---
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

        // Notificación a ventanas abierta
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


