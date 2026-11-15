'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ops = require('../services/operaciones-cxc-cxp');
const bi = require('../services/estadisticas-bi');
const { createSqliteTestDb } = require('./helpers/sqlite-test-db');

test('CxP guardarDocumentoCxpCompletoDb bloquea duplicados y emitirRetencionCxpIndependienteDb genera comprobante de 14 dígitos', () => {
    const db = createSqliteTestDb('local');
    db.prepare("INSERT INTO configuracion (clave, valor) VALUES ('TASA_BCV', '50')").run();
    db.prepare("INSERT INTO proveedores (nombre, rif, company_id) VALUES ('Distribuidora Sur', 'J-30123456-7', 'C1')").run();

    const doc = ops.guardarDocumentoCxpCompletoDb(db, {
        company_id: 'C1',
        proveedor_rif: 'J-30123456-7',
        proveedor_nombre: 'Distribuidora Sur',
        tipo_documento: 'FACTURA',
        comprobante: 'FAC-2026-01',
        numero_control: '00-00101',
        fecha: '2026-05-05',
        tasa_bcv: 50,
        base_imponible: 5000,
        monto_iva: 800,
        alicuota_iva: 16,
    });
    assert.equal(doc.exito, true);
    assert.equal(doc.documento.monto, 116);
    assert.equal(doc.documento.monto_bs, 5800);

    assert.throws(() => {
        ops.guardarDocumentoCxpCompletoDb(db, {
            company_id: 'C1',
            proveedor_rif: 'J-30123456-7',
            tipo_documento: 'FACTURA',
            comprobante: 'FAC-2026-01',
            fecha: '2026-05-05',
            tasa_bcv: 50,
            base_imponible: 5000,
        });
    }, err => err.code === 'DUPLICADO_CXP');

    const ret = ops.emitirRetencionCxpIndependienteDb(db, {
        company_id: 'C1',
        movimiento_cxp_id: doc.id,
        tipo_impuesto: 'IVA',
        porcentaje_retencion: 75,
        fecha_emision: '2026-05-06',
    });
    assert.equal(ret.exito, true);
    assert.match(ret.numero_comprobante, /^202605\d{8}$/);
    assert.equal(ret.calculo.monto_retenido_bs, 600);
    db.close();
});

test('CxC registrarAbonoCxcAvanzadoDb soporta transacciones SAVEPOINT anidadas, ND cambiaria y saldo a favor', () => {
    const db = createSqliteTestDb('local');
    db.prepare("INSERT INTO configuracion (clave, valor) VALUES ('TASA_BCV', '50')").run();
    db.prepare(`
        INSERT INTO cuentas_por_cobrar (id, company_id, factura_nro, cliente_id, cliente_nombre, monto_usd, monto_bs, monto_pagado, estado, fecha_vencimiento, tasa_emision, fecha)
        VALUES (1, 'C1', 'F-100', 'V11111111', 'Cliente Uno', 100, 4000, 0, 'PENDIENTE', '2026-06-01', 40, '2026-05-01')
    `).run();

    const abono = ops.registrarAbonoCxcAvanzadoDb(db, {
        company_id: 'C1',
        cliente_id: 'V11111111',
        cliente_nombre: 'Cliente Uno',
        factura_nro: 'F-100',
        monto_bs: 6000, // 120 USD a tasa 50 => amortiza 100 USD y deja 20 USD de saldo a favor
        tasa_bcv: 50,
        fecha: '2026-05-10',
        usuario: 'tester',
    });

    assert.equal(abono.exito, true);
    assert.equal(abono.saldo_restante_usd, 0);
    assert.equal(abono.saldo_a_favor_generado_usd, 20);
    assert.equal(abono.diferencial_cambiario_bs, 1000);
    assert.equal(abono.notas_debito_generadas.length, 1);
    assert.equal(abono.notas_debito_generadas[0].iva_bs, 137.93);

    const anticipo = db.prepare("SELECT saldo_disponible_usd, estado FROM anticipos_saldos_favor WHERE company_id = 'C1'").get();
    assert.equal(anticipo.saldo_disponible_usd, 20);
    assert.equal(anticipo.estado, 'DISPONIBLE');
    db.close();
});

test('Cierre cambiario mensual normaliza periodo YYYYMM en BI y excluye cierres REVERTIDO', () => {
    const db = createSqliteTestDb('local');
    db.prepare("INSERT INTO configuracion (clave, valor) VALUES ('tasa_bcv', '50')").run();
    db.prepare("INSERT INTO historial_tasas (fecha, valor, fuente) VALUES ('2026-05-15', 50, 'BCV')").run();
    db.prepare("INSERT INTO proveedores (nombre, rif, company_id) VALUES ('P1', 'J-30123456-7', 'C1')").run();

    ops.guardarDocumentoCxpCompletoDb(db, {
        company_id: 'C1',
        proveedor_rif: 'J-30123456-7',
        tipo_documento: 'FACTURA',
        comprobante: 'F1',
        fecha: '2026-05-01',
        tasa_bcv: 50,
        base_imponible: 5000,
        monto_iva: 800,
    });

    const cierre = ops.ejecutarCierreCambiarioMensualDb(db, {
        companyId: 'C1',
        modulo: 'CXP',
        periodoAAAAMM: '202605',
        tasaCierreBcv: 52,
        usuario: 'admin',
    });
    assert.equal(cierre.exito, true);
    assert.equal(cierre.diferencial_no_realizado_bs, 232);

    const genActivo = bi.obtenerEstadisticasGeneralesBiDb(db, {
        companyId: 'C1',
        fechaInicio: '2026-05-01',
        fechaFin: '2026-05-31',
    });
    assert.equal(genActivo.resultado_comercial_vs_cambiario.fuente_no_realizado, 'CIERRE_CAMBIARIO_MENSUAL');
    assert.equal(genActivo.resultado_comercial_vs_cambiario.diferencial_no_realizado_bs, -232);

    ops.revertirCierreCambiarioDiaUnoDb(db, {
        companyId: 'C1',
        cierreId: cierre.id,
        fechaReverso: '2026-06-01',
    });

    const genRevertido = bi.obtenerEstadisticasGeneralesBiDb(db, {
        companyId: 'C1',
        fechaInicio: '2026-05-01',
        fechaFin: '2026-05-31',
    });
    assert.equal(genRevertido.resultado_comercial_vs_cambiario.fuente_no_realizado, 'CARTERA_ABIERTA_VIVA');

    const esp = bi.obtenerEstadisticasEspecificasBiDb(db, {
        companyId: 'C1',
        fechaInicio: '2026-05-01',
        fechaFin: '2026-05-31',
    });
    assert.equal(esp.tasa_bcv_activa, 50);
    assert.ok(esp.cascada_y_tijera && esp.inventario_inteligencia && esp.proteccion_cambiaria_y_canales);
    db.close();
});
