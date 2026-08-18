'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------------------------------------------------------------------
// Zonas de risco (configuraveis pelo usuario em data/crime-zones.json)
// ---------------------------------------------------------------------------
const CRIME_ZONES_PATH = path.join(__dirname, 'data', 'crime-zones.json');

function loadCrimeZones() {
  try {
    const raw = fs.readFileSync(CRIME_ZONES_PATH, 'utf-8');
    const json = JSON.parse(raw);
    delete json._readme;
    return json;
  } catch (err) {
    console.error('Nao foi possivel ler data/crime-zones.json:', err.message);
    return {};
  }
}

function normalizeCityKey(city) {
  return city
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Geometria / distancias
// ---------------------------------------------------------------------------
const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Distancia aproximada (metros) de um ponto ate um segmento de reta,
// usando projecao equiretangular local (suficiente para distancias urbanas).
function pointToSegmentDistance(p, a, b) {
  const lat0 = toRad((a.lat + b.lat) / 2);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(lat0);

  const toXY = (pt) => ({
    x: pt.lon * mPerDegLon,
    y: pt.lat * mPerDegLat,
  });

  const A = toXY(a);
  const B = toXY(b);
  const P = toXY(p);

  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const lenSq = dx * dx + dy * dy;

  let t = lenSq === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = A.x + t * dx;
  const projY = A.y + t * dy;

  return Math.sqrt((P.x - projX) ** 2 + (P.y - projY) ** 2);
}

function checkRouteAgainstZones(route, zones) {
  const warnings = [];
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    for (const zone of zones) {
      const dist = pointToSegmentDistance(
        { lat: zone.lat, lon: zone.lon },
        { lat: a.lat, lon: a.lon },
        { lat: b.lat, lon: b.lon }
      );
      if (dist <= zone.radius_m) {
        warnings.push({
          zone: zone.name,
          level: zone.level || 'alta',
          betweenIndex: [i, i + 1],
          approxDistanceM: Math.round(dist),
        });
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Geocodificacao (Nominatim) + POIs (Overpass)
// ---------------------------------------------------------------------------
const USER_AGENT = 'ZyntraTurismo/1.0 (contato@zyntra.example)';

async function geocodeCity(city) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0&q=${encodeURIComponent(
    city
  )}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Falha na geocodificacao (HTTP ${res.status})`);
  const data = await res.json();
  if (!data.length) throw new Error('Cidade nao encontrada');

  const place = data[0];
  const [south, north, west, east] = place.boundingbox.map(Number);
  return {
    lat: Number(place.lat),
    lon: Number(place.lon),
    displayName: place.display_name,
    bbox: { south, north, west, east },
  };
}

async function fetchPois(bbox) {
  const { south, west, north, east } = bbox;
  const query = `
    [out:json][timeout:25];
    (
      node["tourism"~"attraction|museum|viewpoint|gallery|artwork|zoo|theme_park"](${south},${west},${north},${east});
      node["historic"](${south},${west},${north},${east});
      node["tourism"="hotel"](${south},${west},${north},${east});
      node["tourism"="hostel"](${south},${west},${north},${east});
      node["amenity"="restaurant"](${south},${west},${north},${east});
    );
    out body 250;
  `;

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: 'data=' + encodeURIComponent(query),
  });

  if (!res.ok) throw new Error(`Falha ao buscar pontos (HTTP ${res.status})`);
  const data = await res.json();

  const attractions = [];
  const hotels = [];
  const restaurants = [];

  for (const el of data.elements || []) {
    const tags = el.tags || {};
    if (!tags.name) continue;
    const point = {
      id: el.id,
      name: tags.name,
      lat: el.lat,
      lon: el.lon,
      category: tags.tourism || tags.historic || tags.amenity || 'ponto',
    };

    if (tags.tourism === 'hotel' || tags.tourism === 'hostel') {
      hotels.push(point);
    } else if (tags.amenity === 'restaurant') {
      point.cuisine = tags.cuisine || null;
      restaurants.push(point);
    } else {
      attractions.push(point);
    }
  }

  return { attractions, hotels, restaurants };
}

// ---------------------------------------------------------------------------
// Clusterizacao por dia (k-means simplificado) + ordenacao por vizinho mais proximo
// ---------------------------------------------------------------------------
function kMeansClusters(points, k, iterations = 15) {
  if (points.length === 0) return [];
  k = Math.max(1, Math.min(k, points.length));

  // Inicializa centroides distribuindo pontos ordenados por longitude.
  const sorted = [...points].sort((a, b) => a.lon - b.lon);
  const step = Math.floor(sorted.length / k) || 1;
  let centroids = Array.from({ length: k }, (_, i) => {
    const p = sorted[Math.min(i * step, sorted.length - 1)];
    return { lat: p.lat, lon: p.lon };
  });

  let assignments = new Array(points.length).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;

    points.forEach((p, idx) => {
      let best = 0;
      let bestDist = Infinity;
      centroids.forEach((c, ci) => {
        const d = haversine(p, c);
        if (d < bestDist) {
          bestDist = d;
          best = ci;
        }
      });
      if (assignments[idx] !== best) changed = true;
      assignments[idx] = best;
    });

    const sums = Array.from({ length: k }, () => ({ lat: 0, lon: 0, n: 0 }));
    points.forEach((p, idx) => {
      const c = sums[assignments[idx]];
      c.lat += p.lat;
      c.lon += p.lon;
      c.n += 1;
    });

    centroids = centroids.map((old, ci) => {
      const s = sums[ci];
      return s.n > 0 ? { lat: s.lat / s.n, lon: s.lon / s.n } : old;
    });

    if (!changed) break;
  }

  const clusters = Array.from({ length: k }, () => []);
  points.forEach((p, idx) => clusters[assignments[idx]].push(p));
  return clusters.filter((c) => c.length > 0);
}

function orderByNearestNeighbor(points, start) {
  if (points.length === 0) return [];
  const remaining = [...points];
  const route = [];
  let current = start || remaining[0];

  if (!start) {
    route.push(remaining.shift());
    current = route[0];
  }

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((p, idx) => {
      const d = haversine(current, p);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    });
    current = remaining.splice(bestIdx, 1)[0];
    route.push(current);
  }

  return route;
}

function centroidOf(points) {
  const n = points.length;
  const lat = points.reduce((s, p) => s + p.lat, 0) / n;
  const lon = points.reduce((s, p) => s + p.lon, 0) / n;
  return { lat, lon };
}

function nearestTo(target, points) {
  let best = null;
  let bestDist = Infinity;
  for (const p of points) {
    const d = haversine(target, p);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rota principal: gera o roteiro completo
// ---------------------------------------------------------------------------
app.get('/api/plan', async (req, res) => {
  try {
    const city = String(req.query.city || '').trim();
    const days = Math.max(1, Math.min(14, parseInt(req.query.days, 10) || 1));

    if (!city) {
      return res.status(400).json({ error: 'Informe o parametro "city".' });
    }

    const geo = await geocodeCity(city);
    const { attractions, hotels, restaurants } = await fetchPois(geo.bbox);

    if (attractions.length === 0) {
      return res.status(404).json({
        error:
          'Nenhum ponto turistico encontrado para essa cidade na base OpenStreetMap.',
      });
    }

    const clusters = kMeansClusters(attractions, days);

    const cityCenter = { lat: geo.lat, lon: geo.lon };
    const zonesMap = loadCrimeZones();
    const zones = zonesMap[normalizeCityKey(city)] || [];

    const itinerary = clusters.map((cluster, index) => {
      const startPoint = index === 0 ? cityCenter : centroidOf(cluster);
      const orderedPoints = orderByNearestNeighbor(cluster, startPoint);
      const routeWithStart =
        index === 0 ? [cityCenter, ...orderedPoints] : orderedPoints;

      const dayCentroid = centroidOf(cluster);
      const suggestedRestaurant =
        restaurants.length > 0 ? nearestTo(dayCentroid, restaurants) : null;

      const warnings = checkRouteAgainstZones(routeWithStart, zones);

      return {
        day: index + 1,
        stops: orderedPoints.map((p) => ({
          name: p.name,
          category: p.category,
          lat: p.lat,
          lon: p.lon,
        })),
        suggestedRestaurant,
        warnings,
      };
    });

    const overallCentroid = centroidOf(attractions);
    const recommendedHotels = hotels
      .map((h) => ({ ...h, distanceM: Math.round(haversine(overallCentroid, h)) }))
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 8);

    res.json({
      city: geo.displayName,
      center: cityCenter,
      days: itinerary,
      hotels: recommendedHotels,
      totalAttractionsFound: attractions.length,
      totalRestaurantsFound: restaurants.length,
      crimeZonesConsidered: zones,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Zyntra Turismo rodando em http://localhost:${PORT}`);
});
