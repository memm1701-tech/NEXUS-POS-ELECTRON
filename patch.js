const fs = require('fs');
let code = fs.readFileSync('main.js', 'utf8');
const search = '    createSplashScreen(); // 1. Primero mostramos el video';
const replacement = \    // --- LIBERAR COMANDOS DE DESARROLLADOR Y RECARGA (SIN MOSTRAR EL MENÚ) ---
    app.on('web-contents-created', (event, contents) => {
        contents.on('before-input-event', (event, input) => {
            if (input.type !== 'keyDown') return;
            if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
                contents.toggleDevTools();
                event.preventDefault();
            }
            if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') {
                contents.reload();
                event.preventDefault();
            }
        });
    });

    createSplashScreen(); // 1. Primero mostramos el video\;
code = code.replace(search, replacement);
fs.writeFileSync('main.js', code);
console.log('Done');
