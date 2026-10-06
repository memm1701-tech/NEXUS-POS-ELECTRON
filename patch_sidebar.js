const fs = require('fs');
const path = require('path');

const applyPatches = () => {
    // 1. Patch inicio_cajera.html
    const cajeraFile = path.join('c:', 'NEXUS-POS-ELECTRON', 'public', 'inicio_cajera.html');
    if (fs.existsSync(cajeraFile)) {
        let content = fs.readFileSync(cajeraFile, 'utf8');

        // Fix background solid color on dropdown in Cajera (making it transparent)
        content = content.replace(
            /\.sidebar-nav \.dropdown ul\s*\{\s*max-height:[^}]+background-color:\s*#2d3748;/g,
            (match) => {
                return match.replace('background-color: #2d3748;', 'background-color: transparent;');
            }
        );

        // Fix Sidebar stretch in Cajera
        content = content.replace(
            /display:\s*flex;\s*flex-direction:\s*column;\s*min-height:\s*100vh;/g,
            "display: flex; flex-direction: column; height: 100vh; max-height: 100vh; align-self: flex-start;"
        );

        fs.writeFileSync(cajeraFile, content, 'utf8');
        console.log("Patched inicio_cajera.html");
    }

    // 2. Patch inicio.html
    const adminFile = path.join('c:', 'NEXUS-POS-ELECTRON', 'public', 'inicio.html');
    if (fs.existsSync(adminFile)) {
        let content = fs.readFileSync(adminFile, 'utf8');

        // Fix Sidebar stretch in Admin
        // We will insert align-self and position sticky
        if (!content.includes('position: sticky; top: 0; align-self: flex-start;')) {
            content = content.replace(
                /height:\s*100vh;\s*overflow-y:\s*auto;/g,
                "height: 100vh; max-height: 100vh; overflow-y: auto; position: sticky; top: 0; align-self: flex-start;"
            );
            fs.writeFileSync(adminFile, content, 'utf8');
            console.log("Patched inicio.html");
        } else {
            console.log("inicio.html already patched");
        }
    }
};

applyPatches();
