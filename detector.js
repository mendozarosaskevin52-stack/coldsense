/*
 * ============================================================
 *  COLD SENSE — Detector en línea
 * ============================================================
 *
 *  Por qué no usamos aquí el modelo .joblib del Mtro. Carlos:
 *  ese modelo predice la temperatura a partir de la POSICIÓN
 *  dentro de una curva de enfriamiento específica (entrada = t
 *  normalizado de 0 a 1 sobre esa corrida de 1,687 muestras).
 *  Funciona perfecto para validar offline esa corrida, pero en
 *  vivo no existe ese "t normalizado": el refri cicla sin fin.
 *
 *  Este detector hace lo que dice el plan de negocios: aprende
 *  el comportamiento normal de CADA equipo y mide la desviación
 *  contra su propio patrón. Tres señales independientes:
 *
 *    1. BANDA        — ¿está fuera del rango objetivo del equipo?
 *    2. DERIVA       — ¿se aleja de su propia línea base (EWMA)?
 *    3. PENDIENTE    — ¿sube más rápido de lo normal? (puerta abierta)
 *
 *  Se conservan los criterios del Mtro. Carlos:
 *    - umbral de residual en °C
 *    - N muestras consecutivas antes de disparar (evita falsos positivos)
 * ============================================================
 */

'use strict';

// ── Perfiles por tipo de equipo ───────────────────────────────
const PERFILES = {
  refrigerador: { min:  2.0, max:  8.0, nominalW: 350, nombre: 'Refrigerador' },
  congelador:   { min: -22.0, max: -15.0, nominalW: 450, nombre: 'Congelador' },
  vitrina:      { min:  1.0, max:  6.0, nominalW: 300, nombre: 'Vitrina' },
  camara:       { min:  0.0, max:  5.0, nominalW: 900, nombre: 'Cámara fría' },
  ambiente:     { min: 15.0, max: 30.0, nominalW: 350, nombre: 'Banco de pruebas' },
};

const CFG = {
  alphaBase: 0.02,        // EWMA lenta = "cómo se comporta normalmente"
  alphaRapida: 0.35,      // EWMA rápida = "qué está pasando ahorita"
  alphaResidual: 0.02,    // qué tan rápido aprende su oscilación típica
  factorUmbral: 3.0,      // se avisa a 3 veces su oscilación normal
  umbralMinimo: 1.2,      // °C, piso para equipos muy estables
  umbralMaximo: 5.0,      // °C, techo para equipos muy ruidosos
  calibracionSeg: 150,    // hasta aquí solo aprende, no acusa
  muestrasConsecutivas: 4,// criterio del Mtro. Carlos
  pendienteAlerta: 0.08,  // °C por segundo de subida => puerta abierta
  ventana: 720,           // muestras guardadas en memoria (~1 h a 5 s)
  tarifaMXNkWh: 3.15,     // tarifa CFE PDBT de referencia
};

class Equipo {
  constructor(id, tipo = 'refrigerador', nombre = null) {
    this.id = id;
    this.tipo = PERFILES[tipo] ? tipo : 'refrigerador';
    this.perfil = PERFILES[this.tipo];
    this.nombre = nombre || this.perfil.nombre;

    this.historial = [];       // { ts, t, h, base, estado }
    this.base = null;          // EWMA lenta
    this.rapida = null;        // EWMA rápida
    this.residualTipico = null;// cuánto oscila normalmente ESTE equipo
    this.umbral = CFG.umbralMinimo;
    this.consecutivas = 0;
    this.estado = 'SIN_DATOS';
    this.alertas = [];
    this.segCompresor = 0;     // segundos estimados de compresor trabajando
    this.segTotales = 0;       // segundos totales contabilizados (misma base)
    this.ultimoTs = null;
    this.arranques = 0;
    this.compresorEncendido = false;
  }

