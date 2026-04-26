const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');

// --- 1. CONFIGURACIÓN DE RUTAS (UNIFICADO CON APPDATA) ---
const dbDir = path.join(process.env.APPDATA, 'nexus-pos', 'data');
const configPath = path.join(dbDir, 'config.json');
const serverDbPath = path.join(dbDir, 'nexus-local-server.db');

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const server = express();
const PORT = 3000;

// Habilitar CORS para que otras computadoras de la red puedan entrar
server.use(cors());
server.use(express.json());

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
if (fs.existsSync(configPath)) {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        console.error("Error al leer config.json:", error.message);
    }
}

// --- 3. LÓGICA DEL SERVIDOR MAESTRO ---
if (config.isServer) {
    const serverDb = new Database(serverDbPath);
    serverDb.pragma('journal_mode = WAL');
    
    // Inicialización de Tablas Maestras
    serverDb.exec(`
        CREATE TABLE IF NOT EXISTS stock_maestro (
        producto_id TEXT,
        sucursal_id TEXT,
        company_id TEXT,
        cantidad_real REAL DEFAULT 0,
        ultima_sincronizacion DATETIME,
        PRIMARY KEY (producto_id, sucursal_id)
        );


        CREATE TABLE IF NOT EXISTS correlativos_maestros (
            tipo TEXT PRIMARY KEY,
            prefijo TEXT,
            ultimo_numero INTEGER DEFAULT 0
        );

        -- 🔥 AQUÍ AGREGAMOS LAS TABLAS DE DEUDAS FALTANTES 🔥
        CREATE TABLE IF NOT EXISTS clientes_maestro (
            id TEXT PRIMARY KEY,
            nombre TEXT NOT NULL,
            saldo_deuda REAL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS cuentas_por_cobrar (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_id TEXT NOT NULL,
            cliente_nombre TEXT,
            monto_bs REAL DEFAULT 0,
            monto_usd REAL DEFAULT 0,
            factura_nro TEXT,
            fecha TEXT,
            estado TEXT DEFAULT 'PENDIENTE'
        );
    `);


    const checkCorr = serverDb.prepare("SELECT COUNT(*) as count FROM correlativos_maestros").get();
        if (checkCorr.count === 0) {
            const insertStmt = serverDb.prepare("INSERT INTO correlativos_maestros (tipo, ultimo_numero, prefijo) VALUES (?, ?, ?)");
            
            // Inicialización de los 4 modos de Nexus POS
            insertStmt.run('TICKET_NO_FISCAL', 0, 'TICK-');
            insertStmt.run('FISCAL_HKA', 0, 'FIS-');
            insertStmt.run('FORMA_LIBRE', 0, 'FL-');
            insertStmt.run('ELECTRONICA', 0, 'TFHKA-');
        }

    server.use(cors());
    server.use(express.json({ limit: '100mb' }));

    console.log("👑 Cerebro Nexus POS: Servidor Maestro Activo (PM2).");

    // --- 1. ENDPOINT: TASAS BCV ---
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
                const row = serverDb.prepare('SELECT ultimo_numero, prefijo FROM correlativos_maestros WHERE tipo = ?').get(tipo);
                const nuevoNumero = (row ? row.ultimo_numero : 0) + 1;
                serverDb.prepare('UPDATE correlativos_maestros SET ultimo_numero = ? WHERE tipo = ?').run(nuevoNumero, tipo);
                return { 
                    numero: nuevoNumero, 
                    formato: `${row.prefijo}${String(nuevoNumero).padStart(8, '0')}` 
                };
            });
            res.json(transaccion());
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // server.js - Endpoint Maestro unificado
    server.post('/api/maestro/registrar-entrada', (req, res) => {
        const { items, sucursalId, companyId } = req.body; 
        
        try {
            const transaccion = serverDb.transaction((productos) => {
                for (const item of productos) {
                    // Usamos la sucursalId que viene en el cuerpo de la petición
                    const sId = sucursalId || item.sucursalId;
                    const cId = companyId || item.companyId;

                    const sql = item.operacion === 'FIJAR' 
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

                    serverDb.prepare(sql).run(item.id, sId, cId, item.cantidad);
                }
            });
            transaccion(items);
            res.json({ exito: true, mensaje: "Stock por sucursal actualizado." });
        } catch (e) {
            res.status(500).json({ exito: false, error: e.message });
        }
    });

    // --- 5. ENDPOINT: DESCONTAR STOCK GLOBAL (Ventas) ---
    server.post('/api/maestro/descontar-stock', (req, res) => {
        const { items } = req.body;
        try {
            const transaccion = serverDb.transaction((productos) => {
                for (const item of productos) {
                    const row = serverDb.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ?').get(item.id);
                    if (!row || row.cantidad_real < item.cantidad) {
                        // Ahora usa el nombre si viene en la petición, si no, usa el ID
                        throw new Error(`Stock insuficiente para: ${item.nombre || item.id}`);
                    }
                }
                const stmt = serverDb.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real - ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ?');
                for (const item of productos) { stmt.run(item.cantidad, item.id); }
            });
            transaccion(items);
            res.json({ exito: true });
        } catch (e) { 
            res.status(400).json({ exito: false, mensaje: e.message }); 
        }
    });

    // --- ENDPOINT: OBTENER STOCK MAESTRO (Para la tabla) ---
    server.get('/api/maestro/stock', (req, res) => {
        const { sucursalId, companyId } = req.query;
        try {
            const filas = serverDb.prepare(`
                SELECT producto_id, cantidad_real 
                FROM stock_maestro 
                WHERE sucursal_id = ? AND company_id = ?
            `).all(sucursalId, companyId);
            res.json(filas);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // server.js - Endpoint para recibir deudas de Laptops
    server.post('/api/maestro/registrar-deuda', (req, res) => {
        const { cliente_id, cliente_nombre, monto_bs, monto_usd, numero_factura, fecha } = req.body;
        
        // Rastreador visual en consola
        console.log(`\n📡 [API RED] Recibiendo deuda de Laptop para: ${cliente_nombre} por ${monto_bs} Bs`);
        
        try {
            const transaccion = serverDb.transaction(() => {
                // 1. Si el cliente no existe en el Maestro, lo creamos
                serverDb.prepare(`
                    INSERT OR IGNORE INTO clientes_maestro (id, nombre, saldo_deuda) VALUES (?, ?, 0)
                `).run(cliente_id, cliente_nombre);

                // 2. Insertar el ticket de la deuda
                serverDb.prepare(`
                    INSERT INTO cuentas_por_cobrar (cliente_id, cliente_nombre, monto_bs, monto_usd, factura_nro, fecha, estado)
                    VALUES (?, ?, ?, ?, ?, ?, 'PENDIENTE')
                `).run(cliente_id, cliente_nombre, monto_bs, monto_usd || 0, numero_factura, fecha);

                // 3. Sumar la deuda al saldo total del cliente
                serverDb.prepare(`
                    UPDATE clientes_maestro SET saldo_deuda = saldo_deuda + ? WHERE id = ?
                `).run(monto_bs, cliente_id);
            });

            transaccion();
            console.log(`✅ [API RED] Deuda guardada exitosamente en nexus-local-server.db`);
            res.json({ exito: true });
        } catch (e) {
            console.error(`❌ [API RED] Error al guardar deuda:`, e.message);
            res.status(500).json({ exito: false, mensaje: e.message });
        }
    });

// server.js - Endpoint para que las Laptops consulten la deuda de un cliente
server.get('/api/maestro/deuda-cliente/:rif', (req, res) => {
    try {
        const row = serverDb.prepare('SELECT saldo_deuda FROM clientes_maestro WHERE id = ?').get(req.params.rif);
        res.json({ exito: true, deuda: row ? row.saldo_deuda : 0 });
    } catch (e) {
        res.status(500).json({ exito: false, deuda: 0 });
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

// server.js - Endpoint para recibir abonos y restar deuda (Red)
    server.post('/api/maestro/registrar-abono', (req, res) => {
        const { cliente_id, monto_bs } = req.body;
        
        console.log(`\n📡 [API RED] Recibiendo ABONO de Laptop. Restando ${monto_bs} Bs al ID: ${cliente_id}`);
        
        try {
            const transaccion = serverDb.transaction(() => {
                // 1. Descontamos el saldo total del cliente
                serverDb.prepare(`
                    UPDATE clientes_maestro 
                    SET saldo_deuda = MAX(0, saldo_deuda - ?) 
                    WHERE id = ?
                `).run(monto_bs, cliente_id);
                
                // 2. Cambiamos el estado de las facturas de 'PENDIENTE' a 'PAGADO' para limpiar su historial visible
                serverDb.prepare(`
                    UPDATE cuentas_por_cobrar 
                    SET estado = 'PAGADO' 
                    WHERE cliente_id = ? AND estado = 'PENDIENTE'
                `).run(cliente_id);
            });

            transaccion(); // Ejecutamos ambas órdenes juntas
            console.log(`✅ [API RED] Deuda saldada y facturas actualizadas en nexus-local-server.db`);
            res.json({ exito: true });
        } catch (e) {
            console.error(`❌ [API RED] Error al procesar abono:`, e.message);
            res.status(500).json({ exito: false, mensaje: e.message });
        }
    });

server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n👑 [NEXUS MASTER] Cerebro Maestro inicializado.`);
        console.log(`📂 DB Maestra: ${serverDbPath}`);
        console.log(`🚀 Puerto: ${PORT} (Disponible para la red local)`);
    });

} else {
    console.log("💻 [NEXUS NODO] Esta máquina está configurada como CLIENTE. Servidor Maestro desactivado.");
}