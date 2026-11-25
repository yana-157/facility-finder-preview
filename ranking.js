const EARTH_RADIUS_KM = 6371;
const MIN_CONFIDENCE = 25;
const CONFIDENCE_PENALTY_MAX_KM = 30;
const CONFIDENCE_MIDPOINT = 55;
const CONFIDENCE_WIDTH = 3.5;
const BRANCH_ID = /^fdr:[^:\s]+$/u;
const EXACT_EVIDENCE = new Set(["corroborated", "hospital_site", "directory", "record_listing"]);
const TIME_CRITICAL_SERVICES = new Set([
  "Emergency C-section", "Trauma / emergency", "NICU", "Burn care", "Cardiac surgery", "Fracture care", "Stroke care",
]);
const PIN_PREFIX_RANGES = [[11, 28], [30, 34], [36, 53], [56, 64], [67, 85]];
const COLLATOR = new Intl.Collator("en-IN");

export const MAX_EXTRA_KM = 10;
export const ROUTING_URL = "https://facility-finder-routing.facility-finder-routing.workers.dev/api/routes";
export const TRAVEL_MODES = {
  driving: {label: "Driving", trip: "drive", mapsMode: "driving"},
  walking: {label: "Walking", trip: "walk", mapsMode: "walking"},
  cycling: {label: "Cycling", trip: "bike ride", mapsMode: "bicycling"},
  public_transport: {label: "Public transport", trip: "public transport trip", mapsMode: "transit"},
};
export const DEFAULT_FIT_WEIGHTS = {capability: 0.4, availability: 0.25, quality: 0.2, freshness: 0.15};
const PRIORITIES = ["travel", "evidence", "capability", "availability", "quality", "freshness", "spare"];
const MAX_EXTRA_MINUTES = 15;
const MINUTES_PER_KM_EQUIVALENT = 2;

export function attachClassicData(data, companion, snapshotSha256) {
  if (!/^[a-f0-9]{64}$/u.test(snapshotSha256) || companion?.snapshotSha256 !== snapshotSha256
      || companion.facilities?.length !== data.facilities.length) {
    throw new Error("The additional facility details do not match the published snapshot.");
  }
  const matchedTerms = (indices, terms) => {
    if (indices === null) return null;
    if (!Array.isArray(indices) || !indices.every(i => Number.isInteger(i) && i >= 0 && i < terms.length)) {
      throw new Error("Invalid equipment or staff evidence.");
    }
    return indices.map(index => terms[index]);
  };
  const catalog = data.services.map(option => {
    const details = companion.services?.[option.label];
    const pairs = companion.matches?.[option.label];
    if (!details?.specialty || !details.area || !Array.isArray(details.equipment) || !Array.isArray(details.staff)
        || !Array.isArray(pairs) || pairs.length !== data.matches[option.label].length) {
      throw new Error("The additional details use a different service catalog.");
    }
    const evidence = pairs.map(([equipment, staff]) => ({
      equipment: matchedTerms(equipment, details.equipment), staff: matchedTerms(staff, details.staff),
    }));
    return {option, details, evidence};
  });
  data.facilities.forEach((facility, index) => {
    const details = companion.facilities[index];
    for (const key of ["ownership", "facilityType", "source", "hours", "open24h", "occupancy",
      "accreditation", "rating", "lastVerified"]) {
      facility[key] = details[key] ?? null;
    }
  });
  for (const {option, details, evidence} of catalog) {
    Object.assign(option, details);
    data.matches[option.label].forEach((assessment, index) => {
      const {equipment, staff} = evidence[index];
      assessment.matchedEquipment = equipment ?? [];
      assessment.matchedStaff = staff ?? [];
      const documented = [];
      if (equipment && details.equipment.length) documented.push(equipment.length / details.equipment.length);
      if (staff && details.staff.length) documented.push(staff.length / details.staff.length);
      assessment.capability = mean(documented);
    });
  }
  return data;
}

export class RouteOriginError extends Error {}

