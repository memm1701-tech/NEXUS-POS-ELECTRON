const fs = require('fs');
const path = require('path');

const replacer = `(function(){let d=new Date();let c=new Date(d.getTime()+(d.getTimezoneOffset()*60000)-(4*3600000));let p=(n)=>String(n).padStart(2,'0');return c.getFullYear()+'-'+p(c.getMonth()+1)+'-'+p(c.getDate())+' '+p(c.getHours())+':'+p(c.getMinutes())+':'+p(c.getSeconds());})()`;

function processDir(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            if (file === 'node_modules' || file === '.git') continue;
            processDir(fullPath);
        } else if (fullPath.endsWith('.html') || fullPath.endsWith('.js')) {
            let code = fs.readFileSync(fullPath, 'utf8');
            if (code.includes('new Date().toISOString()')) {
                // Ignore minified libraries to avoid breaking them
                if (code.length > 500000 && file !== 'facturacion.html') continue;
                
                // First handle split('T')[0] cases (extract just the date part YYYY-MM-DD)
                code = code.replace(/new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/g, "("+replacer+").split(' ')[0]");
                code = code.replace(/hoy\.toISOString\(\)\.split\('T'\)\[0\]/g, "("+replacer+").split(' ')[0]"); // Special case seen in facturacion.html
                code = code.replace(/now\.toISOString\(\)\.split\('T'\)\[0\]/g, "("+replacer+").split(' ')[0]");
                
                // Then handle standard new Date().toISOString()
                code = code.replace(/new Date\(\)\.toISOString\(\)/g, replacer);
                // Also hoy.toISOString() and now.toISOString() if it exists
                code = code.replace(/hoy\.toISOString\(\)/g, replacer);
                code = code.replace(/now\.toISOString\(\)/g, replacer);

                fs.writeFileSync(fullPath, code, 'utf8');
                console.log('Patched frontend ISO: ' + fullPath);
            }
        }
    }
}

processDir(path.join(__dirname, 'public'));
