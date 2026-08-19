/**
 * Script de prueba de generación de PDFs para Nexus POS
 * Carga la configuración real de SQLite (encabezadoFactura y logoFactura) y genera los PDFs de prueba.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { generarHTMLFactura } = require('./template-factura');

app.disableHardwareAcceleration();

function obtenerDatosConfiguracion() {
    let encabezadoFactura = {
        line1: "",
        line2: "",
        line3: "",
        line4: "",
        line5: "",
        line6: ""
    };
    let logoBase64 = '';

    const posiblesRutas = [
        path.join(process.env.APPDATA || '', 'nexus-pos', 'data', 'nexus_pos.db'),
        path.join(process.env.APPDATA || '', 'nexus-pos-global', 'nexus_pos.db'),
        path.join(process.env.APPDATA || '', 'nexus-pos', 'nexus_pos.db')
    ];

    for (const dbPath of posiblesRutas) {
        if (fs.existsSync(dbPath)) {
            try {
                console.log(`🔍 Conectando a Base de Datos en: ${dbPath}`);
                const db = new Database(dbPath, { readonly: true });
                const row = db.prepare("SELECT valor FROM configuracion WHERE clave = 'config_factura'").get();
                if (row && row.valor) {
                    const configFactura = JSON.parse(row.valor);
                    if (configFactura.encabezadoFactura) {
                        encabezadoFactura = { ...encabezadoFactura, ...configFactura.encabezadoFactura };
                    }
                    if (configFactura.logoFactura) {
                        logoBase64 = configFactura.logoFactura;
                        console.log(`🖼️ [LOGO] Se encontró logotipo guardado en config_factura (${logoBase64.length} chars).`);
                    }
                }
                db.close();
                if (logoBase64) break;
            } catch (e) {
                console.warn(`⚠️ Error leyendo ${dbPath}:`, e.message);
            }
        }
    }

    if (!logoBase64) {
        console.warn("⚠️ No se encontró logotipo en SQLite, buscando en assets...");
        const logoPath = path.join(__dirname, '..', 'assets', 'logo_nexus_sin_fondo.png');
        if (fs.existsSync(logoPath)) {
            const bitmap = fs.readFileSync(logoPath);
            logoBase64 = `data:image/png;base64,${bitmap.toString('base64')}`;
        }
    }

    return { encabezadoFactura, logoBase64 };
}

function renderPDF(htmlPath, printOptions) {
    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            show: false,
            width: 1200,
            height: 900,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                webSecurity: false
            }
        });

        win.webContents.once('did-finish-load', async () => {
            try {
                await new Promise(r => setTimeout(r, 600));
                const data = await win.webContents.printToPDF(printOptions);
                win.close();
                resolve(data);
            } catch (err) {
                win.close();
                reject(err);
            }
        });

        win.webContents.once('did-fail-load', (e, code, desc) => {
            win.close();
            reject(new Error(`Fallo al cargar (${code}): ${desc}`));
        });

        const fileUrl = 'file:///' + path.resolve(htmlPath).replace(/\\/g, '/');
        win.loadURL(fileUrl);
    });
}

app.whenReady().then(async () => {
    console.log("🚀 Iniciando generación de facturas de prueba...");

    const salidaDir = path.join(__dirname);
    if (!fs.existsSync(salidaDir)) {
        fs.mkdirSync(salidaDir, { recursive: true });
    }

    const { encabezadoFactura, logoBase64 } = obtenerDatosConfiguracion();

    const datosFactura = {
        encabezadoFactura,
        logoBase64,
        cliente: {
            nombre: "MOISES",
            rif: "V-XXXXXXX",
            direccion: "No registrado",
            telefono: ""
        },
        factura: {
            numero: "C-00009",
            control: "MAESTRO-001",
            fecha: "15/8/2026",
            hora: "07:25 AM",
            condicion: "Crédito Pendiente",
            moneda: "USD",
            tasaCambio: 41.60
        },
        items: [
            { concepto: "KILOS CEBOLLA GRANDE", cantidad: 8, precio: 15.00, total: 120.00 }
        ]
    };

    const formatos = [
        {
            nombre: 'MEDIA_CARTA',
            archivoPDF: 'factura_media_carta.pdf',
            archivoHTML: 'factura_media_carta.html',
            printOptions: {
                landscape: true,
                pageSize: { width: 216000, height: 140000 }, // 216mm x 140mm
                margins: { marginType: 'none' },
                printBackground: true
            }
        },
        {
            nombre: 'CARTA',
            archivoPDF: 'factura_carta.pdf',
            archivoHTML: 'factura_carta.html',
            printOptions: {
                landscape: false,
                pageSize: 'Letter',
                margins: { marginType: 'none' },
                printBackground: true
            }
        },
        {
            nombre: 'OFICIO',
            archivoPDF: 'factura_oficio.pdf',
            archivoHTML: 'factura_oficio.html',
            printOptions: {
                landscape: false,
                pageSize: 'Legal',
                margins: { marginType: 'none' },
                printBackground: true
            }
        }
    ];

    for (const fmt of formatos) {
        console.log(`📄 Generando formato: ${fmt.nombre}...`);
        
        const html = generarHTMLFactura(datosFactura, fmt.nombre);
        const rutaHTML = path.join(salidaDir, fmt.archivoHTML);
        fs.writeFileSync(rutaHTML, html, 'utf8');

        try {
            const pdfBuffer = await renderPDF(rutaHTML, fmt.printOptions);
            const rutaPDF = path.join(salidaDir, fmt.archivoPDF);
            fs.writeFileSync(rutaPDF, pdfBuffer);
            console.log(`   ✅ Guardado: ${rutaPDF} (${pdfBuffer.length} bytes)`);
        } catch (err) {
            console.error(`   ❌ Error al generar ${fmt.nombre}:`, err.message);
        }
    }

    console.log("\n🎉 ¡Facturas generadas exitosamente!");
    app.quit();
});
