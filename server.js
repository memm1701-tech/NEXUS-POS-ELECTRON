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
const posDbPath = path.join(dbDir, 'nexus_pos.db');

let posDb = null;
function getPosDb() {
    if (!posDb && fs.existsSync(posDbPath)) {
        try {
            posDb = new Database(posDbPath, { timeout: 15000 });
            posDb.pragma('journal_mode = WAL');
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
    getPosDb();
    
    // Inicialización de Tablas Maestras automatizada con ESQUEMA_MAESTRO
    // Inicialización de Tablas Maestras automatizada con ESQUEMA_MAESTRO
    const ESQUEMA_MAESTRO = {
        stock_maestro: { producto_id: "TEXT", sucursal_id: "TEXT", company_id: "TEXT", cantidad_real: "REAL DEFAULT 0", ultima_sincronizacion: "DATETIME DEFAULT CURRENT_TIMESTAMP", "PRIMARY KEY": "(producto_id, sucursal_id)" },
        movimientos_stock_maestro: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", company_id: "TEXT NOT NULL", sucursal_id: "TEXT", producto_id: "TEXT NOT NULL", cantidad: "REAL DEFAULT 0", tipo_movimiento: "TEXT", fecha_movimiento: "DATETIME DEFAULT CURRENT_TIMESTAMP", referencia_id: "TEXT", estado_sync: "INTEGER DEFAULT 0" },
        correlativos_maestros: { tipo: "TEXT PRIMARY KEY", prefijo: "TEXT DEFAULT ''", ultimo_numero: "INTEGER DEFAULT 0", correlativo_nc_actual: "INTEGER DEFAULT 0" },
        clientes_maestro: { rif: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT NOT NULL", direccion: "TEXT", telefono: "TEXT", correo: "TEXT", datos_json: "TEXT", es_contribuyente_especial: "INTEGER DEFAULT 0", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP", saldo_deuda: "REAL DEFAULT 0" },
        cuentas_por_cobrar: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", cliente_id: "TEXT", cliente_nombre: "TEXT", monto_bs: "REAL DEFAULT 0", monto_usd: "REAL DEFAULT 0", factura_nro: "TEXT", monto_pagado: "REAL DEFAULT 0", fecha: "TEXT", estado: "TEXT DEFAULT 'PENDIENTE'" },
        facturas_borradores: { id: "TEXT PRIMARY KEY", cliente_nombre: "TEXT", cliente_id: "TEXT", items: "TEXT", subtotal: "REAL DEFAULT 0", iva: "REAL DEFAULT 0", total: "REAL DEFAULT 0", metodos_pago: "TEXT", fecha: "INTEGER", usuario_id: "TEXT", sucursal_id: "TEXT", company_id: "TEXT" },
        cierres_caja_maestros: { id: "TEXT PRIMARY KEY", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", total_ventas_bs: "REAL DEFAULT 0", total_ventas_usd: "REAL DEFAULT 0", total_gastos_bs: "REAL DEFAULT 0", total_gastos_usd: "REAL DEFAULT 0", total_ingresos_bs: "REAL DEFAULT 0", total_diferencia_bs: "REAL DEFAULT 0", total_diferencia_usd: "REAL DEFAULT 0", detalle_pagos_json: "TEXT" },
        ventas_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_factura: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", monto_exento: "REAL DEFAULT 0", base_imponible: "REAL DEFAULT 0", monto_iva: "REAL DEFAULT 0", total_iva: "REAL DEFAULT 0", monto_igtf: "REAL DEFAULT 0", monto_total: "REAL DEFAULT 0", tasa_bcv: "REAL DEFAULT 1", metodo_pago: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_emision: "DATETIME DEFAULT CURRENT_TIMESTAMP", estado_cierre: "INTEGER DEFAULT 0", es_nota_credito: "INTEGER DEFAULT 0", es_nota_debito: "INTEGER DEFAULT 0", factura_afectada: "TEXT", monto_factura_afectada: "REAL DEFAULT 0", fecha_factura_afectada: "TEXT", comprobante_retencion_id: "TEXT DEFAULT NULL", ganancia_venta: "REAL DEFAULT 0" },
        configuraciones_maestras: { clave: "TEXT PRIMARY KEY", valor: "TEXT" },
        auditoria_fiscal: { id: "TEXT PRIMARY KEY", usuario: "TEXT", accion: "TEXT", valores: "TEXT", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
        metodos_pago_maestro: { id: "TEXT PRIMARY KEY", nombre: "TEXT NOT NULL", tecla: "TEXT", tipo_moneda: "TEXT DEFAULT 'BS'", activo: "INTEGER DEFAULT 1", flag_impresora: "TEXT DEFAULT '00'" },
        claves_admin_maestras: { id: "TEXT PRIMARY KEY", ownerName: "TEXT", encryptedCode: "TEXT", company_id: "TEXT", created_by: "TEXT", updatedAt: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
        guia_despacho: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_guia: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", factura_asociada: "TEXT", fecha_emision: "DATETIME DEFAULT CURRENT_TIMESTAMP", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0" },
        guias_despacho: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_guia: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", factura_asociada: "TEXT", datos_json: "TEXT", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
        empleados: { ID_empleado: "TEXT PRIMARY KEY", nombre: "TEXT", cedula: "TEXT", cargo: "TEXT", sueldo_base: "REAL DEFAULT 0", telefono: "TEXT", sucursal: "TEXT", saldo_pendiente: "REAL DEFAULT 0", estado_sync: "INTEGER DEFAULT 0", fecha_creacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
        proveedores: { rif: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", telefono: "TEXT", contacto: "TEXT", direccion: "TEXT", saldo_deuda: "REAL DEFAULT 0", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
        movimientos_cuentas_pagar: { id: "TEXT PRIMARY KEY", proveedor_rif: "TEXT", motivo: "TEXT", nota: "TEXT", monto: "REAL DEFAULT 0", company_id: "TEXT", comprobante: "TEXT", estado: "TEXT DEFAULT 'PENDIENTE'", monto_abonado: "REAL DEFAULT 0", metodo_pago: "TEXT", referencia: "TEXT", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP", estado_sync: "INTEGER DEFAULT 0" },
        empleados_movimientos: { id: "TEXT PRIMARY KEY", empleado_id: "TEXT", motivo: "TEXT", razon: "TEXT", monto: "REAL DEFAULT 0", company_id: "TEXT", fecha: "DATETIME DEFAULT CURRENT_TIMESTAMP", estado_sync: "INTEGER DEFAULT 0" },
        productos_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", codigo: "TEXT", nombre: "TEXT", precio: "REAL DEFAULT 0", precio_compra: "REAL DEFAULT 0", porcentaje_ganancia: "REAL DEFAULT 0", categoria: "TEXT", status: "INTEGER DEFAULT 1", imagen: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
        categorias_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
        sucursales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", direccion: "TEXT", telefono: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "TEXT" },
        unidades_empaque: { id: "TEXT PRIMARY KEY", company_id: "TEXT", product_id: "TEXT", nombre_producto: "TEXT DEFAULT ''", nombre_unidad: "TEXT", tipo_medida: "TEXT", factor_cantidad: "REAL DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP", ultima_sincronizacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
        historial_tasas: { fecha: "DATE PRIMARY KEY", valor: "DECIMAL(18, 8) DEFAULT 0", fuente: "TEXT DEFAULT 'BCV'" },
        comprobantes_retencion: { id: "TEXT PRIMARY KEY", datos_json: "TEXT", fecha_registro: "DATETIME DEFAULT CURRENT_TIMESTAMP", estatus: "TEXT DEFAULT 'EMITIDO'" },
        salidas_inventario: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", product_id: "TEXT", cantidad: "REAL DEFAULT 0", unidad: "TEXT", motivo: "TEXT", observacion: "TEXT", usuario_id: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
        entradas_inventario: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", product_id: "TEXT", cantidad: "REAL DEFAULT 0", costo_unitario: "REAL DEFAULT 0", precio_venta: "REAL DEFAULT 0", proveedor_id: "TEXT", factura_referencia: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT CURRENT_TIMESTAMP" }
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
                                dbConnection.prepare(`UPDATE ${tabla} SET ${colName} = datetime('now', 'localtime') WHERE ${colName} IS NULL`).run();
                            } catch(eUp) {}
                        }
                        console.log(`[DB AUTO-SYNC] Columna añadida: '${colName}' (${cleanType}) en la tabla '${tabla}'`);
                    } catch (error) {
                        console.error(`[DB AUTO-SYNC] Error añadiendo columna '${colName}' a '${tabla}':`, error.message);
                    }
                }
            }
        }
    }

    asegurarEsquema(serverDb, ESQUEMA_MAESTRO);


const checkCorr = serverDb.prepare("SELECT COUNT(*) as count FROM correlativos_maestros").get();

const checkPagos = serverDb.prepare("SELECT COUNT(*) as count FROM metodos_pago_maestro").get();
if (checkPagos.count === 0) {
    console.log("⚠️ Inicializando métodos de pago por defecto...");
    const defaultMethods = [
        { id: '1000001', nombre: 'Efectivo', tecla: 'F5', tipo_moneda: 'BS', activo: 1, flag_impresora: '01' },
        { id: '1000002', nombre: 'Débito', tecla: 'F6', tipo_moneda: 'BS', activo: 1, flag_impresora: '12' },
        { id: '1000003', nombre: 'Pago Móvil', tecla: 'F7', tipo_moneda: 'BS', activo: 1, flag_impresora: '07' },
        { id: '1000004', nombre: 'Biopago', tecla: 'F8', tipo_moneda: 'BS', activo: 1, flag_impresora: '08' },
        { id: '1000005', nombre: 'Dólares Físicos', tecla: 'F9', tipo_moneda: 'USD', activo: 1, flag_impresora: '20' },
        { id: '1000008', nombre: 'Crédito', tecla: 'F12', tipo_moneda: 'BS', activo: 1, flag_impresora: '08' }
    ];
    const stmtPagos = serverDb.prepare(`INSERT INTO metodos_pago_maestro (id, nombre, tecla, tipo_moneda, activo, flag_impresora) VALUES (?, ?, ?, ?, ?, ?)`);
    serverDb.transaction(() => {
        for (const m of defaultMethods) {
            stmtPagos.run(m.id, m.nombre, m.tecla, m.tipo_moneda, m.activo, m.flag_impresora);
        }
    })();
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
                } catch(e) {}
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
            fecha || new Date().toISOString()
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
        res.json({ exito: true, data: stmt.all() });
    } catch (error) {
        console.error("❌ Error al leer metodos de pago:", error.message);
        res.status(500).json({ exito: false, error: error.message });
    }
});

