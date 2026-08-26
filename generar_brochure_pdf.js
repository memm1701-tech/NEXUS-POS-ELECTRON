const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

function renderPDF(htmlPath, outputPath) {
    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            show: false,
            width: 1200,
            height: 1600,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                webSecurity: false
            }
        });

        win.webContents.once('did-finish-load', async () => {
            try {
                await new Promise(r => setTimeout(r, 1000));
                const pdfData = await win.webContents.printToPDF({
                    landscape: false,
                    pageSize: 'Letter',
                    printBackground: true,
                    margins: {
                        marginType: 'none'
                    }
                });
                fs.writeFileSync(outputPath, pdfData);
                win.close();
                resolve(outputPath);
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
    try {
        const htmlPath = path.join(__dirname, 'Nexus_POS_Brochure_Imprimir.html');
        const pdfPath = path.join(__dirname, 'Nexus_POS_Dossier_Ejecutivo.pdf');

        console.log("📄 Generando PDF desde:", htmlPath);
        await renderPDF(htmlPath, pdfPath);
        console.log("✅ PDF generado con éxito en:", pdfPath);
    } catch (err) {
        console.error("❌ Error al generar PDF:", err);
    } finally {
        app.quit();
    }
});
