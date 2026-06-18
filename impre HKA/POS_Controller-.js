const FiscalPrinterHKA = require('./FiscalPrinterHKA');

// 1. Instanciar el emulador
const impresora = new FiscalPrinterHKA();

// Simular la conexión (En producción aquí iría el puerto COM real)
impresora.conectar("COM1");

/**
 * Función que formatea y envía una factura de prueba al emulador
 */
function procesarVentaPrueba() {
    console.log("Iniciando proceso de facturación en Nexus POS...");

    // TRAMA 1: Imprimir datos del cliente (Comandos 'iS' o texto no fiscal)
    impresora.enviarComando("iS*Moises Marino");
    impresora.enviarComando("iR*V-12345678");

    // TRAMA 2: Vender un artículo. 
    // Estructura simplificada HKA: 
    // [Comando] + [Tasa IVA] + [Precio 10 enteros 2 decimales] + [Cant 5 enteros 3 decimales] + [Descripción]
    // Ejemplo ficticio de trama de producto:
    let tramaProducto1 = " 0000000150000001000Teclado Mecanico USB"; // Venta, Tasa Exenta, 15.00 Bs, 1.000 cant
    let tramaProducto2 = "!0000000500000002000Mouse Optico";       // Venta, Tasa 16%, 50.00 Bs, 2.000 cant
    
    impresora.enviarComando(tramaProducto1);
    impresora.enviarComando(tramaProducto2);

    // TRAMA 3: Subtotal
    impresora.enviarComando("3");

    // TRAMA 4: Pagar y cerrar la factura
    // Comando '101' suele representar pago en Efectivo o Tarjeta según la máquina
    impresora.enviarComando("101000000000000"); // Pagar el total exacto
}

// Ejecutar la prueba
procesarVentaPrueba();

// Prueba de reporte Z al final del día
setTimeout(() => {
    console.log("Generando cierre de caja diario...");
    impresora.enviarComando("I0Z");
}, 2000);