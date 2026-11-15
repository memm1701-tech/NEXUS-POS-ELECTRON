'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');

const nominaMod = require('../../services/nomina-ve');
const tasasMod = require('../../services/tasas-grafica');
const fiscalMod = require('../../services/contabilidad-fiscal-ve');

const ROOT = path.resolve(__dirname, '..', '..');

function extractBalancedObject(code, marker) {
    const idx = code.indexOf(marker);
    if (idx === -1) throw new Error(`No se encontró el marcador de esquema: ${marker}`);
    let i = code.indexOf('{', idx);
    let depth = 0;
    let inStr = null;
    let esc = false;
    const start = i;
    for (; i < code.length; i++) {
        const ch = code[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === inStr) inStr = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return code.slice(start, i + 1);
        }
    }
    throw new Error(`Llaves desbalanceadas en esquema: ${marker}`);
}

function loadSchemaObject(target = 'local') {
    const mainPath = path.join(ROOT, 'main.js');
    const serverPath = path.join(ROOT, 'server.js');
    let objSrc;
    if (target === 'maestro') {
        const serverCode = fs.readFileSync(serverPath, 'utf8');
        objSrc = extractBalancedObject(serverCode, 'const ESQUEMA_MAESTRO = {');
    } else if (target === 'maestroLocal') {
        const mainCode = fs.readFileSync(mainPath, 'utf8');
        objSrc = extractBalancedObject(mainCode, 'const ESQUEMA_MAESTRO_LOCAL = {');
    } else {
        const mainCode = fs.readFileSync(mainPath, 'utf8');
        objSrc = extractBalancedObject(mainCode, 'const ESQUEMA_LOCAL = {');
    }

    const schema = vm.runInNewContext(`(${objSrc})`, {
        ESQUEMA_EMPLEADOS_Y_NOMINA: nominaMod.ESQUEMA_EMPLEADOS_Y_NOMINA,
        tasasGrafica: tasasMod,
    });
    fiscalMod.aplicarExtensionesEsquemaCxcCxp(schema);
    return schema;
}

/**
 * Crea una base SQLite en :memory: con el esquema real de NEXUS POS
 * y emula db.transaction(fn) mediante SAVEPOINTs anidables (compatible con better-sqlite3).
 */
function createSqliteTestDb(target = 'local') {
    const schema = loadSchemaObject(target);
    const db = new DatabaseSync(':memory:');

    for (const [tabla, columnas] of Object.entries(schema)) {
        const colDefs = Object.entries(columnas).map(([k, v]) => `${k} ${v}`);
        db.exec(`CREATE TABLE IF NOT EXISTS ${tabla} (${colDefs.join(', ')})`);
    }

    let txCounter = 0;
    db.transaction = function transaction(fn) {
        return function wrappedTx(...args) {
            txCounter++;
            const sp = `sp_test_${txCounter}`;
            db.exec(`SAVEPOINT ${sp}`);
            try {
                const res = fn.apply(this, args);
                db.exec(`RELEASE SAVEPOINT ${sp}`);
                return res;
            } catch (err) {
                try { db.exec(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) {}
                try { db.exec(`RELEASE SAVEPOINT ${sp}`); } catch (_) {}
                throw err;
            }
        };
    };

    return db;
}

module.exports = {
    ROOT,
    loadSchemaObject,
    createSqliteTestDb,
};