export function parseRouteMatrix(payload, assessments, travelMode = "driving", allowOriginAdjustment = false) {
  const calculatedAt = new Date(payload?.calculatedAt);
  if (!Array.isArray(payload?.routes) || typeof payload.calculatedAt !== "string"
      || !Number.isFinite(calculatedAt.getTime()) || !Object.hasOwn(TRAVEL_MODES, travelMode)
      || payload.travelMode !== travelMode) {
    throw new Error("Invalid routing response.");
  }
  const expected = new Set(assessments.map(row => row.index));
  const secondsByIndex = new Map();
  for (const {index, seconds} of payload.routes) {
    if (!expected.has(index) || secondsByIndex.has(index) || !Number.isFinite(seconds)
        || seconds < 0 || seconds > 10800) {
      throw new Error("Invalid facility travel time.");
    }
    secondsByIndex.set(index, seconds);
  }
  const matrix = {secondsByIndex, calculatedAt, travelMode};
  if (Object.hasOwn(payload, "routedOrigin")) {
    const point = payload.routedOrigin;
    if (allowOriginAdjustment !== true || !inIndia(point?.lat, point?.lon)) {
      throw new RouteOriginError("The routing service returned a starting point that could not be verified. Try the search again.");
    }
    matrix.routedOrigin = {lat: point.lat, lon: point.lon};
  }
  return matrix;
}

function cleanText(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function key(value) {
  return cleanText(value).toLowerCase();
}

function decimal(value) {
  if (typeof value === "number") return value;
  const text = cleanText(value);
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(text) ? Number(text) : NaN;
}

function inIndia(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 6.5 && lat <= 37.5 && lon >= 68 && lon <= 97.5;
}

export function haversineKm(origin, destination) {
  const radians = Math.PI / 180;
  const latitudeDelta = (destination.lat - origin.lat) * radians;
  const longitudeDelta = (destination.lon - origin.lon) * radians;
  const term = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(origin.lat * radians) * Math.cos(destination.lat * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, term)));
}

function centroid(facilities, label) {
  const total = facilities.reduce((sum, facility) => ({
    lat: sum.lat + facility.lat,
    lon: sum.lon + facility.lon,
  }), {lat: 0, lon: 0});
  return {lat: total.lat / facilities.length, lon: total.lon / facilities.length, label, approximate: true};
}

export function resolveOrigin(data, {type, query, state, lat, lon}) {
  if (type === "coordinates") {
    const latitude = decimal(lat);
    const longitude = decimal(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("Enter latitude and longitude as decimal numbers.");
    }
    if (!inIndia(latitude, longitude)) {
      throw new Error("Enter coordinates within India for this facility dataset.");
    }
    return {lat: latitude, lon: longitude, label: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, approximate: false};
  }

  const facilities = data.facilities.filter(facility => inIndia(facility.lat, facility.lon));
  if (type === "pin") {
    const pin = cleanText(query).replace(/\s/gu, "");
    if (!/^[1-8]\d{5}$/u.test(pin)) {
      throw new Error("Enter a six-digit Indian PIN code.");
    }
    const region = Number(pin.slice(0, 2));
    if (!PIN_PREFIX_RANGES.some(([first, last]) => region >= first && region <= last)) {
      throw new Error("Enter a PIN code from an assigned Indian postal region.");
    }
    const exact = facilities.filter(facility => facility.pin === pin);
    if (exact.length) {
      return centroid(exact, `PIN ${pin}`);
    }
    const area = pin.slice(0, 3);
    const nearby = facilities.filter(facility => facility.pin?.startsWith(area));
    if (nearby.length) {
      return centroid(nearby, `PIN area ${area}xxx near ${pin}`);
    }
    throw new Error(`No facility coordinates are available near PIN ${pin}. Try a city or coordinates.`);
  }

  if (type !== "city" && type !== "district") {
    throw new Error("Choose PIN, city, district, or coordinates.");
  }
  const place = cleanText(query);
  const placeKey = key(place);
  const stateKey = key(state);
  if (!place) {
    throw new Error(`Enter a ${type} name.`);
  }
  const matches = facilities.filter(facility => key(facility[type]) === placeKey
    && (!stateKey || key(facility.state) === stateKey));
  if (!matches.length) {
    throw new Error(`No facility coordinates are available for ${place}. Check the spelling or enter coordinates.`);
  }
  const stateKeys = new Set(matches.map(facility => key(facility.state)).filter(Boolean));
  if (stateKeys.size > 1) {
    throw new Error(`Enter the state to distinguish ${place} from other places with this name.`);
  }
  const knownState = matches.find(facility => key(facility.state))?.state;
  return centroid(matches, [matches[0][type], knownState].filter(Boolean).join(", "));
}

