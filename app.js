/* =====================================================================
 * UvillaDx - Lógica principal de la aplicación
 * UPEC · Carrera de Computación · Sistemas Expertos 2026 B
 *
 * Módulos (en este archivo):
 *   1. Utilidades generales
 *   2. DB         → envoltorio de IndexedDB (diagnósticos, cola, usuarios, config, nube simulada)
 *   3. Auth       → cuentas locales (invitado / registrado) con contraseña hasheada (SHA-256)
 *   4. Modelos    → carga de modelos Teachable Machine (URL o archivos) y persistencia offline
 *   5. Vision     → inferencia con TensorFlow.js o simulador por análisis de color
 *   6. Motor      → sistema experto: reglas de confianza, síntomas, clima y factores de certeza
 *   7. Sync       → cola de sincronización offline → nube
 *   8. UI         → navegación, vistas, flujo de diagnóstico, historial, base de conocimiento
 *   9. Arranque   → registro del Service Worker, eventos de red, instalación PWA
 * ===================================================================== */

'use strict';

/* =====================================================================
 * 1. UTILIDADES
 * ===================================================================== */
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

/** Escapa texto para insertarlo de forma segura en HTML */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Normaliza etiquetas: sin tildes, minúsculas, sin guiones bajos */
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

const pct = (x, d = 0) => `${(x * 100).toFixed(d)} %`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const fechaCorta = (iso) => new Date(iso).toLocaleString('es-EC', { dateStyle: 'medium', timeStyle: 'short' });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Notificación breve en pantalla */
function toast(msg, tipo = 'info') {
  const colores = { info: 'bg-tierra-800', ok: 'bg-hoja-700', error: 'bg-red-600', aviso: 'bg-uvilla-600' };
  const el = document.createElement('div');
  el.className = `${colores[tipo] || colores.info} text-white text-sm px-4 py-3 rounded-xl shadow-lg vista`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

/** Color según el valor de un factor de certeza */
function colorFC(fc) {
  if (fc >= 0.75) return 'bg-hoja-600';
  if (fc >= 0.55) return 'bg-uvilla-500';
  if (fc >= 0) return 'bg-tierra-600';
  return 'bg-red-500';
}

/* =====================================================================
 * 2. DB - IndexedDB
 * ===================================================================== */
const DB = {
  nombre: 'uvilladx',
  version: 1,
  db: null,

  /** Abre la base de datos y crea los almacenes si no existen */
  abrir() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.nombre, this.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('diagnosticos')) {
          const s = db.createObjectStore('diagnosticos', { keyPath: 'id' });
          s.createIndex('usuario', 'usuario');
          s.createIndex('estadoSync', 'estadoSync');
        }
        if (!db.objectStoreNames.contains('cola'))     db.createObjectStore('cola', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('usuarios')) db.createObjectStore('usuarios', { keyPath: 'email' });
        if (!db.objectStoreNames.contains('config'))   db.createObjectStore('config', { keyPath: 'clave' });
        // "nube" simula el servidor remoto cuando no hay un endpoint real configurado
        if (!db.objectStoreNames.contains('nube'))     db.createObjectStore('nube', { keyPath: 'id' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  },

  _tx(store, modo, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, modo);
      const s = tx.objectStore(store);
      const req = fn(s);
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  },

  put(store, valor)   { return this._tx(store, 'readwrite', (s) => s.put(valor)); },
  get(store, clave)   { return this._tx(store, 'readonly',  (s) => s.get(clave)); },
  del(store, clave)   { return this._tx(store, 'readwrite', (s) => s.delete(clave)); },
  todos(store)        { return this._tx(store, 'readonly',  (s) => s.getAll()); },

  async getConfig(clave, defecto = null) {
    const r = await this.get('config', clave);
    return r ? r.valor : defecto;
  },
  setConfig(clave, valor) { return this.put('config', { clave, valor }); }
};

/* =====================================================================
 * 3. AUTH - cuentas locales simuladas
 * ===================================================================== */
const Auth = {
  usuario: null, // null = invitado

  /** Hash SHA-256 con sal (si el contexto no es seguro, usa un hash simple de respaldo) */
  async hash(texto, sal) {
    const datos = new TextEncoder().encode(`${sal}:${texto}`);
    if (crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', datos);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 0; for (const b of datos) h = (h * 31 + b) | 0; return `fallback-${h}`;
  },

  async restaurar() {
    const email = await DB.getConfig('sesion');
    if (email) this.usuario = (await DB.get('usuarios', email)) || null;
  },

  async registrar({ nombre, email, password, institucion }) {
    email = email.trim().toLowerCase();
    if (!nombre.trim() || !email || password.length < 6) throw new Error('Complete nombre, correo y una contraseña de al menos 6 caracteres.');
    if (await DB.get('usuarios', email)) throw new Error('Ya existe una cuenta con ese correo.');
    const sal = uid();
    const usuario = { email, nombre: nombre.trim(), institucion: institucion?.trim() || '', sal, hash: await this.hash(password, sal), creado: new Date().toISOString() };
    await DB.put('usuarios', usuario);
    await this._iniciar(usuario);
    return usuario;
  },

  async ingresar(email, password) {
    email = email.trim().toLowerCase();
    const u = await DB.get('usuarios', email);
    if (!u || u.hash !== await this.hash(password, u.sal)) throw new Error('Correo o contraseña incorrectos.');
    await this._iniciar(u);
    return u;
  },

  async _iniciar(u) {
    this.usuario = u;
    await DB.setConfig('sesion', u.email);
  },

  async salir() {
    this.usuario = null;
    await DB.setConfig('sesion', null);
  },

  get id() { return this.usuario ? this.usuario.email : 'invitado'; },
  get esInvitado() { return !this.usuario; }
};

/* =====================================================================
 * 4. MODELOS - Teachable Machine
 * ===================================================================== */
const Modelos = {
  // organo → { modelo (tf.LayersModel), etiquetas [], mapeo [], fuente, fecha }
  cargados: {},

  claveIDB: (organo) => `indexeddb://uvilladx-modelo-${organo}`,

  tfDisponible() { return typeof window.tf !== 'undefined'; },

  /** Relaciona cada etiqueta del modelo con una clase de la base de conocimiento */
  mapearEtiquetas(organo, etiquetas) {
    const clases = App.kb.organos[organo].clases;
    const ajenas = App.kb.parametros.clasesAjenas.map(norm);
    return etiquetas.map((et) => {
      const n = norm(et);
      if (ajenas.includes(n)) return '__ajena__';
      for (const c of clases) {
        const enf = App.kb.enfermedades[c.id];
        const alias = [c.etiqueta, c.id, enf.nombre];
        if (c.id === 'sano') alias.push('sano', 'sana', 'saludable', `${organo} sano`, `${organo} sana`);
        if (alias.map(norm).includes(n)) return c.id;
      }
      // Coincidencia parcial (p. ej. "Mancha gris hoja")
      const parcial = clases.find((c) => c.id !== 'sano' && n.includes(norm(c.etiqueta)));
      if (parcial) return parcial.id;
      if (/\bsan[oa]\b/.test(n)) return 'sano';
      return null; // etiqueta desconocida
    });
  },

  /** Restaura desde IndexedDB los modelos guardados (funciona sin conexión) */
  async restaurar() {
    if (!this.tfDisponible()) return;
    for (const organo of Object.keys(App.kb.organos)) {
      const meta = await DB.getConfig(`modelo-${organo}`);
      if (!meta) continue;
      try {
        const modelo = await tf.loadLayersModel(this.claveIDB(organo));
        this.cargados[organo] = { ...meta, modelo, mapeo: this.mapearEtiquetas(organo, meta.etiquetas) };
      } catch (e) {
        console.warn('No se pudo restaurar el modelo de', organo, e);
      }
    }
  },

  /** Carga desde un enlace de Teachable Machine o una carpeta con model.json */
  async desdeURL(organo, url) {
    if (!this.tfDisponible()) throw new Error('TensorFlow.js no está disponible (¿sin conexión en la primera carga?).');
    url = url.trim();
    if (!/model\.json$/i.test(url)) url = url.replace(/\/?$/, '/') + 'model.json';
    const base = url.replace(/model\.json$/i, '');
    const modelo = await tf.loadLayersModel(url);
    const meta = await fetch(base + 'metadata.json').then((r) => r.json());
    return this._registrar(organo, modelo, meta.labels, `URL: ${base}`);
  },

  /** Carga desde los archivos descargados (model.json, weights.bin, metadata.json) */
  async desdeArchivos(organo, archivos) {
    if (!this.tfDisponible()) throw new Error('TensorFlow.js no está disponible.');
    const lista = [...archivos];
    const json = lista.find((f) => /model\.json$/i.test(f.name)) || lista.find((f) => f.name.endsWith('.json') && !/metadata/i.test(f.name));
    const metaF = lista.find((f) => /metadata\.json$/i.test(f.name));
    const pesos = lista.filter((f) => f.name.endsWith('.bin'));
    if (!json || !metaF || !pesos.length) throw new Error('Seleccione model.json, metadata.json y el/los archivo(s) .bin.');
    const meta = JSON.parse(await metaF.text());
    const modelo = await tf.loadLayersModel(tf.io.browserFiles([json, ...pesos]));
    return this._registrar(organo, modelo, meta.labels, `Archivos: ${json.name}`);
  },

  async _registrar(organo, modelo, etiquetas, fuente) {
    if (!Array.isArray(etiquetas) || !etiquetas.length) throw new Error('metadata.json no contiene etiquetas (labels).');
    const forma = modelo.outputs[0].shape;
    if (forma[forma.length - 1] !== etiquetas.length) throw new Error('El número de salidas del modelo no coincide con las etiquetas.');
    // Persistencia offline del modelo en IndexedDB
    await modelo.save(this.claveIDB(organo));
    const meta = { etiquetas, fuente, fecha: new Date().toISOString() };
    await DB.setConfig(`modelo-${organo}`, meta);
    const mapeo = this.mapearEtiquetas(organo, etiquetas);
    this.cargados[organo] = { ...meta, modelo, mapeo };
    return this.cargados[organo];
  },

  async eliminar(organo) {
    try { await tf.io.removeModel(this.claveIDB(organo)); } catch { /* no existía */ }
    await DB.setConfig(`modelo-${organo}`, null);
    delete this.cargados[organo];
  }
};

/* =====================================================================
 * 5. VISION - inferencia (TensorFlow.js o simulador)
 * ===================================================================== */
const Vision = {
  /** Convierte RGB a HSV (h en grados 0-360, s y v en 0-1) */
  hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, max ? d / max : 0, max];
  },

  /** Estadísticas de color de la imagen (usadas para validar el órgano y por el simulador) */
  analizarColor(img) {
    const N = 96;
    const c = document.createElement('canvas'); c.width = c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    const px = ctx.getImageData(0, 0, N, N).data;
    const cuenta = { verde: 0, amarillo: 0, marron: 0, blanco: 0, gris: 0, oscuro: 0, otro: 0 };
    let semilla = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [h, s, v] = this.hsv(px[i], px[i + 1], px[i + 2]);
      semilla = (semilla * 31 + px[i] + px[i + 1] * 7 + px[i + 2] * 13) >>> 0;
      if (v < 0.18) cuenta.oscuro++;
      else if (s < 0.15 && v > 0.78) cuenta.blanco++;
      else if (s < 0.15) cuenta.gris++;
      else if (h >= 65 && h <= 170 && s > 0.18) cuenta.verde++;
      else if (h >= 20 && h < 65 && s > 0.35 && v > 0.45) cuenta.amarillo++;
      else if (h < 45 && v <= 0.6) cuenta.marron++;
      else cuenta.otro++;
    }
    const total = N * N;
    const f = Object.fromEntries(Object.entries(cuenta).map(([k, v]) => [k, v / total]));
    // Índice vegetal: fracción de píxeles compatibles con tejido vegetal sano o enfermo
    f.indiceVegetal = Math.min(1, f.verde + f.amarillo + f.marron + 0.5 * f.blanco + 0.3 * f.gris + 0.2 * f.oscuro);
    f.semilla = semilla;
    return f;
  },

  softmax(v, t = 1) {
    const m = Math.max(...v);
    const e = v.map((x) => Math.exp((x - m) * t));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  },

  /**
   * SIMULADOR: genera probabilidades plausibles a partir del color.
   * Solo para demostraciones cuando no hay modelo entrenado.
   */
  simular(organo, color) {
    const clases = App.kb.organos[organo].clases;
    const { verde, amarillo, marron, blanco, gris, oscuro } = color;
    const tejidoSano = organo === 'frutos' ? amarillo : verde;
    const lesion = marron + oscuro + blanco + gris;
    const pesos = {
      sano:                tejidoSano * 2.2 - lesion * 2.5,
      mancha_gris:         gris * 3.2 + marron * 0.8,
      muerte_descendente:  marron * 1.8 + oscuro * 2.2,
      esclerotiniosis:     blanco * 2.4 + oscuro * 1.6,
      moho_blanco:         blanco * 3.0 + gris * 0.4,
      pudricion_dura:      marron * 2.6 + oscuro * 0.6,
      mancha_grasienta:    oscuro * 1.4 + amarillo * (organo === 'hojas' ? 1.2 : 0.3) + marron * 0.5,
      marchitez_bacterial: amarillo * 1.6 + marron * 1.0 - verde * 0.5
    };
    // Ruido determinista (misma imagen → mismo resultado)
    let s = color.semilla || 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const puntajes = clases.map((c) => (pesos[c.id] ?? 0) + rnd() * 0.35);
    const probs = this.softmax(puntajes, 4);
    return clases.map((c, i) => ({ claseId: c.id, etiqueta: c.etiqueta, p: probs[i] }));
  },

  /** Inferencia con el modelo real de Teachable Machine (224×224, normalizado a [-1, 1]) */
  async predecirModelo(organo, img) {
    const m = Modelos.cargados[organo];
    const lado = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas'); c.width = c.height = 224;
    c.getContext('2d').drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, 224, 224);
    const salida = tf.tidy(() => {
      const t = tf.browser.fromPixels(c).toFloat().div(127.5).sub(1).expandDims(0);
      return m.modelo.predict(t);
    });
    const valores = await salida.data();
    salida.dispose();
    return m.etiquetas.map((et, i) => ({
      claseId: m.mapeo[i],
      etiqueta: m.mapeo[i] && m.mapeo[i] !== '__ajena__' ? App.kb.organos[organo].clases.find((c) => c.id === m.mapeo[i]).etiqueta : et,
      p: valores[i]
    }));
  },

  /** Punto de entrada: devuelve la predicción ordenada y metadatos */
  async predecir(organo, img) {
    const color = this.analizarColor(img);
    let probs, fuente;
    if (Modelos.cargados[organo] && Modelos.tfDisponible()) {
      probs = await this.predecirModelo(organo, img);
      fuente = 'modelo';
    } else {
      probs = this.simular(organo, color);
      fuente = 'simulador';
    }
    probs.sort((a, b) => b.p - a.p);
    return { probs, fuente, indiceVegetal: color.indiceVegetal, color };
  }
};

