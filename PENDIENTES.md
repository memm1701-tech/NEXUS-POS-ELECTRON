# 📋 NEXUS POS - Hoja de Ruta Técnica, Auditoría y Diseño en Código (Por Dificultad)

Documento maestro de arquitectura y desarrollo para **NEXUS POS Global**. Integra la auditoría real del código fuente (`main.js`, `server.js`, `preload.js` y vistas HTML), el estudio de ERPs administrativos en Venezuela y las especificaciones del documento [libro de compra_libro de venta](https://docs.google.com/document/d/1_tDuIV850KC980YUkLAl2wAU4FQeVmj6LhYO6cg2Y0s/edit).

---

## 📌 1. Estado de Prioridad 1: Aislamiento Multi-Empresa (`company_id`)

### ✅ Cuentas por Pagar (CXP) y Proveedores — COMPLETADO
El aislamiento por `company_id` en **Cuentas por Pagar** y **Proveedores** quedó corregido en:
- `preload.js` (L22-30), `main.js` (`obtener-proveedores-local`, `guardar-proveedor-local`, `eliminar-proveedor-local`, `obtener-movimientos-cxp-local`, `guardar-movimiento-cxp-local`, `registrar-abono-cxp-local`).
- Vistas: `cuentas_pagar.html`, `gestion_de_proveedores.html`, `entradas_de_inventario.html` y `salidas_de_inventario.html`.

### ✅ Cuentas por Cobrar (`cuentas_por_cobrar`) y Diferencial Cambiario — COMPLETADO
Corregido y blindado integralmente en `preload.js`, `server.js`, `main.js`, `facturacion.html` y `cuentas_cobrar.html` (ver detalle en el punto **1.1** del Roadmap):
- Esquema homologado con `company_id`, `branch_id`, `cliente_rif`, `rif_cliente`, `tasa_emision`, `clientes_maestro.saldo_deuda_usd`, `clientes_locales.saldo_deuda_usd` y nueva tabla hija `abonos_cuentas_cobrar`.
- Aislamiento por `company_id` en consultas, registro de deudas, cascada de abonos y sincronización PUSH/PULL con migración automática de huérfanos.

---

## 💱 2. Validación y Auditoría Técnica de Cuentas por Cobrar (CXC) y Diferencial Cambiario

### ✅ Verificación de la lógica actual del sistema
Se auditó el ciclo completo de créditos en divisas desde la caja hasta el administrador y **tu lógica financiera base está validada y es correcta para economías inflacionarias**:
1. **Al facturar a crédito en POS** (`public/index_cajera/punto-de-venta/facturacion.html`, `datosDeudaMaestro`):
   - Calcula `calculoCreditoUSD = montoCreditoBs / tasaActual`.
   - Envía a `window.nexusAPI.registrarDeudaMaestro` el `company_id`, `branch_id`, `tasa_bcv: tasaActual`, `monto_bs: montoCreditoBs` y `monto_usd: parseFloat(calculoCreditoUSD.toFixed(2))`.
2. **Al consultar deuda por Cédula/RIF en Caja** (`facturacion.html` → `obtenerDeudaClienteMaestro(rif, window.companyId)` → `GET /api/maestro/consultar-deuda/:rif` en `server.js`):
   - El servidor filtra por `company_id`, calcula el saldo vivo en divisas (`resta = usdReal - yaPagado`), suma `saldo_total_usd` y devuelve `monto_bs: saldo_total_usd * tasaActual` (tasa vigente del día del cobro), además de `tasa_emision`, `tasa_actual` y el arreglo `abonos` por factura.
3. **Al registrar un abono** (`POST /api/maestro/registrar-abono` en `server.js` y espejo en `main.js`):
   - Convierte el monto recibido en Bolívares a USD usando la tasa del día del pago (`abonoUSD`) y aplica el pago en cascada (`procesoCascada`) sobre las facturas pendientes de esa empresa, guardando filas individuales en `abonos_cuentas_cobrar` y recalculando tanto `saldo_deuda_usd` como `saldo_deuda` en Bolívares a la tasa activa.

**Conclusión financiera**: A nivel operativo/gerencial (No Fiscal), indexar el saldo pendiente en USD y multiplicarlo por la tasa BCV vigente al cobrar es **superior** a llevar la cuenta en Bs fijos, porque protege automáticamente el capital de reposición sin cálculos manuales de la cajera.

### ✅ 4 Mejoras implementadas en código (Backend, BD y Frontend) para CXC
1. **Aislamiento obligatorio por `company_id` (COMPLETADO ✅)**: `company_id` y `branch_id` propagados en `facturacion.html`, `cuentas_cobrar.html`, `preload.js`, `main.js` y `server.js`, con migración automática de registros huérfanos en `migrarCuentasPorCobrarHuerfanas` / `migrarCuentasPorCobrarHuerfanasLocal`.
2. **Consistencia de moneda en `clientes_maestro.saldo_deuda` y `saldo_deuda_usd` (COMPLETADO ✅)**: Agregado `saldo_deuda_usd` y unificado mediante `recalcularSaldoClienteMaestro` (`server.js`) y `recalcularSaldoClienteLocal` (`main.js`) para recalcular USD pendiente y su equivalente en Bolívares a la tasa BCV activa tanto al registrar deuda como al abonar o consultar.
3. **Historial individual de abonos (`abonos_cuentas_cobrar`) (COMPLETADO ✅)**: Creada la tabla `abonos_cuentas_cobrar` en `server.js`, `ESQUEMA_LOCAL` y `ESQUEMA_MAESTRO_LOCAL` (`main.js`), inserción por cada factura afectada en `procesoCascada`, espejo local y consulta desde `GET /api/maestro/cxc/abonos` + IPC `obtener-abonos-cxc`.
4. **Visor de Diferencial Cambiario Protegido y Trazabilidad en `cuentas_cobrar.html` (COMPLETADO ✅)**: Nueva 4ta tarjeta `Diferencial Cambiario Protegido`, subtítulo `Equivale hoy: Bs ...`, detalle por fila (`Tasa em`, `Hoy Bs`, `+Bs dif.`), selector de Método de Pago y Referencia en los modales de abono, y vista de **Análisis Cambiario + Historial de Abonos Registrados** dentro del modal de detalles.

---

## 🛠️ 3. Roadmap de Nuevos Módulos Ordenado por Dificultad de Lógica y Preparación

---

### 🟢 NIVEL 1: Dificultad Baja-Media (Preparación Inmediata sobre Tablas y Rutas Existentes)

#### 1.1. Blindaje `company_id`, Historial de Abonos y Visor Cambiario en Cuentas por Cobrar — ✅ COMPLETADO
- **Archivos modificados**:
  - `preload.js`: `obtenerDeudaClienteMaestro(rif, companyId)`, `obtenerCuentasCobrarLocal(companyId)` y `obtenerAbonosCxc(filtros)`.
  - `server.js`: `ESQUEMA_MAESTRO` (`clientes_maestro.saldo_deuda_usd`, `cuentas_por_cobrar` con `company_id`/`branch_id`/`cliente_rif`/`rif_cliente`/`tasa_emision`, tabla `abonos_cuentas_cobrar` + índices), helpers (`obtenerTasaActivaServidor`, `construirFiltroEmpresaCxc`, `migrarCuentasPorCobrarHuerfanas`, `recalcularSaldoClienteMaestro`), rutas `/api/maestro/registrar-deuda`, `/api/maestro/consultar-deuda/:rif`, `/api/maestro/registrar-abono`, `/api/cuentas_por_cobrar` y `GET /api/maestro/cxc/abonos`.
  - `main.js`: `ESQUEMA_LOCAL`, `ESQUEMA_MAESTRO_LOCAL`, índices, helpers (`obtenerWhereRifCxcSql`, `obtenerTasaActivaLocal`, `construirFiltroEmpresaCxcLocal`, `migrarCuentasPorCobrarHuerfanasLocal`, `recalcularSaldoClienteLocal`), migración al arranque, `sincronizarCuentasCobrarConVps`, handlers `obtener-cuentas-cobrar-local`, `obtener-abonos-cxc`, `obtener-deuda-cliente-maestro`, `registrar-deuda-maestro` y `registrar-abono-maestro`.
  - `public/index_cajera/punto-de-venta/facturacion.html`: envío de `company_id`, `branch_id`, `tasa_bcv`, `metodo_pago`, `referencia` y `usuario` en abonos/deudas y consultas de deuda filtradas por `window.companyId`.
  - `public/index_inicio_admin/administracion/cuentas_cobrar.html`: aislamiento por `userCompanyId`, tarjeta y columnas de Diferencial Cambiario Protegido, Método/Referencia en modales de pago y sección de Análisis Cambiario + Historial de Abonos en detalles.

---

#### 1.2. Registro Rápido de Facturas de Gastos Operativos / Servicios (Sin Inventario) — ✅ COMPLETADO
- **Implementado integralmente junto a Suite Fiscal CxP**:
  - Columnas en `movimientos_cuentas_pagar` (`es_gasto_operativo`, `categoria_gasto`, `numero_control`, `tasa_bcv`, `monto_bs`, `monto_exento`, `base_imponible`, `alicuota_iva`, `monto_iva`, `islr_retenido_bs`, `neto_a_pagar_bs/usd`, `fecha_vencimiento`, `forma80_json`).
  - Backend transaccional en `services/operaciones-cxc-cxp.js` (`guardarDocumentoCxpCompletoDb`, `emitirRetencionCxpIndependienteDb`) + IPC `guardar-documento-cxp-completo` + endpoints `/api/maestro/cxc-cxp/*`.
  - UI completa en `public/index_inicio_admin/administracion/cuentas_pagar.html` (modal **Nuevo Doc / Gasto / Forma 80**, categorización operativa, anti-duplicado, auto-retención IVA 75%/100% e ISLR Decreto 1808 con PDF/TXT/XML SENIAT).

---

#### 1.3. Prorrateo de Fletes, Persistencia Real del CPP y Radar Protector de Márgenes en Entradas
- **Hallazgo real del escaneo**: En `entradas_de_inventario.html` L3633-3683 (`calcularYPrevisualizarCostoPonderado`), el sistema **previsualiza** el Costo Promedio Ponderado en pantalla y envía `costoUnitario` dentro de `payloadLocal` (L2693) hacia `window.nexusAPI.guardarStockSucursal`; **sin embargo**, en `main.js` L26754 (`guardar-stock-sucursal`), el handler destructura `{ productoId, sucursalId, companyId, cantidad, operacion, datosStock }` e **ignora `costoUnitario`**, por lo que hoy `productos_locales.precio_compra` no se actualiza automáticamente tras la entrada.
- **Archivos a modificar**:
  - `public/index_inicio_admin/gestion_de_inventario/entradas_de_inventario.html` (L2659-2715, L3105-3310, L3633-3683).
  - `main.js` (`guardar-stock-sucursal` L26754 o nuevo handler dedicado `actualizar-costo-ponderado-lote`).
  - `preload.js` (exponer actualización atómica de costo + historial de lote).
- **Diseño en código**:
  1. En `entradas_de_inventario.html`, añadir campo `inputFleteUsd` (Flete / Caleta / Importación) + checkbox `"Sumar flete a la deuda del proveedor"` vs `"Pagado aparte"`.
  2. Al renderizar o procesar `itemsLote` (L3105 / L2680), calcular el prorrateo por peso de valor en factura:
     - `pesoRelativo = item.subtotal / subtotalMercancia`
     - `fleteItem = fleteTotal * pesoRelativo`
     - `costoRealUnitario = item.costoUnitario + (fleteItem / item.cantidadFinal)`
  3. En `main.js`, actualizar realmente `productos_locales.precio_compra` aplicando la política de costeo configurada (CPP, Último Costo o `MAX(CPP, Último Costo)` — anti-descapitalización) y marcar `estado_sync = 0` para propagar el costo al servidor/cajas.
  4. **Radar de Margen en vivo**: En `entradas_de_inventario.html`, comparar `costoRealUnitario` y `nuevoCPP` contra `producto.precio` (`porcentaje_ganancia`). Si el margen real cae por debajo de la meta, resaltar la fila en amarillo/rojo y habilitar checkbox `[x] Sugerir / Aplicar nuevo Precio de Venta: $X.XX` usando `window.nexusAPI.sincronizarProductoServidor`.
  5. **Cola de Habladores de Anaquel**: Todo producto cuyo `precio` cambie desde el Radar se inserta en una tabla/cola `cola_habladores (product_id, company_id, precio_anterior, precio_nuevo, fecha, impreso)` para imprimir solo las etiquetas de precios que subieron hoy.
- **Hay que estar pendiente de**:
  - Si el stock previo en base de datos está negativo o en `0` (`stockActual <= 0`), la fórmula de CPP **debe tomar directamente `costoRealUnitario`** (para evitar divisiones por cero o costos distorsionados por stock negativo).

---

### 🟡 NIVEL 2: Dificultad Media (Consolidación Multi-Tabla, Libros Fiscales/Gerenciales e IA)

#### 2.1. Libro de Compra y Libro de Venta (Doble Vista: Gerencial No Fiscal + Formato SENIAT) — COMPLETADO ✅
Diseñado cruzando la arquitectura actual de NEXUS POS con los campos y el cierre de 4 pasos de [libro de compra_libro de venta](https://docs.google.com/document/d/1_tDuIV850KC980YUkLAl2wAU4FQeVmj6LhYO6cg2Y0s/edit).

##### A. Libro de Ventas (`libro_de_ventas.html`)
- **Tablas existentes aprovechables**:
  - `ventas_locales` (`main.js` L1722, `server.js` L96): **YA posee** `company_id`, `branch_id`, `cashier_id`, `fecha_emision`, `cliente_rif`, `cliente_nombre`, `numero_factura`, `numero_control`, `es_nota_credito`, `es_nota_debito`, `factura_afectada`, `monto_factura_afectada`, `fecha_factura_afectada`, `monto_exento`, `base_imponible`, `monto_iva`, `monto_igtf`, `monto_total`, `tasa_bcv`, `comprobante_retencion_id`, `ganancia_venta`, `estado`, `es_anulada`, `metodo_pago`, `datos_json`.
  - `reportes_fiscales_cierre` (`main.js` L1742): posee `numero_z`, `fecha_emision`, `ultima_factura`, `exento`, `base_imponible_tasa_1/2/3`, `impuesto_tasa_1/2/3`, `igtf`.
  - `comprobantes_retencion` (`main.js` L1750 / L4681): vinculada por `comprobante_retencion_id`.
- **Migraciones en `ventas_locales` (`asegurarEsquema` en `main.js` y `server.js`)**:
  - `alicuota_iva: "REAL DEFAULT 16"`
  - `iva_retenido_cliente: "REAL DEFAULT 0"`
  - `numero_comprobante_retencion_cliente: "TEXT"`
  - `fecha_retencion_cliente: "TEXT"`
  - `ventas_exportacion: "REAL DEFAULT 0"`
- **Nuevos endpoints y handlers a crear**:
  - `server.js`: `GET /api/maestro/libro-ventas` (parámetros: `companyId`, `branchId`, `desde`, `hasta`, `tipoDocumento`, `vista: 'GERENCIAL'|'FISCAL'`).
  - `main.js` & `preload.js`:
    - `obtenerLibroVentas(filtros)` → `ipcMain.handle('obtener-libro-ventas', ...)`
    - `registrarRetencionClienteVenta(datos)` → `ipcMain.handle('registrar-retencion-cliente-venta', ...)` (permite cargar el comprobante de retención 75%/100% entregado por un cliente Contribuyente Especial sobre una factura emitida en el período actual o anterior).
- **Doble Modo de Interfaz**:
  1. **Modo Gerencial / Operativo (No Fiscal)**: Lista TODAS las operaciones (Tickets, Notas de Entrega y Facturas Fiscales) con montos en **USD y Bs**, Costo CPP, **Utilidad Bruta (`ganancia_venta`)**, Margen %, desglose por método de pago y condición (Contado / Crédito).
  2. **Modo Contador / Formato SENIAT (según Documento)**: Columnas exactas exigidas en el documento: `N° Operación`, `Fecha Documento`, `RIF / Cédula`, `Nombre o Razón Social`, `Tipo (Contribuyente vs. No Contribuyente)`, `N° Factura / Rango Maq. Fiscal (Desde/Hasta)`, `N° Control`, `N° Reporte Z`, `N° Nota de Débito`, `N° Nota de Crédito`, `Factura Afectada`, `Total Ventas con IVA`, `Ventas Internas No Gravadas (Exentas)`, `Ventas de Exportación`, `Base Imponible (discriminada 16% / 8% / 31%)`, `% Alícuota`, `Débito Fiscal (IVA)`, `IVA Retenido por Comprador (75%/100%)`, `N° Comprobante Retención` y `Fecha Recepción`.

##### B. Libro de Compras (`libro_de_compras.html`)
- **Tablas existentes aprovechables**:
  - `movimientos_cuentas_pagar` (`main.js` L1794, `server.js` L106) cruzada con `proveedores` (`main.js` L1790, `server.js` L105) y enriquecida desde `entradas_inventario` (`server.js` L115).
- **Migraciones en `movimientos_cuentas_pagar` (`asegurarEsquema` en `main.js` y `server.js`)**:
  - `numero_control: "TEXT"`
  - `nota_credito_nro: "TEXT"`, `nota_debito_nro: "TEXT"`, `factura_afectada: "TEXT"`
  - `tipo_transaccion: "TEXT DEFAULT '01-REGISTRO'"` (`01-REGISTRO`, `02-COMPLEMENTO`, `03-ANULACION`, `04-AJUSTE`)
  - `es_importacion: "INTEGER DEFAULT 0"`, `planilla_importacion: "TEXT"`, `expediente_importacion: "TEXT"`
  - `tasa_bcv: "REAL DEFAULT 1"`, `monto_bs: "REAL DEFAULT 0"`
  - `monto_exento: "REAL DEFAULT 0"`, `base_imponible: "REAL DEFAULT 0"`, `alicuota_iva: "REAL DEFAULT 16"`, `monto_iva: "REAL DEFAULT 0"`
  - `iva_retenido: "REAL DEFAULT 0"`, `comprobante_retencion: "TEXT"`, `fecha_retencion: "TEXT"`
  - `flete_usd: "REAL DEFAULT 0"`
- **Modificaciones en módulos conectados**:
  - `entradas_de_inventario.html` (L2849-2873, `payloadCxp`): añadir inputs opcionales de `N° Control`, `Tasa BCV Factura`, y desglose automático (`Exento` / `Base Imponible 16% o 8%` / `IVA`) según el atributo fiscal de cada producto en `itemsLote`.
  - `salidas_de_inventario.html` (L1750-1760, `datosAbono`): cuando se descuenta una factura por devolución al proveedor, guardar también un registro de ajuste vinculado con `tipo_transaccion: '04-AJUSTE'`, `factura_afectada: facturaSeleccionadaObj.comprobante` y `nota_credito_nro: referencia`, de forma que aparezca automáticamente restando en el **Libro de Compras**.
- **Nuevos endpoints, handlers y menú**:
  - `server.js`: `GET /api/maestro/libro-compras?companyId=X&desde=YYYY-MM-DD&hasta=YYYY-MM-DD`.
  - `main.js` & `preload.js`: `obtenerLibroCompras(filtros)` → `ipcMain.handle('obtener-libro-compras', ...)`.
  - `public/inicio.html` (L352-359 bajo "Administración"): añadir enlaces a `libro_de_ventas.html` y `libro_de_compras.html`.
  - Exportación a Excel aprovechando `window.nexusAPI.guardarArchivoExcel` (`main.js` L21522 / `preload.js` L58) + hoja adicional del **Resumen de Conciliación Fiscal de 4 Pasos** del documento (`Débito Fiscal - Crédito Fiscal = Cuota Tributaria - Retenciones Aplicadas = Neto a Pagar o Excedente de Crédito Fiscal`).
- **Hay que estar pendiente de**:
  - **Facturas Anuladas**: Nunca excluir ni borrar del Libro de Ventas las filas con `es_anulada = 1`; deben mostrarse en su orden correlativo con montos en `0.00` y etiqueta `ANULADA` para mantener la secuencia de N° de Factura y N° de Control.
  - **Tasa BCV Histórica**: En la vista Fiscal en Bolívares, convertir cada factura usando **su propia `tasa_bcv` guardada al momento de la emisión**, jamás recalculándola con la tasa actual de hoy.
  - **Notas de Crédito de períodos distintos**: Si una devolución afecta una factura de un mes anterior, debe sumarse/restarse dentro del período en que se emitió la Nota de Crédito referenciando `factura_afectada`, tal como exige el Paso 1 y 2 del documento.

---

#### 2.2. Ingesta Inteligente de Facturas de Compra por IA (Foto / PDF / Excel) en Entradas — 🟡 BASE OCR IMPLEMENTADA
- **Completado**: Handler `escanear-factura-compra-ia` con `gemini-2.5-flash` (`main.js` + `preload.js`) integrado en `entradas_de_inventario.html` y `cuentas_pagar.html` para extraer N° de Factura, N° Control, RIF/Proveedor, Fecha, Tasa BCV y alícuota IVA automáticamente desde foto o PDF.
- **Pendiente complementario**: Pre-conciliación renglón a renglón contra `listaProductos` para inyectar automáticamente filas en `itemsLote` tras validar la tasa BCV.

---

### 🔴 NIVEL 3: Dificultad Alta (Lógica Contable Delicada, Estados Cruzados y Partición Financiera)

#### 3.1. Salidas Tipificadas Anti-Fugas, Notas de Crédito / Saldos a Favor con Proveedor y Cargos a Nómina — 🟡 SALDOS A FAVOR COMPLETADO / NÓMINA PENDIENTE
- **Completado**: `saldo_a_favor_usd` en clientes y proveedores, billetera `anticipos_saldos_favor` (`INDEXADO_USD` vs `NOMINAL_BS`), envío automático de excedentes de devoluciones (`salidas_de_inventario.html` via `registrarAnticipoSaldoFavor`) y sobrepagos en `cuentas_cobrar.html` / `cuentas_pagar.html`, más visualización en `entradas_de_inventario.html`.
- **Pendiente complementario**: Cargo automático a Nómina desde `salidas_de_inventario.html` (`guardar-movimiento-empleado-local`).

---

#### 3.2. Tesorería Bimonetaria (Bóvedas, Cajas Chicas y Bancos) + Estado de Resultados (P&L) — 🟡 NÚCLEO COMPLETADO EN CXC/CXP
- **Completado**: Tablas `cuentas_tesoreria` y `movimientos_tesoreria`, motor `gestionarCuentaTesoreriaDb`, conciliación bancaria y disparadores automáticos desde `registrarAbonoCxcAvanzadoDb`, `registrarPagoCxpAvanzadoDb` y `crearOEjecutarOrdenPagoCxpDb` dentro de `cuentas_cobrar.html` y `cuentas_pagar.html`.
- **Pendiente complementario**: Vista dedicada `tesoreria_bancos.html` con Mesa de Cambio interna y Estado de Resultados P&L gerencial + conexión automática desde `procesar-cierre-caja-local`.

---

#### 3.3. Conciliador Nativo de Ventas Financiadas en Cuotas (Cashea / Krece / BNPL) con Partición Tripartita — 🟡 MOTOR & CARTERA COMPLETADO
- **Completado**: Fórmula de partición tripartita (`calcularParticionCashea` en `services/contabilidad-fiscal-ve.js`), registro transaccional (`registrarCasheaVentaCxcDb`), diferenciación en cartera y registro/seguimiento administrativo en `cuentas_cobrar.html`.
- **Pendiente complementario**: Selector directo de Cashea con partición en vivo de la Inicial en turno de caja (`facturacion.html` / `procesar-cierre-caja-local`).

---

#### 3.4. Suite Fiscal & Contable Avanzada VE para CxC y CxP (Superando Top 10 ERPs Venezuela) — ✅ COMPLETADO
- **Servicios creados**: `services/contabilidad-fiscal-ve.js`, `services/operaciones-cxc-cxp.js`, `services/template-comprobantes-cxc-cxp.js` + extensión en `services/nomina-ve.js` (`conceptoPrefijo` para TXT bancario CxP).
- **Cumplimiento legal y contable**: Retenciones IVA 75%/100% (16 cols TXT SENIAT) e ISLR Decreto 1808 (`UT = Bs. 43`, sustraendo PNR `83.3334*UT`, XML `<RelacionRetencionesISLR>`), numeración oficial 14 dígitos `AAAAMMSSSSSSSS`, prelación IGTF 3% SPE, asimetría Art. 51 Regl. IVA (ND automática CxC Libro de Ventas vs bandeja N/D en tránsito CxP Libro de Compras), Forma 80 importación, Semáforo BCV, Órdenes de Pago OP + TXT Banco (Banesco/Mercantil/Provincial/BDV/BNC), Giros/Cheques devueltos + comisión, Límites de crédito/morosidad en POS (`facturacion.html`), Cierre Cambiario Mensual VEN-NIF NIC 21 + Reverso Día 1, y PDFs oficiales (Retención, Estado de Cuenta Aging y Orden de Pago).

---

## 🧩 4. Módulos Complementarios y Requerimientos Técnicos en Curso (Fases Posteriores)

Se mantienen en agenda los siguientes módulos estratégicos y requerimientos técnicos previos para completar la suite ERP:

1. **Asistente Inteligente de Compras, Quiebre de Stock y Órdenes de Compra (OC)** *(Nivel 2)*:
   - Cálculo de días de inventario restantes según rotación real (`ventas_locales` últimos 7/15/30 días).
   - Comparador histórico de costos por proveedor leyendo el `contenido_fac` de `movimientos_cuentas_pagar`.
   - Emisión de Orden de Compra por proveedor y botón **"Recibir OC"** conectado directo a `entradas_de_inventario.html`.
2. **Auditoría Relámpago (Conteo Ciego Diario) con Adjudicación de Faltantes** *(Nivel 2-3)*:
   - Lotes diarios aleatorios de 10-20 productos sin mostrar stock del sistema, con resolución directa hacia reclamo a CXP proveedor, vale en `empleados_movimientos` o merma en `salidas_inventario`.
3. **Exportación de Kardex e Historial de Ventas por Producto (`inventario.html`)** *(Nivel 1-2)*:
   - Botones **"Exportar Kardex"** (cruzando `entradas_inventario`, `salidas_inventario` y `ventas_locales`) y **"Exportar Ventas del Producto"** usando `window.nexusAPI.guardarArchivoExcel` (`main.js` L21522), con endpoints `/api/maestro/inventario/kardex/:productoId` y `/api/maestro/ventas/por-producto/:productoId` filtrados por `company_id`.
4. **Configuración de Política de Costeo ("Último Costo vs. Costo Ponderado / Reposición")** *(Nivel 1)*:
   - Selector global en configuración: `(1) CPP`, `(2) Último Costo de Compra`, `(3) MAX(CPP, Último Costo)`, visible directamente en la ficha de producto en `inventario.html`.

---

*Documento actualizado con base en auditoría directa de código fuente — **NEXUS POS Global**.*