function confidencePenalty(confidence) {
  const curve = score => 1 / (1 + Math.exp((score - CONFIDENCE_MIDPOINT) / CONFIDENCE_WIDTH));
  const clamped = Math.min(100, Math.max(0, confidence));
  return CONFIDENCE_PENALTY_MAX_KM * (curve(clamped) - curve(100)) / (curve(0) - curve(100));
}

function compareRecommended(left, right) {
  return (right.fitTier ?? -1) - (left.fitTier ?? -1)
    || left.recommendedScore - right.recommendedScore || left.scoreParts.travel - right.scoreParts.travel
    || left.distanceKm - right.distanceKm;
}

const OTHER_SORTS = {
  straightLine: (left, right) => left.distanceKm - right.distanceKm,
  distance: (left, right) => left.scoreParts.travel - right.scoreParts.travel,
  confidence: (left, right) => right.assessment.confidence - left.assessment.confidence,
  beds: (left, right) => (right.facility.beds ?? -1) - (left.facility.beds ?? -1),
  name: (left, right) => COLLATOR.compare(left.facility.name, right.facility.name),
  fit: (left, right) => (right.fitScore ?? -1) - (left.fitScore ?? -1),
  occupancy: (left, right) => (left.facility.occupancy ?? 2) - (right.facility.occupancy ?? 2),
  priorities: (left, right) => (right.priorityScore ?? -1) - (left.priorityScore ?? -1),
};

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function assessFit(facility, assessment, asOf, weights) {
  const quality = [];
  if (facility.accreditation) quality.push(1);
  if (Number.isFinite(facility.rating) && facility.rating >= 0 && facility.rating <= 5) quality.push(facility.rating / 5);
  const ageMonths = (Date.parse(asOf) - Date.parse(facility.lastVerified)) / (30 * 86400000);
  let freshness = null;
  if (Number.isFinite(ageMonths) && ageMonths >= 0) freshness = ageMonths <= 6 ? 1 : ageMonths <= 12 ? 0.8 : 0.5;
  const components = {
    capability: assessment.capability ?? null,
    availability: typeof facility.open24h === "boolean" ? Number(facility.open24h) : null,
    quality: mean(quality), freshness,
  };
  let total = 0;
  let weightUsed = 0;
  for (const [key, value] of Object.entries(components)) {
    if (value === null || !Number.isFinite(weights[key]) || weights[key] <= 0) continue;
    total += value * weights[key];
    weightUsed += weights[key];
  }
  const fitScore = weightUsed ? Math.round(10 * assessment.match * total / weightUsed) / 10 : null;
  return {fitComponents: components, fitScore};
}

function fitTier(score) {
  if (score === null) return null;
  if (score >= 60) return 3;
  if (score >= 55) return 2;
  if (score >= 50) return 1;
  return 0;
}

