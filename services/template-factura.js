/**
 * Plantilla HTML/CSS para Facturación en PDF - Nexus POS
 * Soporte para formatos Estándar: MEDIA_CARTA, CARTA y OFICIO.
 * Carga de encabezado de 6 líneas, logotipo de configuración y estilos de factura/nota de entrega.
 */

const fs = require('fs');
const path = require('path');

function getBase64Logo() {
    try {
        const logoPath = path.join(__dirname, '..', 'assets', 'logo_nexus_sin_fondo.png');
        if (fs.existsSync(logoPath)) {
            const bitmap = fs.readFileSync(logoPath);
            return `data:image/png;base64,${bitmap.toString('base64')}`;
        }
    } catch (e) {
        console.error("No se pudo cargar el logo de assets:", e);
    }
    return '';
}

function generarHTMLFactura(datos = {}, formatoPapel = 'MEDIA_CARTA') {
    const logoDataUrl = datos.logoBase64 || getBase64Logo();
     // Dimensiones y configuraciones calibradas al 100% por formato
    const configFormatos = {
        'MEDIA_CARTA': {
            pageWidth: '216mm',
            pageHeight: '140mm',
            padding: '5mm 7mm',
            orientation: 'landscape',
            fontSizeBase: '10px',
            logoMaxHeight: '48px',
            logoMaxWidth: '160px',
            docTitleSize: '15px',
            empresaTitleSize: '11px',
            empresaDetalleSize: '8.5px',
            clientBoxPadding: '5px 8px',
            clientFontSize: '9px',
            tableHeaderPadding: '4px 6px',
            tableRowPadding: '3.5px 6px',
            tableFontSize: '9px',
            totalsBoxWidth: '220px',
            totalsFontSize: '10px',
            totalsMainAmountSize: '13.5px',
            cornerAccentSize: '55px',
            cornerOverlaySize: '32px'
        },
        'CARTA': {
            pageWidth: '216mm',
            pageHeight: '279mm',
            padding: '8mm 10mm',
            orientation: 'portrait',
            fontSizeBase: '11.5px',
            logoMaxHeight: '68px',
            logoMaxWidth: '220px',
            docTitleSize: '19px',
            empresaTitleSize: '13px',
            empresaDetalleSize: '9.5px',
            clientBoxPadding: '7px 12px',
            clientFontSize: '10.5px',
            tableHeaderPadding: '6px 10px',
            tableRowPadding: '6px 10px',
            tableFontSize: '10.5px',
            totalsBoxWidth: '260px',
            totalsFontSize: '11px',
            totalsMainAmountSize: '16px',
            cornerAccentSize: '85px',
            cornerOverlaySize: '50px'
        },
        'OFICIO': {
            pageWidth: '216mm',
            pageHeight: '356mm',
            padding: '10mm 12mm',
            orientation: 'portrait',
            fontSizeBase: '12px',
            logoMaxHeight: '75px',
            logoMaxWidth: '240px',
            docTitleSize: '20px',
            empresaTitleSize: '13.5px',
            empresaDetalleSize: '10px',
            clientBoxPadding: '8px 14px',
            clientFontSize: '11px',
            tableHeaderPadding: '7px 12px',
            tableRowPadding: '7px 12px',
            tableFontSize: '11px',
            totalsBoxWidth: '280px',
            totalsFontSize: '11.5px',
            totalsMainAmountSize: '17px',
            cornerAccentSize: '95px',
            cornerOverlaySize: '55px'
        }
    };

    const cfg = configFormatos[formatoPapel] || configFormatos['MEDIA_CARTA'];

    // Mapeo de tipo de documento y subtítulo
    const rawTipoDoc = (datos.factura?.tipoDocumento || datos.tipoDocumento || "NOTA DE ENTREGA").toUpperCase();
    const esPresupuesto = rawTipoDoc.includes('PRESUPUESTO') || rawTipoDoc.includes('COTIZACION') || rawTipoDoc.includes('COTIZACIÓN');
    const tipoDocumento = esPresupuesto ? "PRESUPUESTO / COTIZACIÓN" : rawTipoDoc;
    const subtituloSoftware = datos.subtituloSoftware || "Software Administrativo NEXUS POS";

    // Mapeo del encabezado de factura guardado en SQLite (Líneas 1 a 6)
    const encabezado = datos.encabezadoFactura || {};
    const razonSocial = (encabezado.line1 || datos.empresa?.nombre || "NEXUS COMPANY C.A.").trim();
    const rifEmpresa = (encabezado.line3 || datos.empresa?.rif || "J-50807000-3").trim();
    const domicilioFiscal = (encabezado.line4 || datos.empresa?.direccion || "Av. Bolívar Norte, Sector Centro, Valencia, Edo. Carabobo").trim();
    const contactoEmpresa = (encabezado.line5 || datos.empresa?.telefono || "0424-4543572 / info@nexusposglobal.com").trim();
    const sucursal = (encabezado.line6 || datos.empresa?.sucursal || "SUCURSAL PRINCIPAL - SEDE 1").trim();

    // Datos del cliente
    const cliente = datos.cliente || {
        nombre: "CONSUMIDOR FINAL",
        rif: "V-00000000",
        direccion: "No registrado",
        telefono: ""
    };

    // Datos de la factura
    const factura = datos.factura || {
        numero: "00001",
        control: "MAESTRO-001",
        fecha: new Date().toLocaleDateString('es-VE'),
        hora: new Date().toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }),
        condicion: "PAGADO",
        moneda: "USD",
        tasaCambio: 1.00
    };

    // Items / Productos
    const items = datos.items || [];

    // Cálculos de totales
    let subtotalUSD = 0;
    items.forEach(it => {
        const precio = parseFloat(it.precio || it.price || 0);
        const cant = parseFloat(it.cantidad || it.qty || 1);
        const tot = it.total !== undefined ? parseFloat(it.total) : (cant * precio);
        subtotalUSD += tot;
    });

    const ivaUSD = datos.montoIvaUSD || 0;
    const totalUSD = (datos.totalUSD !== undefined) ? parseFloat(datos.totalUSD) : (subtotalUSD + ivaUSD);
    const tasaCambio = parseFloat(factura.tasaCambio || 1);
    const subtotalBS = subtotalUSD * tasaCambio;
    const totalBS = (datos.totalBS !== undefined) ? parseFloat(datos.totalBS) : (totalUSD * tasaCambio);

    // Generar filas de tabla
    let filasHTML = "";
    if (items.length === 0) {
        filasHTML = `
            <tr>
                <td colspan="4" style="padding: 14px; text-align: center; color: #94a3b8; font-style: italic;">
                    Sin artículos registrados
                </td>
            </tr>
        `;
    } else {
        items.forEach((it, idx) => {
            const bgRow = idx % 2 === 0 ? "#ffffff" : "#f8fafc";
            const concepto = (it.concepto || it.nombre || it.name || "PRODUCTO").toUpperCase();
            const cantidad = parseFloat(it.cantidad || it.qty || 1);
            const precio = parseFloat(it.precio !== undefined ? it.precio : (it.price || 0));
            const totalFila = it.total !== undefined ? parseFloat(it.total) : (cantidad * precio);

            filasHTML += `
                <tr style="background-color: ${bgRow}; border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: ${cfg.tableRowPadding}; font-weight: 700; color: #1e293b; text-align: left; text-transform: uppercase;">
                        ${concepto}
                    </td>
                    <td style="padding: ${cfg.tableRowPadding}; text-align: center; color: #334155; font-weight: 600;">
                        ${cantidad}
                    </td>
                    <td style="padding: ${cfg.tableRowPadding}; text-align: right; color: #334155; font-family: 'Consolas', monospace;">
                        ${precio.toFixed(2)}$
                    </td>
                    <td style="padding: ${cfg.tableRowPadding}; text-align: right; font-weight: 800; color: #0f172a; font-family: 'Consolas', monospace;">
                        ${totalFila.toFixed(2)}$
                    </td>
                </tr>
            `;
        });
    }

    const isCredito = String(factura.condicion || '').toUpperCase().includes('CRÉDITO') || 
                      String(factura.condicion || '').toUpperCase().includes('CREDITO') || 
                      String(factura.condicion || '').toUpperCase().includes('DEUDA');

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>${tipoDocumento} ${factura.numero}</title>
    <style>
        @page {
            size: ${cfg.pageWidth} ${cfg.pageHeight};
            margin: 0;
        }
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        html {
            width: 100%;
            height: 100%;
            background-color: #f1f5f9;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            font-size: ${cfg.fontSizeBase};
            color: #1e293b;
            background-color: #ffffff;
            width: 100%;
            max-width: ${cfg.pageWidth};
            min-height: ${cfg.pageHeight};
            height: 100%;
            margin: 0 auto;
            padding: ${cfg.padding};
            position: relative;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
        }
        @media screen {
            html {
                overflow-y: auto;
                padding: 10px 0;
                display: flex;
                justify-content: center;
            }
            body {
                overflow: visible;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
                margin: 0 auto;
                height: auto;
            }
        }
        @media print {
            html, body {
                width: 100% !important;
                height: 100% !important;
                min-height: 100% !important;
                max-width: 100% !important;
                margin: 0 !important;
                padding: ${cfg.padding} !important;
                overflow: hidden !important;
                box-shadow: none !important;
                background-color: #ffffff !important;
            }
        }

        /* Acento geométrico inferior derecho de Nexus */
        .corner-accent {
            position: absolute;
            right: 0;
            bottom: 0;
            width: 0;
            height: 0;
            border-style: solid;
            border-width: 0 0 ${cfg.cornerAccentSize} ${cfg.cornerAccentSize};
            border-color: transparent transparent #00bcd4 transparent;
            z-index: 1;
            opacity: 0.95;
        }
        .corner-accent-overlay {
            position: absolute;
            right: 0;
            bottom: 0;
            width: 0;
            height: 0;
            border-style: solid;
            border-width: 0 0 ${cfg.cornerOverlaySize} ${cfg.cornerOverlaySize};
            border-color: transparent transparent #0288d1 transparent;
            z-index: 2;
        }

        /* ENCABEZADO SUPERIOR (100% ANCHO) */
        .header-top {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 16px;
            width: 100%;
            margin-bottom: 8px;
        }

        /* Columna Empresa y Logo */
        .company-info-col {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            flex: 1.3;
            min-width: 0;
        }
        .logo-img {
            max-height: ${cfg.logoMaxHeight};
            max-width: ${cfg.logoMaxWidth};
            width: auto;
            height: auto;
            object-fit: contain;
            display: block;
        }
        .company-text {
            display: flex;
            flex-direction: column;
            gap: 1.5px;
        }
        .empresa-nombre-grande {
            font-size: ${cfg.empresaTitleSize};
            font-weight: 900;
            color: #0f172a;
            text-transform: uppercase;
            letter-spacing: -0.2px;
            line-height: 1.15;
        }
        .empresa-detalle {
            font-size: ${cfg.empresaDetalleSize};
            color: #475569;
            line-height: 1.25;
        }
        .empresa-sucursal {
            font-size: ${cfg.empresaDetalleSize};
            font-weight: 700;
            color: #0284c7;
            text-transform: uppercase;
            margin-top: 1px;
        }

        /* Columna Documento y Metadatos */
        .doc-meta-col {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            text-align: right;
            flex: 1;
            min-width: 0;
            gap: 2px;
        }
        .title-doc {
            font-size: ${cfg.docTitleSize};
            font-weight: 900;
            letter-spacing: -0.5px;
            color: #0f172a;
            line-height: 1.1;
            text-transform: uppercase;
        }
        .subtitle-software {
            font-size: 8.5px;
            color: #64748b;
            font-weight: 500;
            margin-bottom: 3px;
        }
        .meta-badge-box {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 1.5px;
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            padding: 4px 10px;
            border-radius: 4px;
            width: fit-content;
        }
        .meta-num-row {
            font-size: 13px;
            font-weight: 800;
            color: #1e293b;
        }
        .meta-num-val {
            color: #e11d48;
            font-family: 'Consolas', monospace;
            font-weight: 900;
        }
        .meta-date {
            font-size: 9.5px;
            color: #475569;
            font-weight: 600;
        }
        .meta-control {
            font-size: 8.5px;
            color: #94a3b8;
            font-family: 'Consolas', monospace;
        }

        /* TARJETA DE CLIENTE (100% ANCHO, 2 COLUMNAS BALANCEADAS) */
        .client-card {
            width: 100%;
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 4px;
            padding: ${cfg.clientBoxPadding};
            font-size: ${cfg.clientFontSize};
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
            margin-bottom: 8px;
        }
        .client-card-col {
            display: flex;
            flex-direction: column;
            gap: 2.5px;
            flex: 1;
        }
        .client-row {
            display: flex;
            gap: 6px;
            line-height: 1.2;
        }
        .client-label {
            font-weight: 700;
            color: #64748b;
            min-width: 60px;
            text-transform: uppercase;
            font-size: 8.5px;
        }
        .client-value {
            color: #0f172a;
            font-weight: 700;
            word-break: break-word;
        }

        /* TABLA DE PRODUCTOS (100% ANCHO) */
        .table-container {
            width: 100%;
            flex: 1 1 auto;
            margin-bottom: 8px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            border: 1px solid #cbd5e1;
            border-radius: 4px;
            overflow: hidden;
            font-size: ${cfg.tableFontSize};
        }
        thead th {
            background-color: #0f172a;
            color: #ffffff;
            font-size: 9px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: ${cfg.tableHeaderPadding};
        }

        /* PIE DE FACTURA: FORMAS DE PAGO Y TOTALES (100% ANCHO) */
        .footer-section {
            width: 100%;
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            gap: 14px;
            position: relative;
            z-index: 10;
            margin-top: auto;
        }

        /* Caja de Forma de Pago / Validez */
        .payment-box {
            flex: 1;
            border: 1px solid #cbd5e1;
            background-color: #ffffff;
            border-radius: 4px;
            padding: 6px 12px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.02);
            font-size: 9.5px;
        }
        .payment-box-title {
            font-size: 8.5px;
            font-weight: 800;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border-bottom: 1px solid #e2e8f0;
            padding-bottom: 2px;
            margin-bottom: 4px;
        }
        .payment-box-content {
            font-size: 10.5px;
            color: #0f172a;
            font-weight: 700;
        }
        .payment-box-details {
            font-size: 8.5px;
            color: #64748b;
            margin-top: 2px;
        }

        /* Caja de Totales */
        .totals-box {
            width: ${cfg.totalsBoxWidth};
            border: 1px solid #cbd5e1;
            border-radius: 4px;
            overflow: hidden;
            background-color: #ffffff;
            box-shadow: 0 1px 2px rgba(0,0,0,0.02);
            flex-shrink: 0;
            font-size: ${cfg.totalsFontSize};
        }
        .totals-row {
            display: flex;
            justify-content: space-between;
            padding: 4px 10px;
        }
        .totals-row-subtotal {
            font-weight: 700;
            color: #475569;
            border-bottom: 1px solid #f1f5f9;
        }
        .totals-row-main {
            background-color: #f8fafc;
            color: #0f172a;
            padding: 6px 10px;
            font-weight: 900;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-top: 1px solid #e2e8f0;
        }
        .totals-main-amount {
            color: #e11d48;
            font-family: 'Consolas', monospace;
            font-size: ${cfg.totalsMainAmountSize};
            font-weight: 900;
        }
        .totals-bs-amount {
            font-size: 8.5px;
            color: #64748b;
            text-align: right;
            padding: 3px 10px;
            background-color: #ffffff;
            border-top: 1px dashed #e2e8f0;
            font-family: 'Consolas', monospace;
        }
    </style>
