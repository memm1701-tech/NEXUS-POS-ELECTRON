const fs = require('fs');
const file = 'c:/NEXUS-POS-ELECTRON/public/index_cajera/punto-de-venta/facturacion.html';
let c = fs.readFileSync(file, 'utf8');

c = c.replace(
    /window\.addEventListener\('tasaActualizadaBackground',\s*\(e\)\s*=>\s*\{/g,
    "window.addEventListener('tasaActualizadaBackground', (e) => { const pModal = document.getElementById('payment-modal'); if (pModal && !pModal.classList.contains('hidden') && pModal.style.display !== 'none') return;"
);

c = c.replace(
    /window\.addEventListener\('productosActualizadosBackground',\s*async\s*\(\)\s*=>\s*\{/g,
    "window.addEventListener('productosActualizadosBackground', async () => { const pModal = document.getElementById('payment-modal'); if (pModal && !pModal.classList.contains('hidden') && pModal.style.display !== 'none') return;"
);

c = c.replace(
    /window\.parent\.addEventListener\('productosActualizadosBackground',\s*async\s*\(\)\s*=>\s*\{/g,
    "window.parent.addEventListener('productosActualizadosBackground', async () => { const pModal = document.getElementById('payment-modal'); if (pModal && !pModal.classList.contains('hidden') && pModal.style.display !== 'none') return;"
);

c = c.replace(
    /window\.nexusAPI\.onProductosCambiados\(async\s*\(\)\s*=>\s*\{/g,
    "window.nexusAPI.onProductosCambiados(async () => { const pModal = document.getElementById('payment-modal'); if (pModal && !pModal.classList.contains('hidden') && pModal.style.display !== 'none') return;"
);

fs.writeFileSync(file, c);
console.log("Done.");
