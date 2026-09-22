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
        const t = document.createElement("div");
        t.className = "grupo-titulo";
        t.textContent = act.grupo;
        cont.appendChild(t);
      }

      const fila = document.createElement("div");
      fila.className = "item";

      const texto = document.createElement("div");
      texto.className = "item-texto";
      texto.textContent = act.descripcion;
      texto.id = "act-" + act.id;

      const sw = document.createElement("div");
      sw.className = "switch";
      sw.setAttribute("role", "group");
      sw.setAttribute("aria-labelledby", texto.id);

      for (const [valor, rotulo] of [["ok", "OK"], ["mal", "Falla"]]) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.valor = valor;
        b.textContent = rotulo;
        b.setAttribute("aria-pressed", "false");
        b.addEventListener("click", () => marcar(act.id, valor, sw, fila));
        sw.appendChild(b);
      }

      fila.append(texto, sw);
      cont.appendChild(fila);
    }
  }

  function marcar(id, valor, sw, fila) {
    estado.marcas.set(id, valor);
    for (const b of sw.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.valor === valor));
    }

    // Una falla pide decir cual: "algo esta mal" sin detalle no le sirve ni al
    // taller ni al reporte.
    let obs = fila.querySelector(".item-obs");
    if (valor === "mal" && !obs) {
      obs = document.createElement("input");
      obs.type = "text";
      obs.className = "item-obs";
      obs.placeholder = "¿Qué encontraste? (opcional)";
      obs.dataset.obs = String(id);
      fila.appendChild(obs);
    } else if (valor === "ok" && obs) {
      obs.remove();
    }

    actualizarProgreso();
  }

  function actualizarProgreso() {
    const total = estado.actividades.length;
    const hechas = estado.marcas.size;
    const fallas = [...estado.marcas.values()].filter((v) => v === "mal").length;

    let txt = `<strong>${hechas}</strong> de ${total} verificados`;
    if (fallas) txt += ` · ${fallas} con falla`;
    $("progreso").innerHTML = txt;

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
      pista.textContent = "";
      return;
    }

    if (estado.nombresVistos.has(cedula)) {
      aplicarNombre(estado.nombresVistos.get(cedula), pista);
      return;
    }

    pista.textContent = "Buscando…";
    const mia = consultaVigente;

    relojCedula = setTimeout(async () => {
      if (!window.SICOV.hayConexion()) {
        pista.textContent = "Sin conexión: escribe el nombre.";
        return;
      }
      try {
        const resp = await fetch(RUTA + "/conductor?cedula=" + encodeURIComponent(cedula));
        const datos = await resp.json();
        if (mia !== consultaVigente) return;

        if (resp.status === 429) {
          pista.textContent = "Demasiadas consultas: escribe el nombre.";
          return;
        }
        const nombre = datos.encontrado ? nombreLimpio(datos.nombre) : null;
        estado.nombresVistos.set(cedula, nombre);
        aplicarNombre(nombre, pista);
      } catch {
        if (mia !== consultaVigente) return;
        // No se bloquea: que la consulta falle no impide alistar, solo obliga
        // a escribir el nombre. El servidor lo valida igual al registrar.
        pista.textContent = "No se pudo verificar: escribe el nombre.";
      }
    }, 400);
  });

  function aplicarNombre(nombre, pista) {
    if (nombre) {
      $("nombre").value = nombre;
      pista.textContent = "Conductor encontrado en la nómina.";
    } else {
      pista.textContent = "No está en la nómina: escribe el nombre.";
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
        mostrarAviso(
          `La placa ${placa} ya tiene alistamiento de hoy` +
            (datos.registro?.conductor ? ` (${datos.registro.conductor})` : "") + ".",
          "info",
        );
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
    if (!nombre) return mostrarAviso("Escribe el nombre del conductor.");
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
          conductorCedula: cedula,
          conductorNombre: nombre,
          kilometraje: soloDigitos($("kilometraje").value),
          observaciones: $("observaciones").value.trim(),
          actividades,
        }),
      });
      const datos = await resp.json();

      if (!resp.ok || !datos.success) throw new Error(datos.message || "No se pudo registrar.");

      estado.enviado = true;

      // Se reemplaza la pantalla: si el formulario siguiera ahi, un segundo
      // toque en Registrar intentaria duplicar el alistamiento del dia.
      const novedad =
        datos.alistamiento?.estado === "CON_NOVEDAD"
          ? " Quedó marcado con novedad: repórtalo al taller."
          : "";

      const envoltura = document.querySelector(".envoltura");
      envoltura.innerHTML = "";

      const cab = document.createElement("header");
      const h = document.createElement("h1");
      h.textContent = "Alistamiento registrado";
      cab.appendChild(h);

      const bien = document.createElement("div");
      bien.className = "aviso bien";
      bien.textContent = `Placa ${placa}, ${nombre}.${novedad}`;

      const panel = document.createElement("div");
      panel.className = "panel";
      const p = document.createElement("p");
      p.className = "sub";
      p.style.margin = "0";
      p.textContent = "Ya puedes cerrar esta página.";
      panel.appendChild(p);

      envoltura.append(cab, bien, panel);
      $("barra").hidden = true;
      window.scrollTo(0, 0);
    } catch (e) {
      estado.enviando = false;
      $("enviar").textContent = "Registrar";
      actualizarProgreso();
      mostrarAviso(e.message || "No se pudo enviar. Revisa tu señal e intenta de nuevo.");
    }
  });

  cargar();
})();
