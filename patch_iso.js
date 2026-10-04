const fs = require('fs');

function patchISOStrings(file) {
    if (!fs.existsSync(file)) return;
    let code = fs.readFileSync(file, 'utf8');
    
    // Inject getCaracasTime() at the top if not present
    if (!code.includes("function getCaracasTime()")) {
        const inject = `
function getCaracasTime() {
    const d = new Date();
    const utcMillis = d.getTime() + (d.getTimezoneOffset() * 60000);
    const cDate = new Date(utcMillis - (4 * 60 * 60 * 1000));
    const pad = (n) => String(n).padStart(2, '0');
    return \`\${cDate.getFullYear()}-\${pad(cDate.getMonth() + 1)}-\${pad(cDate.getDate())} \${pad(cDate.getHours())}:\${pad(cDate.getMinutes())}:\${pad(cDate.getSeconds())}\`;
}
`;
        code = code.replace("process.env.TZ = 'America/Caracas';\n", "process.env.TZ = 'America/Caracas';\n" + inject);
    }

    // First replace cases where it was split by 'T' to get the date
    code = code.replace(/new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/g, "getCaracasTime().split(' ')[0]");
    
    // Then replace the remaining cases
    code = code.replace(/new Date\(\)\.toISOString\(\)/g, "getCaracasTime()");

    fs.writeFileSync(file, code, 'utf8');
    console.log('Patched ISO Strings in ' + file);
}

patchISOStrings('main.js');
patchISOStrings('server.js');