server.post('/api/maestro/metodos-pago', (req, res) => {
    try {
        const { id, nombre, tecla, tipo_moneda, activo, flag_impresora } = req.body;
        // Generar un ID numérico aleatorio de 7 dígitos si no existe
        const finalId = id || Math.floor(1000000 + Math.random() * 9000000).toString();
        
        const stmt = serverDb.prepare(`
            INSERT INTO metodos_pago_maestro (id, nombre, tecla, tipo_moneda, activo, flag_impresora) 
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET 
                nombre = excluded.nombre,
                tecla = excluded.tecla,
                tipo_moneda = excluded.tipo_moneda,
                activo = excluded.activo,
                flag_impresora = excluded.flag_impresora
        `);
        stmt.run(finalId, nombre, tecla || null, tipo_moneda || 'BS', activo !== undefined ? activo : 1, flag_impresora || '00');
        res.json({ exito: true, id: finalId });
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
                try { process.send({ tipo: 'stock-actualizado' }); } catch(e) {}
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
                        } catch(e) {}
                    }
                    console.log(`✅ [stock/actualizar] Item: ${itemId} | Op: ${op} | Cant: ${cant} | Dif: ${diferencia}`);
                }
            });

            transaccion(items);

            if (process.send) {
                try { process.send({ tipo: 'stock-actualizado' }); } catch(e) {}
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
        const refFactura = factura_ref || '';
        const tipoMovimiento = tipo_movimiento || 'VENTA';
        
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ exito: false, error: "Payload incompleto" });
        }

        console.log(`\n🛒 [API MAESTRO] --- NUEVA PETICIÓN DE VENTA (DESCUENTO) ---`);
        
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
                        } catch(e) {}
                    } else {
                        serverDb.prepare('UPDATE stock_maestro SET cantidad_real = cantidad_real - ?, ultima_sincronizacion = CURRENT_TIMESTAMP WHERE producto_id = ?').run(item.cantidad, itemId);
                        try {
                            serverDb.prepare(`INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento, referencia_id) VALUES (?, ?, ?, ?, ?, ?)`)
                                    .run(compId, 'GLOBAL', itemId, -Math.abs(item.cantidad), tipoMovimiento, refFactura);
                        } catch(e) {}
                    }
                }
            });
            transaccion(items);
            console.log(`✅ [API MAESTRO] Descuento de stock por venta exitoso.\n`);
            if (process.send) {
                try { process.send({ tipo: 'stock-actualizado' }); } catch(e) {}
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
        const sucursales = serverDb.prepare("SELECT * FROM sucursales WHERE company_id = ?").all(companyId);
        res.json(sucursales);
    } catch (e) {
        res.json([]);
    }
});

