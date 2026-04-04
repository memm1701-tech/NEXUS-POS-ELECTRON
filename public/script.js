import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInWithCustomToken, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// Global variables provided by the canvas environment
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Firebase initialization
let app;
if (getApps().length === 0) {
    app = initializeApp(firebaseConfig);
} else {
    app = getApp();
}
const auth = getAuth(app);
const db = getFirestore(app);

// App state
let cart = [];
let selectedProduct = null;
let allProducts = [];
let userId = null;
let companyId = null;
let userRole = null;
let isAuthReady = false;
let currentFocus = -1;
let filteredProducts = [];

// DOM elements
const productSearchInput = document.getElementById('product-search');
const autocompleteResultsDiv = document.getElementById('autocomplete-results');
const cartTableBody = document.getElementById('cart-table-body');
const subtotalDisplay = document.getElementById('subtotal');
const taxDisplay = document.getElementById('tax');
const totalDisplay = document.getElementById('total');
const messageBoxElement = document.getElementById('message-box');

// Function to display messages to the user
function messageBox(message, type) {
    if (messageBoxElement) {
        messageBoxElement.textContent = message;
        messageBoxElement.className = `fixed top-4 right-4 p-4 rounded-lg shadow-lg text-white transition-opacity duration-300 z-50 ${type}`;
        messageBoxElement.style.opacity = '1';

        setTimeout(() => {
            messageBoxElement.style.opacity = '0';
        }, 3000);
    }
}

// Update user info display
function updateUserInfoDisplay() {
    document.getElementById('user-id').textContent = `ID: ${userId || 'N/A'}`;
    document.getElementById('company-id').textContent = `Compañía: ${companyId || 'N/A'}`;
    document.getElementById('user-role').textContent = `Rol: ${userRole || 'N/A'}`;
}

// Function to fetch products from Firestore
async function fetchProducts() {
    try {
        const querySnapshot = await getDocs(collection(db, "products"));
        allProducts = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        console.log("Productos cargados:", allProducts);
    } catch (error) {
        console.error("Error fetching products: ", error);
        messageBox("Error al cargar productos.", 'bg-red-500');
    }
}

// Autocomplete and search functions
function filterProducts() {
    const searchTerm = productSearchInput.value.toLowerCase();
    if (searchTerm.length === 0) {
        autocompleteResultsDiv.style.display = 'none';
        filteredProducts = [];
        return;
    }

    filteredProducts = allProducts.filter(product =>
        product.name.toLowerCase().includes(searchTerm) ||
        product.barcode.includes(searchTerm)
    );
    renderAutocompleteResults();
}

function renderAutocompleteResults() {
    autocompleteResultsDiv.innerHTML = '';
    if (filteredProducts.length === 0) {
        autocompleteResultsDiv.style.display = 'none';
        return;
    }

    autocompleteResultsDiv.style.display = 'block';
    filteredProducts.forEach((product, index) => {
        const item = document.createElement('div');
        item.classList.add('autocomplete-item');
        if (index === currentFocus) {
            item.classList.add('highlighted');
        }
        item.innerHTML = `<strong>${product.name}</strong><br><small>Código: ${product.barcode}</small>`;
        item.addEventListener('click', () => selectProduct(product));
        autocompleteResultsDiv.appendChild(item);
    });
}

function selectProduct(product) {
    selectedProduct = product;
    productSearchInput.value = product.name;
    autocompleteResultsDiv.style.display = 'none';
}

function setupSearchListener() {
    productSearchInput.addEventListener('input', () => {
        currentFocus = -1;
        filterProducts();
    });

    productSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            currentFocus = (currentFocus + 1) % filteredProducts.length;
            renderAutocompleteResults();
        } else if (e.key === 'ArrowUp') {
            currentFocus = (currentFocus - 1 + filteredProducts.length) % filteredProducts.length;
            renderAutocompleteResults();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (currentFocus > -1) {
                selectProduct(filteredProducts[currentFocus]);
            }
        }
    });

    document.addEventListener('click', (e) => {
        if (!autocompleteResultsDiv.contains(e.target) && e.target !== productSearchInput) {
            autocompleteResultsDiv.style.display = 'none';
        }
    });
}