/* =====================================================================
 * 6. MOTOR - Sistema experto con factores de certeza
 * ===================================================================== */
const Motor = {
  /**
   * Combinación de factores de certeza (modelo MYCIN).
   * Ambos positivos:  FC = FC1 + FC2 × (1 − FC1)   ← fórmula del proyecto
   * Ambos negativos:  FC = FC1 + FC2 × (1 + FC1)
   * Signos opuestos:  FC = (FC1 + FC2) / (1 − min(|FC1|, |FC2|))
   */
  combinar(fc1, fc2) {
    if (fc1 >= 0 && fc2 >= 0) return fc1 + fc2 * (1 - fc1);
    if (fc1 < 0 && fc2 < 0) return fc1 + fc2 * (1 + fc1);
    const den = 1 - Math.min(Math.abs(fc1), Math.abs(fc2));
    return den === 0 ? 0 : (fc1 + fc2) / den;
  },

  /** Reglas de control de confianza (RC-01 … RC-05) */
  evaluarConfianza(pred) {
    const P = App.kb.parametros;
    const R = Object.fromEntries(App.kb.reglas.confianza.map((r) => [r.id, r]));
    const disparadas = [];
    const validas = pred.probs.filter((x) => x.claseId && x.claseId !== '__ajena__');
    const top = pred.probs[0];
    const top1 = validas[0], top2 = validas[1];

    // RC-01: imagen ajena (clase "Fondo/Otro" del modelo o índice vegetal bajo)
    if (top.claseId === '__ajena__' || pred.indiceVegetal < P.umbralIndiceVegetal) {
      disparadas.push({ ...R['RC-01'], detalle: top.claseId === '__ajena__'
        ? `El modelo clasificó la imagen como "${top.etiqueta}" (${pct(top.p)}).`
        : `Índice vegetal ${pct(pred.indiceVegetal)} < ${pct(P.umbralIndiceVegetal)}.` });
      return { accion: 'RECHAZAR_AJENA', disparadas };
    }
    if (!top1) return { accion: 'RECHAZAR_AJENA', disparadas: [{ ...R['RC-01'], detalle: 'Ninguna etiqueta del modelo coincide con la base de conocimiento.' }] };

    // RC-02: confianza insuficiente
    if (top1.p < P.umbralRechazo) {
      disparadas.push({ ...R['RC-02'], detalle: `Confianza máxima ${pct(top1.p, 1)} < ${pct(P.umbralRechazo)}.` });
      return { accion: 'RECHAZAR_CONFIANZA', disparadas };
    }

    let accion = 'CONCLUIR';
    // RC-03: zona de reevaluación
    if (top1.p < P.umbralReevaluacion) {
      disparadas.push({ ...R['RC-03'], detalle: `Confianza ${pct(top1.p, 1)} entre ${pct(P.umbralRechazo)} y ${pct(P.umbralReevaluacion)}.` });
      accion = 'REEVALUAR';
    }
    // RC-04: empate entre las dos primeras clases
    if (top2 && top1.p - top2.p < P.margenDesempate) {
      disparadas.push({ ...R['RC-04'], detalle: `${top1.etiqueta} (${pct(top1.p, 1)}) vs ${top2.etiqueta} (${pct(top2.p, 1)}): diferencia ${pct(top1.p - top2.p, 1)}.` });
      accion = 'DESEMPATAR';
    }
    // RC-05: órgano sano con confianza alta
    if (accion === 'CONCLUIR' && top1.claseId === 'sano') {
      disparadas.push({ ...R['RC-05'], detalle: `Clase sana con ${pct(top1.p, 1)}.` });
      accion = 'SANO';
    }
    return { accion, disparadas };
  },

  /** Clases candidatas: top-3 o con probabilidad ≥ 10 % */
  candidatos(pred) {
    const validas = pred.probs.filter((x) => x.claseId && x.claseId !== '__ajena__');
    return validas.filter((x, i) => i < 3 || x.p >= 0.10);
  },

  /** Preguntas de síntomas relevantes para el órgano y las enfermedades candidatas */
  preguntasRelevantes(organo, candidatos) {
    const ids = candidatos.map((c) => c.claseId).filter((id) => id !== 'sano');
    // Si "sano" encabeza con dudas, se pregunta por las enfermedades más próximas
    return App.kb.preguntas.filter((q) => q.organos.includes(organo) && q.enfermedades.some((e) => ids.includes(e)));
  },

  /** Reglas climáticas RK-01 … RK-04 para una enfermedad */
  evaluarClima(enfId, temp, hr) {
    const enf = App.kb.enfermedades[enfId];
    const rk = Object.fromEntries(App.kb.reglas.climaticas.map((r) => [r.id, r]));
    if (!enf || !enf.clima) return null;
    const c = enf.clima;
    if (temp >= c.tOptMin && temp <= c.tOptMax && hr >= c.hrMin) return rk['RK-01'];
    if (temp < c.tMin || temp > c.tMax || hr < c.hrMin - 20) return rk['RK-03'];
    if (hr >= c.hrMin - 10) return rk['RK-02'];
    return rk['RK-04'];
  },

  /**
   * Inferencia completa: parte del FC del modelo visual (FC1) y lo combina
   * con cada evidencia de síntomas y clima mediante la fórmula de certeza.
   */
  concluir(pred, respuestas, clima, organo) {
    const P = App.kb.parametros;
    const candidatos = this.candidatos(pred);
    const respuestasPositivas = Object.values(respuestas).some((v) => v && v !== 'no' && v !== 'ns');

    const ranking = candidatos.map((c) => {
      const traza = [];
      // FC inicial = confianza del modelo (limitado para dejar margen a la evidencia)
      let fc = Math.min(c.p, 0.95);
      traza.push({ regla: 'ML', descripcion: `Modelo visual (${pred.fuente})`, aporte: fc, fc });

      // Reglas de síntomas (RS-xx) disparadas por las respuestas del usuario
      for (const r of App.kb.reglas.sintomas) {
        if (respuestas[r.si.pregunta] !== r.si.valor) continue;
        for (const e of r.entonces) {
          if (e.enfermedad !== c.claseId) continue;
          const antes = fc;
          fc = this.combinar(fc, e.fc);
          traza.push({ regla: r.id, descripcion: r.explicacion, aporte: e.fc, antes, fc });
        }
      }
      // Regla implícita: si se reportan síntomas, se penaliza la clase "sano"
      if (c.claseId === 'sano' && respuestasPositivas) {
        const antes = fc;
        fc = this.combinar(fc, -0.5);
        traza.push({ regla: 'RS-00', descripcion: 'Se reportaron síntomas visibles: se reduce la certeza de órgano sano.', aporte: -0.5, antes, fc });
      }
      // Reglas climáticas
      if (clima.aplicar && c.claseId !== 'sano') {
        const rk = this.evaluarClima(c.claseId, clima.temp, clima.hr);
        if (rk && rk.fc !== 0) {
          const antes = fc;
          fc = this.combinar(fc, rk.fc);
          traza.push({ regla: rk.id, descripcion: `${rk.entonces} (${clima.temp} °C, ${clima.hr} % HR)`, aporte: rk.fc, antes, fc });
        } else if (rk) {
          traza.push({ regla: rk.id, descripcion: `${rk.entonces} (${clima.temp} °C, ${clima.hr} % HR)`, aporte: 0, antes: fc, fc });
        }
      }
      return { claseId: c.claseId, etiqueta: c.etiqueta, pModelo: c.p, fc: Math.max(-1, Math.min(1, fc)), traza };
    }).sort((a, b) => b.fc - a.fc);

    const mejor = ranking[0];
    let estado;
    if (mejor.claseId === 'sano' && mejor.fc >= P.umbralDiagnosticoProbable) estado = 'sano';
    else if (mejor.fc >= P.umbralDiagnosticoConfirmado) estado = 'confirmado';
    else if (mejor.fc >= P.umbralDiagnosticoProbable) estado = 'probable';
    else estado = 'no_concluyente';

    const enf = App.kb.enfermedades[mejor.claseId];
    return {
      claseId: mejor.claseId,
      nombre: mejor.claseId === 'sano' ? App.kb.organos[organo].clases.find((c) => c.id === 'sano').etiqueta : enf.nombre,
      fc: mejor.fc,
      estado,
      ranking
    };
  }
};

