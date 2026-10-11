
/**
 * AeroSentinel live data adapters
 *
 * Providers:
 * - NASA FIRMS: satellite thermal hotspot detections
 * - OpenAQ v3: ground PM2.5 observations
 * - Open-Meteo: current weather and wind
 *
 * IMPORTANT:
 * - API keys stay on the server.
 * - A satellite hotspot is not proof of stubble burning.
 * - PM2.5-derived AQI is indicative, not official Indian AQI.
 * - Old observations must never be represented as current.
 * - Weather observations are not a substitute for local wind sensors.
 */

const DEFAULT_BBOX = '77.1,10.9,77.6,11.4';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const HOURS_TO_MS = 60 * 60 * 1000;

const bbox = () =>
  process.env.REGION_BBOX || DEFAULT_BBOX;

function validateBbox(value) {
  const parts = String(value)
    .split(',')
    .map(part => Number(part.trim()));

  if (
    parts.length !== 4 ||
    parts.some(part => !Number.isFinite(part))
  ) {
    throw new Error(
      'REGION_BBOX must contain west,south,east,north'
    );
  }

  const [west, south, east, north] = parts;

  if (
    west < -180 || west > 180 ||
    east < -180 || east > 180 ||
    south < -90 || south > 90 ||
    north < -90 || north > 90 ||
    west >= east || south >= north
  ) {
    throw new Error('REGION_BBOX contains invalid coordinates');
  }

  return { west, south, east, north };
}

