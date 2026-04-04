const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const server = express();
const PORT = 3000;

const dbDir = path.join(__dirname, 'data');
const configPath = path.join(dbDir, 'config.json');
const serverDbPath = path.join(dbDir, 'nexus-local-server.db');

// Leer configuración
let config = { isServer: false };
if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

if (config.isServer) {
    const serverDb = new Database(serverDbPath);
    serverDb.pragma('journal_mode = WAL');
    
    server.use(cors());
    server.use(express.json({ limit: '100mb' }));

    console.log("👑 Cerebro Nexus POS: Servidor Maestro Activo (PM2).");

    // --- 1. ENDPOINT: TASAS BCV (Centralizado para toda la red) ---
// Ruta de tasas: SIEMPRE disponible para el consumo local del HTML
server.get('/api/tasas', async (req, res) => {
    const url = 'https://www.bcv.org.ve/';
    try {
        console.log("🌐 Nexus POS: Solicitando tasas al BCV...");
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

        if (Object.keys(rates).length === 0) throw new Error("Estructura BCV no encontrada");

        console.log("✅ Tasas BCV obtenidas correctamente.");
        res.json({ rates });
    } catch (error) {
        console.error('❌ Error Scraping BCV:', error.message);
        res.status(500).json({ error: 'No se pudieron obtener las tasas.' });
    }
});

    // --- 2. ENDPOINT: SINCRONIZAR DESDE XEON (Nube a Maestro) ---
    server.post('/api/sincronizar-desde-xeon', (req, res) => {
        const productos = req.body; 
        try {
            // Nota: Aquí se guarda en la DB MAESTRA de stock, no en la local de la caja
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
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Agrega esto en tu server.js, por ejemplo debajo de "const PORT = 3000;"
        const axiosConfigBCV = {
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        };

    // --- 3. ENDPOINT: OBTENER CORRELATIVO MAESTRO ---
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

    // --- 4. ENDPOINT: DESCONTAR STOCK GLOBAL ---
    server.post('/api/maestro/descontar-stock', (req, res) => {
        const { items } = req.body;
        try {
            const transaccion = serverDb.transaction((productos) => {
                for (const item of productos) {
                    const row = serverDb.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ?').get(item.id);
                    if (!row || row.cantidad_real < item.cantidad) {
                        throw new Error(`Stock insuficiente para ID: ${item.id}`);
                    }
                }
                const stmt = serverDb.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real - ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ?');
                for (const item of productos) { stmt.run(item.cantidad, item.id); }
            });
            transaccion(items);
            res.json({ exito: true });
        } catch (e) { res.status(400).json({ exito: false, mensaje: e.message }); }
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Servidor Maestro escuchando en el puerto ${PORT}`);
    });
}