// Shopping cart logic
function addItem() {
    const quantity = parseInt(document.getElementById('cantidad').value, 10);

    if (selectedProduct && quantity > 0) {
        const existingItemIndex = cart.findIndex(item => item.id === selectedProduct.id);
        if (existingItemIndex > -1) {
            cart[existingItemIndex].quantity += quantity;
        } else {
            cart.push({ ...selectedProduct, quantity });
        }
        renderCart();
        document.getElementById('cantidad').value = 1;
        productSearchInput.value = '';
        selectedProduct = null;
        messageBox("Producto agregado al carrito.", 'bg-green-500');
    } else {
        messageBox("Por favor, selecciona un producto y una cantidad válida.", 'bg-red-500');
    }
}

function renderCart() {
    cartTableBody.innerHTML = '';
    let subtotal = 0;

    cart.forEach((item, index) => {
        const row = document.createElement('tr');
        const itemTotal = item.price * item.quantity;
        subtotal += itemTotal;

        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${item.name}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${item.price.toFixed(2)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                <input type="number" value="${item.quantity}" min="1" class="quantity-input" onchange="updateCartItemQuantity(${index}, this.value)">
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${itemTotal.toFixed(2)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                <button class="delete-btn" onclick="removeCartItem(${index})">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </td>
        `;
        cartTableBody.appendChild(row);
    });

    const tax = subtotal * 0.16; // 16% IVA
    const total = subtotal + tax;

    subtotalDisplay.textContent = subtotal.toFixed(2);
    taxDisplay.textContent = tax.toFixed(2);
    totalDisplay.textContent = total.toFixed(2);
}

function updateCartItemQuantity(index, newQuantity) {
    const quantity = parseInt(newQuantity, 10);
    if (quantity > 0) {
        cart[index].quantity = quantity;
        renderCart();
    }
}

function removeCartItem(index) {
    cart.splice(index, 1);
    renderCart();
}

function clearCart() {
    cart = [];
    renderCart();
    messageBox("El carrito ha sido vaciado.", 'bg-yellow-500');
}

// Sale processing
function processSale() {
    if (cart.length === 0) {
        messageBox("El carrito está vacío. Agrega productos para procesar la venta.", 'bg-red-500');
        return;
    }
    showPaymentModal();
}

function showPaymentModal() {
    const modal = document.getElementById('payment-modal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

function hidePaymentModal() {
    const modal = document.getElementById('payment-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

async function finalizeSale(paymentMethod) {
    const total = parseFloat(totalDisplay.textContent);
    const saleData = {
        cart: cart.map(item => ({
            productId: item.id,
            productName: item.name,
            quantity: item.quantity,
            price: item.price
        })),
        subtotal: parseFloat(subtotalDisplay.textContent),
        tax: parseFloat(taxDisplay.textContent),
        total: total,
        paymentMethod: paymentMethod,
        timestamp: new Date(),
        userId: userId,
        companyId: companyId
    };

    try {
        await addDoc(collection(db, "sales"), saleData);
        messageBox("¡Venta finalizada con éxito!", 'bg-green-500');
        clearCart();
        hidePaymentModal();
        showSaleSuccessModal();
    } catch (e) {
        console.error("Error al añadir el documento de venta: ", e);
        messageBox("Error al procesar la venta. Por favor, inténtalo de nuevo.", 'bg-red-500');
    }
}

function showSaleSuccessModal() {
    const modal = document.getElementById('sale-modal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

function hideSaleSuccessModal() {
    const modal = document.getElementById('sale-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// Firestore listeners for saved invoices
function initializeFirestoreListeners() {
    if (!isAuthReady) {
        console.log("Autenticación no completa, no se iniciarán los listeners de Firestore.");
        return;
    }

    const savedInvoicesRef = collection(db, `artifacts/${appId}/users/${userId}/savedInvoices`);
    onSnapshot(savedInvoicesRef, (snapshot) => {
        const invoicesList = document.getElementById('invoices-list');
        invoicesList.innerHTML = '';
        snapshot.forEach((doc) => {
            const invoice = doc.data();
            const li = document.createElement('li');
            li.className = 'cursor-pointer hover:bg-gray-100 transition p-2 rounded-md';
            li.textContent = `Factura ${doc.id} - Total: $${invoice.total.toFixed(2)}`;
            li.addEventListener('click', () => loadInvoice(invoice.cart));
            invoicesList.appendChild(li);
        });
    }, (error) => {
        console.error("Error al escuchar cambios en las facturas guardadas: ", error);
        messageBox("Error al cargar facturas guardadas.", 'bg-red-500');
    });
}

async function saveInvoice() {
    if (cart.length === 0) {
        messageBox("No hay productos en el carrito para guardar.", 'bg-red-500');
        return;
    }

    const total = parseFloat(totalDisplay.textContent);
    const invoiceData = {
        cart: cart.map(item => ({
            productId: item.id,
            productName: item.name,
            quantity: item.quantity,
            price: item.price
        })),
        total: total,
        timestamp: new Date()
    };

    try {
        const savedInvoicesRef = collection(db, `artifacts/${appId}/users/${userId}/savedInvoices`);
        await addDoc(savedInvoicesRef, invoiceData);
        messageBox("Factura guardada con éxito.", 'bg-green-500');
    } catch (e) {
        console.error("Error al guardar la factura: ", e);
        messageBox("Error al guardar la factura.", 'bg-red-500');
    }
}

function loadInvoice(invoiceCart) {
    cart = invoiceCart.map(item => ({
        ...item,
        id: item.productId // Ensure id is correctly mapped for logic
    }));
    renderCart();
    messageBox("Factura cargada en el carrito.", 'bg-blue-500');
}

function newInvoice() {
    clearCart();
    messageBox("Nueva factura iniciada.", 'bg-gray-500');
}

// Authenticate the user
console.log("Iniciando autenticación...");
console.log("Token de autenticación inicial:", initialAuthToken ? "Detectado" : "No detectado");

if (initialAuthToken) {
    signInWithCustomToken(auth, initialAuthToken).catch(error => {
        console.error("Error al iniciar sesión con el token de autenticación:", error);
        messageBox("Error de autenticación. Por favor, recarga la página.", 'bg-red-500');
    });
}

onAuthStateChanged(auth, async (user) => {
    console.log("Estado de autenticación cambiado. Objeto de usuario:", user);

    if (user) {
        try {
            const idTokenResult = await user.getIdTokenResult();
            userId = user.uid;
            companyId = idTokenResult.claims.companyId;
            userRole = idTokenResult.claims.role;
            isAuthReady = true;

            // Moved these calls here to ensure they run only after authentication is complete
            updateUserInfoDisplay();
            initializeFirestoreListeners();
            fetchProducts();
            renderCart();
            setupSearchListener();
            messageBox("¡Autenticación exitosa! La aplicación está lista.", 'bg-green-500');
        } catch (error) {
            console.error("Error al obtener la información del token de autenticación:", error);
            messageBox("Error de autenticación. No se pudieron cargar los datos de la compañía.", 'bg-red-500');
        }
    } else {
        if (!initialAuthToken) {
            console.log("No se ha proporcionado un token, se intenta la autenticación anónima.");
            await signInAnonymously(auth);
        }
    }
});

// Event Listeners setup after the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('add-item-btn')?.addEventListener('click', addItem);
    document.getElementById('clear-cart-btn')?.addEventListener('click', clearCart);
    document.getElementById('process-sale-btn')?.addEventListener('click', processSale);
    document.getElementById('save-invoice-btn')?.addEventListener('click', () => saveInvoice());
    document.getElementById('new-invoice-btn')?.addEventListener('click', newInvoice);
    
    document.getElementById('payment-cash-btn')?.addEventListener('click', () => finalizeSale('Efectivo'));
    document.getElementById('payment-transfer-btn')?.addEventListener('click', () => finalizeSale('Transferencia'));
    document.getElementById('payment-cancel-btn')?.addEventListener('click', hidePaymentModal);
    
    document.getElementById('modal-close-btn')?.addEventListener('click', hideSaleSuccessModal);
});

// Expose functions to the global scope for dynamic content (e.g., cart items)
window.updateCartItemQuantity = updateCartItemQuantity;
window.removeCartItem = removeCartItem;
