const fs = require('fs');
const path = require('path');

// Cargar logotipo en Base64
let logoBase64 = '';
const logoPath = path.join(__dirname, 'assets', 'logo_nexus_sin_fondo.png');
if (fs.existsSync(logoPath)) {
    logoBase64 = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
}

const htmlContent = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nexus POS Global - Presentación Comercial</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #0284c7;
            --primary-dark: #0369a1;
            --navy-900: #0f172a;
            --navy-800: #1e293b;
            --navy-700: #334155;
            --whatsapp-green: #25d366;
            --whatsapp-dark: #075e54;
            --whatsapp-bubble-user: #dcf8c6;
            --whatsapp-bubble-ai: #ffffff;
            --accent-blue: #2563eb;
            --bg-light: #f8fafc;
            --border-color: #e2e8f0;
            --text-dark: #0f172a;
            --text-muted: #64748b;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
        }

        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #cbd5e1;
            color: var(--text-dark);
            line-height: 1.4;
            font-size: 13px;
        }

        /* Formato Carta Estándar (Letter) - 2 Páginas */
        .page {
            width: 8.5in;
            height: 11in;
            max-height: 11in;
            margin: 20px auto;
            background: #ffffff;
            padding: 0.42in 0.5in;
            position: relative;
            box-shadow: 0 10px 30px rgba(0,0,0,0.12);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            page-break-after: always;
            page-break-inside: avoid;
        }

        @media print {
            body {
                background: #ffffff;
            }
            .page {
                margin: 0;
                box-shadow: none;
                width: 100%;
                height: 100%;
                min-height: 100vh;
                max-height: 100vh;
                padding: 0.38in 0.45in;
                page-break-after: always;
                page-break-inside: avoid;
            }
            .no-print {
                display: none !important;
            }
        }

        /* Botón de impresión */
        .toolbar {
            position: fixed;
            top: 15px;
            right: 15px;
            z-index: 9999;
            background: rgba(15, 23, 42, 0.9);
            backdrop-filter: blur(8px);
            padding: 10px 18px;
            border-radius: 50px;
            box-shadow: 0 8px 20px rgba(0,0,0,0.25);
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .toolbar button {
            background: linear-gradient(135deg, #0284c7, #2563eb);
            color: white;
            border: none;
            padding: 9px 20px;
            font-size: 13px;
            font-weight: 700;
            border-radius: 30px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s;
        }
        .toolbar button:hover {
            transform: scale(1.04);
            box-shadow: 0 4px 14px rgba(37, 99, 235, 0.4);
        }

        /* HEADER */
        .page-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 2px solid #f1f5f9;
            padding-bottom: 10px;
            margin-bottom: 12px;
        }
        .brand-box {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .brand-logo {
            height: 44px;
            width: auto;
            object-fit: contain;
        }
        .brand-text h1 {
            font-size: 20px;
            font-weight: 900;
            color: var(--navy-900);
            letter-spacing: -0.5px;
            line-height: 1.1;
        }
        .brand-text p {
            font-size: 10.5px;
            font-weight: 700;
            color: var(--primary);
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .badge-tag {
            background: #e0f2fe;
            color: #0369a1;
            border: 1px solid #bae6fd;
            padding: 5px 12px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: 800;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        /* HERO BANNER SIMPLE Y DIRECTO */
        .hero-banner {
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #0369a1 100%);
            color: white;
            border-radius: 14px;
            padding: 18px 22px;
            margin-bottom: 14px;
            box-shadow: 0 6px 16px rgba(15, 23, 42, 0.1);
        }
        .hero-title {
            font-size: 21px;
            font-weight: 900;
            line-height: 1.25;
            margin-bottom: 6px;
            letter-spacing: -0.5px;
        }
        .hero-title span {
            color: #38bdf8;
        }
        .hero-desc {
            font-size: 12.5px;
            color: #cbd5e1;
            line-height: 1.45;
        }

        /* GRID DE BENEFICIOS CLAVE */
        .benefits-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
            margin-bottom: 14px;
        }
        .benefit-card {
            background: #f8fafc;
            border: 1.5px solid #e2e8f0;
            border-radius: 12px;
            padding: 12px 14px;
        }
        .benefit-card.highlight {
            background: #f0f9ff;
            border-color: #bae6fd;
        }
        .benefit-top {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
        }
        .benefit-icon {
            font-size: 18px;
        }
        .benefit-card h3 {
            font-size: 13.5px;
            font-weight: 800;
            color: var(--navy-900);
        }
        .benefit-card p {
            font-size: 11.5px;
            color: #475569;
            line-height: 1.4;
        }

        /* SECCIÓN MOBILE */
        .mobile-banner {
            background: linear-gradient(135deg, #042f2e 0%, #0f172a 100%);
            color: white;
            border-radius: 14px;
            padding: 14px 18px;
            margin-bottom: 14px;
            border: 1px solid rgba(20, 184, 166, 0.3);
        }
        .mobile-header-box {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        .mobile-header-box h3 {
            font-size: 14.5px;
            font-weight: 900;
            color: #5eead4;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .mobile-header-box span {
            font-size: 10px;
            background: rgba(45, 212, 191, 0.2);
            color: #99f6e4;
            padding: 3px 8px;
            border-radius: 10px;
            font-weight: 700;
        }
        .mobile-items-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
        }
        .mobile-item {
            background: rgba(255, 255, 255, 0.06);
            border-radius: 8px;
            padding: 8px 10px;
            border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .mobile-item h4 {
            font-size: 11.5px;
            font-weight: 800;
            color: #ffffff;
            margin-bottom: 2px;
        }
        .mobile-item p {
            font-size: 10.5px;
            color: #cbd5e1;
            line-height: 1.35;
        }

        /* RESUMEN DE HARDWARE Y FISCAL */
        .hardware-box {
            background: #ffffff;
            border: 1.5px solid #e2e8f0;
            border-radius: 12px;
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
        }
        .hw-group h4 {
            font-size: 12px;
            font-weight: 800;
            color: var(--navy-900);
            margin-bottom: 2px;
        }
        .hw-group p {
            font-size: 11px;
            color: #64748b;
        }

        /* =========================================
           PÁGINA 2: STUART AI EN DETALLE (WHATSAPP)
           ========================================= */
        .stuart-hero {
            background: linear-gradient(135deg, #075e54 0%, #128c7e 50%, #0f172a 100%);
            color: white;
            border-radius: 14px;
            padding: 16px 20px;
            margin-bottom: 12px;
            box-shadow: 0 6px 16px rgba(7, 94, 84, 0.15);
        }
        .stuart-hero-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
        }
        .stuart-hero-title {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .stuart-avatar-circle {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            background: #25d366;
            color: #075e54;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            font-weight: 900;
        }
        .stuart-hero-title h2 {
            font-size: 17px;
            font-weight: 900;
        }
        .stuart-hero-title p {
            font-size: 11px;
            color: #a7f3d0;
        }
        .stuart-hero-desc {
            font-size: 12px;
            color: #e6fffa;
            line-height: 1.4;
        }

        /* SIMULACIÓN DE CHAT WHATSAPP */
        .whatsapp-container {
            background: #efeae2;
            background-image: radial-gradient(#d1d7db 1px, transparent 1px);
            background-size: 16px 16px;
            border-radius: 14px;
            padding: 14px 16px;
            border: 1.5px solid #d1d7db;
            margin-bottom: 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .chat-bubble {
            max-width: 88%;
            padding: 8px 12px;
            border-radius: 8px;
            font-size: 11.5px;
            line-height: 1.35;
            position: relative;
            box-shadow: 0 1px 2px rgba(0,0,0,0.1);
        }
        .bubble-user {
            align-self: flex-end;
            background-color: var(--whatsapp-bubble-user);
            border-top-right-radius: 0;
            color: #111b21;
        }
        .bubble-ai {
            align-self: flex-start;
            background-color: var(--whatsapp-bubble-ai);
            border-top-left-radius: 0;
            color: #111b21;
        }
        .bubble-header {
            font-weight: 800;
            font-size: 10.5px;
            margin-bottom: 2px;
        }
        .bubble-user .bubble-header { color: #075e54; }
        .bubble-ai .bubble-header { color: #0284c7; }

        /* GRID DE FUNCIONES DE STUART */
        .stuart-functions-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
            margin-bottom: 12px;
        }
        .function-card {
            background: #ffffff;
            border: 1.5px solid #e2e8f0;
            border-radius: 10px;
            padding: 10px 12px;
        }
        .function-top {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 4px;
        }
        .function-top h4 {
            font-size: 12px;
            font-weight: 800;
            color: var(--navy-900);
        }
        .function-card p {
            font-size: 11px;
            color: #475569;
            line-height: 1.35;
        }

        /* BANNER DE CIERRE COMERCIAL */
        .cta-banner {
            background: linear-gradient(135deg, #0284c7, #2563eb);
            color: white;
            border-radius: 12px;
            padding: 12px 18px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .cta-text h3 {
            font-size: 13.5px;
            font-weight: 900;
            margin-bottom: 2px;
        }
        .cta-text p {
            font-size: 11px;
            color: #e0f2fe;
        }
        .cta-contact {
            background: rgba(255, 255, 255, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.4);
            padding: 6px 14px;
            border-radius: 20px;
            font-weight: 800;
            font-size: 11.5px;
            color: #ffffff;
            white-space: nowrap;
        }

        /* FOOTER DE PÁGINA */
        .page-footer {
            border-top: 1.5px solid #e2e8f0;
            padding-top: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 10px;
            color: var(--text-muted);
            margin-top: auto;
        }
        .footer-pill {
            background: #f1f5f9;
            padding: 2px 8px;
            border-radius: 8px;
            font-weight: 700;
            color: var(--navy-800);
        }
    </style>
</head>
<body>

    <!-- BOTON FLOTANTE DE IMPRESIÓN -->
    <div class="toolbar no-print">
        <button onclick="window.print()">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>
            Imprimir Folleto en PDF
        </button>
    </div>

    <!-- ========================================================
         PÁGINA 1: NEXUS POS & CONTROL TOTAL DE LA EMPRESA
         ======================================================== -->
    <div class="page">
        <div>
            <header class="page-header">
                <div class="brand-box">
                    ${logoBase64 ? `<img src="${logoBase64}" alt="Nexus POS Logo" class="brand-logo">` : ''}
                    <div class="brand-text">
                        <h1>NEXUS POS GLOBAL</h1>
                        <p>Sistema Inteligente de Punto de Venta & Gestión</p>
                    </div>
                </div>
                <div class="badge-tag">
                    <span>⚡ EDICIÓN 2026</span>
                </div>
            </header>

            <!-- HERO DIRECTO -->
            <div class="hero-banner">
                <div class="hero-title">
                    Tu Negocio Más Rápido, <span>Blindado y en Control Total.</span>
                </div>
                <p class="hero-desc">
                    Nexus POS es la plataforma diseñada para que tu comercio facture a máxima velocidad, elimine errores en caja y nunca se detenga. Conecta ventas rápidas, inventario inteligente, cobro bimoneda y control remoto desde tu celular.
                </p>
            </div>

            <!-- BENEFICIOS CLAVE DEL SISTEMA -->
            <div class="benefits-grid">
                <div class="benefit-card highlight">
                    <div class="benefit-top">
                        <span class="benefit-icon">⚡</span>
                        <h3>Ventas Ultra-Rápidas</h3>
                    </div>
                    <p>Factura y cobra en menos de 3 segundos por cliente. Compatible con lectores de código de barra, balanzas electrónicas de peso y gavetas de dinero.</p>
                </div>

                <div class="benefit-card highlight">
                    <div class="benefit-top">
                        <span class="benefit-icon">📶</span>
                        <h3>Funciona 100% Sin Internet</h3>
                    </div>
                    <p>Si se va la señal o el internet en la zona, tus cajas siguen facturando sin interrupción. Al regresar la conexión, todo se sincroniza automáticamente.</p>
                </div>

                <div class="benefit-card">
                    <div class="benefit-top">
                        <span class="benefit-icon">💵</span>
                        <h3>Bimoneda & Tasa BCV Oficial</h3>
                    </div>
                    <p>Muestra precios y cobra en Dólares ($) o Bolívares (Bs) con la tasa del día del BCV actualizada al instante. Cero pérdidas por cálculo manual.</p>
                </div>

                <div class="benefit-card">
                    <div class="benefit-top">
                        <span class="benefit-icon">📦</span>
                        <h3>Inventario por Bultos y Unidades</h3>
                    </div>
                    <p>Registra entradas por bultos, sacos o cajas y el sistema calcula el costo individual y divide el stock en unidades automáticamente.</p>
                </div>
            </div>

            <!-- NEXUS MOBILE: EN EL TELÉFONO -->
            <div class="mobile-banner">
                <div class="mobile-header-box">
                    <h3>📱 Nexus Mobile: Tu Negocio en el Teléfono</h3>
                    <span>EN TIEMPO REAL</span>
                </div>
                <div class="mobile-items-grid">
                    <div class="mobile-item">
                        <h4>📊 Ventas en Vivo</h4>
                        <p>Mira desde tu casa cuánto está vendiendo cada cajero y revisa los cierres de caja al instante.</p>
                    </div>
                    <div class="mobile-item">
                        <h4>🛒 Preventa en Pasillo</h4>
                        <p>Tus vendedores toman pedidos desde el celular directo en el pasillo para liquidar las colas.</p>
                    </div>
                    <div class="mobile-item">
                        <h4>🏷️ Cambios de Precio</h4>
                        <p>Escanea el producto con la cámara de tu smartphone y actualiza el precio en todas las cajas.</p>
                    </div>
                </div>
            </div>

            <!-- COMPATIBILIDAD Y FISCAL -->
            <div class="hardware-box">
                <div class="hw-group">
                    <h4>🖨️ Facturación e Impresoras Fiscales</h4>
                    <p>The Factory HKA, Bixolon, Epson, Formas Libres, Notas de Entrega y Retenciones IVA / ISLR.</p>
                </div>
                <div class="hw-group" style="text-align: right;">
                    <h4>⚖️ Balanzas & Escáneres</h4>
                    <p>Conexión directa por puerto serial y USB para carnicerías, charcuterías y víveres.</p>
                </div>
            </div>
        </div>

        <footer class="page-footer">
            <div>
                <span class="footer-pill">Nexus Company C.A</span>
                <span>•</span>
                <span>nexusposgobal@gmail.com</span>
            </div>
            <div>Página 1 de 2</div>
        </footer>
    </div>

    <!-- ========================================================
         PÁGINA 2: STUART AI (EL ASISTENTE POR WHATSAPP)
         ======================================================== -->
    <div class="page">
        <div>
            <header class="page-header">
                <div class="brand-box">
                    ${logoBase64 ? `<img src="${logoBase64}" alt="Nexus POS Logo" class="brand-logo">` : ''}
                    <div class="brand-text">
                        <h1>STUART AI • ASISTENTE POR WHATSAPP</h1>
                        <p>Gestión Inteligente de Productos e Inventario</p>
                    </div>
                </div>
                <div class="badge-tag" style="background: #dcfce7; color: #15803d; border-color: #86efac;">
                    <span>💬 VÍA WHATSAPP / API</span>
                </div>
            </header>

            <!-- HERO DE STUART -->
            <div class="stuart-hero">
                <div class="stuart-hero-top">
                    <div class="stuart-hero-title">
                        <div class="stuart-avatar-circle">🤖</div>
                        <div>
                            <h2>Stuart: Tu Asistente de Inventario y Precios</h2>
                            <p>Controla tus productos simplemente enviando un mensaje de WhatsApp</p>
                        </div>
                    </div>
                </div>
                <p class="stuart-hero-desc">
                    Olvídate de procesos manuales complicados. Con Stuart puedes consultar existencias, crear productos, ajustar precios y registrar compras por bultos conversando en lenguaje natural desde tu celular.
                </p>
            </div>

            <!-- SIMULACIÓN DE CHAT WHATSAPP REALISTA -->
            <div class="whatsapp-container">
                <div class="chat-bubble bubble-user">
                    <div class="bubble-header">👤 Dueño (WhatsApp)</div>
                    Stuart, llegaron 5 bultos de Arroz a 14$ el bulto. ¿Cómo quedan los precios?
                </div>

                <div class="chat-bubble bubble-ai">
                    <div class="bubble-header">🤖 Stuart (Nexus AI)</div>
                    ¡Entendido! 5 bultos equivalen a <strong>120 unidades</strong>. El costo unitario es de <strong>$0.58</strong>.<br>
                    • <strong>P1 (Detal):</strong> $0.85 (Margen: 32%)<br>
                    • <strong>P2 (Mayor):</strong> $0.75 | <strong>P3 (Especial):</strong> $0.70<br>
                    ¿Deseas que aplique estos precios y sume las 120 unidades al inventario de la Sucursal Principal?
                </div>

                <div class="chat-bubble bubble-user">
                    <div class="bubble-header">👤 Dueño (WhatsApp)</div>
                    Sí, confirmado.
                </div>

                <div class="chat-bubble bubble-ai">
                    <div class="bubble-header">🤖 Stuart (Nexus AI)</div>
                    ✅ <strong>¡Listo!</strong> Stock y precios actualizados en todas las cajas automáticamente.
                </div>
            </div>

            <!-- RESUMEN DE CAPACIDADES DE STUART -->
            <div class="stuart-functions-grid">
                <div class="function-card">
                    <div class="function-top">
                        <span>🔍</span>
                        <h4>1. Búsqueda y Consulta Instantánea</h4>
                    </div>
                    <p>Ubica cualquier producto por nombre o código. Muestra al instante sus 3 niveles de precio (P1, P2, P3), costo, porcentaje de ganancia y stock por sucursal.</p>
                </div>

                <div class="function-card">
                    <div class="function-top">
                        <span>🛡️</span>
                        <h4>2. Creación y Tríada de Precios Segura</h4>
                    </div>
                    <p>Crea productos guiado paso a paso. Calcula el margen de ganancia automáticamente y <strong>bloquea cualquier cambio que genere pérdidas</strong> sin tu permiso.</p>
                </div>

                <div class="function-card">
                    <div class="function-top">
                        <span>📦</span>
                        <h4>3. Compras por Bultos y Empaques</h4>
                    </div>
                    <p>Escribe <em>"Llegaron 10 bultos a 20$"</em> y Stuart desglosa el empaque en unidades, recalcula el nuevo costo unitario y actualiza las existencias sin errores.</p>
                </div>

                <div class="function-card">
                    <div class="function-top">
                        <span>🌐</span>
                        <h4>4. Tienda Online y Mayoristas</h4>
                    </div>
                    <p>Activa productos en tu catálogo web con un mensaje, asigna etiquetas de <em>Oferta / Nuevo</em> y controla mermas o rendición de cargas al mayor.</p>
                </div>
            </div>

            <!-- CTA COMERCIAL -->
            <div class="cta-banner">
                <div class="cta-text">
                    <h3>¿Listo para modernizar tu negocio?</h3>
                    <p>Instalación rápida, capacitación a tu equipo y soporte continuo.</p>
                </div>
                <div class="cta-contact">
                    📧 nexusposgobal@gmail.com
                </div>
            </div>
        </div>

        <footer class="page-footer">
            <div>
                <span class="footer-pill">Nexus Company C.A</span>
                <span>•</span>
                <span>© 2026 Todos los Derechos Reservados</span>
            </div>
            <div>Página 2 de 2</div>
        </footer>
    </div>

</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'Nexus_POS_Brochure_Imprimir.html'), htmlContent, 'utf8');
console.log("✅ Archivo HTML condensado y claro generado exitosamente.");
