const fs = require('fs');
const path = require('path');

// 1. Modificar inicio_cajera.html para agregar el script que oculta la opción
const inicioPath = path.join('c:', 'NEXUS-POS-ELECTRON', 'public', 'inicio_cajera.html');
let contentInicio = fs.readFileSync(inicioPath, 'utf8');

if (!contentInicio.includes('checkBalanzaMenu')) {
    const validationScript = `
<script>
    // Validar si es IMPORTADO para ocultar la opción
    document.addEventListener("DOMContentLoaded", async () => {
        const checkBalanzaMenu = async () => {
            try {
                if (window.nexusAPI && window.nexusAPI.obtenerConfiguracion) {
                    const basculaDataRaw = await window.nexusAPI.obtenerConfiguracion('config_bascula');
                    const balanzaMenu = document.getElementById('menu-balanza-config');
                    if (balanzaMenu) {
                        if (basculaDataRaw) {
                            const data = JSON.parse(basculaDataRaw);
                            if (data.tipoBalanza === 'IMPORTADO') {
                                balanzaMenu.style.display = 'none';
                            } else {
                                balanzaMenu.style.display = '';
                            }
                        } else {
                            balanzaMenu.style.display = '';
                        }
                    }
                }
            } catch (err) {
                console.error("Error validando configuración de balanza:", err);
            }
        };
        
        setTimeout(checkBalanzaMenu, 1000);
        
        // Escuchar por si se guarda la configuracion y se necesita actualizar
        window.addEventListener('configuracion_actualizada', checkBalanzaMenu);
    });
</script>
</body>
</html>`;

    let replaced = false;
    contentInicio = contentInicio.replace(/<\/body>\s*<\/html>/i, () => {
        replaced = true;
        return validationScript;
    });
    
    if (replaced) {
        fs.writeFileSync(inicioPath, contentInicio, 'utf8');
        console.log("inicio_cajera.html updated");
    } else {
        console.log("Could not find </body></html> in inicio_cajera.html");
    }
}

// 2. Modificar configuracion.html para emitir el evento al guardar
const configPath = path.join('c:', 'NEXUS-POS-ELECTRON', 'public', 'index_cajera', 'configuracion', 'configuracion.html');
let configContent = fs.readFileSync(configPath, 'utf8');

if (!configContent.includes('configuracion_actualizada')) {
    const eventEmitScript = `
            await window.nexusAPI.guardarConfiguracion('config_bascula', JSON.stringify(basculaData));
            window.dispatchEvent(new Event('configuracion_actualizada'));
`;
    configContent = configContent.replace(
        /await window\.nexusAPI\.guardarConfiguracion\('config_bascula', JSON\.stringify\(basculaData\)\);/, 
        eventEmitScript
    );
    fs.writeFileSync(configPath, configContent, 'utf8');
    console.log("configuracion.html updated");
}

// 3. Modificar configuracion_balanza.html para mostrar mensaje y bloquear si es IMPORTADO
const balanzaPath = path.join('c:', 'NEXUS-POS-ELECTRON', 'public', 'index_cajera', 'configuracion', 'configuracion_balanza.html');
let balanzaContent = fs.readFileSync(balanzaPath, 'utf8');

if (!balanzaContent.includes('IMPORTADO')) {
    // There are some places that run when DOM is loaded. 
    // Let's add a general check at the end of the script before the closing </script> tag
    
    const generalCheckScript = `
    // Check if IMPORTADO and block the UI
    setTimeout(async () => {
        try {
            if (window.nexusAPI && window.nexusAPI.obtenerConfiguracion) {
                const basculaDataRaw = await window.nexusAPI.obtenerConfiguracion('config_bascula');
                if (basculaDataRaw) {
                    const data = JSON.parse(basculaDataRaw);
                    if (data.tipoBalanza === 'IMPORTADO') {
                        document.body.innerHTML = \`
                            <div class="flex items-center justify-center min-h-screen bg-gray-100">
                                <div class="bg-white p-8 rounded-lg shadow-md text-center max-w-lg">
                                    <i class="fas fa-weight text-blue-500 text-6xl mb-4"></i>
                                    <h2 class="text-2xl font-bold text-gray-800 mb-2">Sección No Disponible</h2>
                                    <p class="text-gray-600 mb-4">Esta sección de configuración de balanza es únicamente para cuando tenemos <strong>Pesos Tradicionales</strong>.</p>
                                    <p class="text-sm text-gray-500">Usted tiene configurado "Pesos Importados" en la Configuración General.</p>
                                </div>
                            </div>
                        \`;
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }
    }, 500);
    `;

    balanzaContent = balanzaContent.replace(/setModoPaso\(1\);\s*inicializarPuertos\(\);\s*}\)\(\);\s*<\/script>/, (match) => {
        return `setModoPaso(1);\n    inicializarPuertos();\n    ${generalCheckScript}\n})();\n</script>`;
    });

    fs.writeFileSync(balanzaPath, balanzaContent, 'utf8');
    console.log("configuracion_balanza.html updated");
}

console.log('Modifications completed successfully');
