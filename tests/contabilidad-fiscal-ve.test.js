'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fiscal = require('../services/contabilidad-fiscal-ve');

test('formatearHoraSNAT2026 convierte UTC a America/Caracas (UTC-4) y preserva horas locales explícitas', () => {
    const d = new Date('2026-05-10T18:30:45Z');
    assert.equal(fiscal.formatearHoraSNAT2026(d), '02.30.45 p.m.');
    assert.equal(fiscal.formatearHoraSNAT2026('2026-05-10T18:30:45.000Z'), '02.30.45 p.m.');
    assert.equal(fiscal.formatearHoraSNAT2026('2026-05-10 09:15:22'), '09.15.22 a.m.');
    assert.equal(fiscal.formatearHoraSNAT2026('08:05:09'), '08.05.09 a.m.');
    assert.match(fiscal.formatearHoraSNAT2026(), /^\d{2}\.\d{2}\.\d{2} [ap]\.m\.$/);
});

test('normalizarRifSENIAT, clasificarPersonaPorRif y construirComprobante14Digitos cumplen formato SENIAT', () => {
    assert.equal(fiscal.normalizarRifSENIAT('j-12345678-9', false), 'J123456789');
    assert.equal(fiscal.normalizarRifSENIAT('j123456789', true), 'J-12345678-9');
    assert.equal(fiscal.clasificarPersonaPorRif('J-30123456-7'), 'PJD');
    assert.equal(fiscal.clasificarPersonaPorRif('V-18500123-4'), 'PNR');
    assert.equal(fiscal.construirComprobante14Digitos('2026-05', 42), '20260500000042');
});

test('calcularRetencionIvaVE aplica 75%, 100% sin control y 100% metales preciosos', () => {
    const r75 = fiscal.calcularRetencionIvaVE({ montoIvaBs: 1600, tieneControl: true, ivaDiscriminado: true, proveedorPctDefault: 75 });
    assert.equal(r75.porcentaje_retencion, 75);
    assert.equal(r75.monto_retenido_bs, 1200);
    assert.equal(r75.iva_no_retenido_bs, 400);

    const rSinControl = fiscal.calcularRetencionIvaVE({ montoIvaBs: 1600, tieneControl: false });
    assert.equal(rSinControl.porcentaje_retencion, 100);
    assert.equal(rSinControl.monto_retenido_bs, 1600);

    const rMetal = fiscal.calcularRetencionIvaVE({ montoIvaBs: 1000, esMetalOPiedraPreciosa: true });
    assert.equal(rMetal.porcentaje_retencion, 100);
    assert.equal(rMetal.monto_retenido_bs, 1000);
});

test('calcularRetencionIslrDecreto1808 aplica sustraendo a PNR y alícuota sin sustraendo a PJD', () => {
    const pj = fiscal.calcularRetencionIslrDecreto1808({
        baseImponibleBs: 10000,
        rifRetenido: 'J-30000000-1',
        codigoConcepto: '053',
        utBs: 9,
    });
    assert.equal(pj.tipo_persona, 'PJD');
    assert.equal(pj.porcentaje_retencion, 2);
    assert.equal(pj.sustraendo_bs, 0);
    assert.equal(pj.monto_retenido_bs, 200);

    const pn = fiscal.calcularRetencionIslrDecreto1808({
        baseImponibleBs: 5000,
        rifRetenido: 'V-15000000-2',
        codigoConcepto: '053',
        utBs: 9,
    });
    assert.equal(pn.tipo_persona, 'PNR');
    assert.equal(pn.porcentaje_retencion, 1);
    assert.equal(pn.sustraendo_bs, 7.5);
    assert.equal(pn.monto_retenido_bs, 42.5);
});

test('calcularPrelacionCobroIgtfVE separa capital, retenciones e IGTF 3% en divisas', () => {
    const res = fiscal.calcularPrelacionCobroIgtfVE({
        saldoPendienteUsd: 100,
        tasaCobro: 50,
        montoRetencionIvaBs: 600, // 12 USD
        montoPagadoDivisasUsd: 50,
        divisaIncluyeIgtf: false,
        empresaEsSpeIgtf: true,
        pctIgtf: 3,
    });
    assert.equal(res.igtf_usd, 1.5);
    assert.equal(res.igtf_bs, 75);
    assert.equal(res.amortizacion_capital_usd, 62);
    assert.equal(res.amortizacion_capital_bs, 3100);
    assert.equal(res.excedente_saldo_a_favor_usd, 0);
});