</head>
<body>

    <!-- Acento gráfico inferior estilo Nexus -->
    <div class="corner-accent"></div>
    <div class="corner-accent-overlay"></div>

    <!-- ENCABEZADO SUPERIOR: DATOS EMPRESA + TIPO DOC / NÚMERO -->
    <div class="header-top">
        <div class="company-info-col">
            ${logoDataUrl ? `<img src="${logoDataUrl}" class="logo-img" alt="Logo Empresa" />` : ''}
            <div class="company-text">
                ${razonSocial ? `<div class="empresa-nombre-grande">${razonSocial}</div>` : ''}
                ${rifEmpresa ? `<div class="empresa-detalle"><strong>RIF:</strong> ${rifEmpresa}</div>` : ''}
                ${domicilioFiscal ? `<div class="empresa-detalle">${domicilioFiscal}</div>` : ''}
                ${contactoEmpresa ? `<div class="empresa-detalle"><strong>Teléf:</strong> ${contactoEmpresa}</div>` : ''}
                ${sucursal ? `<div class="empresa-sucursal">📍 ${sucursal}</div>` : ''}
            </div>
        </div>

        <div class="doc-meta-col">
            <div class="title-doc">${tipoDocumento}</div>
            <div class="subtitle-software">${subtituloSoftware}</div>
            <div class="meta-badge-box">
                <div class="meta-num-row">N° <span class="meta-num-val">${factura.numero}</span></div>
                <div class="meta-date">Fecha: ${factura.fecha} ${factura.hora ? factura.hora : ''}</div>
                <div class="meta-control">Control: ${factura.control}</div>
            </div>
        </div>
    </div>

    <!-- TARJETA DE CLIENTE A 100% DE ANCHO -->
    <div class="client-card">
        <div class="client-card-col">
            <div class="client-row">
                <span class="client-label">Cliente:</span>
                <span class="client-value" style="color: #2563eb; text-transform: uppercase;">${cliente.nombre}</span>
            </div>
            <div class="client-row">
                <span class="client-label">RIF / CI:</span>
                <span class="client-value">${cliente.rif || 'V-00000000'}</span>
            </div>
        </div>
        <div class="client-card-col">
            <div class="client-row">
                <span class="client-label">Domicilio:</span>
                <span class="client-value">${cliente.direccion || 'No registrado'}</span>
            </div>
            <div class="client-row">
                <span class="client-label">Teléfono:</span>
                <span class="client-value">${cliente.telefono || 'No registrado'}</span>
            </div>
        </div>
    </div>

    <!-- TABLA DE PRODUCTOS A 100% DE ANCHO -->
    <div class="table-container">
        <table>
            <thead>
                <tr>
                    <th style="width: 52%; text-align: left;">CONCEPTO</th>
                    <th style="width: 14%; text-align: center;">CANTIDAD</th>
                    <th style="width: 17%; text-align: right;">PRECIO</th>
                    <th style="width: 17%; text-align: right;">TOTAL</th>
                </tr>
            </thead>
            <tbody>
                ${filasHTML}
            </tbody>
        </table>
    </div>

    <!-- SECCIÓN INFERIOR: CONDICIONES Y TOTALES (100% ANCHO) -->
    <div class="footer-section">
        <!-- Caja de Forma de Pago / Validez -->
        <div class="payment-box">
            <div class="payment-box-title">
                <span>${esPresupuesto ? 'CONDICIÓN / VALIDEZ' : 'FORMA DE PAGO'}</span>
            </div>
            <div class="payment-box-content">
                ${esPresupuesto ? 'COTIZACIÓN INFORMATIVA (VÁLIDA POR 1 DÍA)' : factura.condicion}
            </div>
            ${factura.tasaCambio && factura.tasaCambio > 1 ? `
            <div class="payment-box-details">
                Tasa Oficial BCV: Bs. ${factura.tasaCambio.toFixed(2)} por 1.00 USD
            </div>` : ''}
            ${esPresupuesto ? `
            <div style="font-size: 8px; color: #64748b; margin-top: 3px; font-style: italic; line-height: 1.15;">
                * No representa una factura fiscal ni compromiso de entrega hasta su facturación definitiva.
            </div>` : ''}
        </div>

        <!-- Caja de Totales -->
        <div class="totals-box">
            <div class="totals-row totals-row-subtotal">
                <span>SUBTOTAL</span>
                <span style="font-family: 'Consolas', monospace; font-weight: 700;">${subtotalUSD.toFixed(2)}$</span>
            </div>
            <div class="totals-row-main">
                <span>${esPresupuesto ? 'TOTAL PRESUPUESTO' : (isCredito ? 'TOTAL DEUDA' : 'TOTAL A PAGAR')}</span>
                <span class="totals-main-amount">${totalUSD.toFixed(2)}$</span>
            </div>
            <div class="totals-bs-amount">
                Equivalente Bs: ${totalBS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
        </div>
    </div>

</body>
</html>`;
}

module.exports = {
    generarHTMLFactura,
    getBase64Logo
};
