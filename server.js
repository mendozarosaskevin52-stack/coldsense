/*
 * ============================================================
 *  COLD SENSE — Servidor de ingesta y tablero
 *  Node.js puro, CERO dependencias. No hay que instalar nada.
 * ============================================================
 *
 *  ARRANCAR:
 *      cd servidor
 *      node server.js
 *
 *  El mismo archivo corre en tres lugares sin cambios:
 *    - En tu Mac, para pruebas locales
 *    - En tu Mac + túnel, para el stand
 *    - En un hosting gratis (Render/Railway), para el QR público
 *
 *  RUTAS:
 *    GET  /                 tablero (lo que ve el jurado)
 *    POST /api/ingesta      el ESP32 (o el simulador) manda lecturas
 *    GET  /api/estado       foto completa en JSON
 *    GET  /api/stream       tiempo real por SSE
 *    GET  /api/salud        para verificar que vive
 * ============================================================
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { Equipo } = require('./detector');

const PUERTO = process.env.PORT || 3000;
const TOKEN  = process.env.CS_TOKEN || 'coldsense-anfeca-2026';
const PUBLIC = path.join(__dirname, 'public');

// Modo demostración: 'auto' (recomendado) | 'off'
// En 'auto', si no llega ninguna lectura de un dispositivo real durante
// 45 segundos, el propio servidor genera datos de demostración. Así el QR
// SIEMPRE muestra algo vivo, aunque el ESP32 esté apagado, sin batería,
// sin señal o desconectado. Es la red de seguridad del stand.
const MODO_DEMO = process.env.CS_DEMO || 'auto';
const ESPERA_DEMO = 45000;

// ── Estado en memoria ─────────────────────────────────────────
const equipos = new Map();
let clientes = [];
let totalLecturas = 0;
let ultimaReal = 0;
let tickDemo = 0;

const esDemo = id => id.startsWith('DEMO-');

function obtenerEquipo(id, tipo, nombre) {
  if (!equipos.has(id)) {
    equipos.set(id, new Equipo(id, tipo, nombre));
    console.log(`  + Equipo dado de alta: ${id} (${tipo || 'refrigerador'})`);
  }
  return equipos.get(id);
}

function hayDispositivoReal() {
  return Date.now() - ultimaReal < ESPERA_DEMO;
}

// ── Generador de demostración ─────────────────────────────────
const EQUIPOS_DEMO = [
  { id: 'DEMO-01', nombre: 'Refrigerador de bebidas', tipo: 'refrigerador', centro:  4.5, amp: 1.3, periodo: 28 },
  { id: 'DEMO-02', nombre: 'Vitrina de lácteos',      tipo: 'vitrina',      centro:  3.4, amp: 1.1, periodo: 24, falla: true },
  { id: 'DEMO-03', nombre: 'Congelador de carnes',    tipo: 'congelador',   centro: -18.5, amp: 1.8, periodo: 32 },
];

function generarDemo() {
  if (MODO_DEMO === 'off') return;

  // Si hay un dispositivo real reportando, la demo se retira por completo.
  if (hayDispositivoReal()) {
    let borrados = 0;
    for (const id of [...equipos.keys()]) if (esDemo(id)) { equipos.delete(id); borrados++; }
    if (borrados) { console.log('  Dispositivo real detectado. Demostración retirada.'); difundir(); }
    return;
  }

  tickDemo++;
  for (const d of EQUIPOS_DEMO) {
    const fase = (tickDemo % d.periodo) / d.periodo;
    // Diente de sierra: enfría, se apaga, se calienta, vuelve a enfriar
    const desv = fase < 0.55
      ? d.amp * (1 - 2 * (fase / 0.55))
      : d.amp * (2 * ((fase - 0.55) / 0.45) - 1);

    // La vitrina sufre una excursión cada ~5 minutos para que quien escanee
    // el QR alcance a ver dispararse una alerta de verdad.
    let extra = 0;
    if (d.falla) {
      const ciclo = tickDemo % 60;
      if (ciclo > 44 && ciclo < 58) extra = 4.4 * Math.sin(((ciclo - 44) / 14) * Math.PI);
    }

    const t = d.centro + desv + extra + (Math.random() - 0.5) * 0.12;
    const eq = obtenerEquipo(d.id, d.tipo, d.nombre);
    eq.registrar({ t, h: 74 + Math.random() * 12 });
    totalLecturas++;
  }
  difundir();
}

function snapshot() {
  const real = hayDispositivoReal();
  return {
    ok: true,
    fuente: real ? 'dispositivo' : 'demostracion',
    lecturas: totalLecturas,
    pantallas: clientes.length,
    equipos: [...equipos.values()].map(e => e.resumen()),
  };
}

function difundir() {
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
  clientes = clientes.filter(c => !c.destroyed);
  clientes.forEach(c => { try { c.write(msg); } catch (_) {} });
}

// ── Utilidades ────────────────────────────────────────────────
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function servirArchivo(res, archivo) {
  const tipos = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml', '.png':'image/png' };
  fs.readFile(archivo, (err, data) => {
    if (err) { res.writeHead(404); res.end('No encontrado'); return; }
    res.writeHead(200, { 'Content-Type': tipos[path.extname(archivo)] || 'application/octet-stream' });
    res.end(data);
  });
}

function ipLocal() {
  for (const lista of Object.values(os.networkInterfaces()))
    for (const i of lista)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}

// ── Servidor ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CS-Token');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // ── POST /api/ingesta ──
  if (req.method === 'POST' && url === '/api/ingesta') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        const token = req.headers['x-cs-token'] || d.token;
        if (token !== TOKEN) return json(res, 401, { ok: false, error: 'Token inválido' });

        const id = d.id || d.device_id || 'REF-001';
        if (!esDemo(id)) ultimaReal = Date.now();
        const eq = obtenerEquipo(id, d.tipo, d.nombre);
        const r = eq.registrar({
          t: Number(d.t ?? d.temperatura),
          h: d.h ?? d.humedad ?? null,
          bateria: d.bateria ?? null,
          rssi: d.rssi ?? null,
        });
        if (!r) return json(res, 400, { ok: false, error: 'Temperatura inválida' });

        totalLecturas++;
        difundir();
        if (totalLecturas % 20 === 0)
          console.log(`  ${id}  ${r.punto.t} °C  base ${r.punto.base}  ${eq.estado}  (${totalLecturas} lecturas)`);

        json(res, 200, { ok: true, estado: eq.estado, intervalo: 5 });
      } catch (e) {
        json(res, 400, { ok: false, error: 'JSON inválido' });
      }
    });
    return;
  }

  // ── GET /api/estado ──
  if (url === '/api/estado') return json(res, 200, snapshot());

  // ── GET /api/salud ──
  if (url === '/api/salud') return json(res, 200, { ok: true, equipos: equipos.size, lecturas: totalLecturas });

  // ── GET /api/stream (SSE) ──
  if (url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clientes.push(res);
    const latido = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => {
      clearInterval(latido);
      clientes = clientes.filter(c => c !== res);
    });
    return;
  }

  // ── Archivos estáticos ──
  if (url === '/' || url === '/index.html') return servirArchivo(res, path.join(PUBLIC, 'index.html'));
  const archivo = path.join(PUBLIC, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (archivo.startsWith(PUBLIC) && fs.existsSync(archivo) && fs.statSync(archivo).isFile())
    return servirArchivo(res, archivo);

  res.writeHead(404); res.end('No encontrado');
});

server.listen(PUERTO, '0.0.0.0', () => {
  const ip = ipLocal();
  console.log('');
  console.log('  COLD SENSE — servidor activo');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Tablero en esta Mac : http://localhost:${PUERTO}`);
  console.log(`  Tablero en la red   : http://${ip}:${PUERTO}`);
  console.log(`  Endpoint del ESP32  : http://${ip}:${PUERTO}/api/ingesta`);
  console.log(`  Token               : ${TOKEN}`);
  console.log(`  Modo demostración   : ${MODO_DEMO}`);
  console.log('  ─────────────────────────────────────────────');
  if (MODO_DEMO === 'auto')
    console.log('  Sin dispositivo real, el tablero muestra la demostración.');
  console.log('');

  if (MODO_DEMO === 'auto') setInterval(generarDemo, 5000);
});
