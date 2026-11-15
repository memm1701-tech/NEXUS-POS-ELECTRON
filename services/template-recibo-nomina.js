/**
 * Plantilla HTML/CSS para Recibos de Pago de Nómina Bimoneda y Liquidación LOTTT - NEXUS POS
 * Compatible con CARTA y MEDIA_CARTA vía Electron printToPDF.
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
        console.error('No se pudo cargar el logo para recibo de nómina:', e.message);
    }
    return '';
}

function escapeHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
        return trimmed;
    }
    return '';
}

function fmtNum(val) {
    const num = Number(val || 0);
    return (Number.isFinite(num) ? num : 0).toLocaleString('es-VE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function generarHTMLReciboNomina(datos = {}, formatoPapel = 'CARTA') {
    const logoDataUrl = sanitizeImageUrl(datos.logoBase64 || getBase64Logo());
    const emp = datos.empresa || {};
    const periodo = datos.periodo || {};
    const det = datos.detalle || {};
    const tasa = Math.max(0.01, parseFloat(det.tasa_bcv || periodo.tasa_bcv || 1));

    const esMediaCarta = formatoPapel === 'MEDIA_CARTA';
    const pageCss = esMediaCarta
        ? '@page { size: 216mm 140mm; margin: 6mm 8mm; }'
        : '@page { size: letter portrait; margin: 10mm 12mm; }';

    const asignaciones = [];
    if (det.sueldo_periodo_usd > 0) asignaciones.push({ concepto: `Sueldo Base Período (${det.dias_efectivos || 15} días)`, usd: det.sueldo_periodo_usd });
    if (det.cestaticket_usd > 0) asignaciones.push({ concepto: 'Cestaticket / Bono Alimentación (No Salarial)', usd: det.cestaticket_usd });
    if (det.horas_extra_usd > 0) asignaciones.push({ concepto: 'Horas Extra / Feriados (Arts. 117-120 LOTTT)', usd: det.horas_extra_usd });
    if (det.comisiones_usd > 0) asignaciones.push({ concepto: 'Comisiones sobre Ventas', usd: det.comisiones_usd });
    if (det.otros_ingresos_usd > 0) asignaciones.push({ concepto: 'Otros Bonos e Ingresos del Período', usd: det.otros_ingresos_usd });

    const deducciones = [];
    if (det.ivss_usd > 0) deducciones.push({ concepto: 'Retención IVSS (4% Seguro Social)', usd: det.ivss_usd });
    if (det.faov_usd > 0) deducciones.push({ concepto: 'Retención FAOV (1% Ahorro Habitacional)', usd: det.faov_usd });
    if (det.rpe_usd > 0) deducciones.push({ concepto: 'Retención RPE (0.5% Rég. Prestacional de Empleo)', usd: det.rpe_usd });
    if (det.islr_usd > 0) deducciones.push({ concepto: 'Retención ISLR (AR-I)', usd: det.islr_usd });
    if (det.adelantos_usd > 0) deducciones.push({ concepto: 'Adelantos de Sueldo', usd: det.adelantos_usd });
    if (det.cuota_prestamo_usd > 0) deducciones.push({ concepto: 'Amortización Cuota de Préstamo Interno', usd: det.cuota_prestamo_usd });
    if (det.faltantes_caja_usd > 0) deducciones.push({ concepto: 'Descuento por Faltante / Descuadre de Caja', usd: det.faltantes_caja_usd });
    if (det.consumo_inventario_usd > 0) deducciones.push({ concepto: 'Descuento por Retiros / Consumo de Inventario', usd: det.consumo_inventario_usd });
    if (det.otros_descuentos_usd > 0) deducciones.push({ concepto: 'Otros Descuentos / Deducciones Internas', usd: det.otros_descuentos_usd });

    const maxRows = Math.max(asignaciones.length, deducciones.length, 4);
    let filasHtml = '';
    for (let i = 0; i < maxRows; i++) {
        const a = asignaciones[i];
        const d = deducciones[i];
        filasHtml += `
            <tr>
                <td>${a ? escapeHtml(a.concepto) : '&nbsp;'}</td>
                <td class="num">${a ? `$ ${fmtNum(a.usd)}` : ''}</td>
                <td class="num">${a ? `Bs. ${fmtNum(a.usd * tasa)}` : ''}</td>
                <td class="sep">${d ? escapeHtml(d.concepto) : '&nbsp;'}</td>
                <td class="num danger">${d ? `$ ${fmtNum(d.usd)}` : ''}</td>
                <td class="num danger">${d ? `Bs. ${fmtNum(d.usd * tasa)}` : ''}</td>
            </tr>
        `;
    }

    const encabezadoLineas = Array.isArray(datos.encabezadoFactura)
        ? datos.encabezadoFactura.filter(Boolean).slice(0, 4).map(l => `<div>${escapeHtml(l)}</div>`).join('')
        : `
            <div style="font-weight:700;font-size:13px;color:#0f172a;">${escapeHtml(emp.nombre || 'NEXUS POS COMERCIAL')}</div>
            <div>RIF: ${escapeHtml(emp.rif || 'N/A')} ${emp.telefono ? '| Tel: ' + escapeHtml(emp.telefono) : ''}</div>
            <div>${escapeHtml(emp.direccion || '')}</div>
        `;

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8" />
    <title>Recibo de Pago de Nómina</title>
    <style>
        ${pageCss}
        * { box-sizing: border-box; font-family: 'Segoe UI', Arial, sans-serif; }
        body { margin: 0; padding: 0; color: #1e293b; font-size: ${esMediaCarta ? '9.5px' : '11px'}; }
        .sheet { border: 1px solid #cbd5e1; border-radius: 6px; padding: ${esMediaCarta ? '8px 10px' : '14px 16px'}; }
        .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1e40af; padding-bottom: 8px; margin-bottom: 8px; }
        .brand { display: flex; gap: 10px; align-items: center; }
        .brand img { max-height: ${esMediaCarta ? '38px' : '54px'}; max-width: 150px; object-fit: contain; }
        .doc-box { text-align: right; }
        .doc-title { font-size: ${esMediaCarta ? '13px' : '16px'}; font-weight: 800; color: #1e3a8a; letter-spacing: 0.4px; }
        .doc-sub { font-size: 9.5px; color: #475569; margin-top: 2px; }
        .grid-info { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 5px; padding: 7px 10px; margin-bottom: 9px; font-size: ${esMediaCarta ? '9px' : '10px'}; }
        .lbl { font-size: 8px; text-transform: uppercase; color: #64748b; font-weight: 700; display: block; }
        .val { font-weight: 600; color: #0f172a; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
        th { background: #1e293b; color: #ffffff; font-size: ${esMediaCarta ? '8.5px' : '9.5px'}; text-transform: uppercase; padding: 5px 6px; text-align: left; }
        th.num, td.num { text-align: right; white-space: nowrap; }
        td { border-bottom: 1px solid #e2e8f0; padding: ${esMediaCarta ? '3px 5px' : '4.5px 6px'}; font-size: ${esMediaCarta ? '9px' : '10px'}; }
        td.sep, th.sep { border-left: 2px solid #cbd5e1; padding-left: 8px; }
        td.danger { color: #b91c1c; }
        .totales-row td { background: #f1f5f9; font-weight: 700; border-top: 1.5px solid #94a3b8; border-bottom: 1.5px solid #94a3b8; }
        .neto-banner { display: flex; justify-content: space-between; align-items: center; background: #eff6ff; border: 1.5px solid #3b82f6; border-radius: 6px; padding: ${esMediaCarta ? '6px 10px' : '9px 14px'}; margin-bottom: 10px; }
        .neto-monto { text-align: right; }
        .neto-usd { font-size: ${esMediaCarta ? '14px' : '18px'}; font-weight: 800; color: #1e3a8a; }
        .neto-bs { font-size: ${esMediaCarta ? '11px' : '13px'}; font-weight: 700; color: #047857; }
        .nota-lottt { font-size: 8.5px; color: #475569; margin-bottom: 14px; line-height: 1.35; }
        .firmas { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; margin-top: ${esMediaCarta ? '18px' : '28px'}; }
        .firma-linea { border-top: 1px solid #475569; text-align: center; padding-top: 4px; font-size: 9px; color: #334155; }
    </style>
</head>
<body>
    <div class="sheet">
        <div class="header">
            <div class="brand">
                ${logoDataUrl ? `<img src="${logoDataUrl}" alt="Logo" />` : ''}
                <div style="font-size:9.5px;color:#334155;line-height:1.35;">${encabezadoLineas}</div>
            </div>
            <div class="doc-box">
                <div class="doc-title">RECIBO DE PAGO DE NÓMINA</div>
                <div class="doc-sub">Art. 106 Decreto con Rango, Valor y Fuerza de LOTTT</div>
                <div class="doc-sub"><strong>Período:</strong> ${escapeHtml(periodo.codigo || periodo.id || '')} (${escapeHtml(periodo.fecha_inicio || '')} al ${escapeHtml(periodo.fecha_fin || '')})</div>
                <div class="doc-sub"><strong>Tasa BCV:</strong> Bs. ${fmtNum(tasa)} / USD | <strong>Frecuencia:</strong> ${escapeHtml(periodo.frecuencia || 'QUINCENAL')}</div>
            </div>
        </div>

        <div class="grid-info">
            <div><span class="lbl">Trabajador</span><span class="val">${escapeHtml(det.empleado_nombre || '')}</span></div>
            <div><span class="lbl">Cédula / Doc.</span><span class="val">${escapeHtml(det.empleado_cedula || '')}</span></div>
            <div><span class="lbl">Cargo</span><span class="val">${escapeHtml(det.empleado_cargo || 'N/A')}</span></div>
            <div><span class="lbl">Sueldo Base Mensual</span><span class="val">$ ${fmtNum(det.sueldo_base_mensual_usd || 0)}</span></div>
            <div><span class="lbl">Fecha de Ingreso</span><span class="val">${escapeHtml(det.fecha_ingreso || 'N/A')}</span></div>
            <div><span class="lbl">Días Pagados</span><span class="val">${escapeHtml(String(det.dias_efectivos || 15))} días</span></div>
            <div><span class="lbl">Banco / Cuenta</span><span class="val">${escapeHtml(det.banco || 'Efectivo / Caja')} ${det.numero_cuenta ? '• ' + escapeHtml(det.numero_cuenta.slice(-6)) : ''}</span></div>
            <div><span class="lbl">Garantía Prestaciones Art. 142</span><span class="val">$ ${fmtNum(det.prestaciones_acumuladas_usd || 0)}</span></div>
        </div>

        <table>
            <thead>
                <tr>
                    <th>Asignaciones / Devengos</th>
                    <th class="num">USD ($)</th>
                    <th class="num">Bolívares</th>
                    <th class="sep">Deducciones / Retenciones</th>
                    <th class="num">USD ($)</th>
                    <th class="num">Bolívares</th>
                </tr>
            </thead>
            <tbody>
                ${filasHtml}
                <tr class="totales-row">
                    <td>TOTAL ASIGNACIONES</td>
                    <td class="num">$ ${fmtNum(det.total_asignaciones_usd)}</td>
                    <td class="num">Bs. ${fmtNum(det.total_asignaciones_usd * tasa)}</td>
                    <td class="sep">TOTAL DEDUCCIONES</td>
                    <td class="num danger">$ ${fmtNum(det.total_deducciones_usd)}</td>
                    <td class="num danger">Bs. ${fmtNum(det.total_deducciones_usd * tasa)}</td>
                </tr>
            </tbody>
        </table>

        <div class="neto-banner">
            <div>
                <div style="font-weight:700;color:#1e3a8a;font-size:12px;">NETO A PAGAR AL TRABAJADOR</div>
                <div style="font-size:9px;color:#475569;">Método de pago: ${escapeHtml(periodo.metodo_pago || 'Transferencia Bancaria')}</div>
            </div>
            <div class="neto-monto">
                <div class="neto-usd">$ ${fmtNum(det.neto_usd)}</div>
                <div class="neto-bs">Bs. ${fmtNum(det.neto_bs)}</div>
            </div>
        </div>

        <div class="nota-lottt">
            Recibí conforme de la entidad de trabajo la cantidad arriba indicada por concepto de remuneración correspondiente al período señalado, dejando constancia de haber verificado las asignaciones y deducciones legales e internas descritas conforme al Art. 106 de la LOTTT.
        </div>

        <div class="firmas">
            <div class="firma-linea">Por la Empresa (Recursos Humanos / Administración)</div>
            <div class="firma-linea">Recibí Conforme — ${escapeHtml(det.empleado_nombre || '')} (${escapeHtml(det.empleado_cedula || '')})<br/>Huella / Fecha</div>
        </div>
    </div>
</body>
</html>`;
}

module.exports = {
    generarHTMLReciboNomina,
    escapeHtml
};