  // ── Ingesta de una lectura ──────────────────────────────────
  registrar({ t, h = null, bateria = null, rssi = null, ts = Date.now() }) {
    if (typeof t !== 'number' || Number.isNaN(t)) return null;

    const dtSeg = this.ultimoTs ? Math.max(0.5, (ts - this.ultimoTs) / 1000) : 5;
    const anterior = this.historial.length
      ? this.historial[this.historial.length - 1]
      : null;

    // Líneas base
    const rapidaPrevia = this.rapida;
    if (this.base === null) { this.base = t; this.rapida = t; }
    else {
      this.base   = CFG.alphaBase   * t + (1 - CFG.alphaBase)   * this.base;
      this.rapida = CFG.alphaRapida * t + (1 - CFG.alphaRapida) * this.rapida;
    }

    // Pendiente en °C/s. Se mide sobre la EWMA rápida para no reaccionar
    // al ruido de una sola muestra, pero sigue siendo una pendiente real.
    const pendiente = anterior ? (t - anterior.t) / dtSeg : 0;
    const pendienteSuave = rapidaPrevia !== null ? (this.rapida - rapidaPrevia) / dtSeg : 0;

    // Estimación de ciclo de compresor: enfriando = compresor trabajando
    const enfriando = pendiente < -0.005;
    if (enfriando && !this.compresorEncendido) this.arranques++;
    this.compresorEncendido = enfriando;
    this.segTotales += dtSeg;
    if (enfriando) this.segCompresor += dtSeg;

    // ── Las tres señales ──────────────────────────────────────
    const deriva = Math.abs(t - this.base);

    // Aprende cuánto oscila normalmente este equipo y ajusta su umbral.
    if (this.residualTipico === null) this.residualTipico = deriva;
    else this.residualTipico = CFG.alphaResidual * deriva + (1 - CFG.alphaResidual) * this.residualTipico;
    this.umbral = Math.min(CFG.umbralMaximo,
                  Math.max(CFG.umbralMinimo, CFG.factorUmbral * this.residualTipico));

    // Durante la calibración solo observa: todavía no sabe qué es normal aquí.
    const calibrado = this.segTotales >= CFG.calibracionSeg;

    const fueraDeBanda = t > this.perfil.max || t < this.perfil.min;
    const derivando = calibrado && deriva > this.umbral;
    const subidaRapida = calibrado && dtSeg >= 2 && pendienteSuave > CFG.pendienteAlerta;

    if (fueraDeBanda || derivando) this.consecutivas++;
    else this.consecutivas = 0;

    // ── Estado ────────────────────────────────────────────────
    let estado = 'NORMAL';
    let motivo = null;

    if (subidaRapida) {
      estado = 'ADVERTENCIA';
      motivo = 'puerta';
    }
    if (this.consecutivas >= CFG.muestrasConsecutivas) {
      if (fueraDeBanda) { estado = 'ALERTA'; motivo = 'banda'; }
      else { estado = 'ADVERTENCIA'; motivo = 'deriva'; }
    }

    const cambioDeEstado = estado !== this.estado;
    this.estado = estado;
    this.ultimoTs = ts;

    const punto = { ts, t: +t.toFixed(2), h, base: +this.base.toFixed(2), estado };
    this.historial.push(punto);
    if (this.historial.length > CFG.ventana) this.historial.shift();

    if (cambioDeEstado && estado !== 'NORMAL') {
      this.alertas.unshift(this._construirAlerta(estado, motivo, t, deriva, pendienteSuave));
      this.alertas = this.alertas.slice(0, 12);
    }

    return { punto, bateria, rssi };
  }

