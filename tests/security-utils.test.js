'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const sec = require('../services/security-utils');

test('hashPassword / verifyPassword soporta scrypt y rechaza claves incorrectas', () => {
    const hash = sec.hashPassword('ClaveSegura#2026');
    assert.ok(hash.startsWith('scrypt:'));
    assert.equal(sec.verifyPassword('ClaveSegura#2026', hash), true);
    assert.equal(sec.verifyPassword('otra_clave', hash), false);
    assert.equal(sec.verifyPassword('', hash), false);
    assert.equal(sec.verifyPassword('ClaveSegura#2026', 'malformed'), false);
});

test('encryptWithKey y decryptWithKeys cifran y descifran UTF-8 y reportan ERROR_DESCIFRADO con clave errónea', () => {
    const k1 = sec.deriveAesKey('secreto-primario-test');
    const k2 = sec.deriveAesKey('secreto-secundario-test');
    const cipher = sec.encryptWithKey('TokenSENIAT|J-12345678-9|ñáéíóú', k1);
    assert.notEqual(cipher, 'TokenSENIAT|J-12345678-9|ñáéíóú');
    assert.equal(sec.decryptWithKeys(cipher, [k2, k1]), 'TokenSENIAT|J-12345678-9|ñáéíóú');
    assert.equal(sec.decryptWithKeys(cipher, [k2]), 'ERROR_DESCIFRADO');
});

test('resolveSafePublicRoute permite archivos bajo public/ y bloquea traversal o esquemas externos', () => {
    const publicDir = path.resolve(__dirname, '..', 'public');
    const valid = sec.resolveSafePublicRoute(publicDir, 'inicio.html?tab=1#top');
    assert.equal(valid.ok, true);
    assert.equal(path.basename(valid.filePath), 'inicio.html');

    for (const bad of ['../main.js', '..\\package.json', 'https://evil.com/x.html', 'javascript:alert(1)', '..\\..\\Windows\\win.ini']) {
        const res = sec.resolveSafePublicRoute(publicDir, bad);
        assert.equal(res.ok, false, `Debió bloquear ruta insegura: ${bad}`);
    }
});

test('isAllowedUpdateUrl y isPrivateOrLocalOrigin validan listas blancas correctamente', () => {
    assert.equal(sec.isAllowedUpdateUrl('https://github.com/org/repo/releases/latest'), true);
    assert.equal(sec.isAllowedUpdateUrl('http://github.com/org/repo'), false);
    assert.equal(sec.isAllowedUpdateUrl('https://evil.example.com/update.exe'), false);

    assert.equal(sec.isPrivateOrLocalOrigin('http://localhost:3000'), true);
    assert.equal(sec.isPrivateOrLocalOrigin('http://192.168.1.50:8080'), true);
    assert.equal(sec.isPrivateOrLocalOrigin('http://172.16.0.10'), true);
    assert.equal(sec.isPrivateOrLocalOrigin('https://8.8.8.8'), false);
});

test('validarPermisoDeClave respeta modo maestro, permisos JSON y restricciones por módulo', () => {
    const master = { is_master: 1, permisos: '{}' };
    assert.equal(sec.validarPermisoDeClave(master, 'eliminar_factura'), true);

    const limited = { is_master: 0, permisos: JSON.stringify({ eliminar_producto: true, opciones_fiscales: true }) };
    assert.equal(sec.validarPermisoDeClave(limited, 'eliminar_producto'), true);
    assert.equal(sec.validarPermisoDeClave(limited, 'nota_credito'), true);
    assert.equal(sec.validarPermisoDeClave(limited, 'eliminar_factura'), false);
    assert.equal(sec.validarPermisoDeClave(limited, 'cierre_de_caja'), false);
});

test('parsePositiveFiniteNumber y sanitización de env/impresora', () => {
    assert.equal(sec.parsePositiveFiniteNumber('125.5'), 125.5);
    assert.equal(sec.parsePositiveFiniteNumber(0), null);
    assert.equal(sec.parsePositiveFiniteNumber(-5), null);
    assert.equal(sec.parsePositiveFiniteNumber(NaN), null);
    assert.equal(sec.parsePositiveFiniteNumber(Infinity), null);

    assert.throws(() => sec.sanitizeEnvSingleLine('hola\nMAL=1\r\n'));
    assert.equal(sec.sanitizeEnvSingleLine('VALOR_SEGURO_123'), 'VALOR_SEGURO_123');
    assert.equal(sec.sanitizePrinterShareName('EPSON TM-T20II'), 'EPSON TM-T20II');
    assert.equal(sec.sanitizePrinterShareName('\\\\SERVIDOR\\Bad;rm -rf'), null);
});

test('validateSqliteBackupFile acepta backups válidos y rechaza corruptos o sin tablas', () => {
    class DatabaseSyncCompat extends DatabaseSync {
        pragma(expr, opts = {}) {
            const row = this.prepare(`PRAGMA ${expr}`).get();
            if (opts && opts.simple && row) return Object.values(row)[0];
            return row;
        }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-bkp-'));
    const goodDbPath = path.join(tmpDir, 'good.db');
    const badDbPath = path.join(tmpDir, 'bad.db');
    try {
        const db = new DatabaseSync(goodDbPath);
        db.exec("CREATE TABLE configuracion (clave TEXT, valor TEXT); INSERT INTO configuracion VALUES ('TASA', '50');");
        db.close();

        const ok = sec.validateSqliteBackupFile(DatabaseSyncCompat, goodDbPath, ['configuracion']);
        assert.equal(ok.valid, true);

        const missingTable = sec.validateSqliteBackupFile(DatabaseSyncCompat, goodDbPath, ['tabla_inexistente']);
        assert.equal(missingTable.valid, false);

        fs.writeFileSync(badDbPath, 'not a sqlite file');
        const bad = sec.validateSqliteBackupFile(DatabaseSyncCompat, badDbPath, ['configuracion']);
        assert.equal(bad.valid, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
});
