import { DEFAULT_FIT_WEIGHTS, TRAVEL_MODES } from "./ranking.js?v=6fd04098";

const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-IN", { style: "percent", maximumFractionDigits: 0 });
const evidenceLabels = {
  corroborated: "Hospital source and independent corroboration",
  hospital_site: "Listed by the hospital",
  directory: "Listed in a reviewed directory",
  record_listing: "Listed in the facility record",
  mention: "Mentioned in the facility record",
};
const criterionLabels = {
  travel: "Journey length", distance: "Journey length", evidence: "Service evidence",
  capability: "Equipment and staff", availability: "Round-the-clock operation",
  quality: "Accreditation and rating", freshness: "Record freshness", spare: "Spare capacity",
};
const capacityLabels = {
  xgboost_estimate: "XGBoost model estimate", fdr_reported: "Facility Data Registry",
  dated_external_report: "Dated external report", explicit_fdr_description: "Facility Data Registry description",
  direct_review: "Direct source review", approved_source_recovery: "Reviewed source recovery",
  review_unresolved: "Withheld pending review", missing: "Missing from the release",
};
const emptyText = /^(?:n\/a|null|none|nan)$/i;
const fitRanges = ["above 0 to under 50", "50 to under 55", "55 to under 60", "60–100"];

function text(value) {
  const string = String(value ?? "").trim();
  return emptyText.test(string) ? "" : string;
}

function node(tag, content = "", className = "") {
  const element = document.createElement(tag);
  if (content) element.append(content);
  if (className) element.className = className;
  return element;
}

function link(label, url) {
  try {
    const address = new URL(url);
    if (!["https:", "http:"].includes(address.protocol) || address.username || address.password) return null;
    const result = node("a", label);
    result.href = address.href;
    result.target = "_blank";
    result.rel = "noopener noreferrer";
    return result;
  } catch {
    return null;
  }
}

function links(pairs) {
  const row = node("div", "", "card-links");
  for (const [title, url] of pairs) {
    const anchor = link(title, url);
    if (anchor) row.append(anchor);
  }
  return row;
}

function addressOf(facility) {
  return text(facility.address).split(",").map(text).filter(Boolean).join(", ") || "Not listed";
}

function phoneOf(facility) {
  const display = text(facility.phone);
  if (!display) return "Not listed";
  const numbers = display.split(/\s*(?:;|\/|,|\s+or\s+)\s*/i);
  const group = node("span");
  numbers.forEach((item, i) => {
    if (i) group.append(" / ");
    const dial = item.replace(/[\s().-]/g, "");
    if (/^\+?\d{7,15}$/.test(dial)) {
      const anchor = node("a", item);
      anchor.href = "tel:" + dial;
      group.append(anchor);
    } else {
      group.append(item);
    }
  });
  return group;
}

function hoursOf(facility) {
  return text(facility.hours) || (facility.open24h === true ? "Open 24 hours, per facility record" : "Not listed");
}

function bedsOf(facility) {
  const status = text(facility.capacityStatus);
  const value = facility.beds;
  const source = text(facility.capacitySource);
  const provenance = capacityLabels[status] || status.replaceAll("_", " ");
  if (!Number.isFinite(value) || value <= 0 || ["review_unresolved", "missing"].includes(status)) {
    return { label: "Capacity (beds)", value: "Unavailable", detail: "Capacity unavailable. " + (provenance || "No published capacity figure.") };
  }
  const estimate = /estimat|model|predict/i.test(status);
  const description = [provenance, source && source !== "FDR" ? source.replaceAll("_", " ") : ""].filter(Boolean).join(" · ");
  const range = estimate && Number.isFinite(facility.bedsLow) && Number.isFinite(facility.bedsHigh)
    ? `. Published prediction range ${number.format(facility.bedsLow)}–${number.format(facility.bedsHigh)} beds` : "";
  return {
    label: estimate ? "Estimated capacity (beds)" : "Reported capacity (beds)", value: number.format(value),
    detail: `${estimate ? "Estimated" : "Reported"} capacity of ${number.format(value)} beds${description ? " · " + description : ""}${range}.`,
  };
}

function directionsTo(facility, origin, travelMode) {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", `${facility.lat},${facility.lon}`);
  if (origin) url.searchParams.set("origin", `${origin.lat},${origin.lon}`);
  url.searchParams.set("travelmode", TRAVEL_MODES[travelMode].mapsMode);
  return url.href;
}

function facts(rows, className) {
  const list = node("dl", "", className);
  for (const [title, value] of rows) {
    const term = node("dt", title), definition = node("dd", value);
    if (className === "card-facts") list.append(term, definition);
    else {
      const pair = node("div");
      pair.append(term, definition);
      list.append(pair);
    }
  }
  return list;
}

