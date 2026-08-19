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
    
    // Dimensiones y configuraciones por formato
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
                <td colspan="4" style="padding: 16px; text-align: center; color: #94a3b8; font-style: italic;">
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
                    <td style="padding: ${cfg.tablePadding}; font-weight: 700; color: #1e293b; text-align: left; text-transform: uppercase;">
                        ${concepto}
                    </td>
                    <td style="padding: ${cfg.tablePadding}; text-align: center; color: #334155; font-weight: 600;">
                        ${cantidad}
                    </td>
                    <td style="padding: ${cfg.tablePadding}; text-align: right; color: #334155; font-family: 'Consolas', monospace;">
                        ${precio.toFixed(2)}$
                    </td>
                    <td style="padding: ${cfg.tablePadding}; text-align: right; font-weight: 800; color: #0f172a; font-family: 'Consolas', monospace;">
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
            background-color: #f8fafc;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            font-size: ${cfg.fontSizeBase};
            color: #1e293b;
            background-color: #ffffff;
            width: 100%;
            max-width: ${cfg.pageWidth};
            min-height: ${cfg.pageHeight};
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
            }
            body {
                overflow: visible;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
                margin: 12px auto 24px auto;
            }
        }
        @media print {
            html, body {
                width: ${cfg.pageWidth};
                height: ${cfg.pageHeight};
                min-height: ${cfg.pageHeight};
                margin: 0;
                padding: ${cfg.padding};
                overflow: hidden;
                box-shadow: none;
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
        .payment-box-details {
            font-size: 9px;
            color: #64748b;
            margin-top: 2px;
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
            <div style="font-size: 8.5px; color: #64748b; margin-top: 4px; font-style: italic; line-height: 1.2;">
                * No representa una factura fiscal ni compromiso de entrega hasta su facturación definitiva.
            </div>` : ''}
        </div>

        <!-- Caja de Totales (Limpia, sin fondo negro) -->
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
