/**
 * Shared security utilities for NEXUS POS Electron main process and LAN server.
 * Handles password hashing/verification, timing-safe secret comparisons,
 * multi-key AES-256-CBC migration support, path containment, URL allowlists,
 * permission checks, and SQLite backup integrity verification.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IV_LENGTH = 16;

const ALLOWED_UPDATE_HOSTS = new Set([
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com',
    'api.nexusposgobal.com',
    'tienda.nexusposgobal.com'
]);

/**
 * Computes a salted scrypt password hash string ("scrypt:<saltHex>:<derivedHex>").
 */
function hashPassword(password) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('La contraseña no puede estar vacía.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt:${salt}:${derived}`;
}

/**
 * Verifies a plaintext password against a stored salted scrypt hash in constant time.
 */
function verifyPassword(password, storedHash) {
    if (typeof password !== 'string' || typeof storedHash !== 'string' || !storedHash.startsWith('scrypt:')) {
        return false;
    }
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const [, salt, expectedHex] = parts;
    if (!salt || !expectedHex) return false;
    try {
        const expectedBuf = Buffer.from(expectedHex, 'hex');
        const actualBuf = crypto.scryptSync(password, salt, expectedBuf.length);
        if (actualBuf.length !== expectedBuf.length) return false;
        return crypto.timingSafeEqual(actualBuf, expectedBuf);
    } catch (_) {
        return false;
    }
}

/**
 * Constant-time string comparison using SHA-256 digests so length mismatches
 * never leak timing or throw.
 */
function timingSafeEqualStr(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
    const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Ensures an env file contains key=value for an auto-generated per-install secret.
 * Never logs the secret value. Mutates envContent or creates the key in process.env.
 */
function ensureRandomEnvSecret(envPath, varName, byteLength = 32, upperHex = false) {
    const existingEnv = process.env[varName];
    if (existingEnv && existingEnv.trim()) {
        return existingEnv.trim();
    }

    let content = '';
    if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, 'utf8');
        const re = new RegExp(`^\\s*${varName}=["']?([^"'\\r\\n]+)["']?`, 'm');
        const m = content.match(re);
        if (m && m[1] && m[1].trim()) {
            const val = m[1].trim();
            process.env[varName] = val;
            return val;
        }
    }

    let generated = crypto.randomBytes(byteLength).toString('hex');
    if (upperHex) generated = generated.toUpperCase();
    const line = `${varName}=${generated}`;
    const updated = content ? (content.endsWith('\n') ? `${content}${line}\n` : `${content}\n${line}\n`) : `${line}\n`;
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, updated, 'utf8');
    process.env[varName] = generated;
    return generated;
}

/**
 * Builds an AES-256 encryption key Buffer from a hex string or passphrase.
 */
function deriveAesKey(rawKey) {
    if (Buffer.isBuffer(rawKey) && rawKey.length === 32) return rawKey;
    const str = String(rawKey || '');
    if (/^[0-9a-fA-F]{64}$/.test(str)) {
        return Buffer.from(str, 'hex');
    }
    return crypto.createHash('sha256').update(str, 'utf8').digest();
}

/**
 * Encrypts plaintext with AES-256-CBC and a random IV.
 */
function encryptWithKey(text, keyBuf) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
    const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts AES-256-CBC ciphertext, trying each candidate key in order so
 * per-install keys and rotated keys remain backwards-compatible.
 */
function decryptWithKeys(text, keyBuffers) {
    if (!text || typeof text !== 'string' || !text.includes(':')) return 'ERROR_DESCIFRADO';
    const parts = text.split(':');
    const ivHex = parts.shift();
    const cipherHex = parts.join(':');
    let iv;
    let encrypted;
    try {
        iv = Buffer.from(ivHex, 'hex');
        encrypted = Buffer.from(cipherHex, 'hex');
    } catch (_) {
        return 'ERROR_DESCIFRADO';
    }
    if (iv.length !== IV_LENGTH || encrypted.length === 0) return 'ERROR_DESCIFRADO';

    for (const keyBuf of keyBuffers) {
        if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) continue;
        try {
            const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
            const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            return decrypted.toString('utf8');
        } catch (_) {
            // Try next key
        }
    }
    return 'ERROR_DESCIFRADO';
}

/**
 * Checks whether an admin key entry grants permission for a given POS action.
 */
