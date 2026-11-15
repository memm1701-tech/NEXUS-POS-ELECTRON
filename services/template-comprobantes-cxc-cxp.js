/**
 * Plantillas PDF Bimonetarias para Comprobantes de Retención IVA / ISLR (PA SNAT/2026/00093 + SNAT/2025/000054 + Decreto 1808),
 * Estados de Cuenta CxC/CxP y Órdenes de Pago — NEXUS POS
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
    } catch (_) {}
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
    if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) return trimmed;
    return '';
}

function fmt(val) {
    const n = Number(val || 0);
    return (Number.isFinite(n) ? n : 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function cssBaseDocumento(formatoPapel = 'CARTA') {
    const pageRule = formatoPapel === 'MEDIA_CARTA'
        ? '@page { size: 216mm 140mm; margin: 6mm 8mm; }'
        : '@page { size: letter portrait; margin: 10mm 12mm; }';
    return `
        <style>
            ${pageRule}
            * { box-sizing: border-box; font-family: Arial, Helvetica, sans-serif; }
            body { margin: 0; color: #1f2937; font-size: 10px; line-height: 1.35; }
            .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1e3a8a; padding-bottom: 8px; margin-bottom: 10px; }
            .brand { display: flex; gap: 10px; align-items: center; }
            .brand img { max-height: 48px; max-width: 140px; }
            .brand-title { font-size: 13px; font-weight: 800; color: #111827; text-transform: uppercase; }
            .doc-badge { text-align: right; }
            .doc-title { font-size: 13px; font-weight: 800; color: #1e3a8a; text-transform: uppercase; }
            .doc-nro { font-family: monospace; font-size: 13px; font-weight: 700; color: #111827; background: #eff6ff; border: 1px solid #bfdbfe; padding: 3px 8px; display: inline-block; margin-top: 3px; }
            .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
            .box { border: 1px solid #d1d5db; border-radius: 4px; padding: 7px 9px; background: #f9fafb; }
            .box-title { font-size: 8.5px; font-weight: 800; color: #4b5563; text-transform: uppercase; border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; margin-bottom: 4px; }
            table { width: 100%; border-collapse: collapse; margin-top: 6px; }
            th { background: #1e3a8a; color: #ffffff; font-size: 8.5px; text-transform: uppercase; padding: 5px 6px; text-align: left; }
            td { border-bottom: 1px solid #e5e7eb; padding: 5px 6px; font-size: 9px; }
            .num { text-align: right; font-variant-numeric: tabular-nums; }
            .legal-note { margin-top: 10px; padding: 6px 8px; background: #f8fafc; border: 1px dashed #94a3b8; font-size: 8.5px; color: #475569; }
            .firmas { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 28px; text-align: center; }
            .firma-line { border-top: 1px solid #374151; padding-top: 4px; font-size: 9px; font-weight: 700; }
        </style>
    `;
}

/**
 * Comprobante oficial de Retención IVA (SNAT/2025/000054) o ISLR (Decreto 1808) conforme a PA SNAT/2026/00093.
 */
