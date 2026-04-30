// /api/bdns?nif=A28013811&yearFrom=2020&yearTo=2026
//
// Proxy serverless para la API pública de la BDNS (Base de Datos Nacional
// de Subvenciones, Ministerio de Hacienda). Resuelve el NIF a `idPersona`
// vía `/terceros` y luego pagina `/concesiones/busqueda` filtrando por
// beneficiario. Devuelve un JSON normalizado con el shape que el front
// espera.

const BASE = 'https://www.pap.hacienda.gob.es/bdnstrans/api';
const UPSTREAM_TIMEOUT_MS = 20000;
const MAX_CONCESIONES = 1000;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'subvenciones-bdns-proxy/1.0' },
      signal: ctrl.signal,
    });
    if (r.status === 204) return null;
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      const err = new Error(`upstream ${r.status}`);
      err.status = r.status;
      err.body = body.slice(0, 300);
      throw err;
    }
    const text = await r.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      const err = new Error(`upstream non-JSON (${text.length} bytes)`);
      err.body = text.slice(0, 300);
      throw err;
    }
  } finally {
    clearTimeout(t);
  }
}

function isoToDDMMYYYY(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function instrumentoCode(text) {
  if (!text) return '';
  const t = text.toUpperCase();
  if (t.includes('SUBVEN') || t.includes('ENTREGA DINERARIA')) return 'SB';
  if (t.includes('PRÉSTAMO') || t.includes('PRESTAMO')) return 'PR';
  if (t.includes('GARANT')) return 'GR';
  if (t.includes('VENTAJA') || t.includes('FISCAL')) return 'VF';
  if (t.includes('AVAL')) return 'AV';
  return text.trim().slice(0, 20);
}

function nombreFromTercero(descripcion, fallback) {
  if (!descripcion) return fallback;
  const parts = descripcion.split(' - ');
  return parts.length > 1 ? parts.slice(1).join(' - ').trim() : descripcion.trim();
}

function buildBaseParams({ yearFrom, yearTo }) {
  const p = new URLSearchParams({
    vpd: 'GE',
    pageSize: '50',
    order: 'fechaConcesion',
    direccion: 'desc',
  });
  if (yearFrom) p.set('fechaDesde', `01/01/${yearFrom}`);
  if (yearTo) p.set('fechaHasta', `31/12/${yearTo}`);
  return p;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(204).end();
  }

  const nifRaw = (req.query.nif || '').toString().trim().toUpperCase();
  const yearFrom = (req.query.yearFrom || '').toString().trim();
  const yearTo = (req.query.yearTo || '').toString().trim();

  if (!/^[A-Z0-9]{8,10}$/.test(nifRaw)) {
    return res.status(400).json({ error: 'NIF inválido', nif: nifRaw });
  }
  if (yearFrom && !/^\d{4}$/.test(yearFrom)) return res.status(400).json({ error: 'yearFrom inválido' });
  if (yearTo && !/^\d{4}$/.test(yearTo)) return res.status(400).json({ error: 'yearTo inválido' });

  try {
    const tercerosUrl = `${BASE}/terceros?vpd=GE&busqueda=${encodeURIComponent(nifRaw)}`;
    const tercerosResp = await fetchJson(tercerosUrl);
    const terceros = Array.isArray(tercerosResp?.terceros) ? tercerosResp.terceros : [];
    const ids = [...new Set(terceros.map((t) => t.id).filter((x) => Number.isFinite(x)))];

    if (!ids.length) {
      return res.status(200).json({
        nif: nifRaw,
        nombre: 'Sin datos',
        totalConcesiones: 0,
        importeTotal: 0,
        concesiones: [],
      });
    }

    const nombre = nombreFromTercero(terceros[0].descripcion, nifRaw);
    const baseParams = buildBaseParams({ yearFrom, yearTo });

    const all = [];
    let truncated = false;

    outer: for (const id of ids) {
      let page = 0;
      let totalPages = 1;
      while (page < totalPages) {
        const p = new URLSearchParams(baseParams);
        p.set('beneficiario', String(id));
        p.set('page', String(page));
        const data = await fetchJson(`${BASE}/concesiones/busqueda?${p.toString()}`);
        const content = Array.isArray(data?.content) ? data.content : [];
        for (const c of content) {
          all.push({
            id: c.codConcesion,
            titulo: c.convocatoria || '',
            importe: typeof c.importe === 'number' ? c.importe : Number(c.importe) || 0,
            ayudaEquivalente: typeof c.ayudaEquivalente === 'number' ? c.ayudaEquivalente : null,
            fechaConcesion: isoToDDMMYYYY(c.fechaConcesion),
            organo: c.nivel3 || '',
            ccaa: c.nivel1 === 'AUTONOMICA' ? c.nivel2 || '' : c.nivel1 || '',
            provincia: c.nivel1 === 'LOCAL' ? c.nivel2 || '' : '',
            ambito: c.nivel1 || '',
            instrumento: instrumentoCode(c.instrumento),
            instrumentoTexto: (c.instrumento || '').trim(),
            convocatoria: c.numeroConvocatoria || '',
            beneficiarioBruto: c.beneficiario || '',
            urlBR: c.urlBR || null,
          });
          if (all.length >= MAX_CONCESIONES) {
            truncated = true;
            break outer;
          }
        }
        totalPages = Number(data?.totalPages) || 1;
        page += 1;
        if (page > 50) break;
      }
    }

    const seen = new Set();
    const concesiones = [];
    for (const c of all) {
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      concesiones.push(c);
    }
    concesiones.sort((a, b) => {
      const da = (a.fechaConcesion || '').split('/').reverse().join('');
      const db = (b.fechaConcesion || '').split('/').reverse().join('');
      return db.localeCompare(da);
    });
    const importeTotal = concesiones.reduce((s, c) => s + (c.importe || 0), 0);

    return res.status(200).json({
      nif: nifRaw,
      nombre,
      totalConcesiones: concesiones.length,
      importeTotal,
      truncated,
      concesiones,
    });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? 502 : 500;
    return res.status(status).json({
      error: 'Error consultando BDNS',
      nif: nifRaw,
      detail: String(err.message || err).slice(0, 200),
    });
  }
}