function validarPermisoDeClave(claveObj, accion) {
    if (!claveObj) return false;
    const esMaster = (
        claveObj.is_master === 1 ||
        claveObj.is_master === true ||
        claveObj.is_master === '1' ||
        claveObj.is_master === 'true' ||
        claveObj.isMaster === true ||
        claveObj.isMaster === 1
    );
    if (esMaster) return true;
    if (!accion || accion === 'any') return true;

    let permisos = claveObj.permisos;
    if (typeof permisos === 'string') {
        try {
            permisos = JSON.parse(permisos);
        } catch (_) {
            permisos = null;
        }
    }
    if (!permisos || typeof permisos !== 'object') return false;

    const esTrue = (v) => v === true || v === 1 || v === 'true' || v === '1';

    if (accion === 'config_general') {
        return esTrue(permisos.opciones_fiscales) || esTrue(permisos.config_general) || Object.values(permisos).some(esTrue);
    }
    if (accion === 'eliminar_producto') return esTrue(permisos.eliminar_producto);
    if (accion === 'vaciar_carrito') return esTrue(permisos.vaciar_carrito);
    if (accion === 'eliminar_factura') return esTrue(permisos.eliminar_factura);
    if (accion === 'guia_despacho') return esTrue(permisos.guia_despacho) || esTrue(permisos.opciones_fiscales);
    if (accion === 'cierre_de_caja' || accion === 'arqueo_caja') return esTrue(permisos.cierre_de_caja);
    if (accion === 'autorizar_credito') return esTrue(permisos.autorizar_credito);

    const docFiscales = ['nota_credito', 'nota_debito', 'retencion_iva', 'retencion_islr', 'comprobante_arcv', 'anulacion_no_fiscal', 'opciones_fiscales'];
    if (docFiscales.includes(accion)) {
        return esTrue(permisos.opciones_fiscales);
    }
    return esTrue(permisos[accion]);
}

/**
 * Resolves a relative route inside public/ and prevents directory traversal or
 * scheme smuggling (returns { ok, filePath, relativePath, search, hash }).
 */
function resolveSafePublicRoute(publicDir, rawRuta) {
    if (typeof rawRuta !== 'string' || !rawRuta.trim()) {
        return { ok: false, reason: 'Ruta vacía' };
    }
    if (/[\x00-\x1f]/.test(rawRuta) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawRuta) || rawRuta.startsWith('//')) {
        return { ok: false, reason: 'Esquema no permitido en ruta' };
    }

    const hashIdx = rawRuta.indexOf('#');
    const hashPart = hashIdx >= 0 ? rawRuta.slice(hashIdx) : '';
    const beforeHash = hashIdx >= 0 ? rawRuta.slice(0, hashIdx) : rawRuta;
    const queryIdx = beforeHash.indexOf('?');
    const searchPart = queryIdx >= 0 ? beforeHash.slice(queryIdx) : '';
    let pathPart = (queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash).replace(/\\/g, '/').replace(/^\/+/, '');

    if (pathPart.startsWith('public/')) {
        pathPart = pathPart.slice('public/'.length);
    }

    const baseResolved = path.resolve(publicDir);
    const targetResolved = path.resolve(baseResolved, pathPart);
    const baseNormalized = process.platform === 'win32' ? baseResolved.toLowerCase() : baseResolved;
    const targetNormalized = process.platform === 'win32' ? targetResolved.toLowerCase() : targetResolved;

    if (targetNormalized !== baseNormalized && !targetNormalized.startsWith(baseNormalized + path.sep)) {
        return { ok: false, reason: 'Ruta fuera del directorio permitido' };
    }
    return {
        ok: true,
        filePath: targetResolved,
        relativePath: path.relative(baseResolved, targetResolved).replace(/\\/g, '/'),
        search: searchPart,
        hash: hashPart
    };
}

/**
 * Validates that an update download URL uses HTTPS and points to an allowlisted host.
 */
function isAllowedUpdateUrl(urlStr) {
    if (typeof urlStr !== 'string' || !urlStr.trim()) return false;
    try {
        const u = new URL(urlStr.trim());
        if (u.protocol !== 'https:') return false;
        const host = u.hostname.toLowerCase();
        return ALLOWED_UPDATE_HOSTS.has(host);
    } catch (_) {
        return false;
    }
}

/**
 * Validates whether a URL belongs to local app assets inside the packaged/repo directory.
 */