function generarHTMLComprobanteRetencion(datos = {}, formatoPapel = 'CARTA') {
    const emp = datos.empresa || {};
    const ret = datos.retencion || {};
    const logo = sanitizeImageUrl(datos.logoBase64 || getBase64Logo());
    const esIslr = String(ret.tipo_impuesto || 'IVA').toUpperCase() === 'ISLR';
    const titulo = esIslr
        ? 'Comprobante de Retención de I.S.L.R. (Decreto 1808)'
        : 'Comprobante de Retención de I.V.A. (PA SNAT/2025/000054)';

    const baseLegal = esIslr
        ? 'Decreto N° 1.808 (Reglamento Parcial Ley de ISLR en Materia de Retenciones) y Providencia SNAT/2026/00093 (Numeración 14 dígitos).'
        : 'Providencia Administrativa SNAT/2025/000054 (G.O. N° 43.171) y Providencia SNAT/2026/00093 Art. 18 (Comprobante 14 dígitos).';

    return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">${cssBaseDocumento(formatoPapel)}</head><body>
        <div class="header">
            <div class="brand">
                ${logo ? `<img src="${logo}" alt="Logo">` : ''}
                <div>
                    <div class="brand-title">${escapeHtml(emp.nombre || 'EMPRESA AGENTE DE RETENCIÓN')}</div>
                    <div><strong>RIF:</strong> ${escapeHtml(emp.rif || 'N/A')} | <strong>Período Fiscal:</strong> ${escapeHtml(ret.periodo_aaaamm || '')}</div>
                    <div>${escapeHtml(emp.direccion || '')}</div>
                </div>
            </div>
            <div class="doc-badge">
                <div class="doc-title">${titulo}</div>
                <div class="doc-nro">N° ${escapeHtml(ret.numero_comprobante || '')}</div>
                <div style="margin-top:4px;font-size:8.5px;">Fecha: ${escapeHtml(ret.fecha_emision || '')} | Tasa BCV: Bs ${fmt(ret.tasa_bcv || 1)}</div>
            </div>
        </div>

        <div class="grid-2">
            <div class="box">
                <div class="box-title">Agente de Retención</div>
                <div><strong>Razón Social:</strong> ${escapeHtml(emp.nombre || 'Agente de Retención')}</div>
                <div><strong>RIF:</strong> ${escapeHtml(emp.rif || 'N/A')}</div>
                <div><strong>Domicilio Fiscal:</strong> ${escapeHtml(emp.direccion || 'N/A')}</div>
            </div>
            <div class="box">
                <div class="box-title">Sujeto Retenido (Proveedor)</div>
                <div><strong>Nombre / Razón Social:</strong> ${escapeHtml(ret.sujeto_nombre || '')}</div>
                <div><strong>RIF:</strong> ${escapeHtml(ret.sujeto_rif || '')} (${escapeHtml(ret.tipo_persona || 'PJD')})</div>
                <div><strong>Tipo Op.:</strong> ${escapeHtml(ret.tipo_documento || '01')} - Factura / Doc.</div>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th>Fecha Doc.</th>
                    <th>N° Factura / Doc.</th>
                    <th>N° Control</th>
                    <th class="num">Total Doc. (Bs)</th>
                    <th class="num">Exento (E) (Bs)</th>
                    <th class="num">Base Imponible (Bs)</th>
                    ${esIslr ? '<th>Cód. Conc.</th>' : '<th class="num">Alíc. %</th><th class="num">IVA Causado (Bs)</th>'}
                    <th class="num">% Ret.</th>
                    ${esIslr ? '<th class="num">Sustraendo (Bs)</th>' : ''}
                    <th class="num">Imp. Retenido (Bs)</th>
                    <th class="num">Ref. USD</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>${escapeHtml(ret.fecha_documento || '')}</td>
                    <td><strong>${escapeHtml(ret.numero_documento || '')}</strong></td>
                    <td>${escapeHtml(ret.numero_control || '0')}</td>
                    <td class="num">${fmt(ret.monto_total_bs)}</td>
                    <td class="num">${fmt(ret.monto_exento_bs)} (E)</td>
                    <td class="num">${fmt(ret.base_imponible_bs)}</td>
                    ${esIslr
                        ? `<td>${escapeHtml(ret.codigo_concepto_islr || '053')}</td>`
                        : `<td class="num">${fmt(ret.alicuota_iva)}%</td><td class="num">${fmt(ret.impuesto_causado_bs)}</td>`}
                    <td class="num">${fmt(ret.porcentaje_retencion)}%</td>
                    ${esIslr ? `<td class="num">${fmt(ret.sustraendo_bs)}</td>` : ''}
                    <td class="num"><strong>Bs ${fmt(ret.monto_retenido_bs)}</strong></td>
                    <td class="num">$ ${fmt(ret.monto_retenido_usd)}</td>
                </tr>
            </tbody>
        </table>

        <div class="legal-note">
            <strong>Base Legal:</strong> ${escapeHtml(baseLegal)}<br>
            Documento emitido para constancia tributaria y deducción contable en el período fiscal correspondiente.
        </div>

        <div class="firmas">
            <div><div class="firma-line">Firma y Sello — Agente de Retención</div></div>
            <div><div class="firma-line">Recibido Conforme — Sujeto Retenido</div></div>
        </div>
    </body></html>`;
}

/**
 * Estado de Cuenta Bimonetario (CxC Cliente o CxP Proveedor) con desglose Aging.
 */
function generarHTMLEstadoCuenta(datos = {}, formatoPapel = 'CARTA') {
    const emp = datos.empresa || {};
    const ter = datos.tercero || {};
    const docs = Array.isArray(datos.documentos) ? datos.documentos : [];
    const aging = datos.aging || {};
    const modulo = String(datos.modulo || 'CXC').toUpperCase();
    const logo = sanitizeImageUrl(datos.logoBase64 || getBase64Logo());
    const tasa = Math.max(0.01, Number(datos.tasa_bcv || 1));

    const filas = docs.map(d => `
        <tr>
            <td>${escapeHtml(String(d.fecha || '').slice(0, 10))}</td>
            <td>${escapeHtml(d.fecha_vencimiento || '-')}</td>
            <td><strong>${escapeHtml(d.documento || d.factura_nro || d.comprobante || '-')}</strong></td>
            <td>${escapeHtml(d.estado || 'PENDIENTE')}</td>
            <td class="num">${Number(d.dias_vencido || 0) > 0 ? `<span style="color:#dc2626;font-weight:700;">+${d.dias_vencido}d</span>` : 'Al día'}</td>
            <td class="num">$ ${fmt(d.monto_usd)}</td>
            <td class="num">$ ${fmt(d.abonado_usd)}</td>
            <td class="num"><strong>$ ${fmt(d.saldo_usd)}</strong></td>
            <td class="num">Bs ${fmt((d.saldo_usd || 0) * tasa)}</td>
        </tr>
    `).join('');

    return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">${cssBaseDocumento(formatoPapel)}</head><body>
        <div class="header">
            <div class="brand">
                ${logo ? `<img src="${logo}" alt="Logo">` : ''}
                <div>
                    <div class="brand-title">${escapeHtml(emp.nombre || 'NEXUS POS')}</div>
                    <div>RIF: ${escapeHtml(emp.rif || '')} | Tasa BCV Referencial: Bs ${fmt(tasa)}</div>
                </div>
            </div>
            <div class="doc-badge">
                <div class="doc-title">Estado de Cuenta Bimonetario (${modulo === 'CXP' ? 'Proveedor CxP' : 'Cliente CxC'})</div>
                <div class="doc-nro">Corte: ${escapeHtml(datos.fecha_corte || '')}</div>
            </div>
        </div>
        <div class="box" style="margin-bottom:8px;">
            <div class="box-title">${modulo === 'CXP' ? 'Datos del Proveedor' : 'Datos del Cliente'}</div>
            <strong>${escapeHtml(ter.nombre || '')}</strong> | RIF: ${escapeHtml(ter.rif || '')} | Tel: ${escapeHtml(ter.telefono || 'N/A')}
            | <strong>Saldo a Favor Billetera:</strong> $ ${fmt(ter.saldo_a_favor_usd || 0)}
        </div>
        <table>
            <thead>
                <tr>
                    <th>Emisión</th><th>Vence</th><th>Documento</th><th>Estado</th><th class="num">Mora</th>
                    <th class="num">Total ($)</th><th class="num">Abonado ($)</th><th class="num">Saldo ($)</th><th class="num">Equiv. BCV (Bs)</th>
                </tr>
            </thead>
            <tbody>${filas || '<tr><td colspan="9" style="text-align:center;">Sin documentos abiertos</td></tr>'}</tbody>
        </table>
        <div class="grid-2" style="margin-top:10px;">
            <div class="box">
                <div class="box-title">Resumen Antigüedad de Saldos (Aging USD)</div>
                Por Vencer: $ ${fmt(aging.POR_VENCER)} | 1-30d: $ ${fmt(aging['0_30'])} | 31-60d: $ ${fmt(aging['31_60'])} | +60d: $ ${fmt((aging['61_90'] || 0) + (aging.MAS_90 || 0))}
            </div>
            <div class="box" style="text-align:right;">
                <div class="box-title">Total Saldo Pendiente Neto</div>
                <div style="font-size:14px;font-weight:800;color:#1e3a8a;">$ ${fmt(datos.total_saldo_usd || 0)}</div>
                <div>Equivalente BCV hoy: <strong>Bs ${fmt((datos.total_saldo_usd || 0) * tasa)}</strong></div>
            </div>
        </div>
    </body></html>`;
}

