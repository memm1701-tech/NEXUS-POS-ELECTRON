/**
 * Motor de Cálculo de Nómina Venezolana (LOTTT), Prestaciones Sociales (Art. 142)
 * y Dispersión Bancaria Interbancaria — NEXUS POS
 */

const CATALOGO_BANCOS_VE = [
    { codigo: '0134', nombre: 'Banesco', alias: 'BANESCO' },
    { codigo: '0105', nombre: 'Mercantil', alias: 'MERCANTIL' },
    { codigo: '0108', nombre: 'BBVA Provincial', alias: 'PROVINCIAL' },
    { codigo: '0102', nombre: 'Banco de Venezuela', alias: 'BDV' },
    { codigo: '0191', nombre: 'Banco Nacional de Crédito (BNC)', alias: 'BNC' },
    { codigo: '0114', nombre: 'Bancaribe', alias: 'BANCARIBE' },
    { codigo: '0172', nombre: 'Bancamiga', alias: 'BANCAMIGA' },
    { codigo: '0138', nombre: 'Banco Plaza', alias: 'PLAZA' },
    { codigo: '0115', nombre: 'Banco Exterior', alias: 'EXTERIOR' },
    { codigo: '0151', nombre: 'BFC Banco Fondo Común', alias: 'BFC' },
    { codigo: '0163', nombre: 'Banco del Tesoro', alias: 'TESORO' },
    { codigo: '0174', nombre: 'Banplus', alias: 'BANPLUS' },
    { codigo: '0128', nombre: 'Banco Caroní', alias: 'CARONI' },
    { codigo: '0157', nombre: 'DelSur Banco Universal', alias: 'DELSUR' },
    { codigo: '0168', nombre: 'Bancrecer', alias: 'BANCRECER' },
    { codigo: '0156', nombre: '100% Banco', alias: 'CIEN_POR_CIENTO' },
    { codigo: '0175', nombre: 'Banco Bicentenario / Digital Trabajadores', alias: 'BICENTENARIO' },
    { codigo: '0177', nombre: 'BANFANB', alias: 'BANFANB' },
    { codigo: '0169', nombre: 'R4 Banco Microfinanciero', alias: 'R4' }
];

const ESQUEMA_EMPLEADOS_Y_NOMINA = {
    empleados: {
        ID_empleado: "TEXT PRIMARY KEY",
        company_id: "TEXT",
        branch_id: "TEXT",
        tipo_documento: "TEXT DEFAULT 'V'",
        nombre: "TEXT",
        cedula: "TEXT",
        email: "TEXT",
        cargo: "TEXT",
        departamento: "TEXT DEFAULT 'General'",
        sueldo_base: "REAL DEFAULT 0",
        bono_fijo_usd: "REAL DEFAULT 40",
        comision_venta_pct: "REAL DEFAULT 0",
        frecuencia_pago: "TEXT DEFAULT 'QUINCENAL'",
        tipo_salario: "TEXT DEFAULT 'FIJO'",
        fecha_ingreso: "TEXT",
        fecha_egreso: "TEXT",
        aplica_ivss: "INTEGER DEFAULT 1",
        aplica_faov: "INTEGER DEFAULT 1",
        aplica_rpe: "INTEGER DEFAULT 1",
        porcentaje_islr: "REAL DEFAULT 0",
        banco: "TEXT",
        tipo_cuenta: "TEXT DEFAULT 'CORRIENTE'",
        numero_cuenta: "TEXT",
        pago_movil_banco: "TEXT",
        pago_movil_telefono: "TEXT",
        telefono: "TEXT",
        direccion: "TEXT",
        sucursal: "TEXT",
        usuario_uid: "TEXT",
        estatus_laboral: "TEXT DEFAULT 'ACTIVO'",
        saldo_pendiente: "REAL DEFAULT 0",
        datos_json: "TEXT",
        activo: "INTEGER DEFAULT 1",
        status: "INTEGER DEFAULT 1",
        estado_sync: "INTEGER DEFAULT 0",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))"
    },
    empleados_movimientos: {
        id: "TEXT PRIMARY KEY",
        empleado_id: "TEXT",
        company_id: "TEXT",
        branch_id: "TEXT",
        motivo: "TEXT",
        tipo_movimiento: "TEXT DEFAULT 'AJUSTE'",
        razon: "TEXT",
        monto: "REAL DEFAULT 0",
        moneda_origen: "TEXT DEFAULT 'USD'",
        monto_bs: "REAL DEFAULT 0",
        tasa_bcv: "REAL DEFAULT 1",
        horas: "REAL DEFAULT 0",
        periodo_id: "TEXT",
        prestamo_id: "TEXT",
        referencia_origen: "TEXT",
        metodo_pago: "TEXT",
        afecta_caja: "INTEGER DEFAULT 0",
        estado: "TEXT DEFAULT 'PENDIENTE'",
        usuario_registro: "TEXT",
        fecha: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    },
    empleados_prestamos: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT",
        branch_id: "TEXT",
        empleado_id: "TEXT",
        concepto: "TEXT",
        monto_total_usd: "REAL DEFAULT 0",
        tasa_bcv: "REAL DEFAULT 1",
        monto_total_bs: "REAL DEFAULT 0",
        cuotas_totales: "INTEGER DEFAULT 1",
        cuotas_pagadas: "INTEGER DEFAULT 0",
        monto_cuota_usd: "REAL DEFAULT 0",
        saldo_pendiente_usd: "REAL DEFAULT 0",
        frecuencia_descuento: "TEXT DEFAULT 'QUINCENAL'",
        metodo_pago: "TEXT",
        afecta_caja: "INTEGER DEFAULT 0",
        estado: "TEXT DEFAULT 'ACTIVO'",
        fecha_otorgamiento: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        fecha_modificacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    },
    empleados_asistencia: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT",
        branch_id: "TEXT",
        empleado_id: "TEXT",
        fecha: "TEXT",
        tipo_registro: "TEXT DEFAULT 'ASISTENCIA'",
        hora_entrada: "TEXT",
        hora_salida: "TEXT",
        horas_extra_diurnas: "REAL DEFAULT 0",
        horas_extra_nocturnas: "REAL DEFAULT 0",
        horas_feriado: "REAL DEFAULT 0",
        dias_descuento: "REAL DEFAULT 0",
        observacion: "TEXT",
        periodo_id: "TEXT",
        estado: "TEXT DEFAULT 'PENDIENTE'",
        estado_sync: "INTEGER DEFAULT 0",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))"
    },
    nominas_periodos: {
        id: "TEXT PRIMARY KEY",
        company_id: "TEXT",
        branch_id: "TEXT",
        codigo: "TEXT",
        titulo: "TEXT",
        frecuencia: "TEXT DEFAULT 'QUINCENAL'",
        fecha_inicio: "TEXT",
        fecha_fin: "TEXT",
        tasa_bcv: "REAL DEFAULT 1",
        cantidad_empleados: "INTEGER DEFAULT 0",
        total_asignaciones_usd: "REAL DEFAULT 0",
        total_deducciones_usd: "REAL DEFAULT 0",
        total_neto_usd: "REAL DEFAULT 0",
        total_neto_bs: "REAL DEFAULT 0",
        metodo_pago: "TEXT DEFAULT 'Transferencia Bancaria'",
        afecta_caja: "INTEGER DEFAULT 0",
        usuario_responsable: "TEXT",
        estado: "TEXT DEFAULT 'APROBADA'",
        observacion: "TEXT",
        datos_json: "TEXT",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    },
    nominas_detalle: {
        id: "TEXT PRIMARY KEY",
        periodo_id: "TEXT",
        company_id: "TEXT",
        branch_id: "TEXT",
        empleado_id: "TEXT",
        empleado_nombre: "TEXT",
        empleado_cedula: "TEXT",
        empleado_cargo: "TEXT",
        sueldo_base_mensual_usd: "REAL DEFAULT 0",
        sueldo_periodo_usd: "REAL DEFAULT 0",
        cestaticket_usd: "REAL DEFAULT 0",
        horas_extra_usd: "REAL DEFAULT 0",
        comisiones_usd: "REAL DEFAULT 0",
        otros_ingresos_usd: "REAL DEFAULT 0",
        total_asignaciones_usd: "REAL DEFAULT 0",
        ivss_usd: "REAL DEFAULT 0",
        faov_usd: "REAL DEFAULT 0",
        rpe_usd: "REAL DEFAULT 0",
        islr_usd: "REAL DEFAULT 0",
        adelantos_usd: "REAL DEFAULT 0",
        cuota_prestamo_usd: "REAL DEFAULT 0",
        otros_descuentos_usd: "REAL DEFAULT 0",
        total_deducciones_usd: "REAL DEFAULT 0",
        neto_usd: "REAL DEFAULT 0",
        tasa_bcv: "REAL DEFAULT 1",
        neto_bs: "REAL DEFAULT 0",
        prestaciones_acumuladas_usd: "REAL DEFAULT 0",
        banco: "TEXT",
        numero_cuenta: "TEXT",
        detalle_json: "TEXT",
        estado: "TEXT DEFAULT 'PAGADO'",
        fecha_creacion: "DATETIME DEFAULT (datetime('now', '-4 hours'))",
        estado_sync: "INTEGER DEFAULT 0"
    }
};