  // ── Traducción de dato a decisión ───────────────────────────
  _construirAlerta(estado, motivo, t, deriva, pendiente) {
    const textos = {
      puerta: {
        titulo: 'Subida rápida de temperatura',
        detalle: `Subió ${(pendiente * 60).toFixed(1)} °C por minuto. Casi siempre es la puerta mal cerrada o mucha carga nueva adentro. Revisa el sello y ciérrala bien.`,
        accion: 'Revisar puerta y empaque',
      },
      deriva: {
        titulo: 'El equipo se está saliendo de su patrón',
        detalle: `Va ${deriva.toFixed(1)} °C arriba de su comportamiento normal, cuando lo suyo es moverse menos de ${this.umbral.toFixed(1)} °C. Todavía no sale del rango seguro. Suele ser rejilla obstruida, condensador sucio o sobrecarga. Aquí es donde se gana tiempo.`,
        accion: 'Revisar rejilla y condensador',
      },
      banda: {
        titulo: 'Temperatura fuera de rango seguro',
        detalle: `${t.toFixed(1)} °C, fuera del rango de ${this.perfil.min} a ${this.perfil.max} °C. Si no baja en 15 minutos, hay que llamar a un técnico antes de perder producto.`,
        accion: 'Contactar técnico aliado',
      },
    };
    const base = textos[motivo] || textos.banda;
    return { ts: Date.now(), estado, motivo, ...base, temperatura: +t.toFixed(1) };
  }

  // ── Estimación de consumo eléctrico ─────────────────────────
  energia() {
    if (this.segTotales < 150)
      return { cicloTrabajo: 0, kWhDia: 0, costoMesMXN: 0, arranques: this.arranques, listo: false };

    const ciclo = Math.min(1, this.segCompresor / this.segTotales);
    const kWhDia = (this.perfil.nominalW / 1000) * ciclo * 24;
    return {
      cicloTrabajo: +(ciclo * 100).toFixed(1),
      kWhDia: +kWhDia.toFixed(2),
      costoMesMXN: Math.round(kWhDia * 30 * CFG.tarifaMXNkWh),
      arranques: this.arranques,
      listo: true,
    };
  }

  // ── Recomendación en lenguaje de negocio ────────────────────
  recomendacion() {
    const e = this.energia();
    if (this.estado === 'ALERTA')
      return 'Atiende la alerta ahora. Cada hora fuera de rango es producto en riesgo.';
    if (this.estado === 'ADVERTENCIA')
      return 'Todavía hay tiempo. Revisa lo que indica la alerta antes de que se convierta en falla.';
    if (!e.listo) return 'Aprendiendo el patrón de este equipo. Necesito unos minutos de lecturas.';
    if (e.cicloTrabajo > 70)
      return `El compresor trabaja ${e.cicloTrabajo}% del tiempo. Arriba de 70% casi siempre es condensador sucio o empaque vencido: limpiarlo baja el recibo.`;
    if (e.cicloTrabajo < 25)
      return `Ciclo de trabajo de ${e.cicloTrabajo}%. El equipo mantiene su temperatura sin esforzarse: está trabajando bien.`;
    return 'Comportamiento dentro de su patrón normal. Sin acciones pendientes.';
  }

  resumen() {
    const ultimo = this.historial[this.historial.length - 1] || null;
    const desviacion = ultimo ? Math.abs(ultimo.t - ultimo.base) : 0;
    return {
      id: this.id,
      nombre: this.nombre,
      tipo: this.tipo,
      rango: { min: this.perfil.min, max: this.perfil.max },
      temperatura: ultimo ? ultimo.t : null,
      humedad: ultimo ? ultimo.h : null,
      base: ultimo ? ultimo.base : null,
      estado: this.estado,
      ts: ultimo ? ultimo.ts : null,
      analisis: {
        desviacion: +desviacion.toFixed(2),
        umbral: +this.umbral.toFixed(2),
        consecutivas: this.consecutivas,
        requeridas: CFG.muestrasConsecutivas,
        calibrado: this.segTotales >= CFG.calibracionSeg,
      },
      energia: this.energia(),
      recomendacion: this.recomendacion(),
      alertas: this.alertas,
      muestras: this.historial.length,
      serie: this.historial.slice(-180),
    };
  }
}

module.exports = { Equipo, PERFILES, CFG };
