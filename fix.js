const fs = require('fs');
const file = 'C:/NEXUS-POS-ELECTRON/public/index_inicio_admin/gestion_de_inventario/entradas_de_inventario.html';
let content = fs.readFileSync(file, 'utf8');
content = content.replace(
    /prepararEdicionStockEntrada\('\$\{item\.id\}', '\$\{item\.nombre\}', \$\{stock\}\)/g,
    "prepararEdicionStockEntrada('', '', )"
);
fs.writeFileSync(file, content, 'utf8');
