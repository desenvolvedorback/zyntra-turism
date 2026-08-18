(function () {
  'use strict';

  const form = document.getElementById('plan-form');
  const cityInput = document.getElementById('city');
  const daysInput = document.getElementById('days');
  const submitBtn = document.getElementById('submit-btn');
  const statusEl = document.getElementById('status');

  const warningsBox = document.getElementById('warnings-box');
  const warningsList = document.getElementById('warnings-list');

  const dayTabsEl = document.getElementById('day-tabs');
  const itineraryEl = document.getElementById('itinerary');

  const hotelsBox = document.getElementById('hotels-box');
  const hotelsList = document.getElementById('hotels-list');

  const DAY_COLORS = ['#00E5FF', '#007BFF', '#FF9F43', '#7CFF6B', '#FF6BE0', '#FFD166'];

  let map;
  let currentLayers = { routes: [], markers: [], zones: [] };
  let planData = null;
  let activeDay = 1;

  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([-14.235, -51.9253], 4);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map);
  }

  function clearLayers() {
    [...currentLayers.routes, ...currentLayers.markers, ...currentLayers.zones].forEach((l) =>
      map.removeLayer(l)
    );
    currentLayers = { routes: [], markers: [], zones: [] };
  }

  function setStatus(message, isError) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('error', Boolean(isError));
  }

  function categoryLabel(cat) {
    const map = {
      attraction: 'Atracao',
      museum: 'Museu',
      viewpoint: 'Mirante',
      gallery: 'Galeria',
      artwork: 'Obra de arte',
      zoo: 'Zoologico',
      theme_park: 'Parque tematico',
    };
    return map[cat] || cat;
  }

  function renderWarnings(days) {
    const allWarnings = [];
    days.forEach((d) => {
      d.warnings.forEach((w) => allWarnings.push({ ...w, day: d.day }));
    });

    if (allWarnings.length === 0) {
      warningsBox.classList.add('hidden');
      warningsList.innerHTML = '';
      return;
    }

    warningsBox.classList.remove('hidden');
    warningsList.innerHTML = allWarnings
      .map(
        (w) =>
          `<li><strong>Dia ${w.day}:</strong> rota passa perto de "${w.zone}" (risco ${w.level}, ~${w.approxDistanceM}m).</li>`
      )
      .join('');
  }

  function renderZones(zones) {
    zones.forEach((z) => {
      const circle = L.circle([z.lat, z.lon], {
        radius: z.radius_m,
        color: z.level === 'alta' ? '#FF4D4D' : '#FFB020',
        fillColor: z.level === 'alta' ? '#FF4D4D' : '#FFB020',
        fillOpacity: 0.15,
        weight: 1.5,
      }).addTo(map);
      circle.bindPopup(`Area de risco: ${z.name} (${z.level})`);
      currentLayers.zones.push(circle);
    });
  }

  function renderDayTabs(days) {
    dayTabsEl.classList.remove('hidden');
    dayTabsEl.innerHTML = '';
    days.forEach((d) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'day-tab' + (d.day === activeDay ? ' active' : '');
      btn.textContent = 'Dia ' + d.day;
      btn.addEventListener('click', () => {
        activeDay = d.day;
        renderDayTabs(days);
        focusDay(d.day);
      });
      dayTabsEl.appendChild(btn);
    });
  }

  function renderItinerary(days) {
    itineraryEl.innerHTML = '';
    days.forEach((d) => {
      const card = document.createElement('div');
      card.className = 'day-card';

      const stopsHtml = d.stops
        .map(
          (s, idx) => `
          <li class="stop-item">
            <span class="stop-index">${idx + 1}</span>
            <span>
              <div>${s.name}</div>
              <div class="stop-category">${categoryLabel(s.category)}</div>
            </span>
          </li>`
        )
        .join('');

      const restaurantHtml = d.suggestedRestaurant
        ? `<div class="restaurant-tip">Sugestao para comer: <strong>${d.suggestedRestaurant.name}</strong>${
            d.suggestedRestaurant.cuisine ? ' &middot; ' + d.suggestedRestaurant.cuisine : ''
          }</div>`
        : '';

      card.innerHTML = `
        <h3>Dia ${d.day}</h3>
        <ul class="stop-list">${stopsHtml}</ul>
        ${restaurantHtml}
      `;

      itineraryEl.appendChild(card);
    });
  }

  function renderHotels(hotels) {
    if (!hotels || hotels.length === 0) {
      hotelsBox.classList.add('hidden');
      return;
    }
    hotelsBox.classList.remove('hidden');
    hotelsList.innerHTML = hotels
      .map(
        (h) =>
          `<li>${h.name}<br><span class="hotel-dist">a ~${(h.distanceM / 1000).toFixed(1)} km do centro do roteiro</span></li>`
      )
      .join('');
  }

  function renderMapRoutes(data) {
    clearLayers();

    data.days.forEach((d, i) => {
      const color = DAY_COLORS[i % DAY_COLORS.length];
      const latlngs = d.stops.map((s) => [s.lat, s.lon]);

      if (latlngs.length > 1) {
        const line = L.polyline(latlngs, { color, weight: 4, opacity: 0.85 }).addTo(map);
        currentLayers.routes.push(line);
      }

      d.stops.forEach((s, idx) => {
        const marker = L.circleMarker([s.lat, s.lon], {
          radius: 7,
          color,
          fillColor: color,
          fillOpacity: 0.9,
          weight: 2,
        }).addTo(map);
        marker.bindPopup(`<strong>Dia ${d.day} - Parada ${idx + 1}</strong><br>${s.name}<br><span style="color:#A6ACB5">${categoryLabel(s.category)}</span>`);
        marker.dayGroup = d.day;
        currentLayers.markers.push(marker);
      });
    });

    renderZones(data.crimeZonesConsidered || []);

    const allPoints = data.days.flatMap((d) => d.stops.map((s) => [s.lat, s.lon]));
    if (allPoints.length > 0) {
      map.fitBounds(allPoints, { padding: [30, 30] });
    }
  }

  function focusDay(dayNumber) {
    if (!planData) return;
    const day = planData.days.find((d) => d.day === dayNumber);
    if (!day || day.stops.length === 0) return;
    const bounds = day.stops.map((s) => [s.lat, s.lon]);
    map.fitBounds(bounds, { padding: [40, 40] });

    currentLayers.markers.forEach((m) => {
      const isActive = m.dayGroup === dayNumber;
      m.setStyle({ opacity: isActive ? 1 : 0.25, fillOpacity: isActive ? 0.9 : 0.15 });
    });
  }

  async function loadPlan(city, days) {
    setStatus('Buscando cidade e pontos turisticos...');
    submitBtn.disabled = true;
    warningsBox.classList.add('hidden');
    dayTabsEl.classList.add('hidden');
    hotelsBox.classList.add('hidden');
    itineraryEl.innerHTML = '';

    try {
      const res = await fetch(`/api/plan?city=${encodeURIComponent(city)}&days=${days}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Erro ao gerar roteiro.');
      }

      planData = data;
      activeDay = 1;

      setStatus(`Roteiro gerado para ${data.city}.`);
      renderMapRoutes(data);
      renderDayTabs(data.days);
      renderItinerary(data.days);
      renderWarnings(data.days);
      renderHotels(data.hotels);
    } catch (err) {
      setStatus(err.message || 'Erro inesperado.', true);
    } finally {
      submitBtn.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const city = cityInput.value.trim();
    const days = Math.max(1, Math.min(14, parseInt(daysInput.value, 10) || 1));
    if (!city) return;
    loadPlan(city, days);
  });

  initMap();
})();