function scorePriorities(ranked, priorities) {
  const order = [...new Set(priorities)].filter(key => PRIORITIES.includes(key));
  if (!order.length || !ranked.length) return;
  const costs = ranked.map(row => row.scoreParts.travel);
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  const weights = order.map((_, index) => {
    let total = 0;
    for (let rank = index + 1; rank <= order.length; rank++) total += 1 / rank;
    return total / order.length;
  });
  for (const result of ranked) {
    const values = {
      ...result.fitComponents, travel: max === min ? 1 : (max - result.scoreParts.travel) / (max - min),
      evidence: result.assessment.confidence / 100,
      spare: Number.isFinite(result.facility.occupancy) ? 1 - result.facility.occupancy : null,
    };
    result.priorityParts = order.map((criterion, index) => ({criterion, value: values[criterion], weight: weights[index]}));
  }
  // Omit criteria undocumented throughout this search. A partially documented branch cannot outscore
  // fully documented branches simply because evidence for one of the available criteria is missing.
  const active = order.map((_, i) => ranked.some(result => result.priorityParts[i].value !== null));
  const applicable = weights.reduce((total, weight, i) => total + (active[i] ? weight : 0), 0);
  for (const result of ranked) {
    if (!applicable || result.priorityParts.some((part, i) => active[i] && part.value === null)) continue;
    const total = result.priorityParts.reduce((score, part) => score + (part.value ?? 0) * part.weight, 0);
    result.priorityScore = 100 * total / applicable;
  }
}

function projectionsFor(projections, service) {
  const matching = new Map();
  const ambiguous = new Set();
  for (const row of projections) {
    if (key(row.care_needed) !== key(service) || !BRANCH_ID.test(row.facility_id)) continue;
    const prior = matching.get(row.facility_id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
      ambiguous.add(row.facility_id);
    }
    matching.set(row.facility_id, row);
  }

  const usable = new Map();
  for (const [id, row] of matching) {
    const caseload = decimal(row.caseload);
    const capacity = decimal(row.capacity);
    if (ambiguous.has(id) || !BRANCH_ID.test(row.projection_facility_id)) continue;
    if (!Number.isFinite(caseload) || caseload < 0 || !Number.isFinite(capacity) || capacity <= 0) continue;
    if (![row.unit, row.scope, row.period].every(value => cleanText(value))) continue;
    usable.set(id, {row, caseload, capacity});
  }
  return usable;
}

function compareProjectedLoad(ranked, projections, service) {
  if (!ranked.length) return 0;
  const published = projectionsFor(projections, service);
  const counts = new Map();
  for (const {facility} of ranked) {
    counts.set(facility.id, (counts.get(facility.id) ?? 0) + 1);
  }

  function projectionFor(result) {
    const {assessment, facility} = result;
    if (assessment.projectionEligible !== true || assessment.match !== 100 || !EXACT_EVIDENCE.has(assessment.kind)) {
      return undefined;
    }
    return counts.get(facility.id) === 1 ? published.get(facility.id) : undefined;
  }

  const baseline = ranked[0];
  const anchor = projectionFor(baseline);
  if (!anchor) return 0;
  const detourLimit = baseline.travelMinutes == null ? MAX_EXTRA_KM : MAX_EXTRA_MINUTES;

  const comparable = new Set();
  let winner = 0;
  let winningScore = Infinity;
  for (const [index, result] of ranked.entries()) {
    if (result.fitTier !== baseline.fitTier || result.assessment.kind !== baseline.assessment.kind) continue;
    const extraTravelKm = Math.max(0, result.distanceKm - baseline.distanceKm);
    const extraTravel = Math.max(0, result.scoreParts.travel - baseline.scoreParts.travel);
    const adjustedDetour = Math.max(0, result.recommendedScore - baseline.recommendedScore);
    if (extraTravelKm > MAX_EXTRA_KM || extraTravel > detourLimit || adjustedDetour > detourLimit) continue;
    const projection = projectionFor(result);
    if (!projection) continue;
    const {row, caseload, capacity} = projection;
    if (["unit", "scope", "period"].some(field => row[field] !== anchor.row[field])) continue;
    if (comparable.has(row.projection_facility_id)) continue;
    const pressure = 1 - 1 / (1 + caseload / capacity);
    const comparisonScore = (adjustedDetour / detourLimit + pressure) / 2;
    comparable.add(row.projection_facility_id);
    result.projectedLoad = {
      caseload, capacity, pressure, comparisonScore, extraTravelKm,
      unit: row.unit, scope: row.scope, period: row.period,
      caseloadPredicted: key(row.caseload_predicted) === "true",
      capacityPredicted: key(row.capacity_predicted) === "true",
      sourceUrl: row.source_url,
      capacitySourceUrl: row.capacity_source_url,
    };
    if (comparisonScore < winningScore) {
      winner = index;
      winningScore = comparisonScore;
    }
  }
  if (comparable.size < 2) {
    delete baseline.projectedLoad;
    return 0;
  }
  if (winner > 0) {
    ranked.unshift(...ranked.splice(winner, 1));
  }
  return comparable.size;
}

