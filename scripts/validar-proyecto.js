'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__', 'data', 'video']);
const IGNORE_VENDOR_JS = new Set([
    'chart.umd.js',
    'jsbarcode.all.min.js',
    'JsBarcode.all.min.js',
    'jsdelivr.js',
    'socket.io.min.js',
    'tailwindcss.js',
    'xlsx.full.min.js',
]);
const ALLOWLIST_COPY_FILES = new Set([
    'public/image_b9add182 - copia-Photoroom.png',
]);
const ALLOWLIST_LEGACY_PREPARE_TABLES = new Set([
    'cierres_caja', // Legacy fallback guarded inside try/catch when DB uses historial_cierres_caja
    'staging_hka_en_vuelo',
    'guias_despacho',
    'sync_queue',
    'movimientos_stock_maestro',
]);

let errors = 0;
let warnings = 0;

function fail(tag, msg) {
    errors++;
    console.error(`[FAIL] [${tag}] ${msg}`);
}

function warn(tag, msg) {
    warnings++;
    console.warn(`[WARN] [${tag}] ${msg}`);
}

function pass(tag, msg) {
    console.log(`[OK] [${tag}] ${msg}`);
}

function walkFiles(dir, filterFn, results = []) {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkFiles(full, filterFn, results);
        } else if (!filterFn || filterFn(full, entry.name)) {
            results.push(full);
        }
    }
    return results;
}

function toPosixRel(absPath) {
    return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function lineAt(text, index) {
    return text.slice(0, index).split('\n').length;
}

function extractBalancedBlock(code, marker, openCh = '{', closeCh = '}') {
    const idx = code.indexOf(marker);
    if (idx === -1) return null;
    let i = code.indexOf(openCh, idx);
    if (i === -1) return null;
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
        if (ch === openCh) depth++;
        else if (ch === closeCh) {
            depth--;
            if (depth === 0) return code.slice(start, i + 1);
        }
    }
    return null;
}

function readBalancedParen(str, openIdx) {
    let i = openIdx + 1;
    let depth = 1;
    let inStr = null;
    let esc = false;
    for (; i < str.length && depth > 0; i++) {
        const ch = str[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === inStr) inStr = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
    }
    if (depth !== 0) return null;
    return { inner: str.slice(openIdx + 1, i - 1), endIdx: i };
}

