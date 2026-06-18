const imprimirEnWindows = require('./ImprimirPrueba');

class FiscalPrinterHKA {
    constructor() {
        this.status = "0 - Ok";
        this.items = [];
        this.nroFactura = "00000000"; 
        this.cliente = { nombre: "CONSUMIDOR FINAL", rif: "V00000000", direccion: "N/A" };
        
        // Añadimos line6 para soportar la Sucursal si la configuran
        this.emisor = { line1: "NEXUS POS", line3: "J-00000000-0", line4: "VALENCIA", line6: "" };
        this.conectado = false;
    }

    conectar(puerto) { this.conectado = true; return true; }

    enviarComando(comando) {
        if (!this.conectado) return false;
        
        // Captura de datos de la empresa
        if (comando.startsWith("iE1*")) this.emisor.line1 = comando.substring(4).toUpperCase();
        if (comando.startsWith("iE3*")) this.emisor.line3 = comando.substring(4).toUpperCase();
        if (comando.startsWith("iE4*")) this.emisor.line4 = comando.substring(4).toUpperCase();
        if (comando.startsWith("iE6*")) this.emisor.line6 = comando.substring(4).toUpperCase();
        
        // Captura de correlativo y cliente
        if (comando.startsWith("iNF*")) this.nroFactura = comando.substring(4);
        if (comando.startsWith("iS*")) this.cliente.nombre = comando.substring(3).trim().toUpperCase();
        if (comando.startsWith("iR*")) this.cliente.rif = comando.substring(3).trim().toUpperCase();
        
        // Items y pagos
        if (comando.startsWith("!") || comando.startsWith(" ")) this.items.push(comando);
        if (comando.startsWith("1") || comando.startsWith("2")) this._cerrarFactura("1");
        
        return true;
    }

    _cerrarFactura(comandoPago) {
        const LINE_WIDTH = 28; 
        const sep = "-".repeat(LINE_WIDTH);
        const eq = "=".repeat(LINE_WIDTH);
        const CRLF = "\r\n"; // Obligatorio para la JP588
        
        // --- FUNCIONES MÁGICAS DE ALINEACIÓN ---
        
        // 1. Centra el texto en los 28 caracteres
        const centerText = (text) => {
            const str = String(text).substring(0, LINE_WIDTH).trim();
            const padding = Math.floor((LINE_WIDTH - str.length) / 2);
            return " ".repeat(Math.max(0, padding)) + str;
        };

        // 2. Pega una palabra a la izquierda y otra a la derecha
        const formatLR = (left, right) => {
            const strLeft = String(left).trim();
            const strRight = String(right).trim();
            const espacios = LINE_WIDTH - strLeft.length - strRight.length;
            return strLeft + " ".repeat(Math.max(0, espacios)) + strRight;
        };

        // --- CONSTRUCCIÓN DEL TICKET ---

        // Comando ESC @ para resetear la impresora y destrabar texto corrido
        let t = "\x1B\x40" + CRLF + CRLF; 
        
        // 1. ENCABEZADO SUPERIOR (Centrado)
        t += centerText("SENIAT") + CRLF;
        t += centerText(this.emisor.line1) + CRLF;
        t += centerText(`RIF: ${this.emisor.line3}`) + CRLF;
        
        if (this.emisor.line4 && this.emisor.line4 !== "N/A") {
            t += centerText(this.emisor.line4) + CRLF;
        }
        if (this.emisor.line6) {
            t += centerText(this.emisor.line6) + CRLF; // Sucursal
        }
        t += CRLF;

        // 2. FECHA, HORA Y NÚMERO (Alineados Izquierda / Derecha)
        const fechaActual = new Date().toLocaleDateString();
        const horaActual = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        
        t += formatLR("FECHA:", fechaActual) + CRLF;
        t += formatLR("HORA:", horaActual) + CRLF;
        t += formatLR("NRO:", this.nroFactura) + CRLF;
        t += sep + CRLF;

        // 3. DATOS DEL CLIENTE
        t += `CLI: ${this.cliente.nombre.substring(0, LINE_WIDTH - 5)}` + CRLF;
        t += `C.I/RIF: ${this.cliente.rif}` + CRLF;
        t += sep + CRLF;
        
        // 4. CABECERA DE PRODUCTOS
        t += "DESCRIPCION         TOTAL" + CRLF; 
        t += sep + CRLF;

        let subExento = 0, subBase = 0;

        // 5. PRODUCTOS (De aquí para abajo, tal como acordamos)
        this.items.forEach((trama) => {
            const esEx = trama.startsWith(" ");
            const precio = parseFloat(trama.substring(1, 11)) / 100;
            const cant = parseFloat(trama.substring(11, 19)) / 1000;
            const desc = trama.substring(19).trim().toUpperCase();
            const totalItem = precio * cant;

            if (esEx) subExento += totalItem; else subBase += totalItem;

            const pNombre = desc.substring(0, 16).padEnd(16);
            const pTotal = totalItem.toFixed(2).padStart(10);
            
            t += `${pNombre}${pTotal}${esEx ? 'E' : ' '}` + CRLF;
            
            if (desc.length > 16 || cant !== 1) {
                t += `  ${cant.toFixed(2)} x ${precio.toFixed(2)}` + CRLF;
            }
        });

        // 6. TOTALES (Alineados Izquierda / Derecha)
        const iva = subBase * 0.16;
        const totalG = subExento + subBase + iva;

        t += sep + CRLF;
        if (subExento > 0) t += formatLR("EXENTO", subExento.toFixed(2)) + CRLF;
        if (subBase > 0) {
            t += formatLR("BASE", subBase.toFixed(2)) + CRLF;
            t += formatLR("IVA", iva.toFixed(2)) + CRLF;
        }
        t += eq + CRLF;
        t += formatLR("TOTAL BS", totalG.toFixed(2)) + CRLF;
        t += eq + CRLF;
        
        // 7. DESPEDIDA
        t += centerText("FACTURA FISCAL") + CRLF;
        t += centerText("GRACIAS POR SU COMPRA") + CRLF;
        t += CRLF + CRLF + CRLF + CRLF + CRLF; 

        // Enviar a imprimir
        imprimirEnWindows(t);
        
        // Reset de memoria para la próxima venta
        this.items = [];
        this.nroFactura = "00000000";
    }
}

module.exports = FiscalPrinterHKA;