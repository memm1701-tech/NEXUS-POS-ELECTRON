const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexusAPI', {
    // --- PRODUCTOS ---
    sincronizarProductoServidor: (productData) => 
        ipcRenderer.invoke('sincronizar-producto-servidor', productData),

    obtenerProductosLocal: (empresaId) => 
        ipcRenderer.invoke('obtener-productos-local', empresaId),

    // --- CATEGORÍAS ---
    obtenerCategoriasLocal: () => 
        ipcRenderer.invoke('obtener-categorias-local'),

    sincronizarCategoriaServidor: (cat) => 
        ipcRenderer.invoke('sincronizar-categoria-servidor', cat),

    eliminarCategoriaLocal: (id) => 
        ipcRenderer.invoke('eliminar-categoria-local', id),

    sincronizarCategoriasLocal: (categories) => 
        ipcRenderer.invoke('sincronizar-categorias-local', categories),

    // --- USUARIOS Y SESIÓN ---
    guardarUsuarioLocal: (datos) => 
        ipcRenderer.invoke('guardar-usuario-local', datos),

    obtenerSesionLocal: () => 
        ipcRenderer.invoke('obtener-sesion-local'),

    loginLocal: (email) => 
        ipcRenderer.invoke('login-local', email),

    cerrarSesionLocal: () => 
        ipcRenderer.invoke('cerrar-sesion-local'),

    // --- CLIENTES ---
    guardarClienteLocal: (cliente) => 
        ipcRenderer.invoke('guardar-cliente-local', cliente),

    obtenerClientesLocal: () => 
        ipcRenderer.invoke('obtener-clientes-local'),

    // --- TASAS Y BCV ---
    guardarTasaBCV: (tasa) =>
         ipcRenderer.invoke('guardar-tasa-bcv', tasa),
    
    obtenerTasaBCV: () =>
         ipcRenderer.invoke('obtener-tasa-bcv'),

    obtenerHistorialTasas: () =>
        ipcRenderer.invoke('obtener-historial-tasas'),

    guardarTasaHistorial: (datos) =>
        ipcRenderer.invoke('guardar-tasa-historial', datos),

    // --- CONFIGURACIÓN E IMPRESORAS ---
    obtenerConfiguracion: (key) => 
        ipcRenderer.invoke('obtener-configuracion', key),

    guardarConfiguracion: (key, data) => 
        ipcRenderer.invoke('guardar-configuracion', key, data),

    leerImpresoras: () => 
        ipcRenderer.invoke('leer-impresoras'),

    leerPuertos: () => 
        ipcRenderer.invoke('leer-puertos'),

    // --- IMPRESIÓN NATIVA ---
    imprimirTextoLibre: (texto, nombreImpresora) => 
        ipcRenderer.invoke('imprimir-texto-libre', texto, nombreImpresora),

    // --- SISTEMA Y VENTANAS ---
    minimize: () =>
        ipcRenderer.send('minimize-login-window'),

    close: () => 
        ipcRenderer.send('close-login-window'),

    cerrarYVolverAlLogin: () => 
        ipcRenderer.send('cerrar-y-volver-login'),

    abrirVentanaPrincipal: (ruta) => 
        ipcRenderer.send('abrir-ventana-principal', ruta),

    // --- SINCRONIZACIÓN ---
    encolarSincronizacion: (tarea) => 
        ipcRenderer.invoke('encolar-sincronizacion', tarea),

    procesarColaSync: () => 
        ipcRenderer.invoke('procesar-cola-sync'),

    // --- INTELIGENCIA ARTIFICIAL ---
    consultarIA: (datos) =>
        ipcRenderer.invoke('consultar-ia-nexus', datos),

    // --- EVENTOS DE ESCUCHA (RADAR) ---
    onProductosCambiados: (callback) => {
        // Limpiamos escuchadores previos para evitar duplicidad de mensajes
        ipcRenderer.removeAllListeners('productos-actualizados'); 
        ipcRenderer.on('productos-actualizados', () => {
            callback();
        });
    }
});

console.log('✅ Puente NexusAPI establecido correctamente basándose en el Main.js actualizado.');