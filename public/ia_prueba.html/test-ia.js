const axios = require('axios');

const API_KEY = "AIzaSyAPKpaQrze48wBpt2CwXxGDvATb8lgYpFo";
// Usamos el alias que garantiza compatibilidad con la cuota gratuita
const MODELO = "gemini-flash-latest"; 
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${API_KEY}`;

async function probarConexionIA() {
    console.log("--------------------------------------------------");
    console.log(`🧪 TEST FINAL: MODELO ${MODELO}`);
    console.log("--------------------------------------------------");

    const payload = {
        contents: [{
            parts: [{
                text: "Responde solo: 'NEXUS POS CONECTADO'."
            }]
        }]
    };

    try {
        console.log(`📡 Solicitando acceso al canal estable: ${MODELO}...`);
        
        const response = await axios.post(URL, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.candidates) {
            const respuesta = response.data.candidates[0].content.parts[0].text;
            console.log("\n✅ ¡LO LOGRAMOS!");
            console.log("🤖 Respuesta:", respuesta);
        }

    } catch (error) {
        console.log("\n❌ SEGUIMOS CON RESTRICCIÓN:");
        if (error.response) {
            console.error("Estado:", error.response.status);
            console.error("Causa:", error.response.data.error.message);
            
            console.log("\n💡 ANÁLISIS:");
            console.log("Si el límite sigue en 0 para Flash, cambiaremos el MODELO a 'gemini-pro-latest'.");
        } else {
            console.error("Error:", error.message);
        }
    }
    console.log("--------------------------------------------------\n");
}

probarConexionIA();