/* =====================================================================
 * 7. SYNC - cola offline → nube
 * ===================================================================== */
const Sync = {
  enCurso: false,

  /** Guarda un diagnóstico y, si el usuario está registrado, lo encola */
  async guardar(diag) {
    diag.usuario = Auth.id;
    diag.estadoSync = Auth.esInvitado ? 'local' : 'pendiente';
    await DB.put('diagnosticos', diag);
    if (!Auth.esInvitado) {
      await DB.put('cola', { id: diag.id, intentos: 0, creado: new Date().toISOString() });
      if (navigator.onLine) this.sincronizar();
      else this.registrarBackgroundSync();
    }
    UI.actualizarBadgeCola();
  },

  async registrarBackgroundSync() {
    try {
      const reg = await navigator.serviceWorker?.ready;
      if (reg && 'sync' in reg) await reg.sync.register('sync-diagnosticos');
    } catch { /* no soportado: se sincroniza con el evento "online" */ }
  },

  /** Envía un diagnóstico al servidor (endpoint real o nube simulada) */
  async enviar(diag) {
    const api = await DB.getConfig('apiUrl', '');
    if (api) {
      const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(diag) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } else {
      await dormir(250); // latencia simulada
      await DB.put('nube', { ...diag, recibido: new Date().toISOString() });
    }
  },

  /** Vacía la cola de sincronización */
  async sincronizar({ silencioso = false } = {}) {
    if (this.enCurso || !navigator.onLine || Auth.esInvitado) return;
    this.enCurso = true;
    let ok = 0, fallos = 0;
    try {
      const cola = await DB.todos('cola');
      for (const item of cola) {
        const diag = await DB.get('diagnosticos', item.id);
        if (!diag) { await DB.del('cola', item.id); continue; }
        try {
          await this.enviar({ ...diag, estadoSync: 'sincronizado' });
          diag.estadoSync = 'sincronizado';
          diag.sincronizado = new Date().toISOString();
          await DB.put('diagnosticos', diag);
          await DB.del('cola', item.id);
          ok++;
        } catch (e) {
          fallos++;
          await DB.put('cola', { ...item, intentos: item.intentos + 1, error: String(e) });
        }
      }
    } finally {
      this.enCurso = false;
    }
    if (!silencioso && (ok || fallos)) toast(fallos ? `Sincronizados ${ok}, con error ${fallos}.` : `☁️ ${ok} diagnóstico(s) sincronizado(s).`, fallos ? 'aviso' : 'ok');
    UI.actualizarBadgeCola();
    if (App.vista === 'historial') UI.renderHistorial();
    if (App.vista === 'dashboard') UI.renderDashboard();
  },

  /** Al iniciar sesión, descarga los diagnósticos del usuario que estén en la nube simulada */
  async descargar() {
    if (Auth.esInvitado) return;
    const api = await DB.getConfig('apiUrl', '');
    if (api) return; // con endpoint real, la descarga depende del backend
    const remotos = (await DB.todos('nube')).filter((d) => d.usuario === Auth.id);
    for (const d of remotos) {
      if (!(await DB.get('diagnosticos', d.id))) await DB.put('diagnosticos', { ...d, estadoSync: 'sincronizado' });
    }
  },

  /** Pasa los diagnósticos de invitado a la cuenta actual */
  async migrarInvitado() {
    const locales = (await DB.todos('diagnosticos')).filter((d) => d.usuario === 'invitado');
    for (const d of locales) {
      d.usuario = Auth.id; d.estadoSync = 'pendiente';
      await DB.put('diagnosticos', d);
      await DB.put('cola', { id: d.id, intentos: 0, creado: new Date().toISOString() });
    }
    await this.sincronizar();
    return locales.length;
  }
};

/* =====================================================================
 * 8. UI
 * ===================================================================== */
const App = {
  kb: null,
  vista: 'dashboard',
  organo: 'hojas',
  imagen: null,      // HTMLImageElement
  imagenURL: null,   // dataURL comprimido para guardar
  diagId: null,      // id del diagnóstico en curso (para refinarlo sin duplicar)
  pred: null,
  control: null,
  kbTab: 'enfermedades'
};

