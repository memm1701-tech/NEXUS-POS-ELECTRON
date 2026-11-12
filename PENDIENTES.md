# 📋 NEXUS POS - Lista de Tareas y Requerimientos Pendientes (Roadmap)

Documento de seguimiento de nuevas funcionalidades, mejoras operativas y requerimientos solicitados por clientes para la evolución del sistema NEXUS POS.

---

## 📌 1. Historial de Compras y Costo Promedio Ponderado (CPP)

### 🎯 Objetivo
Registrar cada adquisición de mercancía con trazabilidad histórica (proveedor, fecha, lote, cantidad, costo unitario, divisa y tasa BCV) para calcular de forma matemática y automatizada el valor real del inventario.

### 📐 Lógica del Costo Promedio Ponderado (CPP)
Cada vez que ingresa una nueva compra, el costo unitario del inventario se actualiza según la fórmula:

$$\text{Costo Ponderado} = \frac{(\text{Stock Actual} \times \text{Costo Actual}) + (\text{Cantidad Nueva} \times \text{Costo Nuevo})}{\text{Stock Actual} + \text{Cantidad Nueva}}$$

### 🛠️ Tareas de Implementación:
- [ ] **Tabla de Compras / Lotes**: Crear o extender la persistencia en base de datos (`compras_maestro` / `lotes_compras`) con:
  - `id`, `company_id`, `producto_id`, `proveedor_id`, `fecha_compra`, `cantidad_comprada`, `costo_unitario_usd`, `costo_unitario_bs`, `tasa_bcv`, `numero_factura_proveedor`.
- [ ] **Cálculo Automático en Entradas de Inventario**: Al procesar una entrada de inventario (`entradas_de_inventario.html`), recalcular y almacenar el costo promedio ponderado resultante del producto.
- [ ] **Preservación del Historial**: Mantener el historial inmutable de compras para auditoría contable y trazabilidad.

---

## 📌 2. Opción de Costeo: "Último Costo vs. Costo Ponderado" (Costo de Reposición)

### 💡 Justificación Contable / Comercial (¿Por qué lo solicita el cliente?)
En economías con variación frecuente de precios de proveedores o fluctuación cambiaria (como Venezuela):
- Si un comerciante compra 10 unidades a **$1.00** y luego 10 unidades a **$2.00**, el costo ponderado es **$1.50**.
- Si fija su precio de venta sumando su margen sobre el costo ponderado ($1.50), al vender todo el lote recaudará dinero insuficiente para reponer el producto al nuevo precio del proveedor ($2.00).
- **El criterio de "Último Costo si es mayor al Ponderado"** protege el margen de reposición del negocio frente a la inflación o incrementos del proveedor:

$$\text{Costo Aplicable para Margen} = \max(\text{Costo Ponderado}, \text{Último Costo de Compra})$$

### 🛠️ Tareas de Implementación:
- [ ] **Selector en Configuración del Sistema**: Permitir elegir en ajustes la política de costeo preferida por la empresa:
  1. *Costo Promedio Ponderado (CPP)* (Estándar contable NIIF/NIC 2).
  2. *Último Costo de Compra* (Enfoque LIFO / reposición directa).
  3. *El Mayor entre Ponderado y Último Costo* (Protección anti-inflación / reposición).
- [ ] **Ficha de Producto**: Visualizar en el inventario ambos indicadores: Costo Ponderado y Último Costo Registrado.

---

## 📌 3. Descarga / Exportación de Historiales por Producto (Excel / CSV)

### 🎯 Objetivo
Proveer herramientas avanzadas de auditoría, control de pérdidas y análisis de rentabilidad individual descargables por producto.

### 📊 3.1 Historial de Inventario (Kardex por Producto)
Descargar el historial cronológico detallado de todos los movimientos de stock del producto seleccionado:
- **Campos a exportar**:
  - Fecha y hora exacta.
  - Tipo de movimiento (Entrada por compra, Venta en caja, Merma/Ajuste manual, Traspaso entre sucursales).
  - Sucursal y usuario/cajero responsable.
  - Cantidad entrante / saliente.
  - Saldo de stock resultante tras la operación.
  - Documento de referencia (Nro. de Factura, Guía de entrada, Nota de crédito, Código de ajuste).

### 📈 3.2 Historial de Ventas por Producto
Descargar todas las transacciones donde ha participado un producto específico dentro de un rango de fechas:
- **Campos a exportar**:
  - Nro. Factura / Ticket de venta.
  - Fecha y hora de emisión.
  - Sucursal y caja de origen.
  - Cliente (Nombre y RIF/Cédula).
  - Cantidad vendida y unidad de medida.
  - Precio unitario de venta (USD y Bs) y tasa BCV del momento.
  - Costo unitario registrado en la venta.
  - Margen de ganancia bruto generado ($ y %).
  - Método de pago principal.

### 🛠️ Tareas de Implementación:
- [ ] **Botón "Exportar Kardex" en Inventario**: Botón contextual en cada fila del producto para exportar a Excel (`XLSX`) su historial de movimientos.
- [ ] **Botón "Exportar Ventas del Producto"**: Opción desde el inventario o desde estadísticas para generar el reporte de facturación filtrado por producto y fechas.
- [ ] **Endpoint Backend de Extracción**: Crear endpoints dedicados en `server.js` (`/api/maestro/inventario/kardex/:productoId` y `/api/maestro/ventas/por-producto/:productoId`) optimizados para streaming o exportación en libro Excel.

---

*Documento creado para gestión técnica del proyecto NEXUS POS.*