function construirFiltroEmpresaEmpleados(dbs, companyId, alias = '') {
    if (!companyId || companyId === 'undefined' || companyId === 'null' || String(companyId).trim() === '') {
        return { clause: '1=1', params: [] };
    }
    const compStr = String(companyId).trim();
    const prefix = alias ? `${alias}.` : '';
    const listaDbs = (Array.isArray(dbs) ? dbs : [dbs]).filter(Boolean);
    for (const d of listaDbs) {
        for (const [tbl, col] of [
            ['empleados', 'company_id'],
            ['ventas_locales', 'company_id'],
            ['sucursales', 'company_id'],
            ['usuarios_locales', 'companyId']
        ]) {
            try {
                const otro = d.prepare(`SELECT 1 FROM ${tbl} WHERE ${col} IS NOT NULL AND ${col} != '' AND ${col} != ? LIMIT 1`).get(compStr);
                if (otro) return { clause: `${prefix}company_id = ?`, params: [compStr] };
            } catch (_) {}
        }
    }
    return {
        clause: `(${prefix}company_id = ? OR ${prefix}company_id IS NULL OR ${prefix}company_id = '')`,
        params: [compStr]
    };
}

function upsertEmpleadoDb(conn, emp = {}, ahora = '', estadoSync = 0, opciones = {}) {
    if (!conn) throw new Error('Conexión SQLite requerida');
    const empId = String(emp.ID_empleado || emp.id || '').trim();
    if (!empId) throw new Error('ID_empleado requerido');
    const compId = String(emp.company_id || emp.companyId || '').trim();
    const toIntFlag = (val, def = 1) => (val === undefined || val === null ? def : (val ? 1 : 0));
    const statusNum = emp.status !== undefined && emp.status !== null ? Number(emp.status) : 1;
    const activoNum = statusNum === -1 ? 0 : toIntFlag(emp.activo, 1);
    const guardSync = opciones.soloSiNoPendiente ? 'WHERE empleados.estado_sync != 0' : '';

    const datosJsonStr = emp.datos_json
        ? (typeof emp.datos_json === 'string' ? emp.datos_json : JSON.stringify(emp.datos_json))
        : null;

    conn.prepare(`
        INSERT INTO empleados (
            ID_empleado, company_id, branch_id, tipo_documento, nombre, cedula, email, cargo, departamento,
            sueldo_base, bono_fijo_usd, comision_venta_pct, frecuencia_pago, tipo_salario, fecha_ingreso, fecha_egreso,
            aplica_ivss, aplica_faov, aplica_rpe, porcentaje_islr, banco, tipo_cuenta, numero_cuenta,
            pago_movil_banco, pago_movil_telefono, telefono, direccion, sucursal, usuario_uid, estatus_laboral,
            saldo_pendiente, datos_json, activo, status, estado_sync, fecha_creacion, fecha_modificacion
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ID_empleado) DO UPDATE SET
            company_id = COALESCE(NULLIF(excluded.company_id, ''), empleados.company_id),
            branch_id = COALESCE(NULLIF(excluded.branch_id, ''), empleados.branch_id),
            tipo_documento = COALESCE(NULLIF(excluded.tipo_documento, ''), empleados.tipo_documento),
            nombre = excluded.nombre,
            cedula = excluded.cedula,
            email = excluded.email,
            cargo = excluded.cargo,
            departamento = excluded.departamento,
            sueldo_base = excluded.sueldo_base,
            bono_fijo_usd = excluded.bono_fijo_usd,
            comision_venta_pct = excluded.comision_venta_pct,
            frecuencia_pago = excluded.frecuencia_pago,
            tipo_salario = excluded.tipo_salario,
            fecha_ingreso = COALESCE(NULLIF(excluded.fecha_ingreso, ''), empleados.fecha_ingreso),
            fecha_egreso = excluded.fecha_egreso,
            aplica_ivss = excluded.aplica_ivss,
            aplica_faov = excluded.aplica_faov,
            aplica_rpe = excluded.aplica_rpe,
            porcentaje_islr = excluded.porcentaje_islr,
            banco = excluded.banco,
            tipo_cuenta = excluded.tipo_cuenta,
            numero_cuenta = excluded.numero_cuenta,
            pago_movil_banco = excluded.pago_movil_banco,
            pago_movil_telefono = excluded.pago_movil_telefono,
            telefono = excluded.telefono,
            direccion = excluded.direccion,
            sucursal = excluded.sucursal,
            usuario_uid = COALESCE(NULLIF(excluded.usuario_uid, ''), empleados.usuario_uid),
            estatus_laboral = excluded.estatus_laboral,
            saldo_pendiente = COALESCE(excluded.saldo_pendiente, empleados.saldo_pendiente),
            datos_json = COALESCE(excluded.datos_json, empleados.datos_json),
            activo = excluded.activo,
            status = excluded.status,
            estado_sync = excluded.estado_sync,
            fecha_modificacion = excluded.fecha_modificacion
        ${guardSync}
    `).run(
        empId,
        compId,
        String(emp.branch_id || emp.branchId || '').trim(),
        String(emp.tipo_documento || 'V').toUpperCase().slice(0, 1),
        String(emp.nombre || '').trim(),
        limpiarSoloDigitos(emp.cedula) || String(emp.cedula || '').trim(),
        String(emp.email || '').trim(),
        String(emp.cargo || '').trim(),
        String(emp.departamento || 'General').trim(),
        round2(parseFloat(emp.sueldo_base ?? emp.sueldoBase ?? 0)),
        round2(parseFloat(emp.bono_fijo_usd ?? 40)),
        round2(parseFloat(emp.comision_venta_pct ?? 0)),
        String(emp.frecuencia_pago || 'QUINCENAL').toUpperCase(),
        String(emp.tipo_salario || 'FIJO').toUpperCase(),
        String(emp.fecha_ingreso || (emp.fecha_creacion ? String(emp.fecha_creacion).slice(0, 10) : (ahora ? ahora.slice(0, 10) : ''))).trim(),
        String(emp.fecha_egreso || '').trim(),
        toIntFlag(emp.aplica_ivss, 1),
        toIntFlag(emp.aplica_faov, 1),
        toIntFlag(emp.aplica_rpe, 1),
        round2(parseFloat(emp.porcentaje_islr ?? 0)),
        String(emp.banco || '').trim(),
        String(emp.tipo_cuenta || 'CORRIENTE').toUpperCase(),
        limpiarSoloDigitos(emp.numero_cuenta),
        String(emp.pago_movil_banco || '').trim(),
        limpiarSoloDigitos(emp.pago_movil_telefono),
        String(emp.telefono || '').trim(),
        String(emp.direccion || '').trim(),
        String(emp.sucursal || '').trim(),
        String(emp.usuario_uid || '').trim(),
        String(emp.estatus_laboral || 'ACTIVO').toUpperCase(),
        round2(parseFloat(emp.saldo_pendiente ?? 0)),
        datosJsonStr,
        activoNum,
        statusNum,
        estadoSync,
        emp.fecha_creacion || ahora,
        ahora
    );
    return empId;
}