function isInsideRoot(targetPath) {
    const rel = path.relative(ROOT, targetPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveHtmlAssetExists(htmlFile, rawRef) {
    const clean = rawRef.split('?')[0].split('#')[0].trim();
    if (!clean || /^(https?:|about:|data:|blob:|mailto:|tel:|javascript:|#|\/\/|\$\{)/i.test(clean)) {
        return true;
    }
    const targetRel = path.resolve(path.dirname(htmlFile), clean);
    if (isInsideRoot(targetRel) && fs.existsSync(targetRel)) return true;
    const isInPublic = isInsideRoot(htmlFile) && toPosixRel(htmlFile).startsWith('public/');
    if (isInPublic) {
        const targetPublic = path.resolve(ROOT, 'public', clean.replace(/^\/+/, ''));
        if (isInsideRoot(targetPublic) && fs.existsSync(targetPublic)) return true;
    }
    return false;
}

function stripHtmlNonMarkup(html) {
    return html
        .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, m => m.replace(/[^\n]/g, ' '))
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, m => m.replace(/[^\n]/g, ' '));
}

// =========================================================================
// 1. JSON VALIDATION
// =========================================================================
function checkJsonFiles() {
    const candidates = [
        path.join(ROOT, 'package.json'),
        path.join(ROOT, 'data', 'config.json'),
        path.join(ROOT, '.vscode', 'settings.json'),
    ];
    let checked = 0;
    for (const file of candidates) {
        if (!fs.existsSync(file)) {
            if (path.basename(file) === 'package.json') {
                fail('JSON', 'package.json no existe en la raíz del proyecto');
            }
            continue;
        }
        try {
            const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
            JSON.parse(raw);
            checked++;
        } catch (err) {
            fail('JSON', `${toPosixRel(file)} tiene JSON inválido: ${err.message}`);
        }
    }
    pass('JSON', `${checked} archivos JSON validados correctamente.`);
}

// =========================================================================
// 2. JS SYNTAX (node --check) & LOCAL REQUIRE() RESOLUTION
// =========================================================================
function checkJsSyntaxAndRequires() {
    const customPublicJs = walkFiles(
        path.join(ROOT, 'public'),
        (full, name) => name.toLowerCase().endsWith('.js') && !IGNORE_VENDOR_JS.has(name) && !name.endsWith('.min.js')
    );
    const serviceJs = walkFiles(path.join(ROOT, 'services'), (_, name) => name.toLowerCase().endsWith('.js'));
    const scriptJs = walkFiles(path.join(ROOT, 'scripts'), (_, name) => name.toLowerCase().endsWith('.js'));
    const testJs = walkFiles(path.join(ROOT, 'tests'), (_, name) => name.toLowerCase().endsWith('.js'));

    const allJsFiles = [
        path.join(ROOT, 'main.js'),
        path.join(ROOT, 'preload.js'),
        path.join(ROOT, 'server.js'),
        ...serviceJs,
        ...scriptJs,
        ...customPublicJs,
        ...testJs,
    ].filter(f => fs.existsSync(f));

    for (const file of allJsFiles) {
        try {
            execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        } catch (err) {
            fail('JS-SYNTAX', `${toPosixRel(file)}: ${err.stderr?.toString().trim() || err.message}`);
        }
    }
    pass('JS-SYNTAX', `${allJsFiles.length} archivos JavaScript verificados con node --check.`);

    // Resolve local relative require('./...') / require('../...')
    const backendJs = [
        path.join(ROOT, 'main.js'),
        path.join(ROOT, 'preload.js'),
        path.join(ROOT, 'server.js'),
        ...serviceJs,
        ...scriptJs,
        ...testJs,
    ].filter(f => fs.existsSync(f));

    let requireCount = 0;
    const serviceExports = new Map();
    for (const sf of serviceJs) {
        try {
            const mod = require(sf);
            serviceExports.set(path.basename(sf), new Set(Object.keys(mod)));
        } catch (err) {
            fail('SERVICE-LOAD', `services/${path.basename(sf)} falló al importar: ${err.message}`);
        }
    }

    for (const file of backendJs) {
        const code = fs.readFileSync(file, 'utf8');
        const codeNoComments = code.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, m => m.replace(/[^\n]/g, ' '));
        const reqRegex = /\brequire\s*\(\s*(['"`])(\.[^'"`]+)\1\s*\)/g;
        let m;
        while ((m = reqRegex.exec(codeNoComments)) !== null) {
            requireCount++;
            const rel = m[2];
            const candidates = [
                path.resolve(path.dirname(file), rel),
                path.resolve(path.dirname(file), `${rel}.js`),
                path.resolve(path.dirname(file), `${rel}.json`),
                path.resolve(path.dirname(file), rel, 'index.js'),
            ];
            if (!candidates.some(p => fs.existsSync(p))) {
                fail('REQUIRE', `${toPosixRel(file)}:${lineAt(code, m.index)} require('${rel}') no existe en disco`);
            }
        }

        // Destructured imports from services modules
        const destrRe = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*['"](\.[^'"]*\/services\/[^'"]+|\.\/[^'"]+)['"]\s*\)/g;
        while ((m = destrRe.exec(codeNoComments)) !== null) {
            const reqPath = m[2];
            const base = path.basename(reqPath.endsWith('.js') ? reqPath : `${reqPath}.js`);
            const expSet = serviceExports.get(base);
            if (!expSet) continue;
            const keys = m[1]
                .split(',')
                .map(s => s.trim().split(':')[0].trim())
                .filter(Boolean);
            for (const k of keys) {
                if (!expSet.has(k)) {
                    fail('EXPORT-MISSING', `${toPosixRel(file)}:${lineAt(code, m.index)} desestructura "${k}" desde ${base}, pero no está exportado`);
                }
            }
        }
    }
    pass('REQUIRE', `${requireCount} require() relativos y exportaciones de servicios verificados.`);
}

// =========================================================================
// 3. HTML: <script>, INLINE EVENT HANDLERS, DUPLICATE IDS, ASSETS
// =========================================================================
function checkHtmlFiles() {
    const htmlFiles = [
        path.join(ROOT, 'splash.html'),
        ...walkFiles(path.join(ROOT, 'public'), (_, name) => name.toLowerCase().endsWith('.html')),
    ].filter(f => fs.existsSync(f));

    let scriptBlocksChecked = 0;
    let inlineEventsChecked = 0;
    let refsChecked = 0;

    for (const file of htmlFiles) {
        const html = fs.readFileSync(file, 'utf8');
        const relPath = toPosixRel(file);

        // Balance check for <script> tags
        const openScripts = (html.match(/<script\b/gi) || []).length;
        const closeScripts = (html.match(/<\/script>/gi) || []).length;
        if (openScripts !== closeScripts) {
            fail('HTML-SCRIPT', `${relPath} tiene <script> desbalanceados (open=${openScripts}, close=${closeScripts})`);
        }

        // Check <script> blocks
        const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
        let sm;
        let blockIdx = 0;
        while ((sm = scriptRegex.exec(html)) !== null) {
            blockIdx++;
            const attrs = sm[1] || '';
            const body = sm[2] || '';
            const startLine = lineAt(html, sm.index);
            const srcMatch = /\bsrc\s*=\s*(['"])([^'"]+)\1/i.exec(attrs);
            if (srcMatch) {
                const rawSrc = srcMatch[2].trim();
                const clean = rawSrc.split('?')[0].split('#')[0];
                if (clean && !/^(https?:|about:|data:|blob:|\/\/|\$\{)/i.test(clean)) {
                    refsChecked++;
                    if (!resolveHtmlAssetExists(file, rawSrc)) {
                        fail('ASSET-SRC', `${relPath}:${startLine} script src no encontrado -> ${rawSrc}`);
                    }
                }
                if (body.trim().length > 0) {
                    warn('HTML-SCRIPT', `${relPath}:${startLine} tiene src y código inline simultáneo`);
                }
                continue;
            }

            if (!body.trim()) continue;
            scriptBlocksChecked++;
            const isModule = /\btype\s*=\s*(['"])module\1/i.test(attrs);
            const padded = '\n'.repeat(startLine - 1) + body;
            try {
                if (isModule) {
                    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: padded, stdio: 'pipe' });
                } else {
                    new vm.Script(padded, { filename: relPath });
                }
            } catch (err) {
                const msg = err.stderr ? err.stderr.toString().trim() : (err.message || String(err));
                fail('HTML-SCRIPT', `${relPath} <script #${blockIdx} @ L${startLine}>: ${msg}`);
            }
        }

        // Strip scripts/styles/comments once for attribute & ID checks
        const stripped = stripHtmlNonMarkup(html);

        // Inline event handlers (onclick, onchange, etc.)
        const evRe = /\bon(click|change|input|submit|load|keyup|keydown|keypress|blur|focus|mouseover|mouseout|dblclick)\s*=\s*(["'])([\s\S]*?)\2/gi;
        let em;
        while ((em = evRe.exec(stripped)) !== null) {
            const code = em[3].trim();
            if (!code || code.includes('${')) continue;
            inlineEventsChecked++;
            try {
                new vm.Script(`(function(){ ${code} })`);
            } catch (err) {
                fail('HTML-EVENT', `${relPath}:${lineAt(stripped, em.index)} on${em[1]}="${code.slice(0, 60)}" -> ${err.message}`);
            }
        }

        // Duplicate DOM IDs
        const idRe = /\bid\s*=\s*(["'])([^"']+)\1/gi;
        const ids = new Map();
        let im;
        while ((im = idRe.exec(stripped)) !== null) {
            const id = im[2].trim();
            if (!id || id.includes('${')) continue;
            if (!ids.has(id)) ids.set(id, []);
            ids.get(id).push(lineAt(stripped, im.index));
        }
        for (const [id, lines] of ids.entries()) {
            if (lines.length > 1) {
                fail('DUPLICATE-ID', `${relPath} tiene id="${id}" duplicado en líneas ${lines.join(', ')}`);
            }
        }

        // Local asset href/src references on media/stylesheet/frame tags (avoids JS inside onerror="..." and dead landing links)
        const tagRe = /<(?:link|img|video|audio|source|iframe|embed)\b([^>]+)>/gi;
        let tm;
        while ((tm = tagRe.exec(stripped)) !== null) {
            const attrs = tm[1];
            const attrMatch = /(?:^|\s)(?:href|src)\s*=\s*(['"])([^'"]+)\1/i.exec(attrs);
            if (!attrMatch) continue;
            const raw = attrMatch[2].trim();
            const clean = raw.split('?')[0].split('#')[0].trim();
            if (!clean || /^(https?:|about:|data:|blob:|mailto:|tel:|javascript:|#|\/\/|\$\{)/i.test(clean)) continue;
            refsChecked++;
            if (!resolveHtmlAssetExists(file, raw)) {
                fail('ASSET-REF', `${relPath}:${lineAt(stripped, tm.index)} recurso no encontrado -> ${raw}`);
            }
        }
    }

    pass('HTML', `${htmlFiles.length} HTML, ${scriptBlocksChecked} <script> inline, ${inlineEventsChecked} handlers y ${refsChecked} rutas de recursos validados.`);
}

// =========================================================================
// 4. DUPLICATE / COPY FILENAME DETECTION
// =========================================================================
function checkCopyFilenames() {
    const scanRoots = [
        ROOT,
        path.join(ROOT, 'services'),
        path.join(ROOT, 'scripts'),
        path.join(ROOT, 'tests'),
        path.join(ROOT, 'public'),
    ];
    const files = [];
    for (const f of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (f.isFile()) files.push(path.join(ROOT, f.name));
    }
    for (const dir of scanRoots.slice(1)) {
        walkFiles(dir, null, files);
    }

    const copyRe = /(\bcopia\b|\bcopy\b|_copia|\(\d+\)\.[a-z0-9]+$)/i;
    let flagged = 0;
    for (const file of files) {
        const rel = toPosixRel(file);
        if (rel.startsWith('assets/')) continue;
        if (ALLOWLIST_COPY_FILES.has(rel)) continue;
        if (copyRe.test(path.basename(file))) {
            flagged++;
            fail('COPY-FILE', `Archivo copia/duplicado detectado fuera de lista permitida: ${rel}`);
        }
    }
    if (flagged === 0) {
        pass('COPY-FILE', 'Sin archivos copia/duplicados no autorizados en el árbol del proyecto.');
    }
}

// =========================================================================
// 5. IPC SYMMETRY, EXPRESS ROUTES & ELECTRON SECURITY
// =========================================================================
function checkIpcRoutesAndSecurity() {
    const mainCode = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const preloadCode = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    // Preload IPC channels
    const preloadInvoke = new Map();
    const preloadSend = new Map();
    const ipcRe = /ipcRenderer\.(invoke|send|sendSync|on|once)\s*\(\s*(['"`])([^'"`]+)\2/g;
    let pm;
    while ((pm = ipcRe.exec(preloadCode)) !== null) {
        const kind = pm[1];
        const ch = pm[3];
        const ln = lineAt(preloadCode, pm.index);
        if (kind === 'invoke') preloadInvoke.set(ch, ln);
        else if (kind === 'send' || kind === 'sendSync') preloadSend.set(ch, ln);
    }

    // main.js IPC handlers
    const mainHandle = new Map();
    const mainOn = new Map();
    const mainIpcRe = /ipcMain\.(handle|on|once)\s*\(\s*(['"`])([^'"`]+)\2/g;
    let mm;
    while ((mm = mainIpcRe.exec(mainCode)) !== null) {
        const kind = mm[1];
        const ch = mm[3];
        const ln = lineAt(mainCode, mm.index);
        const map = kind === 'handle' ? mainHandle : mainOn;
        if (!map.has(ch)) map.set(ch, []);
        map.get(ch).push(ln);
    }

    for (const [ch, lines] of mainHandle.entries()) {
        if (lines.length > 1) {
            fail('IPC-DUP', `main.js define ipcMain.handle('${ch}') múltiples veces en líneas ${lines.join(', ')}`);
        }
    }
    for (const [ch, ln] of preloadInvoke.entries()) {
        if (!mainHandle.has(ch)) {
            fail('IPC-MISSING', `preload.js:${ln} invoca '${ch}' pero main.js no tiene ipcMain.handle`);
        }
    }
    for (const [ch, ln] of preloadSend.entries()) {
        if (!mainOn.has(ch)) {
            fail('IPC-MISSING', `preload.js:${ln} envía '${ch}' pero main.js no tiene ipcMain.on/once`);
        }
    }

    // nexusAPI exposed keys & usage in public/
    const exposeMatch = preloadCode.match(/contextBridge\.exposeInMainWorld\s*\(\s*['"]nexusAPI['"]\s*,\s*\{([\s\S]*)\}\s*\)/);
    const exposedMethods = new Map();
    if (!exposeMatch) {
        fail('PRELOAD-API', 'No se pudo localizar contextBridge.exposeInMainWorld("nexusAPI", ...) en preload.js');
    } else {
        const keyRe = /(?:^|\n)\s*(\w+)\s*:/g;
        let km;
        while ((km = keyRe.exec(exposeMatch[1])) !== null) {
            const name = km[1];
            exposedMethods.set(name, (exposedMethods.get(name) || 0) + 1);
        }
        for (const [name, cnt] of exposedMethods.entries()) {
            if (cnt > 1) fail('PRELOAD-DUP', `preload.js expone clave duplicada en nexusAPI: ${name}`);
        }
    }

    const frontendFiles = [
        path.join(ROOT, 'splash.html'),
        ...walkFiles(path.join(ROOT, 'public'), (_, name) => name.toLowerCase().endsWith('.html') || (name.toLowerCase().endsWith('.js') && !IGNORE_VENDOR_JS.has(name) && !name.endsWith('.min.js'))),
    ].filter(f => fs.existsSync(f));

    for (const file of frontendFiles) {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');
        const callRe = /nexusAPI\.(\w+)/g;
        let cm;
        while ((cm = callRe.exec(content)) !== null) {
            const mName = cm[1];
            if (!exposedMethods.has(mName)) {
                const ln = lineAt(content, cm.index);
                const contextWindow = lines.slice(Math.max(0, ln - 3), ln).join('\n');
                const isGuarded = new RegExp(`typeof\\s+(?:window\\.)?nexusAPI\\??\\.${mName}\\b`).test(contextWindow);
                if (!isGuarded) {
                    fail('PRELOAD-CALL', `${toPosixRel(file)}:${ln} llama nexusAPI.${mName}, que no existe en preload.js`);
                }
            }
        }
        if (/ipcRenderer\.(invoke|send|on)/.test(content)) {
            fail('SEC-RENDERER', `${toPosixRel(file)} referencia ipcRenderer directamente`);
        }
    }

    // Express routes uniqueness
    const routeRe = /\b(server|app|router)\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\3/g;
    const routes = new Map();
    let rm;
    while ((rm = routeRe.exec(serverCode)) !== null) {
        const key = `${rm[2].toUpperCase()} ${rm[4]}`;
        if (!routes.has(key)) routes.set(key, []);
        routes.get(key).push(lineAt(serverCode, rm.index));
    }
    for (const [rt, lines] of routes.entries()) {
        if (lines.length > 1) {
            fail('EXPRESS-DUP', `server.js declara ruta duplicada "${rt}" en líneas ${lines.join(', ')}`);
        }
    }

    // BrowserWindow security settings
    const wpRe = /webPreferences\s*:\s*\{[\s\S]*?\}/g;
    let wpCount = 0;
    let wm;
    while ((wm = wpRe.exec(mainCode)) !== null) {
        wpCount++;
        const block = wm[0];
        const ln = lineAt(mainCode, wm.index);
        if (!/nodeIntegration\s*:\s*false/.test(block)) {
            fail('ELECTRON-SEC', `main.js:${ln} webPreferences sin nodeIntegration: false`);
        }
        if (!/contextIsolation\s*:\s*true/.test(block)) {
            fail('ELECTRON-SEC', `main.js:${ln} webPreferences sin contextIsolation: true`);
        }
        if (!/sandbox\s*:\s*true/.test(block)) {
            fail('ELECTRON-SEC', `main.js:${ln} webPreferences sin sandbox: true`);
        }
    }
    if (wpCount === 0) {
        fail('ELECTRON-SEC', 'No se detectó ningún bloque webPreferences en main.js');
    }

    pass('IPC-ROUTES-SEC', `IPC simétrico (${preloadInvoke.size} invoke, ${preloadSend.size} send, ${exposedMethods.size} métodos nexusAPI), ${routes.size} rutas Express y ${wpCount} BrowserWindow seguros.`);
}

// =========================================================================
// 6. SQLITE SCHEMA PARITY & :memory: STATIC .prepare() COMPILATION
// =========================================================================
function checkSqliteSchemasAndQueries() {
    const mainCode = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    const nominaMod = require(path.join(ROOT, 'services', 'nomina-ve.js'));
    const tasasMod = require(path.join(ROOT, 'services', 'tasas-grafica.js'));
    const fiscalMod = require(path.join(ROOT, 'services', 'contabilidad-fiscal-ve.js'));

    const evalSchema = (code, marker) => {
        const objSrc = extractBalancedBlock(code, marker, '{', '}');
        if (!objSrc) {
            fail('SCHEMA', `No se pudo extraer "${marker}"`);
            return {};
        }
        const obj = vm.runInNewContext(`(${objSrc})`, {
            ESQUEMA_EMPLEADOS_Y_NOMINA: nominaMod.ESQUEMA_EMPLEADOS_Y_NOMINA,
            tasasGrafica: tasasMod,
        });
        fiscalMod.aplicarExtensionesEsquemaCxcCxp(obj);
        return obj;
    };

    const schemaMaestro = evalSchema(serverCode, 'const ESQUEMA_MAESTRO = {');
    const schemaMaestroLocal = evalSchema(mainCode, 'const ESQUEMA_MAESTRO_LOCAL = {');
    const schemaLocal = evalSchema(mainCode, 'const ESQUEMA_LOCAL = {');

    // Parity assertions
    for (const [label, tbl] of [
        ['ESQUEMA_LOCAL.claves_admin_locales', schemaLocal.claves_admin_locales],
        ['ESQUEMA_MAESTRO.claves_admin_maestras', schemaMaestro.claves_admin_maestras],
        ['ESQUEMA_MAESTRO_LOCAL.claves_admin_maestras', schemaMaestroLocal.claves_admin_maestras],
    ]) {
        if (!tbl) {
            fail('SCHEMA-PARITY', `Falta tabla ${label}`);
        } else {
            for (const col of ['permisos', 'is_master', 'code_hash']) {
                if (!Object.prototype.hasOwnProperty.call(tbl, col)) {
                    fail('SCHEMA-PARITY', `${label} no define columna "${col}"`);
                }
            }
        }
    }

    for (const [label, schemaObj] of [
        ['ESQUEMA_LOCAL', schemaLocal],
        ['ESQUEMA_MAESTRO', schemaMaestro],
        ['ESQUEMA_MAESTRO_LOCAL', schemaMaestroLocal],
    ]) {
        if (!schemaObj.reportes_fiscales_cierre) {
            fail('SCHEMA-PARITY', `${label} no define la tabla reportes_fiscales_cierre`);
        }
    }

    // Common table column parity between server ESQUEMA_MAESTRO and main ESQUEMA_MAESTRO_LOCAL
    for (const tbl of Object.keys(schemaMaestro)) {
        if (!schemaMaestroLocal[tbl]) continue;
        const sCols = Object.keys(schemaMaestro[tbl]);
        const mCols = Object.keys(schemaMaestroLocal[tbl]);
        const missingInMain = sCols.filter(c => !mCols.includes(c));
        const missingInServer = mCols.filter(c => !sCols.includes(c));
        if (missingInMain.length > 0 || missingInServer.length > 0) {
            fail('SCHEMA-DIFF', `Tabla maestro "${tbl}" desincronizada: falta en main.js=[${missingInMain.join(', ')}], falta en server.js=[${missingInServer.join(', ')}]`);
        }
    }

    const createDb = (schemaObj) => {
        const db = new DatabaseSync(':memory:');
        for (const [tabla, columnas] of Object.entries(schemaObj)) {
            const defs = Object.entries(columnas).map(([k, v]) => `${k} ${v}`);
            db.exec(`CREATE TABLE IF NOT EXISTS ${tabla} (${defs.join(', ')})`);
        }
        return db;
    };

    const dbLocal = createDb(schemaLocal);
    const dbMaestro = createDb(schemaMaestro);
    const dbMainMaestro = createDb(schemaMaestroLocal);

    // Compile all static SQL .prepare(...) calls across main.js, server.js and services/*.js
    const serviceFiles = walkFiles(path.join(ROOT, 'services'), (_, name) => name.toLowerCase().endsWith('.js'));
    const sqlFiles = [path.join(ROOT, 'main.js'), path.join(ROOT, 'server.js'), ...serviceFiles];
    let sqlChecked = 0;

    for (const file of sqlFiles) {
        const txt = fs.readFileSync(file, 'utf8');
        const rel = toPosixRel(file);
        const prepRe = /\.prepare\s*\(/g;
        let pm;
        while ((pm = prepRe.exec(txt)) !== null) {
            const openIdx = pm.index + pm[0].length - 1;
            const paren = readBalancedParen(txt, openIdx);
            if (!paren) continue;
            const raw = paren.inner.trim();
            if (!/^(['"`])[\s\S]*\1$/.test(raw)) continue;
            if (raw.startsWith('`') && raw.includes('${')) continue;

            let sql;
            try {
                sql = String(vm.runInNewContext(raw)).trim();
            } catch (_) {
                continue;
            }
            if (!sql || /^(PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|CREATE|DROP|ALTER)/i.test(sql)) continue;

            sqlChecked++;
            let okLocal = true;
            let okMaestro = true;
            let okMainMaestro = true;
            let firstErr = '';
            try { dbLocal.prepare(sql); } catch (e) { okLocal = false; firstErr = e.message; }
            try { dbMaestro.prepare(sql); } catch (e) { okMaestro = false; if (!firstErr) firstErr = e.message; }
            try { dbMainMaestro.prepare(sql); } catch (e) { okMainMaestro = false; if (!firstErr) firstErr = e.message; }

            if (!okLocal && !okMaestro && !okMainMaestro) {
                const isAllowlistedLegacy = [...ALLOWLIST_LEGACY_PREPARE_TABLES].some(t =>
                    new RegExp(`no such table:\\s*${t}\\b`, 'i').test(firstErr)
                );
                if (!isAllowlistedLegacy) {
                    fail('SQL-PREPARE', `${rel}:${lineAt(txt, pm.index)} -> ${firstErr} | SQL: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
                }
            } else if (rel === 'server.js' && !okMaestro && !okLocal) {
                const isAllowlistedLegacy = [...ALLOWLIST_LEGACY_PREPARE_TABLES].some(t =>
                    new RegExp(`no such table:\\s*${t}\\b`, 'i').test(firstErr)
                );
                if (!isAllowlistedLegacy) {
                    fail('SQL-SERVER', `${rel}:${lineAt(txt, pm.index)} -> ${firstErr} | SQL: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
                }
            }
        }
    }

    dbLocal.close();
    dbMaestro.close();
    dbMainMaestro.close();
    pass('SQLITE', `Esquemas sincronizados y ${sqlChecked} sentencias SQL .prepare() compiladas en :memory:.`);
}

function main() {
    console.log('=== NEXUS POS VALIDACION INTEGRAL ===\n');
    checkJsonFiles();
    checkJsSyntaxAndRequires();
    checkHtmlFiles();
    checkCopyFilenames();
    checkIpcRoutesAndSecurity();
    checkSqliteSchemasAndQueries();

    console.log(`\nResumen: ${errors} error(es), ${warnings} advertencia(s).`);
    process.exit(errors > 0 ? 1 : 0);
}

main();
