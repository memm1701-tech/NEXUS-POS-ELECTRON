const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexusAPI', {
    sincronizarProductoServidor: (productData) => ipcRenderer.invoke('sincronizar-producto-servidor', productData),
    obtenerProductosLocal: (empresaId) => ipcRenderer.invoke('obtener-productos-local', empresaId),
    obtenerCategoriasLocal: () => ipcRenderer.invoke('obtener-categorias-local'),
    sincronizarCategoriaServidor: (cat) => ipcRenderer.invoke('sincronizar-categoria-servidor', cat),
    eliminarCategoriaLocal: (id) => ipcRenderer.invoke('eliminar-categoria-local', id),
    sincronizarCategoriasLocal: (categories) => ipcRenderer.invoke('sincronizar-categorias-local', categories),
    guardarUsuarioLocal: (datos) => ipcRenderer.invoke('guardar-usuario-local', datos),
    obtenerSesionLocal: () => ipcRenderer.invoke('obtener-sesion-local'),
    loginLocal: (email) => ipcRenderer.invoke('login-local', email),
    cerrarSesionLocal: () => ipcRenderer.invoke('cerrar-sesion-local'),
    guardarClienteLocal: (cliente) => ipcRenderer.invoke('guardar-cliente-local', cliente),
    obtenerClientesLocal: () => ipcRenderer.invoke('obtener-clientes-local'),
    guardarTasaBCV: (tasa) => ipcRenderer.invoke('guardar-tasa-bcv', tasa),
    obtenerTasaBCV: () => ipcRenderer.invoke('obtener-tasa-bcv'),
    obtenerHistorialTasas: () => ipcRenderer.invoke('obtener-historial-tasas'),
    obtenerConfiguracion: (key) => ipcRenderer.invoke('obtener-configuracion', key),
    guardarConfiguracion: (key, data) => ipcRenderer.invoke('guardar-configuracion', key, data),
    leerImpresoras: () => ipcRenderer.invoke('leer-impresoras'),
    leerPuertos: () => ipcRenderer.invoke('leer-puertos'),
    imprimirTextoLibre: (texto, nombreImpresora) => ipcRenderer.invoke('imprimir-texto-libre', texto, nombreImpresora),
    minimize: () => ipcRenderer.send('minimize-login-window'),
    close: () => ipcRenderer.send('close-login-window'),
    cerrarYVolverAlLogin: () => ipcRenderer.send('cerrar-y-volver-login'),
    abrirVentanaPrincipal: (ruta) => ipcRenderer.send('abrir-ventana-principal', ruta),
    encolarSincronizacion: (tarea) => ipcRenderer.invoke('encolar-sincronizacion', tarea),
    procesarColaSync: () => ipcRenderer.invoke('procesar-cola-sync'),
    consultarIA: (datos) => ipcRenderer.invoke('consultar-ia-nexus', datos),
    guardarVentaLocal: (venta) => ipcRenderer.invoke('guardar-venta-local', venta),
    obtenerProximoCorrelativo: (tipo) => ipcRenderer.invoke('obtener-proximo-correlativo', tipo),
    obtenerVentaPorId: (id) => ipcRenderer.invoke('obtener-venta-por-id', id),
    onProductosCambiados: (callback) => {
        ipcRenderer.removeAllListeners('productos-actualizados'); 
        ipcRenderer.on('productos-actualizados', () => callback());
    }
});

console.log('✅ Puente NexusAPI establecido correctamente.');