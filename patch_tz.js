const fs = require('fs');

function patchFile(file) {
    if (!fs.existsSync(file)) return;
    let code = fs.readFileSync(file, 'utf8');
    
    // Add timezone env var at the very top if not present
    if (!code.includes("process.env.TZ = 'America/Caracas';")) {
        code = "process.env.TZ = 'America/Caracas';\n" + code;
    }

    // Replace SQLite defaults
    code = code.replace(/DEFAULT CURRENT_TIMESTAMP/g, "DEFAULT (datetime('now', '-4 hours'))");
    
    // Replace SQLite localtime functions
    code = code.replace(/datetime\('now',\s*'localtime'\)/g, "datetime('now', '-4 hours')");
    
    // Replace naked datetime('now') EXCEPT where we just replaced it (so we use negative lookbehind if possible, or just be careful)
    // Actually, simple regex:
    code = code.replace(/datetime\('now'\)/g, "datetime('now', '-4 hours')");

    // Repair normalizarFechaLocalVenta to strictly enforce Caracas UTC-4
    const oldNorm = `function normalizarFechaLocalVenta(fecha) {
    const pad = (n) => String(n).padStart(2, '0');
    let d = null;
    if (fecha && typeof fecha === 'string' && /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(fecha.trim())) {
        return fecha.trim(); // Ya está en formato local correcto
    }
    if (fecha) {
        const parsed = new Date(fecha);
        if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d) d = new Date();
    return \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())} \${pad(d.getHours())}:\${pad(d.getMinutes())}:\${pad(d.getSeconds())}\`;
}`;
    const newNorm = `function normalizarFechaLocalVenta(fecha) {
    const pad = (n) => String(n).padStart(2, '0');
    let d = null;
    if (fecha && typeof fecha === 'string' && /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(fecha.trim())) {
        return fecha.trim(); // Ya está en formato local correcto
    }
    if (fecha) {
        // Al parsear, obtener el timestamp en milisegundos
        const parsed = new Date(fecha);
        if (!isNaN(parsed.getTime())) d = parsed;
    }
    if (!d) d = new Date();
    
    // Forzar HORA CARACAS (UTC-4) sin importar la hora del PC
    const utcMillis = d.getTime() + (d.getTimezoneOffset() * 60000);
    const caracasMillis = utcMillis - (4 * 60 * 60 * 1000);
    const cDate = new Date(caracasMillis);
    
    return \`\${cDate.getFullYear()}-\${pad(cDate.getMonth() + 1)}-\${pad(cDate.getDate())} \${pad(cDate.getHours())}:\${pad(cDate.getMinutes())}:\${pad(cDate.getSeconds())}\`;
}`;
    if (code.includes(oldNorm)) {
        code = code.replace(oldNorm, newNorm);
    }

    // Repair the old date migration script
    const oldMig = `const r = conn.prepare(\`UPDATE ventas_locales SET fecha_emision = datetime(fecha_emision, 'localtime') WHERE fecha_emision LIKE '____-__-__T%' AND datetime(fecha_emision, 'localtime') IS NOT NULL\`).run();`;
    const newMig = `const r = conn.prepare(\`UPDATE ventas_locales SET fecha_emision = datetime(fecha_emision, '-4 hours') WHERE fecha_emision LIKE '____-__-__T%' AND datetime(fecha_emision, '-4 hours') IS NOT NULL\`).run();`;
    if (code.includes(oldMig)) {
        code = code.replace(oldMig, newMig);
    }
    
    fs.writeFileSync(file, code, 'utf8');
    console.log('Patched ' + file);
}

patchFile('main.js');
patchFile('server.js');
