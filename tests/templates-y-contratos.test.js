'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tf = require('../services/template-factura');
const tn = require('../services/template-recibo-nomina');
const tc = require('../services/template-comprobantes-cxc-cxp');
const { loadSchemaObject, ROOT } = require('./helpers/sqlite-test-db');

test('template-factura evita NaN/undefined en montos y genera HTML válido', () => {
    const html = tf.generarHTMLFactura({
        factura: {
            numero: '00001234',
            control: '00-001234',
            tasaCambio: undefined,
            fecha: '2026-05-15',
            hora: '02.30.00 p.m.',
        },
        subtotalUSD: 'no_numerico',
        totalUSD: NaN,
        subtotalBS: NaN,
        totalBS: Infinity,
        items: [
            { nombre: 'Producto Test', cantidad: 2, precio: 10, total: 20 },
        ],
    }, 'MEDIA_CARTA');

    const htmlSinBase64 = html.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '');
    assert.equal(/\bNaN\b/.test(htmlSinBase64), false, 'El HTML de factura no debe contener NaN en montos');
    assert.ok(html.includes('00001234'));
    assert.ok(html.includes('PRODUCTO TEST'));
});

test('template-recibo-nomina y template-comprobantes-cxc-cxp escapan HTML y renderizan documentos completos', () => {
    const htmlRecibo = tn.generarHTMLReciboNomina({
        empresa: { nombre: '<script>alert(1)</script>Comercializadora CA', rif: 'J-30111222-3' },
        periodo: { titulo: 'Quincena 1', fecha_inicio: '2026-05-01', fecha_fin: '2026-05-15', tasa_bcv: 50 },
        detalle: {
            empleado_nombre: '<img src=x onerror=alert(1)>María',
            empleado_cedula: 'V-15000111',
            sueldo_periodo_usd: 150,
            total_asignaciones_usd: 150,
            total_deducciones_usd: 8.25,
            neto_usd: 141.75,
            neto_bs: 7087.5,
        },
    });
    assert.equal(htmlRecibo.includes('<script>alert(1)'), false);
    assert.equal(htmlRecibo.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
    assert.equal(htmlRecibo.includes('<img src=x'), false);

    const htmlRet = tc.generarHTMLComprobanteRetencion({
        empresa: { nombre: 'Agente Retención CA', rif: 'J-30111222-3' },
        retencion: {
            tipo_impuesto: 'IVA',
            numero_comprobante: '20260500000001',
            fecha_emision: '2026-05-10',
            periodo_aaaamm: '202605',
            sujeto_nombre: 'Proveedor <Prueba>',
            sujeto_rif: 'J-30999888-7',
            porcentaje_retencion: 75,
            monto_retenido_bs: 600,
        },
        detalles: [{
            fecha_documento: '2026-05-05',
            numero_documento: '000100',
            numero_control: '00-00100',
            monto_total_bs: 5800,
            base_imponible_bs: 5000,
            monto_iva_bs: 800,
            monto_retenido_bs: 600,
        }],
    });
    assert.ok(htmlRet.includes('20260500000001'));
    assert.ok(htmlRet.includes('Proveedor &lt;Prueba&gt;'));
});

test('Esquemas SQLite maestro y local mantienen paridad crítica (claves_admin y reportes_fiscales_cierre)', () => {
    const local = loadSchemaObject('local');
    const maestro = loadSchemaObject('maestro');
    const maestroLocal = loadSchemaObject('maestroLocal');

    for (const col of ['permisos', 'is_master', 'code_hash']) {
        assert.ok(Object.prototype.hasOwnProperty.call(local.claves_admin_locales, col));
        assert.ok(Object.prototype.hasOwnProperty.call(maestro.claves_admin_maestras, col));
        assert.ok(Object.prototype.hasOwnProperty.call(maestroLocal.claves_admin_maestras, col));
    }
    assert.ok(local.reportes_fiscales_cierre);
    assert.ok(maestro.reportes_fiscales_cierre);
    assert.ok(maestroLocal.reportes_fiscales_cierre);
});

test('Contrato IPC entre preload.js y main.js permanece simétrico y sin duplicados', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

    const invokeSet = new Set();
    let m;
    const preRe = /ipcRenderer\.invoke\s*\(\s*(['"`])([^'"`]+)\1/g;
    while ((m = preRe.exec(preload)) !== null) invokeSet.add(m[2]);

    const handleCounts = new Map();
    const mainRe = /ipcMain\.handle\s*\(\s*(['"`])([^'"`]+)\1/g;
    while ((m = mainRe.exec(main)) !== null) {
        handleCounts.set(m[2], (handleCounts.get(m[2]) || 0) + 1);
    }

    for (const [ch, cnt] of handleCounts.entries()) {
        assert.equal(cnt, 1, `Canal IPC duplicado en main.js: ${ch}`);
    }
    for (const ch of invokeSet) {
        assert.ok(handleCounts.has(ch), `Canal IPC invocado en preload.js sin handler en main.js: ${ch}`);
    }
});
