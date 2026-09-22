/* ---------------------------------------------------------------------------
   Service worker de la plataforma SICOV
   ---------------------------------------------------------------------------
   MANEJO DE VERSIONES

   La constante VERSION de abajo es la fuente unica. Para publicar una version
   nueva se cambia aqui y se vuelven a subir los archivos: no hay que tocar
   nada mas, y nada la duplica.

   Funciona porque el navegador compara sw.js byte a byte con el que tiene
   instalado. Cambiar VERSION cambia el archivo, el navegador lo detecta, y el
   nuevo entra en estado 'waiting'. De ahi NO pasa solo: la pagina decide
   cuando activarlo (ver comun.js). Eso es deliberado -- activar en medio de un
   checklist a medio llenar recargaria la pagina y el conductor perderia lo que
   llevaba escrito.

   El nombre del cache incluye la version, asi que cada version estrena cache y
   los anteriores se borran al activar. No hay forma de quedarse con una mezcla
   de archivos de dos versiones.

   ESTRATEGIAS DE RED, y por que cada una

   - Navegacion (los HTML): red primero con 3s de plazo, y si no responde, del
     cache. Con red normal siempre se ve lo ultimo, asi que una correccion
     urgente llega al primer intento; sin red, o con la red mala de un
     parqueadero, la app abre igual.

   - Archivos del shell (css, js, iconos): cache primero. Estan en el cache de
     esta version, asi que no hace falta preguntar por ellos; cuando cambia la
     version se renuevan todos de golpe.

   - GET /formulario de la API: se sirve del cache y se refresca de fondo. Es
     el catalogo y la flota: cambia poco, y gracias a esto el formulario se
     puede pintar sin red. Un catalogo de ayer es mucho mejor que una pantalla
     en blanco.

   - Todo lo demas de la API, y cualquier POST: solo red, nunca cache. Un
     registro de alistamiento no se guarda ni se reintenta a espaldas de quien
     lo envia: es una afirmacion ante el regulador, y hay una restriccion de
     uno por placa y dia. Una copia guardada aqui acabaria en duplicados o en
     un "crei que lo habia enviado".
--------------------------------------------------------------------------- */

const VERSION = "1.0.0";

const CACHE = `sicov-v${VERSION}`;

// El shell: lo que tiene que estar para que la app abra sin red.
// Rutas relativas a la raiz donde se publique, para que funcione igual en un
// bucket de Storage que en un subdirectorio.
const SHELL = [
  "./",
  "./index.html",
  "./alistamiento.html",
  "./mantenimiento.html",
  "./manifest.webmanifest",
  "./assets/app.css",
  "./assets/comun.js",
  "./assets/alistamiento.js",
  "./assets/mantenimiento.js",
  "./assets/icono-192.png",
  "./assets/icono-512.png",
];

const PLAZO_RED_MS = 3000;

// ---------------------------------------------------------------------------
// Instalacion
// ---------------------------------------------------------------------------

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll falla entero si un solo archivo falla, y entonces la version no
      // se instala y el usuario se queda en la anterior -- que funciona. Se
      // pide de red explicitamente para no heredar una copia vieja del cache
      // HTTP del navegador.
      await cache.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })));
      // Sin skipWaiting: el nuevo queda esperando y la pagina decide.
    })(),
  );
});