function upsertMovimientoEmpleadoDb(conn, mov = {}, ahora = '', estadoSync = 0, opciones = {}) {
    if (!conn) throw new Error('Conexión SQLite requerida');
    const idMov = String(mov.id || `MOV-${Date.now()}`).trim();
    const empId = String(mov.empleado_id || mov.empId || '').trim();
    if (!empId) throw new Error('empleado_id requerido');
    const compId = String(mov.company_id || mov.companyId || '').trim();
    const motivoNorm = String(mov.motivo || 'Egreso').toLowerCase() === 'ingreso' ? 'Ingreso' : 'Egreso';
    const tipoDefault = motivoNorm === 'Ingreso' ? 'BONO' : 'ADELANTO';
    const tipoMov = String(mov.tipo_movimiento || tipoDefault).toUpperCase();
    const guardSync = opciones.soloSiNoPendiente ? 'WHERE empleados_movimientos.estado_sync != 0' : '';

    conn.prepare(`
        INSERT INTO empleados_movimientos (
            id, empleado_id, company_id, branch_id, motivo, tipo_movimiento, razon, monto, moneda_origen,
            monto_bs, tasa_bcv, horas, periodo_id, prestamo_id, referencia_origen, metodo_pago, afecta_caja,
            estado, usuario_registro, fecha, estado_sync
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            company_id = COALESCE(NULLIF(excluded.company_id, ''), empleados_movimientos.company_id),
            motivo = excluded.motivo,
            tipo_movimiento = excluded.tipo_movimiento,
            razon = excluded.razon,
            monto = excluded.monto,
            moneda_origen = excluded.moneda_origen,
            monto_bs = excluded.monto_bs,
            tasa_bcv = excluded.tasa_bcv,
            horas = excluded.horas,
            periodo_id = COALESCE(NULLIF(excluded.periodo_id, ''), empleados_movimientos.periodo_id),
            prestamo_id = COALESCE(NULLIF(excluded.prestamo_id, ''), empleados_movimientos.prestamo_id),
            referencia_origen = COALESCE(NULLIF(excluded.referencia_origen, ''), empleados_movimientos.referencia_origen),
            estado = excluded.estado,
            estado_sync = excluded.estado_sync
        ${guardSync}
    `).run(
        idMov,
        empId,
        compId,
        String(mov.branch_id || '').trim(),
        motivoNorm,
        tipoMov,
        String(mov.razon || '').trim(),
        round2(parseFloat(mov.monto || 0)),
        String(mov.moneda_origen || 'USD').toUpperCase(),
        round2(parseFloat(mov.monto_bs || 0)),
        Math.max(0.01, parseFloat(mov.tasa_bcv || 1)),
        round2(parseFloat(mov.horas || 0)),
        String(mov.periodo_id || '').trim(),
        String(mov.prestamo_id || '').trim(),
        String(mov.referencia_origen || '').trim(),
        String(mov.metodo_pago || '').trim(),
        mov.afecta_caja ? 1 : 0,
        String(mov.estado || 'PENDIENTE').toUpperCase(),
        String(mov.usuario_registro || '').trim(),
        mov.fecha || ahora,
        estadoSync
    );
    return idMov;
}

function recalcularSaldoEmpleadoDb(conn, empleadoId, companyId = null, tasaActiva = 1, ahora = '', dbsRef = null) {
    if (!conn || !empleadoId) return { saldoPendiente: 0 };
    const filtroEmp = construirFiltroEmpresaEmpleados(dbsRef || conn, companyId);
    const movs = conn.prepare(`
        SELECT motivo, monto, moneda_origen, monto_bs, tasa_bcv
        FROM empleados_movimientos
        WHERE empleado_id = ?
          AND ${filtroEmp.clause}
          AND UPPER(COALESCE(estado, 'PENDIENTE')) = 'PENDIENTE'
    `).all(empleadoId, ...filtroEmp.params);

    let neto = 0;
    for (const m of movs) {
        const val = resolverMontoMovimientoUsd(m, m.tasa_bcv > 0 ? m.tasa_bcv : tasaActiva);
        if (String(m.motivo || '').toLowerCase() === 'ingreso') neto += val;
        else neto -= val;
    }
    const saldoPendiente = round2(neto);
    const filtroEmpUpd = construirFiltroEmpresaEmpleados(dbsRef || conn, companyId);
    conn.prepare(`
        UPDATE empleados
        SET saldo_pendiente = ?, fecha_modificacion = COALESCE(NULLIF(?, ''), fecha_modificacion), estado_sync = 0
        WHERE ID_empleado = ? AND ${filtroEmpUpd.clause}
          AND ABS(COALESCE(saldo_pendiente, 0) - ?) > 0.005
    `).run(saldoPendiente, ahora, empleadoId, ...filtroEmpUpd.params, saldoPendiente);
    return { saldoPendiente };
}