async function getText(url, headers = {}) {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from data provider`);
  }

  return response.text();
}

async function getJson(url, headers = {}) {
  const text = await getText(url, headers);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Data provider returned invalid JSON');
  }
}

function requireLiveMode() {
  if (String(process.env.DATA_MODE).toUpperCase() !== 'LIVE') {
    throw new Error(
      'Live adapter disabled: set DATA_MODE=LIVE in .env'
    );
  }
}

function validCoordinates(lat, lng) {
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 && lat <= 90 &&
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    lng >= -180 && lng <= 180
  );
}

function isInsideBbox(lat, lng, box) {
  return (
    lng >= box.west && lng <= box.east &&
    lat >= box.south && lat <= box.north
  );
}

function parseFirmsTimestamp(date, time) {
  const dateText = String(date || '').trim();
  const timeText = String(time || '').trim().padStart(4, '0');

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dateText) ||
    !/^\d{4}$/.test(timeText)
  ) {
    return null;
  }

  const hour = Number(timeText.slice(0, 2));
  const minute = Number(timeText.slice(2, 4));

  if (hour > 23 || minute > 59) return null;

  const iso =
    `${dateText}T${timeText.slice(0, 2)}:` +
    `${timeText.slice(2, 4)}:00.000Z`;

  const ms = Date.parse(iso);

  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString() !== iso
  ) {
    return null;
  }

  return iso;
}

/**
 * NASA FIRMS thermal hotspots.
 * Returns recent detections inside REGION_BBOX.
 */
async function hotspots() {
  requireLiveMode();

  const key = process.env.FIRMS_MAP_KEY;
  if (!key) throw new Error('FIRMS_MAP_KEY not set');

  const box = validateBbox(bbox());
  const region = [
    box.west, box.south, box.east, box.north
  ].join(',');

  const url =
    'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' +
    `${encodeURIComponent(key)}/VIIRS_SNPP_NRT/` +
    `${region}/5`;

  const text = (await getText(url)).trim();

  if (!text) {
    throw new Error('NASA FIRMS returned an empty response');
  }

  const [headerLine, ...rows] = text.split(/\r?\n/);
  const columns = headerLine.split(',').map(v => v.trim());

  const required = [
    'latitude', 'longitude', 'acq_date', 'acq_time'
  ];

  if (!required.every(column => columns.includes(column))) {
    throw new Error('Unexpected NASA FIRMS CSV format');
  }

  const detections = [];

  for (const row of rows) {
    if (!row.trim()) continue;

    // FIRMS CSV fields used here do not normally contain commas.
    const values = row.split(',');
    const record = {};

    columns.forEach((column, index) => {
      record[column] = (values[index] || '').trim();
    });

    const lat = Number(record.latitude);
    const lng = Number(record.longitude);

    if (!validCoordinates(lat, lng)) continue;
    if (!isInsideBbox(lat, lng, box)) continue;

    const timestamp = parseFirmsTimestamp(
      record.acq_date,
      record.acq_time
    );

    if (!timestamp) continue;

    detections.push({
      lat,
      lng,
      timestamp,
      confidence: record.confidence || null,
      frp: record.frp ? Number(record.frp) : null,
      satellite: record.satellite || null,
      source: 'NASA FIRMS VIIRS_SNPP_NRT',
      evidenceType: 'SATELLITE_HOTSPOT',
      interpretation:
        'Potential thermal anomaly; not verified stubble burning'
    });
  }

  return detections;
}

/**
 * Approximate US-EPA-style PM2.5 index.
 * This is NOT official Indian AQI.
 */
function aqiFromPm25(concentration) {
  if (
    typeof concentration !== 'number' ||
    !Number.isFinite(concentration) ||
    concentration < 0
  ) {
    return null;
  }

  const value = Math.round(concentration * 10) / 10;

  const ranges = [
    [0.0, 9.0, 0, 50],
    [9.1, 35.4, 51, 100],
    [35.5, 55.4, 101, 150],
    [55.5, 125.4, 151, 200],
    [125.5, 225.4, 201, 300],
    [225.5, 325.4, 301, 500]
  ];

  const range = ranges.find(
    ([low, high]) => value >= low && value <= high
  );

  if (!range) return value > 325.4 ? 500 : null;

  const [cLow, cHigh, iLow, iHigh] = range;

  return Math.round(
    ((iHigh - iLow) / (cHigh - cLow)) *
      (value - cLow) + iLow
  );
}

function getMeasurementTimestamp(measurement) {
  const value =
    measurement?.datetime?.utc ||
    measurement?.datetime?.local;

  const ms = Date.parse(value || '');

  return Number.isFinite(ms) ? ms : null;
}

/**
 * OpenAQ v3 PM2.5 observations.
 */
async function aqi() {
  requireLiveMode();

  const key = process.env.OPENAQ_API_KEY;
  if (!key) throw new Error('OPENAQ_API_KEY not set');

  const freshnessHours = Number(
    process.env.OPENAQ_FRESHNESS_HOURS || 72
  );

  if (
    !Number.isFinite(freshnessHours) ||
    freshnessHours <= 0
  ) {
    throw new Error(
      'OPENAQ_FRESHNESS_HOURS must be positive'
    );
  }

  const box = validateBbox(bbox());
  const region = [
    box.west, box.south, box.east, box.north
  ].join(',');

  const baseUrl = 'https://api.openaq.org/v3';
  const headers = {
    'X-API-Key': key,
    Accept: 'application/json'
  };

  const response = await getJson(
    `${baseUrl}/locations?bbox=${encodeURIComponent(region)}` +
      '&limit=100',
    headers
  );

  if (!Array.isArray(response.results)) {
    throw new Error('OpenAQ locations response has no results');
  }

  const stations = response.results.filter(location =>
    location.id != null &&
    Array.isArray(location.sensors) &&
    location.sensors.some(sensor =>
      String(
        sensor.parameter?.name ||
        sensor.parameter?.displayName ||
        ''
      ).toLowerCase().replace(/[^a-z0-9]/g, '') === 'pm25'
    )
  );

  const now = Date.now();
  const maxAgeMs = freshnessHours * HOURS_TO_MS;
  const readings = [];

  // Bound concurrency to reduce API rate-limit failures.
  for (let i = 0; i < stations.length; i += 5) {
    const batch = stations.slice(i, i + 5);

    const results = await Promise.allSettled(
      batch.map(async location => {
        const latest = await getJson(
          `${baseUrl}/locations/${encodeURIComponent(location.id)}/latest?limit=100`,
          headers
        );

        const sensorIds = new Set(
          location.sensors
            .filter(sensor =>
              String(
                sensor.parameter?.name ||
                sensor.parameter?.displayName ||
                ''
              ).toLowerCase().replace(/[^a-z0-9]/g, '') === 'pm25'
            )
            .map(sensor => String(sensor.id))
        );

        const measurements = (latest.results || [])
          .filter(item => {
            const sensorId = item.sensorsId ?? item.sensorId;
            const sensorMatches =
              sensorId != null
                ? sensorIds.has(String(sensorId))
                : sensorIds.size === 1;

            return (
              sensorMatches &&
              typeof item.value === 'number' &&
              Number.isFinite(item.value) &&
              item.value >= 0
            );
          })
          .map(item => ({
            value: item.value,
            timestampMs: getMeasurementTimestamp(item)
          }))
          .filter(item => item.timestampMs != null)
          .sort((a, b) => b.timestampMs - a.timestampMs);

        const measurement = measurements[0];
        if (!measurement) return null;

        const lat = location.coordinates?.latitude;
        const lng = location.coordinates?.longitude;

        if (!validCoordinates(lat, lng)) return null;
        if (!isInsideBbox(lat, lng, box)) return null;

        const ageMs = now - measurement.timestampMs;

        // Never mark future-dated readings as current.
        const freshness =
          ageMs < -MAX_CLOCK_SKEW_MS
            ? 'INVALID_TIMESTAMP'
            : ageMs < 0
              ? 'INVALID_TIMESTAMP'
              : ageMs <= maxAgeMs
                ? 'CURRENT'
                : 'STALE';

        return {
          id: location.id,
          name: location.name || `Station ${location.id}`,
          lat,
          lng,
          pm25: measurement.value,
          aqi: aqiFromPm25(measurement.value),
          timestamp: new Date(
            measurement.timestampMs
          ).toISOString(),
          freshness,
          ageHours: Math.max(
            0,
            Math.floor(ageMs / HOURS_TO_MS)
          ),
          source: 'OpenAQ v3',
          unit: 'µg/m³',
          aqiLabel:
            'Indicative PM2.5-derived estimate; not official Indian AQI'
        };
      })
    );

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value) readings.push(result.value);
      } else {
        console.warn(
          `[OpenAQ] Station ${batch[index].id} failed:`,
          result.reason?.message || 'Unknown error'
        );
      }
    });
  }

  return readings.sort((a, b) => {
    const currentA = a.freshness === 'CURRENT' ? 1 : 0;
    const currentB = b.freshness === 'CURRENT' ? 1 : 0;

    return currentB - currentA ||
      Date.parse(b.timestamp) - Date.parse(a.timestamp);
  });
}

/**
 * Open-Meteo current weather.
 * No API key is required for its public forecast API.
 *
 * Pass the incident's actual latitude and longitude.
 * Wind speed is returned in km/h; direction in degrees.
 */
async function weather(lat, lng) {
  requireLiveMode();

  lat = Number(lat);
  lng = Number(lng);

  if (!validCoordinates(lat, lng)) {
    throw new Error(
      'weather() requires valid incident latitude and longitude'
    );
  }

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    current: [
      'temperature_2m',
      'relative_humidity_2m',
      'precipitation',
      'wind_speed_10m',
      'wind_direction_10m',
      'wind_gusts_10m'
    ].join(','),
    wind_speed_unit: 'kmh',
    timezone: 'UTC'
  });

  const data = await getJson(
    `https://api.open-meteo.com/v1/forecast?${params}`
  );

  const current = data.current;

  if (!current || !current.time) {
    throw new Error('Weather provider returned no current data');
  }

  const timestampMs = Date.parse(`${current.time}Z`);

  if (!Number.isFinite(timestampMs)) {
    throw new Error('Weather provider returned invalid timestamp');
  }

  const ageMs = Date.now() - timestampMs;

  const freshness =
    ageMs < -MAX_CLOCK_SKEW_MS
      ? 'INVALID_TIMESTAMP'
      : ageMs < 0
        ? 'INVALID_TIMESTAMP'
        : ageMs <= 2 * HOURS_TO_MS
          ? 'CURRENT'
          : 'STALE';

  const windSpeed = current.wind_speed_10m;
  const windDirection = current.wind_direction_10m;

  return {
    lat,
    lng,
    timestamp: new Date(timestampMs).toISOString(),
    freshness,
    source: 'Open-Meteo',
    temperatureC: current.temperature_2m ?? null,
    relativeHumidityPercent:
      current.relative_humidity_2m ?? null,
    precipitationMm: current.precipitation ?? null,
    windSpeedKmh:
      Number.isFinite(windSpeed) ? windSpeed : null,
    windDirectionDegrees:
      Number.isFinite(windDirection) ? windDirection : null,
    windGustsKmh: current.wind_gusts_10m ?? null,
    windDirectionCardinal:
      Number.isFinite(windDirection)
        ? directionToCardinal(windDirection)
        : null,
    units: {
      windSpeed: 'km/h',
      windDirection: 'degrees clockwise from north',
      temperature: '°C',
      precipitation: 'mm'
    },
    note:
      'Weather-model data; not a direct local wind sensor measurement'
  };
}

function directionToCardinal(degrees) {
  const directions = [
    'N', 'NNE', 'NE', 'ENE',
    'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW',
    'W', 'WNW', 'NW', 'NNW'
  ];

  return directions[
    Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16
  ];
}

module.exports = {
  hotspots,
  aqi,
  weather,
  aqiFromPm25,
  directionToCardinal
};
