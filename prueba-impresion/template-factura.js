/**
 * Plantilla HTML/CSS para Facturación en PDF - Nexus POS
 * Estructura exacta y fiel para Media Carta, Carta y Oficio.
 * Con soporte para 'NOTA DE ENTREGA', 'Software Administrativo NEXUS POS' y datos fiscales.
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
    
    // Parámetros y dimensiones según formato
    const configFormatos = {
        'MEDIA_CARTA': {
            pageWidth: '216mm',
            pageHeight: '140mm',
            padding: '8mm 10mm',
            orientation: 'landscape',
            fontSizeBase: '11px',
            tablePadding: '6px 10px',
            maxLogoHeight: '65px',
            maxLogoWidth: '230px'
        },
        'CARTA': {
            pageWidth: '216mm',
            pageHeight: '279mm',
            padding: '14mm 16mm',
            orientation: 'portrait',
            fontSizeBase: '12.5px',
            tablePadding: '8px 12px',
            maxLogoHeight: '80px',
            maxLogoWidth: '260px'
        },
        'OFICIO': {
            pageWidth: '216mm',
            pageHeight: '356mm',
            padding: '16mm 18mm',
            orientation: 'portrait',
            fontSizeBase: '13px',
            tablePadding: '10px 14px',
            maxLogoHeight: '90px',
            maxLogoWidth: '280px'
        }
    };

    const cfg = configFormatos[formatoPapel] || configFormatos['MEDIA_CARTA'];

    // Mapeo de tipo de documento y subtítulo
    const tipoDocumento = (datos.factura?.tipoDocumento || datos.tipoDocumento || "NOTA DE ENTREGA").toUpperCase();
    const subtituloSoftware = datos.subtituloSoftware || "Software Administrativo NEXUS POS";

    // Mapeo del encabezado de factura guardado en SQLite (Línea 1 a 6)
    const encabezado = datos.encabezadoFactura || {};
    const razonSocial = (encabezado.line1 || datos.empresa?.nombre || "NEXUS COMPANY C.A.").trim();
    const rifEmpresa = (encabezado.line3 || datos.empresa?.rif || "J-50807000-3").trim();
    const domicilioFiscal = (encabezado.line4 || datos.empresa?.direccion || "Av. Bolívar Norte, Sector Centro, Valencia, Edo. Carabobo").trim();
    const contactoEmpresa = (encabezado.line5 || datos.empresa?.telefono || "0424-4543572 / info@nexusposglobal.com").trim();
    const sucursal = (encabezado.line6 || datos.empresa?.sucursal || "SUCURSAL PRINCIPAL - SEDE 1").trim();

    // Datos del cliente
    const cliente = datos.cliente || {
        nombre: "MOISES",
        rif: "V-XXXXXXX",
        direccion: "No registrado",
        telefono: "0424-0000000"
    };

    // Datos de la factura
    const factura = datos.factura || {
        numero: "C-00009",
        control: "MAESTRO-001",
        fecha: "15/8/2026",
        hora: "07:25 AM",
        condicion: "Crédito Pendiente",
        moneda: "USD",
        tasaCambio: 41.60
    };

    // Items / Productos
    const items = datos.items || [
        { concepto: "KILOS CEBOLLA GRANDE", cantidad: 8, precio: 15.00, total: 120.00 }
    ];

    // Cálculos de totales
    let subtotalUSD = 0;
    items.forEach(it => { subtotalUSD += (it.total !== undefined ? it.total : (it.cantidad * it.precio)); });
    const ivaUSD = 0;
    const totalUSD = subtotalUSD + ivaUSD;
    const subtotalBS = subtotalUSD * factura.tasaCambio;
    const totalBS = totalUSD * factura.tasaCambio;

    // Generar filas de tabla
    let filasHTML = "";
    items.forEach((it, idx) => {
        const bgRow = idx % 2 === 0 ? "#ffffff" : "#f8fafc";
        filasHTML += `
            <tr style="background-color: ${bgRow}; border-bottom: 1px solid #e2e8f0;">
                <td style="padding: ${cfg.tablePadding}; font-weight: 700; color: #1e293b; text-align: left; text-transform: uppercase;">
                    ${it.concepto}
                </td>
                <td style="padding: ${cfg.tablePadding}; text-align: center; color: #334155; font-weight: 600;">
                    ${it.cantidad}
                </td>
                <td style="padding: ${cfg.tablePadding}; text-align: right; color: #334155; font-family: 'Consolas', monospace;">
                    ${it.precio.toFixed(2)}$
                </td>
                <td style="padding: ${cfg.tablePadding}; text-align: right; font-weight: 800; color: #0f172a; font-family: 'Consolas', monospace;">
                    ${it.total.toFixed(2)}$
                </td>
            </tr>
        `;
    });

    const isCredito = String(factura.condicion || '').toUpperCase().includes('CRÉDITO') || String(factura.condicion || '').toUpperCase().includes('CREDITO') || String(factura.condicion || '').toUpperCase().includes('DEUDA');

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
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            font-size: ${cfg.fontSizeBase};
            color: #1e293b;
            background-color: #ffffff;
            width: ${cfg.pageWidth};
            height: ${cfg.pageHeight};
            padding: ${cfg.padding};
            position: relative;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
        }

        /* Acento geométrico inferior derecho de Nexus */
        .corner-accent {
            position: absolute;
            right: 0;
            bottom: 0;
            width: 0;
            height: 0;
            border-style: solid;
            border-width: 0 0 110px 110px;
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
            border-width: 0 0 65px 65px;
            border-color: transparent transparent #0288d1 transparent;
            z-index: 2;
        }

        /* ENCABEZADO */
        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 14px;
            margin-bottom: 10px;
            padding-bottom: 6px;
        }

        /* Columna Izquierda: Logo, Tipo de Documento y Datos de la Empresa */
        .brand-col {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            flex: 1.25;
            min-width: 0;
        }

        /* Contenedor flexible de Logotipo */
        .logo-wrapper {
            display: flex;
            align-items: center;
            justify-content: flex-start;
            max-height: ${cfg.maxLogoHeight};
            max-width: ${cfg.maxLogoWidth};
            width: auto;
            height: auto;
            margin-bottom: 4px;
        }
        .logo-img {
            max-height: ${cfg.maxLogoHeight};
            max-width: ${cfg.maxLogoWidth};
            width: auto;
            height: auto;
            object-fit: contain;
            display: block;
        }

        .title-doc {
            font-size: 19px;
            font-weight: 900;
            letter-spacing: -0.5px;
            color: #0f172a;
            line-height: 1.1;
            text-transform: uppercase;
            margin-top: 2px;
        }
        .subtitle-software {
            font-size: 10px;
            color: #64748b;
            font-weight: 500;
            margin-top: 2px;
            margin-bottom: 5px;
        }
        .empresa-nombre-grande {
            font-size: 12px;
            font-weight: 800;
            color: #0f172a;
            text-transform: uppercase;
            letter-spacing: -0.2px;
            margin-bottom: 2px;
        }
        .empresa-detalle {
            font-size: 9.5px;
            color: #475569;
            line-height: 1.35;
        }
        .empresa-sucursal {
            font-size: 9.5px;
            font-weight: 700;
            color: #0284c7;
            text-transform: uppercase;
            margin-top: 2px;
        }

        /* Columna Central: Datos del Cliente */
        .client-col {
            display: flex;
            flex-direction: column;
            gap: 3.5px;
            font-size: 11px;
            flex: 1.1;
            background-color: #f1f5f9;
            padding: 9px 14px;
            border-radius: 8px;
            border: none;
        }
        .client-row {
            display: flex;
            gap: 6px;
            line-height: 1.25;
        }
        .client-label {
            font-weight: 700;
            color: #475569;
            min-width: 68px;
        }
        .client-value {
            color: #0f172a;
            font-weight: 600;
        }

        /* Columna Derecha: Metadatos del Documento */
        .meta-col {
            text-align: right;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 3px;
            flex: 0.85;
        }
        .meta-date {
            font-size: 11px;
            color: #475569;
            font-weight: 600;
        }
        .meta-num-row {
            font-size: 13.5px;
            font-weight: 800;
            color: #1e293b;
        }
        .meta-num-val {
            color: #e11d48;
            font-family: 'Consolas', monospace;
            font-weight: 900;
        }
        .meta-control {
            font-size: 9.5px;
            color: #94a3b8;
            font-family: 'Consolas', monospace;
            margin-top: 1px;
        }

        /* TABLA DE PRODUCTOS */
        .table-container {
            flex-grow: 1;
            margin-bottom: 10px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            border: 1px solid #cbd5e1;
            border-radius: 4px;
            overflow: hidden;
        }
        thead th {
            background-color: #1e293b;
            color: #ffffff;
            font-size: 10.5px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            padding: ${cfg.tablePadding};
        }

        /* PIE DE FACTURA: FORMAS DE PAGO Y TOTALES */
        .footer-section {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            gap: 16px;
            position: relative;
            z-index: 10;
        }

        /* Caja de Forma de Pago */
        .payment-box {
            flex: 1;
            border: 1px solid #cbd5e1;
            background-color: #ffffff;
            border-radius: 6px;
            padding: 8px 14px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.02);
        }
        .payment-box-title {
            font-size: 9.5px;
            font-weight: 800;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border-bottom: 1px solid #e2e8f0;
            padding-bottom: 3px;
            margin-bottom: 5px;
        }
        .payment-box-content {
            font-size: 11.5px;
            color: #1e293b;
            font-weight: 700;
        }

        /* Caja de Totales (Limpia sin fondo negro) */
        .totals-box {
            width: 260px;
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            overflow: hidden;
            background-color: #ffffff;
            box-shadow: 0 1px 2px rgba(0,0,0,0.02);
        }
        .totals-row {
            display: flex;
            justify-content: space-between;
            padding: 6px 14px;
            font-size: 11.5px;
        }
        .totals-row-subtotal {
            font-weight: 700;
            color: #475569;
            border-bottom: 1px solid #f1f5f9;
        }
        .totals-row-main {
            background-color: #f8fafc;
            color: #0f172a;
            padding: 8px 14px;
            font-weight: 900;
            font-size: 12.5px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-top: 1px solid #e2e8f0;
        }
        .totals-main-amount {
            color: #e11d48;
            font-family: 'Consolas', monospace;
            font-size: 16px;
            font-weight: 900;
        }
        .totals-bs-amount {
            font-size: 9.5px;
            color: #64748b;
            text-align: right;
            padding: 4px 14px;
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

    <!-- ENCABEZADO -->
    <div class="header">
        <!-- Columna 1: Logo, Tipo de Documento y Datos de la Empresa -->
        <div class="brand-col">
            ${logoDataUrl ? `
            <div class="logo-wrapper">
                <img src="${logoDataUrl}" class="logo-img" alt="Logo Empresa" />
            </div>` : ''}
            <div class="title-doc">${tipoDocumento}</div>
            <div class="subtitle-software">${subtituloSoftware}</div>
            ${razonSocial ? `<div class="empresa-nombre-grande">${razonSocial}</div>` : ''}
            ${rifEmpresa ? `<div class="empresa-detalle"><strong>RIF:</strong> ${rifEmpresa}</div>` : ''}
            ${domicilioFiscal ? `<div class="empresa-detalle">${domicilioFiscal}</div>` : ''}
            ${contactoEmpresa ? `<div class="empresa-detalle"><strong>Teléf:</strong> ${contactoEmpresa}</div>` : ''}
            ${sucursal ? `<div class="empresa-sucursal">📍 ${sucursal}</div>` : ''}
        </div>

        <!-- Columna 2: Datos del Cliente -->
        <div class="client-col">
            <div class="client-row">
                <span class="client-label">Cliente:</span>
                <span class="client-value" style="color: #2563eb; text-transform: uppercase;">${cliente.nombre}</span>
            </div>
            <div class="client-row">
                <span class="client-label">Domicilio:</span>
                <span class="client-value">${cliente.direccion || 'No registrado'}</span>
            </div>
            <div class="client-row">
                <span class="client-label">RIF/CI:</span>
                <span class="client-value">${cliente.rif || 'V-XXXXXXXX'}</span>
            </div>
            ${cliente.telefono ? `
            <div class="client-row">
                <span class="client-label">Contacto:</span>
                <span class="client-value">${cliente.telefono}</span>
            </div>` : ''}
        </div>

        <!-- Columna 3: Metadatos del Documento -->
        <div class="meta-col">
            <div class="meta-date">Fecha: ${factura.fecha}</div>
            <div class="meta-num-row">Número: <span class="meta-num-val">${factura.numero}</span></div>
            <div class="meta-control">Control: ${factura.control}</div>
        </div>
    </div>

    <!-- TABLA DE PRODUCTOS -->
    <div class="table-container">
        <table>
            <thead>
                <tr>
                    <th style="width: 55%; text-align: left;">CONCEPTO</th>
                    <th style="width: 15%; text-align: center;">CANTIDAD</th>
                    <th style="width: 15%; text-align: right;">PRECIO</th>
                    <th style="width: 15%; text-align: right;">TOTAL</th>
                </tr>
            </thead>
            <tbody>
                ${filasHTML}
            </tbody>
        </table>
    </div>

    <!-- SECCIÓN INFERIOR: FORMAS DE PAGO Y TOTALES -->
    <div class="footer-section">
        <!-- Caja de Forma de Pago -->
        <div class="payment-box">
            <div class="payment-box-title">
                <span>FORMA DE PAGO</span>
            </div>
            <div class="payment-box-content">
                ${factura.condicion}
            </div>
        </div>

        <!-- Caja de Totales (Limpia, sin fondo negro) -->
        <div class="totals-box">
            <div class="totals-row totals-row-subtotal">
                <span>SUBTOTAL</span>
                <span style="font-family: 'Consolas', monospace; font-weight: 700;">${subtotalUSD.toFixed(2)}$</span>
            </div>
            <div class="totals-row-main">
                <span>${isCredito ? 'TOTAL DEUDA' : 'TOTAL A PAGAR'}</span>
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
