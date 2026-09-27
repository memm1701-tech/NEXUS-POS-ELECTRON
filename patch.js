const fs = require('fs');
let content = fs.readFileSync('C:\\NEXUS-POS-ELECTRON\\public\\index.html', 'utf-8');
content = content.replace(/\r\n/g, '\n');

const search1 = `                                    if (hoy > fVenc) {
                                        mostrarAlertaSuspension();
                                        await signOut(auth);
                                        esLoginManual = false;
                                        document.getElementById('login-btn-text').classList.remove('hidden');
                                        document.getElementById('login-btn-spinner').classList.add('hidden');
                                        document.getElementById('login-btn').disabled = false;
                                        return;
                                    }`;

const injection1 = search1 + `
                                    
                                    // EL PLAN ESTÁ VIGENTE - ACTUALIZAR BASE DE DATOS LOCAL PARA EVITAR BUCLE INFINITO
                                    if (window.nexusAPI && window.nexusAPI.guardarPlanLocal) {
                                        try {
                                            const planParaGuardar = { ...dataEmpresa.plan, companyId: companyId };
                                            await window.nexusAPI.guardarPlanLocal(planParaGuardar);
                                            console.log('Plan sincronizado localmente durante el inicio de sesión.');
                                        } catch (errPlan) {
                                            console.error('Error al sincronizar el plan localmente:', errPlan);
                                        }
                                    }`;

if(content.includes(search1)) {
    content = content.replace(search1, injection1);
    console.log("Admin block replaced!");
} else {
    console.log("Admin block not found!");
}


const search2 = `                                    if (hoy > fVenc) {
                                        mostrarAlertaSuspension();
                                        await signOut(auth);
                                        return;
                                    }`;

const injection2 = search2 + `
                                    
                                    // EL PLAN ESTÁ VIGENTE - ACTUALIZAR BASE DE DATOS LOCAL PARA EVITAR BUCLE INFINITO
                                    if (window.nexusAPI && window.nexusAPI.guardarPlanLocal) {
                                        try {
                                            const planParaGuardar = { ...dataEmpresa.plan, companyId: companyId };
                                            await window.nexusAPI.guardarPlanLocal(planParaGuardar);
                                            console.log('Plan de cajera sincronizado localmente durante el inicio de sesión.');
                                        } catch (errPlan) {
                                            console.error('Error al sincronizar el plan localmente (cajera):', errPlan);
                                        }
                                    }`;

if(content.includes(search2)) {
    content = content.replace(search2, injection2);
    console.log("Cajera block replaced!");
} else {
    console.log("Cajera block not found!");
}


fs.writeFileSync('C:\\NEXUS-POS-ELECTRON\\public\\index.html', content, 'utf-8');
console.log('Done.');