const UI = {
  /* ---------- Navegación ---------- */
  ir(vista) {
    App.vista = vista;
    $$('main > section').forEach((s) => s.classList.toggle('hidden', s.id !== `vista-${vista}`));
    $$('.nav-btn').forEach((b) => {
      const activo = b.dataset.ir === vista;
      b.classList.toggle('bg-hoja-100', activo && b.closest('#nav-lateral'));
      b.classList.toggle('text-hoja-800', activo);
      b.classList.toggle('font-semibold', activo);
      b.classList.toggle('text-tierra-600', !activo && !!b.closest('#nav-inferior'));
    });
    const render = { dashboard: this.renderDashboard, historial: this.renderHistorial, conocimiento: this.renderKB, modelos: this.renderModelos, cuenta: this.renderCuenta, diagnostico: this.renderSelectorOrgano };
    render[vista]?.call(this);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    history.replaceState(null, '', `#${vista}`);
  },

  /* ---------- Cabecera ---------- */
  actualizarRed() {
    const on = navigator.onLine;
    $('#estado-red').innerHTML = `<span class="w-2 h-2 rounded-full ${on ? 'bg-lime-300' : 'bg-red-400'}"></span><span>${on ? 'En línea' : 'Sin conexión'}</span>`;
    $('#estado-red').className = `text-xs px-2 py-1 rounded-full flex items-center gap-1 ${on ? 'bg-hoja-600' : 'bg-red-700'}`;
  },

  async actualizarBadgeCola() {
    const n = (await DB.todos('cola')).length;
    const b = $('#badge-cola');
    b.textContent = `⏳ ${n}`;
    b.classList.toggle('hidden', n === 0);
  },

  actualizarPerfil() {
    const nombre = Auth.esInvitado ? 'Invitado' : Auth.usuario.nombre.split(' ')[0];
    $('#nombre-perfil').textContent = nombre;
    $('#saludo-nombre').textContent = Auth.esInvitado ? 'Invitado (modo offline)' : Auth.usuario.nombre;
  },

  /* ---------- Panel ---------- */
  async renderDashboard() {
    const diags = (await DB.todos('diagnosticos')).filter((d) => d.usuario === Auth.id);
    const enfermos = diags.filter((d) => d.resultado && d.resultado.claseId !== 'sano' && d.resultado.estado !== 'no_concluyente');
    const sanos = diags.filter((d) => d.resultado?.claseId === 'sano');
    const pendientes = diags.filter((d) => d.estadoSync === 'pendiente').length;
    const kpi = (titulo, valor, sub, icono) => `
      <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100">
        <div class="text-xs text-tierra-600 flex items-center gap-1">${icono} ${titulo}</div>
        <div class="text-2xl font-semibold mt-1">${valor}</div>
        <div class="text-[11px] text-tierra-600">${sub}</div>
      </div>`;
    $('#kpis').innerHTML =
      kpi('Diagnósticos', diags.length, 'en este perfil', '🔬') +
      kpi('Con enfermedad', enfermos.length, 'confirmados o probables', '⚠️') +
      kpi('Órganos sanos', sanos.length, 'sin síntomas', '✅') +
      kpi('Por sincronizar', pendientes, Auth.esInvitado ? 'modo invitado: solo local' : 'en cola offline', '☁️');

    // Conteo por enfermedad (barras simples)
    const conteo = {};
    enfermos.forEach((d) => { conteo[d.resultado.nombre] = (conteo[d.resultado.nombre] || 0) + 1; });
    const max = Math.max(1, ...Object.values(conteo));
    $('#grafico-enfermedades').innerHTML = Object.keys(conteo).length
      ? Object.entries(conteo).sort((a, b) => b[1] - a[1]).map(([n, v]) => `
        <div>
          <div class="flex justify-between"><span>${esc(n)}</span><span class="font-medium">${v}</span></div>
          <div class="h-2 bg-hoja-50 rounded-full"><div class="h-2 rounded-full bg-uvilla-500 barra-fc" style="width:${(v / max) * 100}%"></div></div>
        </div>`).join('')
      : '<p class="text-tierra-600">Aún no hay diagnósticos con enfermedad.</p>';

    const ultimos = diags.sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 5);
    $('#ultimos-diagnosticos').innerHTML = ultimos.length
      ? ultimos.map((d) => `
        <button data-detalle="${d.id}" class="w-full flex items-center gap-3 py-2 text-left hover:bg-hoja-50 rounded-lg">
          <img src="${d.imagen}" alt="" class="w-10 h-10 rounded-lg object-cover" />
          <div class="min-w-0 flex-1">
            <div class="font-medium truncate">${esc(d.resultado?.nombre || 'Rechazado')}</div>
            <div class="text-[11px] text-tierra-600">${App.kb.organos[d.organo].nombre} · ${fechaCorta(d.fecha)}</div>
          </div>
          ${this.chipSync(d.estadoSync)}
        </button>`).join('')
      : '<p class="text-tierra-600 py-2">Sin diagnósticos todavía.</p>';

    const modelosCargados = Object.keys(Modelos.cargados).length;
    const swActivo = !!navigator.serviceWorker?.controller;
    const item = (t, v, ok) => `<div class="p-3 rounded-xl ${ok ? 'bg-hoja-50 text-hoja-800' : 'bg-uvilla-50 text-uvilla-700'}"><div class="text-[11px]">${t}</div><div class="font-medium">${v}</div></div>`;
    $('#estado-sistema').innerHTML =
      item('Modelos de visión', modelosCargados ? `${modelosCargados}/3 cargados` : 'Simulador activo', modelosCargados === 3) +
      item('Modo offline', swActivo ? 'Service Worker activo' : 'Pendiente (recargue)', swActivo) +
      item('Base de conocimiento', `${Object.keys(App.kb.enfermedades).length - 1} enfermedades · ${App.kb.reglas.sintomas.length + App.kb.reglas.confianza.length + App.kb.reglas.climaticas.length} reglas`, true);
  },

  chipSync(estado) {
    const m = { sincronizado: ['☁️ Sincronizado', 'bg-hoja-100 text-hoja-800'], pendiente: ['⏳ Pendiente', 'bg-uvilla-100 text-uvilla-700'], local: ['📱 Local', 'bg-tierra-100 text-tierra-600'] };
    const [t, c] = m[estado] || m.local;
    return `<span class="text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ${c}">${t}</span>`;
  },

  /* ---------- Diagnóstico: selección de órgano ---------- */
  renderSelectorOrgano() {
    $('#selector-organo').innerHTML = Object.entries(App.kb.organos).map(([id, o]) => `
      <button data-organo="${id}" class="rounded-xl border-2 p-3 text-center transition ${App.organo === id ? 'border-hoja-700 bg-hoja-50' : 'border-tierra-100 hover:border-hoja-300'}">
        <div class="text-3xl">${o.icono}</div>
        <div class="font-medium text-sm mt-1">${o.nombre}</div>
        <div class="text-[11px] text-tierra-600">${o.clases.length} clases · ${Modelos.cargados[id] ? '🧠 modelo' : '🧪 simulador'}</div>
      </button>`).join('');
    const o = App.kb.organos[App.organo];
    $('#info-organo').innerHTML = `<b>${o.icono} ${o.nombre}:</b> ${esc(o.descripcion)}<br><span class="text-[11px]">Clases: ${o.clases.map((c) => c.etiqueta).join(', ')}.</span>`;
  },

  /* ---------- Diagnóstico: imagen ---------- */
  async cargarImagen(file) {
    if (!file || !file.type.startsWith('image/')) return toast('Seleccione un archivo de imagen válido.', 'error');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      App.imagen = img;
      // Copia comprimida (máx. 480 px) para guardar en IndexedDB
      const esc_ = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * esc_); c.height = Math.round(img.naturalHeight * esc_);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      App.imagenURL = c.toDataURL('image/jpeg', 0.75);
      $('#preview-imagen').src = url;
      $('#preview-imagen').classList.remove('hidden');
      $('#placeholder-imagen').classList.add('hidden');
      $('#btn-analizar').disabled = false;
      $('#panel-resultado').classList.add('hidden');
    };
    img.onerror = () => toast('No se pudo leer la imagen.', 'error');
    img.src = url;
  },

  leerClima() {
    return { temp: parseFloat($('#temp').value), hr: parseFloat($('#hr').value), aplicar: $('#usar-clima').checked };
  },

  /* ---------- Diagnóstico: análisis ---------- */
  async analizar() {
    if (!App.imagen) return;
    const btn = $('#btn-analizar');
    btn.disabled = true; btn.textContent = '⏳ Analizando…';
    try {
      App.diagId = null; // nuevo análisis → nuevo registro
      App.pred = await Vision.predecir(App.organo, App.imagen);
      App.control = Motor.evaluarConfianza(App.pred);
      const panel = $('#panel-resultado');
      panel.classList.remove('hidden');
      const { accion } = App.control;

      if (accion === 'RECHAZAR_AJENA' || accion === 'RECHAZAR_CONFIANZA') {
        panel.innerHTML = this.htmlPrediccion() + this.htmlRechazo(accion);
      } else if (accion === 'REEVALUAR' || accion === 'DESEMPATAR') {
        const preguntas = Motor.preguntasRelevantes(App.organo, Motor.candidatos(App.pred));
        if (preguntas.length) panel.innerHTML = this.htmlPrediccion() + this.htmlPreguntas(preguntas, true);
        else await this.finalizar({});
      } else {
        await this.finalizar({});
      }
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      console.error(e);
      toast(`Error en el análisis: ${e.message}`, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '🔬 Analizar con el sistema híbrido';
    }
  },

  htmlPrediccion() {
    const { pred, control } = App;
    const filas = pred.probs.slice(0, 5).map((x) => `
      <div>
        <div class="flex justify-between text-sm"><span>${esc(x.etiqueta)}${x.claseId === '__ajena__' ? ' <span class="text-[10px] text-red-600">(ajena)</span>' : ''}${!x.claseId ? ' <span class="text-[10px] text-tierra-600">(sin mapear)</span>' : ''}</span><span class="font-mono">${pct(x.p, 1)}</span></div>
        <div class="h-2 bg-tierra-100 rounded-full"><div class="h-2 rounded-full barra-fc ${x.p >= 0.5 ? 'bg-hoja-600' : 'bg-tierra-600'}" style="width:${x.p * 100}%"></div></div>
      </div>`).join('');
    const reglas = control.disparadas.map((r) => `
      <li class="flex gap-2"><span class="font-mono text-[11px] px-1.5 py-0.5 rounded bg-hoja-100 text-hoja-800 h-fit">${r.id}</span>
      <span><b>SI</b> ${esc(r.si)} <b>ENTONCES</b> ${esc(r.entonces)}<br><span class="text-[11px] text-tierra-600">${esc(r.detalle || '')}</span></span></li>`).join('');
    return `
      <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100">
        <div class="flex items-center gap-2 mb-3">
          <h3 class="font-semibold">Etapa 1 · Modelo de visión</h3>
          <span class="ml-auto text-[11px] px-2 py-0.5 rounded-full ${pred.fuente === 'modelo' ? 'bg-hoja-100 text-hoja-800' : 'bg-uvilla-100 text-uvilla-700'}">${pred.fuente === 'modelo' ? '🧠 Teachable Machine' : '🧪 Simulador'}</span>
        </div>
        <div class="grid sm:grid-cols-[120px_1fr] gap-4">
          <img src="${App.imagenURL}" alt="" class="w-28 h-28 rounded-xl object-cover" />
          <div class="space-y-2">${filas}
            <p class="text-[11px] text-tierra-600">Índice vegetal de la imagen: ${pct(pred.indiceVegetal)}</p>
          </div>
        </div>
        ${reglas ? `<div class="mt-4"><h4 class="text-sm font-semibold mb-2">Reglas de control disparadas</h4><ul class="space-y-2 text-sm">${reglas}</ul></div>` : ''}
      </div>`;
  },

  htmlRechazo(accion) {
    const ajena = accion === 'RECHAZAR_AJENA';
    return `
      <div class="rounded-2xl p-5 border-2 ${ajena ? 'border-red-300 bg-red-50' : 'border-uvilla-300 bg-uvilla-50'}">
        <h3 class="font-semibold text-lg">${ajena ? '🚫 Imagen no válida para este órgano' : '⚠️ Confianza insuficiente'}</h3>
        <p class="text-sm mt-1">${ajena
          ? `La fotografía no parece corresponder a ${App.kb.organos[App.organo].nombre.toLowerCase()} de uvilla. Tome otra foto encuadrando solo el órgano.`
          : `El modelo no alcanzó el umbral de seguridad (${pct(App.kb.parametros.umbralRechazo)}). Tome otra foto con mejor luz y enfoque, o reevalúe respondiendo síntomas.`}</p>
        <div class="flex flex-wrap gap-2 mt-4">
          <button data-accion="otra-foto" class="bg-hoja-700 text-white text-sm px-4 py-2 rounded-xl">📷 Tomar otra fotografía</button>
          ${!ajena ? '<button data-accion="reevaluar" class="bg-white border border-hoja-300 text-hoja-800 text-sm px-4 py-2 rounded-xl">🧩 Reevaluar con síntomas</button>' : ''}
        </div>
      </div>`;
  },

  htmlPreguntas(preguntas, obligatorio) {
    const items = preguntas.map((q) => `
      <fieldset class="border border-tierra-100 rounded-xl p-3">
        <legend class="text-sm font-medium px-1">${esc(q.texto)}</legend>
        <div class="flex flex-wrap gap-2 mt-1">
          ${q.opciones.map((o) => `
            <label class="cursor-pointer">
              <input type="radio" name="q-${q.id}" value="${o.valor}" class="peer sr-only" ${o.valor === 'ns' ? 'checked' : ''} />
              <span class="inline-block text-sm px-3 py-1.5 rounded-full border border-tierra-100 peer-checked:bg-hoja-700 peer-checked:text-white peer-checked:border-hoja-700">${esc(o.texto)}</span>
            </label>`).join('')}
        </div>
      </fieldset>`).join('');
    return `
      <form id="form-sintomas" class="bg-white rounded-2xl p-4 shadow-sm border-2 border-uvilla-200 space-y-3">
        <div>
          <h3 class="font-semibold">Etapa 2 · Reglas de desempate por síntomas</h3>
          <p class="text-sm text-tierra-600">${obligatorio ? 'El modelo visual tiene dudas. Observe la planta y responda para que el sistema experto resuelva el diagnóstico.' : 'Responda para refinar el diagnóstico.'}</p>
        </div>
        ${items}
        <button class="w-full bg-hoja-700 hover:bg-hoja-800 text-white font-medium py-3 rounded-xl">✅ Aplicar reglas y concluir</button>
      </form>`;
  },

  /** Ejecuta el motor de inferencia, muestra el resultado y lo guarda */
  async finalizar(respuestas) {
    const clima = this.leerClima();
    const resultado = Motor.concluir(App.pred, respuestas, clima, App.organo);
    const diag = {
      // Si se refina el mismo análisis, se actualiza el registro en lugar de duplicarlo
      id: App.diagId || uid(),
      fecha: new Date().toISOString(),
      organo: App.organo,
      imagen: App.imagenURL,
      clima,
      ubicacion: $('#ubicacion').value.trim(),
      prediccion: { fuente: App.pred.fuente, indiceVegetal: App.pred.indiceVegetal, probs: App.pred.probs.slice(0, 5).map(({ claseId, etiqueta, p }) => ({ claseId, etiqueta, p })) },
      control: App.control.disparadas.map((r) => ({ id: r.id, detalle: r.detalle })),
      respuestas,
      resultado
    };
    await Sync.guardar(diag);
    App.diagId = diag.id;
    const panel = $('#panel-resultado');
    panel.innerHTML = this.htmlPrediccion() + this.htmlResultado(diag, true);
    panel.classList.remove('hidden');
    toast(Auth.esInvitado ? '💾 Guardado en el dispositivo.' : (navigator.onLine ? '💾 Guardado. Sincronizando…' : '💾 Guardado offline. Se sincronizará al volver la conexión.'), 'ok');
  },

  /** Tarjeta de resultado: conclusión, explicación (traza) y ficha de manejo */
  htmlResultado(diag, conAcciones = false) {
    const r = diag.resultado;
    const enf = App.kb.enfermedades[r.claseId];
    const estados = {
      confirmado:     ['Diagnóstico confirmado', 'bg-hoja-700', '🟢'],
      probable:       ['Diagnóstico probable', 'bg-uvilla-500', '🟡'],
      no_concluyente: ['No concluyente', 'bg-tierra-600', '⚪'],
      sano:           ['Órgano sano', 'bg-hoja-600', '✅']
    };
    const [titulo, color, icono] = estados[r.estado];

    const ranking = r.ranking.map((x) => `
      <div>
        <div class="flex justify-between text-sm"><span>${esc(x.claseId === 'sano' ? x.etiqueta : App.kb.enfermedades[x.claseId].nombre)}</span><span class="font-mono">FC ${x.fc.toFixed(3)}</span></div>
        <div class="h-2 bg-tierra-100 rounded-full overflow-hidden"><div class="h-2 rounded-full barra-fc ${colorFC(x.fc)}" style="width:${Math.max(0, x.fc) * 100}%"></div></div>
      </div>`).join('');

    const traza = r.ranking[0].traza.map((t) => `
      <tr class="border-t border-tierra-100">
        <td class="py-1.5 pr-2 font-mono text-[11px]">${t.regla}</td>
        <td class="py-1.5 pr-2 text-[12px]">${esc(t.descripcion)}</td>
        <td class="py-1.5 pr-2 font-mono text-[11px] text-right ${t.aporte < 0 ? 'text-red-600' : ''}">${t.aporte >= 0 ? '+' : ''}${t.aporte.toFixed(2)}</td>
        <td class="py-1.5 font-mono text-[11px] text-right">${t.fc.toFixed(3)}</td>
      </tr>`).join('');

    const respuestas = Object.entries(diag.respuestas || {}).filter(([, v]) => v !== 'ns');
    const htmlResp = respuestas.length ? `<p class="text-[12px] text-tierra-600 mt-2">Síntomas reportados: ${respuestas.map(([k, v]) => {
      const q = App.kb.preguntas.find((p) => p.id === k);
      return `${esc(k)} = <b>${esc(q?.opciones.find((o) => o.valor === v)?.texto || v)}</b>`;
    }).join(' · ')}</p>` : '';

    const climaEval = (diag.clima.aplicar && r.claseId !== 'sano' && enf.clima)
      ? `<div class="p-3 rounded-xl bg-hoja-50 text-sm"><b>Clima registrado:</b> ${diag.clima.temp} °C · ${diag.clima.hr} % HR.<br><b>Favorable para ${esc(enf.nombre)}:</b> ${enf.clima.tOptMin}–${enf.clima.tOptMax} °C, HR ≥ ${enf.clima.hrMin} %. <span class="text-tierra-600">${esc(enf.clima.descripcion)}</span></div>` : '';

    const alertaNC = r.estado === 'no_concluyente'
      ? `<div class="p-3 rounded-xl bg-uvilla-50 text-uvilla-700 text-sm">La evidencia no alcanza el umbral (${pct(App.kb.parametros.umbralDiagnosticoProbable)}). Se recomienda tomar otra fotografía, responder más síntomas o consultar a un técnico agrónomo. Se muestra la hipótesis más probable.</div>` : '';

    return `
      <div class="bg-white rounded-2xl shadow-sm border border-tierra-100 overflow-hidden">
        <div class="${color} text-white p-5">
          <div class="text-sm opacity-90">${icono} ${titulo} · ${App.kb.organos[diag.organo].nombre}</div>
          <div class="text-2xl font-semibold mt-1">${esc(r.nombre)}</div>
          ${r.claseId !== 'sano' ? `<div class="text-sm opacity-90 italic">${esc(enf.agente)} · ${esc(enf.tipoAgente)} · Severidad ${esc(enf.severidad)}</div>` : ''}
          <div class="mt-3 flex items-end gap-3">
            <div class="text-4xl font-bold font-mono">${r.fc.toFixed(2)}</div>
            <div class="text-xs opacity-90 pb-1">Factor de certeza final<br>FC = FC₁ + FC₂ × (1 − FC₁)</div>
          </div>
        </div>
        <div class="p-4 space-y-4">
          ${alertaNC}
          ${r.claseId !== 'sano' && enf.rasgos[diag.organo] ? `<p class="text-sm"><b>Rasgos visuales esperados:</b> ${esc(enf.rasgos[diag.organo])}</p>` : ''}
          ${climaEval}
          <div>
            <h4 class="text-sm font-semibold mb-2">Ranking del sistema experto</h4>
            <div class="space-y-2">${ranking}</div>
            ${htmlResp}
          </div>
          <details class="rounded-xl border border-tierra-100 p-3">
            <summary class="text-sm font-semibold cursor-pointer">¿Por qué? Traza de inferencia</summary>
            <div class="overflow-x-auto scroll-fino mt-2">
              <table class="w-full text-left"><thead><tr class="text-[11px] text-tierra-600"><th>Regla</th><th>Evidencia</th><th class="text-right">FC₂</th><th class="text-right">FC acum.</th></tr></thead><tbody>${traza}</tbody></table>
            </div>
          </details>
        </div>
      </div>
      ${this.htmlFichaManejo(r.claseId)}
      ${conAcciones ? `
      <div class="flex flex-wrap gap-2">
        <button data-accion="nuevo" class="flex-1 bg-hoja-700 text-white text-sm font-medium px-4 py-3 rounded-xl">🔬 Nuevo diagnóstico</button>
        ${r.estado !== 'sano' ? '<button data-accion="refinar" class="flex-1 bg-white border border-hoja-300 text-hoja-800 text-sm font-medium px-4 py-3 rounded-xl">🧩 Refinar con síntomas</button>' : ''}
        <button data-ir="historial" class="flex-1 bg-hoja-100 text-hoja-800 text-sm font-medium px-4 py-3 rounded-xl">🗂️ Ver historial</button>
      </div>` : ''}`;
  },

  /** Ficha de manejo agronómico */
  htmlFichaManejo(enfId) {
    const enf = App.kb.enfermedades[enfId];
    const bloques = [
      ['cultural', '🌱 Manejo cultural', 'border-hoja-300'],
      ['biologico', '🦠 Control biológico', 'border-lime-300'],
      ['quimico', '🧪 Control químico', 'border-uvilla-300'],
      ['preventivo', '🛡️ Prevención', 'border-sky-300']
    ];
    return `
      <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100">
        <h3 class="font-semibold">Ficha de manejo agronómico${enfId !== 'sano' ? ` · ${esc(enf.nombre)}` : ''}</h3>
        <div class="grid sm:grid-cols-2 gap-3 mt-3">
          ${bloques.map(([k, t, b]) => `
            <div class="border-l-4 ${b} pl-3">
              <div class="text-sm font-medium">${t}</div>
              <ul class="text-sm text-tierra-600 list-disc pl-4 mt-1 space-y-0.5">${enf.manejo[k].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
            </div>`).join('')}
        </div>
        <p class="text-[11px] text-tierra-600 mt-3">Use solo productos con registro vigente (Agrocalidad) y respete dosis, periodos de carencia y equipo de protección. Consulte a un ingeniero agrónomo antes de aplicar.</p>
      </div>`;
  },

  reiniciarDiagnostico() {
    App.imagen = null; App.imagenURL = null; App.pred = null; App.control = null;
    $('#preview-imagen').classList.add('hidden');
    $('#placeholder-imagen').classList.remove('hidden');
    $('#btn-analizar').disabled = true;
    $('#panel-resultado').classList.add('hidden');
    $('#input-camara').value = ''; $('#input-galeria').value = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  /* ---------- Historial ---------- */
  async renderHistorial() {
    const fo = $('#filtro-organo').value, fs = $('#filtro-sync').value;
    const diags = (await DB.todos('diagnosticos'))
      .filter((d) => d.usuario === Auth.id && (!fo || d.organo === fo) && (!fs || d.estadoSync === fs))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
    $('#btn-sincronizar').classList.toggle('hidden', Auth.esInvitado);
    $('#lista-historial').innerHTML = diags.length ? diags.map((d) => `
      <div class="bg-white rounded-2xl p-3 shadow-sm border border-tierra-100 flex gap-3 items-center">
        <img src="${d.imagen}" alt="" class="w-16 h-16 rounded-xl object-cover shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold">${esc(d.resultado.nombre)}</span>
            <span class="text-[11px] font-mono px-1.5 rounded ${colorFC(d.resultado.fc)} text-white">FC ${d.resultado.fc.toFixed(2)}</span>
          </div>
          <div class="text-[12px] text-tierra-600">${App.kb.organos[d.organo].icono} ${App.kb.organos[d.organo].nombre} · ${fechaCorta(d.fecha)}${d.ubicacion ? ` · ${esc(d.ubicacion)}` : ''}</div>
          <div class="text-[11px] text-tierra-600">${d.clima.temp} °C · ${d.clima.hr} % HR · ${d.prediccion.fuente}</div>
        </div>
        <div class="flex flex-col items-end gap-2">
          ${this.chipSync(d.estadoSync)}
          <div class="flex gap-1">
            <button data-detalle="${d.id}" class="text-xs px-2 py-1 rounded-lg bg-hoja-100 text-hoja-800">Ver</button>
            <button data-eliminar="${d.id}" class="text-xs px-2 py-1 rounded-lg bg-red-50 text-red-700">Eliminar</button>
          </div>
        </div>
      </div>`).join('')
      : `<div class="text-center text-tierra-600 py-10 bg-white rounded-2xl border border-tierra-100">No hay diagnósticos con estos filtros.<br><button data-ir="diagnostico" class="mt-3 text-sm bg-hoja-700 text-white px-4 py-2 rounded-xl">Hacer un diagnóstico</button></div>`;
  },

  async verDetalle(id) {
    const d = await DB.get('diagnosticos', id);
    if (!d) return;
    $('#modal-titulo').textContent = `${d.resultado.nombre} · ${fechaCorta(d.fecha)}`;
    $('#modal-cuerpo').innerHTML = `
      <img src="${d.imagen}" alt="" class="w-full max-h-72 object-contain rounded-xl bg-tierra-100 mb-4" />
      <div class="space-y-4">${this.htmlResultado(d)}</div>`;
    $('#modal').classList.remove('hidden');
  },

  async eliminar(id) {
    if (!confirm('¿Eliminar este diagnóstico del dispositivo?')) return;
    await DB.del('diagnosticos', id);
    await DB.del('cola', id);
    this.renderHistorial(); this.actualizarBadgeCola();
    toast('Diagnóstico eliminado.');
  },

  async exportarCSV() {
    const diags = (await DB.todos('diagnosticos')).filter((d) => d.usuario === Auth.id);
    if (!diags.length) return toast('No hay datos para exportar.', 'aviso');
    const cab = ['id', 'fecha', 'organo', 'diagnostico', 'estado', 'fc', 'fuente_ml', 'clase_ml', 'prob_ml', 'temperatura', 'humedad', 'ubicacion', 'sync'];
    const filas = diags.map((d) => [d.id, d.fecha, d.organo, d.resultado.nombre, d.resultado.estado, d.resultado.fc.toFixed(4), d.prediccion.fuente,
      d.prediccion.probs[0]?.etiqueta, d.prediccion.probs[0]?.p.toFixed(4), d.clima.temp, d.clima.hr, d.ubicacion, d.estadoSync]);
    const csv = [cab, ...filas].map((f) => f.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `uvilladx-diagnosticos-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  },

  /* ---------- Base de conocimiento ---------- */
  renderKB() {
    $$('.kb-tab').forEach((b) => {
      const on = b.dataset.kb === App.kbTab;
      b.className = `kb-tab px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${on ? 'bg-hoja-700 text-white' : 'bg-white border border-tierra-100'}`;
    });
    const kb = App.kb;
    const cont = $('#contenido-kb');

    if (App.kbTab === 'enfermedades') {
      cont.innerHTML = `<div class="grid md:grid-cols-2 gap-3">${Object.entries(kb.enfermedades).filter(([id]) => id !== 'sano').map(([id, e]) => {
        const organos = Object.entries(kb.organos).filter(([, o]) => o.clases.some((c) => c.id === id)).map(([, o]) => o.icono + ' ' + o.nombre);
        return `
        <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100">
          <div class="flex items-start gap-2">
            <div><h3 class="font-semibold">${esc(e.nombre)}</h3><p class="text-sm italic text-tierra-600">${esc(e.agente)}</p></div>
            <span class="ml-auto text-[11px] px-2 py-0.5 rounded-full ${e.tipoAgente === 'Bacteria' ? 'bg-sky-100 text-sky-800' : 'bg-hoja-100 text-hoja-800'}">${e.tipoAgente}</span>
          </div>
          <p class="text-[12px] mt-2">Órganos: ${organos.join(' · ')} · Severidad: <b>${e.severidad}</b></p>
          <p class="text-[12px] mt-1"><b>Clima favorable:</b> ${e.clima.tOptMin}–${e.clima.tOptMax} °C (tolera ${e.clima.tMin}–${e.clima.tMax} °C), HR ≥ ${e.clima.hrMin} %.</p>
          <ul class="text-[12px] text-tierra-600 mt-2 space-y-1">${Object.entries(e.rasgos).map(([o, t]) => `<li><b>${kb.organos[o].nombre}:</b> ${esc(t)}</li>`).join('')}</ul>
          <button data-ficha="${id}" class="mt-3 text-xs bg-hoja-100 text-hoja-800 px-3 py-1.5 rounded-lg">📋 Ficha de manejo</button>
        </div>`;
      }).join('')}</div>`;
    }

    if (App.kbTab === 'clases') {
      let n = 0;
      cont.innerHTML = `<div class="grid md:grid-cols-3 gap-3">${Object.entries(kb.organos).map(([id, o]) => `
        <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100">
          <h3 class="font-semibold">${o.icono} ${o.nombre} <span class="text-sm text-tierra-600 font-normal">(${o.clases.length} clases)</span></h3>
          <ol class="mt-2 text-sm space-y-1">${o.clases.map((c) => `<li class="flex gap-2"><span class="font-mono text-[11px] text-tierra-600 w-6">${++n}</span>${esc(c.etiqueta)}</li>`).join('')}</ol>
        </div>`).join('')}</div>`;
    }

    if (App.kbTab === 'reglas') {
      const nombreEnf = (id) => (id === 'sano' ? 'Sano' : kb.enfermedades[id].nombre);
      const pregunta = (id) => kb.preguntas.find((q) => q.id === id);
      cont.innerHTML = `
        <div class="space-y-4">
          <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100">
            <h3 class="font-semibold mb-2">Reglas de control de confianza</h3>
            <ul class="space-y-2 text-sm">${kb.reglas.confianza.map((r) => `<li><span class="font-mono text-[11px] px-1.5 py-0.5 rounded bg-hoja-100 text-hoja-800">${r.id}</span> <b>SI</b> ${esc(r.si)} <b>ENTONCES</b> ${esc(r.entonces)}</li>`).join('')}</ul>
          </div>
          <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100">
            <h3 class="font-semibold mb-2">Reglas de desempate por síntomas</h3>
            <ul class="space-y-2 text-sm">${kb.reglas.sintomas.map((r) => {
              const q = pregunta(r.si.pregunta);
              const op = q?.opciones.find((o) => o.valor === r.si.valor)?.texto || r.si.valor;
              return `<li><span class="font-mono text-[11px] px-1.5 py-0.5 rounded bg-uvilla-100 text-uvilla-700">${r.id}</span> <b>SI</b> “${esc(q?.texto || r.si.pregunta)}” = <b>${esc(op)}</b> <b>ENTONCES</b> ${r.entonces.map((e) => `${esc(nombreEnf(e.enfermedad))} <span class="font-mono ${e.fc < 0 ? 'text-red-600' : 'text-hoja-700'}">(FC ${e.fc > 0 ? '+' : ''}${e.fc})</span>`).join(', ')}</li>`;
            }).join('')}</ul>
          </div>
          <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100">
            <h3 class="font-semibold mb-2">Reglas climáticas</h3>
            <ul class="space-y-2 text-sm">${kb.reglas.climaticas.map((r) => `<li><span class="font-mono text-[11px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-800">${r.id}</span> <b>SI</b> ${esc(r.si)} <b>ENTONCES</b> ${esc(r.entonces)} <span class="font-mono">(FC ${r.fc > 0 ? '+' : ''}${r.fc})</span></li>`).join('')}</ul>
          </div>
        </div>`;
    }

    if (App.kbTab === 'fc') {
      cont.innerHTML = `
        <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100 space-y-4 text-sm">
          <div>
            <h3 class="font-semibold">Combinación de factores de certeza</h3>
            <p class="text-tierra-600">Cada diagnóstico parte de la confianza del modelo visual (FC₁) y se combina con cada evidencia (FC₂):</p>
            <div class="mt-2 grid sm:grid-cols-3 gap-2 font-mono text-[13px]">
              <div class="p-3 rounded-xl bg-hoja-50"><div class="text-[11px] font-sans text-tierra-600">Ambos ≥ 0</div>FC₁ + FC₂ × (1 − FC₁)</div>
              <div class="p-3 rounded-xl bg-red-50"><div class="text-[11px] font-sans text-tierra-600">Ambos &lt; 0</div>FC₁ + FC₂ × (1 + FC₁)</div>
              <div class="p-3 rounded-xl bg-uvilla-50"><div class="text-[11px] font-sans text-tierra-600">Signos opuestos</div>(FC₁ + FC₂) / (1 − min(|FC₁|, |FC₂|))</div>
            </div>
          </div>
          <div class="border-t border-tierra-100 pt-4">
            <h3 class="font-semibold mb-2">Calculadora</h3>
            <div class="grid sm:grid-cols-2 gap-4">
              <label>FC₁ <span id="calc-v1" class="font-mono">0.60</span><input id="calc-fc1" type="range" min="-1" max="1" step="0.01" value="0.6" class="w-full" /></label>
              <label>FC₂ <span id="calc-v2" class="font-mono">0.45</span><input id="calc-fc2" type="range" min="-1" max="1" step="0.01" value="0.45" class="w-full" /></label>
            </div>
            <p class="mt-3 text-lg">FC combinado = <b id="calc-res" class="font-mono">0.780</b></p>
          </div>
          <div class="border-t border-tierra-100 pt-4">
            <h3 class="font-semibold mb-1">Umbrales</h3>
            <ul class="list-disc pl-5 text-tierra-600">
              <li>Rechazo del modelo: confianza &lt; ${pct(kb.parametros.umbralRechazo)}</li>
              <li>Reevaluación con síntomas: confianza &lt; ${pct(kb.parametros.umbralReevaluacion)}</li>
              <li>Desempate: diferencia entre 1.ª y 2.ª clase &lt; ${pct(kb.parametros.margenDesempate)}</li>
              <li>Diagnóstico confirmado: FC ≥ ${kb.parametros.umbralDiagnosticoConfirmado} · probable: FC ≥ ${kb.parametros.umbralDiagnosticoProbable}</li>
            </ul>
          </div>
        </div>`;
      const calc = () => {
        const a = +$('#calc-fc1').value, b = +$('#calc-fc2').value;
        $('#calc-v1').textContent = a.toFixed(2); $('#calc-v2').textContent = b.toFixed(2);
        $('#calc-res').textContent = Motor.combinar(a, b).toFixed(3);
      };
      $('#calc-fc1').oninput = calc; $('#calc-fc2').oninput = calc; calc();
    }
  },

  verFicha(enfId) {
    const e = App.kb.enfermedades[enfId];
    $('#modal-titulo').textContent = `${e.nombre} · ${e.agente}`;
    $('#modal-cuerpo').innerHTML = `<p class="text-sm text-tierra-600 mb-3">${esc(e.clima.descripcion)}</p>${this.htmlFichaManejo(enfId)}`;
    $('#modal').classList.remove('hidden');
  },

  /* ---------- Modelos ---------- */
  renderModelos() {
    const tfOk = Modelos.tfDisponible();
    $('#lista-modelos').innerHTML = (tfOk ? '' : `<div class="p-3 rounded-xl bg-red-50 text-red-700 text-sm">TensorFlow.js no se pudo cargar. Conéctese a internet una vez para descargarlo; después quedará disponible sin conexión.</div>`) +
      Object.entries(App.kb.organos).map(([id, o]) => {
        const m = Modelos.cargados[id];
        const mapeo = m ? m.etiquetas.map((et, i) => {
          const c = m.mapeo[i];
          const ok = c && c !== '__ajena__';
          return `<li class="flex justify-between gap-2"><span>${esc(et)}</span><span class="${ok ? 'text-hoja-700' : c === '__ajena__' ? 'text-uvilla-700' : 'text-red-600'}">${ok ? '→ ' + esc(o.clases.find((x) => x.id === c).etiqueta) : c === '__ajena__' ? 'clase de rechazo' : 'sin coincidencia'}</span></li>`;
        }).join('') : '';
        return `
        <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100">
          <div class="flex items-center gap-2">
            <h3 class="font-semibold">${o.icono} Modelo de ${o.nombre.toLowerCase()}</h3>
            <span class="ml-auto text-[11px] px-2 py-0.5 rounded-full ${m ? 'bg-hoja-100 text-hoja-800' : 'bg-uvilla-100 text-uvilla-700'}">${m ? '🧠 Cargado' : '🧪 Simulador'}</span>
          </div>
          ${m ? `
            <p class="text-[12px] text-tierra-600 mt-1">${esc(m.fuente)} · ${fechaCorta(m.fecha)}</p>
            <ul class="text-[12px] mt-2 space-y-0.5 bg-tierra-50 rounded-lg p-2">${mapeo}</ul>
            <button data-quitar-modelo="${id}" class="mt-3 text-xs px-3 py-1.5 rounded-lg bg-red-50 text-red-700">Quitar modelo</button>`
          : `
            <form data-form-url="${id}" class="flex gap-2 mt-3">
              <input name="url" type="url" required placeholder="https://teachablemachine.withgoogle.com/models/XXXX/" class="flex-1 min-w-0 border border-tierra-100 rounded-lg px-3 py-2 text-sm" />
              <button class="text-sm bg-hoja-700 text-white px-3 py-2 rounded-lg whitespace-nowrap">Cargar URL</button>
            </form>
            <label class="mt-2 block text-sm">
              <span class="text-tierra-600 text-[12px]">o seleccione los archivos exportados (model.json, weights.bin, metadata.json):</span>
              <input data-archivos-modelo="${id}" type="file" multiple accept=".json,.bin" class="block mt-1 text-sm w-full" />
            </label>`}
        </div>`;
      }).join('');
  },

  async cargarModelo(organo, fn) {
    toast('Cargando modelo…');
    try {
      const m = await fn();
      const sinMapear = m.mapeo.filter((x) => x === null).length;
      toast(sinMapear ? `Modelo cargado, pero ${sinMapear} etiqueta(s) no coinciden con la base de conocimiento.` : '🧠 Modelo cargado y guardado para uso offline.', sinMapear ? 'aviso' : 'ok');
    } catch (e) {
      console.error(e);
      toast(`No se pudo cargar el modelo: ${e.message}`, 'error');
    }
    this.renderModelos();
  },

  /* ---------- Cuenta ---------- */
  async renderCuenta() {
    const cont = $('#contenido-cuenta');
    if (Auth.esInvitado) {
      const nLocales = (await DB.todos('diagnosticos')).filter((d) => d.usuario === 'invitado').length;
      cont.innerHTML = `
        <div class="p-4 rounded-2xl bg-uvilla-50 text-uvilla-700 text-sm">
          Está usando <b>modo invitado</b>: los diagnósticos se guardan solo en este dispositivo (${nLocales}). Cree una cuenta para sincronizarlos con la nube.
        </div>
        <div class="grid md:grid-cols-2 gap-4">
          <form id="form-login" class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100 space-y-3">
            <h3 class="font-semibold">Iniciar sesión</h3>
            <input name="email" type="email" required placeholder="Correo" autocomplete="username" class="w-full border border-tierra-100 rounded-lg px-3 py-2 text-sm" />
            <input name="password" type="password" required placeholder="Contraseña" autocomplete="current-password" class="w-full border border-tierra-100 rounded-lg px-3 py-2 text-sm" />
            <button class="w-full bg-hoja-700 text-white text-sm font-medium py-2.5 rounded-xl">Ingresar</button>
          </form>
          <form id="form-registro" class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100 space-y-3">
            <h3 class="font-semibold">Crear cuenta</h3>
            <input name="nombre" required placeholder="Nombre completo" class="w-full border border-tierra-100 rounded-lg px-3 py-2 text-sm" />
            <input name="institucion" placeholder="Finca / institución (opcional)" class="w-full border border-tierra-100 rounded-lg px-3 py-2 text-sm" />
            <input name="email" type="email" required placeholder="Correo" autocomplete="username" class="w-full border border-tierra-100 rounded-lg px-3 py-2 text-sm" />
            <input name="password" type="password" required minlength="6" placeholder="Contraseña (mín. 6)" autocomplete="new-password" class="w-full border border-tierra-100 rounded-lg px-3 py-2 text-sm" />
            <label class="flex items-center gap-2 text-sm"><input name="migrar" type="checkbox" checked class="accent-hoja-700" /> Pasar mis diagnósticos de invitado a la cuenta</label>
            <button class="w-full bg-uvilla-500 text-white text-sm font-medium py-2.5 rounded-xl">Registrarme</button>
          </form>
        </div>
        <p class="text-[11px] text-tierra-600">Autenticación simulada para fines académicos: las cuentas se guardan localmente (contraseña con hash SHA-256 y sal). Para producción, conecte un backend real en “Endpoint de sincronización”.</p>`;
    } else {
      const u = Auth.usuario;
      const mios = (await DB.todos('diagnosticos')).filter((d) => d.usuario === u.email);
      const nInv = (await DB.todos('diagnosticos')).filter((d) => d.usuario === 'invitado').length;
      const api = await DB.getConfig('apiUrl', '');
      cont.innerHTML = `
        <div class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100 flex items-center gap-4">
          <div class="w-14 h-14 rounded-full bg-hoja-700 text-white grid place-items-center text-xl font-semibold">${esc(u.nombre[0].toUpperCase())}</div>
          <div class="min-w-0">
            <div class="font-semibold">${esc(u.nombre)}</div>
            <div class="text-sm text-tierra-600 truncate">${esc(u.email)}${u.institucion ? ` · ${esc(u.institucion)}` : ''}</div>
            <div class="text-[11px] text-tierra-600">Cuenta creada ${fechaCorta(u.creado)} · ${mios.length} diagnósticos</div>
          </div>
          <button data-accion="salir" class="ml-auto text-sm bg-tierra-100 px-3 py-2 rounded-lg">Cerrar sesión</button>
        </div>
        ${nInv ? `<div class="p-4 rounded-2xl bg-uvilla-50 text-sm flex flex-wrap items-center gap-3">Hay ${nInv} diagnóstico(s) de invitado en este dispositivo.<button data-accion="migrar" class="ml-auto bg-uvilla-500 text-white px-3 py-1.5 rounded-lg">Pasarlos a mi cuenta</button></div>` : ''}
        <form id="form-api" class="bg-white rounded-2xl p-4 shadow-sm border border-tierra-100 space-y-2">
          <h3 class="font-semibold">Endpoint de sincronización (opcional)</h3>
          <p class="text-[12px] text-tierra-600">Si lo deja vacío, la sincronización usa una nube simulada local. Con un endpoint, cada diagnóstico se envía como JSON por POST.</p>
          <div class="flex gap-2">
            <input name="api" type="url" value="${esc(api)}" placeholder="https://mi-servidor/api/diagnosticos" class="flex-1 min-w-0 border border-tierra-100 rounded-lg px-3 py-2 text-sm" />
            <button class="text-sm bg-hoja-700 text-white px-3 py-2 rounded-lg">Guardar</button>
          </div>
        </form>`;
    }
  },

  /* ---------- Eventos globales ---------- */
  enlazarEventos() {
    // Navegación, detalle, eliminar, acciones dinámicas (delegación)
    document.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-ir],[data-organo],[data-detalle],[data-eliminar],[data-accion],[data-ficha],[data-quitar-modelo],[data-kb]');
      if (!t) return;
      if (t.dataset.ir) return this.ir(t.dataset.ir);
      if (t.dataset.organo) {
        App.organo = t.dataset.organo; this.renderSelectorOrgano();
        if (App.imagen) $('#panel-resultado').classList.add('hidden');
        return;
      }
      if (t.dataset.detalle) return this.verDetalle(t.dataset.detalle);
      if (t.dataset.eliminar) return this.eliminar(t.dataset.eliminar);
      if (t.dataset.ficha) return this.verFicha(t.dataset.ficha);
      if (t.dataset.kb) { App.kbTab = t.dataset.kb; return this.renderKB(); }
      if (t.dataset.quitarModelo) {
        await Modelos.eliminar(t.dataset.quitarModelo); toast('Modelo eliminado. Se usará el simulador.');
        return this.renderModelos();
      }
      switch (t.dataset.accion) {
        case 'otra-foto': this.reiniciarDiagnostico(); $('#input-camara').click(); break;
        case 'nuevo': this.reiniciarDiagnostico(); break;
        case 'reevaluar':
        case 'refinar': {
          const preguntas = Motor.preguntasRelevantes(App.organo, Motor.candidatos(App.pred));
          if (!preguntas.length) return toast('No hay preguntas de síntomas aplicables a estos candidatos.', 'aviso');
          $('#panel-resultado').innerHTML = this.htmlPrediccion() + this.htmlPreguntas(preguntas, false);
          $('#form-sintomas').scrollIntoView({ behavior: 'smooth' });
          break;
        }
        case 'salir':
          await Auth.salir(); this.actualizarPerfil(); this.actualizarBadgeCola(); this.renderCuenta(); toast('Sesión cerrada. Modo invitado.');
          break;
        case 'migrar': {
          const n = await Sync.migrarInvitado(); toast(`${n} diagnóstico(s) pasados a su cuenta.`, 'ok'); this.renderCuenta();
          break;
        }
      }
    });

    // Formularios (delegación)
    document.addEventListener('submit', async (e) => {
      const f = e.target;
      e.preventDefault();
      const datos = Object.fromEntries(new FormData(f));
      try {
        if (f.id === 'form-sintomas') {
          const resp = {};
          $$('input[type=radio]:checked', f).forEach((r) => { resp[r.name.slice(2)] = r.value; });
          await this.finalizar(resp);
        } else if (f.id === 'form-login') {
          await Auth.ingresar(datos.email, datos.password);
          await Sync.descargar();
          this.despuesDeSesion('Bienvenido/a de nuevo.');
        } else if (f.id === 'form-registro') {
          await Auth.registrar(datos);
          if (datos.migrar) await Sync.migrarInvitado();
          this.despuesDeSesion('Cuenta creada correctamente.');
        } else if (f.id === 'form-api') {
          await DB.setConfig('apiUrl', datos.api.trim()); toast('Endpoint guardado.', 'ok');
        } else if (f.dataset.formUrl) {
          this.cargarModelo(f.dataset.formUrl, () => Modelos.desdeURL(f.dataset.formUrl, datos.url));
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    // Archivos de modelo
    document.addEventListener('change', (e) => {
      const org = e.target.dataset?.archivosModelo;
      if (org && e.target.files.length) this.cargarModelo(org, () => Modelos.desdeArchivos(org, e.target.files));
    });

    // Imagen: cámara, galería, clic y arrastrar
    $('#input-camara').addEventListener('change', (e) => this.cargarImagen(e.target.files[0]));
    $('#input-galeria').addEventListener('change', (e) => this.cargarImagen(e.target.files[0]));
    $('#zona-imagen').addEventListener('click', () => $('#input-galeria').click());
    $('#zona-imagen').addEventListener('dragover', (e) => { e.preventDefault(); e.currentTarget.classList.add('border-hoja-600'); });
    $('#zona-imagen').addEventListener('dragleave', (e) => e.currentTarget.classList.remove('border-hoja-600'));
    $('#zona-imagen').addEventListener('drop', (e) => { e.preventDefault(); e.currentTarget.classList.remove('border-hoja-600'); this.cargarImagen(e.dataTransfer.files[0]); });
    $('#btn-analizar').addEventListener('click', () => this.analizar());

    // Clima: sincroniza deslizador y campo numérico, recuerda el último valor
    const enlazar = (rango, num, clave) => {
      const set = (v) => { $(rango).value = v; $(num).value = v; DB.setConfig(clave, v); };
      $(rango).addEventListener('input', (e) => set(e.target.value));
      $(num).addEventListener('change', (e) => set(Math.min(+e.target.max, Math.max(+e.target.min, +e.target.value || 0))));
    };
    enlazar('#temp', '#temp-num', 'ultimaTemp');
    enlazar('#hr', '#hr-num', 'ultimaHR');

    // Historial
    $('#filtro-organo').addEventListener('change', () => this.renderHistorial());
    $('#filtro-sync').addEventListener('change', () => this.renderHistorial());
    $('#btn-sincronizar').addEventListener('click', () => navigator.onLine ? Sync.sincronizar() : toast('Sin conexión: se sincronizará automáticamente al reconectar.', 'aviso'));
    $('#btn-exportar').addEventListener('click', () => this.exportarCSV());

    // Modal
    $('#modal-cerrar').addEventListener('click', () => $('#modal').classList.add('hidden'));
    $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
  },

  despuesDeSesion(msg) {
    this.actualizarPerfil();
    this.actualizarBadgeCola();
    Sync.sincronizar({ silencioso: true });
    toast(msg, 'ok');
    this.ir('dashboard');
  }
};

/* =====================================================================
 * 9. ARRANQUE
 * ===================================================================== */
async function iniciar() {
  try {
    App.kb = await fetch('knowledgeBase.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  } catch (e) {
    document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">No se pudo cargar la base de conocimiento. Abra la app desde un servidor web (no como archivo local) y con conexión la primera vez.</p>';
    return;
  }

  await DB.abrir();
  await Auth.restaurar();

  // Valores climáticos iniciales (típicos de zonas uvilleras del Carchi)
  const t = await DB.getConfig('ultimaTemp', 16), h = await DB.getConfig('ultimaHR', 80);
  $('#temp').value = $('#temp-num').value = t;
  $('#hr').value = $('#hr-num').value = h;

  UI.enlazarEventos();
  UI.actualizarRed();
  UI.actualizarPerfil();
  UI.actualizarBadgeCola();

  const inicial = location.hash.slice(1);
  UI.ir(['dashboard', 'diagnostico', 'historial', 'conocimiento', 'modelos', 'cuenta'].includes(inicial) ? inicial : 'dashboard');

  // TensorFlow.js se carga con "defer": restaurar modelos cuando esté listo
  const esperarTF = async () => {
    for (let i = 0; i < 50 && !Modelos.tfDisponible(); i++) await dormir(100);
    await Modelos.restaurar();
    if (App.vista === 'dashboard') UI.renderDashboard();
    if (App.vista === 'diagnostico') UI.renderSelectorOrgano();
    if (App.vista === 'modelos') UI.renderModelos();
  };
  esperarTF();

  // Conectividad
  window.addEventListener('online', () => { UI.actualizarRed(); toast('Conexión restablecida.', 'ok'); Sync.sincronizar(); });
  window.addEventListener('offline', () => { UI.actualizarRed(); toast('Sin conexión: los diagnósticos se guardarán en la cola offline.', 'aviso'); });
  if (navigator.onLine) Sync.sincronizar({ silencioso: true });

  // Service Worker
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
      navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.tipo === 'SYNC_SOLICITADA') Sync.sincronizar(); });
    } catch (e) {
      console.warn('Service Worker no registrado:', e);
    }
  }

  // Instalación PWA
  let eventoInstalar = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); eventoInstalar = e;
    $('#aviso-instalar').classList.remove('hidden');
  });
  $('#btn-instalar').addEventListener('click', async () => {
    if (!eventoInstalar) return;
    eventoInstalar.prompt(); await eventoInstalar.userChoice;
    eventoInstalar = null; $('#aviso-instalar').classList.add('hidden');
  });
  $('#btn-cerrar-instalar').addEventListener('click', () => $('#aviso-instalar').classList.add('hidden'));
}

document.addEventListener('DOMContentLoaded', iniciar);
