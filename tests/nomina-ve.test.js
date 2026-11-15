'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const nomina = require('../services/nomina-ve');
const { createSqliteTestDb } = require('./helpers/sqlite-test-db');

test('normalizarTextoAscii, obtenerDiasBaseFrecuencia y resolverMontoMovimientoUsd calculan correctamente', () => {
    assert.equal(nomina.normalizarTextoAscii('José María Ñandú #1'), 'JOSE MARIA NANDU 1');
    assert.equal(nomina.obtenerDiasBaseFrecuencia('SEMANAL'), 7);
    assert.equal(nomina.obtenerDiasBaseFrecuencia('QUINCENAL'), 15);
    assert.equal(nomina.obtenerDiasBaseFrecuencia('MENSUAL'), 30);

    assert.equal(nomina.resolverMontoMovimientoUsd({ monto: 45, moneda_origen: 'USD' }, 50), 45);
    assert.equal(nomina.resolverMontoMovimientoUsd({ monto_bs: 250, moneda_origen: 'BS' }, 50), 5);
});

test('calcularPrestacionesArt142VE calcula salario integral, garantía y retroactividad LOTTT Art. 142', () => {
    const res = nomina.calcularPrestacionesArt142VE(
        { sueldo_base: 300, fecha_ingreso: '2024-01-15' },
        50,
        '2026-05-15',
        100
    );
    assert.equal(res.tieneFechaIngreso, true);
    assert.equal(res.salarioIntegralDiarioUsd, 11.25);
    assert.equal(res.diasRetroactividad, 60);
    assert.equal(res.retroactividadUsd, 675);
    assert.ok(res.garantiaUsd > res.retroactividadUsd);
    assert.equal(res.metodoAplicable, 'GARANTIA');
    assert.equal(res.netoDisponibleUsd, nomina.round2(res.brutoUsd - 100));
    assert.equal(res.netoDisponibleBs, nomina.round2(res.netoDisponibleUsd * 50));
});

test('calcularNominaEmpleadoVE calcula sueldo quincenal, cestaticket, parafiscales, movimientos y préstamos', () => {
    const calc = nomina.calcularNominaEmpleadoVE({
        empleado: {
            ID_empleado: 'emp_1',
            nombre: 'Carlos Pérez',
            cedula: '12345678',
            tipo_documento: 'V',
            sueldo_base: 300,
            bono_fijo_usd: 40,
            frecuencia_pago: 'QUINCENAL',
            fecha_ingreso: '2024-01-15',
            aplica_ivss: 1,
            aplica_faov: 1,
            aplica_rpe: 1,
            porcentaje_islr: 0,
            banco: '0134',
            numero_cuenta: '01340000000000000001',
        },
        movimientos: [
            { id: 'mov_bono', motivo: 'ingreso', tipo_movimiento: 'BONO', monto: 15, moneda_origen: 'USD', estado: 'PENDIENTE', fecha: '2026-05-10' },
            { id: 'mov_adelanto', motivo: 'egreso', tipo_movimiento: 'ADELANTO', moneda_origen: 'BS', monto_bs: 500, estado: 'PENDIENTE', fecha: '2026-05-11' },
        ],
        prestamos: [
            { id: 'pre_1', monto_cuota_usd: 10, saldo_pendiente_usd: 30, estado: 'ACTIVO' },
        ],
        opciones: { tasaBcv: 50, frecuencia: 'QUINCENAL' },
    });

    assert.equal(calc.sueldo_periodo_usd, 150);
    assert.equal(calc.cestaticket_usd, 20);
    assert.equal(calc.otros_ingresos_usd, 15);
    assert.equal(calc.total_asignaciones_usd, 185);
    assert.equal(calc.ivss_usd, 6);
    assert.equal(calc.faov_usd, 1.5);
    assert.equal(calc.rpe_usd, 0.75);
    assert.equal(calc.adelantos_usd, 10);
    assert.equal(calc.cuota_prestamo_usd, 10);
    assert.equal(calc.total_deducciones_usd, 28.25);
    assert.equal(calc.neto_usd, 156.75);
    assert.equal(calc.neto_bs, 7837.5);
    assert.equal(calc.sobregirado, false);
});

test('generarTxtDispersionBancariaVE genera archivo Banesco sin advertencias para cuenta de 20 dígitos', () => {
    const txt = nomina.generarTxtDispersionBancariaVE({
        bancoFormato: 'BANESCO',
        empresa: { nombre: 'Comercializadora Nexus', rif: 'J-30111222-3', cuenta_origen: '01340000000000000099' },
        periodo: { fecha_fin: '2026-05-15' },
        detalles: [{
            empleado_nombre: 'Ana María López',
            empleado_cedula: 'V-18222333',
            banco: '0134',
            numero_cuenta: '01340000000000000001',
            neto_bs: 8087.5,
            neto_usd: 161.75,
        }],
    });
    assert.equal(txt.advertencias.length, 0);
    assert.equal(txt.cantidadRegistros, 1);
    assert.equal(txt.totalBs, 8087.5);
    assert.ok(txt.contenido.startsWith('HDR|J301112223'));
    assert.ok(txt.contenido.includes('ANA MARIA LOPEZ'));
});

test('SQLite :memory: upsertEmpleadoDb, upsertMovimientoEmpleadoDb y recalcularSaldoEmpleadoDb funcionan de punta a punta', () => {
    const db = createSqliteTestDb('local');
    const ahora = '2026-05-15T12:00:00.000Z';

    const empId = nomina.upsertEmpleadoDb(db, {
        ID_empleado: 'emp_db_1',
        company_id: 'COMP_1',
        nombre: 'Pedro González',
        cedula: '20123456',
        sueldo_base: 400,
        bono_fijo_usd: 40,
        fecha_ingreso: '2025-01-01',
    }, ahora);

    assert.equal(empId, 'emp_db_1');
    nomina.upsertMovimientoEmpleadoDb(db, {
        id: 'mov_1',
        company_id: 'COMP_1',
        empleado_id: empId,
        tipo: 'BONO',
        descripcion: 'Bono puntualidad',
        monto_usd: 25,
        fecha: '2026-05-10',
        estado: 'PENDIENTE',
    }, ahora);

    nomina.recalcularSaldoEmpleadoDb(db, empId, 'COMP_1', 50, ahora);
    const empRow = db.prepare('SELECT saldo_pendiente FROM empleados WHERE ID_empleado = ?').get(empId);
    assert.equal(typeof empRow.saldo_pendiente, 'number');

    const perId = nomina.upsertNominaPeriodoDb(db, {
        id: 'per_1',
        company_id: 'COMP_1',
        titulo: '1ra Quincena Mayo 2026',
        frecuencia: 'QUINCENAL',
        fecha_inicio: '2026-05-01',
        fecha_fin: '2026-05-15',
        tasa_bcv: 50,
        total_neto_usd: 225,
        total_neto_bs: 11250,
    }, [{
        empleado_id: empId,
        empleado_nombre: 'Pedro González',
        empleado_cedula: 'V-20123456',
        sueldo_periodo_usd: 200,
        total_asignaciones_usd: 225,
        total_deducciones_usd: 0,
        neto_usd: 225,
        neto_bs: 11250,
    }], ahora);
    assert.equal(perId, 'per_1');
    const detCount = db.prepare('SELECT COUNT(*) AS n FROM nominas_detalle WHERE periodo_id = ?').get(perId).n;
    assert.equal(detCount, 1);
    db.close();
});
