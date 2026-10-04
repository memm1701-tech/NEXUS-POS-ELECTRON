const fs = require('fs');

function injectBackupLogic(file) {
    if (!fs.existsSync(file)) return;
    let code = fs.readFileSync(file, 'utf8');
    
    const backupCode = `
// ============================================================================
// 🛡️ DAEMON DE RESPALDOS AUTOMATICOS (8:00 AM)
// ============================================================================
function iniciarBackupDaemon() {
    if (!config || config.isServer !== true) return; // Solo la máquina maestra respalda

    function programarProximoBackup() {
        const ahora = new Date();
        const manana = new Date(ahora);
        
        // Configurar para las 8:00 AM del día actual
        manana.setHours(8, 0, 0, 0);
        
        // Si ya pasaron las 8:00 AM, programar para mañana a las 8:00 AM
        if (ahora.getTime() >= manana.getTime()) {
            manana.setDate(manana.getDate() + 1);
        }
        
        const msParaEsperar = manana.getTime() - ahora.getTime();
        
        setTimeout(() => {
            ejecutarRespaldoSilencioso();
            programarProximoBackup(); // Reprogramar el siguiente
        }, msParaEsperar);
        
        console.log(\`[BACKUP DAEMON] Respaldo programado para dentro de \${(msParaEsperar / 3600000).toFixed(2)} horas.\`);
    }

    function ejecutarRespaldoSilencioso() {
        try {
            const os = require('os');
            const path = require('path');
            const fs = require('fs');
            
            const docsDir = path.join(os.homedir(), 'Documents', 'NEXUS_BACKUPS');
            
            // Obtener YYYY-MM-DD para la carpeta (Forzando UTC-4 para Caracas si es necesario, o usando local)
            const hoy = new Date();
            const caracasMillis = hoy.getTime() + (hoy.getTimezoneOffset() * 60000) - (4 * 60 * 60 * 1000);
            const cDate = new Date(caracasMillis);
            const pad = (n) => String(n).padStart(2, '0');
            const folderDate = \`\${cDate.getFullYear()}-\${pad(cDate.getMonth() + 1)}-\${pad(cDate.getDate())}\`;
            
            const targetDir = path.join(docsDir, folderDate);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            
            const dbDir = path.join(require('electron').app.getPath('userData'), 'data');
            const dbPath = path.join(dbDir, 'nexus_pos.db');
            const serverDbPath = path.join(dbDir, 'nexus-local-server.db');
            
            // Copiar bases de datos y archivos WAL/SHM temporales si existen para evitar corrupción
            const archivosACopiar = [
                'nexus_pos.db', 'nexus_pos.db-wal', 'nexus_pos.db-shm',
                'nexus-local-server.db', 'nexus-local-server.db-wal', 'nexus-local-server.db-shm'
            ];
            
            archivosACopiar.forEach(archivo => {
                const src = path.join(dbDir, archivo);
                const dest = path.join(targetDir, archivo);
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, dest);
                }
            });
            
            console.log(\`[BACKUP DAEMON] Respaldo exitoso en: \${targetDir}\`);
        } catch (error) {
            console.error(\`[BACKUP DAEMON] Error realizando el respaldo:\`, error.message);
        }
    }

    // Iniciar el ciclo
    programarProximoBackup();
}

// Iniciar daemon de backups 5 segundos despues del arranque para no afectar carga
setTimeout(() => { try { iniciarBackupDaemon(); } catch(e){} }, 5000);
`;

    if (!code.includes('iniciarBackupDaemon')) {
        code = code + "\n" + backupCode;
        fs.writeFileSync(file, code, 'utf8');
        console.log('Daemon de Backups inyectado en ' + file);
    } else {
        console.log('Daemon ya existia en ' + file);
    }
}

injectBackupLogic('main.js');
