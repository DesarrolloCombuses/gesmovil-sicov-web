# Alistamiento COMBUSES

Aplicación web instalable (PWA) para el registro diario de alistamiento y
mantenimiento de la flota de COMBUSES.

Este repositorio contiene **únicamente el frontend**, que es público por
naturaleza: es una página web, y su código llega al navegador de todos modos.
La lógica de servidor, el modelo de datos y la integración con la
Superintendencia de Transporte viven en un repositorio privado aparte.

## Qué hay aquí

| Archivo | Para qué |
|---|---|
| `index.html` | Portada: elegir alistamiento o mantenimiento |
| `alistamiento.html` | Formulario del conductor, sin login |
| `mantenimiento.html` | Registro de taller, requiere login |
| `sw.js` | Service worker: caché versionado y funcionamiento sin red |
| `manifest.webmanifest` | Metadatos de instalación |

## Cómo se instala en el celular

Se abre la URL en Chrome (Android) o Safari (iPhone) y se elige
**Agregar a pantalla de inicio**. Queda como una aplicación más.

## Sobre datos personales

La aplicación **no descarga la nómina**. Para saber el nombre de un conductor
se consulta su cédula de a una contra el servidor, con tope de consultas por
conexión y registro de auditoría de cada una. Es un requisito de la Ley 1581
de 2012: los datos personales no se publican, se consultan con finalidad.

## Versiones

La versión está en `sw.js` (`const VERSION`). Al subirla, el service worker
borra las cachés anteriores y reparte el código nuevo. No se actualiza encima
de un formulario a medio llenar: espera a que se envíe o se descarte.