export function rankFacilities(data, {
  service, origin, sort = "recommended", severity = "routine", considerLoad = false, limit = 5, routeMatrix = null,
  fitWeights = DEFAULT_FIT_WEIGHTS, priorities = [],
}) {
  const ranked = [];
  const explicitSort = Object.hasOwn(OTHER_SORTS, sort);
  let candidateCount = 0;
  let lowConfidenceCount = 0;
  let unknownFitCount = 0;
  const penaltyScale = routeMatrix ? MINUTES_PER_KM_EQUIVALENT : 1;
  const assessments = Object.hasOwn(data.matches, service) ? data.matches[service] : [];
  for (const assessment of assessments) {
    const facility = data.facilities[assessment.index];
    if (!facility || !inIndia(facility.lat, facility.lon) || !assessment.term || !assessment.excerpt) continue;
    if (assessment.kind !== "mention" && !EXACT_EVIDENCE.has(assessment.kind)) continue;
    if (!Number.isFinite(assessment.confidence)) continue;
    if (assessment.match !== 40 && assessment.match !== 100) continue;
    if (routeMatrix && !routeMatrix.secondsByIndex.has(assessment.index)) continue;
    candidateCount++;
    if (assessment.confidence < MIN_CONFIDENCE) {
      lowConfidenceCount++;
      continue;
    }
    const fit = assessFit(facility, assessment, data.classifiedAsOf, fitWeights);
    if (fit.fitScore === 0) continue;
    if (fit.fitScore === null) {
      unknownFitCount++;
      if (!explicitSort) continue;
    }
    const distanceKm = haversineKm(routeMatrix?.routedOrigin ?? origin, facility);
    const travelMinutes = routeMatrix ? routeMatrix.secondsByIndex.get(assessment.index) / 60 : null;
    const travel = travelMinutes ?? distanceKm;
    const confidenceCost = confidencePenalty(assessment.confidence) * penaltyScale;
    ranked.push({
      facility,
      assessment,
      distanceKm,
      travelMinutes,
      driveMinutes: routeMatrix?.travelMode === "driving" ? travelMinutes : null,
      scoreParts: {travel, confidencePenalty: confidenceCost},
      recommendedScore: travel + confidenceCost,
      ...fit, fitTier: fitTier(fit.fitScore),
      priorityScore: null, priorityParts: [],
    });
  }
  if (sort === "priorities") scorePriorities(ranked, priorities);
  const compare = explicitSort ? OTHER_SORTS[sort] : null;
  ranked.sort(compare ? (left, right) => compare(left, right) || compareRecommended(left, right) : compareRecommended);
  ranked.forEach((result, index) => {
    result.baselineRank = index + 1;
  });
  const baselineFirst = ranked[0]?.facility ?? null;

  let loadStatus = "off";
  let comparisonCount = 0;
  if (considerLoad) {
    const urgentService = TIME_CRITICAL_SERVICES.has(service) || data.services.find(option => option.label === service)?.urgent;
    if (key(severity) !== "routine" || urgentService) {
      loadStatus = "urgency";
    } else if (sort !== "recommended") {
      loadStatus = "sort";
    } else {
      comparisonCount = compareProjectedLoad(ranked, data.projections, service);
      loadStatus = comparisonCount ? (ranked[0].baselineRank === 1 ? "compared" : "changed") : "unavailable";
    }
  }
  return {results: ranked.slice(0, limit), candidateCount, lowConfidenceCount, unknownFitCount,
    comparisonCount, baselineFirst, loadStatus};
}