test('evaluarAsimetriaDiferencialCambiario genera ND fiscal cuando sube BCV en régimen FISCAL_ND_ART51', () => {
    const sube = fiscal.evaluarAsimetriaDiferencialCambiario({
        modulo: 'CXC',
        modoFiscalEmpresa: 'FISCAL_ND_ART51',
        montoUsdAmortizado: 100,
        tasaOriginal: 40,
        tasaLiquidacion: 50,
        alicuotaIva: 16,
        esOperacionGravada: true,
    });
    assert.equal(sube.requiere_nota_debito_fiscal, true);
    assert.equal(sube.variacion_bruta_bs, 1000);
    assert.equal(sube.base_imponible_nd_bs, 862.07);
    assert.equal(sube.iva_nd_bs, 137.93);
});

test('calcularParticionCashea, calcularSemaforoBcvPago, calcularAgingDocumento y calcularForma80AduanaVE', () => {
    const cashea = fiscal.calcularParticionCashea({ montoTotalUsd: 200, montoInicialUsd: 50, comisionPct: 6.5, tasaBcv: 50 });
    assert.equal(cashea.saldo_cxc_cashea_usd, 150);
    assert.equal(cashea.comision_cashea_usd, 13);
    assert.equal(cashea.neto_esperado_plataforma_usd, 137);

    const sem = fiscal.calcularSemaforoBcvPago({ saldoUsd: 100, tasaEmision: 40, tasaHoy: 55, diasVencido: 10 });
    assert.equal(sem.color, 'AMARILLO');
    assert.equal(sem.codigo, 'EXPOSICION_ALZA_BCV');

    const aging = fiscal.calcularAgingDocumento({ fechaEmision: '2026-04-01', fechaVencimiento: '2026-04-16', fechaCorte: '2026-05-01' });
    assert.equal(aging.dias_vencido, 15);
    assert.equal(aging.vencida, true);
    assert.equal(aging.bucket, '0_30');

    const forma80 = fiscal.calcularForma80AduanaVE({ fobUsd: 1000, fleteUsd: 100, seguroUsd: 50, tasaAduanaBcv: 50, arancelPct: 10, tasaServicioPct: 1, alicuotaIva: 16 });
    assert.equal(forma80.cif_usd, 1150);
    assert.equal(forma80.cif_bs, 57500);
    assert.equal(forma80.iva_aduana_bs, 10212);
    assert.equal(forma80.total_tributos_aduana_bs, 16537);
});

test('generadores TXT/XML SENIAT y TXT proveedores producen salida válida sin advertencias cuando los datos están completos', () => {
    const txtIva = fiscal.generarTxtRetencionesIvaSENIAT({
        rifAgente: 'J-30111222-3',
        periodoAAAAMM: '202605',
        filas: [{
            fecha_documento: '2026-05-05',
            sujeto_rif: 'J-30999888-7',
            numero_documento: '00001234',
            numero_control: '00-001234',
            monto_total_bs: 1160,
            base_imponible_bs: 1000,
            monto_retenido_bs: 120,
            numero_comprobante: '20260500000001',
            alicuota_iva: 16,
        }],
    });
    assert.equal(txtIva.advertencias.length, 0);
    assert.equal(txtIva.cantidadRegistros, 1);
    assert.ok(txtIva.contenido.includes('J301112223\t202605\t2026-05-05'));
    assert.ok(txtIva.contenido.includes('20260500000001'));

    const xmlIslr = fiscal.generarXmlRetencionesIslrSENIAT({
        rifAgente: 'J-30111222-3',
        periodoAAAAMM: '202605',
        detalles: [{
            sujeto_rif: 'V-12345678-9',
            numero_documento: '000100',
            numero_control: '00-000100',
            fecha_documento: '2026-05-05',
            codigo_concepto_islr: '053',
            base_imponible_bs: 5000,
            porcentaje_retencion: 1,
        }],
    });
    assert.equal(xmlIslr.advertencias.length, 0);
    assert.ok(xmlIslr.contenido.startsWith('<?xml version="1.0"'));
    assert.ok(xmlIslr.contenido.includes('<RelacionRetencionesISLR RifAgente="J301112223" Periodo="202605">'));
    assert.ok(xmlIslr.contenido.includes('<RifRetenido>V123456789</RifRetenido>'));

    const txtBanco = fiscal.generarTxtPagosProveedoresVE({
        bancoFormato: 'BANESCO',
        empresa: { nombre: 'MI EMPRESA CA', rif: 'J-30111222-3', cuenta: '01340000000000000001' },
        fechaEjecucion: '2026-05-15',
        pagos: [{ proveedor_nombre: 'Proveedor ABC', proveedor_rif: 'J-30555666-7', cuenta_bancaria: '01340000000000000002', neto_bs: 2500.5 }],
    });
    assert.equal(txtBanco.advertencias.length, 0);
    assert.ok(txtBanco.contenido.includes('MI EMPRESA CA'));
    assert.ok(txtBanco.contenido.includes('0305556667'));
});
