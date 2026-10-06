const fs = require('fs');
const path = require('path');

const filePaths = [
    path.join('c:', 'NEXUS-POS-ELECTRON', 'public', 'index_cajera', 'login.html'),
    path.join('c:', 'NEXUS-POS-ELECTRON', 'public', 'index_cajera', 'punto-de-venta', 'login.html'),
    path.join('c:', 'NEXUS-POS-ELECTRON', 'public', 'index_cajera', 'movimientos_de_caja', 'login_auditoria.html')
];

const auditSnippet = `
                    // REGISTRO DE AUDITORÍA
                    if (window.nexusAPI && window.nexusAPI.guardarAuditoriaAdmin) {
                        try {
                            const sesion = await window.nexusAPI.obtenerSesionLocal();
                            const d = new Date();
                            const c = new Date(d.getTime()+(d.getTimezoneOffset()*60000)-(4*3600000));
                            const p = (n) => String(n).padStart(2,'0');
                            const fechaAudit = c.getFullYear()+'-'+p(c.getMonth()+1)+'-'+p(c.getDate())+' '+p(c.getHours())+':'+p(c.getMinutes())+':'+p(c.getSeconds());

                            let adminName = claveValida.ownerName || 'Administrador';
                            let moduleName = "Acceso a Módulo";

                            if (window.location.href.includes('punto-de-venta/login.html')) {
                                moduleName = "Cierre de Caja";
                            } else if (window.location.href.includes('login_auditoria.html')) {
                                moduleName = "Auditoría";
                            } else {
                                const target = sessionStorage.getItem('pendingConfigTarget') || '';
                                if (target.includes('configuracion_fiscal')) {
                                    moduleName = "Configuración Fiscal";
                                } else if (target.includes('configuracion.html')) {
                                    moduleName = "Configuración General";
                                } else {
                                    moduleName = "Configuración";
                                }
                            }

                            await window.nexusAPI.guardarAuditoriaAdmin({
                                id: 'AUDIT-' + Date.now(),
                                company_id: companyId || (sesion ? sesion.companyId : 'unknown'),
                                branch_id: (sesion ? sesion.branchId : 'unknown'),
                                cashier_id: (sesion ? sesion.uid : 'unknown'),
                                admin_name: adminName,
                                accion: 'Acceso a ' + moduleName,
                                detalles: 'Se autorizó el acceso a las opciones del sistema: ' + moduleName,
                                fecha: fechaAudit
                            });
                        } catch (err) {
                            console.error("Error guardando auditoría:", err);
                        }
                    }
`;

for (let file of filePaths) {
    if (fs.existsSync(file)) {
        let content = fs.readFileSync(file, 'utf8');

        // Modify index_cajera/login.html since it uses esClaveValida
        if (file.includes('index_cajera\\login.html')) {
            content = content.replace(
                /const esClaveValida = clavesGuardadas\.some\(clave => clave\.plainCode === inputCode\);\s*if \(esClaveValida\) \{/,
                `const claveValida = clavesGuardadas.find(clave => clave.plainCode === inputCode);\n                if (claveValida) {`
            );
        }

        // Ensure we don't insert it multiple times
        if (!content.includes('REGISTRO DE AUDITORÍA')) {
            content = content.replace(
                /const accessKey = generateSecureToken\(32\);\s*sessionStorage\.setItem\('adminAccessKey', accessKey\);/,
                `const accessKey = generateSecureToken(32);\n                    sessionStorage.setItem('adminAccessKey', accessKey);\n${auditSnippet}`
            );
            fs.writeFileSync(file, content, 'utf8');
            console.log(`Updated ${file}`);
        } else {
            console.log(`Audit logic already exists in ${file}`);
        }
    } else {
        console.log(`File not found: ${file}`);
    }
}
