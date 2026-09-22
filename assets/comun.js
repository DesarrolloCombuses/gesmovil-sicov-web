/* ---------------------------------------------------------------------------
   Utilidades compartidas + ciclo de vida de la PWA
   ---------------------------------------------------------------------------
   Lo que usan los dos formularios: configuracion, avisos, estado de conexion,
   y el manejo de versiones del service worker.

   Se expone como window.SICOV para que cada formulario solo tenga que
   preocuparse de lo suyo.
--------------------------------------------------------------------------- */

(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // Configuracion
  // -------------------------------------------------------------------------
  // La URL del proyecto no es un secreto: es el endpoint publico. La anon key
  // tampoco -- va en frontends por diseño y no da acceso a nada por si sola,
  // porque las tablas tienen RLS y los registros pasan por edge functions.
  const CONFIG = {
    SUPABASE_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co",
    SUPABASE_ANON_KEY: "PEGAR_AQUI_LA_ANON_KEY",
  };

  const API = (fn) => `${CONFIG.SUPABASE_URL}/functions/v1/${fn}`;

  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------------------------
  // Avisos
  // -------------------------------------------------------------------------

  function mostrarAviso(texto, clase) {
    const el = $("aviso");
    if (!el) return;
    el.textContent = texto;
    el.className = "aviso " + (clase || "error");
    el.hidden = false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function ocultarAviso() {
    const el = $("aviso");
    if (el) el.hidden = true;
  }

  // -------------------------------------------------------------------------
  // Limpieza de datos
  // -------------------------------------------------------------------------

  /** Solo digitos: evita que "12.345.678" llegue al servidor con puntos. */
  function soloDigitos(valor) {
    return String(valor || "").replace(/[^\d]/g, "");
  }

  /**
   * Quita el estado que la operacion pega al nombre ("Juan Perez [INCAPACITADO]").
   * Ese corchete es dato de salud de una persona identificada: dato sensible
   * bajo la Ley 1581 de 2012. No tiene por que aparecer en una lista abierta.
   */
  function nombreLimpio(valor) {
    return String(valor || "").replace(/\s*\[[^\]]*\]\s*/g, " ").trim();
  }

  // -------------------------------------------------------------------------
  // Estado de conexion
  // -------------------------------------------------------------------------
  // Una cinta pegada arriba, no un aviso en el flujo: el conductor tiene que
  // poder ver que esta sin red en cualquier momento del formulario, no solo
  // cuando lo abrio.
  //
  // Se puede llenar el formulario sin red -- el catalogo viene del cache del
  // service worker -- pero enviarlo no. Un alistamiento es una afirmacion ante
  // el regulador con una restriccion de uno por placa y dia; guardarlo aqui
  // para mandarlo luego acabaria en duplicados o en un "crei que lo envie".
  // Por eso la cinta dice exactamente eso y lo escrito no se pierde.

  function pintarConexion() {
    const cinta = $("cinta-conexion");
    if (!cinta) return;
    if (navigator.onLine) {
      cinta.hidden = true;
    } else {
      cinta.textContent = "Sin conexión — puedes llenar el formulario, pero no enviarlo hasta recuperar señal.";
      cinta.className = "cinta sinred";
      cinta.hidden = false;
    }
  }

  window.addEventListener("online", pintarConexion);
  window.addEventListener("offline", pintarConexion);

  // -------------------------------------------------------------------------
  // Service worker y versiones
  // -------------------------------------------------------------------------

  // Cada formulario puede declarar si tiene trabajo a medias, para que una
  // actualizacion no recargue la pagina y se lleve lo que el conductor llevaba
  // escrito. Por defecto se asume que no hay nada que perder.
  let hayTrabajoSinGuardar = () => false;

  let recargando = false;
  let registro = null;

  /** Aplica el worker en espera. La recarga la dispara controllerchange. */
  function aplicarActualizacion() {
    if (!registro || !registro.waiting) return;
    registro.waiting.postMessage({ tipo: "SKIP_WAITING" });
  }

  function anunciarVersionNueva() {
    const cinta = $("cinta-version");
    if (!cinta) return;

    // Si no hay nada escrito, se actualiza sola: molestar con un boton para
    // algo que no cuesta nada es ruido.
    if (!hayTrabajoSinGuardar()) {
      aplicarActualizacion();
      return;
    }

    cinta.className = "cinta nueva";
    cinta.hidden = false;
    cinta.innerHTML = "";

    const texto = document.createElement("span");
    texto.textContent = "Hay una versión nueva.";

    const boton = document.createElement("button");
    boton.type = "button";
    boton.textContent = "Actualizar";
    boton.addEventListener("click", aplicarActualizacion);

    cinta.append(texto, boton);
  }

  function vigilarRegistro(reg) {
    registro = reg;

    // Ya hay una version instalada esperando de una visita anterior.
    if (reg.waiting) anunciarVersionNueva();

    reg.addEventListener("updatefound", () => {
      const nuevo = reg.installing;
      if (!nuevo) return;
      nuevo.addEventListener("statechange", () => {
        // 'installed' con un controller ya presente significa version nueva
        // esperando. Sin controller es la primera instalacion, que no se
        // anuncia: no hay nada que actualizar.
        if (nuevo.state === "installed" && navigator.serviceWorker.controller) {
          anunciarVersionNueva();
        }
      });
    });

    // Buscar actualizaciones al volver a la app y cada media hora: la app
    // instalada puede quedarse abierta dias, y sin esto no se enteraria de una
    // version nueva hasta que alguien la cierre.
    const buscar = () => reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") buscar();
    });
    setInterval(buscar, 30 * 60 * 1000);
  }

  async function registrarServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    // Una sola recarga cuando el worker nuevo toma el control. El guardia
    // evita el bucle de recargas que sale si dos eventos llegan juntos.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (recargando) return;
      recargando = true;
      window.location.reload();
    });

    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      vigilarRegistro(reg);
      mostrarVersion();
    } catch (e) {
      // Sin service worker la app funciona igual, solo pierde el modo sin red.
      // No vale la pena molestar al usuario con esto.
      console.warn("[sicov] no se pudo registrar el service worker:", e);
    }
  }

  /**
   * Pregunta al worker que version esta sirviendo y la muestra en el pie.
   * Se le pregunta a el en vez de guardar la version tambien aqui: dos copias
   * del numero acabarian discrepando, y la que importa es la que atiende.
   */
  function mostrarVersion() {
    const pie = $("version");
    if (!pie) return;

    const sw = navigator.serviceWorker.controller;
    if (!sw) {
      pie.textContent = "sin modo offline todavía";
      return;
    }

    const canal = new MessageChannel();
    canal.port1.onmessage = (ev) => {
      if (ev.data?.tipo === "VERSION") pie.textContent = "v" + ev.data.version;
    };
    sw.postMessage({ tipo: "VERSION" }, [canal.port2]);
  }

  // -------------------------------------------------------------------------
  // Arranque
  // -------------------------------------------------------------------------

  pintarConexion();
  registrarServiceWorker();

  window.SICOV = {
    CONFIG,
    API,
    $,
    mostrarAviso,
    ocultarAviso,
    soloDigitos,
    nombreLimpio,
    hayConexion: () => navigator.onLine,
    /** Declara como sabe este formulario si tiene trabajo a medias. */
    registrarGuardia(fn) {
      if (typeof fn === "function") hayTrabajoSinGuardar = fn;
    },
  };
})();
