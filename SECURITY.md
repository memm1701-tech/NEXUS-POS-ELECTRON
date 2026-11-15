# Política de Seguridad — NEXUS POS Global

## Reporte Responsable de Vulnerabilidades

Si detectas una vulnerabilidad de seguridad en **NEXUS POS Global**, por favor **no** la divulgues públicamente mediante Issues ni Pull Requests abiertos.

Repórtala de forma privada a través de:
- La pestaña **Security → Advisories → Report a vulnerability** de este repositorio en GitHub, o
- Los canales oficiales privados de soporte de **Nexus Company C.A.**

## Alcance y Buenas Prácticas del Repositorio

- Nunca subas archivos `.env`, credenciales JSON, certificados (`.pem`, `.key`, `.pfx`, `.p12`), bases de datos (`.db`, `.sqlite`) ni respaldos al repositorio.
- Cualquier archivo de configuración local debe permanecer bajo `data/` y fuera del control de versiones (ver `.gitignore`).
