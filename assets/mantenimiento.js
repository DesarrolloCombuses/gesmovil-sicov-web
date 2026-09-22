/* ---------------------------------------------------------------------------
   Formulario de mantenimientos
   ---------------------------------------------------------------------------
   Requiere login: un mantenimiento es la afirmacion de que un trabajo se
   ejecuto, y el manual exige un responsable con nombre y cedula. Un formulario
   anonimo no puede sostener eso.

   Se carga como modulo porque necesita supabase-js para el login. El resto de
   la app no lo necesita, asi que solo esta pagina paga la descarga.
--------------------------------------------------------------------------- */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const { CONFIG, API, $, mostrarAviso, ocultarAviso, soloDigitos } = window.SICOV;
const RUTA = API("sicov-mantenimiento");

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const estado = { actividades: [], tipo: null, usuario: null, enviando: false };

// Si hay algo capturado, una actualizacion de la app no debe recargar y
// llevarse el trabajo.
window.SICOV.registrarGuardia(
  () =>
    !!estado.tipo ||
    !!$("placa")?.value ||
    !!$("detalleLibre")?.value ||
    document.querySelectorAll("#checklist input:checked").length > 0,
);

/** Token de la sesion actual, para llamar a la edge function. */
async function token() {
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token || null;
}

// ---------------------------------------------------------------------------
// Sesion
// ---------------------------------------------------------------------------

async function arrancar() {
  if (CONFIG.SUPABASE_ANON_KEY === "PEGAR_AQUI_LA_ANON_KEY") {
    mostrarAviso("Falta configurar SUPABASE_ANON_KEY en assets/comun.js.", "info");
    return;
  }
  // El login necesita red: sin ella no hay sesion que validar ni catalogo que
  // traer. Es distinto del alistamiento, que se puede llenar sin señal.
  if (!window.SICOV.hayConexion() && !(await token())) {
    mostrarAviso("Sin conexión: no se puede iniciar sesión. Conéctate e intenta de nuevo.", "info");
    return;
  }

  const jwt = await token();
  if (jwt) return await entrarAlFormulario();
  $("login").hidden = false;
}

$("login").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  ocultarAviso();
  $("entrar").disabled = true;
  $("entrar").textContent = "Entrando…";

  const { error } = await sb.auth.signInWithPassword({
    email: $("correo").value.trim(),
    password: $("clave").value,
  });

  $("entrar").disabled = false;
  $("entrar").textContent = "Entrar";

  if (error) {
    // Mismo mensaje para correo inexistente y clave mala: no se confirma si
    // una cuenta existe.
    return mostrarAviso("Correo o contraseña incorrectos.");
  }
  $("login").hidden = true;
  await entrarAlFormulario();
});

$("salir").addEventListener("click", async () => {
  await sb.auth.signOut();
  window.location.reload();
});

// ---------------------------------------------------------------------------
// Carga del formulario
// ---------------------------------------------------------------------------

async function entrarAlFormulario() {
  $("cargando").hidden = false;
  ocultarAviso();

  try {
    const jwt = await token();
    const resp = await fetch(RUTA + "/formulario", {
      headers: { Authorization: "Bearer " + jwt },
    });
    const datos = await resp.json();

    if (!resp.ok || !datos.success) {
      // Un 403 aqui es la cuenta sin autorizar en sicov_usuarios: tener sesion
      // no basta, y conviene que el mensaje del servidor lo diga.
      throw new Error(datos.message || "No se pudo cargar el formulario.");
    }

    estado.usuario = datos.usuario;
    estado.actividades = datos.actividades || [];

    $("subtitulo").textContent = `${datos.usuario.nombre} · ${datos.usuario.rol}`;
    $("salir").hidden = false;

    const selPlaca = $("placa");
    for (const v of datos.vehiculos) {
      const op = document.createElement("option");
      op.value = v.placa;
      op.textContent = v.interno ? `${v.placa} — interno ${v.interno}` : v.placa;
      selPlaca.appendChild(op);
    }

    pintarTipos(datos.tipos);
    pintarChecklist();

    // Solo coordinador y admin pueden atribuir el trabajo a otra persona. El
    // servidor lo vuelve a comprobar; esto es para no mostrar lo que no se
    // puede usar.
    if (datos.usuario.rol === "coordinador" || datos.usuario.rol === "admin") {
      $("panel-responsable").hidden = false;
    }

    // Por defecto, ahora: es cuando se registra el trabajo recien hecho.
    const ahora = new Date();
    const dos = (n) => String(n).padStart(2, "0");
    $("fecha").value = `${ahora.getFullYear()}-${dos(ahora.getMonth() + 1)}-${dos(ahora.getDate())}`;
    $("fecha").max = $("fecha").value;
    $("hora").value = `${dos(ahora.getHours())}:${dos(ahora.getMinutes())}`;

    $("cargando").hidden = true;
    $("formulario").hidden = false;
    $("barra").hidden = false;

    if (datos.catalogoVacio) {
      mostrarAviso(
        "El catálogo oficial de actividades está vacío. Puedes registrar usando el detalle del trabajo.",
        "info",
      );
    }
    actualizarProgreso();
  } catch (e) {
    $("cargando").hidden = true;
    mostrarAviso(e.message || "No se pudo cargar.");
  }
}

