/* ---------------------------------------------------------------------------
   Formulario de alistamiento diario
   ---------------------------------------------------------------------------
   Lo llena el conductor en el movil, sin login. La autorizacion la pone el
   servidor: solo acepta placas que existen en la flota y actividades del
   catalogo oficial de la Supertransporte.
--------------------------------------------------------------------------- */

(function () {
  "use strict";

  const { API, $, mostrarAviso, ocultarAviso, soloDigitos, nombreLimpio } = window.SICOV;
  const RUTA = API("sicov-alistar");

  const estado = {
    actividades: [],
    marcas: new Map(),
    // Lo ya resuelto por /conductor, para no repetir la consulta mientras el
    // conductor corrige un digito y vuelve atras.
    nombresVistos: new Map(),
    // placa -> interno, para que el comprobante diga "EQR790 · interno 717".
    // El conductor reconoce su bus por el interno, no por la placa.
    internos: new Map(),
    enviando: false,
    enviado: false,
  };

  // Si hay algo marcado o escrito, una actualizacion de la app no debe
  // recargar la pagina y llevarse el trabajo. Despues de enviar ya no importa.
  window.SICOV.registrarGuardia(() => {
    if (estado.enviado) return false;
    return (
      estado.marcas.size > 0 ||
      !!$("placa")?.value ||
      !!$("cedula")?.value ||
      !!$("observaciones")?.value
    );
  });

  // -------------------------------------------------------------------------
  // Carga inicial
  // -------------------------------------------------------------------------

  async function cargar() {
    try {
      const resp = await fetch(RUTA + "/formulario");
      const datos = await resp.json();
      if (!resp.ok || !datos.success) {
        throw new Error(datos.message || "No se pudo cargar el formulario.");
      }

      const selPlaca = $("placa");
      for (const v of datos.vehiculos) {
        if (v.interno) estado.internos.set(v.placa, v.interno);
        const op = document.createElement("option");
        op.value = v.placa;
        op.textContent = v.interno ? `${v.placa} — interno ${v.interno}` : v.placa;
        selPlaca.appendChild(op);
      }

      // Aqui ya no se pinta ninguna lista de conductores: el formulario no
      // recibe la nomina. El nombre se resuelve de a uno contra la cedula que
      // el conductor digita.

      estado.actividades = datos.actividades || [];
      pintarChecklist();

      $("cargando").hidden = true;
      $("formulario").hidden = false;
      $("barra").hidden = false;

      if (!datos.listo) {
        mostrarAviso(
          "La plataforma todavía no está lista para recibir registros: " +
            (datos.faltante || []).join("; ") + ". Avisa al administrador.",
          "info",
        );
        $("enviar").disabled = true;
        return;
      }

      actualizarProgreso();
    } catch (e) {
      $("cargando").hidden = true;
      mostrarAviso(e.message || "No se pudo conectar. Revisa tu señal e intenta de nuevo.");
    }
  }

  // -------------------------------------------------------------------------
  // Checklist
  // -------------------------------------------------------------------------
  // Ningun punto viene premarcado: hay que tocar OK o Falla en cada uno. Un
  // formulario que llegara todo en "OK" se enviaria sin mirar el vehiculo, y
  // eso vaciaria de sentido el registro. Un toque por punto sigue siendo
  // rapido, y el contador de la barra deja claro cuanto falta.

  function pintarChecklist() {
    const cont = $("checklist");
    cont.innerHTML = "";

    if (estado.actividades.length === 0) {
      const p = document.createElement("p");
      p.className = "sub";
      p.textContent = "El catálogo de actividades está vacío. No se puede registrar todavía.";
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

        // Contador por grupo. Con 40 puntos en 9 bloques, "cuanto me falta de
        // este" no se responde contando a ojo.
        const cuenta = document.createElement("span");
        cuenta.className = "grupo-cuenta";
        cuenta.dataset.cuenta = act.grupo;

        cab.append(nombre, cuenta);
        cont.appendChild(cab);
      }

      const tarjeta = document.createElement("div");
      tarjeta.className = "item";
      tarjeta.dataset.grupo = act.grupo || "";

      // El texto y el switch van juntos en una fila propia, y la tarjeta es un
      // grid de una columna. Antes la tarjeta ERA la fila, asi que el campo de
      // observacion entraba como tercera columna y encimaba el texto.
      const fila = document.createElement("div");
      fila.className = "item-fila";

      const texto = document.createElement("div");
      texto.className = "item-texto";
      texto.textContent = act.descripcion;
      texto.id = "act-" + act.id;

      const sw = document.createElement("div");
      sw.className = "switch";
      sw.setAttribute("role", "group");
      sw.setAttribute("aria-labelledby", texto.id);

      for (const [valor, rotulo, glifo] of [["ok", "OK", "✓"], ["mal", "Falla", "!"]]) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.valor = valor;
        b.setAttribute("aria-pressed", "false");
        // El glifo ademas del rotulo: a contraluz se distingue antes una forma
        // que una palabra. Va en un span aparte para poder darle su tamano.
        const g = document.createElement("span");
        g.className = "glifo";
        g.setAttribute("aria-hidden", "true");
        g.textContent = glifo;
        b.append(g, document.createTextNode(rotulo));
        b.addEventListener("click", () => marcar(act.id, valor, sw, tarjeta));
        sw.appendChild(b);
      }

      fila.append(texto, sw);
      tarjeta.appendChild(fila);
      cont.appendChild(tarjeta);
    }

    actualizarProgreso();
  }

  function marcar(id, valor, sw, tarjeta) {
    estado.marcas.set(id, valor);
    for (const b of sw.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.valor === valor));
    }
    // Tiñe la tarjeta entera, no solo el boton: al bajar por la lista se ve de
    // un vistazo que quedo resuelto y que no.
    tarjeta.dataset.estado = valor;

    // Una falla pide decir cual: "algo esta mal" sin detalle no le sirve ni al
    // taller ni al reporte.
    let obs = tarjeta.querySelector(".item-obs");
    if (valor === "mal" && !obs) {
      obs = document.createElement("input");
      obs.type = "text";
      obs.className = "item-obs";
      obs.placeholder = "¿Qué encontraste? (opcional)";
      obs.dataset.obs = String(id);
      tarjeta.appendChild(obs);
    } else if (valor === "ok" && obs) {
      obs.remove();
    }

    actualizarProgreso();
  }

  function actualizarProgreso() {
    const total = estado.actividades.length;
    const hechas = estado.marcas.size;
    const fallas = [...estado.marcas.values()].filter((v) => v === "mal").length;

    // Se arma con nodos, no con innerHTML: las descripciones y los rotulos
    // vienen de la base, y aqui no hace falta interpretar HTML para nada.
    const t = $("progreso-texto");
    t.textContent = "";
    const n = document.createElement("strong");
    n.textContent = String(hechas);
    t.append(n, document.createTextNode(` de ${total} verificados`));
    if (fallas) {
      const f = document.createElement("span");
      f.className = "fallas";
      f.textContent = `${fallas} con falla`;
      t.append(document.createTextNode(" · "), f);
    }

    const lleno = $("progreso-lleno");
    lleno.style.width = total ? `${Math.round((hechas / total) * 100)}%` : "0%";
    // Verde solo al completarse: mientras falte algo sigue siendo azul, para
    // que el color no diga "listo" antes de tiempo.
    if (total > 0 && hechas === total) lleno.dataset.lleno = "si";
    else delete lleno.dataset.lleno;

    // Contadores por grupo.
    for (const chip of document.querySelectorAll("[data-cuenta]")) {
      const grupo = chip.dataset.cuenta;
      const delGrupo = estado.actividades.filter((a) => (a.grupo || "") === grupo);
      const marcadas = delGrupo.filter((a) => estado.marcas.has(a.id)).length;
      chip.textContent = `${marcadas}/${delGrupo.length}`;
      if (delGrupo.length > 0 && marcadas === delGrupo.length) chip.dataset.completo = "si";
      else delete chip.dataset.completo;
    }

    $("enviar").disabled = estado.enviando || total === 0 || hechas < total;
  }

  // -------------------------------------------------------------------------
  // Ayudas de digitacion
  // -------------------------------------------------------------------------

  // El nombre se pide al servidor de a una cedula. La nomina completa ya no
  // baja al navegador: son 298 cedulas con nombre y apellido, dato personal
  // que no tiene por que viajar a un movil para llenar un formulario.
  //
  // Se espera a que deje de escribir en vez de consultar por tecla: una cedula
  // de 10 digitos dispararia cinco consultas inutiles camino de la buena.
  let relojCedula = null;
  let consultaVigente = 0;

  $("cedula").addEventListener("input", (ev) => {
    const cedula = soloDigitos(ev.target.value);
    ev.target.value = cedula;
    const pista = $("pista-conductor");

    clearTimeout(relojCedula);
    // Invalida lo que este en vuelo: si corrigio un digito, la respuesta de la
    // cedula anterior ya no debe escribir nada en el campo del nombre.
    consultaVigente++;

    if (cedula.length < 6) {
      decirPista(pista, "");
      $("nombre").value = "";
      return;
    }

    if (estado.nombresVistos.has(cedula)) {
      aplicarNombre(estado.nombresVistos.get(cedula), pista);
      return;
    }

    decirPista(pista, "Buscando…");
    const mia = consultaVigente;

    relojCedula = setTimeout(async () => {
      // Sin verificar no hay nombre, y sin nombre el servidor rechaza el
      // registro. Asi que estos tres casos no dicen "escribe el nombre": no se
      // puede. Dicen que se siga llenando el checklist, que no se pierde, y
      // que al volver la señal la cedula se resuelve sola.
      if (!window.SICOV.hayConexion()) {
        decirPista(pista, "Sin conexión. Sigue llenando el checklist: al volver la señal se verifica.");
        return;
      }
      try {
        const resp = await fetch(RUTA + "/conductor?cedula=" + encodeURIComponent(cedula));
        const datos = await resp.json();
        if (mia !== consultaVigente) return;

        if (resp.status === 429) {
          decirPista(pista, "Demasiadas consultas desde esta conexión. Espera unos minutos.");
          return;
        }
        const nombre = datos.habilitado ? nombreLimpio(datos.nombre) : null;
        estado.nombresVistos.set(cedula, nombre);
        aplicarNombre(nombre, pista);
      } catch {
        if (mia !== consultaVigente) return;
        decirPista(pista, "No se pudo verificar la cédula. Reintenta en un momento.");
      }
    }, 400);
  });

  /** Un solo sitio donde se escribe la pista, para que la clase no se quede pegada. */
  function decirPista(pista, texto, bien) {
    pista.className = bien ? "pista bien" : "pista";
    pista.textContent = texto;
  }

  /**
   * Instante en hora de Colombia.
   *
   * Se fija la zona en vez de usar la del telefono: el comprobante tiene que
   * decir la misma hora que quedo en el registro y que vera el regulador. Un
   * telefono con la zona mal puesta mostraria otra, y el conductor creeria que
   * se guardo a una hora distinta de la real.
   */
  function fechaHoraCol(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  }

  // El campo del nombre no se escribe a mano: lo llena la nomina o queda
  // vacio. Un conductor inactivo, o que no este en la nomina, no puede
  // alistar, asi que no tiene sentido dejarle teclear un nombre que el
  // servidor va a rechazar de todas formas.
  function aplicarNombre(nombre, pista) {
    if (nombre) {
      $("nombre").value = nombre;
      decirPista(pista, "Conductor encontrado.", true);
    } else {
      $("nombre").value = "";
      decirPista(pista, "Esa cédula no corresponde a un conductor activo. Comunícate con Talento Humano.");
    }
  }

  // Avisa si la placa ya se alisto hoy, antes de que llene el checklist entero.
  $("placa").addEventListener("change", async (ev) => {
    ocultarAviso();
    const placa = ev.target.value;
    if (!placa) return;
    try {
      const resp = await fetch(RUTA + "/hoy?placa=" + encodeURIComponent(placa));
      const datos = await resp.json();
      if (datos.yaRegistrado) {
        // Modal y no una linea de aviso: esto le ahorra llenar 40 puntos para
        // que el servidor se lo rechace al final con un 409. Tiene que verlo.
        const r = datos.registro || {};
        window.SICOV.modal({
          tipo: "aviso",
          titulo: "Este vehículo ya se alistó hoy",
          mensaje:
            "Solo se registra un alistamiento por vehículo y por día. Si hay que corregir algo " +
            "del que ya está, se corrige ese registro; no se crea otro.",
          datos: [
            ["Vehículo", placa],
            ["Lo registró", r.conductor],
            ["Fecha y hora", fechaHoraCol(r.registrado_en)],
          ],
          acciones: [
            {
              texto: "Elegir otro vehículo",
              primario: true,
              alTocar: () => {
                // Se limpia la placa: dejarla elegida invita a seguir llenando
                // un formulario que no se va a poder enviar.
                $("placa").value = "";
                window.SICOV.cerrarModal();
                $("placa").focus();
              },
            },
          ],
        });
      }
    } catch {
      // Es una comprobacion de cortesia y necesita red. Si falla, el servidor
      // lo rechazara al enviar igual: no vale la pena molestar al conductor.
    }
  });

  // -------------------------------------------------------------------------
  // Envio
  // -------------------------------------------------------------------------

  $("enviar").addEventListener("click", async () => {
    ocultarAviso();

    const placa = $("placa").value;
    const cedula = soloDigitos($("cedula").value);
    const nombre = $("nombre").value.trim();

    if (!placa) return mostrarAviso("Selecciona el vehículo.");
    if (cedula.length < 6) return mostrarAviso("Escribe la cédula del conductor.");
    // Sin nombre significa que la cedula no quedo verificada contra la nomina.
    // El servidor lo rechazaria igual con un 403; se corta aqui para no hacerle
    // perder el viaje ni el checklist ya marcado.
    if (!nombre) {
      return mostrarAviso(
        "La cédula no está verificada. Revisa el número: solo un conductor activo de la nómina puede registrar el alistamiento.",
      );
    }
    if (estado.marcas.size < estado.actividades.length) {
      return mostrarAviso("Faltan puntos por verificar.");
    }
    if (!window.SICOV.hayConexion()) {
      // Se corta aqui con el formulario intacto: el conductor recupera señal y
      // vuelve a tocar Registrar sin perder nada.
      return mostrarAviso(
        "Sin conexión. Lo que llenaste sigue aquí: busca señal y vuelve a tocar Registrar.",
      );
    }

    const actividades = estado.actividades.map((act) => {
      const obs = document.querySelector(`[data-obs="${act.id}"]`);
      return {
        id: act.id,
        conforme: estado.marcas.get(act.id) === "ok",
        observacion: obs ? obs.value.trim() : null,
      };
    });

    estado.enviando = true;
    $("enviar").disabled = true;
    $("enviar").textContent = "Enviando…";

    try {
      const resp = await fetch(RUTA + "/registrar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          placa,
          // No se manda el nombre: el servidor lo resuelve contra la nomina y
          // lo que llegue del formulario lo ignora. Mandarlo sugeriria que
          // cuenta para algo.
          conductorCedula: cedula,
          kilometraje: soloDigitos($("kilometraje").value),
          observaciones: $("observaciones").value.trim(),
          actividades,
        }),
      });
      const datos = await resp.json();

      if (!resp.ok || !datos.success) throw new Error(datos.message || "No se pudo registrar.");

      estado.enviado = true;

      const reg = datos.alistamiento || {};
      const conNovedad = reg.estado === "CON_NOVEDAD";
      const fallas = [...estado.marcas.values()].filter((v) => v === "mal").length;
      const interno = estado.internos.get(placa);

      // Se vacia la pantalla detras: si el formulario siguiera ahi, cerrar el
      // modal dejaria a la vista un Registrar que intentaria duplicar el
      // alistamiento del dia.
      const envoltura = document.querySelector(".envoltura");
      envoltura.innerHTML = "";
      const cab = document.createElement("header");
      const h = document.createElement("h1");
      h.textContent = "Alistamiento registrado";
      cab.appendChild(h);
      const p = document.createElement("p");
      p.className = "sub";
      p.textContent = `Placa ${placa} · ${fechaHoraCol(reg.registrado_en)}`;
      cab.appendChild(p);
      envoltura.appendChild(cab);
      $("barra").hidden = true;
      window.scrollTo(0, 0);

      window.SICOV.modal({
        tipo: conNovedad ? "aviso" : "bien",
        titulo: conNovedad ? "Registrado con novedad" : "Alistamiento registrado",
        mensaje: conNovedad
          ? `Quedó guardado, pero con ${fallas} punto(s) marcados como falla. Repórtalo al taller antes de salir.`
          : "Quedó guardado y disponible para el reporte a la Superintendencia.",
        datos: [
          ["Consecutivo", reg.id ? `N° ${reg.id}` : null],
          ["Vehículo", interno ? `${placa} · interno ${interno}` : placa],
          ["Conductor", nombre],
          ["Fecha y hora", fechaHoraCol(reg.registrado_en)],
          ["Puntos verificados", `${estado.marcas.size} de ${estado.actividades.length}`],
          ["Novedades", fallas > 0 ? `${fallas}` : "Ninguna"],
        ],
        acciones: [
          {
            texto: "Registrar otro vehículo",
            primario: true,
            // Recarga en vez de limpiar campos a mano: asi vuelve a pedir la
            // flota y el checklist, y no arrastra nada del anterior.
            alTocar: () => location.reload(),
          },
          { texto: "Cerrar", alTocar: () => window.SICOV.cerrarModal() },
        ],
      });
    } catch (e) {
      estado.enviando = false;
      $("enviar").textContent = "Registrar";
      actualizarProgreso();
      mostrarAviso(e.message || "No se pudo enviar. Revisa tu señal e intenta de nuevo.");
    }
  });

  cargar();
})();
