process.env.TZ = 'America/Caracas';







function getCaracasTime() {



    const d = new Date();



    const utcMillis = d.getTime() + (d.getTimezoneOffset() * 60000);



    const cDate = new Date(utcMillis - (4 * 60 * 60 * 1000));



    const pad = (n) => String(n).padStart(2, '0');



    return `${cDate.getFullYear()}-${pad(cDate.getMonth() + 1)}-${pad(cDate.getDate())} ${pad(cDate.getHours())}:${pad(cDate.getMinutes())}:${pad(cDate.getSeconds())}`;



}







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



const { app, BrowserWindow, ipcMain, Menu, session, dialog } = require('electron');



const path = require('path');



const fs = require('fs');



const os = require('os');



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



let win = null;



let cerebroProcess = null; // Proceso hijo del servidor maestro (server.js). Debe declararse antes de su uso (TDZ).







// 🛡️ SEGURIDAD ESTRICTA: Neutralizar flags de depuración remota o inyección externa por terminal



const debugSwitchesBloqueados = [



    'remote-debugging-port',



    'remote-debugging-pipe',



    'remote-debugging-address',



    'inspect',



    'inspect-brk',



    'auto-open-devtools-for-tabs'



];



debugSwitchesBloqueados.forEach(sw => {



    try {



        if (app.commandLine.hasSwitch(sw)) {



            console.warn(`🔒 [SEGURIDAD] Parámetro no autorizado detectado (--${sw}). Cerrando proceso...`);



            app.quit();



            process.exit(0);



        }



    } catch(e) {}



});







// Control estricto de instancia única: Evita que la aplicación se abra múltiples veces



const singleInstanceLock = app.requestSingleInstanceLock();



if (!singleInstanceLock) {



    console.log("⚠️ Ya hay una instancia de Nexus POS Global en ejecución. Cerrando proceso duplicado...");



    app.quit();



    process.exit(0);



} else {



    app.on('second-instance', () => {



        if (win) {



            if (win.isMinimized()) win.restore();



            win.focus();



        }



    });



}







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



    let maestroIp = null;



    try {



        maestroIp = getIpMaestro();



    } catch (e) {}







    const isServer = (config.isServer === true || config.isServer === 'true');



    const vpsIp = process.env.SERVER_IP || '';



    const vpsPort = parseInt(process.env.SERVER_PORT) || 4010;



    const respaldo = (process.env.respaldo_datos === 'true');







    if (isServer) {



        return {



            isServer: true,



            serverIP: vpsIp,



            serverIp: vpsIp,



            serverPort: vpsPort,



            SERVER_IP: vpsIp,



            SERVER_PORT: vpsPort,



            vpsIp: vpsIp,



            vpsPort: vpsPort,



            respaldo_datos: respaldo,



            respaldoActivo: respaldo



        };



    } else {



        const lanIp = maestroIp || config.serverIP || '';



        return {



            isServer: false,



            serverIP: lanIp,



            serverIp: lanIp,



            serverPort: 3000,



            SERVER_IP: lanIp,



            SERVER_PORT: 3000,



            vpsIp: vpsIp,



            vpsPort: vpsPort,



            respaldo_datos: false,



            respaldoActivo: false



        };



    }



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



const originalConsoleLog = console.log;



const originalConsoleError = console.error;



const originalConsoleWarn = console.warn;







function sendLogToDevTools(type, args) {



    try {



        if (typeof win !== 'undefined' && win && !win.isDestroyed()) {



            const wc = win.webContents;



            if (wc && !wc.isDestroyed()) {



                const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');



                wc.executeJavaScript(`console.${type}(${JSON.stringify('[MAIN] ' + text)})`).catch(() => {});



            }



        }



    } catch (e) {



        // Silenciar cualquier error si la ventana se destruyó en el proceso



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







// Sincronizar 'config' desde la tabla 'configuracion' en la SQLite local (nexus_pos.db)



try {



    const rowServer = db.prepare("SELECT valor FROM configuracion WHERE clave = 'isServer'").get();



    if (rowServer) config.isServer = (rowServer.valor === true || rowServer.valor === 'true');



    const rowIP = db.prepare("SELECT valor FROM configuracion WHERE clave = 'serverIP'").get();



    if (rowIP) config.serverIP = rowIP.valor;



} catch (eConfigSync) {



    console.error("❌ Error al sincronizar config desde SQLite en inicio:", eConfigSync.message);



}







let masterDbDirect = null;



if (config.isServer) {



    try {



        masterDbDirect = new Database(serverDbPath, { timeout: 10000 });



        try {



            masterDbDirect.pragma('journal_mode = WAL');



        } catch (ePragma) {



            console.warn("⚠️ [NEXUS MASTER] No se pudo aplicar journal_mode = WAL:", ePragma.message);



        }



    } catch (eDb) {



        console.error("❌ [NEXUS MASTER] Error abriendo base de datos maestra:", eDb.message);



    }



    // Nota: asegurarEsquema(masterDbDirect, ESQUEMA_MAESTRO) se llama desde inicializarTablas()



    console.log(`\n=========================================================`);



    console.log(`💻 [NEXUS NODE] Base de Datos Local: ${dbPath}`);



    console.log(`👑 [NEXUS MASTER] Iniciando Cerebro Maestro: ${serverDbPath}`);







    try {



        const serverScriptPath = path.join(__dirname, 'server.js');







        cerebroProcess = fork(serverScriptPath, [], {



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







        cerebroProcess.on('message', (msg) => {



            if (msg && msg.tipo === 'stock-actualizado') {



                try {



                    BrowserWindow.getAllWindows().forEach(v => {



                        if (!v.isDestroyed()) v.webContents.send('stock-actualizado-global');



                    });



                } catch(eWin) {}



            }



        });







        cerebroProcess.on('error', (err) => {



            console.error("❌ [NEXUS MASTER] Error al arrancar:", err.message);



        });







        if (app) {



            app.on('before-quit', () => {



                console.log("ðŸ›‘ Apagando Servidor Maestro...");



                try {



                    if (cerebroProcess && !cerebroProcess.killed) cerebroProcess.kill();



                } catch (eKill) {



                    console.warn("âš ï¸ No se pudo detener el Servidor Maestro:", eKill.message);



                }



            });



        }







    } catch (error) {



        console.error("âŒ Fallo crÃ­tico al intentar automatizar server.js:", error);



    }



    console.log(`=========================================================\n`);



}















let splash;

let splashStartTime = 0;

let sistemaPrincipalAbierto = false;



let cierreAutorizado = false; // <--- NUEVA VARIABLE DE SEGURIDAD



let printerPort;



let apiToken = null;



let tokenExpiration = null;



// Resolución dinámica de URL según el ambiente configurado (DEMO o PRODUCCIÓN)



function getHkaBaseUrl() {



    try {



        if (currentHkaCredentials && currentHkaCredentials.usuario && currentHkaCredentials.usuario.includes('_tfhka')) {



            return "https://demoemision.thefactoryhka.com.ve";



        }



        let row = null;



        if (masterDbDirect) {



            try { row = masterDbDirect.prepare("SELECT valor FROM configuracion WHERE clave = 'config_factura'").get(); } catch(e) {}



        }



        if (!row && db) {



            row = db.prepare("SELECT valor FROM configuracion WHERE clave = 'config_factura'").get();



            if (!row) row = db.prepare("SELECT valor FROM configuracion_cajera WHERE clave = 'config_factura'").get();



        }



        if (row && row.valor) {



            const cfg = JSON.parse(row.valor);



            // Si las credenciales corresponden a la cuenta demo oficial de pruebas (_tfhka), conecta a DEMO.



            // Para cualquier credencial real de cliente/empresa, pasa automáticamente a PRODUCCIÓN SENIAT.



            if (cfg.token_usuario && cfg.token_usuario.includes('_tfhka')) {



                return "https://demoemision.thefactoryhka.com.ve";



            }



        }



    } catch(e) {



        console.warn("[HKA BASE URL] Error leyendo configuración:", e.message);



    }



    // Por defecto producción SENIAT



    return "https://emision.thefactoryhka.com.ve";



}







let currentHkaCredentials = { usuario: "", clave: "" };



let basculaPort = null;



let basculaConfigActual = { path: null, baudRate: 9600, enabled: false };



let basculaReintentoTimer = null;



let basculaConectando = false;



let taraOffset = 0.0;



let ultimoPesoBruto = 0.0;



let senderBasculaActivo = null;











function reportarLogHKA(event, mensaje, esError = false) {



    const prefijo = esError ? "❌ [AUTH-HKA ERROR]:" : "ℹ️ [AUTH-HKA INFO]:";



    console[esError ? 'error' : 'log'](`${prefijo} ${mensaje}`);



    



    if (event && event.sender) {



        event.sender.send('hka-auth-log', { mensaje, esError });



    }



}







async function iniciarAuthWorkerHKA(event, credentials) {



    try {



        if (!credentials || !credentials.usuario || !credentials.clave) {



            // Fallback de seguridad: buscar en base de datos local si no vinieron en el evento



            try {



                let row = db.prepare("SELECT valor FROM configuracion WHERE clave = 'config_factura'").get();



                if (!row) {



                    row = db.prepare("SELECT valor FROM configuracion_cajera WHERE clave = 'config_factura'").get();



                }



                if (row && row.valor) {



                    const cfg = JSON.parse(row.valor);



                    if (cfg.token_usuario && cfg.token_password) {



                        credentials = {



                            usuario: String(cfg.token_usuario).trim(),



                            clave: String(cfg.token_password).trim()



                        };



                    }



                }



            } catch (eCfg) {



                console.warn("[HKA] Error leyendo config_factura fallback:", eCfg.message);



            }



        }







        if (!credentials || !credentials.usuario || !credentials.clave) {



            reportarLogHKA(event, "Faltan credenciales del cliente para la API.", true);



            return false;



        }







        currentHkaCredentials = { usuario: credentials.usuario, clave: credentials.clave };







        if (apiToken && tokenExpiration && (Date.now() + 5 * 60 * 1000) < tokenExpiration.getTime()) {



            reportarLogHKA(event, `Sesión HKA activa. Token válido hasta: ${tokenExpiration.toLocaleString()}`);



            return true;



        }







        const baseUrl = getHkaBaseUrl();



        reportarLogHKA(event, `Iniciando autenticación para el usuario: ${credentials.usuario} en [${baseUrl}]...`);







        const response = await axios.post(`${baseUrl}/api/Autenticacion`, {



            usuario: credentials.usuario,



            clave: credentials.clave



        });







        if (response.data && (response.data.codigo === 0 || response.data.token)) {



            apiToken = response.data.token;



            tokenExpiration = new Date(response.data.expiracion);



            



            reportarLogHKA(event, `Éxito: Token obtenido. Expira: ${tokenExpiration.toLocaleString()}`);



            



            if (global.servidorLocal) {



                global.servidorLocal.setHkaToken(apiToken);



                reportarLogHKA(event, "Token sincronizado con el núcleo de Nexus POS.");



            }



            return true;



        } else {



            const errDetalle = response.data ? `Código ${response.data.codigo} - ${response.data.mensaje || 'Error devuelto por HKA'}` : 'Error devuelto por HKA';



            reportarLogHKA(event, `Respuesta HKA: ${errDetalle}`, true);



            return false;



        }



    } catch (error) {



        reportarLogHKA(event, `Fallo de conexión con The Factory: ${error.message}`, true);



        return false;



    }



}







try {



    db.pragma('journal_mode = WAL');



} catch (e) {



    console.warn("⚠️ Aviso: La base de datos está ocupada. Iniciando sin modo WAL forzado.");



}







const ESQUEMA_LOCAL = {



    usuarios_locales: { uid: "TEXT PRIMARY KEY", email: "TEXT UNIQUE", role: "TEXT", companyId: "TEXT", branchId: "TEXT", company_data: "TEXT", last_login: "DATETIME" },



    movimientos_caja_locales: { id: "TEXT PRIMARY KEY", tipo: "TEXT", concepto: "TEXT", monto: "REAL DEFAULT 0", monto_usd: "REAL DEFAULT 0", metodo_pago: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", cashier_id: "TEXT", company_id: "TEXT", branch_id: "TEXT", estado_cierre: "INTEGER DEFAULT 0" },



    pagos_moviles_locales: { id: "TEXT PRIMARY KEY", venta_id: "TEXT", numero_factura: "TEXT", banco_receptor: "TEXT", referencia: "TEXT", telefono_origen: "TEXT", monto: "REAL DEFAULT 0", fecha_pago: "DATETIME DEFAULT (datetime('now', '-4 hours'))", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", estado_cierre: "INTEGER DEFAULT 0" },



    claves_admin_locales: { id: "TEXT PRIMARY KEY", ownerName: "TEXT", encryptedCode: "TEXT", company_id: "TEXT", created_by: "TEXT", updatedAt: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    productos_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", codigo: "TEXT", nombre: "TEXT", precio: "REAL DEFAULT 0", precio_compra: "REAL DEFAULT 0", porcentaje_ganancia: "REAL DEFAULT 0", categoria: "TEXT", status: "INTEGER DEFAULT 1", imagen: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    categorias_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    correlativos: { tipo: "TEXT PRIMARY KEY", ultimo_numero: "INTEGER DEFAULT 0", prefijo: "TEXT DEFAULT ''", correlativo_nc_actual: "INTEGER DEFAULT 0" },



    clientes_locales: { rif: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", direccion: "TEXT", telefono: "TEXT", correo: "TEXT", datos_json: "TEXT", es_contribuyente_especial: "INTEGER DEFAULT 0", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))", saldo_deuda: "REAL DEFAULT 0" },



    configuracion: { clave: "TEXT PRIMARY KEY", valor: "TEXT", fecha_actualizacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    historial_tasas: { fecha: "DATE PRIMARY KEY", valor: "DECIMAL(18, 8) DEFAULT 0", fuente: "TEXT DEFAULT 'BCV'" },



    ventas_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_factura: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", monto_exento: "REAL DEFAULT 0", base_imponible: "REAL DEFAULT 0", monto_iva: "REAL DEFAULT 0", total_iva: "REAL DEFAULT 0", monto_igtf: "REAL DEFAULT 0", monto_total: "REAL DEFAULT 0", tasa_bcv: "REAL DEFAULT 1", metodo_pago: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", estado_sync_maestro: "INTEGER DEFAULT 0", sync_server: "INTEGER DEFAULT 0", fecha_emision: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estado_cierre: "INTEGER DEFAULT 0", es_nota_credito: "INTEGER DEFAULT 0", es_nota_debito: "INTEGER DEFAULT 0", factura_afectada: "TEXT", monto_factura_afectada: "REAL DEFAULT 0", fecha_factura_afectada: "TEXT", comprobante_retencion_id: "TEXT DEFAULT NULL", ganancia_venta: "REAL DEFAULT 0", estado: "TEXT DEFAULT 'EMITIDA'", es_anulada: "INTEGER DEFAULT 0" },



    cuentas_por_cobrar: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", company_id: "TEXT", branch_id: "TEXT", cliente_rif: "TEXT", cliente_nombre: "TEXT", cliente_id: "TEXT", monto_deuda: "REAL DEFAULT 0", monto_pagado: "REAL DEFAULT 0", monto_bs: "REAL DEFAULT 0", monto_usd: "REAL DEFAULT 0", factura_nro: "TEXT", fecha: "TEXT", estado: "TEXT DEFAULT 'PENDIENTE'", fecha_emision: "DATETIME DEFAULT (datetime('now', '-4 hours'))", venta_id: "TEXT", estado_sync: "INTEGER DEFAULT 0", rif_cliente: "TEXT", monto: "REAL DEFAULT 0", concepto: "TEXT", tipo_movimiento: "TEXT", metodo_pago: "TEXT", referencia: "TEXT" },



    sync_queue: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", operacion: "TEXT", tabla: "TEXT", id_registro: "TEXT", datos: "TEXT", fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))", intentos: "INTEGER DEFAULT 0", ultimo_error: "TEXT DEFAULT ''", estado: "TEXT DEFAULT 'PENDIENTE'" },



    inventario_sucursales: { producto_id: "TEXT", sucursal_id: "TEXT", company_id: "TEXT", stock: "REAL DEFAULT 0", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))", "PRIMARY KEY": "(producto_id, sucursal_id)" },



    cierres_caja_locales: { id: "TEXT PRIMARY KEY", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", total_ventas_bs: "REAL DEFAULT 0", total_ventas_usd: "REAL DEFAULT 0", total_gastos_bs: "REAL DEFAULT 0", total_gastos_usd: "REAL DEFAULT 0", total_ingresos_bs: "REAL DEFAULT 0", total_diferencia_bs: "REAL DEFAULT 0", total_diferencia_usd: "REAL DEFAULT 0", detalle_pagos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0" },



    reportes_fiscales_cierre: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", tipo_reporte: "TEXT", numero_z: "TEXT", fecha_emision: "TEXT", hora_emision: "TEXT", ultima_factura: "TEXT", exento: "REAL DEFAULT 0", base_imponible_tasa_1: "REAL DEFAULT 0", impuesto_tasa_1: "REAL DEFAULT 0", base_imponible_tasa_2: "REAL DEFAULT 0", impuesto_tasa_2: "REAL DEFAULT 0", base_imponible_tasa_3: "REAL DEFAULT 0", impuesto_tasa_3: "REAL DEFAULT 0", igtf: "REAL DEFAULT 0", raw_data: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_registro: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    unidades_empaque: { id: "TEXT PRIMARY KEY", company_id: "TEXT", product_id: "TEXT", nombre_producto: "TEXT DEFAULT ''", nombre_unidad: "TEXT", tipo_medida: "TEXT", factor_cantidad: "REAL DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))", ultima_sincronizacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    comprobantes_retencion: { id: "TEXT PRIMARY KEY", datos_json: "TEXT NOT NULL", fecha_registro: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estatus: "TEXT DEFAULT 'EMITIDO'" },



    sucursales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", direccion: "TEXT", telefono: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "TEXT" },



    salidas_inventario: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", product_id: "TEXT", cantidad: "REAL DEFAULT 0", unidad: "TEXT", motivo: "TEXT", observacion: "TEXT", usuario_id: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    configuracion_cajera: { clave: "TEXT PRIMARY KEY", valor: "TEXT", fecha_actualizacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    plan_empresa: { company_id: "TEXT PRIMARY KEY", datos_encriptados: "TEXT", updated_at: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    auditoria_fiscal: { id: "TEXT PRIMARY KEY", usuario: "TEXT", accion: "TEXT", valores: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    auditoria_administrador: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", admin_name: "TEXT", accion: "TEXT", detalles: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    configuracion_fiscal: { id: "INTEGER PRIMARY KEY CHECK (id = 1)", iva_exento: "REAL DEFAULT 0", iva_general: "REAL DEFAULT 16", iva_reducido: "REAL DEFAULT 8", iva_anadida: "REAL DEFAULT 31", igtf_porcentaje: "REAL DEFAULT 3", fecha_actualizacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    guias_despacho: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_guia: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", factura_asociada: "TEXT", datos_json: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    empleados: { ID_empleado: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", cedula: "TEXT", cargo: "TEXT", sueldo_base: "REAL DEFAULT 0", frecuencia_pago: "TEXT", fecha_ingreso: "TEXT", telefono: "TEXT", sucursal: "TEXT", saldo_pendiente: "REAL DEFAULT 0", activo: "INTEGER DEFAULT 1", status: "INTEGER DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    proveedores: { rif: "TEXT PRIMARY KEY", id: "TEXT", company_id: "TEXT", nombre: "TEXT", telefono: "TEXT", contacto: "TEXT", direccion: "TEXT", correo: "TEXT", saldo_deuda: "REAL DEFAULT 0", status: "INTEGER DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



    movimientos_cuentas_pagar: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", company_id: "TEXT", proveedor_id: "TEXT", proveedor_rif: "TEXT", monto: "REAL DEFAULT 0", motivo: "TEXT", razon: "TEXT", nota: "TEXT", comprobante: "TEXT", estado: "TEXT DEFAULT 'PENDIENTE'", monto_abonado: "REAL DEFAULT 0", metodo_pago: "TEXT", referencia: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estado_sync: "INTEGER DEFAULT 0", contenido_fac: "TEXT" },



    empleados_movimientos: { id: "TEXT PRIMARY KEY", empleado_id: "TEXT", motivo: "TEXT", razon: "TEXT", monto: "REAL DEFAULT 0", company_id: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estado_sync: "INTEGER DEFAULT 0" },



    metodos_pago_locales: { id: "TEXT PRIMARY KEY", nombre: "TEXT NOT NULL", tecla: "TEXT", tipo_moneda: "TEXT DEFAULT 'BS'", activo: "INTEGER DEFAULT 1", flag_impresora: "TEXT DEFAULT '00'" },



    presupuestos_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_presupuesto: "TEXT UNIQUE", cliente_nombre: "TEXT", cliente_rif: "TEXT", cliente_direccion: "TEXT", cliente_telefono: "TEXT", subtotal: "REAL DEFAULT 0", monto_iva: "REAL DEFAULT 0", monto_total: "REAL DEFAULT 0", tasa_bcv: "REAL DEFAULT 1", moneda: "TEXT DEFAULT 'USD'", validez_dias: "INTEGER DEFAULT 1", estado: "TEXT DEFAULT 'EMITIDO'", fecha_emision: "DATETIME DEFAULT (datetime('now', '-4 hours'))", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0" }



};







function asegurarEsquema(dbConnection, esquema) {



    if (!dbConnection) return;



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







        // 2. Verificar columnas faltantes y auto-migrar



        const tableInfo = dbConnection.prepare(`PRAGMA table_info(${tabla})`).all();



        const columnasExistentes = tableInfo.map(col => col.name);







        for (const [colName, colType] of Object.entries(columnas)) {



            if (colName === "PRIMARY KEY" || colName === "FOREIGN KEY") continue;







            if (!columnasExistentes.includes(colName)) {



                // SQLite restricción: ALTER TABLE ADD COLUMN no permite PRIMARY KEY, UNIQUE, ni NOT NULL sin DEFAULT.



                let cleanType = colType



                    .replace(/PRIMARY KEY/gi, "")



                    .replace(/UNIQUE/gi, "")



                    .replace(/CHECK\s*\([^)]*\)/gi, "")



                    .trim();



                



                // Si tiene NOT NULL pero no tiene DEFAULT, remover NOT NULL para evitar error en tablas con filas existentes



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







function inicializarTablas() {







    try {



        db.exec(`



            -- 📦 Índices para Inventario (Búsquedas en milisegundos)



            CREATE INDEX IF NOT EXISTS idx_productos_codigo ON productos_locales(codigo);



            CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos_locales(categoria);



            CREATE INDEX IF NOT EXISTS idx_productos_empresa ON productos_locales(company_id);







            -- 🧾 Índices para Ventas (Vital para que el Cierre Z sea instantáneo)



            CREATE INDEX IF NOT EXISTS idx_ventas_cierre_compuesto 



            ON ventas_locales(company_id, branch_id, cashier_id, estado_cierre);



            



            -- Índice para buscar facturas por fecha rápidamente (Reportes)



            CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas_locales(fecha_emision);



            CREATE INDEX IF NOT EXISTS idx_ventas_factura ON ventas_locales(numero_factura);



            CREATE INDEX IF NOT EXISTS idx_ventas_estado ON ventas_locales(estado);



            CREATE INDEX IF NOT EXISTS idx_ventas_sync_server ON ventas_locales(sync_server);







            -- 💸 Índices para Movimientos de Caja (Ingresos/Gastos)



            CREATE INDEX IF NOT EXISTS idx_movimientos_cierre 



            ON movimientos_caja_locales(company_id, tipo, estado_cierre);



            CREATE INDEX IF NOT EXISTS idx_movimientos_fecha ON movimientos_caja_locales(fecha);







            -- 🤝 Índices para Cuentas por Cobrar (Créditos)



            CREATE INDEX IF NOT EXISTS idx_cxc_cliente ON cuentas_por_cobrar(cliente_rif, estado);







            -- 📑 Índices para Presupuestos



            CREATE INDEX IF NOT EXISTS idx_presupuestos_nro ON presupuestos_locales(numero_presupuesto);



            CREATE INDEX IF NOT EXISTS idx_presupuestos_empresa ON presupuestos_locales(company_id, estado);



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



            stock_maestro: { producto_id: "TEXT", sucursal_id: "TEXT", company_id: "TEXT", cantidad_real: "REAL DEFAULT 0", ultima_sincronizacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))", "PRIMARY KEY": "(producto_id, sucursal_id)" },



            movimientos_stock_maestro: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", company_id: "TEXT NOT NULL", sucursal_id: "TEXT", producto_id: "TEXT NOT NULL", cantidad: "REAL DEFAULT 0", tipo_movimiento: "TEXT", fecha_movimiento: "DATETIME DEFAULT (datetime('now', '-4 hours'))", referencia_id: "TEXT", estado_sync: "INTEGER DEFAULT 0" },



            correlativos_maestros: { tipo: "TEXT PRIMARY KEY", prefijo: "TEXT DEFAULT ''", ultimo_numero: "INTEGER DEFAULT 0", correlativo_nc_actual: "INTEGER DEFAULT 0" },



            clientes_maestro: { rif: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT NOT NULL", direccion: "TEXT", telefono: "TEXT", correo: "TEXT", datos_json: "TEXT", es_contribuyente_especial: "INTEGER DEFAULT 0", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))", saldo_deuda: "REAL DEFAULT 0" },



            cuentas_por_cobrar: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", company_id: "TEXT", branch_id: "TEXT", cliente_id: "TEXT", cliente_nombre: "TEXT", monto_bs: "REAL DEFAULT 0", monto_usd: "REAL DEFAULT 0", factura_nro: "TEXT", monto_pagado: "REAL DEFAULT 0", fecha: "TEXT", estado: "TEXT DEFAULT 'PENDIENTE'", estado_sync: "INTEGER DEFAULT 0", rif_cliente: "TEXT", monto: "REAL DEFAULT 0", concepto: "TEXT", tipo_movimiento: "TEXT", metodo_pago: "TEXT", referencia: "TEXT" },



            facturas_borradores: { id: "TEXT PRIMARY KEY", cliente_nombre: "TEXT", cliente_id: "TEXT", items: "TEXT", subtotal: "REAL DEFAULT 0", iva: "REAL DEFAULT 0", total: "REAL DEFAULT 0", metodos_pago: "TEXT", fecha: "INTEGER", usuario_id: "TEXT", sucursal_id: "TEXT", company_id: "TEXT" },



            cierres_caja_maestros: { id: "TEXT PRIMARY KEY", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", total_ventas_bs: "REAL DEFAULT 0", total_ventas_usd: "REAL DEFAULT 0", total_gastos_bs: "REAL DEFAULT 0", total_gastos_usd: "REAL DEFAULT 0", total_ingresos_bs: "REAL DEFAULT 0", total_diferencia_bs: "REAL DEFAULT 0", total_diferencia_usd: "REAL DEFAULT 0", detalle_pagos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0" },



            movimientos_caja_locales: { id: "TEXT PRIMARY KEY", tipo: "TEXT", concepto: "TEXT", monto: "REAL DEFAULT 0", monto_usd: "REAL DEFAULT 0", metodo_pago: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", cashier_id: "TEXT", company_id: "TEXT", branch_id: "TEXT", estado_cierre: "INTEGER DEFAULT 0" },



            ventas_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_factura: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", monto_exento: "REAL DEFAULT 0", base_imponible: "REAL DEFAULT 0", monto_iva: "REAL DEFAULT 0", total_iva: "REAL DEFAULT 0", monto_igtf: "REAL DEFAULT 0", monto_total: "REAL DEFAULT 0", tasa_bcv: "REAL DEFAULT 1", metodo_pago: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", estado_sync_maestro: "INTEGER DEFAULT 1", sync_server: "INTEGER DEFAULT 0", fecha_emision: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estado_cierre: "INTEGER DEFAULT 0", es_nota_credito: "INTEGER DEFAULT 0", es_nota_debito: "INTEGER DEFAULT 0", factura_afectada: "TEXT", monto_factura_afectada: "REAL DEFAULT 0", fecha_factura_afectada: "TEXT", comprobante_retencion_id: "TEXT DEFAULT NULL", ganancia_venta: "REAL DEFAULT 0", estado: "TEXT DEFAULT 'EMITIDA'", es_anulada: "INTEGER DEFAULT 0" },



            configuraciones_maestras: { clave: "TEXT PRIMARY KEY", valor: "TEXT" },



            auditoria_fiscal: { id: "TEXT PRIMARY KEY", usuario: "TEXT", accion: "TEXT", valores: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



            metodos_pago_maestro: { id: "TEXT PRIMARY KEY", nombre: "TEXT NOT NULL", tecla: "TEXT", tipo_moneda: "TEXT DEFAULT 'BS'", activo: "INTEGER DEFAULT 1", flag_impresora: "TEXT DEFAULT '00'" },



            claves_admin_maestras: { id: "TEXT PRIMARY KEY", ownerName: "TEXT", encryptedCode: "TEXT", company_id: "TEXT", created_by: "TEXT", updatedAt: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



            guia_despacho: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_guia: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", factura_asociada: "TEXT", fecha_emision: "DATETIME DEFAULT (datetime('now', '-4 hours'))", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0" },



            guias_despacho: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_guia: "TEXT", numero_control: "TEXT", cliente_nombre: "TEXT", cliente_rif: "TEXT", factura_asociada: "TEXT", datos_json: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



            empleados: { ID_empleado: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", cedula: "TEXT", cargo: "TEXT", sueldo_base: "REAL DEFAULT 0", frecuencia_pago: "TEXT", fecha_ingreso: "TEXT", telefono: "TEXT", sucursal: "TEXT", saldo_pendiente: "REAL DEFAULT 0", activo: "INTEGER DEFAULT 1", status: "INTEGER DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



            proveedores: { rif: "TEXT PRIMARY KEY", id: "TEXT", company_id: "TEXT", nombre: "TEXT", telefono: "TEXT", contacto: "TEXT", direccion: "TEXT", correo: "TEXT", saldo_deuda: "REAL DEFAULT 0", status: "INTEGER DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



            movimientos_cuentas_pagar: { id: "INTEGER PRIMARY KEY AUTOINCREMENT", company_id: "TEXT", proveedor_id: "TEXT", proveedor_rif: "TEXT", monto: "REAL DEFAULT 0", motivo: "TEXT", razon: "TEXT", nota: "TEXT", comprobante: "TEXT", estado: "TEXT DEFAULT 'PENDIENTE'", monto_abonado: "REAL DEFAULT 0", metodo_pago: "TEXT", referencia: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estado_sync: "INTEGER DEFAULT 0", contenido_fac: "TEXT" },



            empleados_movimientos: { id: "TEXT PRIMARY KEY", empleado_id: "TEXT", motivo: "TEXT", razon: "TEXT", monto: "REAL DEFAULT 0", company_id: "TEXT", fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estado_sync: "INTEGER DEFAULT 0" },



            productos_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", codigo: "TEXT", nombre: "TEXT", precio: "REAL DEFAULT 0", precio_compra: "REAL DEFAULT 0", porcentaje_ganancia: "REAL DEFAULT 0", categoria: "TEXT", status: "INTEGER DEFAULT 1", imagen: "TEXT", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



            categorias_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



            sucursales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", nombre: "TEXT", direccion: "TEXT", telefono: "TEXT", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "TEXT" },



            unidades_empaque: { id: "TEXT PRIMARY KEY", company_id: "TEXT", product_id: "TEXT", nombre_producto: "TEXT DEFAULT ''", nombre_unidad: "TEXT", tipo_medida: "TEXT", factor_cantidad: "REAL DEFAULT 1", estado_sync: "INTEGER DEFAULT 0", fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))", ultima_sincronizacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))" },



            historial_tasas: { fecha: "DATE PRIMARY KEY", valor: "DECIMAL(18, 8) DEFAULT 0", fuente: "TEXT DEFAULT 'BCV'" },



            comprobantes_retencion: { id: "TEXT PRIMARY KEY", datos_json: "TEXT", fecha_registro: "DATETIME DEFAULT (datetime('now', '-4 hours'))", estatus: "TEXT DEFAULT 'EMITIDO'" },



            presupuestos_locales: { id: "TEXT PRIMARY KEY", company_id: "TEXT", branch_id: "TEXT", cashier_id: "TEXT", numero_presupuesto: "TEXT UNIQUE", cliente_nombre: "TEXT", cliente_rif: "TEXT", cliente_direccion: "TEXT", cliente_telefono: "TEXT", subtotal: "REAL DEFAULT 0", monto_iva: "REAL DEFAULT 0", monto_total: "REAL DEFAULT 0", tasa_bcv: "REAL DEFAULT 1", moneda: "TEXT DEFAULT 'USD'", validez_dias: "INTEGER DEFAULT 1", estado: "TEXT DEFAULT 'EMITIDO'", fecha_emision: "DATETIME DEFAULT (datetime('now', '-4 hours'))", datos_json: "TEXT", estado_sync: "INTEGER DEFAULT 0" }



        };



        asegurarEsquema(masterDbDirect, ESQUEMA_MAESTRO_LOCAL);



        console.log("[DB AUTO-SYNC] Esquema maestro sincronizado en masterDbDirect.");



    }







    // Asegurar que registros existentes sin estado_sync se inicialicen en 0 para entrar en el ciclo de subida



    const tablasSync = ['cuentas_por_cobrar', 'proveedores', 'movimientos_cuentas_pagar', 'empleados', 'empleados_movimientos', 'cierres_caja_locales', 'cierres_caja_maestros'];



    for (const t of tablasSync) {



        try { db.prepare(`UPDATE ${t} SET estado_sync = 0 WHERE estado_sync IS NULL`).run(); } catch (_) {}



        if (masterDbDirect) {



            try { masterDbDirect.prepare(`UPDATE ${t} SET estado_sync = 0 WHERE estado_sync IS NULL`).run(); } catch (_) {}



        }



    }



    try { db.prepare(`UPDATE clientes_locales SET estado_sync = 0 WHERE estado_sync IS NULL`).run(); } catch (_) {}



    if (masterDbDirect) {



        try { masterDbDirect.prepare(`UPDATE clientes_maestro SET estado_sync = 0 WHERE estado_sync IS NULL`).run(); } catch (_) {}



    }







    // 🔒 Índices de alta velocidad para sincronización y reportes de cierres



    try {



        db.exec(`



            CREATE INDEX IF NOT EXISTS idx_cierres_locales_sync ON cierres_caja_locales(estado_sync, fecha);



            CREATE INDEX IF NOT EXISTS idx_cierres_locales_fecha ON cierres_caja_locales(fecha);



            CREATE INDEX IF NOT EXISTS idx_cxc_sync ON cuentas_por_cobrar(estado_sync);



            CREATE INDEX IF NOT EXISTS idx_cxp_movs_sync ON movimientos_cuentas_pagar(estado_sync);
            CREATE INDEX IF NOT EXISTS idx_cxp_movs_comprobante ON movimientos_cuentas_pagar(comprobante);
            CREATE INDEX IF NOT EXISTS idx_cxp_movs_proveedor ON movimientos_cuentas_pagar(proveedor_rif);
            CREATE VIEW IF NOT EXISTS cuentas_por_pagar AS SELECT * FROM movimientos_cuentas_pagar;



            CREATE INDEX IF NOT EXISTS idx_empleados_sync ON empleados(estado_sync);



            CREATE INDEX IF NOT EXISTS idx_empleados_movs_sync ON empleados_movimientos(estado_sync);



            CREATE INDEX IF NOT EXISTS idx_proveedores_sync ON proveedores(estado_sync);



        `);



        if (masterDbDirect) {



            masterDbDirect.exec(`



                CREATE INDEX IF NOT EXISTS idx_cierres_maestros_sync ON cierres_caja_maestros(estado_sync, fecha);



                CREATE INDEX IF NOT EXISTS idx_cierres_maestros_comp ON cierres_caja_maestros(company_id, branch_id, fecha);



                CREATE INDEX IF NOT EXISTS idx_cxc_maestros_sync ON cuentas_por_cobrar(estado_sync);



                CREATE INDEX IF NOT EXISTS idx_cxp_movs_maestros_sync ON movimientos_cuentas_pagar(estado_sync);
                CREATE INDEX IF NOT EXISTS idx_cxp_movs_maestros_comprobante ON movimientos_cuentas_pagar(comprobante);
                CREATE INDEX IF NOT EXISTS idx_cxp_movs_maestros_proveedor ON movimientos_cuentas_pagar(proveedor_rif);
                CREATE VIEW IF NOT EXISTS cuentas_por_pagar AS SELECT * FROM movimientos_cuentas_pagar;



                CREATE INDEX IF NOT EXISTS idx_empleados_maestros_sync ON empleados(estado_sync);



                CREATE INDEX IF NOT EXISTS idx_empleados_movs_maestros_sync ON empleados_movimientos(estado_sync);



                CREATE INDEX IF NOT EXISTS idx_proveedores_maestros_sync ON proveedores(estado_sync);



                CREATE INDEX IF NOT EXISTS idx_configuracion_maestra_clave_valor ON configuracion(clave, valor);



                INSERT OR IGNORE INTO configuracion (clave, valor, fecha_actualizacion) VALUES ('backups_auto', 'true', datetime('now', '-4 hours'));



                INSERT OR IGNORE INTO configuracion (clave, valor, fecha_actualizacion) VALUES ('hora_backups', '06:00 PM', datetime('now', '-4 hours'));



            `);



        }



    } catch (eIdx) {



        console.warn("Aviso creando índices de cierres:", eIdx.message);



    }







    db.exec(`



        INSERT OR IGNORE INTO configuracion_fiscal (id, iva_exento, iva_general, iva_reducido, iva_anadida, igtf_porcentaje)



        VALUES (1, 0, 16, 8, 31, 3);



        INSERT OR IGNORE INTO configuracion (clave, valor, fecha_actualizacion)



        VALUES ('confi_auto_tasa', 'false', datetime('now', '-4 hours'));



        INSERT OR IGNORE INTO configuracion (clave, valor, fecha_actualizacion)



        VALUES ('backups_auto', 'true', datetime('now', '-4 hours'));



        INSERT OR IGNORE INTO configuracion (clave, valor, fecha_actualizacion)



        VALUES ('hora_backups', '06:00 PM', datetime('now', '-4 hours'));



        CREATE INDEX IF NOT EXISTS idx_configuracion_clave_valor ON configuracion(clave, valor);
        INSERT OR IGNORE INTO configuracion (clave, valor, fecha_actualizacion)
        VALUES ('tipo_calculo_margen', 'SOBRE_COSTO', datetime('now', '-4 hours'));







        -- TABLA DE PERSISTENCIA FISCAL ANTE CORTES ELECTRICOS (STAGING HKA)



        CREATE TABLE IF NOT EXISTS staging_hka_en_vuelo (



            id TEXT PRIMARY KEY,



            tipo_documento TEXT NOT NULL,



            serie TEXT,



            numero_documento TEXT NOT NULL,



            payload_json TEXT NOT NULL,



            estado TEXT NOT NULL,



            numero_control TEXT,



            error_mensaje TEXT,



            fecha_registro DATETIME DEFAULT (datetime('now', '-4 hours')),



            fecha_actualizacion DATETIME DEFAULT (datetime('now', '-4 hours'))



        );



        CREATE INDEX IF NOT EXISTS idx_staging_hka_estado ON staging_hka_en_vuelo(estado);



        CREATE INDEX IF NOT EXISTS idx_staging_hka_doc ON staging_hka_en_vuelo(tipo_documento, numero_documento, serie);



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



                fecha DATETIME DEFAULT (datetime('now', '-4 hours'))



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







        console.log(`✅ [NEXUS MASTER] Guía de Despacho guardada localmente: ${datos.numero_guia}`);



        



        return { exito: true, id: datos.id, numero_guia: datos.numero_guia };







    } catch (error) {



        console.error("❌ [ERROR] Falló al guardar la Guía de Despacho en SQLite:", error);



        return { exito: false, error: error.message };



    }



});







// ==========================================



// 📑 IPC HANDLERS PARA PRESUPUESTOS / COTIZACIONES



// ==========================================



// ==========================================



// IPC HANDLERS PARA STAGING HKA (PERSISTENCIA Y RECUPERACION ANTE CORTES)



// ==========================================



ipcMain.handle('guardar-staging-hka', async (event, datos) => {



    try {



        const stmt = db.prepare(`



            INSERT OR REPLACE INTO staging_hka_en_vuelo 



            (id, tipo_documento, serie, numero_documento, payload_json, estado, numero_control, error_mensaje, fecha_actualizacion)



            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-4 hours'))



        `);



        stmt.run(



            datos.id,



            datos.tipo_documento || '01',



            datos.serie || '',



            String(datos.numero_documento),



            typeof datos.payload_json === 'string' ? datos.payload_json : JSON.stringify(datos.payload_json),



            datos.estado || 'EN_VUELO',



            datos.numero_control || null,



            datos.error_mensaje || null



        );



        return { success: true };



    } catch(e) {



        console.error('Error guardando staging HKA:', e.message);



        return { success: false, error: e.message };



    }



});







ipcMain.handle('actualizar-staging-hka', async (event, datos) => {



    try {



        const stmt = db.prepare(`



            UPDATE staging_hka_en_vuelo 



            SET estado = ?, numero_control = COALESCE(?, numero_control), error_mensaje = ?, fecha_actualizacion = datetime('now', '-4 hours')



            WHERE id = ? OR (tipo_documento = ? AND numero_documento = ?)



        `);



        stmt.run(



            datos.estado,



            datos.numero_control || null,



            datos.error_mensaje || null,



            datos.id || '',



            datos.tipo_documento || '',



            String(datos.numero_documento || '')



        );



        return { success: true };



    } catch(e) {



        console.error('Error actualizando staging HKA:', e.message);



        return { success: false, error: e.message };



    }



});







ipcMain.handle('consultar-staging-pendientes', async () => {



    try {



        const rows = db.prepare(`SELECT * FROM staging_hka_en_vuelo WHERE estado = 'EN_VUELO' ORDER BY fecha_registro DESC`).all();



        return rows || [];



    } catch(e) {



        return [];



    }



});







ipcMain.handle('abrir-carpeta-comprobantes', async () => {



    try {



        const comprobantesDir = path.join(app.getPath('documents'), 'NEXUS_POS_GLOBAL', 'Comprobantes_Digitales');



        if (!fs.existsSync(comprobantesDir)) fs.mkdirSync(comprobantesDir, { recursive: true });



        await shell.openPath(comprobantesDir);



        return { success: true, path: comprobantesDir };



    } catch (e) {



        return { success: false, error: e.message };



    }



});







ipcMain.handle('guardar-presupuesto-local', async (event, datos) => {



    try {



        const payload = {



            id: datos.id || `PRE-${Date.now()}`,



            company_id: datos.company_id || '',



            branch_id: datos.branch_id || '',



            cashier_id: datos.cashier_id || '',



            numero_presupuesto: datos.numero_presupuesto,



            cliente_nombre: datos.cliente_nombre || 'CONSUMIDOR FINAL',



            cliente_rif: datos.cliente_rif || 'V-00000000',



            cliente_direccion: datos.cliente_direccion || '',



            cliente_telefono: datos.cliente_telefono || '',



            subtotal: parseFloat(datos.subtotal || 0),



            monto_iva: parseFloat(datos.monto_iva || 0),



            monto_total: parseFloat(datos.monto_total || 0),



            tasa_bcv: parseFloat(datos.tasa_bcv || 1),



            moneda: datos.moneda || 'USD',



            validez_dias: parseInt(datos.validez_dias || 1),



            estado: datos.estado || 'EMITIDO',



            fecha_emision: datos.fecha_emision || getCaracasTime(),



            datos_json: typeof datos.datos_json === 'object' ? JSON.stringify(datos.datos_json) : (datos.datos_json || '{}')



        };







        // 1. Guardar en SQLite local



        const stmt = db.prepare(`



            INSERT OR REPLACE INTO presupuestos_locales (



                id, company_id, branch_id, cashier_id, numero_presupuesto,



                cliente_nombre, cliente_rif, cliente_direccion, cliente_telefono,



                subtotal, monto_iva, monto_total, tasa_bcv, moneda, validez_dias,



                estado, fecha_emision, datos_json, estado_sync



            ) VALUES (



                @id, @company_id, @branch_id, @cashier_id, @numero_presupuesto,



                @cliente_nombre, @cliente_rif, @cliente_direccion, @cliente_telefono,



                @subtotal, @monto_iva, @monto_total, @tasa_bcv, @moneda, @validez_dias,



                @estado, @fecha_emision, @datos_json, 0



            )



        `);



        stmt.run(payload);







        // 2. Si es servidor y masterDbDirect está abierto, guardar en maestro directo



        if (config.isServer && masterDbDirect) {



            try {



                masterDbDirect.prepare(`



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



                `).run(payload);



            } catch(eMaster) {



                console.warn("Aviso guardando presupuesto en masterDbDirect:", eMaster.message);



            }



        }







        // 3. Si es caja hija (isServer = false), enviar por red al servidor maestro



        if (!config.isServer) {



            try {



                await llamarMaestro('POST', '/api/maestro/guardar-presupuesto', payload);



                db.prepare(`UPDATE presupuestos_locales SET estado_sync = 1 WHERE id = ?`).run(payload.id);



            } catch(eNet) {



                console.warn("⚠️ [PRESUPUESTO] Servidor maestro inaccesible. Guardado en local para sincronización posterior:", eNet.message);



            }



        }







        console.log(`✅ [PRESUPUESTO] Presupuesto guardado exitosamente: ${datos.numero_presupuesto}`);



        return { success: true, id: payload.id, numero_presupuesto: payload.numero_presupuesto };



    } catch (error) {



        console.error("❌ Error guardando presupuesto en SQLite:", error);



        return { success: false, error: error.message };



    }



});







ipcMain.handle('obtener-presupuestos-local', async (event, filtro = '', companyId = '', branchId = '') => {



    try {



        // 1. Si es caja hija, consultar primero al Servidor Maestro



        if (!config.isServer) {



            try {



                const params = new URLSearchParams();



                if (filtro) params.append('filtro', filtro);



                if (companyId) params.append('companyId', companyId);



                if (branchId) params.append('branchId', branchId);







                const resMaestro = await llamarMaestro('GET', `/api/maestro/obtener-presupuestos?${params.toString()}`);



                if (Array.isArray(resMaestro.data)) {



                    // Cachear en SQLite local



                    const insertStmt = db.prepare(`



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







                    db.transaction(() => {



                        for (const row of resMaestro.data) {



                            insertStmt.run({



                                id: row.id,



                                company_id: row.company_id || '',



                                branch_id: row.branch_id || '',



                                cashier_id: row.cashier_id || '',



                                numero_presupuesto: row.numero_presupuesto,



                                cliente_nombre: row.cliente_nombre || 'CONSUMIDOR FINAL',



                                cliente_rif: row.cliente_rif || 'V-00000000',



                                cliente_direccion: row.cliente_direccion || '',



                                cliente_telefono: row.cliente_telefono || '',



                                subtotal: row.subtotal || 0,



                                monto_iva: row.monto_iva || 0,



                                monto_total: row.monto_total || 0,



                                tasa_bcv: row.tasa_bcv || 1,



                                moneda: row.moneda || 'USD',



                                validez_dias: row.validez_dias || 1,



                                estado: row.estado || 'EMITIDO',



                                fecha_emision: row.fecha_emision || getCaracasTime(),



                                datos_json: typeof row.datos_json === 'object' ? JSON.stringify(row.datos_json) : (row.datos_json || '{}')



                            });



                        }



                    })();







                    return resMaestro.data;



                }



            } catch (eNet) {



                console.warn("⚠️ [PRESUPUESTO] No se pudo consultar maestro vía red. Consultando base de datos local:", eNet.message);



            }



        }







        // 2. Si es servidor o si la red falló, consultar base de datos local



        const targetDb = (config.isServer && masterDbDirect) ? masterDbDirect : db;



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



        const rows = targetDb.prepare(query).all(...params);



        return rows || [];



    } catch (error) {



        console.error("❌ Error obteniendo presupuestos:", error);



        return [];



    }



});







ipcMain.handle('marcar-presupuesto-facturado', async (event, idOPresupuesto) => {



    try {



        db.prepare(`



            UPDATE presupuestos_locales 



            SET estado = 'CONVERTIDO_A_VENTA' 



            WHERE id = ? OR numero_presupuesto = ?



        `).run(idOPresupuesto, idOPresupuesto);







        if (config.isServer && masterDbDirect) {



            try {



                masterDbDirect.prepare(`



                    UPDATE presupuestos_locales 



                    SET estado = 'CONVERTIDO_A_VENTA' 



                    WHERE id = ? OR numero_presupuesto = ?



                `).run(idOPresupuesto, idOPresupuesto);



            } catch(eM) {}



        }







        if (!config.isServer) {



            try {



                await llamarMaestro('POST', '/api/maestro/marcar-presupuesto-facturado', { id: idOPresupuesto });



            } catch(eNet) {



                console.warn("Aviso notificando presupuesto facturado al maestro:", eNet.message);



            }



        }







        return { success: true };



    } catch (error) {



        console.error("❌ Error actualizando estado del presupuesto:", error);



        return { success: false, error: error.message };



    }



});







ipcMain.on('confirmar-cierre-seguro', () => {



    cierreAutorizado = true;



    app.quit(); // Ejecuta el cierre definitivo del sistema



});







ipcMain.handle('guardar-auditoria-fiscal', async (event, datos) => {



    try {



        // 'store' no existe en este proceso: se resuelve la URL del servidor maestro (puerto 3000) desde la configuración local



        let ipMaestro = '127.0.0.1';



        if (!(config.isServer === true || config.isServer === 'true')) {



            try { ipMaestro = getIpMaestro() || config.serverIP || '127.0.0.1'; } catch (_) { ipMaestro = config.serverIP || '127.0.0.1'; }



        }



        const serverUrl = `http://${ipMaestro}:3000`;



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



            datos.fecha || getCaracasTime()



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



        let query = `



            SELECT * FROM ventas_locales 



            WHERE company_id = ? 



              AND estado_cierre = 0



              AND (estado != 'ANULADA' OR estado IS NULL)



        `;



        const params = [companyId];







        if (branchId) {



            query += ` AND (branch_id = ? OR branch_id IS NULL OR branch_id = '')`;



            params.push(branchId);



        }



        if (cashierId) {



            query += ` AND (cashier_id = ? OR cashier_id IS NULL OR cashier_id = '')`;



            params.push(cashierId);



        }







        query += ` ORDER BY fecha_emision ASC`;







        const stmt = db.prepare(query);



        return stmt.all(...params);



    } catch (e) {



        console.error("❌ Error en obtener-ventas-pendientes-caja:", e.message);



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



        if (config.isServer && masterDbDirect) {



            try { masterDbDirect.prepare('DELETE FROM sucursales WHERE id = ?').run(id); } catch (eM) { console.warn("[SUCURSALES] No se pudo borrar en DB maestra:", eM.message); }



        }



        



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
        if (!reporte) reporte = {};
        const cierreId = reporte.id || `CIERRE-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        const companyId = reporte.companyId || reporte.company_id || (typeof getActiveCompanyId === 'function' ? getActiveCompanyId() : null) || 'DEFAULT';
        const branchId = reporte.branchId || reporte.branch_id || 'principal';
        const cashierId = reporte.cashierId || reporte.cashier_id || 'cajera_1';
        const fechaCierre = reporte.fecha || (typeof getCaracasTime === 'function' ? getCaracasTime() : new Date().toISOString());



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



                cierreId,



                fechaCierre,



                companyId,



                branchId,



                cashierId,



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



                        WHERE company_id = ? 



                          AND (branch_id = ? OR branch_id IS NULL OR branch_id = '') 



                          AND (cashier_id = ? OR cashier_id IS NULL OR cashier_id = '') 



                          AND estado_cierre = 0`)



              .run(reporte.companyId, reporte.branchId, reporte.cashierId);



            



            // C. MARCAR INGRESOS Y GASTOS COMO CERRADOS



            db.prepare(`UPDATE movimientos_caja_locales SET estado_cierre = 1 



                        WHERE company_id = ? 



                          AND (cashier_id = ? OR cashier_id IS NULL OR cashier_id = '') 



                          AND (branch_id = ? OR branch_id IS NULL OR branch_id = '') 



                          AND estado_cierre = 0`)



              .run(reporte.companyId, reporte.cashierId, reporte.branchId);



            



            // D. MARCAR PAGOS MÓVILES COMO CERRADOS



            db.prepare(`UPDATE pagos_moviles_locales SET estado_cierre = 1 



                        WHERE company_id = ? 



                          AND (branch_id = ? OR branch_id IS NULL OR branch_id = '') 



                          AND (cashier_id = ? OR cashier_id IS NULL OR cashier_id = '') 



                          AND estado_cierre = 0`)



              .run(reporte.companyId, reporte.branchId, reporte.cashierId);



        });



        



        // Ejecutamos la transacciÃ³n local



        transaction();



        console.log(`âœ… Cierre Z almacenado localmente: ${reporte.id}`);







        // --- E. SINCRONIZACIÓN CON EL SERVIDOR MAESTRO Y VPS ---



        if (config.isServer && masterDbDirect) {



            try {



                masterDbDirect.prepare(`



                    INSERT OR REPLACE INTO cierres_caja_maestros (



                        id, fecha, company_id, branch_id, cashier_id,



                        total_ventas_bs, total_ventas_usd, total_gastos_bs, total_gastos_usd,



                        total_ingresos_bs, total_diferencia_bs, total_diferencia_usd, detalle_pagos_json, estado_sync



                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)



                `).run(



                    reporte.id, reporte.fecha || getCaracasTime(), reporte.companyId,



                    reporte.branchId || 'DEFAULT', reporte.cashierId || 'CAJERO',



                    parseFloat(reporte.totalSalesBs) || 0, parseFloat(reporte.totalSalesDollars) || 0,



                    parseFloat(reporte.totalExpensesBs) || 0, parseFloat(reporte.totalExpensesDollars) || 0,



                    parseFloat(reporte.totalIncomes) || 0, parseFloat(reporte.totalDifferenceBs) || 0,



                    parseFloat(reporte.totalDifferenceDollars) || 0,



                    typeof reporte.paymentsConciliation === 'string' ? reporte.paymentsConciliation : JSON.stringify(reporte.paymentsConciliation || {})



                );



            } catch (eM) {



                console.warn("⚠️ Error guardando cierre en masterDbDirect:", eM.message);



            }



        }







        try {



            const ipMaestro = config.isServer ? '127.0.0.1' : getIpMaestro();



            if (ipMaestro) {



                await llamarMaestro('POST', '/api/maestro/registrar-cierre', reporte, { timeout: 6000, reintentos: 2 });



                if (!config.isServer) db.prepare('UPDATE cierres_caja_locales SET estado_sync = 1 WHERE id = ?').run(reporte.id);



                console.log("📡 Cierre sincronizado con el Servidor Maestro exitosamente.");



            }



        } catch (errSync) {



            console.warn("⚠️ No se pudo sincronizar con el Maestro LAN:", errSync.message);



        }







        // Subir cierre al VPS en la nube



        sincronizarCierresConVps(reporte.companyId).catch(() => {});







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



        p = p || {};



        const id = p.id || `PM-${Date.now()}-${Math.floor(Math.random() * 1000)}`;



        const venta_id = p.venta_id || null;



        const numero_factura = p.numero_factura || 'S/N';



        const banco_receptor = p.banco_receptor || 'N/A';



        const referencia = p.referencia || '';



        const telefono_origen = p.telefono_origen || '';



        const monto = parseFloat(p.monto) || 0;



        const fecha_pago = p.fecha_pago || (function(){



            let d = new Date();



            let c = new Date(d.getTime() + (d.getTimezoneOffset() * 60000) - (4 * 3600000));



            let pad = (n) => String(n).padStart(2, '0');



            return c.getFullYear() + '-' + pad(c.getMonth() + 1) + '-' + pad(c.getDate()) + ' ' + pad(c.getHours()) + ':' + pad(c.getMinutes()) + ':' + pad(c.getSeconds());



        })();



        const company_id = p.company_id || 'DEFAULT_COMPANY';



        const branch_id = p.branch_id || 'SUC-01';



        const cashier_id = p.cashier_id || 'CAJERO-01';







        const stmt = db.prepare(`



            INSERT OR REPLACE INTO pagos_moviles_locales (



                id, venta_id, numero_factura, banco_receptor, referencia, 



                telefono_origen, monto, fecha_pago, company_id, branch_id, 



                cashier_id, estado_cierre



            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)



        `);



        const resultado = stmt.run(



            id, venta_id, numero_factura, banco_receptor, referencia,



            telefono_origen, monto, fecha_pago, company_id, branch_id,



            cashier_id



        );







        // Si estamos en nodo Servidor y masterDbDirect está disponible, replicar localmente



        if (config.isServer && masterDbDirect) {



            try {



                masterDbDirect.prepare(`



                    INSERT OR REPLACE INTO pagos_moviles_locales (



                        id, venta_id, numero_factura, banco_receptor, referencia, 



                        telefono_origen, monto, fecha_pago, company_id, branch_id, 



                        cashier_id, estado_cierre



                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)



                `).run(



                    id, venta_id, numero_factura, banco_receptor, referencia,



                    telefono_origen, monto, fecha_pago, company_id, branch_id,



                    cashier_id



                );



            } catch (eMaster) {



                console.warn("⚠️ Fallo replicando pago móvil en masterDbDirect:", eMaster.message);



            }



        }







        // Si es una caja secundaria, intentar sincronizar con el Maestro en red local



        try {



            const ipMaestro = config.isServer ? '127.0.0.1' : (typeof getIpMaestro === 'function' ? getIpMaestro() : null);



            if (ipMaestro && typeof llamarMaestro === 'function') {



                llamarMaestro('POST', '/api/maestro/registrar-pago-movil', {



                    id, venta_id, numero_factura, banco_receptor, referencia,



                    telefono_origen, monto, fecha_pago, company_id, branch_id,



                    cashier_id



                }, { timeout: 4000, reintentos: 1 }).catch(() => {});



            }



        } catch(eSync) {}







        console.log(`✅ Pago Móvil guardado localmente: ID ${id} | Factura: ${numero_factura} | Monto: ${monto} Bs`);



        return { success: true, changes: resultado.changes, id };



    } catch (e) {



        console.error("❌ Error guardando pago móvil local:", e.message);



        return { error: e.message };



    }



});











ipcMain.handle('obtener-pagos-moviles-caja', async (event, datos) => {



    try {



        datos = datos || {};



        const companyId = datos.companyId || datos.company_id || null;



        const branchId = datos.branchId || datos.branch_id || null;



        const cashierId = datos.cashierId || datos.cashier_id || null;



        



        let query = `



            SELECT * FROM pagos_moviles_locales 



            WHERE estado_cierre = 0



        `;



        const params = [];







        if (companyId) {



            query += ` AND (company_id = ? OR company_id IS NULL OR company_id = '' OR company_id = 'DEFAULT_COMPANY')`;



            params.push(companyId);



        }







        if (branchId) {



            query += ` AND (branch_id = ? OR branch_id IS NULL OR branch_id = '' OR branch_id = 'SUC-01')`;



            params.push(branchId);



        }







        if (cashierId) {



            query += ` AND (cashier_id = ? OR cashier_id IS NULL OR cashier_id = '' OR cashier_id = 'CAJERO-01')`;



            params.push(cashierId);



        }







        query += ` ORDER BY fecha_pago DESC`;







        const stmt = db.prepare(query);



        const pagos = stmt.all(...params);



        return pagos;



    } catch (error) {



        console.error("Error en el handler de obtener-pagos-moviles-caja:", error);



        return []; // Retornamos un array vacío en caso de fallo para no romper el frontend



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



        m = m || {};



        const id = m.id || `MOV-${Date.now()}-${Math.floor(Math.random() * 10000)}`;



        const tipo = m.tipo || 'INGRESO';



        const concepto = m.concepto || 'Movimiento de caja';



        const monto = parseFloat(m.monto) || 0;



        const monto_usd = parseFloat(m.monto_usd) || 0;



        const metodo_pago = m.metodo_pago || 'Efectivo';



        const fecha = m.fecha || getCaracasTime();



        const cashier_id = m.cashier_id || 'CAJERO-01';



        const company_id = m.company_id || 'DEFAULT_COMPANY';



        const branch_id = m.branch_id || 'SUC-01';







        const stmt = db.prepare(`



            INSERT INTO movimientos_caja_locales (



                id, tipo, concepto, monto, monto_usd, metodo_pago, 



                fecha, cashier_id, company_id, branch_id, estado_cierre



            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)



        `);



        



        const res = stmt.run(



            id, tipo, concepto, monto, monto_usd, metodo_pago,



            fecha, cashier_id, company_id, branch_id



        );







        if (config.isServer && masterDbDirect) {



            try {



                masterDbDirect.prepare(`



                    INSERT OR REPLACE INTO movimientos_caja_locales (



                        id, tipo, concepto, monto, monto_usd, metodo_pago, 



                        fecha, cashier_id, company_id, branch_id, estado_cierre



                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)



                `).run(



                    id, tipo, concepto, monto, monto_usd, metodo_pago,



                    fecha, cashier_id, company_id, branch_id



                );



            } catch (eMaster) {



                console.warn("⚠️ Advertencia al duplicar movimiento en masterDbDirect:", eMaster.message);



            }



        }







        return res;



    } catch (e) {



        console.error("❌ Error guardando movimiento local:", e.message);



        return { error: e.message };



    }



});







// 2. Obtener movimientos pendientes de cierre



ipcMain.handle('obtener-movimientos-caja', async (event, { tipo, companyId, cashierId, branchId }) => {



    try {



        let query = `



            SELECT * FROM movimientos_caja_locales 



            WHERE tipo = ? AND company_id = ? AND estado_cierre = 0



        `;



        const params = [tipo, companyId];







        if (cashierId) {



            query += ` AND (cashier_id = ? OR cashier_id IS NULL OR cashier_id = '')`;



            params.push(cashierId);



        }



        if (branchId) {



            query += ` AND (branch_id = ? OR branch_id IS NULL OR branch_id = '')`;



            params.push(branchId);



        }







        query += ` ORDER BY fecha DESC`;



        const stmt = db.prepare(query);



        return stmt.all(...params);



    } catch (e) {



        console.error("❌ Error consultando movimientos:", e.message);



        return [];



    }



});







// Obtener métodos de pago locales (respaldo offline)



ipcMain.handle('obtener-metodos-pago-local', async () => {

    try {

        let rows = db.prepare('SELECT * FROM metodos_pago_locales WHERE activo = 1 ORDER BY id ASC').all();

        if (!rows || rows.length === 0) {

            if (masterDbDirect) {

                try {

                    rows = masterDbDirect.prepare('SELECT * FROM metodos_pago_maestro WHERE activo = 1 ORDER BY id ASC').all();

                } catch(eM) {}

            }

        }

        if (!rows || rows.length === 0) {

            rows = [

                { id: '1000001', nombre: 'Efectivo', tecla: 'F5', tipo_moneda: 'BS', activo: 1, flag_impresora: '01' },

                { id: '1000002', nombre: 'Débito', tecla: 'F6', tipo_moneda: 'BS', activo: 1, flag_impresora: '12' },

                { id: '1000003', nombre: 'Pago Móvil', tecla: 'F7', tipo_moneda: 'BS', activo: 1, flag_impresora: '07' },

                { id: '1000004', nombre: 'Biopago', tecla: 'F8', tipo_moneda: 'BS', activo: 1, flag_impresora: '08' },

                { id: '1000005', nombre: 'Dólares Físicos', tecla: 'F9', tipo_moneda: 'USD', activo: 1, flag_impresora: '20' },

                { id: '1000008', nombre: 'Crédito', tecla: 'F12', tipo_moneda: 'BS', activo: 1, flag_impresora: '08' }

            ];

        }

        return rows;

    } catch (e) {

        console.error("❌ Error al obtener métodos de pago locales:", e.message);

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











ipcMain.handle('obtener-estado-auto-tasa', async () => {



    try {



        const rowCfg = db.prepare("SELECT valor FROM configuracion WHERE clave = 'confi_auto_tasa'").get();



        if (rowCfg && rowCfg.valor !== undefined && rowCfg.valor !== null) {



            return rowCfg.valor === 'true' || rowCfg.valor === true || rowCfg.valor === '1';



        }



        return false;



    } catch (e) {



        console.error("Error al obtener confi_auto_tasa de configuracion:", e);



        return false;



    }



});







ipcMain.handle('guardar-estado-auto-tasa', async (event, activo) => {



    try {



        const boolStr = (activo === true || activo === 'true' || activo === 1 || activo === '1') ? 'true' : 'false';



        const ahora = getCaracasTime();







        // Guardar en la tabla configuracion de nexus_pos.db con formato 'true' / 'false'



        db.prepare(`



            INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion)



            VALUES ('confi_auto_tasa', ?, ?)



        `).run(boolStr, ahora);







        if (masterDbDirect) {



            try {



                masterDbDirect.prepare(`



                    INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion)



                    VALUES ('confi_auto_tasa', ?, ?)



                `).run(boolStr, ahora);



            } catch (_) {}



            try {



                masterDbDirect.prepare(`



                    INSERT OR REPLACE INTO configuraciones_maestras (clave, valor)



                    VALUES ('confi_auto_tasa', ?)



                `).run(boolStr);



            } catch (_) {}



        }







        return { success: true, confi_auto_tasa: boolStr === 'true' };



    } catch (e) {



        console.error("Error al guardar confi_auto_tasa en configuracion:", e);



        return { success: false, error: e.message };



    }



});







let puertoActivo = null; 







function emitirPesoAlFrontend(pesoStr) {



    try {



        if (senderBasculaActivo && !senderBasculaActivo.isDestroyed()) {



            senderBasculaActivo.send('peso-recibido', pesoStr);



            return;



        }



        if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {



            win.webContents.send('peso-recibido', pesoStr);



        }



    } catch (e) {}



}







function extraerPesoDeTrama(rawStr) {



    if (!rawStr) return NaN;



    // Normalizar comas decimales (ej: "0,500" -> "0.500") sin afectar separadores como "ST,GS,+ 0.500kg"



    const normalizado = rawStr.replace(/(\d),(\d)/g, '$1.$2').trim();



    // 1. Buscar número decimal con signo opcional (estándar universal de pesos importados)



    const matchDecimal = normalizado.match(/([+-]?\s*\d+\.\d+)/);



    if (matchDecimal) {



        return parseFloat(matchDecimal[1].replace(/\s+/g, ''));



    }



    // 2. Fallback si la balanza envía un entero puro en la línea



    const matchEntero = normalizado.match(/^([+-]?\s*\d+)$/);



    if (matchEntero) {



        return parseFloat(matchEntero[1].replace(/\s+/g, ''));



    }



    return NaN;



}







function cerrarPuertoBasculaActual() {



    if (basculaReintentoTimer) {



        clearTimeout(basculaReintentoTimer);



        basculaReintentoTimer = null;



    }



    return new Promise((resolve) => {



        if (!basculaPort) return resolve();



        const portToClose = basculaPort;



        basculaPort = null;



        try {



            portToClose.removeAllListeners('data');



            portToClose.removeAllListeners('close');



            portToClose.removeAllListeners('open');



            portToClose.removeAllListeners('error');



            portToClose.on('error', () => {});



        } catch (e) {}







        if (portToClose.isOpen) {



            let resuelto = false;



            const timer = setTimeout(() => {



                if (!resuelto) {



                    resuelto = true;



                    resolve();



                }



            }, 600);



            try {



                portToClose.close(() => {



                    if (!resuelto) {



                        resuelto = true;



                        clearTimeout(timer);



                        // Pausa de seguridad para que Windows libere el handle del puerto COM



                        setTimeout(resolve, 100);



                    }



                });



            } catch (e) {



                if (!resuelto) {



                    resuelto = true;



                    clearTimeout(timer);



                    resolve();



                }



            }



        } else {



            try { portToClose.destroy(); } catch (e) {}



            setTimeout(resolve, 50);



        }



    });



}







function programarReconexionBascula(delayMs = 2500) {



    if (basculaReintentoTimer) clearTimeout(basculaReintentoTimer);



    if (!basculaConfigActual.enabled || !basculaConfigActual.path) return;



    basculaReintentoTimer = setTimeout(() => {



        basculaReintentoTimer = null;



        if (basculaConfigActual.enabled && basculaConfigActual.path) {



            conectarPuertoBascula(basculaConfigActual.path, basculaConfigActual.baudRate, false);



        }



    }, delayMs);



}







async function conectarPuertoBascula(puertoCOM, baudRate, forzarReapertura = false) {



    const cleanPort = puertoCOM ? String(puertoCOM).trim() : '';



    const cleanBaud = baudRate ? parseInt(baudRate, 10) : 9600;







    if (!cleanPort) {



        basculaConfigActual.enabled = false;



        await cerrarPuertoBasculaActual();



        return;



    }







    const mismoPuertoYBaudios = (



        basculaPort &&



        basculaPort.isOpen &&



        basculaConfigActual.path === cleanPort &&



        basculaConfigActual.baudRate === cleanBaud



    );







    basculaConfigActual = {



        path: cleanPort,



        baudRate: cleanBaud,



        enabled: true



    };







    if (mismoPuertoYBaudios && !forzarReapertura) {



        console.log(`⚖️ El puerto ${cleanPort} (${cleanBaud} bps) ya está abierto y activo. Redirigiendo datos a la ventana...`);



        let pesoActual = ultimoPesoBruto - taraOffset;



        if (pesoActual < 0) pesoActual = 0;



        emitirPesoAlFrontend(pesoActual.toFixed(3));



        return;



    }







    if (basculaConectando) return;



    basculaConectando = true;







    try {



        await cerrarPuertoBasculaActual();







        const thisPort = new SerialPort({



            path: cleanPort,



            baudRate: cleanBaud,



            dataBits: 8,



            stopBits: 1,



            parity: 'none',



            rtscts: false,



            xon: false,



            xoff: false,



            autoOpen: false



        });







        basculaPort = thisPort;



        let bufferSerial = '';







        thisPort.on('open', () => {



            if (basculaPort !== thisPort) return;



            console.log(`✅ Puerto de báscula abierto de forma segura: ${cleanPort} (${cleanBaud} baudios)`);



            taraOffset = 0.0;



            // Activar DTR/RTS para energizar optoacopladores RS232 de balanzas importadas



            try {



                thisPort.set({ dtr: true, rts: true }, () => {});



            } catch (e) {}



        });







        thisPort.on('data', (chunk) => {



            if (basculaPort !== thisPort) return;



            bufferSerial += chunk.toString('latin1');



            if (bufferSerial.length > 512) {



                bufferSerial = bufferSerial.slice(-256);



            }







            // Soportar delimitadores \r\n, \n, \r, STX (\x02) y ETX (\x03)



            const partes = bufferSerial.split(/[\r\n\x02\x03]+/);



            bufferSerial = partes.pop() || '';







            for (const linea of partes) {



                const trimmed = linea.trim();



                if (!trimmed) continue;



                const rawWeight = extraerPesoDeTrama(trimmed);



                if (!isNaN(rawWeight)) {



                    ultimoPesoBruto = rawWeight;



                    let pesoNeto = rawWeight - taraOffset;



                    if (pesoNeto < 0) pesoNeto = 0;



                    emitirPesoAlFrontend(pesoNeto.toFixed(3));



                }



            }



        });







        thisPort.on('error', (err) => {



            if (basculaPort !== thisPort) return;



            console.error(`❌ Error en puerto de báscula (${cleanPort}):`, err.message);



            if (!thisPort.isOpen) {



                basculaPort = null;



                programarReconexionBascula(2500);



            }



        });







        thisPort.on('close', () => {



            if (basculaPort !== thisPort) return;



            console.warn(`🔌 Puerto de báscula (${cleanPort}) se cerró. Reintentando conexión automática...`);



            basculaPort = null;



            programarReconexionBascula(2000);



        });







        thisPort.open((err) => {



            basculaConectando = false;



            if (err) {



                if (basculaPort === thisPort) basculaPort = null;



                console.warn(`⚠️ No se pudo abrir ${cleanPort} (${err.message}). Reintentando en 2.5s...`);



                programarReconexionBascula(2500);



            }



        });



    } catch (error) {



        basculaConectando = false;



        console.error("❌ Error al inicializar báscula:", error);



        programarReconexionBascula(2500);



    }



}







ipcMain.on('tarear-bascula', () => {



    taraOffset = ultimoPesoBruto; 



    console.log(`⚖️ Báscula Tareada (Software). Nuevo Offset: ${taraOffset}`);



    emitirPesoAlFrontend('0.000');



});







ipcMain.on('iniciar-puerto-bascula', (event, puertoCOM, baudRate) => {



    // 1. SIEMPRE actualizamos a quién le vamos a enviar la data (la nueva ventana)



    senderBasculaActivo = event.sender;



    conectarPuertoBascula(puertoCOM, baudRate, false);



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



    try {



        cierreAutorizado = true;



        const webContents = event.sender;



        if (webContents && !webContents.isDestroyed()) {



            const currentWindow = BrowserWindow.fromWebContents(webContents);



            if (currentWindow && !currentWindow.isDestroyed()) {



                currentWindow.removeAllListeners('close');



                currentWindow.close();



            }



        }



        app.quit();



    } catch (err) {



        console.error("Error al cerrar ventana de login:", err);



        app.quit();



    }



});







ipcMain.on('abrir-ventana-principal', (event, ruta) => {



    sistemaPrincipalAbierto = true;

    if (splash && !splash.isDestroyed()) splash.close();







    win = new BrowserWindow({



        width: 1280,



        height: 800,



        minWidth: 1024,  // Impide que se reduzca a menos de 1024px de ancho



        minHeight: 768, // Impide que se reduzca a menos de 768px de alto



        frame: true,         // DEVUELVE EL MARCO DE WINDOWS



        autoHideMenuBar: true, // OCULTA MENÚ SUPERIOR (File, Edit, View, Window)



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



            try {



                if (win && !win.isDestroyed()) {



                    const wc = win.webContents;



                    if (wc && !wc.isDestroyed()) {



                        wc.send('solicitar-verificacion-cierre');



                    }



                }



            } catch (err) {



                console.error("Error al solicitar verificacion de cierre:", err);



            }



        }



    });







    const webContents = event.sender;



    if (webContents && !webContents.isDestroyed()) {



        const loginWindow = BrowserWindow.fromWebContents(webContents);



        if (loginWindow && !loginWindow.isDestroyed()) {



            loginWindow.removeAllListeners('close');



            loginWindow.close();



        }



    }



});



ipcMain.handle('guardar-usuario-local', async (event, datos) => {



    try {



        const stmt = db.prepare(`



            INSERT OR REPLACE INTO usuarios_locales (uid, email, role, companyId, branchId, company_data, last_login)



            VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-4 hours'))



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







ipcMain.handle('guardar-tasa-bcv', async (event, tasa, confi_auto_tasa) => {



    try {



        const ahora = getCaracasTime();



        const stmt = db.prepare(`INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion) VALUES ('TASA_BCV', ?, ?)`);



        stmt.run(tasa.toString(), ahora);



        



        // Si se pasa confi_auto_tasa, guardarlo en la tabla configuracion como 'true' o 'false'



        if (confi_auto_tasa !== undefined && confi_auto_tasa !== null) {



            const boolStr = (confi_auto_tasa === true || confi_auto_tasa === 'true' || confi_auto_tasa === 1 || confi_auto_tasa === '1') ? 'true' : 'false';



            db.prepare(`INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion) VALUES ('confi_auto_tasa', ?, ?)`).run(boolStr, ahora);



        }







        try {



            const hoy = ahora.split(' ')[0];



            db.prepare(`



                INSERT INTO historial_tasas (fecha, valor, fuente) 



                VALUES (?, ?, 'BCV')



                ON CONFLICT(fecha) DO UPDATE SET valor = excluded.valor



            `).run(hoy, parseFloat(tasa));



        } catch (_) {}



        



        // 🔥 Notificar a las cajas hijas que la tasa cambió



        if (config.isServer) {



            axios.get('http://127.0.0.1:3000/api/maestro/notificar-cambio/tasa').catch(() => {});



        }







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



            const hoy = getCaracasTime().split(' ')[0];



            



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







// --- RUTAS RECUPERADAS DE SERVER.JS ---



server.get('/api/maestro/stock', (req, res) => {



    const { sucursalId, companyId } = req.query;



    if (!masterDbDirect) return res.status(500).json({ error: "Base de datos maestra no inicializada" });



    try {



        let query;



        let params;







        if (sucursalId && sucursalId !== 'undefined' && sucursalId !== 'null') {



            query = `SELECT producto_id, cantidad_real FROM stock_maestro WHERE sucursal_id = ? AND company_id = ?`;



            params = [sucursalId, companyId];



        } else {



            query = `SELECT producto_id, SUM(cantidad_real) as cantidad_real 



                     FROM stock_maestro 



                     WHERE company_id = ? 



                     GROUP BY producto_id`;



            params = [companyId];



        }







        const filas = masterDbDirect.prepare(query).all(...params);



        res.json(filas);



    } catch (e) {



        console.error("❌ Error en stock maestro:", e.message);



        res.status(500).json({ error: e.message });



    }



});







server.get('/api/maestro/estadisticas', (req, res) => {



    if (!masterDbDirect) return res.status(500).json({ exito: false, error: "Base de datos maestra no inicializada" });



    try {



        const { fecha_inicio, fecha_fin, companyId, periodo } = req.query;



        if (!fecha_inicio || !fecha_fin || !companyId) {



            return res.status(400).json({ exito: false, error: "Faltan parámetros (fecha_inicio, fecha_fin, companyId)" });



        }







        const fechaIni = `${fecha_inicio} 00:00:00`;



        const fechaFin = `${fecha_fin} 23:59:59`;







        // 1. Ganancias estimadas y Ventas Totales en USD (monto_total dividido por tasa BCV)



        const resumenVentas = masterDbDirect.prepare(`



            SELECT 



                SUM(ganancia_venta) as total_ganancia,



                SUM(ROUND(monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1), 2)) as total_venta,



                SUM(ROUND(monto_total, 2)) as total_venta_bs



            FROM ventas_locales 



            WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?



              AND (estado != 'ANULADA' OR estado IS NULL)



              AND (es_nota_credito = 0 OR es_nota_credito IS NULL)



        `).get(companyId, fechaIni, fechaFin);



        const total_ganancia = resumenVentas?.total_ganancia || 0;



        const total_venta = resumenVentas?.total_venta || 0;



        const total_venta_bs = resumenVentas?.total_venta_bs || 0;







        const cogsResult = masterDbDirect.prepare(`



            SELECT SUM((monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1)) - ganancia_venta) as total_cogs



            FROM ventas_locales



            WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?



        `).get(companyId, fechaIni, fechaFin);



        const total_cogs = Math.max(0, cogsResult?.total_cogs || 0);







        // 2. Top Clientes (Ranking Completo)



        const topClientes = masterDbDirect.prepare(`



            SELECT cliente_nombre, cliente_rif, COUNT(*) as total_compras_count, 



                   SUM(monto_total) as total_comprado,



                   SUM(ROUND(monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1), 2)) as total_comprado_usd



            FROM ventas_locales



            WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?



            GROUP BY cliente_rif



            ORDER BY total_comprado_usd DESC



        `).all(companyId, fechaIni, fechaFin);







        // 3. Top Productos (con Unidad de Medida Inteligente y Ranking Completo)



        const topProductos = [];



        try {



            const prodsDb = masterDbDirect.prepare(`SELECT id, datos_json FROM productos_locales WHERE company_id = ?`).all(companyId);



            const mapaUnidadesCatalogo = {};



            prodsDb.forEach(p => {



                try {



                    const d = typeof p.datos_json === 'string' ? JSON.parse(p.datos_json) : (p.datos_json || {});



                    mapaUnidadesCatalogo[p.id] = d.unit || d.unidad || p.unit || 'UN';



                } catch(e){}



            });







            // Cruzar con la tabla unidades_empaque para detectar medidas configuradas (ej: KG, Litro, etc.)



            try {



                const empaquesDb = masterDbDirect.prepare(`SELECT product_id, tipo_medida, nombre_unidad FROM unidades_empaque WHERE company_id = ?`).all(companyId);



                empaquesDb.forEach(emp => {



                    const idProd = emp.product_id;



                    const u = emp.tipo_medida || emp.nombre_unidad;



                    if (idProd && u) {



                        mapaUnidadesCatalogo[idProd] = u;



                    }



                });



            } catch(eEmp) {}







            const ventas = masterDbDirect.prepare(`SELECT datos_json FROM ventas_locales WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?`).all(companyId, fechaIni, fechaFin);



            const mapa = {};



            ventas.forEach(v => {



                try {



                    const parsed = JSON.parse(v.datos_json);



                    const prodArray = Array.isArray(parsed) ? parsed : (parsed.productos || parsed.items || []);



                    prodArray.forEach(item => {



                        if (item.id === 'PAGO-DEUDA' || String(item.codigo || '').toUpperCase() === 'DEUDA') return; // Abonos no son productos



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



            const array = Object.values(mapa).sort((a,b) => b.cantidad_vendida - a.cantidad_vendida);



            topProductos.push(...array);



        } catch(e) {}







        // 3.1 Top Sucursales (con Resolución de Nombre y Ranking Completo)



        const topSucursales = masterDbDirect.prepare(`



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



        `).all(companyId, fechaIni, fechaFin);







        let serieTiempo;



        if (periodo === 'dia' || fecha_inicio === fecha_fin) {



            serieTiempo = masterDbDirect.prepare(`



                SELECT strftime('%Y-%m-%d %H:00:00', fecha_emision) as fecha,



                       SUM(ganancia_venta) as total_ganancia,



                       SUM(ROUND(monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1), 2)) as total_venta,



                       SUM(ROUND(monto_total, 2)) as total_venta_bs



                FROM ventas_locales



                WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?



                  AND (estado != 'ANULADA' OR estado IS NULL)



                  AND (es_nota_credito = 0 OR es_nota_credito IS NULL)



                GROUP BY strftime('%Y-%m-%d %H', fecha_emision)



                ORDER BY fecha ASC



            `).all(companyId, fechaIni, fechaFin);



        } else {



            serieTiempo = masterDbDirect.prepare(`



                SELECT date(fecha_emision) as fecha,



                       SUM(ganancia_venta) as total_ganancia,



                       SUM(ROUND(monto_total / COALESCE(NULLIF(tasa_bcv, 0), 1), 2)) as total_venta,



                       SUM(ROUND(monto_total, 2)) as total_venta_bs



                FROM ventas_locales



                WHERE company_id = ? AND fecha_emision BETWEEN ? AND ?



                  AND (estado != 'ANULADA' OR estado IS NULL)



                  AND (es_nota_credito = 0 OR es_nota_credito IS NULL)



                GROUP BY date(fecha_emision)



                ORDER BY fecha ASC



            `).all(companyId, fechaIni, fechaFin);



        }







        let stocks_promedio = [];



        try {



            const rowsActual = masterDbDirect.prepare('SELECT producto_id, SUM(cantidad_real) as cant FROM stock_maestro WHERE company_id = ? GROUP BY producto_id').all(companyId);



            



            const movimientos = masterDbDirect.prepare(`



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







ipcMain.on('cerrar-y-volver-login', (event) => {



    const currentWin = BrowserWindow.fromWebContents(event.sender);



    



    // Autorizamos el cierre solo de esta ventana (sin hacer app.quit)



    cierreAutorizado = true;







    // Asignar a la variable global 'win' para mantener viva la referencia



    win = new BrowserWindow({



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







    win.loadFile('public/index.html');



    win.center();



    



    if (currentWin && !currentWin.isDestroyed()) {



        currentWin.removeAllListeners('close');



        currentWin.close();



    }



    



    // Restauramos la seguridad de cierre para la próxima vez



    cierreAutorizado = false;



});







ipcMain.handle('obtener-productos-local', async (event, empresaId) => {



    try {



        console.log(`📁 Solicitando productos locales para la empresa: ${empresaId}`);



        if (!config.isServer) {



            const ipMaestro = getIpMaestro();



            if (ipMaestro) {



                try {



                    const url = `http://${ipMaestro}:3000/api/maestro/obtener-productos?empresaId=${encodeURIComponent(empresaId || '')}`;



                    const reqFetch = await fetch(url, { signal: AbortSignal.timeout(10000) });



                    if (reqFetch.ok) {



                        const data = await reqFetch.json();



                        if (Array.isArray(data)) return data;



                    }



                } catch(netErr) {



                    throw new Error("Sin conexión con el Servidor Maestro. Imposible operar facturación.");



                }



            }



        }



        



        let stmt;



        if (empresaId) {



            stmt = db.prepare(`SELECT * FROM productos_locales WHERE company_id = ? AND status != -1 ORDER BY nombre ASC`);



            return stmt.all(empresaId);



        } else {



            stmt = db.prepare(`SELECT * FROM productos_locales WHERE status != -1 ORDER BY nombre ASC`);



            return stmt.all();



        }



        



    } catch (e) {



        console.error("❌ Error en obtener-productos-local:", e);



        return []; 



    }



});







// ═══════════════════════════════════════════════════════════════════



// 🔍 OPTIMIZACIÓN: OBTENER PRODUCTOS PAGINADOS Y FILTRADOS



// ═══════════════════════════════════════════════════════════════════



ipcMain.handle('obtener-productos-paginados', async (event, { empresaId, limit = 350, offset = 0, letterFilter = '', searchQuery = '' }) => {



    try {



        if (!config.isServer) {



            const ipMaestro = getIpMaestro();



            if (ipMaestro) {



                const url = `http://${ipMaestro}:3000/api/maestro/obtener-productos-paginados?empresaId=${encodeURIComponent(empresaId || '')}&limit=${limit}&offset=${offset}&letterFilter=${encodeURIComponent(letterFilter || '')}&searchQuery=${encodeURIComponent(searchQuery || '')}`;



                const reqFetch = await fetch(url, { signal: AbortSignal.timeout(10000) });



                if (reqFetch.ok) {



                    return await reqFetch.json();



                }



            }



        }







        let baseQuery = `FROM productos_locales WHERE status != -1`;



        const params = [];







        if (empresaId) {



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







        const countStmt = db.prepare(`SELECT COUNT(*) as total ${baseQuery}`);



        const countResult = countStmt.get(...params);



        const totalCount = countResult ? countResult.total : 0;







        let data = [];



        if (limit === -1) {



            const dataStmt = db.prepare(`SELECT * ${baseQuery} ORDER BY nombre ASC`);



            data = dataStmt.all(...params);



        } else {



            const dataStmt = db.prepare(`SELECT * ${baseQuery} ORDER BY nombre ASC LIMIT ? OFFSET ?`);



            data = dataStmt.all(...params, limit, offset);



        }







        return { data, totalCount };



    } catch (e) {



        console.error("❌ Error en obtener-productos-paginados:", e);



        return { data: [], totalCount: 0 };



    }



});







// ═══════════════════════════════════════════════════════════════════



// 🚀 OPTIMIZACIÓN: SINCRONIZACIÓN EN LOTE (BULK UPSERT)



// Recibe un array de productos y los guarda todos en una sola transacción SQLite.



// Elimina la necesidad de N llamadas IPC individuales (una por producto).



// Emite el evento 'productos-actualizados' UNA SOLA VEZ al finalizar.



// ═══════════════════════════════════════════════════════════════════



// Helper para detectar si un producto realmente cambió respecto a la fila en SQLite



function haCambiadoProductoEnBD(local, p, barcodeRef, precioRef, compraRef, porcentajeRef) {



    if (!local) return true;



    if (String(local.codigo || '') !== String(barcodeRef || '')) return true;



    if (String(local.nombre || '') !== String(p.nombre || '')) return true;



    if (Math.abs((parseFloat(local.precio) || 0) - precioRef) > 0.0001) return true;



    if (Math.abs((parseFloat(local.precio_compra) || 0) - compraRef) > 0.0001) return true;



    if (Math.abs((parseFloat(local.porcentaje_ganancia) || 0) - porcentajeRef) > 0.0001) return true;



    if (String(local.categoria || '') !== String(p.categoria || '')) return true;



    if (Number(local.status ?? 1) !== Number(p.status ?? 1)) return true;



    if (String(local.imagen || '') !== String(p.imagen || '')) return true;







    try {



        const localJson = local.datos_json ? (typeof local.datos_json === 'string' ? JSON.parse(local.datos_json) : local.datos_json) : {};



        const nuevoJson = p.datos_json ? (typeof p.datos_json === 'string' ? JSON.parse(p.datos_json) : p.datos_json) : p;



        const preciosLocal = JSON.stringify(localJson.precios || p.precios_local || null);



        const preciosNuevo = JSON.stringify(p.precios || nuevoJson.precios || null);



        if (preciosLocal !== preciosNuevo) return true;



        if (String(localJson.moneda || localJson.currency || 'USD') !== String(p.moneda || nuevoJson.moneda || nuevoJson.currency || 'USD')) return true;



        if (String(localJson.unit || localJson.unidad || 'UN') !== String(p.unit || nuevoJson.unit || nuevoJson.unidad || 'UN')) return true;



        if (String(localJson.tipo_alicuota ?? '16') !== String(p.tipo_alicuota ?? nuevoJson.tipo_alicuota ?? '16')) return true;



    } catch (e) {}







    return false;



}







let _timerNotificarProductos = null;



function notificarProductosActualizados(notificarSSE = true) {



    if (_timerNotificarProductos) clearTimeout(_timerNotificarProductos);



    _timerNotificarProductos = setTimeout(() => {



        _timerNotificarProductos = null;



        BrowserWindow.getAllWindows().forEach(ventana => {



            if (!ventana.isDestroyed()) ventana.webContents.send('productos-actualizados');



        });



        if (notificarSSE && config.isServer) {



            axios.get('http://127.0.0.1:3000/api/maestro/notificar-cambio/productos').catch(() => {});



        }



    }, 350);



}







let _timerNotificarStock = null;



function notificarStockActualizado() {



    if (_timerNotificarStock) clearTimeout(_timerNotificarStock);



    _timerNotificarStock = setTimeout(() => {



        _timerNotificarStock = null;



        BrowserWindow.getAllWindows().forEach(v => {



            if (!v.isDestroyed()) v.webContents.send('stock-actualizado-global');



        });



    }, 350);



}







ipcMain.handle('sincronizar-productos-lote', async (event, productos) => {



    if (!productos || productos.length === 0) return { changes: 0, inserted: 0, updated: 0 };



    



    try {



        const stmtSelect = db.prepare('SELECT * FROM productos_locales WHERE id = ?');



        const stmtInsert = db.prepare(`



            INSERT INTO productos_locales (id, company_id, branch_id, codigo, nombre, precio, precio_compra, porcentaje_ganancia, categoria, status, imagen, datos_json, estado_sync, fecha_modificacion)



            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)



        `);



        const stmtUpdate = db.prepare(`



            UPDATE productos_locales



            SET codigo = ?, nombre = ?, precio = ?, precio_compra = ?, porcentaje_ganancia = ?, categoria = ?, status = ?, imagen = ?, datos_json = ?, estado_sync = ?, fecha_modificacion = ?



            WHERE id = ?



        `);



        const stmtUpdateSyncOnly = db.prepare(`



            UPDATE productos_locales SET estado_sync = ? WHERE id = ?



        `);







        const transaccion = db.transaction((items) => {



            let inserted = 0;



            let updated = 0;



            for (const p of items) {



                const idProducto  = p.id || p.producto_ID;



                const idEmpresa   = p.company_id || p.empresa_ID;



                const idSucursal  = p.branch_id || p.sucursal_ID || 'sucursal_1';



                const barcodeRef  = p.codigo || p.producto_codigo || '';



                const precioRef   = parseFloat(p.precios ? p.precios.p1.venta : (p.precio_venta || p.precio || 0)) || 0;



                const compraRef   = parseFloat(p.precios ? p.precios.p1.compra : (p.precio_compra || 0)) || 0;



                const porcentajeRef = parseFloat(p.precios ? p.precios.p1.porcentaje : (p.porcentaje_ganancia || 0)) || 0;



                const jsonGuardar = typeof p.datos_json === 'string' ? p.datos_json : JSON.stringify(p);



                const estadoSync  = p.estado_sync !== undefined ? p.estado_sync : 0;







                const existe = stmtSelect.get(idProducto);



                if (!existe) {



                    stmtInsert.run(idProducto, idEmpresa, idSucursal, barcodeRef, p.nombre, precioRef, compraRef, porcentajeRef, p.categoria, p.status, p.imagen, jsonGuardar, estadoSync, p.fecha_modificacion);



                    inserted++;



                } else if (haCambiadoProductoEnBD(existe, p, barcodeRef, precioRef, compraRef, porcentajeRef)) {



                    stmtUpdate.run(barcodeRef, p.nombre, precioRef, compraRef, porcentajeRef, p.categoria, p.status, p.imagen, jsonGuardar, estadoSync, p.fecha_modificacion || existe.fecha_modificacion, idProducto);



                    updated++;



                } else if (Number(existe.estado_sync) !== Number(estadoSync)) {



                    stmtUpdateSyncOnly.run(estadoSync, idProducto);



                }



            }



            return { inserted, updated };



        });







        const resultado = transaccion(productos);



        if (resultado.inserted > 0 || resultado.updated > 0) {



            console.log(`✅ [LOTE] ${resultado.inserted} insertados, ${resultado.updated} actualizados.`);



            notificarProductosActualizados(true);



        }







        return { success: true, ...resultado, changes: resultado.inserted + resultado.updated };



    } catch (e) {



        console.error("❌ Error en sincronizar-productos-lote:", e);



        return { error: e.message };



    }



});







// ═══════════════════════════════════════════════════════════════════



// 🔍 OPTIMIZACIÓN: BÚSQUEDA DE PRODUCTOS EN BACKEND (SQL LIKE)



// Recibe un texto de búsqueda y retorna máximo 60 resultados activos



// usando índices de SQLite. El frontend NUNCA descarga todo el catálogo.



// ═══════════════════════════════════════════════════════════════════



ipcMain.handle('buscar-productos-local', async (event, { query, empresaId }) => {



    try {



        if (!config.isServer) {



            const ipMaestro = getIpMaestro();



            if (ipMaestro) {



                const url = `http://${ipMaestro}:3000/api/maestro/buscar-productos-local?query=${encodeURIComponent(query || '')}&empresaId=${encodeURIComponent(empresaId || '')}`;



                const reqFetch = await fetch(url, { signal: AbortSignal.timeout(6000) });



                if (reqFetch.ok) {



                    const data = await reqFetch.json();



                    if (Array.isArray(data)) return data;



                }



            }



        }







        const term = `%${(query || '').trim()}%`;



        let stmt;



        if (empresaId) {



            stmt = db.prepare(`



                SELECT *



                FROM productos_locales



                WHERE company_id = ?



                  AND status != -1



                  AND (nombre LIKE ? OR codigo LIKE ? OR categoria LIKE ?)



                ORDER BY nombre ASC



                LIMIT 60



            `);



            return stmt.all(empresaId, term, term, term);



        } else {



            stmt = db.prepare(`



                SELECT *



                FROM productos_locales



                WHERE status != -1



                  AND (nombre LIKE ? OR codigo LIKE ? OR categoria LIKE ?)



                ORDER BY nombre ASC



                LIMIT 60



            `);



            return stmt.all(term, term, term);



        }



    } catch (e) {



        console.error("❌ Error en buscar-productos-local:", e);



        return [];



    }



});







// ═══════════════════════════════════════════════════════════════════



// 📡 OPTIMIZACIÓN: BÚSQUEDA POR CÓDIGO DE BARRAS (ESCÁNER)



// Búsqueda exacta e instantánea por código de barras desde SQLite.



// Retorna el primer producto activo que coincida exactamente con el código.



// ═══════════════════════════════════════════════════════════════════



ipcMain.handle('buscar-producto-por-codigo', async (event, { codigo, empresaId }) => {



    try {



        if (!config.isServer) {



            const ipMaestro = getIpMaestro();



            if (ipMaestro) {



                const url = `http://${ipMaestro}:3000/api/maestro/buscar-producto-por-codigo?codigo=${encodeURIComponent(codigo || '')}&empresaId=${encodeURIComponent(empresaId || '')}`;



                try {



                    const reqFetch = await fetch(url, { signal: AbortSignal.timeout(6000) });



                    if (reqFetch.ok) {



                        const data = await reqFetch.json();



                        if (data && typeof data === 'object' && !data.error) return data;



                    }



                } catch(errFetch) {



                    console.warn("⚠️ [buscar-producto-por-codigo] Error fetch al Maestro:", errFetch.message);



                }



            }



        }







        const codigoLimpio = String(codigo || '').trim();



        if (!codigoLimpio) return null;







        // 🛡️ PROTECCIÓN ANTI-COLISIÓN: Si el código es genérico (ej. 'Sin código', 'S/C'), NO buscar por columna codigo



        const codigosGenericos = ['sin código', 'sin codigo', 's/c', 'sc', 'none', 'null', 'undefined'];



        const esGenerico = codigosGenericos.includes(codigoLimpio.toLowerCase());







        let stmt;



        if (empresaId && empresaId !== 'undefined' && empresaId.trim() !== '') {



            if (esGenerico) {



                stmt = db.prepare(`



                    SELECT * FROM productos_locales



                    WHERE company_id = ? AND id = ? AND status != -1 AND status != 0



                    LIMIT 1



                `);



                return stmt.get(empresaId, codigoLimpio) || null;



            } else {



                stmt = db.prepare(`



                    SELECT * FROM productos_locales



                    WHERE company_id = ? AND (codigo = ? OR id = ?) AND status != -1 AND status != 0



                    LIMIT 1



                `);



                return stmt.get(empresaId, codigoLimpio, codigoLimpio) || null;



            }



        } else {



            if (esGenerico) {



                stmt = db.prepare(`



                    SELECT * FROM productos_locales



                    WHERE id = ? AND status != -1 AND status != 0



                    LIMIT 1



                `);



                return stmt.get(codigoLimpio) || null;



            } else {



                stmt = db.prepare(`



                    SELECT * FROM productos_locales



                    WHERE (codigo = ? OR id = ?) AND status != -1 AND status != 0



                    LIMIT 1



                `);



                return stmt.get(codigoLimpio, codigoLimpio) || null;



            }



        }



    } catch (e) {



        console.error("❌ Error en buscar-producto-por-codigo:", e);



        return null;



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







ipcMain.handle('guardar-venta-local', async (event, v) => {



    try {



        // --- 🛡️ CALCULO ROBUSTO DE GANANCIA EN EL BACKEND ---



        try {



            let gananciaTotal = 0;



            let parsedData = JSON.parse(v.datos_json);



            let productos = parsedData.productos || [];



            let tasaBcv = parseFloat(v.tasa_bcv) || 1;



            



            for (let prod of productos) {



                // REGLA DE NEGOCIO: Los abonos a deudas no generan ganancias



                if (prod.id === 'PAGO-DEUDA' || (prod.codigo && String(prod.codigo).toUpperCase() === 'DEUDA')) {



                    prod.ganancia_unitaria = 0;



                    continue;



                }







                let costo = 0;



                let stmtProd = db.prepare("SELECT precio, precio_compra, datos_json, porcentaje_ganancia FROM productos_locales WHERE id = ?");



                let dbProd = stmtProd.get(prod.id);



                



                if (dbProd) {



                    if (dbProd.precio_compra !== null && dbProd.precio_compra !== undefined && parseFloat(dbProd.precio_compra) > 0) {



                        costo = parseFloat(dbProd.precio_compra);



                    } else if (dbProd.datos_json) {



                        try {



                            let dj = JSON.parse(dbProd.datos_json);



                            if (dj.precio_compra) costo = parseFloat(dj.precio_compra);



                            else if (dj.costo) costo = parseFloat(dj.costo);



                            else if (dj.precios && dj.precios.p1 && dj.precios.p1.compra) costo = parseFloat(dj.precios.p1.compra);



                        } catch(e){}



                    }



                }







                if (!costo && prod.precio_compra) {



                    costo = parseFloat(prod.precio_compra) || 0;



                } else if (!costo && prod.costo) {



                    costo = parseFloat(prod.costo) || 0;



                }



                



                let precioVenta = parseFloat(prod.precio) || 0;



                let monedaProd = (prod.moneda || 'USD').toUpperCase();



                let ganancia = 0;







                // Cálculo prioritario: precio de venta (base) - costo (compra)



                if (costo > 0 || dbProd) {



                    ganancia = precioVenta - costo;



                } else if (prod.ganancia_unitaria !== undefined && prod.ganancia_unitaria !== null && parseFloat(prod.ganancia_unitaria) < precioVenta) {



                    ganancia = parseFloat(prod.ganancia_unitaria) || 0;



                } else {



                    ganancia = precioVenta - costo;



                }







                if (isNaN(ganancia) || ganancia < 0) ganancia = 0;







                // Normalización a USD si el producto se vendió en bolívares



                if (monedaProd === 'BS' || monedaProd === 'VES') {



                    ganancia = ganancia / tasaBcv;



                }







                prod.ganancia_unitaria = parseFloat(ganancia.toFixed(4));







                let cantidad = parseFloat(prod.cantidad || prod.quantity || 1);



                gananciaTotal += (ganancia * cantidad);



            }







            // Actualizamos los datos_json con los objetos corregidos



            parsedData.productos = productos;



            v.datos_json = JSON.stringify(parsedData);







            v.ganancia_venta = parseFloat(gananciaTotal.toFixed(2));



            console.log("✅ Ganancia calculada de forma segura en el backend:", v.ganancia_venta);



        } catch(e) {



            console.error("❌ Error calculando ganancia en backend:", e);



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



        



        v.monto_exento = parseFloat(v.monto_exento) || 0;



        v.base_imponible = parseFloat(v.base_imponible) || 0;



        v.monto_iva = parseFloat(v.monto_iva) || 0;



        v.monto_igtf = parseFloat(v.monto_igtf) || 0;



        v.monto_total = parseFloat(v.monto_total) || (v.monto_exento + v.base_imponible + v.monto_iva + v.monto_igtf);







        // 🛡️ Saneamiento estricto contra valores 'undefined' que puedan romper better-sqlite3



        v.id = v.id || `VTA-${Date.now()}`;



        v.company_id = v.company_id || 'DEFAULT_COMPANY';



        v.branch_id = v.branch_id || 'SUC-01';



        v.cashier_id = v.cashier_id || 'CAJERO-01';



        v.numero_factura = v.numero_factura || `VTA-${Date.now()}`;



        v.numero_control = v.numero_control || 'MAESTRO-001';



        v.cliente_nombre = v.cliente_nombre || 'CONSUMIDOR FINAL';



        v.cliente_rif = v.cliente_rif || 'V000000000';



        v.tasa_bcv = parseFloat(v.tasa_bcv) || 1;



        v.metodo_pago = typeof v.metodo_pago === 'string' ? v.metodo_pago : JSON.stringify(v.metodo_pago || {});



        v.datos_json = sanitizarDatosJsonVenta(typeof v.datos_json === 'string' ? v.datos_json : JSON.stringify(v.datos_json || {}));



        v.ganancia_venta = parseFloat(v.ganancia_venta) || 0;



        v.es_nota_credito = v.es_nota_credito ? 1 : 0;



        v.es_nota_debito = v.es_nota_debito ? 1 : 0;



        v.factura_afectada = v.factura_afectada || null;



        v.monto_factura_afectada = v.monto_factura_afectada || null;



        v.fecha_factura_afectada = v.fecha_factura_afectada || null;



        v.estado = v.estado || 'EMITIDA';







        console.log(`📋 [GUARDAR] Factura: ${v.numero_factura} | Control: ${v.numero_control} | Total: ${v.monto_total} | HKA: ${v.datos_hka ? JSON.stringify(v.datos_hka) : 'N/A'}`);







        const stmt = db.prepare(`



            INSERT OR REPLACE INTO ventas_locales (



                id, company_id, branch_id, cashier_id, numero_factura, 



                numero_control, cliente_nombre, cliente_rif, monto_exento, 



                base_imponible, monto_iva, monto_igtf, monto_total, 



                tasa_bcv, metodo_pago, datos_json, ganancia_venta, estado_sync, estado_sync_maestro, sync_server, estado_cierre,



                es_nota_credito, es_nota_debito, factura_afectada, monto_factura_afectada, fecha_factura_afectada, fecha_emision, estado



            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, datetime('now', '-4 hours'), ?)



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



            v.fecha_factura_afectada || null,



            v.estado || 'EMITIDA'



        );







        // 2. ENCOLAMIENTO PARA SINCRONIZACIÓN VPS (No bloquea a la cajera)



        // Solo descontar en VPS si NO es Nota de Crédito (las NC reintegran stock por su propio flujo)



        if (!v.es_nota_credito) {



            try {



                let parsedDatos = JSON.parse(v.datos_json);



                let productosVenta = parsedDatos.productos || [];



                



                // Payload ultra-ligero: solo IDs y cantidades de productos físicos



                let itemsDescuento = productosVenta



                    .filter(p => {



                        const nombre = String(p.nombre || '').toUpperCase();



                        return !nombre.includes('ABONO') && !nombre.includes('DEUDA') && !nombre.includes('SERVICIO');



                    })



                    .map(p => {
                        const pId = p.id || p.producto_id || p.producto_ID || p.productId;
                        return {
                            id: pId,
                            producto_id: pId,
                            cantidad: parseFloat(p.cantidad || p.quantity || 1)
                        };
                    })
                    .filter(p => Boolean(p.id));







                if (itemsDescuento.length > 0) {



                    const refUnica = String(v.id || v.numero_factura);



                    const yaEnCola = db.prepare(`



                        SELECT id FROM sync_queue 



                        WHERE tabla = 'ventas_descuento_vps' 



                        AND (id_registro = ? OR datos LIKE ? OR datos LIKE ?)



                        LIMIT 1



                    `).get(refUnica, `%"${refUnica}"%`, `%"${v.numero_factura}"%`);







                    if (!yaEnCola) {



                        const payloadDescuento = {



                            company_id: v.company_id || 'DEFAULT',
                            companyId: v.company_id || 'DEFAULT',



                            sucursal_id: v.branch_id || 'principal',
                            branch_id: v.branch_id || 'principal',
                            branchId: v.branch_id || 'principal',



                            items: itemsDescuento,



                            tipo_movimiento: 'VENTA',



                            ventaId: refUnica,



                            factura_ref: refUnica,



                            numero_factura: v.numero_factura



                        };



                        



                        db.prepare('INSERT INTO sync_queue (operacion, tabla, id_registro, datos) VALUES (?, ?, ?, ?)')



                            .run('CREAR', 'ventas_descuento_vps', refUnica, JSON.stringify(payloadDescuento));



                        console.log(`📦 Venta ${v.numero_factura} (${refUnica}) encolada para sync VPS (${itemsDescuento.length} productos).`);



                    } else {



                        console.log(`🛡️ [IDEMPOTENCIA COLA] Venta ${v.numero_factura} ya estaba encolada en sync_queue.`);



                    }



                }



            } catch (eQueue) {



                console.warn(`⚠️ No se pudo encolar venta para VPS:`, eQueue.message);



            }



        }







        // 3. RESPALDO DIRECTO EN SERVIDOR MAESTRO (Si estamos en nodo Servidor)



        let guardadoEnMaestroDirecto = false;



        if (config.isServer && masterDbDirect) {



            try {



                masterDbDirect.prepare(`



                    INSERT OR REPLACE INTO ventas_locales (



                        id, company_id, branch_id, cashier_id, numero_factura, 



                        numero_control, cliente_nombre, cliente_rif, monto_exento, 



                        base_imponible, monto_iva, monto_igtf, monto_total, 



                        tasa_bcv, metodo_pago, datos_json, ganancia_venta, estado_sync, estado_sync_maestro, sync_server, estado_cierre,



                        es_nota_credito, es_nota_debito, factura_afectada, monto_factura_afectada, fecha_factura_afectada, fecha_emision, estado



                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 0, ?, ?, ?, ?, ?, datetime('now', '-4 hours'), ?)



                `).run(



                    v.id, v.company_id, v.branch_id, v.cashier_id, v.numero_factura,



                    v.numero_control, v.cliente_nombre, v.cliente_rif, v.monto_exento,



                    v.base_imponible, v.monto_iva, v.monto_igtf, v.monto_total,



                    v.tasa_bcv, v.metodo_pago, v.datos_json, v.ganancia_venta || 0,



                    v.es_nota_credito || 0, v.es_nota_debito || 0,



                    v.factura_afectada || null, v.monto_factura_afectada || null,



                    v.fecha_factura_afectada || null, v.estado || 'EMITIDA'



                );



                db.prepare("UPDATE ventas_locales SET estado_sync_maestro = 1 WHERE id = ?").run(v.id);



                guardadoEnMaestroDirecto = true;



                console.log(`👑 Venta ${v.numero_factura} guardada directamente en masterDbDirect.`);



            } catch(eMaster) {



                console.warn("⚠️ Fallo escribiendo directamente a masterDbDirect:", eMaster.message);



            }



        }







        // 4. SINCRONIZACIÓN CON EL SERVIDOR MAESTRO (Red Local - Solo si es caja hija o si falló escritura directa)



        if (!guardadoEnMaestroDirecto) {



            try {



                let resSync = null;



                if (config.isServer) {



                    // Modo servidor fallback: indicar origen_maestro para evitar doble encolamiento en sync_queue



                    resSync = await axios.post(`http://127.0.0.1:3000/api/maestro/registrar-venta`, { ...v, origen_maestro: true }, { timeout: 3000 });



                } else {



                    resSync = await llamarMaestro('POST', '/api/maestro/registrar-venta', v, { timeout: 6000, reintentos: 2 });



                }



                if (resSync && (resSync.data?.exito || resSync.status === 200)) {



                    db.prepare("UPDATE ventas_locales SET estado_sync_maestro = 1 WHERE id = ?").run(v.id);



                    console.log(`📡 Venta ${v.numero_factura} sincronizada con Maestro (estado_sync_maestro = 1).`);



                }



            } catch (errSync) {



                console.warn(`⚠️ Maestro no disponible en este momento. Venta ${v.numero_factura} guardada localmente (estado_sync_maestro = 0) para reconciliación en segundo plano.`);



            }



        }







        return resultadoLocal;



    } catch (e) {



        console.error("❌ Error en guardado de venta:", e.message);



        return { error: e.message };



    }



});







// ============================================================================



// 🔄 DAEMON DE RECONCILIACIÓN DE VENTAS PENDIENTES CON EL MAESTRO



// ============================================================================



let isReconciliandoVentas = false;



async function reconciliarVentasPendientesMaestro() {



    if (isReconciliandoVentas) return { exito: true, mensaje: 'Ya en ejecución' };



    isReconciliandoVentas = true;



    try {



        const pendientes = db.prepare(`



            SELECT * FROM ventas_locales 



            WHERE estado_sync_maestro = 0 



            ORDER BY fecha_emision ASC 



            LIMIT 50



        `).all();







        if (!pendientes || pendientes.length === 0) {



            isReconciliandoVentas = false;



            return { exito: true, sincronizadas: 0 };



        }







        console.log(`🔄 [RECONCILIACIÓN MAESTRO] Detectadas ${pendientes.length} ventas pendientes de sincronizar...`);



        let count = 0;







        for (const venta of pendientes) {



            try {



                if (config.isServer && masterDbDirect) {



                    masterDbDirect.prepare(`



                        INSERT OR REPLACE INTO ventas_locales (



                            id, company_id, branch_id, cashier_id, numero_factura, 



                            numero_control, cliente_nombre, cliente_rif, monto_exento, 



                            base_imponible, monto_iva, monto_igtf, monto_total, 



                            tasa_bcv, metodo_pago, datos_json, ganancia_venta, estado_sync, estado_sync_maestro, estado_cierre,



                            es_nota_credito, es_nota_debito, factura_afectada, monto_factura_afectada, fecha_factura_afectada, fecha_emision, estado



                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)



                    `).run(



                        venta.id, venta.company_id, venta.branch_id, venta.cashier_id, venta.numero_factura,



                        venta.numero_control, venta.cliente_nombre, venta.cliente_rif, venta.monto_exento,



                        venta.base_imponible, venta.monto_iva, venta.monto_igtf, venta.monto_total,



                        venta.tasa_bcv, venta.metodo_pago, venta.datos_json,



                        venta.ganancia_venta || 0,



                        venta.estado_cierre || 0,



                        venta.es_nota_credito || 0,



                        venta.es_nota_debito || 0,



                        venta.factura_afectada || null,



                        venta.monto_factura_afectada || null,



                        venta.fecha_factura_afectada || null,



                        venta.fecha_emision,



                        venta.estado || 'EMITIDA'



                    );



                    db.prepare("UPDATE ventas_locales SET estado_sync_maestro = 1 WHERE id = ?").run(venta.id);



                    count++;



                } else {



                    const res = await llamarMaestro('POST', '/api/maestro/registrar-venta', venta, { timeout: 6000, reintentos: 1 });



                    if (res && (res.data?.exito || res.status === 200)) {



                        db.prepare("UPDATE ventas_locales SET estado_sync_maestro = 1 WHERE id = ?").run(venta.id);



                        count++;



                    }



                }



            } catch (errItem) {



                console.warn(`⚠️ Pausa en reconciliación (Maestro no disponible al procesar ${venta.numero_factura}):`, errItem.message);



                break; // Se detiene el lote y se reintenta en el próximo ciclo



            }



        }







        if (count > 0) {



            console.log(`✅ [RECONCILIACIÓN MAESTRO] ${count} ventas sincronizadas exitosamente con el Servidor Maestro.`);



        }



        isReconciliandoVentas = false;



        return { exito: true, sincronizadas: count };



    } catch(e) {



        console.error("❌ Error en reconciliación con Maestro:", e.message);



        isReconciliandoVentas = false;



        return { exito: false, error: e.message };



    }



}















// ============================================================================



// 🔄 DAEMON DE RECONCILIACIÓN DE CIERRES PENDIENTES CON EL MAESTRO



// ============================================================================



let isReconciliandoCierres = false;



async function reconciliarCierresPendientesMaestro() {



    if (isReconciliandoCierres || config.isServer) return;



    isReconciliandoCierres = true;



    try {



        const pendientes = db.prepare('SELECT * FROM cierres_caja_locales WHERE estado_sync = 0 ORDER BY fecha ASC LIMIT 10').all();







        if (!pendientes || pendientes.length === 0) {



            isReconciliandoCierres = false;



            return;



        }







        console.log(`🔄 [RECONCILIACIÓN CIERRES] Detectados ${pendientes.length} cierres pendientes...`);



        let count = 0;







        for (const cierre of pendientes) {



            try {



                const reporte = {



                    id: cierre.id,



                    fecha: cierre.fecha,



                    companyId: cierre.company_id,



                    branchId: cierre.branch_id,



                    cashierId: cierre.cashier_id,



                    totalSalesBs: cierre.total_ventas_bs,



                    totalSalesDollars: cierre.total_ventas_usd,



                    totalExpensesBs: cierre.total_gastos_bs,



                    totalExpensesDollars: cierre.total_gastos_usd,



                    totalIncomes: cierre.total_ingresos_bs,



                    totalDifferenceBs: cierre.total_diferencia_bs,



                    totalDifferenceDollars: cierre.total_diferencia_usd,



                    paymentsConciliation: cierre.detalle_pagos_json



                };



                



                const res = await llamarMaestro('POST', '/api/maestro/registrar-cierre', reporte, { timeout: 6000, reintentos: 1 });



                if (res && (res.data?.exito || res.status === 200)) {



                    db.prepare("UPDATE cierres_caja_locales SET estado_sync = 1 WHERE id = ?").run(cierre.id);



                    count++;



                }



            } catch (errItem) {



                console.warn(`⚠️ Maestro no disponible al procesar cierre ${cierre.id}`);



                break;



            }



        }







        if (count > 0) console.log(`✅ [RECONCILIACIÓN CIERRES] ${count} sincronizados.`);



    } catch(e) { } finally { isReconciliandoCierres = false; }



}







ipcMain.handle('reconciliar-ventas-maestro', async () => {



    return await reconciliarVentasPendientesMaestro();



});







// Daemon recurrente cada 30 segundos



setInterval(() => {



    reconciliarVentasPendientesMaestro().catch(() => {});



    reconciliarCierresPendientesMaestro().catch(() => {});



}, 30000);







// ============================================================================



// ☁️ DAEMON DE SINCRONIZACIÓN DE VENTAS CON EL SERVIDOR NUBE (VPS)



// ============================================================================



let isSincronizandoVentasServidor = false;







function getActiveCompanyId() {



    try {



        if (config && (config.company_id || config.companyId)) {



            return config.company_id || config.companyId;



        }



        const sesion = db.prepare("SELECT valor FROM configuracion WHERE clave = 'sesion_activa'").get();



        if (sesion && sesion.valor) {



            const parsed = JSON.parse(sesion.valor);



            if (parsed.companyId || parsed.company_id) return parsed.companyId || parsed.company_id;



        }



        const user = db.prepare("SELECT companyId FROM usuarios_locales ORDER BY last_login DESC LIMIT 1").get();



        if (user && user.companyId) return user.companyId;



    } catch (e) {}



    return null;



}







function getDbForEntity() {



    return (config && config.isServer && masterDbDirect) ? masterDbDirect : db;



}







function obtenerUrlVps(urlManual = null) {



    if (urlManual && typeof urlManual === 'string' && !urlManual.includes('localhost') && !urlManual.includes('127.0.0.1') && !urlManual.endsWith(':3000')) {



        return urlManual.replace(/\/$/, '');



    }



    const ip = process.env.SERVER_IP || '68.168.218.147';



    const port = process.env.SERVER_PORT || 4010;



    return `http://${ip}:${port}`;



}







async function sincronizarVentasPendientesServidor(limite = 50, serverUrlManual = null) {



    if (isSincronizandoVentasServidor) {



        return { exito: true, mensaje: 'Sincronización ya en curso', enCurso: true };



    }



    isSincronizandoVentasServidor = true;







    try {



        const baseUrl = obtenerUrlVps(serverUrlManual);



        const targetDb = (config.isServer && masterDbDirect) ? masterDbDirect : db;







        // 1. Obtener lote de ventas pendientes



        const pendientes = targetDb.prepare(`



            SELECT * FROM ventas_locales 



            WHERE sync_server = 0 



            ORDER BY fecha_emision ASC 



            LIMIT ?



        `).all(limite);







        if (!pendientes || pendientes.length === 0) {



            isSincronizandoVentasServidor = false;



            return { exito: true, sincronizadas: 0, restantes: 0 };



        }







        console.log(`☁️ [SYNC VPS VENTAS] Enviando lote de ${pendientes.length} ventas pendientes hacia ${baseUrl}...`);







        // 2. Empaquetar y sanitizar anti-Base64



        const ventasParaEnviar = pendientes.map(v => {



            const jsonLimpio = sanitizarDatosJsonVenta(v.datos_json);



            const compSafe = v.company_id || (typeof getActiveCompanyId === 'function' ? getActiveCompanyId() : null) || 'DEFAULT';
            const branchSafe = v.branch_id || 'principal';
            const cashierSafe = v.cashier_id || 'cajera_1';

            let itemsExtraidos = [];
            try {
                if (jsonLimpio) {
                    const parsed = JSON.parse(jsonLimpio);
                    const prods = parsed.productos || parsed.items || [];
                    if (Array.isArray(prods)) {
                        itemsExtraidos = prods.map(p => {
                            const pId = p.id || p.producto_id || p.producto_ID || p.productId;
                            return {
                                id: pId,
                                producto_id: pId,
                                nombre: p.nombre || p.name || '',
                                cantidad: parseFloat(p.cantidad || p.quantity || 1),
                                precio: parseFloat(p.precio || p.price || 0),
                                costo: parseFloat(p.precio_compra || p.costo || 0)
                            };
                        }).filter(p => Boolean(p.id));
                    }
                }
            } catch (_) {}

            return {
                items: itemsExtraidos,
                productos: itemsExtraidos,



                id: v.id,



                company_id: compSafe,
                companyId: compSafe,



                branch_id: branchSafe,
                branchId: branchSafe,
                sucursal_id: branchSafe,
                sucursalId: branchSafe,



                cashier_id: cashierSafe,
                cashierId: cashierSafe,



                numero_factura: v.numero_factura,



                numero_control: v.numero_control,



                cliente_nombre: v.cliente_nombre,



                cliente_rif: v.cliente_rif,



                monto_exento: parseFloat(v.monto_exento) || 0,



                base_imponible: parseFloat(v.base_imponible) || 0,



                monto_iva: parseFloat(v.monto_iva) || 0,



                total_iva: parseFloat(v.total_iva) || 0,



                monto_igtf: parseFloat(v.monto_igtf) || 0,



                monto_total: parseFloat(v.monto_total) || 0,



                tasa_bcv: parseFloat(v.tasa_bcv) || 1,



                metodo_pago: v.metodo_pago,



                datos_json: jsonLimpio,



                ganancia_venta: parseFloat(v.ganancia_venta) || 0,



                estado_sync: 1,



                estado_cierre: v.estado_cierre || 0,



                es_nota_credito: v.es_nota_credito || 0,



                es_nota_debito: v.es_nota_debito || 0,



                factura_afectada: v.factura_afectada || null,



                monto_factura_afectada: v.monto_factura_afectada || null,



                fecha_factura_afectada: v.fecha_factura_afectada || null,



                comprobante_retencion_id: v.comprobante_retencion_id || null,



                fecha_emision: v.fecha_emision,



                estado: v.estado || 'EMITIDA',



                es_anulada: v.es_anulada || 0



            };



        });







        // 3. Enviar petición HTTP POST por lote al VPS



        const endpoint = `${baseUrl}/api/maestro/ventas/sincronizar`;



        const respuesta = await axios.post(endpoint, { ventas: ventasParaEnviar }, { timeout: 15000 });







        if (respuesta.status === 200 || respuesta.status === 201) {



            // Extraer IDs confirmados



            const idsProcesados = (respuesta.data && Array.isArray(respuesta.data.procesados))



                ? respuesta.data.procesados



                : ventasParaEnviar.map(v => v.id);







            if (idsProcesados.length > 0) {



                const placeholders = idsProcesados.map(() => '?').join(',');



                targetDb.prepare(`UPDATE ventas_locales SET sync_server = 1 WHERE id IN (${placeholders})`).run(...idsProcesados);



                



                if (db !== targetDb) {



                    try {



                        db.prepare(`UPDATE ventas_locales SET sync_server = 1 WHERE id IN (${placeholders})`).run(...idsProcesados);



                    } catch (e) {}



                }



            }







            const restantes = targetDb.prepare('SELECT COUNT(*) as total FROM ventas_locales WHERE sync_server = 0').get().total;



            console.log(`✅ [SYNC VPS VENTAS] ${idsProcesados.length} ventas subidas con éxito al VPS. Pendientes: ${restantes}`);







            isSincronizandoVentasServidor = false;



            return { exito: true, sincronizadas: idsProcesados.length, restantes };



        } else {



            throw new Error(`Código inesperado del VPS: ${respuesta.status}`);



        }



    } catch (err) {



        console.warn(`⚠️ [SYNC VPS VENTAS] Enlace con servidor en pausa: ${err.message}`);



        isSincronizandoVentasServidor = false;



        return { exito: false, error: err.message };



    }



}







ipcMain.handle('sincronizar-ventas-servidor', async (event, args = {}) => {



    const { limite = 50, serverUrl = null } = args || {};



    return await sincronizarVentasPendientesServidor(limite, serverUrl);



});







// ============================================================================



// ☁️ DAEMONS DE SINCRONIZACIÓN CON EL SERVIDOR NUBE (VPS): CXC, CXP, EMPLEADOS



// ============================================================================







let isSincronizandoCuentasCobrar = false;



async function sincronizarCuentasCobrarConVps(companyId = null) {



    if (isSincronizandoCuentasCobrar) return { exito: true, enCurso: true };



    isSincronizandoCuentasCobrar = true;







    try {



        const compId = companyId || getActiveCompanyId();



        if (!compId) {



            isSincronizandoCuentasCobrar = false;



            return { exito: false, mensaje: 'Sin companyId activo' };



        }







        const baseUrl = obtenerUrlVps();



        const targetDb = getDbForEntity();



        const tablaClientes = (targetDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clientes_maestro'").get()) ? 'clientes_maestro' : 'clientes_locales';







        // 1. PUSH Clientes pendientes (estado_sync = 0)



        try {



            const clientesPendientes = targetDb.prepare(`SELECT * FROM ${tablaClientes} WHERE (estado_sync = 0 OR estado_sync IS NULL) LIMIT 100`).all();



            if (clientesPendientes && clientesPendientes.length > 0) {



                const items = clientesPendientes.map(c => ({



                    id: `CLI-${c.rif}`,



                    rif: c.rif,



                    company_id: c.company_id || compId,



                    nombre: c.nombre,



                    telefono: c.telefono || '',



                    direccion: c.direccion || '',



                    saldo_deuda: parseFloat(c.saldo_deuda) || 0



                }));



                const resp = await axios.post(`${baseUrl}/api/maestro/cuentas_cobrar/clientes/sincronizar`, { items }, { timeout: 15000 });



                if (resp.status === 200 || resp.status === 201) {



                    const rifs = clientesPendientes.map(c => c.rif);



                    const placeholders = rifs.map(() => '?').join(',');



                    targetDb.prepare(`UPDATE ${tablaClientes} SET estado_sync = 1 WHERE rif IN (${placeholders})`).run(...rifs);



                    if (db !== targetDb) {



                        try {



                            db.prepare(`UPDATE ${tablaClientes} SET estado_sync = 1 WHERE rif IN (${placeholders})`).run(...rifs);



                        } catch (_) {}



                    }



                    console.log(`☁️ [SYNC CXC] ${items.length} clientes subidos al VPS.`);



                }



            }



        } catch (eCliPush) {



            console.warn(`⚠️ [SYNC CXC] Error subiendo clientes al VPS:`, eCliPush.message);



        }







        // 2. PUSH Cuentas por Cobrar pendientes (estado_sync = 0)



        try {



            const deudasPendientes = targetDb.prepare(`



                SELECT * FROM cuentas_por_cobrar 



                WHERE (estado_sync = 0 OR estado_sync IS NULL)



                LIMIT 100



            `).all();



            if (deudasPendientes && deudasPendientes.length > 0) {



                const items = deudasPendientes.map(d => ({



                    id: d.referencia || d.concepto || String(d.id),



                    company_id: d.company_id || compId,



                    branch_id: d.branch_id || 'DEFAULT',



                    cliente_id: d.cliente_id || d.cliente_rif,



                    cliente_nombre: d.cliente_nombre || '',



                    monto_bs: parseFloat(d.monto_bs) || parseFloat(d.monto_deuda) || 0,



                    monto_usd: parseFloat(d.monto_usd) || 0,



                    factura_nro: d.factura_nro || d.numero_factura || d.comprobante || '',



                    monto_pagado: parseFloat(d.monto_pagado) || 0,



                    fecha: d.fecha || d.fecha_emision || '',



                    estado: d.estado || 'PENDIENTE'



                }));



                const resp = await axios.post(`${baseUrl}/api/maestro/cuentas_cobrar/sincronizar`, { items }, { timeout: 15000 });



                if (resp.status === 200 || resp.status === 201) {



                    const ids = deudasPendientes.map(d => d.id);



                    const placeholders = ids.map(() => '?').join(',');



                    targetDb.prepare(`UPDATE cuentas_por_cobrar SET estado_sync = 1 WHERE id IN (${placeholders})`).run(...ids);



                    if (db !== targetDb) {



                        try {



                            db.prepare(`UPDATE cuentas_por_cobrar SET estado_sync = 1 WHERE id IN (${placeholders})`).run(...ids);



                        } catch (_) {}



                    }



                    console.log(`☁️ [SYNC CXC] ${items.length} deudas subidas al VPS.`);



                }



            }



        } catch (eCxcPush) {



            console.warn(`⚠️ [SYNC CXC] Error subiendo cuentas por cobrar al VPS:`, eCxcPush.message);



        }







        // 3. PULL Clientes desde VPS (Delta Sync con Escudo local)



        try {



            const respCli = await axios.get(`${baseUrl}/api/maestro/cuentas_cobrar/clientes/${compId}`, { timeout: 15000 });



            const listaCli = Array.isArray(respCli.data) ? respCli.data : (respCli.data?.items || []);



            if (listaCli && listaCli.length > 0) {



                targetDb.transaction(() => {



                    for (const c of listaCli) {



                        const local = targetDb.prepare(`SELECT estado_sync FROM ${tablaClientes} WHERE rif = ?`).get(c.rif);



                        if (local && local.estado_sync === 0) continue; // ESCUDO







                        targetDb.prepare(`



                            INSERT INTO ${tablaClientes} (rif, company_id, nombre, direccion, telefono, saldo_deuda, estado_sync)



                            VALUES (?, ?, ?, ?, ?, ?, 1)



                            ON CONFLICT(rif) DO UPDATE SET



                                nombre = excluded.nombre,



                                direccion = excluded.direccion,



                                telefono = excluded.telefono,



                                saldo_deuda = excluded.saldo_deuda,



                                company_id = COALESCE(excluded.company_id, ${tablaClientes}.company_id),



                                estado_sync = 1



                            WHERE ${tablaClientes}.estado_sync != 0



                        `).run(c.rif, c.company_id || compId, c.nombre, c.direccion || '', c.telefono || '', parseFloat(c.saldo_deuda) || 0);



                    }



                })();



            }



        } catch (eCliPull) {



            console.warn(`⚠️ [SYNC CXC] Error descargando clientes del VPS:`, eCliPull.message);



        }







        // 4. PULL Cuentas por Cobrar desde VPS (Delta Sync con Escudo local y soporte de IDs alfanuméricos)



        try {



            const respCxc = await axios.get(`${baseUrl}/api/maestro/cuentas_cobrar/${compId}?limit=100`, { timeout: 15000 });



            const listaCxc = Array.isArray(respCxc.data) ? respCxc.data : (respCxc.data?.items || []);



            if (listaCxc && listaCxc.length > 0) {



                targetDb.transaction(() => {



                    for (const d of listaCxc) {



                        const isNumeric = /^\d+$/.test(String(d.id || '').trim());



                        const numericId = isNumeric ? parseInt(d.id, 10) : null;







                        // Buscar registro local coincidente



                        let local = null;



                        if (numericId !== null) {



                            local = targetDb.prepare(`SELECT id, estado_sync FROM cuentas_por_cobrar WHERE id = ?`).get(numericId);



                        }



                        if (!local && d.factura_nro) {



                            local = targetDb.prepare(`SELECT id, estado_sync FROM cuentas_por_cobrar WHERE factura_nro = ?`).get(d.factura_nro);



                        }



                        if (!local && d.id) {



                            local = targetDb.prepare(`SELECT id, estado_sync FROM cuentas_por_cobrar WHERE referencia = ? OR concepto = ?`).get(String(d.id), String(d.id));



                        }







                        // ESCUDO: Si el registro local tiene cambios pendientes de subir, no sobrescribir



                        if (local && local.estado_sync === 0) continue;







                        if (local) {



                            targetDb.prepare(`



                                UPDATE cuentas_por_cobrar SET



                                    cliente_id = ?,



                                    cliente_nombre = ?,



                                    rif_cliente = ?,



                                    monto_bs = ?,



                                    monto_usd = ?,



                                    monto = ?,



                                    factura_nro = ?,



                                    monto_pagado = ?,



                                    fecha = ?,



                                    estado = ?,



                                    branch_id = ?,



                                    company_id = ?,



                                    estado_sync = 1



                                WHERE id = ?



                            `).run(



                                d.cliente_id || '', d.cliente_nombre || '', d.cliente_id || '',



                                parseFloat(d.monto_bs) || 0, parseFloat(d.monto_usd) || 0, parseFloat(d.monto_bs) || 0,



                                d.factura_nro || '', parseFloat(d.monto_pagado) || 0,



                                d.fecha || '', d.estado || 'PENDIENTE',



                                d.branch_id || 'DEFAULT', d.company_id || compId,



                                local.id



                            );



                        } else {



                            if (numericId !== null) {



                                targetDb.prepare(`



                                    INSERT INTO cuentas_por_cobrar (



                                        id, company_id, branch_id, cliente_id, cliente_nombre, rif_cliente,



                                        monto_bs, monto_usd, monto, factura_nro, monto_pagado, fecha,



                                        estado, estado_sync, referencia



                                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)



                                `).run(



                                    numericId, d.company_id || compId, d.branch_id || 'DEFAULT',



                                    d.cliente_id || '', d.cliente_nombre || '', d.cliente_id || '',



                                    parseFloat(d.monto_bs) || 0, parseFloat(d.monto_usd) || 0, parseFloat(d.monto_bs) || 0,



                                    d.factura_nro || '', parseFloat(d.monto_pagado) || 0,



                                    d.fecha || '', d.estado || 'PENDIENTE',



                                    String(d.id)



                                );



                            } else {



                                targetDb.prepare(`



                                    INSERT INTO cuentas_por_cobrar (



                                        company_id, branch_id, cliente_id, cliente_nombre, rif_cliente,



                                        monto_bs, monto_usd, monto, factura_nro, monto_pagado, fecha,



                                        estado, estado_sync, referencia, concepto



                                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)



                                `).run(



                                    d.company_id || compId, d.branch_id || 'DEFAULT',



                                    d.cliente_id || '', d.cliente_nombre || '', d.cliente_id || '',



                                    parseFloat(d.monto_bs) || 0, parseFloat(d.monto_usd) || 0, parseFloat(d.monto_bs) || 0,



                                    d.factura_nro || '', parseFloat(d.monto_pagado) || 0,



                                    d.fecha || '', d.estado || 'PENDIENTE',



                                    String(d.id), String(d.id)



                                );



                            }



                        }



                    }



                })();



            }



        } catch (eCxcPull) {



            console.warn(`⚠️ [SYNC CXC] Error descargando cuentas por cobrar del VPS:`, eCxcPull.message);



        }







        return { exito: true };



    } catch (err) {



        console.error("❌ Error en sincronizarCuentasCobrarConVps:", err.message);



        return { exito: false, error: err.message };



    } finally {



        isSincronizandoCuentasCobrar = false;



    }



}







let isSincronizandoCuentasPagar = false;



async function sincronizarCuentasPagarConVps(companyId = null) {



    if (isSincronizandoCuentasPagar) return { exito: true, enCurso: true };



    isSincronizandoCuentasPagar = true;







    try {



        const compId = companyId || getActiveCompanyId();



        if (!compId) {



            isSincronizandoCuentasPagar = false;



            return { exito: false, mensaje: 'Sin companyId activo' };



        }







        const baseUrl = obtenerUrlVps();



        const targetDb = getDbForEntity();







        // 1. PUSH Proveedores pendientes (estado_sync = 0)



        try {



            const provPendientes = targetDb.prepare(`SELECT * FROM proveedores WHERE (estado_sync = 0 OR estado_sync IS NULL) LIMIT 100`).all();



            if (provPendientes && provPendientes.length > 0) {



                const items = provPendientes.map(p => ({



                    rif: p.rif,



                    company_id: p.company_id || compId,



                    nombre: p.nombre,



                    telefono: p.telefono || '',



                    contacto: p.contacto || '',



                    direccion: p.direccion || '',



                    saldo_deuda: parseFloat(p.saldo_deuda) || 0,



                    status: p.status !== undefined ? p.status : 1



                }));



                const resp = await axios.post(`${baseUrl}/api/maestro/cuentas_pagar/proveedores/sincronizar`, { items }, { timeout: 15000 });



                if (resp.status === 200 || resp.status === 201) {



                    const rifs = provPendientes.map(p => p.rif);



                    const placeholders = rifs.map(() => '?').join(',');



                    targetDb.prepare(`UPDATE proveedores SET estado_sync = 1 WHERE rif IN (${placeholders})`).run(...rifs);



                    console.log(`☁️ [SYNC CXP] ${items.length} proveedores subidos al VPS.`);



                }



            }



        } catch (eProvPush) {



            console.warn(`⚠️ [SYNC CXP] Error subiendo proveedores al VPS:`, eProvPush.message);



        }







        // 2. PUSH Movimientos Cuentas por Pagar pendientes (estado_sync = 0)



        try {



            const movsPendientes = targetDb.prepare(`SELECT * FROM movimientos_cuentas_pagar WHERE (estado_sync = 0 OR estado_sync IS NULL) LIMIT 100`).all();



            if (movsPendientes && movsPendientes.length > 0) {



                const items = movsPendientes.map(m => ({



                    id: m.id,



                    company_id: m.company_id || compId,



                    proveedor_rif: m.proveedor_rif,



                    motivo: m.motivo,



                    nota: m.nota || '',



                    monto: parseFloat(m.monto) || 0,



                    comprobante: m.comprobante || m.id,



                    estado: m.estado || 'PENDIENTE',



                    monto_abonado: parseFloat(m.monto_abonado) || 0,



                    metodo_pago: m.metodo_pago || '',



                    referencia: m.referencia || '',



                    fecha: m.fecha,



                    contenido_fac: m.contenido_fac || null



                }));



                const resp = await axios.post(`${baseUrl}/api/maestro/cuentas_pagar/movimientos/sincronizar`, { items }, { timeout: 15000 });



                if (resp.status === 200 || resp.status === 201) {



                    const ids = movsPendientes.map(m => m.id);



                    const placeholders = ids.map(() => '?').join(',');



                    targetDb.prepare(`UPDATE movimientos_cuentas_pagar SET estado_sync = 1 WHERE id IN (${placeholders})`).run(...ids);



                    console.log(`☁️ [SYNC CXP] ${items.length} movimientos CXP subidos al VPS.`);



                }



            }



        } catch (eMovPush) {



            console.warn(`⚠️ [SYNC CXP] Error subiendo movimientos CXP al VPS:`, eMovPush.message);



        }







        // 3. PULL Proveedores desde VPS (Delta Sync con Escudo local)



        try {



            const respProv = await axios.get(`${baseUrl}/api/maestro/cuentas_pagar/proveedores/${compId}`, { timeout: 15000 });



            const listaProv = Array.isArray(respProv.data) ? respProv.data : (respProv.data?.items || []);



            if (listaProv && listaProv.length > 0) {



                targetDb.transaction(() => {



                    for (const p of listaProv) {



                        const local = targetDb.prepare(`SELECT estado_sync FROM proveedores WHERE rif = ?`).get(p.rif);



                        if (local && local.estado_sync === 0) continue; // ESCUDO







                        targetDb.prepare(`



                            INSERT INTO proveedores (rif, company_id, nombre, telefono, contacto, direccion, saldo_deuda, status, estado_sync)



                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)



                            ON CONFLICT(rif) DO UPDATE SET



                                nombre = excluded.nombre,



                                telefono = excluded.telefono,



                                contacto = excluded.contacto,



                                direccion = excluded.direccion,



                                saldo_deuda = excluded.saldo_deuda,



                                status = excluded.status,



                                company_id = COALESCE(excluded.company_id, proveedores.company_id),



                                estado_sync = 1



                            WHERE proveedores.estado_sync != 0



                        `).run(



                            p.rif, p.company_id || compId, p.nombre, p.telefono || '',



                            p.contacto || '', p.direccion || '', parseFloat(p.saldo_deuda) || 0,



                            p.status !== undefined ? p.status : 1



                        );



                    }



                })();



            }



        } catch (eProvPull) {



            console.warn(`⚠️ [SYNC CXP] Error descargando proveedores del VPS:`, eProvPull.message);



        }







        // 4. PULL Movimientos CXP desde VPS (Delta Sync con Escudo local)



        try {



            const respMov = await axios.get(`${baseUrl}/api/maestro/cuentas_pagar/movimientos/${compId}?limit=100`, { timeout: 15000 });



            const listaMov = Array.isArray(respMov.data) ? respMov.data : (respMov.data?.items || []);



            if (listaMov && listaMov.length > 0) {



                targetDb.transaction(() => {



                    for (const m of listaMov) {



                        const local = targetDb.prepare(`SELECT estado_sync FROM movimientos_cuentas_pagar WHERE id = ?`).get(m.id);



                        if (local && local.estado_sync === 0) continue; // ESCUDO







                        const cFacStr = m.contenido_fac ? (typeof m.contenido_fac === 'object' ? JSON.stringify(m.contenido_fac) : String(m.contenido_fac)) : null;



                        targetDb.prepare(`



                            INSERT INTO movimientos_cuentas_pagar (id, company_id, proveedor_rif, motivo, nota, monto, comprobante, estado, monto_abonado, metodo_pago, referencia, fecha, contenido_fac, estado_sync)



                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)



                            ON CONFLICT(id) DO UPDATE SET



                                proveedor_rif = excluded.proveedor_rif,



                                motivo = excluded.motivo,



                                nota = excluded.nota,



                                monto = excluded.monto,



                                comprobante = excluded.comprobante,



                                estado = excluded.estado,



                                monto_abonado = excluded.monto_abonado,



                                metodo_pago = excluded.metodo_pago,



                                referencia = excluded.referencia,



                                fecha = excluded.fecha,



                                company_id = excluded.company_id,



                                contenido_fac = COALESCE(excluded.contenido_fac, movimientos_cuentas_pagar.contenido_fac),



                                estado_sync = 1



                            WHERE movimientos_cuentas_pagar.estado_sync != 0



                        `).run(



                            m.id, m.company_id || compId, m.proveedor_rif, m.motivo,



                            m.nota || '', parseFloat(m.monto) || 0, m.comprobante || m.id,



                            m.estado || 'PENDIENTE', parseFloat(m.monto_abonado) || 0,



                            m.metodo_pago || '', m.referencia || '', m.fecha, cFacStr



                        );



                    }



                })();



            }



        } catch (eMovPull) {



            console.warn(`⚠️ [SYNC CXP] Error descargando movimientos CXP del VPS:`, eMovPull.message);



        }







        return { exito: true };



    } catch (err) {



        console.error("❌ Error en sincronizarCuentasPagarConVps:", err.message);



        return { exito: false, error: err.message };



    } finally {



        isSincronizandoCuentasPagar = false;



    }



}







let isSincronizandoEmpleados = false;



async function sincronizarEmpleadosConVps(companyId = null) {



    if (isSincronizandoEmpleados) return { exito: true, enCurso: true };



    isSincronizandoEmpleados = true;







    try {



        const compId = companyId || getActiveCompanyId();



        if (!compId) {



            isSincronizandoEmpleados = false;



            return { exito: false, mensaje: 'Sin companyId activo' };



        }







        const baseUrl = obtenerUrlVps();



        const targetDb = getDbForEntity();







        // 1. PUSH Empleados pendientes (estado_sync = 0)



        try {



            const empPendientes = targetDb.prepare(`SELECT * FROM empleados WHERE (estado_sync = 0 OR estado_sync IS NULL) LIMIT 100`).all();



            if (empPendientes && empPendientes.length > 0) {



                const items = empPendientes.map(e => ({



                    id: e.ID_empleado,



                    ID_empleado: e.ID_empleado,



                    company_id: e.company_id || compId,



                    nombre: e.nombre,



                    cedula: e.cedula || '',



                    cargo: e.cargo || '',



                    sueldo_base: parseFloat(e.sueldo_base) || 0,



                    telefono: e.telefono || '',



                    sucursal: e.sucursal || '',



                    saldo_pendiente: parseFloat(e.saldo_pendiente) || 0,



                    status: e.status !== undefined ? e.status : 1,



                    fecha_creacion: e.fecha_creacion



                }));



                const resp = await axios.post(`${baseUrl}/api/maestro/empleados/sincronizar`, { items }, { timeout: 15000 });



                if (resp.status === 200 || resp.status === 201) {



                    const ids = empPendientes.map(e => e.ID_empleado);



                    const placeholders = ids.map(() => '?').join(',');



                    targetDb.prepare(`UPDATE empleados SET estado_sync = 1 WHERE ID_empleado IN (${placeholders})`).run(...ids);



                    console.log(`☁️ [SYNC EMPLEADOS] ${items.length} empleados subidos al VPS.`);



                }



            }



        } catch (eEmpPush) {



            console.warn(`⚠️ [SYNC EMPLEADOS] Error subiendo empleados al VPS:`, eEmpPush.message);



        }







        // 2. PUSH Movimientos de Empleados pendientes (estado_sync = 0)



        try {



            const movsPendientes = targetDb.prepare(`SELECT * FROM empleados_movimientos WHERE (estado_sync = 0 OR estado_sync IS NULL) LIMIT 100`).all();



            if (movsPendientes && movsPendientes.length > 0) {



                const items = movsPendientes.map(m => ({



                    id: m.id,



                    company_id: m.company_id || compId,



                    empleado_id: m.empleado_id,



                    motivo: m.motivo,



                    razon: m.razon || '',



                    monto: parseFloat(m.monto) || 0,



                    fecha: m.fecha



                }));



                const resp = await axios.post(`${baseUrl}/api/maestro/empleados/movimientos/sincronizar`, { items }, { timeout: 15000 });



                if (resp.status === 200 || resp.status === 201) {



                    const ids = movsPendientes.map(m => m.id);



                    const placeholders = ids.map(() => '?').join(',');



                    targetDb.prepare(`UPDATE empleados_movimientos SET estado_sync = 1 WHERE id IN (${placeholders})`).run(...ids);



                    console.log(`☁️ [SYNC EMPLEADOS] ${items.length} movimientos de empleados subidos al VPS.`);



                }



            }



        } catch (eMovPush) {



            console.warn(`⚠️ [SYNC EMPLEADOS] Error subiendo movimientos de empleados al VPS:`, eMovPush.message);



        }







        // 3. PULL Empleados desde VPS (Delta Sync con Escudo local)



        try {



            const respEmp = await axios.get(`${baseUrl}/api/maestro/empleados/${compId}`, { timeout: 15000 });



            const listaEmp = Array.isArray(respEmp.data) ? respEmp.data : (respEmp.data?.items || []);



            if (listaEmp && listaEmp.length > 0) {



                targetDb.transaction(() => {



                    for (const e of listaEmp) {



                        const idEmp = e.id || e.ID_empleado;



                        const local = targetDb.prepare(`SELECT estado_sync FROM empleados WHERE ID_empleado = ?`).get(idEmp);



                        if (local && local.estado_sync === 0) continue; // ESCUDO







                        targetDb.prepare(`



                            INSERT INTO empleados (ID_empleado, company_id, nombre, cedula, cargo, sueldo_base, telefono, sucursal, saldo_pendiente, status, estado_sync, fecha_creacion)



                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)



                            ON CONFLICT(ID_empleado) DO UPDATE SET



                                nombre = excluded.nombre,



                                cedula = excluded.cedula,



                                cargo = excluded.cargo,



                                sueldo_base = excluded.sueldo_base,



                                telefono = excluded.telefono,



                                sucursal = excluded.sucursal,



                                saldo_pendiente = excluded.saldo_pendiente,



                                status = excluded.status,



                                company_id = COALESCE(excluded.company_id, empleados.company_id),



                                estado_sync = 1



                            WHERE empleados.estado_sync != 0



                        `).run(



                            idEmp, e.company_id || compId, e.nombre, e.cedula || '',



                            e.cargo || '', parseFloat(e.sueldo_base) || 0, e.telefono || '',



                            e.sucursal || '', parseFloat(e.saldo_pendiente) || 0,



                            e.status !== undefined ? e.status : 1,



                            e.fecha_creacion || getCaracasTime()



                        );



                    }



                })();



            }



        } catch (eEmpPull) {



            console.warn(`⚠️ [SYNC EMPLEADOS] Error descargando empleados del VPS:`, eEmpPull.message);



        }







        // 4. PULL Movimientos de Empleados desde VPS (Delta Sync con Escudo local)



        try {



            const respMov = await axios.get(`${baseUrl}/api/maestro/empleados/movimientos/${compId}?limit=100`, { timeout: 15000 });



            const listaMov = Array.isArray(respMov.data) ? respMov.data : (respMov.data?.items || []);



            if (listaMov && listaMov.length > 0) {



                targetDb.transaction(() => {



                    for (const m of listaMov) {



                        const local = targetDb.prepare(`SELECT estado_sync FROM empleados_movimientos WHERE id = ?`).get(m.id);



                        if (local && local.estado_sync === 0) continue; // ESCUDO







                        targetDb.prepare(`



                            INSERT INTO empleados_movimientos (id, company_id, empleado_id, motivo, razon, monto, fecha, estado_sync)



                            VALUES (?, ?, ?, ?, ?, ?, ?, 1)



                            ON CONFLICT(id) DO UPDATE SET



                                empleado_id = excluded.empleado_id,



                                motivo = excluded.motivo,



                                razon = excluded.razon,



                                monto = excluded.monto,



                                fecha = excluded.fecha,



                                company_id = excluded.company_id,



                                estado_sync = 1



                            WHERE empleados_movimientos.estado_sync != 0



                        `).run(



                            m.id, m.company_id || compId, m.empleado_id, m.motivo,



                            m.razon || '', parseFloat(m.monto) || 0, m.fecha



                        );



                    }



                })();



            }



        } catch (eMovPull) {



            console.warn(`⚠️ [SYNC EMPLEADOS] Error descargando movimientos de empleados del VPS:`, eMovPull.message);



        }







        return { exito: true };



    } catch (err) {



        console.error("❌ Error en sincronizarEmpleadosConVps:", err.message);



        return { exito: false, error: err.message };



    } finally {



        isSincronizandoEmpleados = false;



    }



}







let isSincronizandoCierres = false;



async function sincronizarCierresConVps(companyId = null) {



    if (isSincronizandoCierres) return { exito: true, enCurso: true };



    isSincronizandoCierres = true;







    try {



        const compId = companyId || getActiveCompanyId();



        const baseUrl = obtenerUrlVps();







        // 1. Obtener cierres pendientes (estado_sync = 0 o NULL) tanto de locales como de maestros



        const mapPendientes = new Map();



        try {



            const locs = db.prepare(`SELECT * FROM cierres_caja_locales WHERE (estado_sync = 0 OR estado_sync IS NULL) ORDER BY fecha ASC LIMIT 20`).all();



            for (const item of locs) mapPendientes.set(item.id, item);



        } catch (_) {}







        if (masterDbDirect) {



            try {



                const maes = masterDbDirect.prepare(`SELECT * FROM cierres_caja_maestros WHERE (estado_sync = 0 OR estado_sync IS NULL) ORDER BY fecha ASC LIMIT 20`).all();



                for (const item of maes) {



                    if (!mapPendientes.has(item.id)) {



                        mapPendientes.set(item.id, item);



                    }



                }



            } catch (_) {}



        }







        const pendientes = Array.from(mapPendientes.values());







        if (!pendientes || pendientes.length === 0) {



            isSincronizandoCierres = false;



            return { exito: true, count: 0 };



        }







        console.log(`☁️ [SYNC CIERRES VPS] Procesando ${pendientes.length} cierres pendientes en cola hacia ${baseUrl}...`);



        let sincronizados = 0;







        for (const c of pendientes) {



            const pagosJson = typeof c.paymentsConciliation === 'string'



                ? c.paymentsConciliation



                : typeof c.detalle_pagos_json === 'string'



                    ? c.detalle_pagos_json



                    : JSON.stringify(c.paymentsConciliation || c.detalle_pagos_json || {});







            const reporte = {



                id: c.id,



                fecha: c.fecha,



                company_id: c.company_id || compId,



                companyId: c.company_id || compId,



                branch_id: c.branch_id || 'DEFAULT',



                branchId: c.branch_id || 'DEFAULT',



                cashier_id: c.cashier_id || 'CAJERO',



                cashierId: c.cashier_id || 'CAJERO',



                role: 'cajera',



                total_ventas_bs: parseFloat(c.total_ventas_bs || c.totalSalesBs) || 0,



                totalSalesBs: parseFloat(c.total_ventas_bs || c.totalSalesBs) || 0,



                total_ventas_usd: parseFloat(c.total_ventas_usd || c.totalSalesDollars) || 0,



                totalSalesDollars: parseFloat(c.total_ventas_usd || c.totalSalesDollars) || 0,



                total_gastos_bs: parseFloat(c.total_gastos_bs || c.totalExpensesBs) || 0,



                totalExpensesBs: parseFloat(c.total_gastos_bs || c.totalExpensesBs) || 0,



                total_gastos_usd: parseFloat(c.total_gastos_usd || c.totalExpensesDollars) || 0,



                totalExpensesDollars: parseFloat(c.total_gastos_usd || c.totalExpensesDollars) || 0,



                total_ingresos_bs: parseFloat(c.total_ingresos_bs || c.totalIncomes) || 0,



                totalIncomes: parseFloat(c.total_ingresos_bs || c.totalIncomes) || 0,



                total_diferencia_bs: parseFloat(c.total_diferencia_bs || c.totalDifferenceBs) || 0,



                totalDifferenceBs: parseFloat(c.total_diferencia_bs || c.totalDifferenceBs) || 0,



                total_diferencia_usd: parseFloat(c.total_diferencia_usd || c.totalDifferenceDollars) || 0,



                totalDifferenceDollars: parseFloat(c.total_diferencia_usd || c.totalDifferenceDollars) || 0,



                detalle_pagos_json: pagosJson,



                paymentsConciliation: pagosJson



            };







            let okVps = false;







            // 1. Enviar petición al endpoint estándar de Nexus POS Global en el VPS



            try {



                const resVps = await axios.post(`${baseUrl}/api/maestro/cierres/sincronizar`, { cierres: [reporte] }, { timeout: 10000 });



                if (resVps.status === 200 || resVps.status === 201) okVps = true;



            } catch (eVps) {



                try {



                    const resVps2 = await axios.post(`${baseUrl}/api/maestro/cierres/sincronizar`, { items: [reporte] }, { timeout: 10000 });



                    if (resVps2.status === 200 || resVps2.status === 201) okVps = true;



                } catch (eVps2) {



                    try {



                        const resVps3 = await axios.post(`${baseUrl}/api/maestro/cierres/sincronizar`, reporte, { timeout: 10000 });



                        if (resVps3.status === 200 || resVps3.status === 201) okVps = true;



                    } catch (_) {}



                }



            }







            // 2. Si somos nodo cliente LAN, enviar también al Maestro local si no se había hecho



            if (!config.isServer) {



                try {



                    await llamarMaestro('POST', '/api/maestro/registrar-cierre', reporte, { timeout: 6000, reintentos: 1 });



                } catch (_) {}



            }







            // 3. Confirmación estricta: sólo marcamos como sincronizado (1) si el VPS confirmó con éxito



            if (okVps) {



                try { db.prepare(`UPDATE cierres_caja_locales SET estado_sync = 1 WHERE id = ?`).run(c.id); } catch (_) {}



                if (masterDbDirect) {



                    try { masterDbDirect.prepare(`UPDATE cierres_caja_locales SET estado_sync = 1 WHERE id = ?`).run(c.id); } catch (_) {}



                    try { masterDbDirect.prepare(`UPDATE cierres_caja_maestros SET estado_sync = 1 WHERE id = ?`).run(c.id); } catch (_) {}



                }



                sincronizados++;



            }



        }







        if (sincronizados > 0) {



            console.log(`✅ [SYNC CIERRES VPS] ${sincronizados} cierres subidos y confirmados por el servidor.`);



        }



        return { exito: true, count: sincronizados };



    } catch (err) {



        console.warn(`⚠️ [SYNC CIERRES VPS] Enlace con servidor en pausa:`, err.message);



        return { exito: false, error: err.message };



    } finally {



        isSincronizandoCierres = false;



    }



}







// Sincronización periódica automática en segundo plano (cada 45 segundos)



setInterval(() => {



    sincronizarVentasPendientesServidor(50).catch(() => {});



    sincronizarCuentasCobrarConVps().catch(() => {});



    sincronizarCuentasPagarConVps().catch(() => {});



    sincronizarEmpleadosConVps().catch(() => {});



    sincronizarCierresConVps().catch(() => {});



}, 45000);







ipcMain.handle('sincronizar-cuentas-cobrar', async (event, companyId) => {



    return await sincronizarCuentasCobrarConVps(companyId);



});







ipcMain.handle('sincronizar-cuentas-pagar', async (event, companyId) => {



    return await sincronizarCuentasPagarConVps(companyId);



});







ipcMain.handle('sincronizar-empleados', async (event, companyId) => {



    return await sincronizarEmpleadosConVps(companyId);



});







ipcMain.handle('sincronizar-cierres-vps', async (event, companyId) => {



    return await sincronizarCierresConVps(companyId);



});







ipcMain.handle('obtener-cuentas-cobrar-local', async () => {



    try {



        const targetDb = getDbForEntity();



        return targetDb.prepare('SELECT * FROM cuentas_por_cobrar ORDER BY fecha DESC').all();



    } catch (e) {



        console.error("Error obteniendo cuentas_por_cobrar local:", e.message);



        return [];



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



                    console.log(`⚠️ Correlativo [${tipo}] no encontrado. Creándolo automáticamente...`);



                    let prefijo = 'DOC-';



                    if (tipo === 'NOTA_CREDITO') prefijo = 'NC-';



                    else if (tipo === 'NOTA_DEBITO') prefijo = 'ND-';



                    else if (tipo === 'PRESUPUESTO' || tipo === 'COTIZACION') prefijo = 'PRE-';



                    else if (tipo === 'RETENCION_IVA') prefijo = 'RET-';



                    else if (tipo === 'RETENCION_ISLR') prefijo = 'ISLR-';



                    else if (tipo === 'COMPROBANTE_ARCV') prefijo = 'ARCV-';



                    else if (tipo === 'GUIA_DESPACHO') prefijo = 'GD-';



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



        if (ip) {



            try {



                const response = await llamarMaestro('GET', `/api/maestro/buscar-factura/${numFactura}`, null, { timeout: 5000 });



                if (response && response.data && response.data.total > 0) return response.data;



            } catch(eMaestro) {}



        }







        // Búsqueda local de respaldo en SQLite



        const criterio = String(numFactura || '').trim();



        const soloNumeros = criterio.replace(/[^0-9]/g, '');



        const busquedaLike = soloNumeros ? `%-${soloNumeros.padStart(8, '0')}` : criterio;



        const targetDb = masterDbDirect || db;



        const stmt = targetDb.prepare(`



            SELECT * FROM ventas_locales 



            WHERE id = ? OR numero_factura = ? OR numero_factura LIKE ?



            ORDER BY fecha_emision DESC



        `);



        const resultados = stmt.all(criterio, criterio, busquedaLike);



        return { total: resultados.length, data: resultados };







    } catch (error) {



        console.error("❌ Error buscando factura:", error.message);



        return { 



            error: true, 



            mensaje: "No se pudo encontrar la factura en la base de datos." 



        };



    }



});







ipcMain.handle('anular-venta-no-fiscal-local', async (event, datos) => {



    try {



        const { facturaId, numeroFactura, companyId, branchId, cashierId, productos, metodosReintegro, motivo, clienteNombre } = datos;



        console.log(`🚫 [ANULACIÓN LOCAL] Procesando anulación para ${numeroFactura || facturaId}`);







        // 1. Transacción local en SQLite



        const transaccion = db.transaction(() => {



            // A. Marcar venta local como ANULADA y poner ganancia_venta = 0



            db.prepare(`



                UPDATE ventas_locales 



                SET estado = 'ANULADA', es_anulada = 1, ganancia_venta = 0, estado_sync = 0, sync_server = 0



                WHERE id = ? OR numero_factura = ?



            `).run(facturaId || '', numeroFactura || '');







            if (config.isServer && masterDbDirect) {



                try {



                    masterDbDirect.prepare(`



                        UPDATE ventas_locales 



                        SET estado = 'ANULADA', es_anulada = 1, ganancia_venta = 0, estado_sync = 0, sync_server = 0



                        WHERE id = ? OR numero_factura = ?



                    `).run(facturaId || '', numeroFactura || '');



                } catch (eM) {}



            }







            // B. Reintegrar stock en stock_maestro, inventario_sucursales y kardex (con idempotencia)



            if (Array.isArray(productos) && productos.length > 0) {



                const targetDb = (config.isServer && masterDbDirect) ? masterDbDirect : db;



                const horaCaracas = getCaracasTime();



                const refAnulacion = String(facturaId || numeroFactura || '');



                let yaReintegradoLocal = false;







                if (refAnulacion) {



                    try {



                        const existeKardex = targetDb.prepare(`



                            SELECT id FROM movimientos_stock_maestro 



                            WHERE (referencia_id = ? OR referencia_id = ?) AND tipo_movimiento = 'ANULACION_VENTA' LIMIT 1



                        `).get(String(facturaId || ''), String(numeroFactura || ''));



                        if (existeKardex) {



                            yaReintegradoLocal = true;



                            console.log(`🛡️ [IDEMPOTENCIA ANULACIÓN] El ticket ${refAnulacion} ya había reintegrado stock previamente.`);



                        }



                    } catch (eCheckAnul) {}



                }







                if (!yaReintegradoLocal) {



                    try {



                        const stmtStockSuc = targetDb.prepare("UPDATE stock_maestro SET cantidad_real = cantidad_real + ?, ultima_sincronizacion = datetime('now', '-4 hours') WHERE producto_id = ? AND sucursal_id = ?");



                        const stmtStockGlobal = targetDb.prepare("UPDATE stock_maestro SET cantidad_real = cantidad_real + ?, ultima_sincronizacion = datetime('now', '-4 hours') WHERE producto_id = ?");



                        const stmtKardex = targetDb.prepare("INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento, fecha_movimiento, referencia_id, estado_sync) VALUES (?, ?, ?, ?, ?, ?, ?, 0)");



                        const stmtInvLocal = db.prepare("UPDATE inventario_sucursales SET stock = stock + ?, fecha_modificacion = datetime('now', '-4 hours') WHERE producto_id = ? AND sucursal_id = ?");







                        productos.forEach(item => {



                            const cant = parseFloat(item.cantidad || item.qty || 1);



                            const prodId = item.id || item.producto_id || item.producto_ID;



                            const nombre = String(item.nombre || item.name || '').toUpperCase();



                            



                            if (prodId && cant > 0 && !nombre.includes('ABONO') && !nombre.includes('DEUDA') && !nombre.includes('SERVICIO')) {



                                if (branchId) {



                                    const resSuc = stmtStockSuc.run(cant, prodId, branchId);



                                    if (resSuc.changes === 0) stmtStockGlobal.run(cant, prodId);



                                    try { stmtInvLocal.run(cant, prodId, branchId); } catch(eInv) {}



                                } else {



                                    stmtStockGlobal.run(cant, prodId);



                                }



                                try {



                                    stmtKardex.run(companyId || 'DEFAULT', branchId || 'GLOBAL', prodId, cant, 'ANULACION_VENTA', horaCaracas, refAnulacion);



                                } catch(eK) {}



                            }



                        });



                    } catch(eStock) {



                        console.warn("⚠️ Advertencia al actualizar stock local en anulación:", eStock.message);



                    }



                }







                // ☁️ Encolar reintegro de stock para el VPS (tabla 'movimientos_stock' -> /api/maestro/inventario/registrar-entrada con SUMAR)



                try {



                    const itemsReintegro = productos



                        .filter(p => {



                            const n = String(p.nombre || p.name || '').toUpperCase();



                            return !n.includes('ABONO') && !n.includes('DEUDA') && !n.includes('SERVICIO');



                        })



                        .map(p => ({



                            id: p.id || p.producto_id || p.producto_ID,



                            cantidad: parseFloat(p.cantidad || p.qty || 1),



                            operacion: 'SUMAR'



                        }));



                    if (itemsReintegro.length > 0) {



                        db.prepare(`CREATE TABLE IF NOT EXISTS sync_queue (



                            id INTEGER PRIMARY KEY AUTOINCREMENT,



                            operacion TEXT,



                            tabla TEXT,



                            id_registro TEXT,



                            datos TEXT,



                            fecha_creacion DATETIME DEFAULT (datetime('now', '-4 hours'))



                        )`).run();







                        const idRegAnul = `ANUL-${refAnulacion}`;



                        const yaEnColaAnul = db.prepare("SELECT id FROM sync_queue WHERE tabla = 'movimientos_stock' AND id_registro = ? LIMIT 1").get(idRegAnul);



                        if (!yaEnColaAnul) {



                            const payloadReintegro = {



                                companyId: companyId || getActiveCompanyId(),



                                company_id: companyId || getActiveCompanyId(),



                                sucursalId: branchId || 'principal',



                                sucursal_id: branchId || 'principal',



                                items: itemsReintegro,



                                tipo_movimiento: 'ANULACION_VENTA',



                                operacion: 'SUMAR',



                                factura_ref: refAnulacion



                            };



                            db.prepare('INSERT INTO sync_queue (operacion, tabla, id_registro, datos) VALUES (?, ?, ?, ?)')



                                .run('UPSERT', 'movimientos_stock', idRegAnul, JSON.stringify(payloadReintegro));



                        }



                    }



                } catch(eQueue) {



                    console.warn("⚠️ No se pudo encolar reintegro de stock en sync_queue:", eQueue.message);



                }



            }







            // C. Registrar salidas de dinero (GASTO) en movimientos de caja para que el Cierre Z descuente de cada método



            if (Array.isArray(metodosReintegro) && metodosReintegro.length > 0) {



                const horaCaracas = getCaracasTime();



                const stmtMovCaja = db.prepare(`



                    INSERT INTO movimientos_caja_locales (



                        id, tipo, concepto, monto, monto_usd, metodo_pago, fecha, cashier_id, company_id, branch_id, estado_cierre



                    ) VALUES (?, 'GASTO', ?, ?, ?, ?, ?, ?, ?, ?, 0)



                `);







                metodosReintegro.forEach(m => {



                    const montoBs = parseFloat(m.montoBs || m.monto || 0);



                    const montoUsd = parseFloat(m.montoUsd || m.monto_usd || 0);



                    if (montoBs > 0 || montoUsd > 0) {



                        const idMov = `ANUL-${Date.now()}-${Math.floor(Math.random()*1000)}`;



                        const concepto = `Anulación Ticket No Fiscal #${numeroFactura || facturaId} - ${clienteNombre || 'Cliente'}`;



                        stmtMovCaja.run(idMov, concepto, montoBs, montoUsd, m.metodo || m.metodo_pago || 'Efectivo', horaCaracas, cashierId || 'SISTEMA', companyId || 'DEFAULT', branchId || 'GLOBAL');



                        if (config.isServer && masterDbDirect) {



                            try {



                                masterDbDirect.prepare(`



                                    INSERT INTO movimientos_caja_locales (



                                        id, tipo, concepto, monto, monto_usd, metodo_pago, fecha, cashier_id, company_id, branch_id, estado_cierre



                                    ) VALUES (?, 'GASTO', ?, ?, ?, ?, ?, ?, ?, ?, 0)



                                `).run(idMov, concepto, montoBs, montoUsd, m.metodo || m.metodo_pago || 'Efectivo', horaCaracas, cashierId || 'SISTEMA', companyId || 'DEFAULT', branchId || 'GLOBAL');



                            } catch(eM) {}



                        }



                    }



                });



            }



        });







        transaccion();







        try {



            if (config.isServer) {



                BrowserWindow.getAllWindows().forEach(v => {



                    if (!v.isDestroyed()) v.webContents.send('stock-actualizado-global');



                });



            } else {



                await llamarMaestro('POST', '/api/maestro/anular-venta', datos, { timeout: 6000, reintentos: 2 });



            }



        } catch(eSync) {



            console.warn("⚠️ No se pudo sincronizar anulación con el Maestro (guardado localmente):", eSync.message);



        }







        return { success: true };



    } catch(err) {



        console.error("❌ Error en anular-venta-no-fiscal-local:", err);



        return { error: err.message };



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



    return stmt.run(datos.uid, datos.email, datos.role, datos.companyId, datos.branchId, JSON.stringify(datos.company_data), getCaracasTime());



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



        const compId = datos.company_id || getActiveCompanyId();



        if (config.isServer && masterDbDirect) {



            // 🚀 MODO SERVIDOR: Escritura directa



            const transaccion = masterDbDirect.transaction(() => {



                // 1. Crear cliente si no existe (CAMBIO A RIF)



                masterDbDirect.prepare(`



                    INSERT INTO clientes_maestro (rif, company_id, nombre, saldo_deuda, estado_sync) 



                    VALUES (?, ?, ?, 0, 0)



                    ON CONFLICT(rif) DO UPDATE SET 



                        nombre = excluded.nombre,



                        company_id = COALESCE(excluded.company_id, clientes_maestro.company_id),



                        estado_sync = 0



                `).run(datos.cliente_id, compId, datos.cliente_nombre);







                // 2. Registrar la cuenta por cobrar



                masterDbDirect.prepare(`



                    INSERT INTO cuentas_por_cobrar (company_id, branch_id, cliente_id, cliente_nombre, monto_bs, monto_usd, factura_nro, fecha, estado, estado_sync)



                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', 0)



                `).run(compId, datos.branch_id || null, datos.cliente_id, datos.cliente_nombre, datos.monto_bs, datos.monto_usd || 0, datos.numero_factura, datos.fecha);



                



                // 3. Actualizar el saldo global (CAMBIO A RIF)



                masterDbDirect.prepare(`



                    UPDATE clientes_maestro SET saldo_deuda = saldo_deuda + ?, estado_sync = 0 WHERE rif = ?



                `).run(datos.monto_bs, datos.cliente_id);



            });







            transaccion();







            // Disparo asíncrono hacia VPS



            try {



                if (typeof cliente === 'undefined' || !cliente) throw new Error('skip');



                const fechaMod = getCaracasTime();



                masterDbDirect.prepare('UPDATE clientes_maestro SET fecha_modificacion = ?, estado_sync = 0 WHERE rif = ?').run(fechaMod, cliente.rif);



                masterDbDirect.prepare('UPDATE cuentas_por_cobrar SET cliente_nombre = ?, estado_sync = 0 WHERE cliente_rif = ?').run(cliente.nombre, cliente.rif);



                if (db) {



                    db.prepare(`



                        INSERT INTO clientes_locales (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync, fecha_modificacion)



                        VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0, 0, @fecha_modificacion)



                        ON CONFLICT(rif) DO UPDATE SET 



                        nombre = excluded.nombre,



                        direccion = excluded.direccion,



                        telefono = excluded.telefono,



                        correo = excluded.correo,



                        es_contribuyente_especial = excluded.es_contribuyente_especial,



                        company_id = COALESCE(excluded.company_id, clientes_locales.company_id),



                        fecha_modificacion = excluded.fecha_modificacion,



                        estado_sync = 0



                    `).run({



                        rif: cliente.rif,



                        nombre: cliente.nombre,



                        direccion: cliente.direccion || 'No especificada',



                        telefono: cliente.telefono || '',



                        correo: cliente.correo || '',



                        es_contribuyente_especial: cliente.es_contribuyente_especial ? 1 : 0,



                        company_id: compId,



                        fecha_modificacion: fechaMod



                    });



                }



            } catch (eMirror) {}



            sincronizarCuentasCobrarConVps(compId).catch(() => {});







            return { exito: true };



        } else {



            // 🌠 MODO CLIENTE: Enviar por red al Servidor Maestro



            const respuesta = await llamarMaestro('POST', '/api/maestro/registrar-deuda', { ...datos, company_id: compId }, { timeout: 8000, reintentos: 2 });



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



        const respuesta = await llamarMaestro('POST', '/api/maestro/registrar-abono', datos, { timeout: 8000, reintentos: 2 });



        if (respuesta && respuesta.data && respuesta.data.exito) {
            if (typeof db !== 'undefined' && db && datos && datos.cliente_id) {
                try {
                    const rate = parseFloat(datos.tasa || 1);
                    const abonoUSD = parseFloat(((datos.monto_bs || 0) / rate).toFixed(2));
                    let rows = db.prepare(`
                        SELECT * FROM cuentas_por_cobrar 
                        WHERE (
                            REPLACE(UPPER(TRIM(COALESCE(cliente_id,''))),'-','') = REPLACE(UPPER(TRIM(?)),'-','') 
                            OR REPLACE(UPPER(TRIM(COALESCE(cliente_rif,''))),'-','') = REPLACE(UPPER(TRIM(?)),'-','')
                            OR REPLACE(UPPER(TRIM(COALESCE(rif_cliente,''))),'-','') = REPLACE(UPPER(TRIM(?)),'-','')
                        ) 
                        AND UPPER(TRIM(COALESCE(estado,''))) NOT IN ('PAGADA','PAGADO') 
                        ORDER BY fecha ASC
                    `).all(datos.cliente_id, datos.cliente_id, datos.cliente_id);

                    if (datos.factura_nro) {
                        const idx = rows.findIndex(d => String(d.factura_nro || '').trim() === String(datos.factura_nro).trim());
                        if (idx > -1) {
                            const target = rows.splice(idx, 1)[0];
                            rows.unshift(target);
                        }
                    }

                    let rem = abonoUSD;
                    for (let f of rows) {
                        if (rem <= 0) break;
                        const orig = (f.monto_usd && f.monto_usd > 0) ? f.monto_usd : parseFloat(((f.monto_bs || 0) / rate).toFixed(2));
                        const pag = parseFloat(f.monto_pagado || 0);
                        const falta = orig - pag;
                        if (falta <= 0.01) {
                            db.prepare("UPDATE cuentas_por_cobrar SET monto_pagado = ?, estado = 'PAGADA', estado_sync = 0 WHERE id = ?").run(orig, f.id);
                            continue;
                        }
                        if (rem >= falta - 0.01) {
                            db.prepare("UPDATE cuentas_por_cobrar SET monto_pagado = ?, estado = 'PAGADA', estado_sync = 0 WHERE id = ?").run(orig, f.id);
                            rem = parseFloat(Math.max(0, rem - falta).toFixed(2));
                        } else {
                            db.prepare("UPDATE cuentas_por_cobrar SET monto_pagado = ?, estado = 'PENDIENTE', estado_sync = 0 WHERE id = ?").run(parseFloat((pag + rem).toFixed(2)), f.id);
                            rem = 0;
                        }
                    }
                } catch (_) {}
            }

            sincronizarCuentasCobrarConVps(datos.company_id || getActiveCompanyId()).catch(() => {});
        }



        return respuesta.data;



    } catch (e) {



        console.error("[MAIN] Error en puente de abonos:", e.message);



        return { exito: false, mensaje: e.message };



    }



});











ipcMain.handle('guardar-cliente-local', async (event, cliente) => {



    try {



        const compId = cliente.company_id || getActiveCompanyId();



        if (config.isServer && masterDbDirect) {



            // 🚀 MODO SERVIDOR: Escribe directamente en el maestro



            const stmt = masterDbDirect.prepare(`



                INSERT INTO clientes_maestro (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync)



                VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0, 0)



                ON CONFLICT(rif) DO UPDATE SET 



                nombre = excluded.nombre,



                direccion = excluded.direccion,



                telefono = excluded.telefono,



                correo = excluded.correo,



                es_contribuyente_especial = excluded.es_contribuyente_especial,



                company_id = COALESCE(excluded.company_id, clientes_maestro.company_id),



                estado_sync = 0



            `);







            stmt.run({



                rif: cliente.rif,



                nombre: cliente.nombre,



                direccion: cliente.direccion || 'No especificada',



                telefono: cliente.telefono || '',



                correo: cliente.correo || '',



                es_contribuyente_especial: cliente.es_contribuyente_especial ? 1 : 0,



                company_id: compId



            });







            try {



                if (typeof cliente === 'undefined' || !cliente) throw new Error('skip');



                const fechaMod = getCaracasTime();



                masterDbDirect.prepare('UPDATE clientes_maestro SET fecha_modificacion = ?, estado_sync = 0 WHERE rif = ?').run(fechaMod, cliente.rif);



                masterDbDirect.prepare('UPDATE cuentas_por_cobrar SET cliente_nombre = ?, estado_sync = 0 WHERE cliente_rif = ?').run(cliente.nombre, cliente.rif);



                if (db) {



                    db.prepare(`



                        INSERT INTO clientes_locales (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync, fecha_modificacion)



                        VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0, 0, @fecha_modificacion)



                        ON CONFLICT(rif) DO UPDATE SET 



                        nombre = excluded.nombre,



                        direccion = excluded.direccion,



                        telefono = excluded.telefono,



                        correo = excluded.correo,



                        es_contribuyente_especial = excluded.es_contribuyente_especial,



                        company_id = COALESCE(excluded.company_id, clientes_locales.company_id),



                        fecha_modificacion = excluded.fecha_modificacion,



                        estado_sync = 0



                    `).run({



                        rif: cliente.rif,



                        nombre: cliente.nombre,



                        direccion: cliente.direccion || 'No especificada',



                        telefono: cliente.telefono || '',



                        correo: cliente.correo || '',



                        es_contribuyente_especial: cliente.es_contribuyente_especial ? 1 : 0,



                        company_id: compId,



                        fecha_modificacion: fechaMod



                    });



                }



            } catch (eMirror) {}



            sincronizarCuentasCobrarConVps(compId).catch(() => {});







            return { success: true };



        } else {



            // 🌠 MODO CLIENTE: Envía por red al Servidor Maestro



            const respuesta = await llamarMaestro('POST', '/api/maestro/guardar-cliente', { ...cliente, company_id: compId }, { timeout: 8000, reintentos: 2 });



            if (db && respuesta && respuesta.data && !respuesta.data.error) {



                try {



                    db.prepare(`



                        INSERT INTO clientes_locales (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync, fecha_modificacion)



                        VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0, 1, @fecha_modificacion)



                        ON CONFLICT(rif) DO UPDATE SET 



                        nombre = excluded.nombre,



                        direccion = excluded.direccion,



                        telefono = excluded.telefono,



                        correo = excluded.correo,



                        es_contribuyente_especial = excluded.es_contribuyente_especial,



                        company_id = COALESCE(excluded.company_id, clientes_locales.company_id),



                        fecha_modificacion = excluded.fecha_modificacion,



                        estado_sync = 1



                    `).run({



                        rif: cliente.rif,



                        nombre: cliente.nombre,



                        direccion: cliente.direccion || 'No especificada',



                        telefono: cliente.telefono || '',



                        correo: cliente.correo || '',



                        es_contribuyente_especial: cliente.es_contribuyente_especial ? 1 : 0,



                        company_id: compId,



                        fecha_modificacion: getCaracasTime()



                    });



                } catch (eCache) {}



            }



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







ipcMain.handle('buscar-cliente-local', async (event, query) => {



    try {



        const queryLimpia = (query || '').trim();



        if (!queryLimpia) return [];







        if (config.isServer && masterDbDirect) {



            const term = `%${queryLimpia}%`;



            const cleanQuery = queryLimpia.replace(/[-\s]/g, '').toUpperCase();



            const cleanTerm = `%${cleanQuery}%`;



            let results = masterDbDirect.prepare(`



                SELECT * FROM clientes_maestro 



                WHERE rif LIKE ? 



                   OR REPLACE(REPLACE(UPPER(rif), '-', ''), ' ', '') LIKE ?



                   OR UPPER(nombre) LIKE ? 



                   OR telefono LIKE ?



                ORDER BY nombre ASC LIMIT 30



            `).all(term, cleanTerm, `%${queryLimpia.toUpperCase()}%`, term);







            if ((!results || results.length === 0) && db) {



                try {



                    results = db.prepare(`



                        SELECT * FROM clientes_locales 



                        WHERE rif LIKE ? 



                           OR REPLACE(REPLACE(UPPER(rif), '-', ''), ' ', '') LIKE ?



                           OR UPPER(nombre) LIKE ? 



                           OR telefono LIKE ?



                        ORDER BY nombre ASC LIMIT 30



                    `).all(term, cleanTerm, `%${queryLimpia.toUpperCase()}%`, term);



                } catch(e) {}



            }



            return results || [];



        } else {



            const respuesta = await llamarMaestro('GET', `/api/maestro/buscar-cliente?query=${encodeURIComponent(queryLimpia)}`, null, { timeout: 6000, reintentos: 1 });



            return Array.isArray(respuesta.data) ? respuesta.data : [];



        }



    } catch (e) {



        console.error("Error al buscar cliente en base de datos:", e);



        return [];



    }



});







ipcMain.handle('eliminar-cliente-local', async (event, rif) => {



    try {



        if (config.isServer && masterDbDirect) {



            masterDbDirect.prepare('DELETE FROM clientes_maestro WHERE rif = ? OR UPPER(rif) = UPPER(?)').run(rif, rif);



            if (db) {



                try { db.prepare('DELETE FROM clientes_locales WHERE rif = ? OR UPPER(rif) = UPPER(?)').run(rif, rif); } catch (_) {}



            }



            return { success: true };



        } else {



            const respuesta = await llamarMaestro('DELETE', `/api/maestro/eliminar-cliente/${encodeURIComponent(rif)}`, null, { timeout: 6000, reintentos: 1 });



            if (db) {



                try { db.prepare('DELETE FROM clientes_locales WHERE rif = ? OR UPPER(rif) = UPPER(?)').run(rif, rif); } catch (_) {}



            }



            return respuesta.data;



        }



    } catch (e) { 



        return { error: e.message }; 



    }



});











// ============================================================



// MÓDULO DE CLIENTES PARA CAJERA (SINCRONIZACIÓN HIJA <-> MAESTRA)



// ============================================================



ipcMain.handle('obtener-clientes-cajera', async (event, companyId) => {



    try {



        if (config.isServer && masterDbDirect) {



            let clientesMaestro = [];



            try {



                clientesMaestro = masterDbDirect.prepare('SELECT * FROM clientes_maestro ORDER BY nombre ASC').all() || [];



            } catch (eM) {}



            let clientesLocales = [];



            if (db) {



                try {



                    clientesLocales = db.prepare('SELECT * FROM clientes_locales ORDER BY nombre ASC').all() || [];



                } catch (eL) {}



            }



            const mapa = new Map();



            for (const c of clientesLocales) {



                if (c && c.rif) mapa.set(String(c.rif).trim().toUpperCase(), c);



            }



            for (const c of clientesMaestro) {



                if (c && c.rif) mapa.set(String(c.rif).trim().toUpperCase(), c);



            }



            return Array.from(mapa.values()).sort((a, b) =>



                String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es', { sensitivity: 'base' })



            );



        } else {



            const respuesta = await llamarMaestro('GET', '/api/maestro/obtener-clientes', null, { timeout: 8000, reintentos: 2 });



            const lista = Array.isArray(respuesta.data) ? respuesta.data : [];



            if (db && lista.length > 0) {



                try {



                    const stmtSync = db.prepare(`



                        INSERT INTO clientes_locales (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync, fecha_modificacion)



                        VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, @saldo_deuda, 1, @fecha_modificacion)



                        ON CONFLICT(rif) DO UPDATE SET 



                        nombre = excluded.nombre,



                        direccion = excluded.direccion,



                        telefono = excluded.telefono,



                        correo = excluded.correo,



                        es_contribuyente_especial = excluded.es_contribuyente_especial,



                        company_id = COALESCE(excluded.company_id, clientes_locales.company_id),



                        fecha_modificacion = excluded.fecha_modificacion,



                        estado_sync = 1



                    `);



                    const tx = db.transaction((items) => {



                        for (const item of items) {



                            stmtSync.run({



                                rif: String(item.rif || '').trim().toUpperCase(),



                                company_id: item.company_id || null,



                                nombre: item.nombre || '',



                                direccion: item.direccion || 'No especificada',



                                telefono: item.telefono || '',



                                correo: item.correo || '',



                                es_contribuyente_especial: item.es_contribuyente_especial ? 1 : 0,



                                saldo_deuda: parseFloat(item.saldo_deuda) || 0,



                                fecha_modificacion: item.fecha_modificacion || getCaracasTime()



                            });



                        }



                    });



                    tx(lista);



                } catch (eCache) {}



            }



            return lista;



        }



    } catch (e) {



        console.error("Error en obtener-clientes-cajera:", e);



        if (db) {



            try { return db.prepare('SELECT * FROM clientes_locales ORDER BY nombre ASC').all() || []; } catch (_) {}



        }



        return [];



    }



});







ipcMain.handle('guardar-cliente-cajera', async (event, cliente) => {



    try {



        const compId = cliente.company_id || getActiveCompanyId();



        const rifLimpio = String(cliente.rif || '').trim().toUpperCase();



        const nombreLimpio = String(cliente.nombre || '').trim();



        const fechaMod = getCaracasTime();



        const payload = {



            rif: rifLimpio,



            nombre: nombreLimpio,



            direccion: cliente.direccion || 'No especificada',



            telefono: cliente.telefono || '',



            correo: cliente.correo || '',



            es_contribuyente_especial: cliente.es_contribuyente_especial ? 1 : 0,



            company_id: compId,



            fecha_modificacion: fechaMod



        };







        if (config.isServer && masterDbDirect) {



            masterDbDirect.prepare(`



                INSERT INTO clientes_maestro (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync, fecha_modificacion)



                VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0, 0, @fecha_modificacion)



                ON CONFLICT(rif) DO UPDATE SET 



                nombre = excluded.nombre,



                direccion = excluded.direccion,



                telefono = excluded.telefono,



                correo = excluded.correo,



                es_contribuyente_especial = excluded.es_contribuyente_especial,



                company_id = COALESCE(excluded.company_id, clientes_maestro.company_id),



                fecha_modificacion = excluded.fecha_modificacion,



                estado_sync = 0



            `).run(payload);







            try {



                masterDbDirect.prepare('UPDATE cuentas_por_cobrar SET cliente_nombre = ?, estado_sync = 0 WHERE cliente_rif = ?').run(nombreLimpio, rifLimpio);



            } catch (_) {}







            if (db) {



                try {



                    db.prepare(`



                        INSERT INTO clientes_locales (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync, fecha_modificacion)



                        VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0, 0, @fecha_modificacion)



                        ON CONFLICT(rif) DO UPDATE SET 



                        nombre = excluded.nombre,



                        direccion = excluded.direccion,



                        telefono = excluded.telefono,



                        correo = excluded.correo,



                        es_contribuyente_especial = excluded.es_contribuyente_especial,



                        company_id = COALESCE(excluded.company_id, clientes_locales.company_id),



                        fecha_modificacion = excluded.fecha_modificacion,



                        estado_sync = 0



                    `).run(payload);



                } catch (_) {}



            }







            sincronizarCuentasCobrarConVps(compId).catch(() => {});



            return { success: true };



        } else {



            const respuesta = await llamarMaestro('POST', '/api/maestro/guardar-cliente', payload, { timeout: 8000, reintentos: 2 });



            if (db && respuesta && respuesta.data && !respuesta.data.error) {



                try {



                    db.prepare(`



                        INSERT INTO clientes_locales (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync, fecha_modificacion)



                        VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0, 1, @fecha_modificacion)



                        ON CONFLICT(rif) DO UPDATE SET 



                        nombre = excluded.nombre,



                        direccion = excluded.direccion,



                        telefono = excluded.telefono,



                        correo = excluded.correo,



                        es_contribuyente_especial = excluded.es_contribuyente_especial,



                        company_id = COALESCE(excluded.company_id, clientes_locales.company_id),



                        fecha_modificacion = excluded.fecha_modificacion,



                        estado_sync = 1



                    `).run(payload);



                } catch (_) {}



            }



            return respuesta.data;



        }



    } catch (error) {



        console.error("Error en guardar-cliente-cajera:", error);



        return { success: false, error: error.message };



    }



});







ipcMain.handle('actualizar-cliente-cajera', async (event, cliente) => {



    try {



        const compId = cliente.company_id || getActiveCompanyId();



        const rifLimpio = String(cliente.rif || '').trim().toUpperCase();



        const nombreLimpio = String(cliente.nombre || '').trim();



        const fechaMod = getCaracasTime();



        const payload = {



            rif: rifLimpio,



            nombre: nombreLimpio,



            direccion: cliente.direccion || 'No especificada',



            telefono: cliente.telefono || '',



            correo: cliente.correo || '',



            es_contribuyente_especial: cliente.es_contribuyente_especial ? 1 : 0,



            company_id: compId,



            fecha_modificacion: fechaMod



        };







        if (config.isServer && masterDbDirect) {



            masterDbDirect.prepare(`



                INSERT INTO clientes_maestro (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync, fecha_modificacion)



                VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0, 0, @fecha_modificacion)



                ON CONFLICT(rif) DO UPDATE SET 



                nombre = excluded.nombre,



                direccion = excluded.direccion,



                telefono = excluded.telefono,



                correo = excluded.correo,



                es_contribuyente_especial = excluded.es_contribuyente_especial,



                company_id = COALESCE(excluded.company_id, clientes_maestro.company_id),



                fecha_modificacion = excluded.fecha_modificacion,



                estado_sync = 0



            `).run(payload);







            try {



                masterDbDirect.prepare('UPDATE cuentas_por_cobrar SET cliente_nombre = ?, estado_sync = 0 WHERE cliente_rif = ?').run(nombreLimpio, rifLimpio);



            } catch (_) {}







            if (db) {



                try {



                    db.prepare(`



                        INSERT INTO clientes_locales (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync, fecha_modificacion)



                        VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0, 0, @fecha_modificacion)



                        ON CONFLICT(rif) DO UPDATE SET 



                        nombre = excluded.nombre,



                        direccion = excluded.direccion,



                        telefono = excluded.telefono,



                        correo = excluded.correo,



                        es_contribuyente_especial = excluded.es_contribuyente_especial,



                        company_id = COALESCE(excluded.company_id, clientes_locales.company_id),



                        fecha_modificacion = excluded.fecha_modificacion,



                        estado_sync = 0



                    `).run(payload);



                } catch (_) {}



            }







            sincronizarCuentasCobrarConVps(compId).catch(() => {});



            return { success: true };



        } else {



            const respuesta = await llamarMaestro('POST', '/api/maestro/actualizar-cliente', payload, { timeout: 8000, reintentos: 2 });



            if (db && respuesta && respuesta.data && !respuesta.data.error) {



                try {



                    db.prepare(`



                        INSERT INTO clientes_locales (rif, company_id, nombre, direccion, telefono, correo, es_contribuyente_especial, saldo_deuda, estado_sync, fecha_modificacion)



                        VALUES (@rif, @company_id, @nombre, @direccion, @telefono, @correo, @es_contribuyente_especial, 0, 1, @fecha_modificacion)



                        ON CONFLICT(rif) DO UPDATE SET 



                        nombre = excluded.nombre,



                        direccion = excluded.direccion,



                        telefono = excluded.telefono,



                        correo = excluded.correo,



                        es_contribuyente_especial = excluded.es_contribuyente_especial,



                        company_id = COALESCE(excluded.company_id, clientes_locales.company_id),



                        fecha_modificacion = excluded.fecha_modificacion,



                        estado_sync = 1



                    `).run(payload);



                } catch (_) {}



            }



            return respuesta.data;



        }



    } catch (error) {



        console.error("Error en actualizar-cliente-cajera:", error);



        return { success: false, error: error.message };



    }



});







ipcMain.handle('eliminar-cliente-cajera', async (event, rif) => {



    try {



        const rifLimpio = String(rif || '').trim();



        if (config.isServer && masterDbDirect) {



            masterDbDirect.prepare('DELETE FROM clientes_maestro WHERE rif = ? OR UPPER(rif) = UPPER(?)').run(rifLimpio, rifLimpio);



            if (db) {



                try { db.prepare('DELETE FROM clientes_locales WHERE rif = ? OR UPPER(rif) = UPPER(?)').run(rifLimpio, rifLimpio); } catch (_) {}



            }



            return { success: true };



        } else {



            const respuesta = await llamarMaestro('DELETE', `/api/maestro/eliminar-cliente/${encodeURIComponent(rifLimpio)}`, null, { timeout: 6000, reintentos: 1 });



            if (db) {



                try { db.prepare('DELETE FROM clientes_locales WHERE rif = ? OR UPPER(rif) = UPPER(?)').run(rifLimpio, rifLimpio); } catch (_) {}



            }



            return respuesta.data;



        }



    } catch (e) {



        console.error("Error en eliminar-cliente-cajera:", e);



        return { error: e.message };



    }



});







ipcMain.handle('buscar-cliente-cajera', async (event, query) => {



    try {



        const queryLimpia = (query || '').trim();



        if (!queryLimpia) return [];







        if (config.isServer && masterDbDirect) {



            const term = `%${queryLimpia}%`;



            const cleanQuery = queryLimpia.replace(/[-\s]/g, '').toUpperCase();



            const cleanTerm = `%${cleanQuery}%`;



            let results = masterDbDirect.prepare(`



                SELECT * FROM clientes_maestro 



                WHERE rif LIKE ? 



                   OR REPLACE(REPLACE(UPPER(rif), '-', ''), ' ', '') LIKE ?



                   OR UPPER(nombre) LIKE ? 



                   OR telefono LIKE ?



                ORDER BY nombre ASC LIMIT 30



            `).all(term, cleanTerm, `%${queryLimpia.toUpperCase()}%`, term);







            if ((!results || results.length === 0) && db) {



                try {



                    results = db.prepare(`



                        SELECT * FROM clientes_locales 



                        WHERE rif LIKE ? 



                           OR REPLACE(REPLACE(UPPER(rif), '-', ''), ' ', '') LIKE ?



                           OR UPPER(nombre) LIKE ? 



                           OR telefono LIKE ?



                        ORDER BY nombre ASC LIMIT 30



                    `).all(term, cleanTerm, `%${queryLimpia.toUpperCase()}%`, term);



                } catch(e) {}



            }



            return results || [];



        } else {



            const respuesta = await llamarMaestro('GET', `/api/maestro/buscar-cliente?query=${encodeURIComponent(queryLimpia)}`, null, { timeout: 6000, reintentos: 1 });



            return Array.isArray(respuesta.data) ? respuesta.data : [];



        }



    } catch (e) {



        console.error("Error en buscar-cliente-cajera:", e);



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

ipcMain.handle('obtener-usuarios-locales', async () => {
    try {
        return db.prepare('SELECT * FROM usuarios_locales').all();
    } catch (e) {
        console.error("Error al obtener usuarios locales:", e);
        return [];
    }
});







ipcMain.handle('leer-puertos', async () => await SerialPort.list());







ipcMain.handle('sincronizar-categorias-local', async (event, categoriasArray) => {



    if (!Array.isArray(categoriasArray) || categoriasArray.length === 0) return { success: true, changes: 0 };



    try {



        let companyFallback = null;



        try {



            const ses = db.prepare("SELECT valor FROM configuracion WHERE clave = 'sesion_activa'").get();



            if (ses && ses.valor) companyFallback = JSON.parse(ses.valor).companyId || null;



        } catch (eSes) {}







        const stmtCheck = db.prepare('SELECT nombre, estado_sync FROM categorias_locales WHERE id = ?');



        const stmtInsert = db.prepare(`



            INSERT INTO categorias_locales (id, company_id, nombre, estado_sync, fecha_modificacion) 



            VALUES (@id, @company_id, @nombre, 1, @fecha_modificacion)



        `);



        const stmtUpdate = db.prepare(`



            UPDATE categorias_locales



            SET nombre = @nombre,



                company_id = COALESCE(@company_id, company_id),



                fecha_modificacion = @fecha_modificacion,



                estado_sync = 1



            WHERE id = @id



        `);







        const transaccion = db.transaction((categorias) => {



            let changes = 0;



            for (const cat of categorias) {



                const id = cat.categoria_id || cat.id || cat.categoria_ID;



                if (!id) continue;



                const nombre = cat.nombre || 'Sin Categoría';



                const company_id = cat.company_id || cat.empresa_ID || companyFallback;



                const fecha_modificacion = cat.fecha_modificacion || getCaracasTime();



                const check = stmtCheck.get(id);



                if (!check) {



                    stmtInsert.run({ id, company_id, nombre, fecha_modificacion });



                    changes++;



                } else if (check.estado_sync !== 0 && String(check.nombre || '') !== String(nombre)) {



                    stmtUpdate.run({ id, company_id, nombre, fecha_modificacion });



                    changes++;



                }



            }



            return changes;



        });







        const changes = transaccion(categoriasArray);



        return { success: true, changes };



    } catch (error) {



        console.error("❌ Error en sincronizar-categorias-local (main.js):", error.message);



        return { success: false, error: error.message, changes: 0 };



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



        if (resultado !== undefined && resultado !== null) {



            return resultado.valor;



        }



        if (config && config[clave] !== undefined) {



            return config[clave];



        }



        return null;



    } catch (error) {



        console.error(`❌ Error obteniendo configuración:`, error.message);



        if (config && config[clave] !== undefined) {



            return config[clave];



        }



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



        return await webContents.getPrintersAsync();



    } catch (error) {



        console.error("❌ Error obteniendo impresoras del sistema:", error);



        return [];



    }



});



















try { db.exec("ALTER TABLE ventas_locales ADD COLUMN ganancia_venta REAL DEFAULT 0"); } catch(e) {}



try { db.exec("ALTER TABLE ventas_locales ADD COLUMN sync_server INTEGER DEFAULT 0"); } catch(e) {}



try { if (masterDbDirect) masterDbDirect.exec("ALTER TABLE ventas_locales ADD COLUMN sync_server INTEGER DEFAULT 0"); } catch(e) {}



try { if (masterDbDirect) masterDbDirect.exec("ALTER TABLE movimientos_stock_maestro ADD COLUMN estado_sync INTEGER DEFAULT 0"); } catch(e) {}



try {



    // Migrar si existía AUTO_UPDATE_BCV y asegurar que confi_auto_tasa exista en tabla configuracion con formato 'true'/'false'



    const oldRow = db.prepare("SELECT valor FROM configuracion WHERE clave = 'AUTO_UPDATE_BCV'").get();



    const defaultVal = (oldRow && (oldRow.valor === '1' || oldRow.valor === 'true')) ? 'true' : 'false';



    db.prepare("INSERT OR IGNORE INTO configuracion (clave, valor, fecha_actualizacion) VALUES ('confi_auto_tasa', ?, datetime('now', '-4 hours'))").run(defaultVal);



    db.prepare("UPDATE configuracion SET valor = 'true' WHERE clave = 'confi_auto_tasa' AND valor = '1'").run();



    db.prepare("UPDATE configuracion SET valor = 'false' WHERE clave = 'confi_auto_tasa' AND valor = '0'").run();



    db.prepare("DELETE FROM configuracion WHERE clave IN ('AUTO_UPDATE_BCV', 'CONFI_AUTO_TASA')").run();



    try { db.exec("ALTER TABLE historial_tasas DROP COLUMN confi_auto_tasa"); } catch(_) {}



    try { if (masterDbDirect) masterDbDirect.exec("ALTER TABLE historial_tasas DROP COLUMN confi_auto_tasa"); } catch(_) {}



} catch(e) {}







// 🩹 Reparación de fechas: ventas guardadas en formato ISO/UTC ('2026-10-04T10:22:36.599Z') por /api/maestro/registrar-venta.



// Las estadísticas filtran por texto 'YYYY-MM-DD HH:MM:SS' en hora local, por lo que esas ventas desaparecían del reporte.



// Solo afecta filas con 'T' en la fecha (idempotente).



for (const conn of [db, masterDbDirect]) {



    if (!conn) continue;



    try {



        const r = conn.prepare(`UPDATE ventas_locales SET fecha_emision = datetime(fecha_emision, '-4 hours') WHERE fecha_emision LIKE '____-__-__T%' AND datetime(fecha_emision, '-4 hours') IS NOT NULL`).run();



        if (r.changes > 0) console.log(`🩹 [FECHAS] ${r.changes} ventas normalizadas de UTC/ISO a hora local.`);



    } catch (e) { console.warn('⚠️ No se pudo normalizar fechas de ventas:', e.message); }



}



















ipcMain.handle('guardar-configuracion', async (event, clave, valor) => {



    try {



        const valorTexto = String(valor);



        



        // 1. Guardar en SQLite (Para la persistencia interna)



        const stmt = db.prepare(`



            INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion)



            VALUES (?, ?, ?)



        `);



        stmt.run(clave, valorTexto, getCaracasTime());







        // 2. Sincronizar con el objeto en memoria



        if (clave === 'isServer') config.isServer = (valor === true || valor === "true");



        else if (clave === 'serverIP') config.serverIP = valor;



        else if (clave === 'allowNoStock') config.allowNoStock = (valor === true || valor === "true");



        else if (clave === 'geminiApiKey') config.geminiApiKey = valor;



        else if (clave === 'showConsole' || clave === 'mostrarConsola') config.showConsole = (valor === true || valor === "true");



        else if (clave === 'config_bascula') {



            try {



                const cfgBascula = JSON.parse(valorTexto);



                if (cfgBascula && cfgBascula.enableScale && cfgBascula.puertoCOM) {



                    senderBasculaActivo = event.sender;



                    conectarPuertoBascula(cfgBascula.puertoCOM, cfgBascula.baudRate || 9600, false);



                } else {



                    basculaConfigActual.enabled = false;



                    cerrarPuertoBasculaActual();



                }



            } catch (eBasc) {



                console.warn("⚠️ Error procesando config_bascula en tiempo real:", eBasc.message);



            }



        }







        // 3. Escribir en el archivo físico config.json (Recreándolo si no existe)



        const llavesFisicas = ['isServer', 'serverIP', 'allowNoStock', 'geminiApiKey', 'showConsole', 'mostrarConsola'];



        if (llavesFisicas.includes(clave)) {



            config.showConsole = (clave === 'showConsole' || clave === 'mostrarConsola') ? (valor === true || valor === "true") : (config.showConsole || false);



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

// ============================================================
// ESCANEO AUTOMÁTICO DE SERVIDOR MAESTRO EN RED LOCAL (PORT 3000)
// Timeout estricto de 100 ms por solicitud conforme a requerimiento
// ============================================================
function getIpsPropiasDeEstaMaquina() {
    const ipsLocales = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1']);
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const addr of (interfaces[name] || [])) {
                if (addr.address) {
                    ipsLocales.add(addr.address.toLowerCase());
                }
            }
        }
    } catch (_) {}
    return ipsLocales;
}

function getSubnetCandidatesParaEscaneo() {
    try {
        const interfaces = os.networkInterfaces();
        const candidateSubnets = [];

        const ifaceNames = Object.keys(interfaces).sort((a, b) => {
            const isVirtualA = /vmware|virtual|vbox|hyper-v|wsl|docker|tap|tun/i.test(a);
            const isVirtualB = /vmware|virtual|vbox|hyper-v|wsl|docker|tap|tun/i.test(b);
            if (isVirtualA && !isVirtualB) return 1;
            if (!isVirtualA && isVirtualB) return -1;
            return 0;
        });

        for (const name of ifaceNames) {
            const addrs = interfaces[name] || [];
            for (const addr of addrs) {
                if (addr.family === 'IPv4' && !addr.internal && addr.address) {
                    const parts = addr.address.split('.');
                    if (parts.length === 4) {
                        const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
                        if (!candidateSubnets.some(c => c.prefix === prefix)) {
                            candidateSubnets.push({
                                iface: name,
                                hostIp: addr.address,
                                prefix: prefix
                            });
                        }
                    }
                }
            }
        }
        return candidateSubnets;
    } catch (e) {
        console.error('[AUTO-IP] Error obteniendo interfaces de red:', e.message);
        return [];
    }
}

function pingServidorNexus(ip, timeoutMs = 100, masterSignal = null) {
    return new Promise((resolve) => {
        let finished = false;
        const controller = new AbortController();
        const t0 = Date.now();
        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                try { controller.abort(); } catch (_) {}
                resolve({ ok: false, ip });
            }
        }, timeoutMs);

        if (masterSignal) {
            masterSignal.addEventListener('abort', () => {
                if (!finished) {
                    finished = true;
                    clearTimeout(timer);
                    try { controller.abort(); } catch (_) {}
                    resolve({ ok: false, ip });
                }
            }, { once: true });
        }

        fetch(`http://${ip}:3000/api/nexus-ping`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
        })
        .then(async (res) => {
            if (finished) return;
            if (res.ok) {
                const data = await res.json().catch(() => null);
                if (data && (data.app === 'NEXUS-POS-SERVER' || data.status === 'ok')) {
                    finished = true;
                    clearTimeout(timer);
                    return resolve({ ok: true, ip, latency: Date.now() - t0, port: data.port || 3000 });
                }
            } else if (res.status === 404) {
                // Compatibilidad: Si la PC Maestra no tiene la última versión de server.js con /api/nexus-ping,
                // verificar si responde en /api/tasas (ruta histórica de NEXUS POS)
                const poweredBy = (res.headers.get('x-powered-by') || '').toLowerCase();
                if (poweredBy.includes('express')) {
                    try {
                        const r2 = await fetch(`http://${ip}:3000/api/tasas`, {
                            method: 'GET',
                            headers: { 'Accept': 'application/json' },
                            signal: controller.signal
                        });
                        if (r2.ok) {
                            const d2 = await r2.json().catch(() => null);
                            if (d2 && d2.rates) {
                                finished = true;
                                clearTimeout(timer);
                                return resolve({ ok: true, ip, latency: Date.now() - t0, port: 3000 });
                            }
                        }
                    } catch (_) {}
                }
            }
            finished = true;
            clearTimeout(timer);
            resolve({ ok: false, ip });
        })
        .catch(() => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                resolve({ ok: false, ip });
            }
        });
    });
}

async function escanearServidorMaestroLocal(timeoutMs = 100) {
    const tStart = Date.now();
    const subnets = getSubnetCandidatesParaEscaneo();
    if (!subnets || subnets.length === 0) {
        return { success: false, message: 'No se encontraron interfaces de red activas en el equipo.' };
    }

    const ipsPropias = getIpsPropiasDeEstaMaquina();
    const masterController = new AbortController();

    // 1. Prioridad: Si existía una IP remota configurada previamente, probarla primero
    // (siempre y cuando NO sea localhost ni una dirección IP propia de esta máquina)
    try {
        const ipActual = (typeof getIpMaestro === 'function') ? getIpMaestro() : null;
        if (ipActual && !ipsPropias.has(ipActual.toLowerCase())) {
            const r = await pingServidorNexus(ipActual, timeoutMs, masterController.signal);
            if (r.ok && !ipsPropias.has(r.ip.toLowerCase())) {
                return { success: true, ip: r.ip, latency: r.latency, totalTime: Date.now() - tStart, verificado: 'actual' };
            }
        }
    } catch (_) {}

    // 2. Barrido masivo de subredes concurrentemente en lotes
    // EXCLUYENDO rigurosamente localhost (127.0.0.1) y todas las IPs de esta máquina
    const BATCH_SIZE = timeoutMs >= 1000 ? 50 : 35;
    for (const sub of subnets) {
        const ipsParaEscanear = [];
        for (let host = 1; host <= 254; host++) {
            const ipTest = `${sub.prefix}.${host}`;
            if (!ipsPropias.has(ipTest.toLowerCase())) {
                ipsParaEscanear.push(ipTest);
            }
        }

        for (let i = 0; i < ipsParaEscanear.length; i += BATCH_SIZE) {
            if (masterController.signal.aborted) break;
            const batch = ipsParaEscanear.slice(i, i + BATCH_SIZE);
            const promises = batch.map(ip => pingServidorNexus(ip, timeoutMs, masterController.signal));
            const results = await Promise.all(promises);
            const encontrado = results.find(r => r.ok && !ipsPropias.has(r.ip.toLowerCase()));
            if (encontrado) {
                masterController.abort();
                return {
                    success: true,
                    ip: encontrado.ip,
                    latency: encontrado.latency,
                    totalTime: Date.now() - tStart,
                    interfaz: sub.iface
                };
            }
        }
    }

    return {
        success: false,
        message: `No se encontró ningún servidor NEXUS POS activo en las otras computadoras de la red local que responda en menos de ${timeoutMs} ms.`,
        totalTime: Date.now() - tStart
    };
}

ipcMain.handle('identificar-servidor-maestro', async (event, customTimeout) => {
    try {
        const timeoutMs = parseInt(customTimeout) || 100;
        console.log(`[RED] 🔍 Iniciando identificación automática de servidor maestro NEXUS (timeout: ${timeoutMs} ms)...`);
        const resultado = await escanearServidorMaestroLocal(timeoutMs);
        console.log('[RED] 📡 Resultado de escaneo automático:', resultado);
        return resultado;
    } catch (error) {
        console.error('[RED] ❌ Error en identificación de servidor maestro:', error);
        return { success: false, message: error.message || 'Error inesperado durante el escaneo.' };
    }
});







function limpiarTextoTicketParaConsola(texto) {



    if (!texto) return "";



    return texto



        .replace(/\x1B\x40/g, '') // Reset



        .replace(/\x1B\x21[\x00-\xFF]/g, '') // Print mode



        .replace(/\x1B\x45[\x00-\xFF]/g, '') // Bold



        .replace(/\x1B\x70[\x00-\xFF]{3}/g, '') // Cash drawer



        .replace(/\x1B\x6D/g, '') // Cut



        .replace(/\x1D\x28\x6B[\x00-\xFF]+/g, '') // QR



        .replace(/\x1B[\x00-\xFF]/g, '') // ESC general



        .replace(/\x1D[\x00-\xFF]/g, '') // GS general



        .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Control characters



}







ipcMain.handle('imprimir-texto-libre', async (event, textoTicket, nombreImpresora) => {



    if (!textoTicket) {



        return { exito: false, mensaje: "No se proporcionó contenido para el ticket." };



    }







    // 🖨️ Log visible en consola con formato de ticket/factura para pruebas sin impresora física



    const ticketConsola = limpiarTextoTicketParaConsola(textoTicket);



    console.log("\n" + "=".repeat(52));



    console.log("🧾 ============ [ VISTA DE FACTURA EN CONSOLA ] ============");



    console.log(`🖨️  IMPRESORA DESTINO: [ ${nombreImpresora || 'MODO CONSOLA / SIMULACIÓN'} ]`);



    console.log("=".repeat(52));



    console.log(ticketConsola.trim());



    console.log("=".repeat(52) + "\n");







    if (!nombreImpresora || nombreImpresora.trim() === '' || nombreImpresora === 'CONSOLA' || nombreImpresora === 'SIMULADOR') {



        console.log("ℹ️ Impresión completada en modo simulación (log en consola).");



        return { exito: true, mensaje: "Impreso en consola con éxito (Modo Simulación)" };



    }







    try {



        const randomId = Math.random().toString(36).substring(7);



        const rutaArchivo = path.join(app.getPath('userData'), `ticket_temp_${randomId}.txt`);



        fs.writeFileSync(rutaArchivo, textoTicket, 'latin1');







        const printerClean = nombreImpresora.trim();



        const comandoCMD = `copy /B "${rutaArchivo}" "\\\\localhost\\${printerClean}"`;







        return new Promise((resolve) => {



            exec(comandoCMD, (error, stdout, stderr) => {



                setTimeout(() => {



                    try {



                        if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);



                    } catch(eClean) {}



                }, 2000);







                if (error) {



                    console.warn(`⚠️ No se pudo enviar a la impresora física (${error.message}). Impresión simulada en consola.`);



                    resolve({ exito: true, simulado: true, mensaje: "Impreso en consola (Impresora física no detectada)" });



                } else {



                    console.log(`🖨️ Ticket enviado físicamente a: \\\\localhost\\${printerClean}`);



                    resolve({ exito: true });



                }



            });



        });



    } catch (error) {



        console.error("❌ Error en impresión:", error.message);



        return { exito: true, simulado: true, mensaje: "Impreso en consola" };



    }



});







// --- GESTIÓN DE FACTURAS EN FORMATO ESTÁNDAR / PDF ---



ipcMain.handle('generar-pdf-factura', async (event, { datosFactura, formatoPapel }) => {



    try {



        const { generarHTMLFactura } = require('./services/template-factura');



        



        let datosCompletos = { ...datosFactura };



        try {



            const row = db.prepare("SELECT valor FROM configuracion WHERE clave = 'config_factura'").get();



            if (row && row.valor) {



                const cfg = JSON.parse(row.valor);



                if (cfg.encabezadoFactura && !datosCompletos.encabezadoFactura) {



                    datosCompletos.encabezadoFactura = cfg.encabezadoFactura;



                }



                if (cfg.logoFactura && !datosCompletos.logoBase64) {



                    datosCompletos.logoBase64 = cfg.logoFactura;



                }



            }



        } catch (eDb) {



            console.warn("⚠️ No se pudo leer config_factura para PDF:", eDb.message);



        }







        const formato = formatoPapel || 'CARTA';



        const html = generarHTMLFactura(datosCompletos, formato);







        const printWin = new BrowserWindow({



            show: false,



            width: 1200,



            height: 900,



            webPreferences: {



                nodeIntegration: false,



                contextIsolation: true,



                webSecurity: false



            }



        });







        const printOptions = {



            margins: { top: 0, bottom: 0, left: 0, right: 0 },



            marginsType: 1,



            printBackground: true,



            preferCSSPageSize: true



        };







        if (formato === 'MEDIA_CARTA') {



            printOptions.landscape = true;



            printOptions.pageSize = { width: 215900, height: 139700 };



        } else if (formato === 'OFICIO') {



            printOptions.landscape = false;



            printOptions.pageSize = 'Legal';



        } else {



            printOptions.landscape = false;



            printOptions.pageSize = 'Letter';



        }







        const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);



        await printWin.loadURL(dataUrl);



        await new Promise(r => setTimeout(r, 400));







        const pdfBuffer = await printWin.webContents.printToPDF(printOptions);



        printWin.close();







        return {



            success: true,



            pdfBase64: `data:application/pdf;base64,${pdfBuffer.toString('base64')}`,



            rawBufferBase64: pdfBuffer.toString('base64'),



            htmlContent: html,



            formato



        };



    } catch (err) {



        console.error("❌ Error generando PDF de factura:", err);



        return { success: false, error: err.message };



    }



});







ipcMain.handle('imprimir-pdf-factura', async (event, { datosFactura, formatoPapel, nombreImpresora }) => {



    try {



        const { generarHTMLFactura } = require('./services/template-factura');



        



        let datosCompletos = { ...datosFactura };



        try {



            const row = db.prepare("SELECT valor FROM configuracion WHERE clave = 'config_factura'").get();



            if (row && row.valor) {



                const cfg = JSON.parse(row.valor);



                if (cfg.encabezadoFactura && !datosCompletos.encabezadoFactura) {



                    datosCompletos.encabezadoFactura = cfg.encabezadoFactura;



                }



                if (cfg.logoFactura && !datosCompletos.logoBase64) {



                    datosCompletos.logoBase64 = cfg.logoFactura;



                }



            }



        } catch (eDb) {}







        const formato = formatoPapel || 'CARTA';



        const html = generarHTMLFactura(datosCompletos, formato);







        const printWin = new BrowserWindow({



            show: false,



            width: 1200,



            height: 900,



            webPreferences: {



                nodeIntegration: false,



                contextIsolation: true,



                webSecurity: false



            }



        });







        const printOptions = {



            silent: true,



            printBackground: true,



            margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },



            marginsType: 1,



            preferCSSPageSize: true



        };







        if (nombreImpresora && nombreImpresora.trim()) {



            printOptions.deviceName = nombreImpresora.trim();



        }







        if (formato === 'MEDIA_CARTA') {



            printOptions.landscape = true;



            printOptions.pageSize = { width: 215900, height: 139700 };



        } else if (formato === 'OFICIO') {



            printOptions.landscape = false;



            printOptions.pageSize = 'Legal';



        } else {



            printOptions.landscape = false;



            printOptions.pageSize = 'Letter';



        }







        const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);



        await printWin.loadURL(dataUrl);



        await new Promise(r => setTimeout(r, 400));







        return new Promise((resolve) => {



            // 1. Intento inicial de impresión directa/silenciosa



            printWin.webContents.print(printOptions, (success, failureReason) => {



                if (success) {



                    try { printWin.close(); } catch(eWin) {}



                    console.log(`🖨️ Factura impresa correctamente en modo silencioso: ${nombreImpresora || 'Default'}`);



                    return resolve({ success: true });



                }







                console.warn(`⚠️ Impresión silenciosa no pudo completarse (${failureReason}). Desplegando cuadro de diálogo de Windows...`);







                // 2. Fallback automático: Abre la ventana nativa de impresión de Windows



                const dialogPrintOptions = {



                    silent: false,



                    printBackground: true,



                    margins: { marginType: 'none', top: 0, bottom: 0, left: 0, right: 0 },



                    marginsType: 1,



                    preferCSSPageSize: true



                };







                if (formato === 'MEDIA_CARTA') {



                    dialogPrintOptions.landscape = true;



                    dialogPrintOptions.pageSize = { width: 215900, height: 139700 };



                } else if (formato === 'OFICIO') {



                    dialogPrintOptions.landscape = false;



                    dialogPrintOptions.pageSize = 'Legal';



                } else {



                    dialogPrintOptions.landscape = false;



                    dialogPrintOptions.pageSize = 'Letter';



                }







                printWin.webContents.print(dialogPrintOptions, (dialogSuccess, dialogFailureReason) => {



                    try { printWin.close(); } catch(eWin) {}



                    if (!dialogSuccess) {



                        console.warn("ℹ️ Diálogo de impresión cerrado o cancelado por el usuario:", dialogFailureReason);



                        resolve({ success: false, canceled: true, error: dialogFailureReason });



                    } else {



                        console.log("🖨️ Factura enviada a través del cuadro de impresión de Windows exitosamente.");



                        resolve({ success: true, viaDialog: true });



                    }



                });



            });



        });



    } catch (err) {



        console.error("❌ Error en imprimir-pdf-factura:", err);



        return { success: false, error: err.message };



    }



});







ipcMain.handle('guardar-pdf-factura', async (event, { rawBufferBase64, pdfBase64, nombreArchivoSugerido }) => {



    try {



        const base64Data = rawBufferBase64 || (pdfBase64 ? pdfBase64.replace(/^data:application\/pdf;base64,/, '') : '');



        if (!base64Data) {



            return { success: false, error: "No se proporcionaron datos del PDF para guardar." };



        }







        const focusedWindow = BrowserWindow.getFocusedWindow();



        const defaultName = nombreArchivoSugerido || `Factura_${Date.now()}.pdf`;



        



        const saveDialogResult = await dialog.showSaveDialog(focusedWindow, {



            title: 'Guardar Factura / Nota de Entrega en PDF',



            defaultPath: path.join(app.getPath('documents'), defaultName),



            filters: [



                { name: 'Documentos PDF (*.pdf)', extensions: ['pdf'] }



            ]



        });







        if (saveDialogResult.canceled || !saveDialogResult.filePath) {



            return { success: false, canceled: true };



        }







        const buffer = Buffer.from(base64Data, 'base64');



        fs.writeFileSync(saveDialogResult.filePath, buffer);



        console.log(`💾 Factura guardada exitosamente en: ${saveDialogResult.filePath}`);







        return { success: true, filePath: saveDialogResult.filePath };



    } catch (err) {



        console.error("❌ Error guardando PDF:", err);



        return { success: false, error: err.message };



    }



});









let isSavingExcelActive = false;

async function generarExcelDisenadoNexus(datosExportacion, rutaDestino) {
    let ExcelJS;
    try {
        ExcelJS = require('exceljs');
    } catch (eReq) {
        ExcelJS = require(path.join(__dirname, 'node_modules', 'exceljs'));
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'NEXUS POS';
    wb.lastModifiedBy = 'NEXUS POS';
    wb.created = new Date();
    wb.modified = new Date();

    const ws = wb.addWorksheet('Inventario', {
        views: [{ showGridLines: true }],
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });

    // 1. Logo de NEXUS POS (image_b9add182 - copia-Photoroom con aspecto perfecto sin deformación)
    const logoRutas = [
        path.join(__dirname, 'public', 'logo_reporte_excel.png'),
        path.join(__dirname, 'public', 'image_b9add182 - copia-Photoroom.png'),
        path.join(__dirname, 'public', 'logo_nexus_sin_fondo.png'),
        path.join(__dirname, 'public', 'logo_nexus.png'),
        path.join(typeof app !== 'undefined' && app.getAppPath ? app.getAppPath() : __dirname, 'public', 'logo_reporte_excel.png'),
        path.join(typeof app !== 'undefined' && app.getAppPath ? app.getAppPath() : __dirname, 'public', 'image_b9add182 - copia-Photoroom.png')
    ];
    let logoPath = logoRutas.find(p => fs.existsSync(p));
    if (logoPath) {
        try {
            const buf = fs.readFileSync(logoPath);
            let imgW = 980;
            let imgH = 679;
            if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
                imgW = buf.readUInt32BE(16) || 980;
                imgH = buf.readUInt32BE(20) || 679;
            }
            const ratio = imgW / imgH;
            const targetH = 66;
            const targetW = Math.round(targetH * ratio);

            const logoId = wb.addImage({
                filename: logoPath,
                extension: 'png'
            });
            ws.addImage(logoId, {
                tl: { col: 0.15, row: 1.15 },
                ext: { width: targetW, height: targetH }
            });
        } catch(eLogo) {
            console.warn("⚠️ No se pudo incrustar el logo en el Excel:", eLogo.message);
        }
    }

    // Alturas de encabezado
    ws.getRow(1).height = 14;
    ws.getRow(2).height = 24;
    ws.getRow(3).height = 18;
    ws.getRow(4).height = 24;
    ws.getRow(5).height = 12; // Espaciador

    // Título principal
    ws.mergeCells('C2:K2');
    const titleCell = ws.getCell('C2');
    titleCell.value = 'NEXUS POS — CATÁLOGO GENERAL DE INVENTARIO Y EXISTENCIAS';
    titleCell.font = { name: 'Segoe UI', size: 14, bold: true, color: { argb: 'FF0F172A' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };

    // Subtítulo con fecha
    ws.mergeCells('C3:K3');
    const subtitleCell = ws.getCell('C3');
    const ahora = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fechaFormat = `${ahora.getFullYear()}-${pad(ahora.getMonth() + 1)}-${pad(ahora.getDate())} ${pad(ahora.getHours())}:${pad(ahora.getMinutes())}`;
    subtitleCell.value = `Fecha de emisión: ${fechaFormat} | Reporte consolidado con desglose de existencias por sucursal`;
    subtitleCell.font = { name: 'Segoe UI', size: 9.5, italic: true, color: { argb: 'FF64748B' } };
    subtitleCell.alignment = { vertical: 'middle', horizontal: 'left' };

    // Filas de datos recibidas
    const filas = datosExportacion.filas || [];
    const encabezados = filas[0] || [];
    const datosFilas = filas.slice(1);

    const totalProds = datosFilas.length;
    const sucursales = datosExportacion.sucursales || [];
    const totalSucursales = sucursales.length;

    // KPI 1: Total Productos
    ws.mergeCells('C4:D4');
    const kpi1 = ws.getCell('C4');
    kpi1.value = `📦 Total Productos: ${totalProds}`;
    kpi1.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF1E293B' } };
    kpi1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    kpi1.alignment = { vertical: 'middle', horizontal: 'center' };
    kpi1.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
    };

    // KPI 2: Sucursales Activas
    ws.mergeCells('E4:F4');
    const kpi2 = ws.getCell('E4');
    kpi2.value = `🏢 Sucursales Activas: ${totalSucursales}`;
    kpi2.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF1E293B' } };
    kpi2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    kpi2.alignment = { vertical: 'middle', horizontal: 'center' };
    kpi2.border = {
        top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
    };

    // Fila 6: Encabezados de la tabla
    const headerRowIndex = 6;
    const hRow = ws.getRow(headerRowIndex);
    hRow.values = encabezados;
    hRow.height = 30;

    encabezados.forEach((h, idx) => {
        const colNum = idx + 1;
        const cell = hRow.getCell(colNum);
        let bgColor = 'FF1E293B'; // Azul pizarra corporativo
        if (h === '|') {
            bgColor = 'FF10B981'; // Verde esmeralda para la barra divisoria
        } else if (idx === 12) {
            bgColor = 'FF065F46'; // Verde oscuro para Cantidad Stock Total
        } else if (idx > 12) {
            bgColor = 'FF047857'; // Verde esmeralda medio para columnas de sucursales
        }

        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: bgColor }
        };
        cell.font = {
            name: 'Segoe UI',
            size: 10,
            bold: true,
            color: { argb: 'FFFFFFFF' }
        };
        cell.alignment = {
            vertical: 'middle',
            horizontal: (h === '|' || idx >= 11 || idx === 1 || idx === 2 || idx === 3 || idx === 4 || idx === 5) ? 'center' : 'left',
            wrapText: true
        };
        cell.border = {
            top: { style: 'medium', color: { argb: 'FF0F172A' } },
            bottom: { style: 'medium', color: { argb: 'FF0F172A' } },
            left: { style: 'thin', color: { argb: 'FF334155' } },
            right: { style: 'thin', color: { argb: 'FF334155' } }
        };
    });

    let granTotalStock = 0;
    const totalesPorSucursal = new Array(Math.max(0, encabezados.length - 13)).fill(0);

    // Filas de productos
    datosFilas.forEach((rowValues, pIdx) => {
        const rowNum = headerRowIndex + 1 + pIdx;
        const row = ws.getRow(rowNum);
        row.values = rowValues;
        row.height = 21;

        const isEven = pIdx % 2 === 1;
        const rowBgColor = isEven ? 'FFF8FAFC' : 'FFFFFFFF';

        const stockProd = Number(rowValues[12]) || 0;
        granTotalStock += stockProd;

        // Acumular totales de sucursales
        for (let sI = 0; sI < totalesPorSucursal.length; sI++) {
            totalesPorSucursal[sI] += Number(rowValues[13 + sI]) || 0;
        }

        rowValues.forEach((val, cIdx) => {
            const colNum = cIdx + 1;
            const cell = row.getCell(colNum);
            const isSep = (cIdx === 11);

            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: isSep ? 'FFECFDF5' : rowBgColor }
            };

            cell.font = {
                name: 'Segoe UI',
                size: 9.5,
                bold: isSep || cIdx === 12,
                color: { argb: isSep ? 'FF10B981' : (cIdx === 12 ? 'FF065F46' : 'FF1E293B') }
            };

            if (cIdx === 1 || cIdx === 3 || cIdx === 4 || cIdx === 5) {
                // Precio compra, P1, P2, P3
                cell.numFmt = '#,##0.00';
                cell.alignment = { vertical: 'middle', horizontal: 'right' };
            } else if (cIdx === 2) {
                // Ganancia
                cell.numFmt = '0.00"%"';
                cell.alignment = { vertical: 'middle', horizontal: 'right' };
            } else if (cIdx >= 12) {
                // Cantidad stock y sucursales
                cell.numFmt = '#,##0.00';
                cell.alignment = { vertical: 'middle', horizontal: 'right' };
            } else if (cIdx === 7 || cIdx === 8 || cIdx === 9 || cIdx === 10 || isSep) {
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
            } else {
                cell.alignment = { vertical: 'middle', horizontal: 'left' };
            }

            cell.border = {
                top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                left: { style: isSep ? 'medium' : 'thin', color: { argb: isSep ? 'FF10B981' : 'FFE2E8F0' } },
                right: { style: isSep ? 'medium' : 'thin', color: { argb: isSep ? 'FF10B981' : 'FFE2E8F0' } }
            };
        });
    });

    // Fila de TOTALES GENERALES
    const totalRowIndex = headerRowIndex + 1 + datosFilas.length;
    const totalRow = ws.getRow(totalRowIndex);
    totalRow.height = 24;

    const totalValues = new Array(encabezados.length).fill('');
    totalValues[0] = 'TOTALES GENERALES:';
    totalValues[11] = '|';
    totalValues[12] = granTotalStock;
    totalesPorSucursal.forEach((tot, sIdx) => {
        totalValues[13 + sIdx] = tot;
    });

    totalRow.values = totalValues;

    totalValues.forEach((val, cIdx) => {
        const colNum = cIdx + 1;
        const cell = totalRow.getCell(colNum);
        const isSep = (cIdx === 11);

        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: isSep ? 'FF10B981' : 'FFF1F5F9' }
        };
        cell.font = {
            name: 'Segoe UI',
            size: 10,
            bold: true,
            color: { argb: isSep ? 'FFFFFFFF' : (cIdx >= 12 ? 'FF065F46' : 'FF0F172A') }
        };

        if (cIdx >= 12) {
            cell.numFmt = '#,##0.00';
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
        } else if (isSep) {
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else {
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
        }

        cell.border = {
            top: { style: 'medium', color: { argb: 'FF94A3B8' } },
            bottom: { style: 'double', color: { argb: 'FF0F172A' } },
            left: { style: isSep ? 'medium' : 'thin', color: { argb: isSep ? 'FF10B981' : 'FFE2E8F0' } },
            right: { style: isSep ? 'medium' : 'thin', color: { argb: isSep ? 'FF10B981' : 'FFE2E8F0' } }
        };
    });

    // Ancho de columnas
    const colWidths = [
        { width: 34 }, // Nombre
        { width: 18 }, // Precio compra
        { width: 30 }, // Porcentaje ganancia
        { width: 14 }, // P1
        { width: 14 }, // P2
        { width: 14 }, // P3
        { width: 22 }, // Categoría
        { width: 18 }, // Código barra
        { width: 18 }, // Moneda
        { width: 22 }, // Alícuota
        { width: 18 }, // Unidad
        { width: 4  }, // | Separador estrecho como una barra divisoria vertical
        { width: 18 }  // Cantidad stock
    ];
    for (let i = 0; i < totalesPorSucursal.length; i++) {
        colWidths.push({ width: 18 });
    }
    ws.columns = colWidths;

    await wb.xlsx.writeFile(rutaDestino);
    return true;
}

ipcMain.handle('guardar-archivo-excel', async (event, { datosExportacion, base64Data, nombreArchivoSugerido }) => {
    if (isSavingExcelActive) {
        console.warn("⚠️ Diálogo de guardar Excel ya activo. Ignorando solicitud concurrente.");
        return { success: false, canceled: true };
    }
    isSavingExcelActive = true;
    try {
        const focusedWindow = BrowserWindow.getFocusedWindow() || (typeof win !== 'undefined' ? win : null);
        const defaultName = nombreArchivoSugerido || `Inventario_NEXUSPOS_${Date.now()}.xlsx`;

        const saveDialogResult = await dialog.showSaveDialog(focusedWindow, {
            title: 'Exportar Inventario a Excel',
            defaultPath: path.join(app.getPath('documents'), defaultName),
            filters: [
                { name: 'Libro de Excel (*.xlsx)', extensions: ['xlsx'] }
            ]
        });

        if (saveDialogResult.canceled || !saveDialogResult.filePath) {
            return { success: false, canceled: true };
        }

        if (datosExportacion && Array.isArray(datosExportacion.filas) && datosExportacion.filas.length > 0) {
            await generarExcelDisenadoNexus(datosExportacion, saveDialogResult.filePath);
            console.log(`📊 Inventario con diseño Nexus exportado exitosamente en: ${saveDialogResult.filePath}`);
            return { success: true, filePath: saveDialogResult.filePath };
        } else if (base64Data) {
            const dataB64 = base64Data.replace(/^data:.*?;base64,/, '');
            const buffer = Buffer.from(dataB64, 'base64');
            fs.writeFileSync(saveDialogResult.filePath, buffer);
            console.log(`📊 Inventario exportado exitosamente en: ${saveDialogResult.filePath}`);
            return { success: true, filePath: saveDialogResult.filePath };
        } else {
            return { success: false, error: "No se proporcionaron datos para exportar a Excel." };
        }
    } catch (err) {
        console.error("❌ Error guardando archivo Excel:", err);
        return { success: false, error: err.message };
    } finally {
        isSavingExcelActive = false;
    }
});

ipcMain.handle('obtener-cola-sincronizacion', async () => {
    try {
        // Leemos solo los pendientes que no hayan superado el límite de 10 intentos
        try {
            const stmt = db.prepare("SELECT * FROM sync_queue WHERE (estado = 'PENDIENTE' OR estado IS NULL) AND (intentos < 10 OR intentos IS NULL) ORDER BY fecha_creacion ASC");
            return stmt.all();
        } catch (colErr) {
            const stmt = db.prepare('SELECT * FROM sync_queue ORDER BY fecha_creacion ASC');
            return stmt.all();
        }
    } catch (e) {
        console.error("❌ Error al leer la cola de sincronización:", e);
        return [];
    }
});

ipcMain.handle('registrar-fallo-cola', async (event, { id, error }) => {
    try {
        const maxIntentos = 10;
        const reg = db.prepare('SELECT id, intentos, tabla FROM sync_queue WHERE id = ?').get(id);
        if (!reg) return { exito: false, mensaje: 'Registro no encontrado' };

        const nuevosIntentos = (parseInt(reg.intentos) || 0) + 1;
        const nuevoEstado = nuevosIntentos >= maxIntentos ? 'FALLIDO' : 'PENDIENTE';
        const errorMsg = String(error || '').slice(0, 500);

        db.prepare('UPDATE sync_queue SET intentos = ?, ultimo_error = ?, estado = ? WHERE id = ?')
          .run(nuevosIntentos, errorMsg, nuevoEstado, id);

        if (nuevoEstado === 'FALLIDO') {
            console.warn(`🛡️ [SYNC QUEUE] Registro ${id} (${reg.tabla}) alcanzó el límite de ${maxIntentos} intentos. Marcado como FALLIDO para desatascar la cola.`);
        }

        return { exito: true, intentos: nuevosIntentos, estado: nuevoEstado };
    } catch (e) {
        console.error("❌ Error al registrar fallo en sync_queue:", e.message);
        return { exito: false, error: e.message };
    }
});

ipcMain.handle('obtener-cola-fallidos', async () => {
    try {
        return db.prepare("SELECT * FROM sync_queue WHERE estado = 'FALLIDO' OR intentos >= 10 ORDER BY fecha_creacion DESC").all();
    } catch (e) {
        return [];
    }
});

ipcMain.handle('reintentar-cola-fallidos', async () => {
    try {
        const res = db.prepare("UPDATE sync_queue SET intentos = 0, estado = 'PENDIENTE' WHERE estado = 'FALLIDO' OR intentos >= 10").run();
        return { exito: true, reactivados: res.changes };
    } catch (e) {
        return { exito: false, error: e.message };
    }
});







// 2. El motor borra un registro porque el VPS confirmÃ³ que lo recibiÃ³



// ⏸️ COLA EN MEMORIA DE STOCK EN STANDBY (bloqueado mientras existan pendientes en sync_queue)



const colaStandbyStock = new Map();







function extraerDeltasDeRegistroCola(registro) {



    const deltas = [];



    if (!registro || !registro.datos) return deltas;



    try {



        const datos = typeof registro.datos === 'string' ? JSON.parse(registro.datos) : registro.datos;



        const sucGeneral = datos.sucursal_id || datos.sucursalId || null;



        if (registro.tabla === 'ventas_descuento_vps') {



            const items = Array.isArray(datos.items) ? datos.items : [];



            for (const it of items) {



                const pId = it.id || it.producto_id || it.producto_ID;



                const cant = Math.abs(parseFloat(it.cantidad) || 0);



                if (pId && cant > 0) {



                    deltas.push({ productoId: String(pId), sucursalId: sucGeneral, delta: -cant });



                }



            }



        } else if (registro.tabla === 'movimientos_stock') {



            if (Array.isArray(datos.items)) {



                for (const it of datos.items) {



                    const pId = it.id || it.producto_id || it.producto_ID;



                    const cant = Math.abs(parseFloat(it.cantidad) || 0);



                    const op = String(it.operacion || datos.operacion || 'SUMAR').toUpperCase();



                    if (pId && cant > 0) {



                        deltas.push({



                            productoId: String(pId),



                            sucursalId: it.sucursal_id || it.sucursalId || sucGeneral,



                            delta: op === 'RESTAR' ? -cant : cant



                        });



                    }



                }



            } else {



                const pId = datos.producto_id || datos.id || datos.productoId;



                const cant = Math.abs(parseFloat(datos.cantidad) || 0);



                const op = String(datos.operacion || 'SUMAR').toUpperCase();



                if (pId && cant > 0) {



                    deltas.push({



                        productoId: String(pId),



                        sucursalId: sucGeneral,



                        delta: op === 'RESTAR' ? -cant : cant



                    });



                }



            }



        }



    } catch (e) {}



    return deltas;



}







function tieneMovimientosPendientesEnCola(productoId, sucursalId) {



    if (!db || !productoId) return false;



    try {



        const filas = db.prepare(`



            SELECT id, tabla, datos FROM sync_queue 



            WHERE tabla IN ('ventas_descuento_vps', 'movimientos_stock') 



            AND datos LIKE ?



        `).all(`%${productoId}%`);



        for (const f of filas) {



            const deltas = extraerDeltasDeRegistroCola(f);



            for (const d of deltas) {



                if (d.productoId === String(productoId) && (!sucursalId || !d.sucursalId || String(d.sucursalId) === String(sucursalId))) {



                    return true;



                }



            }



        }



    } catch (e) {}



    return false;



}







function aplicarStockStandbyEnMaestro(entry) {



    if (!config.isServer || !masterDbDirect || !entry) return false;



    try {



        const { productoId, sucursalId, companyId, cantidadEnStandby, datosStock } = entry;



        let stockPrevio = 0;



        const rowStock = masterDbDirect.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ? AND sucursal_id = ?').get(productoId, sucursalId);



        if (rowStock) stockPrevio = parseFloat(rowStock.cantidad_real || 0);







        const cantFinal = parseFloat(cantidadEnStandby) || 0;



        if (rowStock && Math.abs(cantFinal - stockPrevio) < 0.0001) {



            masterDbDirect.prepare(`UPDATE stock_maestro SET ultima_sincronizacion = datetime('now', '-4 hours') WHERE producto_id = ? AND sucursal_id = ?`).run(productoId, sucursalId);



            console.log(`▶️ [STANDBY STOCK] Pendientes subidos para ${productoId} (${sucursalId}). Stock confirmado sin diferencia (${cantFinal}).`);



            return false;



        }







        masterDbDirect.prepare(`



            INSERT INTO stock_maestro (producto_id, sucursal_id, company_id, cantidad_real, ultima_sincronizacion)



            VALUES (?, ?, ?, ?, datetime('now', '-4 hours'))



            ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET



            cantidad_real = excluded.cantidad_real,



            ultima_sincronizacion = datetime('now', '-4 hours')



        `).run(productoId, sucursalId, companyId, cantFinal);







        const diferencia = cantFinal - stockPrevio;



        if (Math.abs(diferencia) > 0.0001) {



            const tipoMov = diferencia >= 0 ? 'AJUSTE_POSITIVO' : 'AJUSTE_NEGATIVO';



            const refMov = datosStock && (datosStock.referencia_id || datosStock.referenciaId) ? String(datosStock.referencia_id || datosStock.referenciaId) : 'STANDBY_SYNC_VPS';



            try {



                masterDbDirect.prepare(`INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento, referencia_id, estado_sync) VALUES (?, ?, ?, ?, ?, ?, 1)`)



                    .run(companyId, sucursalId, productoId, diferencia, tipoMov, refMov);



            } catch (eK) {}



        }







        console.log(`▶️ [STANDBY STOCK APLICADO] Pendientes subidos para ${productoId} (${sucursalId}). Stock actualizado de ${stockPrevio} a ${cantFinal}.`);



        notificarStockActualizado();



        return true;



    } catch (e) {



        console.error("⚠️ Error aplicando stock desde standby:", e.message);



        return false;



    }



}







ipcMain.handle('eliminar-de-cola', async (event, id, opciones) => {



    try {



        const regPrevio = db.prepare('SELECT * FROM sync_queue WHERE id = ?').get(id);



        const stmt = db.prepare('DELETE FROM sync_queue WHERE id = ?');



        const resultado = stmt.run(id);







        if (regPrevio && colaStandbyStock.size > 0) {



            const fueSubidoAlVps = !(opciones && opciones.omitidoSinSubir);



            if (fueSubidoAlVps) {



                const deltasSubidos = extraerDeltasDeRegistroCola(regPrevio);



                for (const d of deltasSubidos) {



                    for (const [, entry] of colaStandbyStock.entries()) {



                        if (entry.productoId === d.productoId && (!d.sucursalId || !entry.sucursalId || String(entry.sucursalId) === String(d.sucursalId))) {



                            entry.cantidadEnStandby = (parseFloat(entry.cantidadEnStandby) || 0) + d.delta;



                        }



                    }



                }



            }







            // Verificar cuáles productos en standby ya tienen todos sus pendientes subidos



            for (const [keyStandby, entry] of Array.from(colaStandbyStock.entries())) {



                if (!tieneMovimientosPendientesEnCola(entry.productoId, entry.sucursalId)) {



                    colaStandbyStock.delete(keyStandby);



                    aplicarStockStandbyEnMaestro(entry);



                }



            }



        }







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



        



        const jsonParaGuardar = typeof p.datos_json === 'string' ? p.datos_json : JSON.stringify(p);



        const estadoSyncFinal = p.estado_sync !== undefined ? p.estado_sync : 0; 







        const local = db.prepare('SELECT * FROM productos_locales WHERE id = ?').get(idProducto);



        let resultado = { changes: 0 };



        let cambioRealCatalogo = false;







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



            cambioRealCatalogo = true;



        } else if (haCambiadoProductoEnBD(local, p, barcodeRef, precioRef, compraRef, porcentajeRef)) {



            const stmt = db.prepare(`



                UPDATE productos_locales



                SET codigo = ?, nombre = ?, precio = ?, precio_compra = ?, porcentaje_ganancia = ?, categoria = ?, status = ?, imagen = ?, datos_json = ?, estado_sync = ?, fecha_modificacion = ?



                WHERE id = ?



            `);



            resultado = stmt.run(



                barcodeRef, p.nombre, precioRef, compraRef, porcentajeRef, 



                p.categoria, p.status, p.imagen, jsonParaGuardar, 



                estadoSyncFinal, p.fecha_modificacion || local.fecha_modificacion, idProducto



            );



            cambioRealCatalogo = true;



        } else if (Number(local.estado_sync) !== Number(estadoSyncFinal)) {



            db.prepare('UPDATE productos_locales SET estado_sync = ? WHERE id = ?').run(estadoSyncFinal, idProducto);



        }







        if (cambioRealCatalogo && resultado && resultado.changes > 0 && !p.silencioso) {



            notificarProductosActualizados(true);



        }







        return { ...resultado, changed: cambioRealCatalogo };



    } catch (e) {



        console.error("❌ Error en sincronizar-producto-servidor:", e);



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







let cacheActualizacionGithub = null;



const CACHE_TTL_GITHUB = 5 * 60 * 1000; // 5 minutos de caché para respuesta en tiempo real







// --- VERIFICADOR DE ACTUALIZACIONES (MICROSERVICIO + FALLBACK GITHUB) ---



ipcMain.handle('verificar-actualizacion-github', async (event, versionActual, forzarBusqueda = false) => {



    try {



        const vLimpia = String(versionActual || '').replace(/^v/i, '').trim();







        if (!forzarBusqueda && cacheActualizacionGithub) {



            const ahora = Date.now();



            if (ahora - cacheActualizacionGithub.timestamp < CACHE_TTL_GITHUB && cacheActualizacionGithub.versionActual === vLimpia) {



                console.log("📡 [NEXUS UPDATES] Retornando actualización desde caché local.");



                return cacheActualizacionGithub.resultado;



            }



        }







        // 1. Consulta prioritaria al Microservicio de Actualizaciones (api.nexusposgobal.com)



        const updateApiUrl = `https://api.nexusposgobal.com/api/check-update/nexus-pos?current_version=${encodeURIComponent(vLimpia || '1.0.0')}`;



        



        try {



            const responseApi = await axios.get(updateApiUrl, {



                timeout: 7000,



                headers: { 



                    'Accept': 'application/json',



                    'User-Agent': 'Nexus-POS-Global-Desktop' 



                }



            });







            if (responseApi.data && responseApi.data.success) {



                const info = responseApi.data;



                const hayActualizacion = info.has_update === true;







                const resultado = {



                    success: true,



                    hayActualizacion: hayActualizacion,



                    nuevaVersion: info.latest_version ? (String(info.latest_version).startsWith('v') ? info.latest_version : `v${info.latest_version}`) : '',



                    notas: info.release_notes || "Actualización oficial de Nexus POS Global con mejoras de rendimiento y estabilidad.",



                    urlDescarga: info.download_url || "",



                    nombreArchivo: info.file_name || "",



                    tamanioMb: info.file_size_mb || null,



                    publicadoEl: info.published_at || null



                };







                cacheActualizacionGithub = {



                    timestamp: Date.now(),



                    versionActual: vLimpia,



                    resultado: resultado



                };







                console.log(`✅ [NEXUS UPDATES] Microservicio respondió: Hay update = ${hayActualizacion}, Última versión = ${resultado.nuevaVersion} (${resultado.tamanioMb || 0} MB)`);



                return resultado;



            }



        } catch (apiErr) {



            console.warn("⚠️ [NEXUS UPDATES] Microservicio api.nexusposgobal.com no disponible, intentando GitHub directo:", apiErr.message);



        }







        // 2. Fallback de contingencia: Consulta directa a GitHub API si el microservicio no estuviese disponible



        const repo = "memm1701-tech/NEXUS-POS-ELECTRON";



        const url = `https://api.github.com/repos/${repo}/releases`;



        



        const config = {



            timeout: 10000,



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







        let actualizacionEncontrada = null;



        for (const release of response.data) {



            if (esVersionMayor(release.tag_name, vLimpia)) {



                actualizacionEncontrada = release;



                break;



            }



        }







        let resultado = null;



        if (actualizacionEncontrada) {



            const urlDescargaFichero = (actualizacionEncontrada.assets && actualizacionEncontrada.assets.length > 0) 



                                        ? actualizacionEncontrada.assets[0].browser_download_url 



                                        : "";







            resultado = {



                success: true,



                hayActualizacion: true,



                nuevaVersion: actualizacionEncontrada.tag_name,



                notas: actualizacionEncontrada.body || "Sin notas de actualización.",



                urlDescarga: urlDescargaFichero



            };



        } else {



            resultado = {



                success: true,



                hayActualizacion: false



            };



        }







        if (resultado.success) {



            cacheActualizacionGithub = {



                timestamp: Date.now(),



                versionActual: vLimpia,



                resultado: resultado



            };



        }







        return resultado;







    } catch (error) {



        console.error("❌ Error en Verificación de Actualizaciones:", error.response?.status || error.message);



        return { 



            success: false, 



            error: error.response?.status === 404 ? "Repositorio o servicio no encontrado" : (error.response?.status === 403 ? "Límite de API excedido o Token inválido" : error.message) 



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



                        const appDataPath = app.getPath('userData');



                        const exePath = app.getPath('exe');



                        const exeName = path.basename(exePath);



                        const safeAppDataPath = appDataPath.replace(/"/g, '""');



                        const safeExePath = exePath.replace(/"/g, '""');



                        const safeFilePath = filePath.replace(/"/g, '""');



                        const safeExeName = exeName.replace(/"/g, '""');







                        const vbsPath = path.join(tempDir, 'run_nexus_update.vbs');



                        const vbsContent = [



                            'Option Explicit',



                            'Dim sh, fso, wmi, procs, installerCmd, targetExe, exeName, appData',



                            '',



                            'Set sh = CreateObject("WScript.Shell")',



                            'Set fso = CreateObject("Scripting.FileSystemObject")',



                            '',



                            `exeName = "${safeExeName}"`,



                            `targetExe = "${safeExePath}"`,



                            `appData = "${safeAppDataPath}"`,



                            '',



                            '\' 1. Contar 3 segundos para garantizar que el proceso actual de Electron se cierre completamente',



                            'WScript.Sleep 3000',



                            '',



                            '\' 2. Forzar terminacion silenciosa de cualquier proceso remanente',



                            'On Error Resume Next',



                            'sh.Run "taskkill /F /IM """ & exeName & """ /T", 0, True',



                            'On Error GoTo 0',



                            '',



                            '\' 3. Limpiar carpetas de cache previas',



                            'On Error Resume Next',



                            'If fso.FolderExists(appData & "\\Cache") Then fso.DeleteFolder appData & "\\Cache", True',



                            'If fso.FolderExists(appData & "\\Code Cache") Then fso.DeleteFolder appData & "\\Code Cache", True',



                            'If fso.FolderExists(appData & "\\GPUCache") Then fso.DeleteFolder appData & "\\GPUCache", True',



                            'On Error GoTo 0',



                            '',



                            '\' 4. Ejecutar el instalador de forma 100% silenciosa y oculta (sin ventana de consola) y esperar finalizacion',



                            `installerCmd = """${safeFilePath}"" /S"`,



                            'sh.Run installerCmd, 0, True',



                            '',



                            '\' 5. Contar 3 segundos para que los archivos se asienten tras la instalacion',



                            'WScript.Sleep 3000',



                            '',



                            '\' 6. Verificar si ya fue iniciado por el sistema. Si no esta corriendo, abrirlo una sola vez',



                            'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',



                            'Set procs = wmi.ExecQuery("Select * from Win32_Process Where Name = \'" & exeName & "\'")',



                            '',



                            'If procs.Count = 0 Then',



                            '    If fso.FileExists(targetExe) Then',



                            '        sh.Run """" & targetExe & """", 1, False',



                            '    End If',



                            'End If'



                        ].join('\r\n');







                        fs.writeFileSync(vbsPath, vbsContent, 'utf8');







                        // Ejecutar mediante wscript.exe (subsistema GUI de Windows): NO abre ninguna ventana de consola negra



                        const updater = spawn('wscript.exe', ['//B', '//NoLogo', vbsPath], {



                            detached: true,



                            stdio: 'ignore',



                            windowsHide: true



                        });



                        updater.unref();







                        // Autorizar el cierre inmediato de las ventanas y del servidor hijo para liberar archivos



                        cierreAutorizado = true;



                        try {



                            if (typeof cerebroProcess !== 'undefined' && cerebroProcess) {



                                cerebroProcess.kill();



                            }



                        } catch (eKill) {}







                        try {



                            const allWins = BrowserWindow.getAllWindows();



                            allWins.forEach(w => {



                                w.removeAllListeners('close');



                                w.destroy();



                            });



                        } catch (eWin) {}







                        setTimeout(() => {



                            app.quit();



                            setTimeout(() => app.exit(0), 400);



                        }, 300);



                        



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



            db.prepare('UPDATE productos_locales SET estado_sync = 1 WHERE id = ? AND estado_sync != 1').run(idElemento);



        } else if (tabla === 'categorias') {



            db.prepare('UPDATE categorias_locales SET estado_sync = 1 WHERE id = ? AND estado_sync != 1').run(idElemento);



        } else if (tabla === 'movimientos_stock') {



            try { db.prepare('UPDATE salidas_inventario SET estado_sync = 1 WHERE product_id = ? AND estado_sync = 0').run(idElemento); } catch(e) {}



            try { if (masterDbDirect) masterDbDirect.prepare('UPDATE movimientos_stock_maestro SET estado_sync = 1 WHERE producto_id = ? AND estado_sync = 0').run(idElemento); } catch(e) {}



        } else if (tabla === 'unidades_empaque' || tabla === 'empaques') {



            db.prepare('UPDATE unidades_empaque SET estado_sync = 1 WHERE id = ? AND estado_sync != 1').run(idElemento);



        }



        return { success: true };



    } catch (e) {



        console.error("❌ Error al marcar como sincronizado:", e.message);



        return { error: e.message };



    }



});







ipcMain.handle('obtener-categorias-local', async (event, empresaId) => {



    try {



        if (!config.isServer) {



            const ipMaestro = getIpMaestro();



            if (ipMaestro) {



                const url = `http://${ipMaestro}:3000/api/maestro/categorias-local?empresaId=${encodeURIComponent(empresaId || '')}`;



                const reqFetch = await fetch(url, { signal: AbortSignal.timeout(6000) });



                if (reqFetch.ok) {



                    const data = await reqFetch.json();



                    if (Array.isArray(data)) return data;



                }



            }



        }



        let stmt;



        if (empresaId) {



            stmt = db.prepare('SELECT * FROM categorias_locales WHERE company_id = ? ORDER BY nombre ASC');



            return stmt.all(empresaId);



        }



        stmt = db.prepare('SELECT * FROM categorias_locales ORDER BY nombre ASC');



        return stmt.all();



    } catch (e) {



        console.error("Error al obtener categorías locales:", e);



        return [];



    }



});







ipcMain.handle('sincronizar-categoria-servidor', async (event, cat) => {



    try {



        const check = db.prepare('SELECT nombre, fecha_modificacion FROM categorias_locales WHERE id = ?').get(cat.id);



        



        if (!check) {



            const insert = db.prepare(`



                INSERT INTO categorias_locales (id, company_id, nombre, estado_sync, fecha_modificacion)



                VALUES (?, ?, ?, 1, ?)



            `);



            return insert.run(cat.id, cat.company_id, cat.nombre, cat.fecha_modificacion);



        } else if (String(check.nombre || '') !== String(cat.nombre || '')) {



            const fechaServidor = new Date(cat.fecha_modificacion).getTime() || 0;



            const fechaLocal = (check.fecha_modificacion ? new Date(check.fecha_modificacion).getTime() : 0) || 0;



            



            if (isNaN(fechaLocal) || fechaServidor >= fechaLocal) {



                const update = db.prepare(`



                    UPDATE categorias_locales 



                    SET nombre = ?, company_id = ?, fecha_modificacion = ?, estado_sync = 1



                    WHERE id = ?



                `);



                return update.run(cat.nombre, cat.company_id, cat.fecha_modificacion, cat.id);



            }



        }



        return { skipping: true, changes: 0 };



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



        console.error("Error al eliminar categorÃ­a local:", e);



        return { error: e.message };



    }



});











// ==========================================



// MÃ“DULO EMPLEADOS (SQLITE LOCAL)



// ==========================================







ipcMain.handle('guardar-empleado-local', async (event, emp) => {



    try {



        const targetDb = getDbForEntity();



        const compId = emp.company_id || getActiveCompanyId();



        const sueldo = parseFloat(emp.sueldo_base) || 0;







        const stmt = targetDb.prepare(`



            INSERT INTO empleados (



                ID_empleado, company_id, nombre, cedula, cargo, sueldo_base, telefono, sucursal, status, estado_sync



            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)



            ON CONFLICT(ID_empleado) DO UPDATE SET



                nombre = excluded.nombre,



                cedula = excluded.cedula,



                cargo = excluded.cargo,



                sueldo_base = excluded.sueldo_base,



                telefono = excluded.telefono,



                sucursal = excluded.sucursal,



                status = 1,



                company_id = COALESCE(excluded.company_id, empleados.company_id),



                estado_sync = 0



        `);



        



        stmt.run(



            emp.ID_empleado,



            compId,



            emp.nombre,



            emp.cedula || '',



            emp.cargo || '',



            sueldo,



            emp.telefono || '',



            emp.sucursal || '',



            1,



            0 



        );







        if (targetDb !== db) {



            try {



                db.prepare(`



                    INSERT INTO empleados (



                        ID_empleado, company_id, nombre, cedula, cargo, sueldo_base, telefono, sucursal, status, estado_sync



                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)



                    ON CONFLICT(ID_empleado) DO UPDATE SET



                        nombre = excluded.nombre,



                        cedula = excluded.cedula,



                        cargo = excluded.cargo,



                        sueldo_base = excluded.sueldo_base,



                        telefono = excluded.telefono,



                        sucursal = excluded.sucursal,



                        status = 1,



                        company_id = COALESCE(excluded.company_id, empleados.company_id),



                        estado_sync = 0



                `).run(



                    emp.ID_empleado, compId, emp.nombre, emp.cedula || '', emp.cargo || '',



                    sueldo, emp.telefono || '', emp.sucursal || '', 1, 0



                );



            } catch (_) {}



        }







        if (!config.isServer) {



            try {



                await llamarMaestro('POST', '/api/maestro/empleados/guardar', { ...emp, sueldo_base: sueldo, company_id: compId });



            } catch (eLan) {



                console.warn("⚠️ [EMPLEADOS LAN] No se pudo guardar en Maestro LAN:", eLan.message);



            }



        }







        sincronizarEmpleadosConVps(compId).catch(() => {});







        return { success: true };



    } catch (error) {



        console.error("Error al guardar empleado:", error);



        return { error: error.message };



    }



});







ipcMain.handle('guardar-proveedor-local', async (event, prov) => {



    try {



        const targetDb = getDbForEntity();



        const compId = prov.company_id || getActiveCompanyId();



        



        const stmt = targetDb.prepare(`



            INSERT INTO proveedores (rif, company_id, nombre, telefono, contacto, direccion, status, estado_sync)



            VALUES (?, ?, ?, ?, ?, ?, 1, 0)



            ON CONFLICT(rif) DO UPDATE SET



                nombre = excluded.nombre,



                telefono = excluded.telefono,



                contacto = excluded.contacto,



                direccion = excluded.direccion,



                status = 1,



                company_id = COALESCE(excluded.company_id, proveedores.company_id),



                estado_sync = 0



        `);



        



        stmt.run(prov.rif, compId, prov.nombre, prov.telefono || '', prov.contacto || '', prov.direccion || '');







        if (targetDb !== db) {



            try {



                db.prepare(`



                    INSERT INTO proveedores (rif, company_id, nombre, telefono, contacto, direccion, status, estado_sync)



                    VALUES (?, ?, ?, ?, ?, ?, 1, 0)



                    ON CONFLICT(rif) DO UPDATE SET



                        nombre = excluded.nombre, telefono = excluded.telefono, contacto = excluded.contacto,



                        direccion = excluded.direccion, status = 1,



                        company_id = COALESCE(excluded.company_id, proveedores.company_id), estado_sync = 0



                `).run(prov.rif, compId, prov.nombre, prov.telefono || '', prov.contacto || '', prov.direccion || '');



            } catch (_) {}



        }







        if (!config.isServer) {



            try {



                await llamarMaestro('POST', '/api/maestro/proveedores/guardar', { ...prov, company_id: compId });



            } catch (eLan) {



                console.warn("⚠️ [PROVEEDOR LAN] No se pudo guardar en Maestro LAN:", eLan.message);



            }



        }







        sincronizarCuentasPagarConVps(compId).catch(() => {});







        return { success: true };



    } catch (error) {



        console.error("Error guardando proveedor:", error);



        return { success: false, error: error.message };



    }



});







ipcMain.handle('obtener-proveedores-local', async () => {



    try {



        const targetDb = getDbForEntity();



        return targetDb.prepare('SELECT * FROM proveedores WHERE status != -1 OR status IS NULL ORDER BY nombre ASC').all();



    } catch (error) {



        console.error("Error obteniendo proveedores:", error);



        return [];



    }



});







ipcMain.handle('eliminar-proveedor-local', async (event, rif) => {



    try {



        const targetDb = getDbForEntity();



        targetDb.prepare('UPDATE proveedores SET status = -1, estado_sync = 0 WHERE rif = ?').run(rif);



        if (targetDb !== db) {



            try { db.prepare('UPDATE proveedores SET status = -1, estado_sync = 0 WHERE rif = ?').run(rif); } catch (_) {}



        }







        if (!config.isServer) {



            try {



                await llamarMaestro('DELETE', `/api/maestro/proveedores/${encodeURIComponent(rif)}`);



            } catch (eLan) {



                console.warn("⚠️ [ELIMINAR PROV LAN]:", eLan.message);



            }



        }







        sincronizarCuentasPagarConVps().catch(() => {});







        return { success: true };



    } catch (error) {



        console.error("Error eliminando proveedor:", error);



        return { success: false, error: error.message };



    }



});







ipcMain.handle('guardar-movimiento-cxp-local', async (event, mov) => {



    try {



        const targetDb = getDbForEntity();



        const compId = mov.company_id || getActiveCompanyId();



        const horaMov = mov.fecha || getCaracasTime();



        const montoNum = parseFloat(mov.monto) || 0;







        targetDb.transaction(() => {
            // 1. Insertar movimiento (FACTURA)
            const stmtMov = targetDb.prepare(`
                INSERT INTO movimientos_cuentas_pagar 
                (id, proveedor_rif, motivo, nota, monto, company_id, comprobante, estado, monto_abonado, fecha, estado_sync, contenido_fac)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `);

            const motivoReal = (mov.motivo || '').toUpperCase() === 'COMPRA' ? 'FACTURA' : (mov.motivo || 'FACTURA').toUpperCase();
            const estadoReal = mov.estado || 'PENDIENTE';
            const abonadoReal = parseFloat(mov.monto_abonado) || 0;
            const contenidoFacStr = mov.contenido_fac ? (typeof mov.contenido_fac === 'string' ? mov.contenido_fac : JSON.stringify(mov.contenido_fac)) : null;

            stmtMov.run(
                mov.id,
                mov.proveedor_rif,
                motivoReal,
                mov.nota || '',
                montoNum,
                compId,
                mov.comprobante || mov.id,
                estadoReal,
                abonadoReal,
                horaMov,
                contenidoFacStr
            );

            // 2. Actualizar saldo_deuda en proveedores solo si la factura queda PENDIENTE
            if (estadoReal !== 'PAGADO' && estadoReal !== 'PAGADA') {
                const deudaAAgregar = montoNum - abonadoReal;
                if (deudaAAgregar > 0) {
                    const stmtUpdate = targetDb.prepare(`
                        UPDATE proveedores 
                        SET saldo_deuda = COALESCE(saldo_deuda, 0) + (?), estado_sync = 0
                        WHERE rif = ?
                    `);
                    stmtUpdate.run(deudaAAgregar, mov.proveedor_rif);
                }
            }
        })();







        if (!config.isServer) {



            try {



                await llamarMaestro('POST', '/api/maestro/cuentas-pagar/movimiento', { ...mov, monto: montoNum, fecha: horaMov, company_id: compId });



            } catch (eLan) {



                console.warn("⚠️ [MOV CXP LAN] No se pudo guardar en Maestro LAN:", eLan.message);



            }



        }







        sincronizarCuentasPagarConVps(compId).catch(() => {});







        return { success: true };



    } catch (err) {



        console.error("[MAIN] Error guardando factura CXP:", err);



        return { success: false, error: err.message };



    }



});







ipcMain.handle('registrar-abono-cxp-local', async (event, pago) => {



    try {



        const targetDb = getDbForEntity();



        const compId = pago.company_id || getActiveCompanyId();



        const horaPago = pago.fecha || getCaracasTime();



        const montoPago = parseFloat(pago.monto) || 0;







        targetDb.transaction(() => {



            // 1. Obtener la factura de destino



            const factura = targetDb.prepare("SELECT * FROM movimientos_cuentas_pagar WHERE id = ?").get(pago.factura_id);



            if (!factura) throw new Error("Factura no encontrada");







            // 2. Insertar el movimiento del pago con estado_sync = 0



            const pagoId = 'PAGO-' + Date.now();



            const stmtMov = targetDb.prepare(`



                INSERT INTO movimientos_cuentas_pagar 



                (id, proveedor_rif, motivo, nota, monto, company_id, comprobante, estado, metodo_pago, referencia, fecha, estado_sync)



                VALUES (?, ?, 'PAGO', ?, ?, ?, ?, 'PAGADO', ?, ?, ?, 0)



            `);



            stmtMov.run(pagoId, factura.proveedor_rif, pago.nota || 'Abono a factura ' + factura.comprobante, montoPago, factura.company_id || compId, factura.comprobante, pago.metodo_pago || '', pago.referencia || '', horaPago);







            // 3. Actualizar la factura destino (monto abonado y estado) y estado_sync = 0



            const nuevoAbonado = (factura.monto_abonado || 0) + montoPago;



            let nuevoEstado = 'ABONADO';



            if (nuevoAbonado >= (factura.monto - 0.01)) {



                nuevoEstado = 'PAGADO';



            }







            const stmtFactura = targetDb.prepare(`



                UPDATE movimientos_cuentas_pagar 



                SET monto_abonado = ?, estado = ?, estado_sync = 0



                WHERE id = ?



            `);



            stmtFactura.run(nuevoAbonado, nuevoEstado, pago.factura_id);







            // 4. Actualizar saldo global del proveedor (Disminuye deuda) y estado_sync = 0



            const stmtProv = targetDb.prepare(`



                UPDATE proveedores 



                SET saldo_deuda = MAX(0, COALESCE(saldo_deuda, 0) - ?), estado_sync = 0



                WHERE rif = ?



            `);



            stmtProv.run(montoPago, factura.proveedor_rif);



        })();







        if (!config.isServer) {



            try {



                await llamarMaestro('POST', '/api/maestro/cuentas-pagar/abono', { ...pago, monto: montoPago, fecha: horaPago, company_id: compId });



            } catch (eLan) {



                console.warn("⚠️ [ABONO CXP LAN] No se pudo guardar en Maestro LAN:", eLan.message);



            }



        }







        sincronizarCuentasPagarConVps(compId).catch(() => {});







        return { exito: true };



    } catch (err) {



        console.error("[MAIN] Error registrando abono CXP:", err);



        return { exito: false, mensaje: err.message };



    }



});







ipcMain.handle('obtener-movimientos-cxp-local', async () => {



    try {



        const targetDb = getDbForEntity();



        return targetDb.prepare(`



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



        const targetDb = getDbForEntity();



        const row = targetDb.prepare('SELECT SUM(saldo_deuda) as total FROM proveedores WHERE status != -1 OR status IS NULL').get();



        return { total_deuda: row && row.total ? row.total : 0 };



    } catch (err) {



        console.error("Error obteniendo resumen CXP:", err);



        return { total_deuda: 0 };



    }



});







ipcMain.handle('obtener-empleados-local', async () => {



    try {



        const targetDb = getDbForEntity();



        const stmt = targetDb.prepare('SELECT * FROM empleados WHERE status != -1 OR status IS NULL ORDER BY nombre ASC');



        return stmt.all();



    } catch (error) {



        console.error("Error al obtener empleados:", error);



        return [];



    }



});







ipcMain.handle('eliminar-empleado-local', async (event, id) => {



    try {



        const targetDb = getDbForEntity();



        const stmt = targetDb.prepare('UPDATE empleados SET status = -1, estado_sync = 0 WHERE ID_empleado = ?');



        stmt.run(id);







        if (targetDb !== db) {



            try { db.prepare('UPDATE empleados SET status = -1, estado_sync = 0 WHERE ID_empleado = ?').run(id); } catch (_) {}



        }







        if (!config.isServer) {



            try {



                await llamarMaestro('DELETE', `/api/maestro/empleados/${encodeURIComponent(id)}`);



            } catch (eLan) {



                console.warn("⚠️ [ELIMINAR EMPLEADO LAN]:", eLan.message);



            }



        }







        sincronizarEmpleadosConVps().catch(() => {});







        return { success: true };



    } catch (error) {



        console.error("Error al eliminar empleado:", error);



        return { error: error.message };



    }



});







ipcMain.handle('guardar-movimiento-empleado-local', async (event, mov) => {



    try {



        const targetDb = getDbForEntity();



        const compId = mov.company_id || getActiveCompanyId();



        const horaMov = mov.fecha || getCaracasTime();



        const montoNum = parseFloat(mov.monto) || 0;







        targetDb.transaction(() => {



            // Insertar el movimiento



            const stmt = targetDb.prepare(`



                INSERT INTO empleados_movimientos (



                    id, empleado_id, motivo, razon, monto, company_id, fecha, estado_sync



                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)



            `);



            



            stmt.run(



                mov.id,



                mov.empleado_id,



                mov.motivo,



                mov.razon || '',



                montoNum,



                compId,



                horaMov



            );







            // Actualizar el saldo del empleado y marcar estado_sync = 0



            let updateSql = '';



            if (mov.motivo === 'Ingreso') {



                updateSql = 'UPDATE empleados SET saldo_pendiente = saldo_pendiente + ?, estado_sync = 0 WHERE ID_empleado = ?';



            } else if (mov.motivo === 'Egreso') {



                updateSql = 'UPDATE empleados SET saldo_pendiente = saldo_pendiente - ?, estado_sync = 0 WHERE ID_empleado = ?';



            }







            if (updateSql) {



                targetDb.prepare(updateSql).run(montoNum, mov.empleado_id);



                if (targetDb !== db) {



                    try { db.prepare(updateSql).run(montoNum, mov.empleado_id); } catch (_) {}



                }



            }



        })();







        if (!config.isServer) {



            try {



                await llamarMaestro('POST', '/api/maestro/empleados/movimiento', { ...mov, monto: montoNum, fecha: horaMov, company_id: compId });



            } catch (eLan) {



                console.warn("⚠️ [MOV EMPLEADO LAN] No se pudo guardar en Maestro LAN:", eLan.message);



            }



        }







        sincronizarEmpleadosConVps(compId).catch(() => {});







        return { success: true };



    } catch (error) {



        console.error("Error al guardar movimiento de empleado:", error);



        return { error: error.message };



    }



});







ipcMain.handle('obtener-movimientos-empleado-local', async (event, empId) => {



    try {



        const targetDb = getDbForEntity();



        const stmt = targetDb.prepare('SELECT * FROM empleados_movimientos WHERE empleado_id = ? ORDER BY fecha DESC');



        return stmt.all(empId);



    } catch (error) {



        console.error("Error al obtener movimientos de empleados:", error);



        return [];



    }



});











ipcMain.handle('guardar-sucursal-local', async (event, sucursal) => {



    try {



        // CORRECCIÃ“N: Respetar la fecha y el estado de sync si provienen de la nube



        const fechaAUsar = sucursal.fecha_modificacion || getCaracasTime();



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







        const argsSuc = [



            sucursal.id,           // ID Ãºnico de la sucursal



            sucursal.company_id,   // ID de la empresa dueÃ±a



            sucursal.nombre,



            sucursal.direccion,



            sucursal.telefono,



            estadoSync,            // Usar el estado dinÃ¡mico (0 o 1)



            fechaAUsar             // Usar la fecha correcta



        ];



        const resultadoSuc = stmt.run(...argsSuc);



        // Espejo en la DB maestra (el maestro LAN y la lectura en modo servidor usan nexus-local-server.db)



        if (config.isServer && masterDbDirect) {



            try {



                masterDbDirect.prepare(`



                    INSERT INTO sucursales (id, company_id, nombre, direccion, telefono, estado_sync, fecha_modificacion)



                    VALUES (?, ?, ?, ?, ?, ?, ?)



                    ON CONFLICT(id) DO UPDATE SET



                        nombre = excluded.nombre,



                        direccion = excluded.direccion,



                        telefono = excluded.telefono,



                        fecha_modificacion = excluded.fecha_modificacion,



                        estado_sync = excluded.estado_sync



                `).run(...argsSuc);



            } catch (eMirror) {



                console.warn("[SUCURSALES] No se pudo replicar en DB maestra:", eMirror.message);



            }



        }



        return resultadoSuc;



    } catch (e) {



        console.error("â Œ Error al guardar sucursal:", e);



        return { error: e.message };



    }



});







ipcMain.handle('obtener-sucursales-local', async (event, companyId) => {



    try {



        let comp = companyId;



        if (!comp) {



            try {



                const sesion = db.prepare("SELECT valor FROM configuracion WHERE clave = 'sesion_activa'").get();



                if (sesion && sesion.valor) comp = JSON.parse(sesion.valor).companyId;



            } catch(e) {}



        }







        let sucursales = [];



        if (config.isServer && masterDbDirect) {



            try {



                if (comp) {



                    sucursales = masterDbDirect.prepare("SELECT * FROM sucursales WHERE company_id = ?").all(comp);



                } else {



                    sucursales = masterDbDirect.prepare("SELECT * FROM sucursales").all();



                }



            } catch(e) {}



        }



        



        if (!sucursales || sucursales.length === 0) {



            try {



                if (comp) {



                    sucursales = db.prepare("SELECT * FROM sucursales WHERE company_id = ?").all(comp);



                } else {



                    sucursales = db.prepare("SELECT * FROM sucursales").all();



                }



            } catch(e) {}



        }



        



        // Si sigue vacío y es caja hija (isServer = false), intentar consultar al maestro local en LAN



        if ((!sucursales || sucursales.length === 0) && !config.isServer) {



            const ipMaestro = getIpMaestro();



            if (ipMaestro) {



                try {



                    const resp = await axios.get(`http://${ipMaestro}:3000/api/maestro/sucursales/${comp || ''}`, { timeout: 5000 });



                    if (Array.isArray(resp.data) && resp.data.length > 0) {



                        return resp.data;



                    }



                } catch(e) {}



            }



        }







        return Array.isArray(sucursales) ? sucursales : [];



    } catch (e) {



        console.error("❌ Error al obtener sucursales local:", e.message);



        return [];



    }



});











ipcMain.handle('obtener-inventario-sucursal', async (event, { companyId, sucursalId }) => {



    try {



        let comp = companyId;



        if (!comp) {



            try {



                const sesion = db.prepare("SELECT valor FROM configuracion WHERE clave = 'sesion_activa'").get();



                if (sesion && sesion.valor) comp = JSON.parse(sesion.valor).companyId;



            } catch(e) {}



        }







        if (config.isServer) {



            // 🔥 MODO SERVIDOR (isServer = true): Lee directo de la base de datos local / cerebro (localhost)



            if (masterDbDirect) {



                if (sucursalId && sucursalId !== 'undefined' && sucursalId !== 'null') {



                    return masterDbDirect.prepare(`



                        SELECT producto_id, cantidad_real



                        FROM stock_maestro



                        WHERE company_id = ? AND sucursal_id = ?



                    `).all(comp, sucursalId);



                } else {



                    return masterDbDirect.prepare(`



                        SELECT producto_id, SUM(cantidad_real) as cantidad_real



                        FROM stock_maestro



                        WHERE company_id = ?



                        GROUP BY producto_id



                    `).all(comp);



                }



            } else {



                if (sucursalId && sucursalId !== 'undefined' && sucursalId !== 'null') {



                    return db.prepare(`



                        SELECT producto_id, stock as cantidad_real



                        FROM inventario_sucursales



                        WHERE company_id = ? AND sucursal_id = ?



                    `).all(comp, sucursalId);



                } else {



                    return db.prepare(`



                        SELECT producto_id, SUM(stock) as cantidad_real



                        FROM inventario_sucursales



                        WHERE company_id = ?



                        GROUP BY producto_id



                    `).all(comp);



                }



            }



        } else {



            // 🌐 MODO CLIENTE: Petición por red al servidor maestro en LAN con retry



            const endpoint = (sucursalId && sucursalId !== 'undefined' && sucursalId !== 'null')



                ? `/api/maestro/stock?sucursalId=${encodeURIComponent(sucursalId)}&companyId=${encodeURIComponent(comp)}`



                : `/api/maestro/stock?companyId=${encodeURIComponent(comp)}`;



            const respuesta = await llamarMaestro('GET', endpoint, null, { timeout: 8000, reintentos: 2 });



            return Array.isArray(respuesta.data) ? respuesta.data : [];



        }



    } catch (e) {



        console.warn("⚠️ Fallback: Leyendo stock desde inventario_sucursales SQLite...");



        try {



            let comp = companyId;



            if (sucursalId && sucursalId !== 'undefined' && sucursalId !== 'null') {



                const stmt = db.prepare(`



                    SELECT producto_id, stock as cantidad_real



                    FROM inventario_sucursales



                    WHERE company_id = ? AND sucursal_id = ?



                `);



                return stmt.all(comp, sucursalId);



            } else {



                const stmt = db.prepare(`



                    SELECT producto_id, SUM(stock) as cantidad_real



                    FROM inventario_sucursales



                    WHERE company_id = ?



                    GROUP BY producto_id



                `);



                return stmt.all(comp);



            }



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



        const ventaId = Array.isArray(datos) ? null : (datos.ventaId || datos.factura_ref || datos.facturaRef || datos.id);







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



            masterDbDirect.prepare(`CREATE TABLE IF NOT EXISTS movimientos_stock_maestro (



                id INTEGER PRIMARY KEY AUTOINCREMENT,



                company_id TEXT NOT NULL,



                sucursal_id TEXT,



                producto_id TEXT NOT NULL,



                cantidad REAL NOT NULL,



                tipo_movimiento TEXT NOT NULL,



                fecha_movimiento DATETIME DEFAULT (datetime('now', '-4 hours')),



                referencia_id TEXT,



                estado_sync INTEGER DEFAULT 0



            )`).run();



            try { masterDbDirect.prepare("ALTER TABLE movimientos_stock_maestro ADD COLUMN estado_sync INTEGER DEFAULT 0").run(); } catch(e) {}



            try { masterDbDirect.prepare("ALTER TABLE movimientos_stock_maestro ADD COLUMN referencia_id TEXT").run(); } catch(e) {}







            // 🛡️ CANDADO DE IDEMPOTENCIA: Si esta venta ya descontó stock, no descontar de nuevo



            if (ventaId) {



                const yaDescontado = masterDbDirect.prepare(`



                    SELECT id FROM movimientos_stock_maestro 



                    WHERE referencia_id = ? AND tipo_movimiento = 'VENTA' LIMIT 1



                `).get(String(ventaId));



                if (yaDescontado) {



                    console.log(`🛡️ [IDEMPOTENCIA MASTER] Venta ${ventaId} ya tiene stock descontado previamente. Omitiendo segundo descuento.`);



                    return { exito: true, idempotente: true };



                }



            }







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



                const stmtKardex = masterDbDirect.prepare(`INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento, referencia_id, estado_sync) VALUES (?, ?, ?, ?, ?, ?, ?)`);



                



                for (const item of productos) { 



                    // Obtener company_id



                    const rowComp = masterDbDirect.prepare('SELECT company_id FROM stock_maestro WHERE producto_id = ? LIMIT 1').get(item.id);



                    const compId = rowComp ? rowComp.company_id : 'DEFAULT';



                    const sucursalReal = sucursalId || 'GLOBAL';







                    if (sucursalId) {



                        stmtConSucursal.run(item.cantidad, item.id, sucursalId);



                        try { stmtKardex.run(compId, sucursalId, item.id, -Math.abs(item.cantidad), 'VENTA', ventaId ? String(ventaId) : '', 1); } catch(e) {}



                    } else {



                        stmtSinSucursal.run(item.cantidad, item.id);



                        try { stmtKardex.run(compId, 'GLOBAL', item.id, -Math.abs(item.cantidad), 'VENTA', ventaId ? String(ventaId) : '', 1); } catch(e) {}



                    }



                }



            });







            transaccion(productosFisicos); // ✅ Pasamos solo los físicos



            console.log("⚡ Stock descontado directamente en la DB Maestra");



            try {



                BrowserWindow.getAllWindows().forEach(v => {



                    if (!v.isDestroyed()) v.webContents.send('stock-actualizado-global');



                });



            } catch(eWin) {}



            return { exito: true };



        } else {



            // 🌐 MODO CLIENTE: Petición por red al servidor



            const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;



            const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/descontar-stock`, {



                sucursalId: sucursalId,



                factura_ref: ventaId ? String(ventaId) : '',



                items: productosFisicos.map(i => ({ id: i.id, cantidad: i.cantidad, nombre: i.nombre }))



            });



            return respuesta.data;



        }



    } catch (e) {



        return { exito: false, mensaje: e.message || "Error de comunicación con el maestro." };



    }



});











ipcMain.handle('guardar-stock-sucursal', async (event, { productoId, sucursalId, companyId, cantidad, operacion, datosStock }) => {



    try {



        if (config.isServer && masterDbDirect) {



            let stockPrevio = 0;



            const rowStock = masterDbDirect.prepare('SELECT cantidad_real FROM stock_maestro WHERE producto_id = ? AND sucursal_id = ?').get(productoId, sucursalId);



            if (rowStock) stockPrevio = parseFloat(rowStock.cantidad_real || 0);







            let sql = '';



            let valDb = cantidad;



            const opUpper = (operacion || '').toUpperCase();







            // ⏸️ CONTROL DE STANDBY EN DESCARGA DE FONDO DESDE VPS:



            // Si es un FIJAR automático (no manual) y el producto tiene movimientos pendientes por subir en sync_queue,



            // se bloquea la escritura inmediata y queda en STANDBY. En cuanto se suban los pendientes, se aplica automáticamente.



            if (opUpper === 'FIJAR' && !(datosStock && datosStock.manual)) {



                const keyStandby = `${productoId}__${sucursalId || 'GLOBAL'}`;



                if (tieneMovimientosPendientesEnCola(productoId, sucursalId)) {



                    colaStandbyStock.set(keyStandby, {



                        productoId,



                        sucursalId,



                        companyId,



                        cantidadEnStandby: parseFloat(cantidad) || 0,



                        datosStock: datosStock || { estado_sync: 1 },



                        fechaStandby: Date.now()



                    });



                    console.log(`⏸️ [STANDBY STOCK] Escritura bloqueada en standby para ${productoId} (${sucursalId}): esperando subida de pendientes en sync_queue.`);



                    return { success: true, changed: false, standby: true, msg: "En standby: esperando subida de pendientes." };



                } else {



                    colaStandbyStock.delete(keyStandby);



                }



            }







            if (opUpper === 'FIJAR' && rowStock && Math.abs((parseFloat(cantidad) || 0) - stockPrevio) < 0.0001) {



                return { success: true, changed: false, msg: "Stock sin cambios." };



            }







            // 🛡️ CANDADO DE IDEMPOTENCIA POR REFERENCIA (ej. NOTA_CREDITO)



            const refMov = datosStock && (datosStock.referencia_id || datosStock.referenciaId) ? String(datosStock.referencia_id || datosStock.referenciaId) : null;



            if (refMov && opUpper !== 'FIJAR') {



                try {



                    const yaRegistrado = masterDbDirect.prepare(`



                        SELECT id FROM movimientos_stock_maestro 



                        WHERE referencia_id = ? AND producto_id = ? LIMIT 1



                    `).get(refMov, productoId);



                    if (yaRegistrado) {



                        console.log(`🛡️ [IDEMPOTENCIA STOCK] Movimiento con ref ${refMov} para producto ${productoId} ya fue aplicado. Omitiendo duplicado.`);



                        return { success: true, changed: false, idempotente: true, msg: "Movimiento ya aplicado previamente." };



                    }



                } catch (eRefCheck) {}



            }



            



            if (opUpper === 'FIJAR') {



                sql = `INSERT INTO stock_maestro (producto_id, sucursal_id, company_id, cantidad_real, ultima_sincronizacion)



                   VALUES (?, ?, ?, ?, datetime('now', '-4 hours'))



                   ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET



                   cantidad_real = excluded.cantidad_real,



                   ultima_sincronizacion = datetime('now', '-4 hours')`;



            } else if (opUpper === 'RESTAR') {



                valDb = -Math.abs(cantidad);



                sql = `INSERT INTO stock_maestro (producto_id, sucursal_id, company_id, cantidad_real, ultima_sincronizacion)



                   VALUES (?, ?, ?, ?, datetime('now', '-4 hours'))



                   ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET



                   cantidad_real = stock_maestro.cantidad_real + excluded.cantidad_real,



                   ultima_sincronizacion = datetime('now', '-4 hours')`;



            } else { // SUMAR



                valDb = Math.abs(cantidad);



                sql = `INSERT INTO stock_maestro (producto_id, sucursal_id, company_id, cantidad_real, ultima_sincronizacion)



                   VALUES (?, ?, ?, ?, datetime('now', '-4 hours'))



                   ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET



                   cantidad_real = stock_maestro.cantidad_real + excluded.cantidad_real,



                   ultima_sincronizacion = datetime('now', '-4 hours')`;



            }







            masterDbDirect.prepare(sql).run(productoId, sucursalId, companyId, valDb);







            // REGISTRAR MOVIMIENTO KARDEX



            let diferencia = 0;



            let tipoMov = '';



            if (opUpper === 'FIJAR') {



                diferencia = parseFloat(cantidad) - stockPrevio;



                tipoMov = diferencia >= 0 ? 'AJUSTE_POSITIVO' : 'AJUSTE_NEGATIVO';



            } else if (opUpper === 'RESTAR') {



                diferencia = -Math.abs(cantidad);



                tipoMov = (datosStock && datosStock.tipo_movimiento) ? datosStock.tipo_movimiento : 'SALIDA';



            } else {



                diferencia = Math.abs(cantidad);



                tipoMov = (datosStock && datosStock.tipo_movimiento) ? datosStock.tipo_movimiento : 'ENTRADA';



            }







            if (Math.abs(diferencia) > 0.0001) {



                try {



                    masterDbDirect.prepare(`CREATE TABLE IF NOT EXISTS movimientos_stock_maestro (



                        id INTEGER PRIMARY KEY AUTOINCREMENT,



                        company_id TEXT NOT NULL,



                        sucursal_id TEXT,



                        producto_id TEXT NOT NULL,



                        cantidad REAL NOT NULL,



                        tipo_movimiento TEXT NOT NULL,



                        fecha_movimiento DATETIME DEFAULT (datetime('now', '-4 hours')),



                        referencia_id TEXT,



                        estado_sync INTEGER DEFAULT 0



                    )`).run();







                    const estadoSyncParam = opUpper === 'FIJAR' ? 1 : (datosStock && datosStock.estado_sync !== undefined ? datosStock.estado_sync : 0);



                    masterDbDirect.prepare(`INSERT INTO movimientos_stock_maestro (company_id, sucursal_id, producto_id, cantidad, tipo_movimiento, referencia_id, estado_sync) VALUES (?, ?, ?, ?, ?, ?, ?)`)



                            .run(companyId, sucursalId, productoId, diferencia, tipoMov, refMov, estadoSyncParam);



                } catch(e) { console.error("Error guardando movimiento Kardex IPC local:", e.message); }



            }







            notificarStockActualizado();



            return { success: true, changed: true, msg: "Stock de sucursal actualizado correctamente." };



        } else {



            // 🌐 MODO CAJA HIJA / CLIENTE: Enviar actualización al Servidor Maestro por LAN (SUMAR/RESTAR, ej. Notas de Crédito)



            const opUpper = (operacion || '').toUpperCase();



            if (opUpper === 'SUMAR' || opUpper === 'RESTAR') {



                const ipDestino = config.isServer ? '127.0.0.1' : config.serverIP;



                const respuesta = await axios.post(`http://${ipDestino}:${PORT}/api/maestro/inventario/registrar-entrada`, {



                    companyId: companyId,



                    sucursalId: sucursalId,



                    items: [{



                        id: productoId,



                        cantidad: parseFloat(cantidad) || 0,



                        operacion: opUpper



                    }]



                }, { timeout: 6000 });



                return { success: !!(respuesta.data && respuesta.data.exito), changed: true, msg: "Stock actualizado en Maestro vía LAN." };



            }



            return { success: true, changed: false, msg: "Modo cliente: lectura directa del Maestro." };



        }



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



            



            const comandoS3 = Buffer.from("S3", "latin1");



            const lrcS3 = calcularLRC(comandoS3, ETX);



            const tramaS3 = Buffer.concat([STX, comandoS3, ETX, Buffer.from([lrcS3])]);



            



            const comandoS5 = Buffer.from("S5", "latin1");



            const lrcS5 = calcularLRC(comandoS5, ETX);



            const tramaS5 = Buffer.concat([STX, comandoS5, ETX, Buffer.from([lrcS5])]);



            



            let bufferRecepcion = "";



            let estado = 'ENQ'; // 'ENQ', 'S1', 'S3', 'S5'



            let reintentoENQHecho = false;



            let timeoutConsultas;



            



            let datosS1 = { serial: "DESC", nroFac: "S/N", flag21: "No detectado" };



            let rawS3Content = "";



            let rawS5Content = "";







            port.on("data", (data) => {



                bufferRecepcion += data.toString("latin1");



                



                if (data.includes(0x15)) {



                    if (estado === 'ENQ' && !reintentoENQHecho) {



                        console.log("[FISCAL] NAK inicial en estado-fiscal. Auto-reintentando ENQ tras 200ms...");



                        reintentoENQHecho = true;



                        bufferRecepcion = "";



                        setTimeout(() => { if(port.isOpen) port.write(comandoENQ); }, 200);



                        return;



                    }



                    clearTimeout(timeoutConsultas);



                    return closeAndResolve({ success: false, errorType: "HKA_ERROR", msg: "Impresora rechazó consulta (NAK)." });



                }



                if (data.includes(0x03)) {



                    if (estado === 'ENQ') {



                        estado = 'S1';



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



                    } else if (estado === 'S1') {



                        estado = 'S3';



                        try {



                            const contenido = bufferRecepcion.split('\x02')[1].split('\x03')[0];



                            if (contenido.includes('\n')) {



                                const partes = contenido.split('\n').map(p => p.trim()); 



                                datosS1.serial = partes[13] ? partes[13] : "DESC";        



                                if (partes.length >= 14) {



                                    const facturaReal = parseInt(partes[2], 10);



                                    if (!isNaN(facturaReal) && facturaReal > 0) datosS1.nroFac = facturaReal.toString().padStart(8, '0');



                                }



                            } else {



                                // Fallback: parseo por posición fija sólo si la trama no tiene saltos de línea



                                const serialMatch = contenido.match(/([A-Z0-9]{6,12})\s*$/);



                                if (serialMatch) datosS1.serial = serialMatch[1];



                                



                                const facMatch = contenido.match(/(\d{8})/g);



                                if (facMatch && facMatch.length >= 3) {



                                    const facturaReal = parseInt(facMatch[2], 10);



                                    if (!isNaN(facturaReal) && facturaReal > 0) datosS1.nroFac = facturaReal.toString().padStart(8, '0');



                                }



                            }



                        } catch (e) {



                            console.error("Error parseando S1:", e);



                        }



                        bufferRecepcion = "";



                        port.write(tramaS3);



                    } else if (estado === 'S3') {



                        estado = 'S5';



                        try {



                            rawS3Content = bufferRecepcion.split('\x02')[1].split('\x03')[0];



                        } catch (e) {



                            console.error("Error parseando S3:", e);



                        }



                        bufferRecepcion = "";



                        port.write(tramaS5);



                    } else if (estado === 'S5') {



                        clearTimeout(timeoutConsultas);



                        try {



                            rawS5Content = bufferRecepcion.split('\x02')[1].split('\x03')[0];



                        } catch (e) {



                            console.error("Error parseando S5:", e);



                        }



                        closeAndResolve({ 



                            success: true, 



                            msg: "Máquina en línea", 



                            serial: datosS1.serial, 



                            nroFactura: datosS1.nroFac, 



                            flag21: datosS1.flag21,



                            s3_tasas: rawS3Content,



                            s5_memoria: rawS5Content



                        });



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



            let esperandoS2 = false;



            let bufferS2 = "";







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







                if (esperandoS2) {



                    bufferS2 += data.toString('latin1');



                    if (data.includes(0x03)) {



                        clearTimeout(timeoutOperacion);



                        try {



                            const contenidoS2 = bufferS2.split('\x02')[1].split('\x03')[0];



                            let montoRestante = contenidoS2;



                            const match13 = contenidoS2.match(/\d{10,14}/g);



                            if (match13 && match13.length >= 3) {



                                montoRestante = match13[2];



                            }



                            console.log('[FISCAL] S2 Monto restante según impresora: ' + montoRestante);



                        } catch (e) {



                            console.error("[FISCAL] Error parseando S2:", e);



                        }



                        esperandoS2 = false;



                        enviarSiguienteComando();



                    }



                    return;



                }







                if (!leyendoStatusFinal) {



                    if (data.includes(0x06)) {



                        index++;



                        const esComandoPagoParcial = /^2(0[1-9]|1[0-9]|2[0-4])/.test(tramas[index - 1]);



                        if (esComandoPagoParcial) {



                            esperandoS2 = true;



                            bufferS2 = "";



                            const comandoS2 = Buffer.from('S2', 'latin1');



                            const lrcS2 = calcularLRC(comandoS2, ETX);



                            const tramaS2 = Buffer.concat([STX, comandoS2, ETX, Buffer.from([lrcS2])]);



                            port.write(tramaS2);



                            timeoutOperacion = setTimeout(() => {



                                closeAndResolve({ success: false, errorType: 'HKA_ERROR', msg: "Timeout esperando S2 tras pago parcial" });



                            }, 5000);



                        } else {



                            setTimeout(enviarSiguienteComando, 250); 



                        }



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



        let isServerVal = null;



        let serverIPVal = null;







        try {



            if (typeof db !== 'undefined' && db) {



                const rowServer = db.prepare("SELECT valor FROM configuracion WHERE clave = 'isServer'").get();



                if (rowServer) isServerVal = rowServer.valor;







                const rowIP = db.prepare("SELECT valor FROM configuracion WHERE clave = 'serverIP'").get();



                if (rowIP) serverIPVal = rowIP.valor;



            }



        } catch (eDb) {



            // Ignorar si db no está inicializada aún



        }







        if (isServerVal !== null) {



            const esMaestro = (isServerVal === true || isServerVal === 'true');



            if (esMaestro) {



                return '127.0.0.1';



            }



            if (serverIPVal && serverIPVal !== 'localhost' && serverIPVal.trim() !== '') {



                return serverIPVal.trim();



            }



        }







        // Fallback a config.json si no se encuentra en SQLite



        const configLocal = JSON.parse(fs.readFileSync(configPath, 'utf8'));



        const esMaestro = (configLocal.isServer === true || configLocal.isServer === 'true');



        if (esMaestro) {



            return '127.0.0.1';



        }



        const ip = configLocal.serverIP;



        if (!ip || ip === 'localhost' || ip.trim() === '') {



            console.error('[RED] ❌ ERROR CRÍTICO: Esta PC está configurada como CLIENTE pero no tiene una IP de servidor válida.');



            return null;



        }



        return ip.trim();



    } catch (e) {



        console.error('[RED] ❌ Error en getIpMaestro:', e.message);



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



                    : metodo === 'PUT'



                        ? await axios.put(url, datos, cfg)



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



    console.log(`[FISCAL] ⚠️ El puerto abrió bien. Saltando el saludo 0x05 porque el emulador exige tramas completas.`);



    console.log(`[FISCAL] ✅ Dando LUZ VERDE para probar la facturación real.`);



    



    // Le decimos al frontend que todo está OK para que nos deje facturar



    resolve({ success: true, msg: "Puerto abierto y listo para comandos" });



}







// MODO DE facturación HKA IMPRENTA DIGITAL "FACTURACIÓN ELECTRÓNICA" - FASE 2: Sincronización y Validación de Numeración







// Función auxiliar para obtener la serie HKA de configuración



function obtenerSerieHKA() {



    try {



        let row = null;



        if (masterDbDirect) {



            try { row = masterDbDirect.prepare("SELECT valor FROM configuracion WHERE clave = 'config_factura'").get(); } catch(e) {}



        }



        if (!row && db) {



            row = db.prepare("SELECT valor FROM configuracion WHERE clave = 'config_factura'").get();



            if (!row) row = db.prepare("SELECT valor FROM configuracion_cajera WHERE clave = 'config_factura'").get();



        }



        if (row && row.valor) {



            const cfg = JSON.parse(row.valor);



            return (cfg.hka_serie || '').toUpperCase().trim();



        }



    } catch(e) {



        console.warn("[HKA] Error obteniendo serie HKA:", e.message);



    }



    return "";



}







// 🟢 FUNCIÓN 1: Consultar último número y sincronizar con base de datos local



async function sincronizarUltimoNumero(event, tipoDoc = "01", serieParam = null) {



    try {



        const serie = (serieParam !== null && serieParam !== undefined) ? String(serieParam).toUpperCase().trim() : obtenerSerieHKA();



        reportarLogHKA(event, `Consultando último correlativo (${tipoDoc}, Serie: "${serie}") en la nube...`);



        



        if (!apiToken) {



            await iniciarAuthWorkerHKA(event);



        }



        if (!apiToken) {



            throw new Error("No hay token de autenticación activo para consultar la nube.");



        }







        const response = await axios.post(`${getHkaBaseUrl()}/api/UltimoDocumento`, 



            { serie: serie, tipoDocumento: tipoDoc },



            { headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' } }



        );







        const data = response.data;



        const resObj = (data && data.resultado) ? data.resultado : data;



        const nroDocRaw = (resObj && resObj.numeroDocumento !== undefined && resObj.numeroDocumento !== null)



            ? resObj.numeroDocumento



            : (data && data.numeroDocumento !== undefined ? data.numeroDocumento : null);







        if (nroDocRaw !== null && nroDocRaw !== undefined) {



            const ultimoNro = parseInt(nroDocRaw, 10) || 0;



            



            // Determinar tipo de correlativo interno



            let tipoCorrelativoInterno = 'ELECTRONICA';



            if (tipoDoc === '02') tipoCorrelativoInterno = 'NOTA_CREDITO';



            else if (tipoDoc === '03') tipoCorrelativoInterno = 'NOTA_DEBITO';



            else if (tipoDoc === '04') tipoCorrelativoInterno = 'GUIA_DESPACHO';



            else if (tipoDoc === '05') tipoCorrelativoInterno = 'RETENCION_IVA';



            else if (tipoDoc === '06') tipoCorrelativoInterno = 'RETENCION_ISLR';







            // Actualizar correlativo en la base de datos local



            try {



                if (masterDbDirect) {



                    const row = masterDbDirect.prepare('SELECT ultimo_numero FROM correlativos_maestros WHERE tipo = ?').get(tipoCorrelativoInterno);



                    if (!row) {



                        let prefijo = 'TFHKA-';



                        if (tipoDoc === '02') prefijo = 'NC-';



                        else if (tipoDoc === '03') prefijo = 'ND-';



                        else if (tipoDoc === '04') prefijo = 'GD-';



                        else if (tipoDoc === '05' || tipoDoc === '06') prefijo = 'RET-';



                        masterDbDirect.prepare('INSERT INTO correlativos_maestros (tipo, prefijo, ultimo_numero) VALUES (?, ?, ?)').run(tipoCorrelativoInterno, prefijo, ultimoNro);



                    } else {



                        masterDbDirect.prepare('UPDATE correlativos_maestros SET ultimo_numero = ? WHERE tipo = ?').run(ultimoNro, tipoCorrelativoInterno);



                    }



                }



            } catch (eDb) {



                console.warn("[HKA] Error actualizando correlativos_maestros:", eDb.message);



            }







            try {



                if (db) {



                    const row = db.prepare('SELECT ultimo_numero FROM correlativos WHERE tipo = ?').get(tipoCorrelativoInterno);



                    if (!row) {



                        let prefijo = 'TFHKA-';



                        if (tipoDoc === '02') prefijo = 'NC-';



                        else if (tipoDoc === '03') prefijo = 'ND-';



                        else if (tipoDoc === '04') prefijo = 'GD-';



                        else if (tipoDoc === '05' || tipoDoc === '06') prefijo = 'RET-';



                        db.prepare('INSERT INTO correlativos (tipo, ultimo_numero, prefijo) VALUES (?, ?, ?)').run(tipoCorrelativoInterno, ultimoNro, prefijo);



                    } else {



                        db.prepare('UPDATE correlativos SET ultimo_numero = ? WHERE tipo = ?').run(ultimoNro, tipoCorrelativoInterno);



                    }



                }



            } catch (eDb2) {



                console.warn("[HKA] Error actualizando correlativos local:", eDb2.message);



            }







            if (!config.isServer) {



                try {



                    await llamarMaestro('POST', '/api/maestro/actualizar-correlativo', { tipo: tipoCorrelativoInterno, ultimo_numero: ultimoNro });



                } catch(eRed) {}



            }







            const proximoNro = ultimoNro + 1;



            const serieEfectiva = (resObj && resObj.serie) ? resObj.serie : (serie || 'General');



            const numCtrl = (resObj && resObj.numeroControl) ? resObj.numeroControl : '';



            reportarLogHKA(event, `Sincronización exitosa: Última factura en nube #${ultimoNro} (Serie: ${serieEfectiva}). Próximo: #${proximoNro}. DB Local actualizada.`);



            return { exito: true, ultimoNumero: ultimoNro, proximoNumero: proximoNro, serie: serieEfectiva, numeroControl: numCtrl, mensaje: data.mensaje || "Consulta exitosa" };



        } else {



            const msgError = data ? (data.mensaje || JSON.stringify(data.validaciones || data)) : "Respuesta sin datos";



            reportarLogHKA(event, `Aviso HKA: ${msgError}`);



            return { exito: false, error: msgError };



        }



    } catch (error) {



        let detalle = error.message;



        if (error.response && error.response.data) {



            detalle = JSON.stringify(error.response.data);



        }



        reportarLogHKA(event, `Error sincronizando números: ${detalle}`, true);



        return { exito: false, error: detalle };



    }



}







// 🟢 FUNCIÓN 2: Verificar rangos disponibles (ConsultaNumeraciones)



async function verificarRangosDisponibles(event) {



    try {



        const serie = obtenerSerieHKA();



        reportarLogHKA(event, `Validando disponibilidad de correlativos en el portal (Serie: "${serie}")...`);



        



        const response = await axios.post(`${getHkaBaseUrl()}/api/ConsultaNumeraciones`, 



            { serie: serie, tipoDocumento: "01" },



            { headers: { 'Authorization': `Bearer ${apiToken}` } }



        );







        if (response.data && response.data.numeraciones && response.data.numeraciones.length > 0) {



            const rango = response.data.numeraciones[0]; // Tomamos el primer rango activo



            reportarLogHKA(event, `Rangos validados: Desde ${rango.desde} hasta ${rango.hasta}. Estado: ${rango.estado}`);



        } else {



            reportarLogHKA(event, "Validación de rangos completada.");



        }



    } catch (error) {



        reportarLogHKA(event, `Error validando rangos: ${error.message}`, true);



    }



}







// 🟢 INTERCEPCIÓN DEL AUTH EXITOSO PARA DISPARAR FASE 2



ipcMain.on('ejecutar-auth-hka', async (event, credentials) => {



    // Primero hacemos el login (Fase 1)



    const authOk = await iniciarAuthWorkerHKA(event, credentials); 



    



    // Si tenemos token, disparamos la Fase 2 automáticamente con la Serie activa



    if (authOk && apiToken) {



        await sincronizarUltimoNumero(event, "01"); // Sincroniza el número



        await verificarRangosDisponibles(event);    // Valida que hay números libres



    }



});







// IPC PARA CONSULTAR Y SINCRONIZAR A PETICIÓN DESDE LA CONFIGURACIÓN O FACTURACIÓN



ipcMain.handle('consultar-y-sincronizar-ultimo-correlativo-hka', async (event, datos = {}) => {



    try {



        const tipoDoc = datos.tipoDocumento || "01";



        const serie = datos.serie !== undefined ? datos.serie : null;



        return await sincronizarUltimoNumero(event, tipoDoc, serie);



    } catch (e) {



        return { exito: false, error: e.message };



    }



});







// IPC PARA ANULACIÓN FISCAL EN HKA (/api/Anular)



ipcMain.handle('anular-documento-hka', async (event, datosAnulacion) => {



    try {



        if (!apiToken) {



            await iniciarAuthWorkerHKA(event);



        }



        if (!apiToken) throw new Error("No hay token de autenticación activo para anular en HKA.");







        const payload = {



            serie: datosAnulacion.serie !== undefined ? datosAnulacion.serie : obtenerSerieHKA(),



            tipoDocumento: datosAnulacion.tipoDocumento || "01",



            numeroDocumento: String(datosAnulacion.numeroDocumento),



            motivoAnulacion: datosAnulacion.motivoAnulacion || "Anulación administrativa",



            fechaAnulacion: datosAnulacion.fechaAnulacion,



            horaAnulacion: datosAnulacion.horaAnulacion



        };







        const response = await axios.post(`${getHkaBaseUrl()}/api/Anular`, payload, {



            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' }



        });







        return { exito: true, data: response.data };



    } catch (error) {



        let detalle = error.message;



        if (error.response && error.response.data) detalle = JSON.stringify(error.response.data);



        return { exito: false, error: detalle };



    }



});







// --- FASE 3: EMISIÃ“N DE FACTURA ELECTRÃ“NICA ---







// IPC PARA CONSULTAR ESTADO DE DOCUMENTO EN HKA (/api/EstadoDocumento)



ipcMain.handle('consultar-estado-documento-hka', async (event, datos) => {



    try {



        if (!apiToken) await iniciarAuthWorkerHKA(event);



        if (!apiToken) throw new Error("No hay token de autenticación activo.");







        const payload = {



            serie: datos.serie !== undefined ? datos.serie : obtenerSerieHKA(),



            tipoDocumento: datos.tipoDocumento || "01",



            numeroDocumento: String(datos.numeroDocumento)



        };







        const response = await axios.post(`${getHkaBaseUrl()}/api/EstadoDocumento`, payload, {



            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' }



        });



        return { exito: true, data: response.data };



    } catch (error) {



        let detalle = error.message;



        if (error.response && error.response.data) detalle = JSON.stringify(error.response.data);



        return { exito: false, error: detalle };



    }



});







// IPC PARA DESCARGA DE ARCHIVO (PDF / XML) EN HKA (/api/DescargaArchivo)



ipcMain.handle('descargar-archivo-hka', async (event, datos) => {



    try {



        if (!apiToken || (tokenExpiration && Date.now() >= tokenExpiration.getTime())) {



            await iniciarAuthWorkerHKA(event);



        }



        if (!apiToken) throw new Error("No hay token de autenticacion activo.");







        const payload = {



            serie: datos.serie !== undefined ? datos.serie : obtenerSerieHKA(),



            tipoDocumento: datos.tipoDocumento || "01",



            numeroDocumento: String(datos.numeroDocumento)



        };







        const response = await axios.post(`${getHkaBaseUrl()}/api/DescargaArchivo`, payload, {



            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },



            timeout: 25000



        });







        const data = response.data;



        let rutaGuardada = null;



        let base64Pdf = null;







        if (data && [0, 200, '0', '200'].includes(data.codigo)) {



            base64Pdf = data.documento || data.archivo || data.pdf || (typeof data.resultado === 'string' ? data.resultado : (data.resultado?.documento || data.resultado?.archivo));



            if (base64Pdf) {



                try {



                    const comprobantesDir = path.join(app.getPath('documents'), 'NEXUS_POS_GLOBAL', 'Comprobantes_Digitales');



                    if (!fs.existsSync(comprobantesDir)) fs.mkdirSync(comprobantesDir, { recursive: true });







                    const tipoNombres = { "01": "Factura", "02": "NotaCredito", "03": "NotaDebito", "04": "GuiaDespacho", "05": "RetencionIVA", "06": "RetencionISLR" };



                    const prefijo = tipoNombres[payload.tipoDocumento] || "Documento";



                    const serieStr = payload.serie ? `${payload.serie}-` : '';



                    const nombreArchivo = `${prefijo}_${serieStr}${payload.numeroDocumento}.pdf`;



                    rutaGuardada = path.join(comprobantesDir, nombreArchivo);







                    fs.writeFileSync(rutaGuardada, Buffer.from(base64Pdf, 'base64'));



                    console.log(`[HKA] PDF descargado y guardado en disco: ${rutaGuardada}`);



                } catch(eSave) {



                    console.warn("[HKA] Error guardando PDF en disco:", eSave.message);



                }



            }



        }







        return { exito: true, data: data, base64: base64Pdf, rutaGuardada: rutaGuardada };



    } catch (error) {



        let detalle = error.message;



        if (error.response && error.response.data) detalle = JSON.stringify(error.response.data);



        return { exito: false, error: detalle };



    }



});







// IPC PARA REENVIO DE CORREO EN HKA (/api/Correo/Enviar)
ipcMain.handle('enviar-correo-hka', async (event, datos) => {
    try {
        if (!apiToken || (tokenExpiration && Date.now() >= tokenExpiration.getTime())) {
            await iniciarAuthWorkerHKA(event);
        }
        if (!apiToken) throw new Error("No hay token de autenticacion activo.");

        const payload = {
            serie: datos.serie !== undefined ? datos.serie : obtenerSerieHKA(),
            tipoDocumento: datos.tipoDocumento || "01",
            numeroDocumento: String(datos.numeroDocumento),
            correos: Array.isArray(datos.correos) ? datos.correos : [datos.correo]
        };

        const response = await axios.post(`${getHkaBaseUrl()}/api/Correo/Enviar`, payload, {
            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
            timeout: 25000
        });

        const data = response.data;
        if (data && [0, 200, '0', '200'].includes(data.codigo)) {
            return { exito: true, data };
        } else {
            return { exito: false, error: data?.mensaje || "Error retornado por HKA al enviar correo" };
        }
    } catch (error) {
        let detalle = error.message;
        if (error.response && error.response.data) detalle = JSON.stringify(error.response.data);
        return { exito: false, error: detalle };
    }
});

// IPC PARA RASTREO DE CORREO EN HKA (/api/Correo/Rastreo)
ipcMain.handle('rastrear-correo-hka', async (event, datos) => {
    try {
        if (!apiToken || (tokenExpiration && Date.now() >= tokenExpiration.getTime())) {
            await iniciarAuthWorkerHKA(event);
        }
        if (!apiToken) throw new Error("No hay token de autenticacion activo.");

        const payload = {
            serie: datos.serie !== undefined ? datos.serie : obtenerSerieHKA(),
            tipoDocumento: datos.tipoDocumento || "01",
            numeroDocumento: String(datos.numeroDocumento)
        };

        const response = await axios.post(`${getHkaBaseUrl()}/api/Correo/Rastreo`, payload, {
            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        return { exito: true, data: response.data };
    } catch (error) {
        let detalle = error.message;
        if (error.response && error.response.data) detalle = JSON.stringify(error.response.data);
        return { exito: false, error: detalle };
    }
});







ipcMain.handle('emitir-factura-hka', async (event, facturaJSON) => {



    try {



        if (!apiToken || (tokenExpiration && Date.now() >= tokenExpiration.getTime())) {



            await iniciarAuthWorkerHKA(event);



        }



        if (!apiToken) throw new Error("No hay token de autenticacion activo.");







        // 1. Ubicar la raiz del documento soportando cualquier variacion de casing



        const doc = facturaJSON.DocumentoElectronico 



                 || facturaJSON.documentoElectronico 



                 || facturaJSON.Documentoelectronico 



                 || facturaJSON.documentoelectronico;



        if (!doc) throw new Error("Estructura raiz 'DocumentoElectronico' no encontrada en el JSON.");







        const nroDoc = doc.Encabezado?.IdentificacionDocumento?.NumeroDocumento;



        const tipoDoc = doc.Encabezado?.IdentificacionDocumento?.TipoDocumento || "01";



        const serieDoc = doc.Encabezado?.IdentificacionDocumento?.Serie !== undefined ? doc.Encabezado.IdentificacionDocumento.Serie : obtenerSerieHKA();



        



        console.log(`[HKA] Enviando documento legal #${nroDoc} (Tipo: ${tipoDoc}, Serie: "${serieDoc}")`);



        reportarLogHKA(event, `Enviando documento #${nroDoc} a fiscalizacion...`);







        // Registrar en Staging local con estado 'EN_VUELO' para proteger contra cortes de luz



        try {



            const stagingStmt = db.prepare(`



                INSERT OR REPLACE INTO staging_hka_en_vuelo 



                (id, tipo_documento, serie, numero_documento, payload_json, estado, fecha_actualizacion)



                VALUES (?, ?, ?, ?, ?, 'EN_VUELO', datetime('now', '-4 hours'))



            `);



            stagingStmt.run(`HKA-${tipoDoc}-${nroDoc}-${Date.now()}`, tipoDoc, serieDoc, String(nroDoc), JSON.stringify(facturaJSON));



        } catch(eStaging) {



            console.warn("[HKA] Aviso registrando staging en vuelo:", eStaging.message);



        }







        // 2. Envio a la API con timeout seguro de 25 segundos



        const response = await axios.post(`${getHkaBaseUrl()}/api/Emision`, facturaJSON, {



            headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },



            timeout: 25000



        });







        const data = response.data;







        // 3. Validacion de aceptacion oficial



        if (data && [0, 200, '0', '200'].includes(data.codigo)) {



            reportarLogHKA(event, "Documento aceptado exitosamente por The Factory HKA.");



            try {



                const nroCtrl = data.resultado?.numeroControl || data.numeroControl || null;



                db.prepare(`UPDATE staging_hka_en_vuelo SET estado = 'CONFIRMADO', numero_control = ?, fecha_actualizacion = datetime('now', '-4 hours') WHERE tipo_documento = ? AND numero_documento = ?`).run(nroCtrl, tipoDoc, String(nroDoc));



            } catch(eUpd) {}



            return { exito: true, data };



        } 



        



        // 4. Manejo de respuestas / rechazos



        const errorMsg = `${data.mensaje || "Error desconocido"}`;



        console.error("[HKA] Rechazo de emision:", data);



        reportarLogHKA(event, `Error de Emision HKA: ${errorMsg}`, true);







        try {



            db.prepare(`UPDATE staging_hka_en_vuelo SET estado = 'FALLIDO', error_mensaje = ?, fecha_actualizacion = datetime('now', '-4 hours') WHERE tipo_documento = ? AND numero_documento = ?`).run(errorMsg, tipoDoc, String(nroDoc));



        } catch(eFail) {}







        // Si es 201 (Documento duplicado), auto-sincronizamos el correlativo de inmediato con la nube



        const esDuplicado = String(data.codigo) === '201' || errorMsg.toLowerCase().includes('duplicado');



        if (esDuplicado) {



            console.log(`[HKA] Documento duplicado detectado (#${nroDoc}). Auto-sincronizando correlativo con la nube (Serie: "${serieDoc}")...`);



            try {



                const syncRes = await sincronizarUltimoNumero(event, tipoDoc, serieDoc);



                return {



                    exito: false,



                    codigo: 201,



                    duplicado: true,



                    error: `Documento duplicado (#${nroDoc}). El ultimo correlativo registrado en la nube TFHKA es #${syncRes.ultimoNumero}. La base de datos local fue actualizada automaticamente al proximo correlativo (#${syncRes.proximoNumero}). Por favor presione Confirmar nuevamente.`,



                    ultimoNumeroNube: syncRes.ultimoNumero,



                    proximoNumero: syncRes.proximoNumero,



                    data: data



                };



            } catch(eSync) {



                console.warn("[HKA] Error en auto-sincronizacion tras duplicado:", eSync.message);



            }



        }







        return { exito: false, error: errorMsg, codigo: data.codigo, data: data };







    } catch (error) {



        let detalle = error.message;



        if (error.response && error.response.data) {



            detalle = JSON.stringify(error.response.data);



            console.error("[HKA] Respuesta de error HTTP:", error.response.data);



        }



        



        reportarLogHKA(event, `Fallo de conexion HKA: ${detalle}`, true);



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



    splashStartTime = Date.now();

    splash.webContents.once('did-finish-load', () => {
        splashStartTime = Date.now();
    });

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

    asegurarHistorialInicial().then(() => rellenarHuecosHistorial()).catch(() => {});







    Menu.setApplicationMenu(null);







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



        const hoy = getCaracasTime().split(' ')[0]; // Formato YYYY-MM-DD



        



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



                const hoy = getCaracasTime().split(' ')[0];



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

    const tiempoTranscurrido = splashStartTime ? (Date.now() - splashStartTime) : 0;
    const tiempoRestante = Math.max(0, 2000 - tiempoTranscurrido);

    setTimeout(() => {



        if (splash && !splash.isDestroyed()) splash.close();



        



        // REGLA INFALIBLE: Solo mostramos el login si no se ha saltado a la ventana principal



        if (win && !win.isDestroyed() && !sistemaPrincipalAbierto) {



            win.center();



            win.show();



        }



    }, tiempoRestante); 



});



}











ipcMain.handle('obtener-claves-admin-maestro', async (event, companyId) => {



    console.log(`[CLAVES-ADMIN] Iniciando consulta para companyId: ${companyId}`);



    try {



        const ip = getIpServidor();



        const url = `http://${ip}:3000/api/maestro/obtener-claves-admin/${companyId}`;



        console.log(`[CLAVES-ADMIN] IP Servidor: ${ip} | URL completa: ${url}`);



        



        const respuesta = await llamarMaestro('GET', `/api/maestro/obtener-claves-admin/${companyId}`, null, { timeout: 8000, reintentos: 2 });



        console.log(`[CLAVES-ADMIN] Respuesta HTTP de ${url}: Registros = ${respuesta.data ? respuesta.data.length : 0}`);



        console.log(`[CLAVES-ADMIN] Datos recibidos:`, JSON.stringify(respuesta.data));



        



        const result = (respuesta.data || []).map(c => {



            c.plainCode = decryptClave(c.encryptedCode);



            if (typeof c.permisos === 'string') {



                try {



                    c.permisos = JSON.parse(c.permisos);



                } catch(e) {



                    c.permisos = {};



                }



            } else if (!c.permisos) {



                c.permisos = null;



            }



            c.is_master = (c.is_master === 1 || c.is_master === true || c.is_master === '1' || c.is_master === 'true' || c.isMaster === true || c.isMaster === 1);



            return c;



        });



        console.log(`[CLAVES-ADMIN] Claves desencriptadas:`, result.map(c => ({ owner: c.ownerName, isMaster: c.is_master, permisos: c.permisos })));



        return result;



    } catch (e) {



        console.error('[CLAVES-ADMIN] Error en obtener-claves-admin-maestro:', e.message);



        return [];



    }



});







ipcMain.handle('leer-config-maestra', async (event, clave) => {



    try {



        if (config.isServer && masterDbDirect) {



            const row = masterDbDirect.prepare('SELECT valor FROM configuraciones_maestras WHERE clave = ?').get(clave);



            if (row) return { exito: true, valor: row.valor };



            if (db) {



                try {



                    const rowLocal = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(clave);



                    if (rowLocal) return { exito: true, valor: rowLocal.valor };



                } catch(eDb) {}



            }



            return { exito: true, valor: null };



        } else {



            const respuesta = await llamarMaestro('GET', `/api/maestro/configuracion/${clave}`, null, { timeout: 8000, reintentos: 1 });



            return respuesta.data;



        }



    } catch (e) {



        console.error('Error leer-config-maestra:', e);



        return { exito: false, valor: null, error: e.message };



    }



});







ipcMain.handle('eliminar-clave-admin-maestro', async (event, id) => {



    try {



        const respuesta = await llamarMaestro('DELETE', `/api/maestro/eliminar-clave-admin/${id}`, null, { timeout: 6000, reintentos: 1 });



        return respuesta.data;



    } catch (e) {



        console.error('Error eliminar-clave-admin-maestro:', e);



        return { error: e.message };



    }



});







ipcMain.handle('guardar-clave-admin-maestro', async (event, datos) => {



    try {



        // Encriptar clave antes de enviar/guardar



        if (datos.plainCode) {



            datos.encryptedCode = encryptClave(datos.plainCode);



            delete datos.plainCode; // No enviar la contraseña plana



        }



        



        const respuesta = await llamarMaestro('POST', '/api/maestro/guardar-clave-admin', datos, { timeout: 8000, reintentos: 2 });



        return respuesta.data;



    } catch (e) {



        console.error('Error guardar-clave-admin-maestro:', e);



        return { error: e.message };



    }



});







ipcMain.handle('guardar-config-maestra', async (event, datos) => {



    try {



        if (config.isServer && masterDbDirect) {



            const stmt = masterDbDirect.prepare(`



                INSERT INTO configuraciones_maestras (clave, valor) 



                VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor



            `);



            stmt.run(datos.clave, datos.valor);



            return { exito: true };



        } else {



            const respuesta = await llamarMaestro('POST', '/api/maestro/configuracion', datos, { timeout: 8000, reintentos: 2 });



            return respuesta.data;



        }



    } catch (e) {



        console.error('Error guardar-config-maestra:', e);



        return { error: e.message };



    }



});







ipcMain.handle('obtener-configuracion-fiscal', async () => {



    try {



        if (!config.isServer) {



            const ipMaestro = getIpMaestro();



            if (ipMaestro) {



                const url = `http://${ipMaestro}:3000/api/maestro/configuracion-fiscal`;



                const reqFetch = await fetch(url, { signal: AbortSignal.timeout(6000) });



                if (reqFetch.ok) return await reqFetch.json();



            }



        }



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



ipcMain.handle('solicitar-desbloqueo-consola', (event, password) => {



    const clave = String(password).trim();



    const clavesAutorizadas = ['109882', '337246'];



    if (clavesAutorizadas.includes(clave)) {



        const targetWin = BrowserWindow.fromWebContents(event.sender);



        if (targetWin && !targetWin.isDestroyed()) {



            targetWin.webContents.toggleDevTools();



            console.log(`🔓 [SEGURIDAD] Consola de desarrollador autorizada y abierta con clave (${clave}).`);



            return { success: true };



        }



    }



    console.warn("🔒 [SEGURIDAD] Intento bloqueado de acceso a la consola (código incorrecto).");



    return { success: false, msg: "Código no autorizado" };



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



    // --- BLINDAJE INTEGRAL DE HERRAMIENTAS DE DESARROLLO Y MENÚS ---



    app.on('web-contents-created', (event, contents) => {



        // Bloqueo estricto del menú contextual del ratón (Clic derecho -> Inspeccionar)



        contents.on('context-menu', (e) => {



            e.preventDefault();



        });







        contents.on('before-input-event', (event, input) => {



            if (input.type !== 'keyDown') return;







            const key = input.key ? input.key.toLowerCase() : '';



            const isCtrlOrMeta = input.control || input.meta;



            const isShiftOrAlt = input.shift || input.alt;







            // A. Atajos de inspección y consola (F12, Ctrl/Cmd + Shift/Alt + I, J, C)



            const isDevToolsShortcut = 



                (isCtrlOrMeta && isShiftOrAlt && ['i', 'j', 'c'].includes(key)) || 



                input.key === 'F12';







            if (isDevToolsShortcut) {



                event.preventDefault(); // BLOQUEO TOTAL DE APERTURA DIRECTA



                contents.send('solicitar-clave-consola'); // Notificar al front para solicitar la clave



                return;



            }







            // B. Atajos secundarios bloqueados en seco (Ctrl/Cmd + U, S, P y Shift + Escape)



            const isForbiddenShortcut = 



                (isCtrlOrMeta && ['u', 's', 'p'].includes(key)) ||



                (input.shift && input.key === 'Escape');







            if (isForbiddenShortcut) {



                event.preventDefault();



                return;



            }







            // C. Solo Ctrl+R / Cmd+R recarga para desarrollo; F5 queda liberado para actuar como atajo de pago



            if (isCtrlOrMeta && key === 'r') {



                contents.reload();



                event.preventDefault();



            }



        });



    });







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







                    let parsedFields = {



                        numeroZ: "N/A",



                        ultimaFactura: "N/A",



                        fechaEmision: getCaracasTime().split(' ')[0],



                        horaEmision: new Date().toTimeString().split(' ')[0],



                        exento: 0,



                        base1: 0,



                        impuesto1: 0,



                        base2: 0,



                        impuesto2: 0,



                        base3: 0,



                        impuesto3: 0,



                        igtf: 0



                    };







                    try {



                        const dataOnly = dataLimpia.substring(2); // Remover STS1 y STS2 (primeros 2 bytes)



                        if (dataOnly.length >= 200) {



                            const formatDate = (str) => (str && str.length === 6) ? `20${str.substring(4,6)}-${str.substring(2,4)}-${str.substring(0,2)}` : parsedFields.fechaEmision;



                            const formatTime = (str) => (str && str.length === 4) ? `${str.substring(0,2)}:${str.substring(2,4)}:00` : parsedFields.horaEmision;



                            const parseAmount = (str) => str ? parseInt(str, 10) / 100 : 0;







                            if (dataOnly.length < 300) {



                                // Grupo 1 (Legacy: SRP-350, HSP7000, TALLY-1125, etc. ~217 chars)



                                parsedFields.numeroZ = dataOnly.substring(0, 4);



                                parsedFields.fechaEmision = formatDate(dataOnly.substring(4, 10));



                                parsedFields.ultimaFactura = dataOnly.substring(10, 18);



                                



                                parsedFields.exento = parseAmount(dataOnly.substring(28, 41));



                                parsedFields.base1 = parseAmount(dataOnly.substring(41, 54));



                                parsedFields.impuesto1 = parseAmount(dataOnly.substring(54, 67));



                                parsedFields.base2 = parseAmount(dataOnly.substring(67, 80));



                                parsedFields.impuesto2 = parseAmount(dataOnly.substring(80, 93));



                                parsedFields.base3 = parseAmount(dataOnly.substring(93, 106));



                                parsedFields.impuesto3 = parseAmount(dataOnly.substring(106, 119));



                            } else {



                                // Grupo 2 (Expandido: SRP-812, DT-230, HKA-80, PP9, etc. ~595 chars)



                                parsedFields.numeroZ = dataOnly.substring(0, 4);



                                parsedFields.fechaEmision = formatDate(dataOnly.substring(4, 10));



                                parsedFields.horaEmision = formatTime(dataOnly.substring(10, 14));



                                parsedFields.ultimaFactura = dataOnly.substring(14, 22);



                                



                                parsedFields.exento = parseAmount(dataOnly.substring(56, 74));



                                parsedFields.base1 = parseAmount(dataOnly.substring(74, 92));



                                parsedFields.impuesto1 = parseAmount(dataOnly.substring(92, 110));



                                parsedFields.base2 = parseAmount(dataOnly.substring(110, 128));



                                parsedFields.impuesto2 = parseAmount(dataOnly.substring(128, 146));



                                parsedFields.base3 = parseAmount(dataOnly.substring(146, 164));



                                parsedFields.impuesto3 = parseAmount(dataOnly.substring(164, 182));







                                if (dataOnly.length >= 595) {



                                    parsedFields.igtf = parseAmount(dataOnly.substring(506, 524)); // Valor IGTF Ventas



                                }



                            }



                        }



                    } catch (e) {



                        console.error('[FISCAL] Error parseando data U0X/U0Z:', e);



                    }







                    closeAndResolve({ 



                        success: true, 



                        data: {



                            rawData: dataLimpia,



                            ...parsedFields



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



            }, 25000);







            port.write(trama);



        });



    });



});







// --- HANDLERS RECUPERADOS: SALIDAS Y EMPAQUES ---



ipcMain.handle('obtener-empaque-por-producto', async (event, productId) => {



    try {



        if (!config.isServer) {



            const ipMaestro = getIpMaestro();



            if (ipMaestro) {



                const url = `http://${ipMaestro}:3000/api/maestro/unidades-empaque/${encodeURIComponent(productId || '')}`;



                const reqFetch = await fetch(url, { signal: AbortSignal.timeout(6000) });



                if (reqFetch.ok) {



                    const data = await reqFetch.json();



                    if (Array.isArray(data)) return data;



                }



            }



        }



        const query = "SELECT * FROM unidades_empaque WHERE product_id = ?";



        return db.prepare(query).all(productId);



    } catch (e) {



        console.error("❌ Error obtener empaque:", e);



        return [];



    }



});







ipcMain.handle('obtener-unidades-empaque-local', async (event, companyId) => {



    try {



        if (!config.isServer) {



            const ipMaestro = getIpMaestro();



            if (ipMaestro) {



                const url = `http://${ipMaestro}:3000/api/maestro/unidades-empaque`;



                const reqFetch = await fetch(url, { signal: AbortSignal.timeout(6000) });



                if (reqFetch.ok) {



                    const data = await reqFetch.json();



                    if (Array.isArray(data)) return data;



                }



            }



        }



        const query = "SELECT * FROM unidades_empaque WHERE company_id = ?";



        return db.prepare(query).all(companyId);



    } catch (e) {



        console.error("❌ Error obtener unidades empaque:", e);



        return [];



    }



});







ipcMain.handle('guardar-unidad-empaque-local', async (event, datos) => {



    try {



        if (!datos) return { success: false, error: 'Datos no proporcionados' };







        // Asegurar que las columnas existen dinámicamente si Electron no se ha reiniciado



        try { db.exec("ALTER TABLE unidades_empaque ADD COLUMN nombre_producto TEXT DEFAULT ''"); } catch (e) {}



        try { db.exec("ALTER TABLE unidades_empaque ADD COLUMN ultima_sincronizacion DATETIME DEFAULT (datetime('now', '-4 hours'))"); } catch (e) {}







        const id = (datos.id || datos.empaque_id || datos.empaque_ID || Date.now()).toString();



        const companyId = (datos.company_id || datos.companyId || datos.empresa_id || '').toString();



        const productId = (datos.product_id || datos.productId || datos.producto_id || '').toString();



        const nombreProducto = (datos.nombre_producto || datos.nombreProducto || datos.producto_nombre || '').toString();



        const nombreUnidad = (datos.nombre_unidad || datos.nombre || datos.unidad || 'Unidad').toString();



        const tipoMedida = (datos.tipo_medida || datos.medida || 'Unidades').toString();



        const factorCantidad = parseFloat(datos.factor_cantidad || datos.cantidad || 1.0) || 1.0;



        const estadoSync = datos.estado_sync !== undefined && datos.estado_sync !== null ? Number(datos.estado_sync) : 0;



        const fechaMod = (datos.fecha_modificacion || getCaracasTime()).toString();



        const ultimaSync = (datos.ultima_sincronizacion || getCaracasTime()).toString();







        const stmt = db.prepare(`



            INSERT OR REPLACE INTO unidades_empaque 



            (id, company_id, product_id, nombre_producto, nombre_unidad, tipo_medida, factor_cantidad, estado_sync, fecha_modificacion, ultima_sincronizacion)



            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)



        `);



        stmt.run(id, companyId, productId, nombreProducto, nombreUnidad, tipoMedida, factorCantidad, estadoSync, fechaMod, ultimaSync);



        return { success: true, id };



    } catch (e) {



        console.error("Error guardar unidad empaque:", e);



        return { success: false, error: e.message };



    }



});







ipcMain.handle('sincronizar-unidades-empaque-lote', async (event, lote) => {



    try {



        if (!Array.isArray(lote) || lote.length === 0) {



            return { success: true, count: 0 };



        }







        // Asegurar que las columnas existen dinámicamente si Electron no se ha reiniciado



        try { db.exec("ALTER TABLE unidades_empaque ADD COLUMN nombre_producto TEXT DEFAULT ''"); } catch (e) {}



        try { db.exec("ALTER TABLE unidades_empaque ADD COLUMN ultima_sincronizacion DATETIME DEFAULT (datetime('now', '-4 hours'))"); } catch (e) {}







        const stmt = db.prepare(`



            INSERT OR REPLACE INTO unidades_empaque 



            (id, company_id, product_id, nombre_producto, nombre_unidad, tipo_medida, factor_cantidad, estado_sync, fecha_modificacion, ultima_sincronizacion)



            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)



        `);







        const transaction = db.transaction((items) => {



            for (const item of items) {



                if (!item) continue;



                const id = (item.id || item.empaque_id || item.empaque_ID || Date.now()).toString();



                const companyId = (item.company_id || item.companyId || item.empresa_id || '').toString();



                const productId = (item.product_id || item.productId || item.producto_id || '').toString();



                const nombreProducto = (item.nombre_producto || item.nombreProducto || item.producto_nombre || '').toString();



                const nombreUnidad = (item.nombre_unidad || item.nombre || item.unidad || 'Unidad').toString();



                const tipoMedida = (item.tipo_medida || item.medida || 'Unidades').toString();



                const factorCantidad = parseFloat(item.factor_cantidad || item.cantidad || 1.0) || 1.0;



                const estadoSync = item.estado_sync !== undefined && item.estado_sync !== null ? Number(item.estado_sync) : 1;



                const fechaMod = (item.fecha_modificacion || getCaracasTime()).toString();



                const ultimaSync = (item.ultima_sincronizacion || getCaracasTime()).toString();







                stmt.run(id, companyId, productId, nombreProducto, nombreUnidad, tipoMedida, factorCantidad, estadoSync, fechaMod, ultimaSync);



            }



        });







        transaction(lote);



        return { success: true, count: lote.length };



    } catch (e) {



        console.error("Error sincronizando lote de unidades de empaque:", e.message);



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



        const branchId = salida.branchId || salida.sucursalId || 'principal';



        const unidad = salida.unidad || 'UN';



        const motivo = salida.motivo || 'Salida';



        const observacion = salida.observacion || '';



        const usuarioId = salida.usuarioId || 'admin';



        const estado_sync = salida.estado_sync || 0;







        const query = "INSERT INTO salidas_inventario (id, company_id, branch_id, product_id, cantidad, unidad, motivo, observacion, usuario_id, estado_sync) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";



        



        if (config.isServer && masterDbDirect) {



            try {



                masterDbDirect.prepare(query).run(



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



            } catch(eMaster) {



                console.error("Error guardando salida en masterDbDirect:", eMaster.message);



            }



        }







        try {



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



        } catch(eDb) {}







        return { success: true };



    } catch (e) {



        console.error("❌ Error guardar salida local:", e);



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







        if (config.isServer && masterDbDirect) {



            try {



                const res = masterDbDirect.prepare(query).all(params);



                if (res && res.length > 0) return res;



            } catch(eMaster) {}



        }







        return db.prepare(query).all(params);



    } catch (e) {



        console.error("❌ Error obtener salidas:", e);



        return [];



    }



});







// ==========================================



// GESTIÓN DE RESPALDOS LOCALES (BACKUP / RESTORE) EN ZIP CON AMBAS BASES DE DATOS



// ==============================================================================



const documentsDir = app.getPath('documents');



const backupsDir = path.join(documentsDir, 'Nexus POS Gobal', 'backups');



if (!fs.existsSync(backupsDir)) {



    try { fs.mkdirSync(backupsDir, { recursive: true }); } catch(e) {}



}







const autoBackupConfigFile = path.join(dbDir, 'auto_backup_config.json');







// Migración automática de respaldos anteriores si existían en dbDir



try {



    const legacyBackupsDir = path.join(dbDir, 'backups');



    if (fs.existsSync(legacyBackupsDir) && legacyBackupsDir !== backupsDir) {



        const oldFiles = fs.readdirSync(legacyBackupsDir);



        for (const file of oldFiles) {



            if (file.endsWith('.bak') || file.endsWith('.db') || file.endsWith('.zip')) {



                const oldPath = path.join(legacyBackupsDir, file);



                const newPath = path.join(backupsDir, file);



                if (!fs.existsSync(newPath)) {



                    fs.copyFileSync(oldPath, newPath);



                }



            }



        }



    }



} catch (eMigrate) {



    console.warn("Aviso al migrar respaldos previos:", eMigrate.message);



}







// Función Central de Creación de Respaldo ZIP (Manual y Automático)



async function crearArchivoRespaldoZip(tipo = 'MANUAL') {



    if (!fs.existsSync(backupsDir)) {



        fs.mkdirSync(backupsDir, { recursive: true });



    }







    const now = new Date();



    const yyyy = now.getFullYear();



    const mm = String(now.getMonth() + 1).padStart(2, '0');



    const dd = String(now.getDate()).padStart(2, '0');



    let h24 = now.getHours();



    const period = h24 >= 12 ? 'PM' : 'AM';



    const h12 = h24 % 12 || 12;



    const hh = String(h12).padStart(2, '0');



    const min = String(now.getMinutes()).padStart(2, '0');



    const ss = String(now.getSeconds()).padStart(2, '0');







    const prefix = (tipo === 'AUTOMATICO') ? 'Respaldo_Automatico' : 'Respaldo_Manual';



    const fileName = `${prefix}_${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}_${period}.zip`;



    const targetZipPath = path.join(backupsDir, fileName);







    const tempDir = path.join(app.getPath('temp'), `nexus_bkp_${Date.now()}_${Math.random().toString(36).substring(7)}`);



    fs.mkdirSync(tempDir, { recursive: true });







    const tempPosDb = path.join(tempDir, 'nexus_pos.db');



    const tempServerDb = path.join(tempDir, 'nexus-local-server.db');







    try {



        // 1. Respaldo atómico de nexus_pos.db



        try {



            await db.backup(tempPosDb);



        } catch (eBkp) {



            try { db.pragma('wal_checkpoint(PASSIVE)'); } catch(eW) {}



            if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, tempPosDb);



        }







        // 2. Respaldo de nexus-local-server.db si existe



        if (typeof masterDbDirect !== 'undefined' && masterDbDirect) {



            try {



                await masterDbDirect.backup(tempServerDb);



            } catch (eBkp2) {



                try { masterDbDirect.pragma('wal_checkpoint(PASSIVE)'); } catch(eW2) {}



                if (fs.existsSync(serverDbPath)) fs.copyFileSync(serverDbPath, tempServerDb);



            }



        } else if (fs.existsSync(serverDbPath)) {



            fs.copyFileSync(serverDbPath, tempServerDb);



        }







        // 3. Empaquetar en archivo .ZIP usando archiver



        const archiver = require('archiver');



        const output = fs.createWriteStream(targetZipPath);



        const archive = archiver('zip', { zlib: { level: 9 } });







        await new Promise((resolve, reject) => {



            output.on('close', resolve);



            output.on('error', reject);



            archive.on('error', reject);



            archive.pipe(output);







            if (fs.existsSync(tempPosDb)) {



                archive.file(tempPosDb, { name: 'nexus_pos.db' });



            }



            if (fs.existsSync(tempServerDb)) {



                archive.file(tempServerDb, { name: 'nexus-local-server.db' });



            }



            archive.finalize();



        });







        // Limpiar directorio temporal



        try {



            if (fs.existsSync(tempPosDb)) fs.unlinkSync(tempPosDb);



            if (fs.existsSync(tempServerDb)) fs.unlinkSync(tempServerDb);



            fs.rmdirSync(tempDir);



        } catch(eClean) {}







        const stats = fs.statSync(targetZipPath);



        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);







        console.log(`✅ [${tipo}] Respaldo ZIP creado con éxito: ${fileName} (${sizeMB} MB)`);







        return {



            success: true,



            fileName: fileName,



            tipo: tipo,



            size: sizeMB



        };



    } catch (e) {



        console.error(`❌ Error creando respaldo ZIP [${tipo}]:`, e.message);



        try {



            if (fs.existsSync(tempPosDb)) fs.unlinkSync(tempPosDb);



            if (fs.existsSync(tempServerDb)) fs.unlinkSync(tempServerDb);



            if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);



        } catch(eClean2) {}



        return { success: false, error: e.message };



    }



}







ipcMain.handle('obtener-ruta-respaldos', async () => {



    return backupsDir;



});







ipcMain.handle('abrir-carpeta-respaldos', async () => {



    try {



        const { shell } = require('electron');



        if (!fs.existsSync(backupsDir)) {



            fs.mkdirSync(backupsDir, { recursive: true });



        }



        await shell.openPath(backupsDir);



        return { success: true, path: backupsDir };



    } catch (e) {



        return { success: false, error: e.message };



    }



});







ipcMain.handle('obtener-respaldos-locales', async () => {



    try {



        if (!fs.existsSync(backupsDir)) return [];



        const files = fs.readdirSync(backupsDir);



        const backups = [];







        for (const file of files) {



            if (file.endsWith('.zip') || file.endsWith('.bak') || file.endsWith('.db')) {



                const fullPath = path.join(backupsDir, file);



                try {



                    const stats = fs.statSync(fullPath);



                    const isAuto = file.toLowerCase().includes('automatico') || file.toLowerCase().includes('automático');



                    backups.push({



                        fileName: file,



                        tipo: isAuto ? 'AUTOMATICO' : 'MANUAL',



                        size: (stats.size / (1024 * 1024)).toFixed(2),



                        createdAt: stats.birthtime || stats.mtime



                    });



                } catch(eStat) {}



            }



        }







        backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));



        return backups;



    } catch (e) {



        console.error("❌ Error al obtener respaldos locales:", e.message);



        return [];



    }



});







ipcMain.handle('crear-respaldo-local', async (event, tipo = 'MANUAL') => {



    return await crearArchivoRespaldoZip(tipo);



});







ipcMain.handle('eliminar-respaldo-local', async (event, fileName) => {



    try {



        const safeName = path.basename(fileName);



        const targetPath = path.join(backupsDir, safeName);



        if (fs.existsSync(targetPath)) {



            fs.unlinkSync(targetPath);



            return { success: true };



        }



        return { success: false, error: "Archivo no encontrado" };



    } catch (e) {



        console.error("❌ Error al eliminar respaldo local:", e.message);



        return { success: false, error: e.message };



    }



});







ipcMain.handle('restaurar-respaldo-local', async (event, fileName) => {



    try {



        const safeName = path.basename(fileName);



        const sourceZipPath = path.join(backupsDir, safeName);



        if (!fs.existsSync(sourceZipPath)) {



            return { success: false, error: "Archivo de respaldo no encontrado en la carpeta de respaldos." };



        }







        console.log(`🔄 [RESTAURACIÓN] Iniciando proceso de restauración desde: ${safeName}`);







        // 1. Tumbar el servidor maestro en el puerto 3000



        if (typeof cerebroProcess !== 'undefined' && cerebroProcess) {



            try {



                console.log("🛑 [RESTAURACIÓN] Apagando Servidor Maestro (puerto 3000)...");



                cerebroProcess.kill();



                cerebroProcess = null;



            } catch (eKill) {



                console.warn("Aviso cerrando servidor maestro:", eKill.message);



            }



        }







        // Breve pausa para asegurar liberación de sockets y puertos por el SO



        await new Promise(r => setTimeout(r, 400));







        // 2. Cerrar de forma segura las conexiones SQLite del proceso principal



        try { if (db) db.close(); } catch(eC1) {}



        try { if (typeof masterDbDirect !== 'undefined' && masterDbDirect) masterDbDirect.close(); } catch(eC2) {}







        // Breve pausa para que Windows libere los manejadores de archivo



        await new Promise(r => setTimeout(r, 200));







        // 3. Crear copia de seguridad preventiva en 'Documentos / Nexus POS Gobal / backups / respaldos_previos'



        const respaldosPreviosDir = path.join(backupsDir, 'respaldos_previos');



        if (!fs.existsSync(respaldosPreviosDir)) {



            fs.mkdirSync(respaldosPreviosDir, { recursive: true });



        }







        const now = new Date();



        const yyyy = now.getFullYear();



        const mm = String(now.getMonth() + 1).padStart(2, '0');



        const dd = String(now.getDate()).padStart(2, '0');



        let h24 = now.getHours();



        const period = h24 >= 12 ? 'PM' : 'AM';



        const h12 = h24 % 12 || 12;



        const hh = String(h12).padStart(2, '0');



        const min = String(now.getMinutes()).padStart(2, '0');



        const ss = String(now.getSeconds()).padStart(2, '0');







        const cleanTargetName = path.basename(safeName, path.extname(safeName));



        const preRestoreFileName = `Previo_a_${cleanTargetName}_el_${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}_${period}.zip`;



        const preRestoreZipPath = path.join(respaldosPreviosDir, preRestoreFileName);







        const archiver = require('archiver');



        const preOutput = fs.createWriteStream(preRestoreZipPath);



        const preArchive = archiver('zip', { zlib: { level: 9 } });







        await new Promise((resolve, reject) => {



            preOutput.on('close', resolve);



            preOutput.on('error', reject);



            preArchive.on('error', reject);



            preArchive.pipe(preOutput);







            if (fs.existsSync(dbPath)) preArchive.file(dbPath, { name: 'nexus_pos.db' });



            if (fs.existsSync(serverDbPath)) preArchive.file(serverDbPath, { name: 'nexus-local-server.db' });



            preArchive.finalize();



        });







        console.log(`🛡️ [RESTAURACIÓN] Copia previa de seguridad guardada con éxito en respaldos_previos: ${preRestoreFileName}`);







        // 4. Limpiar archivos transaccionales temporales WAL y SHM para evitar conflictos



        const tempWalFiles = [



            `${dbPath}-wal`, `${dbPath}-shm`,



            `${serverDbPath}-wal`, `${serverDbPath}-shm`



        ];



        tempWalFiles.forEach(f => {



            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(_) {}



        });







        // 5. Extraer y sobreescribir las bases de datos desde el ZIP elegido



        if (safeName.endsWith('.zip')) {



            const yauzl = require('yauzl');



            await new Promise((resolve, reject) => {



                yauzl.open(sourceZipPath, { lazyEntries: true }, (err, zipfile) => {



                    if (err) return reject(err);



                    zipfile.readEntry();



                    zipfile.on('entry', (entry) => {



                        let targetFile = null;



                        if (entry.fileName === 'nexus_pos.db') targetFile = dbPath;



                        else if (entry.fileName === 'nexus-local-server.db') targetFile = serverDbPath;







                        if (targetFile) {



                            zipfile.openReadStream(entry, (errStream, readStream) => {



                                if (errStream) return reject(errStream);



                                const writeStream = fs.createWriteStream(targetFile);



                                readStream.pipe(writeStream);



                                writeStream.on('close', () => zipfile.readEntry());



                                writeStream.on('error', reject);



                            });



                        } else {



                            zipfile.readEntry();



                        }



                    });



                    zipfile.on('end', resolve);



                    zipfile.on('error', reject);



                });



            });



        } else {



            // Compatibilidad hacia atrás con archivos .bak / .db antiguos



            fs.copyFileSync(sourceZipPath, dbPath);



        }







        // 6. Validar que la base de datos principal restaurada exista y tenga tamaño



        if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) {



            throw new Error("Fallo en la extracción: El archivo de base de datos restaurado quedó vacío o no existe.");



        }







        console.log("✅ [RESTAURACIÓN] Bases de datos reemplazadas exitosamente. Reiniciando aplicación...");







        // 7. Reiniciar el sistema



        setTimeout(() => {



            app.relaunch();



            app.exit(0);



        }, 1200);







        return {



            success: true,



            preBackupFile: preRestoreFileName



        };







    } catch (e) {



        console.error("❌ Error crítico al restaurar respaldo local:", e.message);



        return { success: false, error: e.message };



    }



});







// Guardar y sincronizar configuración de respaldo automático



ipcMain.handle('guardar-config-auto-backup', async (event, configData) => {



    try {



        const valAuto = (configData.enabled === true || configData.enabled === 'true') ? 'true' : 'false';



        const h12 = String(configData.hour || '06').padStart(2, '0');



        const min = String(configData.minute || '00').padStart(2, '0');



        const per = (configData.period || 'PM').toUpperCase();



        const formattedTime = configData.formatted || `${h12}:${min} ${per}`;







        // Guardar en la tabla configuracion de nexus_pos.db



        db.prepare(`



            INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion)



            VALUES ('backups_auto', ?, datetime('now', '-4 hours'))



        `).run(valAuto);







        db.prepare(`



            INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion)



            VALUES ('hora_backups', ?, datetime('now', '-4 hours'))



        `).run(formattedTime);







        // También en masterDbDirect si está presente



        if (typeof masterDbDirect !== 'undefined' && masterDbDirect) {



            try {



                masterDbDirect.prepare(`



                    INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion)



                    VALUES ('backups_auto', ?, datetime('now', '-4 hours'))



                `).run(valAuto);



                masterDbDirect.prepare(`



                    INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion)



                    VALUES ('hora_backups', ?, datetime('now', '-4 hours'))



                `).run(formattedTime);



            } catch (_) {}



        }







        // Cache sincronizado en archivo



        const fullConfig = {



            enabled: valAuto === 'true',



            hour: h12,



            minute: min,



            period: per,



            formatted: formattedTime,



            updatedAt: new Date().toISOString()



        };



        fs.writeFileSync(autoBackupConfigFile, JSON.stringify(fullConfig, null, 2), 'utf8');







        reprogramarBackupDaemon();



        console.log(`✅ [CONFIG BACKUP] Configuración guardada en SQLite: backups_auto=${valAuto}, hora_backups=${formattedTime}`);



        return { success: true };



    } catch(e) {



        console.error("Error guardando config de respaldo automático:", e.message);



        return { success: false, error: e.message };



    }



});







function parseHoraRespaldoConfig(horaStr) {



    if (!horaStr) return { hour24: 18, minute: 0, hour12: '06', minuteStr: '00', period: 'PM', formatted: '06:00 PM' };



    const str = String(horaStr).trim().toUpperCase();



    const isPM = str.includes('PM');



    const isAM = str.includes('AM');



    const clean = str.replace(/[A-Z]/g, '').trim();



    const parts = clean.split(':');



    let h = parseInt(parts[0], 10);



    let m = parts.length > 1 ? parseInt(parts[1], 10) : 0;



    if (isNaN(h)) h = 18;



    if (isNaN(m)) m = 0;







    let h24 = h;



    if (isPM && h < 12) h24 = h + 12;



    else if (isAM && h === 12) h24 = 0;



    else if (!isPM && !isAM) {



        if (h === 6) h24 = 18; // Default 6 PM



    }







    const h12Num = h24 % 12 || 12;



    const period = h24 >= 12 ? 'PM' : 'AM';



    const hour12 = String(h12Num).padStart(2, '0');



    const minuteStr = String(m).padStart(2, '0');



    const formatted = `${hour12}:${minuteStr} ${period}`;



    return { hour24: h24, minute: m, hour12, minuteStr, period, formatted };



}







ipcMain.handle('obtener-config-auto-backup', async () => {



    try {



        let rowAuto = null;



        let rowHora = null;







        try {



            rowAuto = db.prepare("SELECT valor FROM configuracion WHERE clave IN ('backups_auto', 'backup_auto')").get();



            rowHora = db.prepare("SELECT valor FROM configuracion WHERE clave = 'hora_backups'").get();



        } catch (_) {}







        // Si no existen todavía, sembrarlos con los valores predeterminados (true a las 6:00 PM)



        if (!rowAuto) {



            try {



                db.prepare("INSERT OR IGNORE INTO configuracion (clave, valor, fecha_actualizacion) VALUES ('backups_auto', 'true', datetime('now', '-4 hours'))").run();



                rowAuto = { valor: 'true' };



            } catch(_) {}



        }



        if (!rowHora) {



            try {



                db.prepare("INSERT OR IGNORE INTO configuracion (clave, valor, fecha_actualizacion) VALUES ('hora_backups', '06:00 PM', datetime('now', '-4 hours'))").run();



                rowHora = { valor: '06:00 PM' };



            } catch(_) {}



        }







        const isEnabled = rowAuto ? (rowAuto.valor === 'true' || rowAuto.valor === '1') : true;



        const horaStr = rowHora ? rowHora.valor : '06:00 PM';



        const parsed = parseHoraRespaldoConfig(horaStr);







        return {



            enabled: isEnabled,



            hour: parsed.hour12,



            minute: parsed.minuteStr,



            period: parsed.period,



            formatted: parsed.formatted



        };



    } catch(e) {



        console.error("Error al obtener config auto backup:", e.message);



        return { enabled: true, hour: '06', minute: '00', period: 'PM', formatted: '06:00 PM' };



    }



});







// ============================================================================



// 🛡️ DAEMON DE RESPALDOS AUTOMATICOS PROGRAMADOS



// ============================================================================



let backupDaemonTimer = null;







function reprogramarBackupDaemon() {



    if (backupDaemonTimer) {



        clearTimeout(backupDaemonTimer);



        backupDaemonTimer = null;



    }







    try {



        let rowAuto = null;



        let rowHora = null;







        try {



            rowAuto = db.prepare("SELECT valor FROM configuracion WHERE clave IN ('backups_auto', 'backup_auto')").get();



            rowHora = db.prepare("SELECT valor FROM configuracion WHERE clave = 'hora_backups'").get();



        } catch (_) {}







        // Fallback al archivo cache si la tabla no está lista



        let isEnabled = true;



        let horaStr = '06:00 PM';







        if (rowAuto) {



            isEnabled = (rowAuto.valor === 'true' || rowAuto.valor === '1');



        } else if (fs.existsSync(autoBackupConfigFile)) {



            try {



                const fCfg = JSON.parse(fs.readFileSync(autoBackupConfigFile, 'utf8'));



                isEnabled = !!fCfg.enabled;



            } catch (_) {}



        }







        if (rowHora && rowHora.valor) {



            horaStr = rowHora.valor;



        } else if (fs.existsSync(autoBackupConfigFile)) {



            try {



                const fCfg = JSON.parse(fs.readFileSync(autoBackupConfigFile, 'utf8'));



                if (fCfg.formatted) horaStr = fCfg.formatted;



            } catch (_) {}



        }







        if (!isEnabled) {



            console.log("[BACKUP DAEMON MAIN] ⏸️ Respaldos automáticos actualmente desactivados (backups_auto = false). Verificando nuevamente en 1 hora.");



            backupDaemonTimer = setTimeout(reprogramarBackupDaemon, 3600000);



            return;



        }







        const parsed = parseHoraRespaldoConfig(horaStr);



        const ahora = new Date();



        const proximo = new Date(ahora);



        proximo.setHours(parsed.hour24, parsed.minute, 0, 0);







        if (ahora.getTime() >= proximo.getTime()) {



            proximo.setDate(proximo.getDate() + 1);



        }







        const msParaEsperar = proximo.getTime() - ahora.getTime();







        backupDaemonTimer = setTimeout(async () => {



            try {



                // Revalidar en tiempo real si backups_auto sigue siendo true



                let checkAuto = null;



                try {



                    checkAuto = db.prepare("SELECT valor FROM configuracion WHERE clave IN ('backups_auto', 'backup_auto')").get();



                } catch (_) {}







                if (checkAuto && checkAuto.valor !== 'true') {



                    console.log("[BACKUP DAEMON MAIN] ⚠️ La hora llegó, pero backups_auto está desactivado. Omitiendo respaldo.");



                } else {



                    // Evitar duplicado si ya se creó un respaldo en los últimos 15 min (por server.js u otro proceso)



                    let reciente = false;



                    try {



                        if (fs.existsSync(backupsDir)) {



                            const files = fs.readdirSync(backupsDir);



                            const unaHoraAtras = Date.now() - (60 * 60 * 1000);



                            for (const f of files) {



                                if (f.startsWith('Respaldo_Automatico_') && f.endsWith('.zip')) {



                                    const st = fs.statSync(path.join(backupsDir, f));



                                    if (st.mtimeMs > unaHoraAtras) {



                                        reciente = true;



                                        break;



                                    }



                                }



                            }



                        }



                    } catch (_) {}







                    if (reciente) {



                        console.log("[BACKUP DAEMON MAIN] ℹ️ Respaldo automático reciente ya detectado. Omitiendo duplicado.");



                    } else {



                        console.log(`[BACKUP DAEMON MAIN] ⏰ Hora programada alcanzada (${parsed.formatted}). Ejecutando respaldo automático...`);



                        await crearArchivoRespaldoZip('AUTOMATICO');



                    }



                }



            } catch (errDaemon) {



                console.error("[BACKUP DAEMON MAIN] Error en ejecución programada:", errDaemon.message);



            }



            reprogramarBackupDaemon();



        }, msParaEsperar);







        const horasRestantes = (msParaEsperar / 3600000).toFixed(2);



        console.log(`🛡️ [BACKUP DAEMON MAIN] Programado para las ${parsed.formatted} (en ${horasRestantes} horas).`);



    } catch(e) {



        console.error("[BACKUP DAEMON MAIN] Error al programar:", e.message);



        backupDaemonTimer = setTimeout(reprogramarBackupDaemon, 3600000);



    }



}







// Iniciar daemon 5 segundos después del arranque



setTimeout(() => {



    try { reprogramarBackupDaemon(); } catch(e){}



}, 5000);




// ============================================================
// 🔌 RECONEXIÓN AUTOMÁTICA CAJA HIJA → MAESTRA (services/conexion-maestro.js)
// Túnel SSE único + watchdog local (sin polling). Ver cabecera del módulo.
// ============================================================
let gestorConexionMaestro = null;
let ultimoEstadoMaestro = { estado: 'detenido', ip: null };

function iniciarGestorConexionMaestro() {
    if (gestorConexionMaestro) return;
    const { crearGestorConexion } = require('./services/conexion-maestro');
    const { powerMonitor } = require('electron');

    gestorConexionMaestro = crearGestorConexion({
        getIpMaestro: () => getIpMaestro(),
        esMaestro: () => getIpMaestro() === '127.0.0.1',
        escanear: (ms) => escanearServidorMaestroLocal(ms),
        ping: (ip, ms) => pingServidorNexus(ip, ms),
        persistirIp: async (ip) => {
            db.prepare(`INSERT OR REPLACE INTO configuracion (clave, valor, fecha_actualizacion) VALUES ('serverIP', ?, ?)`)
                .run(ip, getCaracasTime());
            config.serverIP = ip;
            try {
                const cfgFile = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                cfgFile.serverIP = ip; if ('serverIp' in cfgFile) cfgFile.serverIp = ip;
                fs.writeFileSync(configPath, JSON.stringify(cfgFile, null, 2));
            } catch (_) {}
        },
        emitir: (payload) => {
            ultimoEstadoMaestro = payload;
            BrowserWindow.getAllWindows().forEach(w => {
                try { if (!w.isDestroyed()) w.webContents.send('estado-servidor-maestro', payload); } catch (_) {}
            });
        }
    });

    // Reanudar de suspensión / desbloquear: el socket suele estar muerto sin aviso
    powerMonitor.on('resume', () => setTimeout(() => gestorConexionMaestro.reconectarAhora('resume'), 1500));
    powerMonitor.on('unlock-screen', () => gestorConexionMaestro.reconectarAhora('unlock'));

    gestorConexionMaestro.iniciar();
}

ipcMain.handle('obtener-estado-servidor-maestro', () => gestorConexionMaestro ? { ...gestorConexionMaestro.obtenerEstado(), ...ultimoEstadoMaestro } : ultimoEstadoMaestro);
ipcMain.handle('reconectar-servidor-maestro', () => { if (gestorConexionMaestro) gestorConexionMaestro.reconectarAhora('renderer'); return true; });
// Tras guardar IP/modo en Configuración: reinicia el gestor con la nueva configuración
ipcMain.handle('reiniciar-gestor-conexion-maestro', () => { if (gestorConexionMaestro) gestorConexionMaestro.reiniciar(); else iniciarGestorConexionMaestro(); return true; });

app.whenReady().then(() => {
    setTimeout(() => { try { iniciarGestorConexionMaestro(); } catch (e) { console.error('[CONEXION-MAESTRO] No se pudo iniciar:', e.message); } }, 4000);
});
