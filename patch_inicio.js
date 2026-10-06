const fs = require('fs');
const path = require('path');

const filePath = path.join('c:', 'NEXUS-POS-ELECTRON', 'public', 'inicio_cajera.html');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(
    /<li><a href="#" data-page="index_cajera\/configuracion\/configuracion_balanza\.html">/g,
    '<li id="menu-balanza-config"><a href="#" data-page="index_cajera/configuracion/configuracion_balanza.html">'
);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Modified inicio_cajera.html successfully');