// ---------------------------------------------------------------------------
// Activacion
// ---------------------------------------------------------------------------

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    (async () => {
      // Fuera los caches de versiones anteriores. Solo se tocan los que
      // empiezan por 'sicov-v': si algun dia convive otra app en el mismo
      // origen, sus caches no son asunto de este worker.
      const nombres = await caches.keys();
      await Promise.all(
        nombres
          .filter((n) => n.startsWith("sicov-v") && n !== CACHE)
          .map((n) => caches.delete(n)),
      );

      // Con navigationPreload el navegador lanza la peticion de navegacion en
      // paralelo al arranque del worker, en vez de esperarlo. Se activa si el
      // navegador lo soporta.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }

      // Tomar el control de las pestañas abiertas sin que tengan que recargar.
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// Mensajes desde la pagina
// ---------------------------------------------------------------------------

self.addEventListener("message", (evento) => {
  const dato = evento.data || {};

  if (dato.tipo === "SKIP_WAITING") {
    // La pagina confirmo que es buen momento para actualizar.
    self.skipWaiting();
    return;
  }

  if (dato.tipo === "VERSION") {
    // La pagina pregunta que version la esta atendiendo. Responder por el
    // puerto del mensaje, y no por broadcast, evita que una pestaña reciba la
    // respuesta de la pregunta de otra.
    evento.ports?.[0]?.postMessage({ tipo: "VERSION", version: VERSION });
  }
});

// ---------------------------------------------------------------------------
// Reglas de red
// ---------------------------------------------------------------------------

function esApi(url) {
  return url.pathname.includes("/functions/v1/");
}

function esFormularioApi(url) {
  // Los dos GET que traen catalogo y flota. Son los unicos de la API que vale
  // la pena guardar: son datos de referencia, no registros.
  return esApi(url) && url.pathname.endsWith("/formulario");
}

/** Red con plazo. Si tarda mas de lo que un usuario espera, se usa el cache. */
async function redConPlazo(peticion, ms) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), ms);
  try {
    return await fetch(peticion, { signal: control.signal });
  } finally {
    clearTimeout(reloj);
  }
}

/** Navegacion: red primero, cache como red de seguridad. */
async function atenderNavegacion(evento) {
  const cache = await caches.open(CACHE);
  try {
    const precargada = await evento.preloadResponse;
    const respuesta = precargada || (await redConPlazo(evento.request, PLAZO_RED_MS));
    if (respuesta && respuesta.ok) {
      cache.put(evento.request, respuesta.clone());
    }
    return respuesta;
  } catch {
    const guardada =
      (await cache.match(evento.request)) ||
      (await cache.match("./index.html"));
    if (guardada) return guardada;
    return new Response(
      "<!doctype html><meta charset=utf-8><title>Sin conexion</title>" +
        "<p style='font:16px system-ui;padding:24px'>Sin conexión y sin copia guardada. " +
        "Conéctate una vez para poder usar la app sin red.",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

/** Shell: cache primero. */
async function atenderShell(peticion) {
  const cache = await caches.open(CACHE);
  const guardada = await cache.match(peticion);
  if (guardada) return guardada;

  const respuesta = await fetch(peticion);
  if (respuesta && respuesta.ok) cache.put(peticion, respuesta.clone());
  return respuesta;
}

/** Catalogo y flota: se sirve lo guardado y se refresca de fondo. */
async function atenderFormularioApi(peticion) {
  const cache = await caches.open(CACHE);
  const guardada = await cache.match(peticion);

  const refrescar = fetch(peticion)
    .then((respuesta) => {
      if (respuesta && respuesta.ok) cache.put(peticion, respuesta.clone());
      return respuesta;
    })
    .catch(() => null);

  if (guardada) {
    // No se espera el refresco: la copia guardada se entrega ya, y la
    // siguiente apertura vera la nueva.
    return guardada;
  }
  const fresca = await refrescar;
  if (fresca) return fresca;

  return new Response(
    JSON.stringify({
      success: false,
      message: "Sin conexión y sin catálogo guardado. Conéctate una vez para poder usar la app sin red.",
    }),
    { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } },
  );
}

self.addEventListener("fetch", (evento) => {
  const peticion = evento.request;

  // Los POST y todo lo que no sea GET van directo a la red, sin pasar por
  // aqui: registrar un alistamiento no es algo que este worker deba mediar.
  if (peticion.method !== "GET") return;

  const url = new URL(peticion.url);

  // Otro origen que no sea la API de Supabase: que lo maneje el navegador.
  if (url.origin !== self.location.origin && !esApi(url)) return;

  if (peticion.mode === "navigate") {
    evento.respondWith(atenderNavegacion(evento));
    return;
  }

  if (esFormularioApi(url)) {
    evento.respondWith(atenderFormularioApi(peticion));
    return;
  }

  // Cualquier otra cosa de la API (consultas de estado, por ejemplo) necesita
  // el dato real, no uno de hace un rato.
  if (esApi(url)) return;

  if (url.origin === self.location.origin) {
    evento.respondWith(atenderShell(peticion));
  }
});