function isTrustedLocalAppUrl(urlStr, appRootDir) {
    if (typeof urlStr !== 'string' || !urlStr) return false;
    try {
        const u = new URL(urlStr);
        if (u.protocol !== 'file:') return false;
        let pathname = decodeURIComponent(u.pathname);
        if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(pathname)) {
            pathname = pathname.slice(1);
        }
        const resolved = path.resolve(pathname);
        const root = path.resolve(appRootDir);
        const a = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        const b = process.platform === 'win32' ? root.toLowerCase() : root;
        return a === b || a.startsWith(b + path.sep);
    } catch (_) {
        return false;
    }
}

/**
 * Sanitizes single-line .env configuration values (rejects CR/LF/NUL injection).
 */
function sanitizeEnvSingleLine(val, maxLen = 256) {
    if (val === null || val === undefined) return '';
    const str = String(val).trim();
    if (/[\r\n\0]/.test(str)) {
        throw new Error('Valor de configuración contiene caracteres de salto de línea no permitidos.');
    }
    if (str.length > maxLen) {
        throw new Error('Valor de configuración excede la longitud máxima permitida.');
    }
    return str;
}

/**
 * Validates a Windows printer/share name to prevent command injection.
 */
function sanitizePrinterShareName(name) {
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 128) return null;
    if (!/^[A-Za-z0-9 _.-]+$/.test(trimmed)) return null;
    return trimmed;
}

/**
 * Validates that a candidate backup SQLite database passes PRAGMA integrity_check
 * and includes expected core tables before restoring over live data.
 */
function validateSqliteBackupFile(DatabaseCtor, dbFilePath, requiredTables = []) {
    if (!fs.existsSync(dbFilePath)) {
        return { valid: false, reason: 'El archivo de respaldo no existe.' };
    }
    const fd = fs.openSync(dbFilePath, 'r');
    try {
        const header = Buffer.alloc(16);
        const bytesRead = fs.readSync(fd, header, 0, 16, 0);
        if (bytesRead < 16 || header.toString('utf8', 0, 15) !== 'SQLite format 3') {
            return { valid: false, reason: 'El archivo no tiene cabecera SQLite válida.' };
        }
    } finally {
        fs.closeSync(fd);
    }

    let testDb = null;
    try {
        testDb = new DatabaseCtor(dbFilePath, { readonly: true, fileMustExist: true });
        const integrity = testDb.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') {
            return { valid: false, reason: `Integridad SQLite fallida: ${integrity}` };
        }
        if (requiredTables.length > 0) {
            const rows = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
            const existing = new Set(rows.map(r => r.name));
            const missing = requiredTables.filter(t => !existing.has(t));
            if (missing.length > 0) {
                return { valid: false, reason: `Faltan tablas requeridas en el respaldo: ${missing.join(', ')}` };
            }
        }
        return { valid: true };
    } catch (e) {
        return { valid: false, reason: e.message };
    } finally {
        try { if (testDb) testDb.close(); } catch (_) {}
    }
}

/**
 * Validates positive finite numeric amounts/quantities with optional upper bound.
 */
function parsePositiveFiniteNumber(val, max = 1e12) {
    const num = Number(val);
    if (!Number.isFinite(num) || num <= 0 || num > max) return null;
    return num;
}

/**
 * Checks whether an HTTP Origin header is from localhost or a private LAN host.
 */
function isPrivateOrLocalOrigin(origin) {
    if (!origin || typeof origin !== 'string') return false;
    if (origin === 'null' || origin.startsWith('file://')) return true;
    try {
        const u = new URL(origin);
        const host = u.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
        if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
        if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
        const m172 = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
        if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
        return false;
    } catch (_) {
        return false;
    }
}

module.exports = {
    ALLOWED_UPDATE_HOSTS,
    hashPassword,
    verifyPassword,
    timingSafeEqualStr,
    ensureRandomEnvSecret,
    deriveAesKey,
    encryptWithKey,
    decryptWithKeys,
    validarPermisoDeClave,
    resolveSafePublicRoute,
    isAllowedUpdateUrl,
    isTrustedLocalAppUrl,
    sanitizeEnvSingleLine,
    sanitizePrinterShareName,
    validateSqliteBackupFile,
    parsePositiveFiniteNumber,
    isPrivateOrLocalOrigin
};