/**
 * Orden de Pago / Comprobante de Egreso Bimonetario CxP.
 */
function generarHTMLOrdenPagoCxp(datos = {}, formatoPapel = 'CARTA') {
    const emp = datos.empresa || {};
    const ord = datos.orden || {};
    const detalles = Array.isArray(datos.detalles) ? datos.detalles : [];
    const logo = sanitizeImageUrl(datos.logoBase64 || getBase64Logo());

    const filas = detalles.map(d => `
        <tr>
            <td>${escapeHtml(d.proveedor_nombre || d.proveedor_rif || '')}</td>
            <td>${escapeHtml(d.proveedor_rif || '')}</td>
            <td>${escapeHtml(d.comprobante || '')}</td>
            <td>${escapeHtml(d.cuenta_bancaria || 'N/A')}</td>
            <td class="num">$ ${fmt(d.neto_usd)}</td>
            <td class="num">Bs ${fmt(d.neto_bs)}</td>
        </tr>
    `).join('');

    return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">${cssBaseDocumento(formatoPapel)}</head><body>
        <div class="header">
            <div class="brand">
                ${logo ? `<img src="${logo}" alt="Logo">` : ''}
                <div>
                    <div class="brand-title">${escapeHtml(emp.nombre || 'NEXUS POS')}</div>
                    <div>RIF: ${escapeHtml(emp.rif || '')} | Banco Origen: ${escapeHtml(ord.banco_origen_alias || '')}</div>
                </div>
            </div>
            <div class="doc-badge">
                <div class="doc-title">Orden de Pago Programada (CxP)</div>
                <div class="doc-nro">${escapeHtml(ord.codigo_orden || ord.id || '')}</div>
                <div style="margin-top:4px;">Fecha Programada: ${escapeHtml(ord.fecha_programada || '')} | Tasa BCV: Bs ${fmt(ord.tasa_bcv || 1)}</div>
            </div>
        </div>
        <table>
            <thead>
                <tr><th>Proveedor</th><th>RIF</th><th>Documento</th><th>Cuenta Destino</th><th class="num">Neto ($)</th><th class="num">Neto (Bs)</th></tr>
            </thead>
            <tbody>${filas}</tbody>
        </table>
        <div class="box" style="margin-top:10px;text-align:right;">
            <strong>Total Orden (${detalles.length} factura(s)):</strong> $ ${fmt(ord.total_neto_usd)} / <strong>Bs ${fmt(ord.total_neto_bs)}</strong>
            | Semáforo Financiero: <strong>${escapeHtml(ord.semaforo_recomendacion || 'PROGRAMADO')}</strong>
        </div>
        <div class="firmas">
            <div><div class="firma-line">Elaborado / Tesorería</div></div>
            <div><div class="firma-line">Aprobado / Gerencia</div></div>
        </div>
    </body></html>`;
}

module.exports = {
    generarHTMLComprobanteRetencion,
    generarHTMLEstadoCuenta,
    generarHTMLOrdenPagoCxp
};