function details(title) {
  const element = node("details", "", "card-details");
  element.append(node("summary", title));
  return element;
}

function table(headers, rows, className, label) {
  const grid = node("table", "", className);
  grid.setAttribute("aria-label", label);
  const head = grid.createTHead().insertRow();
  for (const name of headers) {
    const heading = node("th", name);
    heading.scope = "col";
    head.append(heading);
  }
  const body = grid.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) row.insertCell().append(value);
  }
  return grid;
}

function section(title, bullets) {
  const area = node("section", "", "card-section");
  const list = node("ul", "", "card-reasons");
  for (const bullet of bullets) list.append(node("li", bullet));
  area.append(node("h4", title), list);
  return area;
}

export function formatTravelTime(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return "Unavailable";
  if (minutes < 1) return "Under 1 min";
  const wholeMinutes = Math.round(minutes);
  const hours = Math.floor(wholeMinutes / 60);
  const remainder = wholeMinutes % 60;
  if (!hours) return `${remainder} min`;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function routingMetric(result, travelMode) {
  if (!Number.isFinite(result.travelMinutes)) return null;
  return [TRAVEL_MODES[travelMode].label + " time", formatTravelTime(result.travelMinutes)];
}

function rankExplanation(result, index, options) {
  if (options.sort !== "recommended") return "";
  if (index === 0 && result.projectedLoad && result.baselineRank > 1)
    return `The workload comparison moved this facility up from #${result.baselineRank} within the same fit range.`;
  const later = options.activeResults?.slice(index + 1) ?? [];
  const routed = Number.isFinite(result.travelMinutes);
  const displayMeasure = row => routed ? formatTravelTime(row.travelMinutes) : number.format(row.distanceKm);
  const shorter = later.filter(row => row.fitScore > 0 && row.scoreParts.travel < result.scoreParts.travel
    && displayMeasure(row) !== displayMeasure(result));
  const lowerFit = shorter.find(row => row.fitTier < result.fitTier);
  const alternative = lowerFit || shorter.find(row => row.fitTier === result.fitTier
    && result.assessment.confidence > row.assessment.confidence && result.recommendedScore < row.recommendedScore);
  if (!alternative) return "";
  const rank = index + 2 + later.indexOf(alternative);
  const journey = routed ? `a shorter estimated ${TRAVEL_MODES[options.travelMode].trip} (${displayMeasure(alternative)})`
    : `a shorter straight-line distance (${displayMeasure(alternative)} km)`;
  const reason = lowerFit ? `Its documented fit of ${number.format(alternative.fitScore)}/100 places it in a lower fit range.`
    : `Within the same fit range, its lower service confidence (${number.format(alternative.assessment.confidence)}/100) puts it behind this facility.`;
  return `#${rank} ${alternative.facility.name} has ${journey}. ${reason}`;
}

function reasons(result, options) {
  const {assessment, facility} = result;
  const why = [`The service evidence matches “${assessment.term}”.`];
  const mode = routingMetric(result, options.travelMode);
  if (mode) why.push(`${mode[1]} by ${TRAVEL_MODES[options.travelMode].label.toLowerCase()} on a typical weekday morning.`);
  if (assessment.matchedEquipment?.length) why.push("Documented equipment: " + assessment.matchedEquipment.join(", ") + ".");
  if (assessment.matchedStaff?.length) why.push("Documented staff: " + assessment.matchedStaff.join(", ") + ".");
  if (facility.open24h === true) why.push("The facility record mentions round-the-clock operation.");
  if (text(facility.accreditation)) why.push("Accreditation on record: " + facility.accreditation + ".");
  if (Number.isFinite(facility.rating)) why.push(`Recorded facility rating: ${number.format(facility.rating)}/5.`);
  const caveats = [];
  if (options.serviceInfo && Array.isArray(assessment.matchedEquipment) && Array.isArray(assessment.matchedStaff)) {
    const equipment = (options.serviceInfo.equipment || []).filter(item => !assessment.matchedEquipment.includes(item));
    const staff = (options.serviceInfo.staff || []).filter(item => !assessment.matchedStaff.includes(item));
    const missing = [...equipment, ...staff];
    if (missing.length) caveats.push("The reviewed text does not document " + missing.join(", ") + ". Ask the branch about these resources.");
  }
  if (options.serviceInfo?.urgent && facility.open24h !== true) caveats.push("Round-the-clock service at this branch is unconfirmed.");
  if (!Number.isFinite(facility.occupancy)) caveats.push("Current occupancy and available capacity are unknown.");
  if (facility.lastVerified) caveats.push("Branch record last verified " + facility.lastVerified + ".");
  else caveats.push("The branch record has no verification date.");
  if (!mode) caveats.push("The routing service did not supply a journey time. Distance is measured in a straight line.");
  return [section("Why this facility", why), section("Caveats", caveats)];
}

function sourceEvidence(result, options) {
  const {assessment, facility} = result;
  const evidence = details("Service evidence and sources");
  evidence.append(node("p", `${evidenceLabels[assessment.kind]} · service evidence ${assessment.servicePoints}/80 · branch identity ${assessment.branchPoints}/20.`));
  evidence.append(node("p", "Matched service text: " + assessment.term));
  if (assessment.excerpt) evidence.append(node("blockquote", assessment.excerpt));
  const refs = links((assessment.urls || []).map((url, i) => ["Service source " + (i + 1), url]));
  if (refs.childElementCount) evidence.append(refs);
  else evidence.append(node("p", "No separate source link is listed for this text."));
  evidence.append(node("p", bedsOf(facility).detail));
  const sources = links([
    ["Capacity source", facility.capacitySourceUrl], ["Phone source", facility.phoneSourceUrl],
    ["Published facility release", options.sourceUrl],
  ]);
  if (sources.childElementCount) evidence.append(sources);
  const source = [text(facility.source), facility.id, options.snapshotDate ? "Service assessment " + options.snapshotDate : ""].filter(Boolean);
  if (source.length) evidence.append(node("p", source.join(" · "), "card-note"));
  return evidence;
}

function scoreBreakdown(result, options) {
  const panel = details("Fit breakdown and ranking");
  const {fitComponents, scoreParts, priorityParts} = result;
  if (fitComponents) {
    const weights = options.fitWeights ?? DEFAULT_FIT_WEIGHTS;
    const includedWeight = Object.entries(fitComponents).reduce((sum, [key, value]) =>
      sum + (Number.isFinite(value) && weights[key] > 0 ? weights[key] : 0), 0);
    const rows = Object.entries(fitComponents).map(([key, value]) => {
      const recorded = Number.isFinite(value);
      const share = includedWeight && recorded ? percent.format((weights[key] || 0) / includedWeight) : "—";
      return [criterionLabels[key] || key, recorded ? number.format(value * 100) + "/100" : "Not recorded", share];
    });
    panel.append(table(["Fit component", "Record", "Share of fit"], rows, "score-table", "Fit components"));
    panel.append(node("p", includedWeight
      ? `The documented components share the weight according to your settings. Their weighted average is multiplied by this branch’s service match of ${result.assessment.match}/100.`
      : "The record has no scored component under the selected weights."));
  }
  if (options.sort === "recommended" && scoreParts) {
    const units = Number.isFinite(result.travelMinutes) ? "min equivalent" : "km equivalent";
    const items = [
      ["Travel", scoreParts.travel], ["Service confidence penalty", scoreParts.confidencePenalty],
      ["Confidence-adjusted total", result.recommendedScore],
    ];
    panel.append(table(["Recommended score component", units], items.map(([label, value]) => [label, number.format(value)]), "score-table", "Recommended score breakdown"));
    panel.append(node("p", `This facility’s fit range is ${fitRanges[result.fitTier]}. The confidence-adjusted total orders branches in that range. Confidence below about 60/100 carries a steeper penalty. Higher fit ranges rank first.`));
  }
  if (priorityParts?.length) {
    panel.append(table(["Personal priority", "Value", "Weight"], priorityParts.map(({criterion, value, weight}) =>
      [criterionLabels[criterion] || criterion, Number.isFinite(value) ? percent.format(value) : "Not recorded", percent.format(weight)]), "score-table", "Your ranked priorities"));
  }
  if (result.projectedLoad) panel.append(projectionDetails(result, options));
  return panel;
}

function projectionDetails(result, options) {
  const load = result.projectedLoad;
  const panel = node("section", "", "card-section");
  panel.append(node("h4", "Expected workload comparison"));
  panel.append(facts([
    [load.caseloadPredicted ? "Projected demand" : "Historical demand", `${number.format(load.caseload)} ${load.unit}/month`],
    [load.capacityPredicted ? "Modeled throughput" : "Reported throughput", `${number.format(load.capacity)} ${load.unit}/month`],
  ], "card-facts"));
  panel.append(node("p", `${load.scope} · ${load.period}. Planning estimate.`));
  panel.append(node("p", `Load comparison score ${load.comparisonScore.toFixed(3)} · lower ranks first · baseline rank #${result.baselineRank}.`));
  panel.append(links([["Demand source", load.sourceUrl], ["Throughput source", load.capacitySourceUrl], ["Projection methods", options.projectionSourceUrl]]));
  return panel;
}

export function resultCard(result, index, options) {
  const {facility, assessment} = result;
  const rank = index + 1;
  const card = node("article", "", "result-card");
  card.id = "facility-" + rank;
  card.tabIndex = -1;
  const name = node("h3", facility.name);
  name.id = "facility-title-" + rank;
  card.setAttribute("aria-labelledby", name.id);
  const header = node("div", "", "card-header");
  const numberPin = node("span", node("span", String(rank)), "rank");
  numberPin.setAttribute("role", "img");
  numberPin.setAttribute("aria-label", "Rank " + rank);
  const heading = node("div");
  const place = [...new Set([facility.city, facility.district, facility.state, facility.pin && "PIN " + facility.pin, facility.ownership].map(text).filter(Boolean))];
  const beds = bedsOf(facility);
  const travel = routingMetric(result, options.travelMode);
  const distance = ["Straight-line distance", number.format(result.distanceKm) + " km"];
  heading.append(name);
  if (place.length) heading.append(node("p", place.join(" · "), "card-place"));
  header.append(numberPin, heading, facts([travel ?? distance], "card-journey"));
  const metrics = [
    ["Documented fit (/100)", Number.isFinite(result.fitScore) ? number.format(result.fitScore) : "Unavailable"],
    ["Service confidence (/100)", number.format(assessment.confidence)],
    [beds.label, beds.value],
  ];
  if (travel) metrics.push(distance);
  if (Number.isFinite(facility.occupancy)) metrics.push(["Recorded occupancy", percent.format(facility.occupancy)]);
  const evidence = node("p", node("span", "Service evidence", "evidence-label"), "card-evidence");
  evidence.append(" ", node("strong", options.service), " · " + evidenceLabels[assessment.kind] + ".");
  if (assessment.kind === "mention") evidence.append(" Call this branch to confirm it offers the service.");
  card.append(header, evidence, facts(metrics, "card-metrics"));
  const explanation = rankExplanation(result, index, options);
  if (explanation) card.append(node("p", explanation, "rank-explanation"));
  if (result.priorityParts?.length) card.append(node("p", "Personal criteria score " + (Number.isFinite(result.priorityScore) ? number.format(result.priorityScore) + "/100" : "unavailable"), "card-note"));
  const actions = links([["Directions", directionsTo(facility, options.origin, options.travelMode)]]);
  const phone = node("span", text(facility.phone) ? "Phone " : "Phone not listed");
  if (text(facility.phone)) phone.append(phoneOf(facility));
  const locate = node("button", "Show on map", "button-text");
  locate.type = "button";
  locate.addEventListener("click", () => options.onShowMap(index));
  actions.prepend(phone, locate);
  const facilityDetails = details("Facility details");
  facilityDetails.append(facts([["Address", addressOf(facility)], ["Hours", hoursOf(facility)]], "card-facts"));
  const website = link("Facility website", facility.website);
  if (website) facilityDetails.append(website);
  facilityDetails.append(...reasons(result, options));
  const disclosures = node("div", "", "facility-disclosures");
  disclosures.append(facilityDetails, sourceEvidence(result, options), scoreBreakdown(result, options));
  card.append(actions, disclosures);
  return card;
}

export function contactsTable(results, {travelMode}) {
  const columns = ["#", "Facility", "Phone", "Hours", "Address", "Straight-line km", TRAVEL_MODES[travelMode].label + " time"];
  return table(columns, results.map(({facility, distanceKm, travelMinutes}, index) => [
    String(index + 1), facility.name, phoneOf(facility), hoursOf(facility), addressOf(facility),
    number.format(distanceKm), formatTravelTime(travelMinutes),
  ]), "classic-contacts", "Facility contact details in result order");
}

export function facilityPopup(result, index, {origin, travelMode}) {
  const {facility} = result;
  const popup = node("div", "", "facility-popup");
  const beds = bedsOf(facility);
  const travel = routingMetric(result, travelMode);
  popup.append(node("strong", `${index + 1}. ${facility.name}`));
  popup.append(facts([
    ["Address", addressOf(facility)], ["Phone", phoneOf(facility)], ["Hours", hoursOf(facility)],
    ["Straight-line distance", number.format(result.distanceKm) + " km"], ...(travel ? [travel] : []),
    [beds.label, beds.value],
  ], "card-facts"));
  popup.append(links([["Directions", directionsTo(facility, origin, travelMode)], ["Facility website", facility.website]]));
  popup.append(node("small", "Call to confirm current availability."));
  return popup;
}
