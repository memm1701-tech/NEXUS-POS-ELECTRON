const fs = require('fs');
const path = require('path');

const filePath = path.join('c:', 'NEXUS-POS-ELECTRON', 'public', 'index_cajera', 'configuracion', 'configuracion_fiscal.html');
let content = fs.readFileSync(filePath, 'utf8');

// The regex will find the exact first function definition.
// We use a non-greedy match to grab the whole function up to the closing brace before the Lógica comment.
const regex = /async function cargarMetodosPagoMapeo\(\) \{\s*try \{\s*const metodos = await window\.nexusAPI\.obtenerMetodosPagoActivos\(\);[\s\S]*?console\.error\("Error cargando m[^\n]*todos para mapeo:", error\);\s*\}\s*\}/;

if (regex.test(content)) {
    content = content.replace(regex, '');
    fs.writeFileSync(filePath, content, 'utf8');
    console.log("Duplicate function removed successfully.");
} else {
    console.log("Could not find the target block to remove.");
}