server.get('/api/maestro/sucursales', (req, res) => {
    const { empresaId, companyId } = req.query;
    const comp = empresaId || companyId;
    try {
        if (comp) {
            const sucursales = serverDb.prepare("SELECT * FROM sucursales WHERE company_id = ?").all(comp);
            res.json(sucursales);
        } else {
            const sucursales = serverDb.prepare("SELECT * FROM sucursales").all();
            res.json(sucursales);
        }
    } catch (e) {
        res.json([]);
    }
});

server.post('/api/maestro/sucursales/sincronizar', (req, res) => {
    const sucursal = req.body;
    try {
        const stmt = serverDb.prepare(`
            INSERT INTO sucursales (id, company_id, nombre, direccion, telefono, estado_sync, fecha_modificacion)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                nombre = excluded.nombre,
                direccion = excluded.direccion,
                telefono = excluded.telefono,
                fecha_modificacion = excluded.fecha_modificacion,
                estado_sync = excluded.estado_sync
        `);
        stmt.run(
            sucursal.id,
            sucursal.company_id || sucursal.empresa_ID,
            sucursal.nombre,
            sucursal.direccion,
            sucursal.telefono,
            1,
            sucursal.fecha_modificacion || new Date().toISOString()
        );
        res.json({ exito: true, success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

server.delete('/api/maestro/sucursales/:id', (req, res) => {
    const { id } = req.params;
    try {
        serverDb.prepare("DELETE FROM sucursales WHERE id = ?").run(id);
        res.json({ exito: true });
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
        let clientes = serverDb.prepare('SELECT * FROM clientes_maestro ORDER BY nombre ASC').all();
        if ((!clientes || clientes.length === 0) && getPosDb()) {
            try {
                clientes = getPosDb().prepare('SELECT * FROM clientes_locales ORDER BY nombre ASC').all();
            } catch(e) {}
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
                WHERE rif LIKE ? 
                   OR REPLACE(REPLACE(UPPER(rif), '-', ''), ' ', '') LIKE ?
                   OR UPPER(nombre) LIKE ? 
                   OR telefono LIKE ?
                ORDER BY nombre ASC LIMIT 30
            `);
            results = stmt.all(term, cleanTerm, `%${query.toUpperCase()}%`, term);
        } catch(eDb) {}

        if ((!results || results.length === 0) && getPosDb()) {
            try {
                const stmtLocal = getPosDb().prepare(`
                    SELECT * FROM clientes_locales 
                    WHERE rif LIKE ? 
                       OR REPLACE(REPLACE(UPPER(rif), '-', ''), ' ', '') LIKE ?
                       OR UPPER(nombre) LIKE ? 
                       OR telefono LIKE ?
                    ORDER BY nombre ASC LIMIT 30
                `);
                results = stmtLocal.all(term, cleanTerm, `%${query.toUpperCase()}%`, term);
            } catch(ePos) {}
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
        const empresaId = req.query.empresaId;
        const activeDb = getPosDb() || serverDb;
        let stmt;
        if (empresaId && empresaId !== 'undefined') {
            stmt = activeDb.prepare('SELECT * FROM categorias_locales WHERE company_id = ? ORDER BY nombre ASC');
            res.json(stmt.all(empresaId));
        } else {
            stmt = activeDb.prepare('SELECT * FROM categorias_locales ORDER BY nombre ASC');
            res.json(stmt.all());
        }
    } catch (error) {
        console.error("❌ Error en Maestro obteniendo categorias locales:", error.message);
        res.status(500).json({ error: error.message });
    }
});

server.post('/api/maestro/categorias/sincronizar', (req, res) => {
    try {
        const cat = req.body;
        if (!cat || !cat.id || !cat.nombre) {
            return res.status(400).json({ error: 'Datos de categoría incompletos' });
        }
        const activeDb = getPosDb() || serverDb;
        const upsert = activeDb.prepare(`
            INSERT INTO categorias_locales (id, company_id, nombre, estado_sync, fecha_modificacion)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET
                nombre = excluded.nombre,
                company_id = excluded.company_id,
                fecha_modificacion = excluded.fecha_modificacion,
                estado_sync = 1
        `);
        upsert.run(cat.id, cat.company_id || cat.empresa_ID, cat.nombre, cat.fecha_modificacion || new Date().toISOString());
        res.json({ success: true, id: cat.id });
    } catch (error) {
        console.error("❌ Error en Maestro sincronizando categoría:", error.message);
        res.status(500).json({ error: error.message });
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
        const activeDb = getPosDb() || serverDb;
        let stmt;
        if (empresaId && empresaId !== 'undefined') {
            stmt = activeDb.prepare(`
                SELECT * FROM productos_locales
                WHERE company_id = ? AND codigo = ? AND status != -1 AND status != 0
                LIMIT 1
            `);
            res.json(stmt.get(empresaId, codigoLimpio) || null);
        } else {
            stmt = activeDb.prepare(`
                SELECT * FROM productos_locales
                WHERE codigo = ? AND status != -1 AND status != 0
                LIMIT 1
            `);
            res.json(stmt.get(codigoLimpio) || null);
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
            } catch(e) {}
            if (!tasa) {
                try {
                    const rowTasa = activeDb.prepare("SELECT valor FROM historial_tasas ORDER BY fecha DESC LIMIT 1").get();
                    if (rowTasa && rowTasa.valor) tasa = parseFloat(rowTasa.valor);
                } catch(e) {}
            }
        }
        if (!tasa) {
            try {
                const rowM = serverDb.prepare("SELECT valor FROM configuraciones_maestras WHERE clave = 'TASA_BCV' OR clave = 'dollarRate' LIMIT 1").get();
                if (rowM && rowM.valor) tasa = parseFloat(rowM.valor);
            } catch(e) {}
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
        const activeDb = getPosDb();
        if (activeDb) {
            if (productId) {
                const rows = activeDb.prepare('SELECT * FROM unidades_empaque WHERE product_id = ? ORDER BY factor_cantidad ASC').all(productId);
                return res.json(rows);
            } else {
                const rows = activeDb.prepare('SELECT * FROM unidades_empaque ORDER BY factor_cantidad ASC').all();
                return res.json(rows);
            }
        }
        res.json([]);
    } catch (error) {
        res.json([]);
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

server.get('/api/maestro/notificar-cambio/:tipo', (req, res) => {
    const { tipo } = req.params;
    cajasEscuchando.forEach(caja => {
        try {
            caja.write(`data: CAMBIO_${tipo.toUpperCase()}\n\n`);
        } catch(e){}
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
                tasa_bcv, metodo_pago, datos_json, ganancia_venta, estado_sync, estado_cierre, fecha_emision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, datetime('now', 'localtime'))
        `);

        stmt.run(
            v.id, v.company_id, v.branch_id, v.cashier_id, v.numero_factura,
            v.numero_control, v.cliente_nombre, v.cliente_rif, v.monto_exento,
            v.base_imponible, v.monto_iva, v.monto_igtf, v.monto_total,
            v.tasa_bcv, v.metodo_pago, v.datos_json, v.ganancia_venta || 0
        );

        // ☁️ Encolar descuento de stock para el VPS (para ventas originadas en caja hija)
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
                }));

            if (itemsDescuento.length > 0) {
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
                    fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
                )`).run();
                activeDb.prepare('INSERT INTO sync_queue (operacion, tabla, datos) VALUES (?, ?, ?)')
                    .run('CREAR', 'ventas_descuento_vps', JSON.stringify(payloadDescuento));
                console.log(`📦 Venta de caja hija ${v.numero_factura} encolada en Servidor Maestro para sync VPS (${itemsDescuento.length} productos).`);
            }
        } catch (eQueue) {
            console.warn("⚠️ No se pudo encolar venta de caja hija para VPS:", eQueue.message);
        }

        res.json({ exito: true });
    } catch (e) {
        console.error("❌ Error guardando venta en Maestro:", e.message);
        res.status(500).json({ exito: false, error: e.message });
    }
});

server.post('/api/maestro/registrar-reporte-fiscal', (req, res) => {
    const { tipo, z_number, json_data, branch_id, company_id } = req.body;
    console.log(`\n📄 [API MAESTRO] Recibiendo Reporte Fiscal: ${tipo} (${z_number}) de Sucursal: ${branch_id}`);

    try {
        const stmt = serverDb.prepare(`
            INSERT INTO cierres_caja (
                company_id, branch_id, numero_z, tipo_reporte, monto_total, ventas_totales, fecha, notas
            ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        `);
        
        let mTotal = 0;
        let vTotal = 0;
        try {
           const parsed = JSON.parse(json_data);
           mTotal = parsed.ventasTotales || 0;
           vTotal = parsed.cantidadVentas || 0;
        } catch(e) {}

        stmt.run(
            company_id, branch_id, z_number, tipo, mTotal, vTotal, json_data
        );

        res.json({ exito: true });
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
        `).get(companyId, fechaIni, fechaFin);
        const total_ganancia = gananciaResult?.total_ganancia || 0;

        // 1.1 Costo de Mercancía Vendida (COGS) en USD
        const cogsResult = serverDb.prepare(`
            SELECT SUM((monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1)) - ganancia_venta) as total_cogs
            FROM ventas_locales
            WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
        `).get(companyId, fechaIni, fechaFin);
        const total_cogs = Math.max(0, cogsResult?.total_cogs || 0);

        // 2. Top Clientes
        const topClientes = serverDb.prepare(`
            SELECT cliente_nombre, cliente_rif, SUM(monto_total) as total_comprado
            FROM ventas_locales
            WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
            GROUP BY cliente_rif
            ORDER BY total_comprado DESC
            LIMIT 5
        `).all(companyId, fechaIni, fechaFin);

        // 3. Top Productos (con Unidad de Medida Inteligente)
        const topProductos = [];
        try {
            const prodsDb = serverDb.prepare(`SELECT id, datos_json FROM productos_locales WHERE company_id = ?`).all(companyId);
            const mapaUnidadesCatalogo = {};
            prodsDb.forEach(p => {
                try {
                    const d = typeof p.datos_json === 'string' ? JSON.parse(p.datos_json) : (p.datos_json || {});
                    mapaUnidadesCatalogo[p.id] = d.unit || d.unidad || p.unit || 'UN';
                } catch(e){}
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
            } catch(eEmp) {}

            const ventas = serverDb.prepare(`SELECT datos_json FROM ventas_locales WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?`).all(companyId, fechaIni, fechaFin);
            const mapa = {};
            ventas.forEach(v => {
                try {
                    const parsed = JSON.parse(v.datos_json);
                    const prodArray = Array.isArray(parsed) ? parsed : (parsed.productos || parsed.items || []);
                    prodArray.forEach(item => {
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
                } catch(e){}
            });
            const array = Object.values(mapa).sort((a,b) => b.cantidad_vendida - a.cantidad_vendida).slice(0,5);
            topProductos.push(...array);
        } catch(e) {}

        // 3.1 Top Sucursales (con Resolución de Nombre)
        const topSucursales = serverDb.prepare(`
            SELECT COALESCE(NULLIF(v.branch_id, ''), 'principal') as branch_id,
                   COALESCE(s.nombre, NULLIF(v.branch_id, ''), 'Sucursal Principal') as sucursal_nombre,
                   COUNT(*) as total_ventas_count,
                   SUM(v.monto_total / COALESCE(NULLIF(v.tasa_bcv, 0), 1)) as total_usd,
                   SUM(v.ganancia_venta) as total_ganancia
            FROM ventas_locales v
            LEFT JOIN sucursales s ON s.id = v.branch_id
            WHERE v.company_id = ? AND v.fecha_emision BETWEEN ? AND ?
            GROUP BY v.branch_id
            ORDER BY total_usd DESC
            LIMIT 5
        `).all(companyId, fechaIni, fechaFin);

        // 4. Serie de tiempo (horaria si es 1 día, diaria si son múltiples días)
        let serieTiempo;
        if (periodo === 'dia' || fecha_inicio === fecha_fin) {
            serieTiempo = serverDb.prepare(`
                SELECT strftime('%Y-%m-%d %H:00:00', fecha_emision) as fecha, SUM(ganancia_venta) as total_ganancia
                FROM ventas_locales
                WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
                GROUP BY strftime('%Y-%m-%d %H', fecha_emision)
                ORDER BY fecha ASC
            `).all(companyId, fechaIni, fechaFin);
        } else {
            serieTiempo = serverDb.prepare(`
                SELECT date(fecha_emision) as fecha, SUM(ganancia_venta) as total_ganancia
                FROM ventas_locales
                WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?
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