function pintarTipos(tipos) {
  const cont = $("tipos");
  cont.innerHTML = "";
  for (const t of tipos) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t.nombre;
    b.dataset.id = String(t.id);
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      estado.tipo = t.id;
      for (const otro of cont.querySelectorAll("button")) {
        otro.setAttribute("aria-pressed", String(Number(otro.dataset.id) === t.id));
      }
      actualizarProgreso();
    });
    cont.appendChild(b);
  }
}

function pintarChecklist() {
  const cont = $("checklist");
  cont.innerHTML = "";

  if (estado.actividades.length === 0) {
    const p = document.createElement("p");
    p.className = "sub";
    p.style.margin = "0";
    p.textContent = "Sin catálogo sincronizado. Describe el trabajo en el detalle.";
    cont.appendChild(p);
    return;
  }

  let grupoActual = null;
  for (const act of estado.actividades) {
    if (act.grupo && act.grupo !== grupoActual) {
      grupoActual = act.grupo;
      const cab = document.createElement("div");
      cab.className = "grupo";
      const nombre = document.createElement("span");
      nombre.className = "grupo-nombre";
      nombre.textContent = act.grupo;
      cab.appendChild(nombre);
      cont.appendChild(cab);
    }

    const l = document.createElement("label");
    l.className = "check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = String(act.id);
    cb.addEventListener("change", actualizarProgreso);
    const sp = document.createElement("span");
    sp.textContent = act.descripcion;
    l.append(cb, sp);
    cont.appendChild(l);
  }
}

function marcadas() {
  return [...document.querySelectorAll("#checklist input:checked")].map((c) => Number(c.value));
}

function actualizarProgreso() {
  const n = marcadas().length;
  const tipo = estado.tipo ? (estado.tipo === 1 ? "preventivo" : "correctivo") : "sin tipo";
  $("progreso").textContent = n ? `${n} actividad(es) · ${tipo}` : tipo;
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

$("enviar").addEventListener("click", async () => {
  ocultarAviso();

  const placa = $("placa").value;
  const actividades = marcadas();
  const detalleLibre = $("detalleLibre").value.trim();

  if (!placa) return mostrarAviso("Selecciona el vehículo.");
  if (!$("fecha").value) return mostrarAviso("Indica la fecha del trabajo.");
  if (!$("hora").value) return mostrarAviso("Indica la hora del trabajo.");
  if (!estado.tipo) return mostrarAviso("Indica si es preventivo o correctivo.");
  if (actividades.length === 0 && !detalleLibre) {
    return mostrarAviso("Marca actividades del catálogo o escribe el detalle del trabajo.");
  }
  if (!window.SICOV.hayConexion()) {
    return mostrarAviso("Sin conexión. Lo que llenaste sigue aquí: recupera señal y vuelve a tocar Registrar.");
  }

  estado.enviando = true;
  $("enviar").disabled = true;
  $("enviar").textContent = "Enviando…";

  try {
    const jwt = await token();
    const resp = await fetch(RUTA + "/registrar", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
      body: JSON.stringify({
        placa,
        fecha: $("fecha").value,
        hora: $("hora").value,
        tipo: estado.tipo,
        actividades: actividades.map((id) => ({ id })),
        detalleLibre,
        kilometraje: soloDigitos($("kilometraje").value),
        observaciones: $("observaciones").value.trim(),
        responsableCedula: soloDigitos($("respCedula").value),
        responsableNombre: $("respNombre").value.trim(),
      }),
    });
    const datos = await resp.json();

    if (!resp.ok || !datos.success) throw new Error(datos.message || "No se pudo registrar.");

    // Se limpia para el siguiente en vez de recargar: el taller registra
    // varios seguidos, y recargar le costaria volver a esperar la carga.
    mostrarAviso(`Mantenimiento registrado para ${placa}.`, "bien");
    for (const c of document.querySelectorAll("#checklist input:checked")) c.checked = false;
    $("detalleLibre").value = "";
    $("observaciones").value = "";
    $("kilometraje").value = "";
    $("placa").value = "";
    window.scrollTo(0, 0);
  } catch (e) {
    mostrarAviso(e.message || "No se pudo enviar.");
  } finally {
    estado.enviando = false;
    $("enviar").disabled = false;
    $("enviar").textContent = "Registrar";
    actualizarProgreso();
  }
});

arrancar();