function upsertPrestamoDb(conn, p = {}, ahora = '', estadoSync = 0, opciones = {}) {
    if (!conn) throw new Error('Conexión SQLite requerida');
    const id = String(p.id || `PREST-${Date.now()}`).trim();
    const empId = String(p.empleado_id || '').trim();
    if (!empId) throw new Error('empleado_id requerido para préstamo');
    const cuotasTot = Math.max(1, parseInt(p.cuotas_totales || 1, 10));
    const cuotasPag = Math.max(0, parseInt(p.cuotas_pagadas || 0, 10));
    const totalUsd = round2(parseFloat(p.monto_total_usd || 0));
    const tasa = Math.max(0.01, parseFloat(p.tasa_bcv || 1));
    const cuotaUsd = round2(parseFloat(p.monto_cuota_usd || (totalUsd / cuotasTot)));
    const saldoUsd = round2(p.saldo_pendiente_usd !== undefined ? parseFloat(p.saldo_pendiente_usd) : Math.max(0, totalUsd));
    const estado = String(p.estado || (saldoUsd <= 0.01 ? 'PAGADO' : 'ACTIVO')).toUpperCase();
    const guardSync = opciones.soloSiNoPendiente ? 'WHERE empleados_prestamos.estado_sync != 0' : '';

    conn.prepare(`
        INSERT INTO empleados_prestamos (
            id, company_id, branch_id, empleado_id, concepto, monto_total_usd, tasa_bcv, monto_total_bs,
            cuotas_totales, cuotas_pagadas, monto_cuota_usd, saldo_pendiente_usd, frecuencia_descuento,
            metodo_pago, afecta_caja, estado, fecha_otorgamiento, fecha_modificacion, estado_sync
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            cuotas_pagadas = excluded.cuotas_pagadas,
            saldo_pendiente_usd = excluded.saldo_pendiente_usd,
            estado = excluded.estado,
            fecha_modificacion = excluded.fecha_modificacion,
            estado_sync = excluded.estado_sync
        ${guardSync}
    `).run(
        id,
        String(p.company_id || '').trim(),
        String(p.branch_id || '').trim(),
        empId,
        String(p.concepto || 'Préstamo Personal').trim(),
        totalUsd,
        tasa,
        round2(parseFloat(p.monto_total_bs || (totalUsd * tasa))),
        cuotasTot,
        cuotasPag,
        cuotaUsd,
        saldoUsd,
        String(p.frecuencia_descuento || 'QUINCENAL').toUpperCase(),
        String(p.metodo_pago || '').trim(),
        p.afecta_caja ? 1 : 0,
        estado,
        p.fecha_otorgamiento || ahora,
        ahora,
        estadoSync
    );
    return id;
}

function upsertAsistenciaDb(conn, a = {}, ahora = '', estadoSync = 0, opciones = {}) {
    if (!conn) throw new Error('Conexión SQLite requerida');
    const id = String(a.id || `ASIST-${Date.now()}`).trim();
    const empId = String(a.empleado_id || '').trim();
    if (!empId) throw new Error('empleado_id requerido para asistencia');
    const guardSync = opciones.soloSiNoPendiente ? 'WHERE empleados_asistencia.estado_sync != 0' : '';

    conn.prepare(`
        INSERT INTO empleados_asistencia (
            id, company_id, branch_id, empleado_id, fecha, tipo_registro, hora_entrada, hora_salida,
            horas_extra_diurnas, horas_extra_nocturnas, horas_feriado, dias_descuento, observacion,
            periodo_id, estado, estado_sync, fecha_creacion
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            tipo_registro = excluded.tipo_registro,
            hora_entrada = excluded.hora_entrada,
            hora_salida = excluded.hora_salida,
            horas_extra_diurnas = excluded.horas_extra_diurnas,
            horas_extra_nocturnas = excluded.horas_extra_nocturnas,
            horas_feriado = excluded.horas_feriado,
            dias_descuento = excluded.dias_descuento,
            observacion = excluded.observacion,
            periodo_id = COALESCE(NULLIF(excluded.periodo_id, ''), empleados_asistencia.periodo_id),
            estado = excluded.estado,
            estado_sync = excluded.estado_sync
        ${guardSync}
    `).run(
        id,
        String(a.company_id || '').trim(),
        String(a.branch_id || '').trim(),
        empId,
        String(a.fecha || (ahora ? ahora.slice(0, 10) : '')).trim(),
        String(a.tipo_registro || 'ASISTENCIA').toUpperCase(),
        String(a.hora_entrada || '').trim(),
        String(a.hora_salida || '').trim(),
        round2(parseFloat(a.horas_extra_diurnas || 0)),
        round2(parseFloat(a.horas_extra_nocturnas || 0)),
        round2(parseFloat(a.horas_feriado || 0)),
        round2(parseFloat(a.dias_descuento || 0)),
        String(a.observacion || '').trim(),
        String(a.periodo_id || '').trim(),
        String(a.estado || 'PENDIENTE').toUpperCase(),
        estadoSync,
        a.fecha_creacion || ahora
    );
    return id;
}

function round2(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 0;
    return Math.round((num + Number.EPSILON) * 100) / 100;
}

