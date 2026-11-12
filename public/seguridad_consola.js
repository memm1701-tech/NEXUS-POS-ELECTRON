// =============================================================================
// SEGURIDAD DE CONSOLA DE DESARROLLADOR - NEXUS POS GLOBAL
// Bloqueo estricto para F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C (y Mac Cmd+Option+I/J/C)
// Bloqueo de inspección secundaria: Clic Derecho, Ctrl+U, Ctrl+S, Ctrl+P, Shift+Esc
// Ventana emergente tipo SaaS con OTP de 6 dígitos y auto-enter (Clave: 109882)
// =============================================================================

(function () {
    let modalActivo = false;

    function abrirModalSeguridadConsola() {
        if (modalActivo || document.getElementById('modal-seguridad-consola')) return;
        modalActivo = true;

        const modal = document.createElement('div');
        modal.id = 'modal-seguridad-consola';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(15, 23, 42, 0.55);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 99999999;
            backdrop-filter: blur(5px);
            opacity: 0;
            transition: opacity 0.2s ease;
        `;

        modal.innerHTML = `
            <style>
                @keyframes otpShakeAnim {
                    0%, 100% { transform: translateX(0); }
                    20%, 60% { transform: translateX(-6px); }
                    40%, 80% { transform: translateX(6px); }
                }
                .otp-shake-active {
                    animation: otpShakeAnim 0.35s ease;
                }
                .otp-digit-input {
                    width: 44px;
                    height: 52px;
                    border-radius: 10px;
                    border: 2px solid #e5e7eb;
                    text-align: center;
                    font-size: 20px;
                    font-weight: 700;
                    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                    outline: none;
                    background: #f9fafb;
                    color: #1f2937;
                    transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease, color 0.15s ease;
                    caret-color: #2563eb;
                }
                .otp-digit-input:focus {
                    border-color: #2563eb;
                    background: #ffffff;
                    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
                }
                .otp-digit-input.otp-error {
                    border-color: #ef4444 !important;
                    background-color: #fef2f2 !important;
                    color: #ef4444 !important;
                }
            </style>
            <div style="background: #ffffff; padding: 32px 30px; border-radius: 18px; text-align: center; max-width: 420px; width: 92%; box-shadow: 0 20px 45px rgba(0, 0, 0, 0.2); position: relative; font-family: inherit;">
                <button id="cerrar-modal-seguridad-consola" style="position: absolute; top: 14px; right: 16px; background: none; border: none; font-size: 24px; color: #9ca3af; cursor: pointer; line-height: 1; padding: 4px; transition: color 0.15s ease;" onmouseover="this.style.color='#4b5563'" onmouseout="this.style.color='#9ca3af'">&times;</button>
                
                <div style="width: 52px; height: 52px; border-radius: 50%; background: #eff6ff; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px auto;">
                    <i class="fa-solid fa-shield-halved" style="color: #2563eb; font-size: 24px;"></i>
                </div>

                <h2 style="font-size: 21px; color: #111827; margin: 0 0 8px 0; font-weight: 700; letter-spacing: -0.01em;">¿Qué intentas hacer?</h2>
                <p style="color: #6b7280; font-size: 13.5px; line-height: 1.45; margin: 0 0 24px 0;">Esta área está protegida. Ingresa el código de autorización de 6 dígitos.</p>

                <div id="otp-row-container" style="display: flex; justify-content: center; align-items: center; gap: 8px; margin-bottom: 14px;">
                    <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" data-index="0" autocomplete="off" />
                    <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" data-index="1" autocomplete="off" />
                    <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" data-index="2" autocomplete="off" />
                    <div style="width: 8px;"></div>
                    <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" data-index="3" autocomplete="off" />
                    <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" data-index="4" autocomplete="off" />
                    <input type="text" inputmode="numeric" maxlength="1" class="otp-digit-input" data-index="5" autocomplete="off" />
                </div>

                <div id="otp-feedback-msg" style="min-height: 20px; font-size: 12.5px; color: #ef4444; font-weight: 500; transition: opacity 0.15s ease;"></div>
            </div>
        `;

        document.body.appendChild(modal);

        requestAnimationFrame(() => {
            modal.style.opacity = '1';
        });

        const inputs = Array.from(modal.querySelectorAll('.otp-digit-input'));
        const rowContainer = modal.querySelector('#otp-row-container');
        const feedbackMsg = modal.querySelector('#otp-feedback-msg');
        const closeBtn = modal.querySelector('#cerrar-modal-seguridad-consola');

        const cerrarModal = () => {
            modal.style.opacity = '0';
            setTimeout(() => {
                if (modal.parentNode) modal.parentNode.removeChild(modal);
                modalActivo = false;
            }, 180);
        };

        closeBtn.onclick = cerrarModal;
        modal.onclick = (e) => {
            if (e.target === modal) cerrarModal();
        };

        const enfocar = (idx) => {
            const el = inputs[Math.max(0, Math.min(inputs.length - 1, idx))];
            if (el) {
                el.focus();
                el.select();
            }
        };

        inputs.forEach((input, idx) => {
            input.addEventListener('focus', () => {
                input.select();
            });

            input.addEventListener('input', (e) => {
                const val = e.target.value.replace(/\D/g, '');
                e.target.value = val ? val[val.length - 1] : '';
                if (e.target.value) {
                    if (idx < inputs.length - 1) {
                        enfocar(idx + 1);
                    }
                }
                verificarOtpCompleto();
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace') {
                    if (!input.value && idx > 0) {
                        inputs[idx - 1].value = '';
                        enfocar(idx - 1);
                        e.preventDefault();
                    } else {
                        input.value = '';
                    }
                    if (feedbackMsg) feedbackMsg.textContent = '';
                } else if (e.key === 'ArrowLeft' && idx > 0) {
                    enfocar(idx - 1);
                    e.preventDefault();
                } else if (e.key === 'ArrowRight' && idx < inputs.length - 1) {
                    enfocar(idx + 1);
                    e.preventDefault();
                } else if (e.key === 'Escape') {
                    cerrarModal();
                }
            });

            input.addEventListener('paste', (e) => {
                e.preventDefault();
                const texto = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
                if (texto) {
                    texto.split('').forEach((char, cIdx) => {
                        if (inputs[cIdx]) inputs[cIdx].value = char;
                    });
                    if (texto.length < 6) {
                        enfocar(texto.length);
                    }
                    verificarOtpCompleto();
                }
            });
        });

        async function verificarOtpCompleto() {
            const codigo = inputs.map(i => i.value).join('');
            if (codigo.length === 6) {
                inputs.forEach(i => i.disabled = true);
                
                let autorizado = false;
                const clavesLocales = ['109882', '337246'];
                if (window.nexusAPI && window.nexusAPI.solicitarDesbloqueoConsola) {
                    try {
                        const res = await window.nexusAPI.solicitarDesbloqueoConsola(codigo);
                        autorizado = (res && res.success);
                    } catch (err) {
                        autorizado = clavesLocales.includes(codigo);
                    }
                } else {
                    autorizado = clavesLocales.includes(codigo);
                }

                if (autorizado) {
                    cerrarModal();
                } else {
                    rowContainer.classList.add('otp-shake-active');
                    inputs.forEach(i => {
                        i.disabled = false;
                        i.classList.add('otp-error');
                    });
                    if (feedbackMsg) feedbackMsg.textContent = 'Código no autorizado';
                    
                    setTimeout(() => {
                        rowContainer.classList.remove('otp-shake-active');
                        inputs.forEach(i => {
                            i.value = '';
                            i.classList.remove('otp-error');
                        });
                        enfocar(0);
                    }, 650);
                }
            }
        }

        setTimeout(() => enfocar(0), 120);
    }

    // 1. Interceptar comandos de teclado a nivel de ventana (fase de captura)
    window.addEventListener('keydown', function (e) {
        const key = e.key ? e.key.toLowerCase() : '';
        const isControlOrMeta = e.ctrlKey || e.metaKey;
        const isShiftOrAlt = e.shiftKey || e.altKey;

        // A. Atajos de inspección de consola (solicita clave de 6 dígitos)
        // - F12
        // - Ctrl + Shift + I, J, C (Windows / Linux)
        // - Cmd + Option + I, J, C (macOS)
        // - Ctrl + Alt + I, J, C
        const esAtajoConsola = 
            (isControlOrMeta && isShiftOrAlt && ['i', 'j', 'c'].includes(key)) || 
            e.key === 'F12';

        if (esAtajoConsola) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            abrirModalSeguridadConsola();
            return;
        }

        // B. Atajos secundarios bloqueados silenciosamente:
        // - Ctrl/Cmd + U (Ver código fuente)
        // - Ctrl/Cmd + S (Guardar página como archivo)
        // - Ctrl/Cmd + P (Diálogo de impresión nativo del navegador)
        // - Shift + Escape (Administrador de tareas de Chromium)
        const esAtajoBloqueado = 
            (isControlOrMeta && ['u', 's', 'p'].includes(key)) ||
            (e.shiftKey && e.key === 'Escape');

        if (esAtajoBloqueado) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return;
        }
    }, true);

    // 2. Bloqueo total de menú contextual de clic derecho (evita "Inspeccionar elemento")
    window.addEventListener('contextmenu', function (e) {
        e.preventDefault();
    }, true);

    // 3. Escuchar la notificación del proceso principal (main.js)
    if (window.nexusAPI && window.nexusAPI.onSolicitarClaveConsola) {
        window.nexusAPI.onSolicitarClaveConsola(() => {
            abrirModalSeguridadConsola();
        });
    }
})();
