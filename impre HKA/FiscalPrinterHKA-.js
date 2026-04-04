const imprimirEnWindows = require('./ImprimirPrueba');

class FiscalPrinterHKA {
    constructor() {
        this.status = "0 - Ok";
        this.items = [];
        this.nroFactura = "00000000"; 
        this.nroControl = "00-000000"; // Nuevo: Requerido por ley
        this.hash = "PENDIENTE-GENERAR-API"; // Nuevo: Firma electrónica
        this.cliente = { nombre: "CONSUMIDOR FINAL", rif: "V00000000", direccion: "N/A" };
        this.emisor = { line1: "NEXUS POS", line3: "J-00000000-0", line4: "VALENCIA", line6: "" };
        this.conectado = false;
    }

    conectar(puerto) { this.conectado = true; return true; }

    enviarComando(comando) {
        if (!this.conectado) return false;
        
        if (comando.startsWith("iE1*")) this.emisor.line1 = comando.substring(4).toUpperCase();
        if (comando.startsWith("iE3*")) this.emisor.line3 = comando.substring(4).toUpperCase();
        if (comando.startsWith("iE4*")) this.emisor.line4 = comando.substring(4).toUpperCase();
        if (comando.startsWith("iE6*")) this.emisor.line6 = comando.substring(4).toUpperCase();
        
        if (comando.startsWith("iNF*")) this.nroFactura = comando.substring(4);
        // Simulamos asignación de nro control basado en factura para el ejemplo
        this.nroControl = `00-${this.nroFactura.padStart(6, '0')}`;

        if (comando.startsWith("iS*")) this.cliente.nombre = comando.substring(3).trim().toUpperCase();
        if (comando.startsWith("iR*")) this.cliente.rif = comando.substring(3).trim().toUpperCase();
        
        if (comando.startsWith("!") || comando.startsWith(" ")) this.items.push(comando);
        if (comando.startsWith("1") || comando.startsWith("2")) this._cerrarFactura("1");
        
        return true;
    }

    _cerrarFactura(comandoPago) {
        const LINE_WIDTH = 28; 
        const sep = "-".repeat(LINE_WIDTH);
        const eq = "=".repeat(LINE_WIDTH);
        const CRLF = "\r\n";
        
        const centerText = (text) => {
            const str = String(text).substring(0, LINE_WIDTH).trim();
            const padding = Math.floor((LINE_WIDTH - str.length) / 2);
            return " ".repeat(Math.max(0, padding)) + str;
        };

        const formatLR = (left, right) => {
            const strLeft = String(left).trim();
            const strRight = String(right).trim();
            const espacios = LINE_WIDTH - strLeft.length - strRight.length;
            return strLeft + " ".repeat(Math.max(0, espacios)) + strRight;
        };

        // Generar un Hash ficticio para el ejemplo (En producción vendrá de tu API)
        this.hash = Math.random().toString(36).substring(2, 15).toUpperCase();

        let t = "\x1B\x40" + CRLF; 
        
        // 1. ENCABEZADO FISCAL
        t += centerText(this.emisor.line1) + CRLF;
        t += centerText(`RIF: ${this.emisor.line3}`) + CRLF;
        if (this.emisor.line4 && this.emisor.line4 !== "N/A") t += centerText(this.emisor.line4) + CRLF;
        if (this.emisor.line6) t += centerText(this.emisor.line6) + CRLF;
        t += CRLF;

        // 2. IDENTIFICACIÓN LEGAL
        t += centerText("FACTURA DIGITAL") + CRLF;
        t += formatLR("FACTURA NRO:", this.nroFactura) + CRLF;
        t += formatLR("CONTROL NRO:", this.nroControl) + CRLF;
        
        const fechaActual = new Date().toLocaleDateString();
        const horaActual = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        t += formatLR("FECHA:", fechaActual) + CRLF;
        t += formatLR("HORA:", horaActual) + CRLF;
        t += sep + CRLF;

        // 3. DATOS DEL CLIENTE
        t += `CLIENTE: ${this.cliente.nombre.substring(0, 19)}` + CRLF;
        t += `RIF/CI:  ${this.cliente.rif}` + CRLF;
        t += sep + CRLF;
        
        // 4. ITEMS
        t += "DESCRIPCION         TOTAL" + CRLF; 
        t += sep + CRLF;

        let subExento = 0, subBase = 0;

        this.items.forEach((trama) => {
            const esEx = trama.startsWith(" ");
            const precio = parseFloat(trama.substring(1, 11)) / 100;
            const cant = parseFloat(trama.substring(11, 19)) / 1000;
            const desc = trama.substring(19).trim().toUpperCase();
            const totalItem = precio * cant;

            if (esEx) subExento += totalItem; else subBase += totalItem;

            const pNombre = desc.substring(0, 16).padEnd(16);
            const pTotal = totalItem.toFixed(2).padStart(10);
            
            // Requisito 0102: Indicar (E) o (G)
            t += `${pNombre}${pTotal}${esEx ? '(E)' : '(G)'}` + CRLF;
            
            if (desc.length > 16 || cant !== 1) {
                t += `  ${cant.toFixed(2)} x ${precio.toFixed(2)}` + CRLF;
            }
        });

        // 5. TOTALES
        const iva = subBase * 0.16;
        const totalG = subExento + subBase + iva;

        t += sep + CRLF;
        if (subExento > 0) t += formatLR("BI EXENTO:", subExento.toFixed(2)) + CRLF;
        if (subBase > 0) {
            t += formatLR("BI GRAVABLE (16%):", subBase.toFixed(2)) + CRLF;
            t += formatLR("IVA (16%):", iva.toFixed(2)) + CRLF;
        }
        t += eq + CRLF;
        t += formatLR("TOTAL BS:", totalG.toFixed(2)) + CRLF;
        t += eq + CRLF;
        
        // 6. PIE DE PÁGINA OBLIGATORIO (PROVIDENCIA 0102)
        t += CRLF;
        t += centerText("VALIDACIÓN DIGITAL") + CRLF;
        t += centerText(`HASH: ${this.hash}`) + CRLF;
        t += centerText("Prov. SNAT/2024/000102") + CRLF;
        t += centerText("SISTEMA NEXUS POS GLOBAL") + CRLF;
        t += CRLF + CRLF + CRLF; // Espacio para corte manual

        imprimirEnWindows(t);
        
        // Limpieza
        this.items = [];
    }
}

module.exports = FiscalPrinterHKA;