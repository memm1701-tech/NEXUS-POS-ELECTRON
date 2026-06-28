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
const localDbPath = path.join(dbDir, 'nexus_pos.db');
const localDb = new Database(localDbPath);

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
        ultimo_numero INTEGER DEFAULT 0,
        correlativo_nc_actual INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS clientes_maestro (
        rif TEXT PRIMARY KEY,
        company_id TEXT,
        nombre TEXT NOT NULL,
        direccion TEXT,
        telefono TEXT,
        correo TEXT,
        datos_json TEXT,
        es_contribuyente_especial INTEGER DEFAULT 0,
        estado_sync INTEGER DEFAULT 0,
        fecha_modificacion DATETIME DEFAULT CURRENT_TIMESTAMP,
        saldo_deuda REAL DEFAULT 0
    );


    CREATE TABLE IF NOT EXISTS cuentas_por_cobrar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id TEXT NOT NULL,
        cliente_nombre TEXT,
        monto_bs REAL DEFAULT 0,
        monto_usd REAL DEFAULT 0,
        factura_nro TEXT,
        monto_pagado REAL DEFAULT 0,
        fecha TEXT,
        estado TEXT DEFAULT 'PENDIENTE'
    );


    CREATE TABLE IF NOT EXISTS facturas_borradores (
        id TEXT PRIMARY KEY,
        cliente_nombre TEXT,
        cliente_id TEXT,
        items TEXT,
        subtotal REAL,
        iva REAL,
        total REAL,
        metodos_pago TEXT,
        fecha INTEGER,
        usuario_id TEXT,
        sucursal_id TEXT,
        company_id TEXT
    );

        CREATE TABLE IF NOT EXISTS cierres_caja_maestros (
        id TEXT PRIMARY KEY,
        fecha DATETIME,
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
        detalle_pagos_json TEXT
    );

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


    CREATE TABLE IF NOT EXISTS configuraciones_maestras (
        clave TEXT PRIMARY KEY, 
        valor TEXT
    );

    CREATE TABLE IF NOT EXISTS claves_admin_maestras (
            id TEXT PRIMARY KEY,
            ownerName TEXT,
            encryptedCode TEXT,
            company_id TEXT,
            created_by TEXT,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS guia_despacho (
        id TEXT PRIMARY KEY,
        company_id TEXT,
        branch_id TEXT,
        cashier_id TEXT,
        numero_guia TEXT,
        numero_control TEXT,
        cliente_nombre TEXT,
        cliente_rif TEXT,
        factura_asociada TEXT,
        fecha_emision DATETIME DEFAULT CURRENT_TIMESTAMP,
        datos_json TEXT,
        estado_sync INTEGER DEFAULT 0
    );

    `);


const checkCorr = serverDb.prepare("SELECT COUNT(*) as count FROM correlativos_maestros").get();

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
                fecha DATETIME DEFAULT CURRENT_TIMESTAMP
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
            const stmt = serverDb.prepare(`
                INSERT INTO claves_admin_maestras (id, ownerName, encryptedCode, company_id, created_by, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            stmt.run(c.id, c.ownerName, c.encryptedCode, c.company_id, c.created_by, c.updatedAt);
            res.json({ exito: true });
        } catch (e) {
            console.error("❌ Error guardando clave en Maestro:", e.message);
            res.status(500).json({ exito: false, error: e.message });
        }
    });

    server.get('/api/maestro/obtener-claves-admin/:companyId', (req, res) => {
        try {
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

server.get('/api/maestro/configuracion/:clave', (req, res) => {
    try {
        // La clave será "isSujetoEspecial" según la URL que consultes
        const clave = req.params.clave;
        
        // Consultamos la tabla correcta de la base de datos local
        const query = `SELECT valor FROM configuracion WHERE clave = ?`;
        
        // Usamos localDb (que apunta a nexus_pos.db)
        const registro = localDb.prepare(query).get(clave);

        if (registro) {
            res.json({ exito: true, valor: registro.valor });
        } else {
            res.json({ exito: true, valor: null }); 
        }

    } catch (error) {
        console.error("❌ Error leyendo config desde nexus_pos.db:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});


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
                else if (tipo === 'RETENCION_IVA') prefijo = 'RET-';
                else if (tipo === 'GUIA_DESPACHO') prefijo = 'GD-'; // <--- NUEVO
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

    server.post('/api/maestro/registrar-entrada', (req, res) => {
        const { items, sucursalId, companyId } = req.body; 
        
        console.log(`\n📦 [API MAESTRO] --- NUEVA PETICIÓN DE ALTERACIÓN DE STOCK ---`);
        console.log(`➡️ Sucursal Petición: ${sucursalId || 'No enviada'} | Empresa: ${companyId || 'No enviada'}`);

        try {
            const transaccion = serverDb.transaction((productos) => {
                for (const item of productos) {
                    // Usamos la sucursalId que viene en el cuerpo de la petición
                    const sId = sucursalId || item.sucursalId;
                    const cId = companyId || item.companyId;

                    // 🔥 LOG ESTRICTO PARA AUDITORÍA 🔥
                    console.log(`🔹 Procesando Item ID: ${item.id}`);
                    console.log(`   - Cantidad recibida (Para operar): ${item.cantidad}`);
                    console.log(`   - Operación: ${item.operacion}`);
                    console.log(`   - Sucursal destino: ${sId}`);

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
                    console.log(`✅ Base de datos actualizada para: ${item.id}`);
                }
            });
            transaccion(items);
            console.log(`🏁 Transacción finalizada con éxito.\n`);
            res.json({ exito: true, mensaje: "Stock por sucursal actualizado." });
        } catch (e) {
            console.error("❌ Error en servidor Maestro (registrar-entrada):", e.message);
            res.status(500).json({ exito: false, error: e.message });
        }
    });

    // --- 5. ENDPOINT: DESCONTAR STOCK GLOBAL (Ventas) ---
    // --- 5. ENDPOINT: DESCONTAR STOCK GLOBAL (Ventas) ---
    server.post('/api/maestro/descontar-stock', (req, res) => {
        const { items, sucursalId } = req.body; // Aseguramos capturar sucursalId si viene
        
        console.log(`\n🛒 [API MAESTRO] --- NUEVA PETICIÓN DE VENTA (DESCUENTO) ---`);
        
        try {
            const transaccion = serverDb.transaction((productos) => {
                // Validación previa
                for (const item of productos) {
                    const sIdTarget = sucursalId || item.sucursalId;
                    
                    let row;
                    if (sIdTarget) {
                        row = serverDb.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ? AND sucursal_id = ?').get(item.id, sIdTarget);
                    } else {
                        // Si no mandan sucursal, buscamos globalmente (Peligroso si hay varias sucursales)
                        row = serverDb.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ?').get(item.id);
                    }

                    if (!row || row.cantidad_real < item.cantidad) {
                        throw new Error(`Stock insuficiente para: ${item.nombre || item.id}. Actual: ${row ? row.cantidad_real : 0}, Solicitado: ${item.cantidad}`);
                    }
                }
                
                // Descuento real
                for (const item of productos) { 
                    const sIdTarget = sucursalId || item.sucursalId;
                    console.log(`📉 VENTA - DESCONTANDO: ${item.cantidad} unidades | ID: ${item.id}`);
                    console.log(`   - Sucursal afectada: ${sIdTarget || 'TODAS LAS SUCURSALES (Advertencia)'}`);
                    
                    if (sIdTarget) {
                        // 🔥 FIX: Actualiza SOLO en la sucursal donde se hizo la venta
                        serverDb.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real - ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ? AND sucursal_id = ?').run(item.cantidad, item.id, sIdTarget);
                    } else {
                        // Lógica anterior (puede causar descuento doble si el producto está en 2 sucursales)
                        serverDb.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real - ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ?').run(item.cantidad, item.id);
                    }
                }
            });
            transaccion(items);
            console.log(`✅ [API MAESTRO] Descuento de stock por venta exitoso.\n`);
            res.json({ exito: true });
        } catch (e) { 
            console.error("❌ [API MAESTRO] Error en descuento global:", e.message);
            res.status(400).json({ exito: false, mensaje: e.message }); 
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

    // server.js - Endpoint para recibir deudas de Laptops
    server.post('/api/maestro/registrar-deuda', (req, res) => {
        const { cliente_id, cliente_nombre, monto_bs, monto_usd, numero_factura, fecha } = req.body;
        
        // Rastreador visual en consola
        console.log(`\n📡 [API RED] Recibiendo deuda de Laptop para: ${cliente_nombre} por ${monto_bs} Bs`);
        
        try {
            const transaccion = serverDb.transaction(() => {
                // 1. Si el cliente no existe en el Maestro, lo creamos (CAMBIO A RIF)
                serverDb.prepare(`
                    INSERT OR IGNORE INTO clientes_maestro (rif, nombre, saldo_deuda) VALUES (?, ?, 0)
                `).run(cliente_id, cliente_nombre);

                // 2. Insertar el ticket de la deuda
                serverDb.prepare(`
                    INSERT INTO cuentas_por_cobrar (cliente_id, cliente_nombre, monto_bs, monto_usd, factura_nro, fecha, estado)
                    VALUES (?, ?, ?, ?, ?, ?, 'PENDIENTE')
                `).run(cliente_id, cliente_nombre, monto_bs, monto_usd || 0, numero_factura, fecha);

                // 3. Sumar la deuda al saldo total del cliente (CAMBIO A RIF)
                serverDb.prepare(`
                    UPDATE clientes_maestro SET saldo_deuda = saldo_deuda + ? WHERE rif = ?
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


server.get('/api/maestro/consultar-deuda/:rif', (req, res) => {
    const rif = req.params.rif;
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const tasaActual = config.tasa_bcv || 1;

        // 🔥 AHORA TRAEMOS TODAS LAS FACTURAS (PAGADAS Y PENDIENTES)
        const facturasHistorial = serverDb.prepare(`
            SELECT 
                factura_nro,
                fecha,
                monto_bs,  
                monto_usd,
                monto_pagado,
                estado
            FROM cuentas_por_cobrar 
            WHERE cliente_id = ? 
            ORDER BY fecha DESC -- Las más recientes arriba
        `).all(rif);

        if (facturasHistorial.length > 0) {
            let saldo_total_usd = 0;
            
            facturasHistorial.forEach(f => {
                const usdReal = (f.monto_usd && f.monto_usd > 0) ? f.monto_usd : parseFloat((f.monto_bs / tasaActual).toFixed(2));
                f.monto_usd = usdReal; 
                
                // Solo sumamos al "Total Pendiente" lo que aún se debe
                if (f.estado !== 'PAGADA') {
                    saldo_total_usd += (usdReal - (f.monto_pagado || 0));
                }
            });
            
            const montoEnBs = saldo_total_usd * tasaActual;

            res.json({ 
                existe: true, 
                monto_bs: montoEnBs, 
                monto_deuda_usd: saldo_total_usd,
                detalles: facturasHistorial 
            });
        } else {
            res.json({ existe: false, monto_bs: 0, monto_deuda_usd: 0, detalles: [] });
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
    const { cliente_id, monto_bs, tasa } = req.body;
    
    console.log(`\n💳 [API MAESTRO] --- NUEVO PAGO DE DEUDA RECIBIDO ---`);
    console.log(`   - Cliente ID: ${cliente_id}`);
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

        const deudas = serverDb.prepare(`
            SELECT * FROM cuentas_por_cobrar 
            WHERE cliente_id = ? AND estado = 'PENDIENTE'
            ORDER BY fecha ASC
        `).all(cliente_id);

        if (deudas.length === 0) {
            console.log(`   - ⚠️ El cliente no tiene deudas en estado PENDIENTE.`);
            return res.json({ exito: false, mensaje: "Sin deudas." });
        }

        console.log(`   - 📋 Facturas pendientes encontradas: ${deudas.length}`);

        const procesoCascada = serverDb.transaction((lista, montoAPagarUSD, montoAPagarBs) => {
            const update = serverDb.prepare(`UPDATE cuentas_por_cobrar SET monto_pagado = ?, estado = ? WHERE id = ?`);
            let saldoRestantePago = montoAPagarUSD;

            for (let factura of lista) {
                if (saldoRestantePago <= 0) break;

                // 🔥 REPARACIÓN AL VUELO: Si la factura vieja está corrupta (0 USD), la reparamos usando sus Bs.
                const originalUSD = (factura.monto_usd && factura.monto_usd > 0) 
                    ? factura.monto_usd 
                    : parseFloat((factura.monto_bs / rate).toFixed(2));

                const yaPagadoUSD = factura.monto_pagado || 0;
                const loQueFaltaUSD = parseFloat((originalUSD - yaPagadoUSD).toFixed(2));

                console.log(`      > Evaluando Factura ${factura.factura_nro} | Debe: $${loQueFaltaUSD} | Saldo en mano: $${saldoRestantePago}`);

                if (loQueFaltaUSD <= 0) {
                    update.run(originalUSD, 'PAGADA', factura.id);
                    continue;
                }

                if (saldoRestantePago >= loQueFaltaUSD) {
                    console.log(`        ✅ Pagando COMPLETA la factura ${factura.factura_nro}.`);
                    update.run(originalUSD, 'PAGADA', factura.id);
                    saldoRestantePago = parseFloat((saldoRestantePago - loQueFaltaUSD).toFixed(2));
                } else {
                    const nuevoAcumuladoUSD = parseFloat((yaPagadoUSD + saldoRestantePago).toFixed(2));
                    console.log(`        ⏳ Pago PARCIAL en factura ${factura.factura_nro}. Se abonó $${saldoRestantePago}. Acumulado total pagado: $${nuevoAcumuladoUSD}`);
                    update.run(nuevoAcumuladoUSD, 'PENDIENTE', factura.id);
                    saldoRestantePago = 0;
                }
            }

            // Actualizar el historial global del cliente
            serverDb.prepare(`
                UPDATE clientes_maestro 
                SET saldo_deuda = MAX(0, saldo_deuda - ?) 
                WHERE rif = ?
            `).run(montoAPagarBs, cliente_id);
        });

        procesoCascada(deudas, abonoUSD, monto_bs);
        console.log(`✅ [API MAESTRO] Cascada de pagos finalizada con éxito.\n`);
        res.json({ exito: true, mensaje: "Abono aplicado correctamente." });

    } catch (e) {
        console.error("❌ Error en registrar-abono:", e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

server.post('/api/maestro/guardar-cliente', (req, res) => {
    const cliente = req.body;
    try {
        const stmt = serverDb.prepare(`
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

        res.json({ success: true });
    } catch (error) {
        console.error("❌ Error guardando cliente en Maestro:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

server.get('/api/maestro/obtener-clientes', (req, res) => {
    try {
        const clientes = serverDb.prepare('SELECT * FROM clientes_maestro ORDER BY nombre ASC').all();
        res.json(clientes);
    } catch (error) {
        console.error("❌ Error obteniendo clientes del Maestro:", error.message);
        res.status(500).json({ error: error.message });
    }
});

server.delete('/api/maestro/eliminar-cliente/:rif', (req, res) => {
    try {
        serverDb.prepare('DELETE FROM clientes_maestro WHERE rif = ?').run(req.params.rif);
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

server.get('/api/maestro/borradores-stream', (req, res) => {
    // Configuramos la respuesta como un flujo continuo (túnel abierto)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    cajasEscuchando.push(res); // Registramos la computadora que se conectó

    // Si la caja se apaga o cierra, la quitamos de la lista
    req.on('close', () => {
        cajasEscuchando = cajasEscuchando.filter(caja => caja !== res);
    });
});

server.get('/api/cuentas_por_cobrar', (req, res) => {
    try {
        const sql = `SELECT * FROM cuentas_por_cobrar ORDER BY fecha DESC`;
        const rows = serverDb.prepare(sql).all();
        res.json(rows);
    } catch (error) {
        console.error("❌ Error consultando la tabla cuentas_por_cobrar:", error.message);
        res.status(500).json({ error: "Error al extraer las deudas." });
    }
});

// Endpoint para recibir cierres de las laptops de la red
server.post('/api/maestro/registrar-cierre', (req, res) => {
    const c = req.body;
    console.log(`\n🏁 [API MAESTRO] Recibiendo Cierre Z de Caja: ${c.cashierId} | Sucursal: ${c.branchId}`);

    try {
        const stmt = serverDb.prepare(`
            INSERT INTO cierres_caja_maestros (
                id, fecha, company_id, branch_id, cashier_id,
                total_ventas_bs, total_ventas_usd, total_gastos_bs,
                total_gastos_usd, total_ingresos_bs, total_diferencia_bs,
                total_diferencia_usd, detalle_pagos_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            c.id,
            c.fecha,
            c.companyId,
            c.branchId,
            c.cashierId,
            c.totalSalesBs,
            c.totalSalesDollars,
            c.totalExpensesBs,
            c.totalExpensesDollars,
            c.totalIncomes,
            c.totalDifferenceBs,
            c.totalDifferenceDollars,
            c.paymentsConciliation
        );

        console.log(`✅ Cierre ${c.id} guardado en Servidor Maestro.`);
        res.json({ exito: true });
    } catch (e) {
        console.error("❌ Error guardando cierre en Maestro:", e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

server.post('/api/maestro/registrar-venta', (req, res) => {
    const v = req.body;
    console.log(`\n🛒 [API MAESTRO] Recibiendo Venta/NC: ${v.numero_factura} de Sucursal: ${v.branch_id}`);

    try {
        const stmt = serverDb.prepare(`
            INSERT INTO ventas_locales (
                id, company_id, branch_id, cashier_id, numero_factura, 
                numero_control, cliente_nombre, cliente_rif, monto_exento, 
                base_imponible, monto_iva, monto_igtf, monto_total, 
                tasa_bcv, metodo_pago, datos_json, estado_sync, estado_cierre
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
        `);

        stmt.run(
            v.id, v.company_id, v.branch_id, v.cashier_id, v.numero_factura,
            v.numero_control, v.cliente_nombre, v.cliente_rif, v.monto_exento,
            v.base_imponible, v.monto_iva, v.monto_igtf, v.monto_total,
            v.tasa_bcv, v.metodo_pago, v.datos_json
        );

        res.json({ exito: true });
    } catch (e) {
        console.error("❌ Error guardando venta en Maestro:", e.message);
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

server.get('/api/maestro/estadisticas/pagos-mes', (req, res) => {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ error: "companyId requerido" });

    try {
        // Usamos un filtro de texto directo que es más compatible con formatos ISO
        // Y forzamos los nombres de las columnas con AS para asegurar el mapeo
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
            WHERE company_id = ? 
            AND fecha >= date('now', 'start of month')
            AND fecha <= date('now', '+1 day')
        `;

        const rows = serverDb.prepare(query).all(companyId);
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
        caja.write(`data: CAMBIO_DETECTADO\n\n`);
    });
}