function normalizarTextoAscii(str) {
    return String(str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9 .,/_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

function limpiarSoloDigitos(str) {
    return String(str || '').replace(/\D/g, '');
}

function obtenerDiasBaseFrecuencia(frecuencia) {
    const f = String(frecuencia || 'QUINCENAL').trim().toUpperCase();
    if (f === 'SEMANAL') return 7;
    if (f === 'MENSUAL') return 30;
    return 15;
}

function resolverMontoMovimientoUsd(mov, tasaBcv) {
    const tasaActiva = Math.max(0.01, parseFloat(tasaBcv) || 1);
    const moneda = String(mov.moneda_origen || 'USD').toUpperCase();
    const montoUsd = parseFloat(mov.monto || 0);
    const montoBs = parseFloat(mov.monto_bs || 0);

    if (moneda === 'BS' && montoBs > 0) {
        return round2(montoBs / tasaActiva);
    }
    return round2(Math.abs(montoUsd));
}

/**
 * Calcula Prestaciones Sociales acumuladas según Art. 142 LOTTT (Lit. a, b vs Lit. c Retroactividad).
 * @param {any} empleado
 * @param {number|string} tasaBcv
 * @param {string|null} fechaReferencia
 * @param {number|string} anticiposUsd
 */
function calcularPrestacionesArt142VE(empleado = {}, tasaBcv = 1, fechaReferencia = null, anticiposUsd = 0) {
    const tasa = Math.max(0.01, parseFloat(String(tasaBcv)) || 1);
    const sueldoMensualUsd = Math.max(0, parseFloat(String(empleado.sueldo_base || 0)));
    const salarioDiarioUsd = sueldoMensualUsd / 30;

    // Salario integral diario: salario básico + alícuota de utilidades (min 30d/año) + bono vacacional (min 15d/año)
    const alicuotaUtilidadesDiaria = (salarioDiarioUsd * 30) / 360;
    const alicuotaVacacionalDiaria = (salarioDiarioUsd * 15) / 360;
    const salarioIntegralDiarioUsd = round2(salarioDiarioUsd + alicuotaUtilidadesDiaria + alicuotaVacacionalDiaria);

    const fIngresoRaw = empleado.fecha_ingreso || (empleado.fecha_creacion ? String(empleado.fecha_creacion).slice(0, 10) : null);
    if (!fIngresoRaw) {
        return {
            tieneFechaIngreso: false,
            antiguedadTexto: 'Sin fecha de ingreso',
            diasTotalesServicio: 0,
            trimestresCompletos: 0,
            anosServicio: 0,
            anosComputablesRetro: 0,
            salarioIntegralDiarioUsd,
            diasGarantia: 0,
            garantiaUsd: 0,
            diasRetroactividad: 0,
            retroactividadUsd: 0,
            metodoAplicable: 'GARANTIA',
            brutoUsd: 0,
            anticiposUsd: round2(anticiposUsd),
            netoDisponibleUsd: 0,
            netoDisponibleBs: 0
        };
    }

    const inicio = new Date(`${String(fIngresoRaw).slice(0, 10)}T00:00:00`);
    const ref = fechaReferencia
        ? new Date(`${String(fechaReferencia).slice(0, 10)}T00:00:00`)
        : new Date();

    if (Number.isNaN(inicio.getTime()) || Number.isNaN(ref.getTime()) || ref < inicio) {
        return {
            tieneFechaIngreso: false,
            antiguedadTexto: 'Fecha inválida',
            diasTotalesServicio: 0,
            trimestresCompletos: 0,
            anosServicio: 0,
            anosComputablesRetro: 0,
            salarioIntegralDiarioUsd,
            diasGarantia: 0,
            garantiaUsd: 0,
            diasRetroactividad: 0,
            retroactividadUsd: 0,
            metodoAplicable: 'GARANTIA',
            brutoUsd: 0,
            anticiposUsd: round2(anticiposUsd),
            netoDisponibleUsd: 0,
            netoDisponibleBs: 0
        };
    }

    const msDia = 86400000;
    const diasTotalesServicio = Math.max(0, Math.floor((ref.getTime() - inicio.getTime()) / msDia));
    const mesesAprox = Math.floor(diasTotalesServicio / 30.4375);
    const anosServicio = Math.floor(mesesAprox / 12);
    const mesesRestantes = mesesAprox % 12;
    const diasRestantesAprox = Math.max(0, Math.floor(diasTotalesServicio - (anosServicio * 365.25) - (mesesRestantes * 30.4375)));

    // Literal a y b: 15 días por trimestre + 2 días adicionales por año después del 1er año (máx 30 días adicionales)
    const trimestresCompletos = Math.floor(mesesAprox / 3);
    let diasAdicionales = 0;
    for (let y = 2; y <= anosServicio; y++) {
        diasAdicionales += Math.min(30, (y - 1) * 2);
    }
    const diasGarantia = (trimestresCompletos * 15) + diasAdicionales;
    const garantiaUsd = round2(diasGarantia * salarioIntegralDiarioUsd);

    // Literal c: 30 días por cada año o fracción superior a 6 meses
    const anosComputablesRetro = anosServicio + (mesesRestantes >= 6 ? 1 : 0);
    const diasRetroactividad = anosComputablesRetro * 30;
    const retroactividadUsd = round2(diasRetroactividad * salarioIntegralDiarioUsd);

    // Literal d: El mayor entre garantía acumulada y retroactividad
    const metodoAplicable = retroactividadUsd >= garantiaUsd ? 'RETROACTIVIDAD' : 'GARANTIA';
    const brutoUsd = round2(Math.max(garantiaUsd, retroactividadUsd));
    const ant = round2(Math.max(0, parseFloat(String(anticiposUsd || 0))));
    const netoDisponibleUsd = round2(Math.max(0, brutoUsd - ant));
    const netoDisponibleBs = round2(netoDisponibleUsd * tasa);

    const partes = [];
    if (anosServicio > 0) partes.push(`${anosServicio} ${anosServicio === 1 ? 'año' : 'años'}`);
    if (mesesRestantes > 0) partes.push(`${mesesRestantes} ${mesesRestantes === 1 ? 'mes' : 'meses'}`);
    if (partes.length === 0) partes.push(`${diasTotalesServicio} días`);

    return {
        tieneFechaIngreso: true,
        antiguedadTexto: partes.join(', '),
        diasTotalesServicio,
        trimestresCompletos,
        anosServicio,
        mesesRestantes,
        diasRestantesAprox,
        anosComputablesRetro,
        salarioIntegralDiarioUsd,
        diasGarantia,
        garantiaUsd,
        diasRetroactividad,
        retroactividadUsd,
        metodoAplicable,
        brutoUsd,
        anticiposUsd: ant,
        netoDisponibleUsd,
        netoDisponibleBs
    };
}

/**
 * Calcula el recibo completo de nómina LOTTT bimoneda para un empleado en un período.
 * @param {any} params
 */
function calcularNominaEmpleadoVE({
    empleado = /** @type {any} */ ({}),
    movimientos = [],
    prestamos = [],
    asistencias = [],
    comisionBaseVentasUsd = 0,
    opciones = /** @type {any} */ ({})
}) {
    const tasaBcv = Math.max(0.01, parseFloat(opciones.tasaBcv) || 1);
    const frecuencia = String(opciones.frecuencia || empleado.frecuencia_pago || 'QUINCENAL').trim().toUpperCase();
    const diasBase = parseFloat(opciones.diasPeriodo) || obtenerDiasBaseFrecuencia(frecuencia);
    const sueldoMensualUsd = Math.max(0, parseFloat(empleado.sueldo_base || 0));
    const salarioDiarioUsd = round2(sueldoMensualUsd / 30);
    const salarioHoraUsd = sueldoMensualUsd / 240; // 30 días x 8 horas diurnas

    let horasExtraDiurnas = 0;
    let horasExtraNocturnas = 0;
    let horasFeriado = 0;
    let diasFalta = 0;
    const asistenciaIds = [];

    for (const a of (Array.isArray(asistencias) ? asistencias : [])) {
        if (!a || String(a.estado || 'PENDIENTE').toUpperCase() === 'LIQUIDADO') continue;
        asistenciaIds.push(a.id);
        horasExtraDiurnas += Math.max(0, parseFloat(a.horas_extra_diurnas || 0));
        horasExtraNocturnas += Math.max(0, parseFloat(a.horas_extra_nocturnas || 0));
        horasFeriado += Math.max(0, parseFloat(a.horas_feriado || 0));
        diasFalta += Math.max(0, parseFloat(a.dias_descuento || 0));
    }

    const diasEfectivos = Math.max(0, round2(diasBase - diasFalta));
    const sueldoPeriodoUsd = round2((sueldoMensualUsd / 30) * diasEfectivos);

    // Cestaticket Socialista / Bono no salarial (prorrateado según días efectivos)
    const incluirCestaticket = opciones.incluirCestaticket !== false;
    const bonoMensualUsd = Math.max(0, parseFloat(empleado.bono_fijo_usd ?? 0));
    const cestaticketUsd = incluirCestaticket ? round2((bonoMensualUsd / 30) * diasEfectivos) : 0;

    // Horas extra LOTTT (Art. 117, 118, 120)
    const montoHorasDiurnasUsd = round2(horasExtraDiurnas * salarioHoraUsd * 1.50);
    const montoHorasNocturnasUsd = round2(horasExtraNocturnas * salarioHoraUsd * 1.30 * 1.50);
    const montoHorasFeriadoUsd = round2(horasFeriado * salarioHoraUsd * 1.50);
    const horasExtraAsistenciaUsd = round2(montoHorasDiurnasUsd + montoHorasNocturnasUsd + montoHorasFeriadoUsd);

    // Comisión automática sobre ventas asociadas al cajero/vendedor
    const pctComision = Math.max(0, parseFloat(empleado.comision_venta_pct || 0));
    const comisionAutoUsd = (opciones.incluirComisiones !== false && pctComision > 0 && comisionBaseVentasUsd > 0)
        ? round2(comisionBaseVentasUsd * (pctComision / 100))
        : 0;

    // Movimientos pendientes en cuenta corriente del empleado
    let horasExtraMovUsd = 0;
    let comisionesMovUsd = 0;
    let otrosIngresosUsd = 0;
    let adelantosUsd = 0;
    let faltantesCajaUsd = 0;
    let consumoInventarioUsd = 0;
    let otrosDescuentosUsd = 0;
    const movimientoIds = [];
    const detalleMovimientos = [];

    for (const m of (Array.isArray(movimientos) ? movimientos : [])) {
        if (!m) continue;
        const est = String(m.estado || 'PENDIENTE').toUpperCase();
        if (est === 'ANULADO' || est === 'APLICADO') continue;

        const tipoMov = String(m.tipo_movimiento || '').toUpperCase();
        const esIngreso = String(m.motivo || '').toLowerCase() === 'ingreso';
        const valUsd = resolverMontoMovimientoUsd(m, tasaBcv);
        if (valUsd <= 0) continue;

        movimientoIds.push(m.id);
        detalleMovimientos.push({
            id: m.id,
            motivo: m.motivo,
            tipo_movimiento: tipoMov || (esIngreso ? 'BONO' : 'ADELANTO'),
            razon: m.razon || '',
            monto_usd: valUsd,
            fecha: m.fecha || ''
        });

        if (esIngreso) {
            if (tipoMov === 'HORA_EXTRA') horasExtraMovUsd = round2(horasExtraMovUsd + valUsd);
            else if (tipoMov === 'COMISION') comisionesMovUsd = round2(comisionesMovUsd + valUsd);
            else otrosIngresosUsd = round2(otrosIngresosUsd + valUsd);
        } else {
            if (tipoMov === 'FALTANTE_CAJA') faltantesCajaUsd = round2(faltantesCajaUsd + valUsd);
            else if (tipoMov === 'CONSUMO_INVENTARIO') consumoInventarioUsd = round2(consumoInventarioUsd + valUsd);
            else if (tipoMov === 'ADELANTO' || !tipoMov) adelantosUsd = round2(adelantosUsd + valUsd);
            else otrosDescuentosUsd = round2(otrosDescuentosUsd + valUsd);
        }
    }

    const horasExtraTotalUsd = round2(horasExtraAsistenciaUsd + horasExtraMovUsd);
    const comisionesTotalUsd = round2(comisionAutoUsd + comisionesMovUsd);
    const totalAsignacionesUsd = round2(
        sueldoPeriodoUsd + cestaticketUsd + horasExtraTotalUsd + comisionesTotalUsd + otrosIngresosUsd
    );

    // Base Salarial Gravable para Parafiscales (excluye Cestaticket y viáticos)
    const baseParafiscalUsd = round2(sueldoPeriodoUsd + horasExtraTotalUsd + comisionesTotalUsd);
    const aplicarParafiscales = opciones.aplicarParafiscales !== false;

    const ivssUsd = (aplicarParafiscales && empleado.aplica_ivss !== 0)
        ? round2(baseParafiscalUsd * 0.04)
        : 0;
    const faovUsd = (aplicarParafiscales && empleado.aplica_faov !== 0)
        ? round2(baseParafiscalUsd * 0.01)
        : 0;
    const rpeUsd = (aplicarParafiscales && empleado.aplica_rpe !== 0)
        ? round2(baseParafiscalUsd * 0.005)
        : 0;
    const pctIslr = Math.max(0, parseFloat(empleado.porcentaje_islr || 0));
    const islrUsd = (aplicarParafiscales && pctIslr > 0)
        ? round2(baseParafiscalUsd * (pctIslr / 100))
        : 0;

    // Cuotas de préstamos activos
    let cuotaPrestamoUsd = 0;
    const prestamosAplicar = [];
    if (opciones.descontarPrestamos !== false) {
        for (const p of (Array.isArray(prestamos) ? prestamos : [])) {
            if (!p || String(p.estado || 'ACTIVO').toUpperCase() !== 'ACTIVO') continue;
            const saldo = Math.max(0, parseFloat(p.saldo_pendiente_usd || 0));
            const cuota = Math.max(0, parseFloat(p.monto_cuota_usd || 0));
            if (saldo <= 0 || cuota <= 0) continue;
            const aplicarUsd = round2(Math.min(saldo, cuota));
            cuotaPrestamoUsd = round2(cuotaPrestamoUsd + aplicarUsd);
            prestamosAplicar.push({
                prestamo_id: p.id,
                concepto: p.concepto || 'Préstamo Interno',
                cuota_aplicada_usd: aplicarUsd,
                cuota_numero: (parseInt(p.cuotas_pagadas || 0, 10) + 1),
                cuotas_totales: parseInt(p.cuotas_totales || 1, 10)
            });
        }
    }

    const totalDeduccionesLegalesUsd = round2(ivssUsd + faovUsd + rpeUsd + islrUsd);
    const totalDeduccionesInternasUsd = round2(
        adelantosUsd + cuotaPrestamoUsd + faltantesCajaUsd + consumoInventarioUsd + otrosDescuentosUsd
    );
    const totalDeduccionesUsd = round2(totalDeduccionesLegalesUsd + totalDeduccionesInternasUsd);

    const netoUsd = round2(totalAsignacionesUsd - totalDeduccionesUsd);
    const netoBs = round2(netoUsd * tasaBcv);

    const prestaciones = calcularPrestacionesArt142VE(empleado, tasaBcv, opciones.fechaFin || null, 0);

    return {
        empleado_id: empleado.ID_empleado || empleado.id,
        empleado_nombre: empleado.nombre || '',
        empleado_cedula: `${empleado.tipo_documento || 'V'}-${empleado.cedula || ''}`,
        empleado_cargo: empleado.cargo || '',
        frecuencia,
        dias_base: diasBase,
        dias_falta: round2(diasFalta),
        dias_efectivos: diasEfectivos,
        tasa_bcv: tasaBcv,
        sueldo_base_mensual_usd: sueldoMensualUsd,
        salario_diario_usd: salarioDiarioUsd,
        sueldo_periodo_usd: sueldoPeriodoUsd,
        cestaticket_usd: cestaticketUsd,
        horas_extra_diurnas: horasExtraDiurnas,
        horas_extra_nocturnas: horasExtraNocturnas,
        horas_feriado: horasFeriado,
        horas_extra_usd: horasExtraTotalUsd,
        comision_base_ventas_usd: round2(comisionBaseVentasUsd),
        comisiones_usd: comisionesTotalUsd,
        otros_ingresos_usd: otrosIngresosUsd,
        total_asignaciones_usd: totalAsignacionesUsd,
        total_asignaciones_bs: round2(totalAsignacionesUsd * tasaBcv),
        base_parafiscal_usd: baseParafiscalUsd,
        ivss_usd: ivssUsd,
        faov_usd: faovUsd,
        rpe_usd: rpeUsd,
        islr_usd: islrUsd,
        total_deducciones_legales_usd: totalDeduccionesLegalesUsd,
        adelantos_usd: adelantosUsd,
        faltantes_caja_usd: faltantesCajaUsd,
        consumo_inventario_usd: consumoInventarioUsd,
        otros_descuentos_usd: otrosDescuentosUsd,
        cuota_prestamo_usd: cuotaPrestamoUsd,
        total_deducciones_internas_usd: totalDeduccionesInternasUsd,
        total_deducciones_usd: totalDeduccionesUsd,
        total_deducciones_bs: round2(totalDeduccionesUsd * tasaBcv),
        neto_usd: netoUsd,
        neto_bs: netoBs,
        sobregirado: netoUsd < 0,
        banco: empleado.banco || '',
        numero_cuenta: empleado.numero_cuenta || '',
        movimiento_ids: movimientoIds,
        asistencia_ids: asistenciaIds,
        prestamos_aplicar: prestamosAplicar,
        detalle_movimientos: detalleMovimientos,
        prestaciones_acumuladas_usd: prestaciones.netoDisponibleUsd,
        prestaciones_detalle: prestaciones
    };
}

/**
 * Genera archivo TXT / CSV para dispersión bancaria masiva en Venezuela.
 * @param {{ bancoFormato?: string, empresa?: any, periodo?: any, detalles?: any[] }} params
 */
function generarTxtDispersionBancariaVE({ bancoFormato = 'GENERICO', empresa = /** @type {any} */ ({}), periodo = /** @type {any} */ ({}), detalles = [], conceptoPrefijo = 'NOMINA' }) {
    const prefijoAscii = normalizarTextoAscii(conceptoPrefijo || 'NOMINA') || 'NOMINA';
    const fmt = String(bancoFormato || 'GENERICO').toUpperCase();
    const fechaEjec = String(periodo.fecha_fin || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
    const nombreEmpresa = normalizarTextoAscii(empresa.nombre || 'EMPRESA NEXUS POS').slice(0, 35);
    const rifEmpresa = normalizarTextoAscii(empresa.rif || 'J000000000').replace(/-/g, '');
    const cuentaEmpresa = limpiarSoloDigitos(empresa.cuenta_origen || '');

    const lineas = [];
    const advertencias = [];
    const pagables = (Array.isArray(detalles) ? detalles : []).filter(d => parseFloat(d.neto_bs || 0) > 0);
    const totalBs = round2(pagables.reduce((acc, d) => acc + parseFloat(d.neto_bs || 0), 0));

    const padLeft = (v, len, ch = '0') => String(v || '').slice(0, len).padStart(len, ch);
    const padRight = (v, len, ch = ' ') => String(v || '').slice(0, len).padEnd(len, ch);
    const montoCents = (bs) => padLeft(Math.round(round2(bs) * 100), 15, '0');

    if (fmt === 'BANESCO' || fmt === 'MERCANTIL' || fmt === 'BNC' || fmt === 'BDV') {
        const codigoCab = fmt === 'BANESCO' ? 'HDR' : '01';
        lineas.push(`${codigoCab}|${padRight(rifEmpresa, 12)}|${padRight(nombreEmpresa, 35)}|${padLeft(cuentaEmpresa, 20)}|${fechaEjec}|${padLeft(pagables.length, 6)}|${montoCents(totalBs)}|VES`);
    } else {
        lineas.push(`TIPO_DOC;CEDULA;NOMBRE_COMPLETO;BANCO_DESTINO;CUENTA_20_DIGITOS;MONTO_VES;MONTO_USD;TASA_BCV;CONCEPTO`);
    }

    pagables.forEach((d, idx) => {
        const rawCed = String(d.empleado_cedula || '');
        const matchTipo = rawCed.match(/^([VEJPvejp])/);
        const tipoDoc = matchTipo ? matchTipo[1].toUpperCase() : 'V';
        const cedDigitos = limpiarSoloDigitos(rawCed);
        const cuenta = limpiarSoloDigitos(d.numero_cuenta || '');
        const nombre = normalizarTextoAscii(d.empleado_nombre || `EMPLEADO_${idx + 1}`);
        const bancoNombre = normalizarTextoAscii(d.banco || 'SIN_BANCO');
        const netoBs = round2(parseFloat(d.neto_bs || 0));
        const netoUsd = round2(parseFloat(d.neto_usd || 0));
        const tasa = round2(parseFloat(d.tasa_bcv || periodo.tasa_bcv || 1));

        if (cuenta.length !== 20) {
            advertencias.push(`${nombre} (${tipoDoc}-${cedDigitos}): cuenta bancaria "${cuenta || 'VACIA'}" no tiene 20 dígitos.`);
        }

        if (fmt === 'BANESCO' || fmt === 'MERCANTIL' || fmt === 'BNC' || fmt === 'BDV') {
            const prefijoBanco = cuenta.slice(0, 4) || '0000';
            lineas.push(`02|${tipoDoc}|${padLeft(cedDigitos, 10)}|${padRight(nombre, 40)}|${prefijoBanco}|${padLeft(cuenta, 20)}|${montoCents(netoBs)}|${prefijoAscii} ${normalizarTextoAscii(periodo.codigo || fechaEjec)}`);
        } else {
            lineas.push(`${tipoDoc};${cedDigitos};${nombre};${bancoNombre};${cuenta};${netoBs.toFixed(2)};${netoUsd.toFixed(2)};${tasa.toFixed(4)};PAGO ${prefijoAscii} ${normalizarTextoAscii(periodo.titulo || periodo.codigo || fechaEjec)}`);
        }
    });

    if (fmt === 'BANESCO' || fmt === 'MERCANTIL' || fmt === 'BNC' || fmt === 'BDV') {
        lineas.push(`99|${padLeft(pagables.length, 6)}|${montoCents(totalBs)}`);
    }

    return {
        contenido: lineas.join('\r\n'),
        cantidadRegistros: pagables.length,
        totalBs,
        formato: fmt,
        advertencias
    };
}

function upsertNominaPeriodoDb(conn, periodo = {}, detalles = [], ahora = '', estadoSync = 0, opciones = {}) {
    if (!conn || !periodo || !periodo.id) throw new Error('Período de nómina inválido');
    const guardSync = opciones.soloSiNoPendiente ? 'WHERE nominas_detalle.estado_sync != 0' : '';
    const existePer = conn.prepare(`SELECT estado_sync FROM nominas_periodos WHERE id = ?`).get(String(periodo.id));
    if (!existePer || !opciones.soloSiNoPendiente || existePer.estado_sync !== 0) {
        conn.prepare(`
            INSERT OR REPLACE INTO nominas_periodos (
                id, company_id, branch_id, codigo, titulo, frecuencia, fecha_inicio, fecha_fin, tasa_bcv,
                cantidad_empleados, total_asignaciones_usd, total_deducciones_usd, total_neto_usd, total_neto_bs,
                metodo_pago, afecta_caja, usuario_responsable, estado, observacion, datos_json, fecha_creacion, estado_sync
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            String(periodo.id),
            String(periodo.company_id || '').trim(),
            String(periodo.branch_id || '').trim(),
            String(periodo.codigo || periodo.id).trim(),
            String(periodo.titulo || 'Nómina').trim(),
            String(periodo.frecuencia || 'QUINCENAL').toUpperCase(),
            String(periodo.fecha_inicio || '').trim(),
            String(periodo.fecha_fin || '').trim(),
            Math.max(0.01, parseFloat(periodo.tasa_bcv || 1)),
            parseInt(periodo.cantidad_empleados || (Array.isArray(detalles) ? detalles.length : 0), 10),
            round2(periodo.total_asignaciones_usd),
            round2(periodo.total_deducciones_usd),
            round2(periodo.total_neto_usd),
            round2(periodo.total_neto_bs),
            String(periodo.metodo_pago || 'Transferencia Bancaria').trim(),
            periodo.afecta_caja ? 1 : 0,
            String(periodo.usuario_responsable || '').trim(),
            String(periodo.estado || 'APROBADA').toUpperCase(),
            String(periodo.observacion || '').trim(),
            typeof periodo.datos_json === 'string' ? periodo.datos_json : JSON.stringify(periodo.datos_json || {}),
            periodo.fecha_creacion || ahora,
            estadoSync
        );
    }

    const stmtDet = conn.prepare(`
        INSERT INTO nominas_detalle (
            id, periodo_id, company_id, branch_id, empleado_id, empleado_nombre, empleado_cedula, empleado_cargo,
            sueldo_base_mensual_usd, sueldo_periodo_usd, cestaticket_usd, horas_extra_usd, comisiones_usd,
            otros_ingresos_usd, total_asignaciones_usd, ivss_usd, faov_usd, rpe_usd, islr_usd,
            adelantos_usd, cuota_prestamo_usd, otros_descuentos_usd, total_deducciones_usd, neto_usd,
            tasa_bcv, neto_bs, prestaciones_acumuladas_usd, banco, numero_cuenta, detalle_json, estado, fecha_creacion, estado_sync
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            estado = excluded.estado,
            detalle_json = excluded.detalle_json,
            estado_sync = excluded.estado_sync
        ${guardSync}
    `);

    for (const d of (Array.isArray(detalles) ? detalles : [])) {
        stmtDet.run(
            String(d.id || `NDET-${periodo.id}-${d.empleado_id}`),
            String(periodo.id),
            String(d.company_id || periodo.company_id || '').trim(),
            String(d.branch_id || periodo.branch_id || '').trim(),
            String(d.empleado_id || ''),
            String(d.empleado_nombre || '').trim(),
            String(d.empleado_cedula || '').trim(),
            String(d.empleado_cargo || '').trim(),
            round2(d.sueldo_base_mensual_usd),
            round2(d.sueldo_periodo_usd),
            round2(d.cestaticket_usd),
            round2(d.horas_extra_usd),
            round2(d.comisiones_usd),
            round2(d.otros_ingresos_usd),
            round2(d.total_asignaciones_usd),
            round2(d.ivss_usd),
            round2(d.faov_usd),
            round2(d.rpe_usd),
            round2(d.islr_usd),
            round2(d.adelantos_usd),
            round2(d.cuota_prestamo_usd),
            round2(d.otros_descuentos_usd),
            round2(d.total_deducciones_usd),
            round2(d.neto_usd),
            Math.max(0.01, parseFloat(d.tasa_bcv || periodo.tasa_bcv || 1)),
            round2(d.neto_bs),
            round2(d.prestaciones_acumuladas_usd),
            String(d.banco || '').trim(),
            String(d.numero_cuenta || '').trim(),
            typeof d.detalle_json === 'string' ? d.detalle_json : JSON.stringify(d),
            String(d.estado || 'PAGADO').toUpperCase(),
            d.fecha_creacion || ahora,
            estadoSync
        );
    }
    return periodo.id;
}

module.exports = {
    CATALOGO_BANCOS_VE,
    ESQUEMA_EMPLEADOS_Y_NOMINA,
    round2,
    normalizarTextoAscii,
    obtenerDiasBaseFrecuencia,
    resolverMontoMovimientoUsd,
    calcularPrestacionesArt142VE,
    calcularNominaEmpleadoVE,
    generarTxtDispersionBancariaVE,
    construirFiltroEmpresaEmpleados,
    upsertEmpleadoDb,
    upsertMovimientoEmpleadoDb,
    recalcularSaldoEmpleadoDb,
    upsertPrestamoDb,
    upsertAsistenciaDb,
    upsertNominaPeriodoDb
};
