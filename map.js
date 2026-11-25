import { facilityPopup } from "./results.js?v=faa9e861";

const INDIA_BOUNDS = [[7.3, 68], [37.4, 97.7]];
const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/";
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Keep successful assets when retrying a failed stylesheet or script.
const assets = new Map();
function loadMapAsset(tag, file, integrity) {
  if (assets.has(file)) return assets.get(file);
  const pending = new Promise((resolve, reject) => {
    const element = document.createElement(tag);
    if (tag === "link") {
      element.rel = "stylesheet";
      element.href = LEAFLET + file;
    } else {
      element.src = LEAFLET + file;
    }
    element.integrity = integrity;
    element.crossOrigin = "anonymous";
    element.onload = resolve;
    element.onerror = () => {
      assets.delete(file);
      element.remove();
      reject(new Error("Could not load " + file));
    };
    document.head.append(element);
  });
  assets.set(file, pending);
  return pending;
}

function pin(className, text) {
  const element = document.createElement("span");
  element.className = className;
  const label = document.createElement("span");
  label.textContent = text;
  element.append(label);
  return element;
}

export function facilityMap({ street, feedback, retry, onSelect }) {
  let origin;
  let routedOrigin;
  let results = [];
  let travelMode = "driving";
  let active = null;
  let map, markers, tiles;
  let pins = [];

  function message(text) {
    feedback.textContent = text;
    retry.hidden = !text;
  }

  function fit() {
    const points = origin ? [origin, ...results.map(result => result.facility)].map(p => [p.lat, p.lon]) : INDIA_BOUNDS;
    if (routedOrigin) points.push([routedOrigin.lat, routedOrigin.lon]);
    map.fitBounds(points, {padding: [38, 38], maxZoom: origin ? 15 : 5, animate: false});
  }

  function highlight(index, focus = false) {
    if (!results[index]) return;
    active = index;
    for (const [i, marker] of pins.entries()) {
      marker.setZIndexOffset(i === index ? 200 : 0);
      marker.getElement().firstElementChild.dataset.active = String(i === index);
    }
    const selected = pins[index];
    if (selected && !selected.isPopupOpen()) selected.openPopup();
    if (focus) selected?.getElement().focus({preventScroll: true});
  }

  function render() {
    if (!map) return;
    map.invalidateSize();
    markers.clearLayers();
    fit(); // Set the initial view before Leaflet attaches the marker elements.
    const L = window.L;
    function startMarker(point, title, className, symbol) {
      const marker = L.marker([point.lat, point.lon], {
        title, icon: L.divIcon({className: "map-leaflet-pin", html: pin(className, symbol), iconSize: [30, 30], iconAnchor: [15, 15]}),
      }).bindTooltip(document.createTextNode(title)).addTo(markers);
      marker.getElement().setAttribute("aria-label", title);
    }
    if (origin) startMarker(origin, (routedOrigin ? "Entered location: " : "Your location: ") + origin.label, "map-origin", "⌂");
    if (routedOrigin) startMarker(routedOrigin, "Routing start: " + routedOrigin.label, "map-route-start", "➜");
    pins = results.map((result, index) => {
      const {facility} = result;
      const label = `${index + 1}. ${facility.name}`;
      const icon = pin("map-marker", index + 1);
      icon.dataset.rank = index;
      const marker = L.marker([facility.lat, facility.lon], {
        title: label, icon: L.divIcon({className: "map-leaflet-pin", html: icon, iconSize: [32, 36], iconAnchor: [16, 34], popupAnchor: [0, -27]}),
      }).bindPopup(() => facilityPopup(result, index, {origin: routedOrigin ?? origin, travelMode}), {maxWidth: 320, maxHeight: Math.max(140, street.clientHeight - 105)})
        .on("popupopen", () => {
          if (active !== index) onSelect(index);
        }).addTo(markers);
      marker.getElement().setAttribute("aria-label", label);
      return marker;
    });
    if (active !== null) highlight(active);
  }

  async function load() {
    message("");
    try {
      await Promise.all([
        loadMapAsset("link", "leaflet.css", "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="),
        loadMapAsset("script", "leaflet.js", "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="),
      ]);
    } catch {
      message("The street map couldn’t load.");
      return;
    }
    const L = window.L;
    map = L.map(street, {scrollWheelZoom: false});
    L.control.scale({imperial: false}).addTo(map);
    const fitControl = L.control({position: "topleft"});
    fitControl.onAdd = () => {
      const bar = L.DomUtil.create("div", "leaflet-bar");
      const button = L.DomUtil.create("button", "map-fit", bar);
      button.type = "button";
      button.textContent = "Fit";
      button.title = "Fit all locations";
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", fit);
      L.DomEvent.disableClickPropagation(bar);
      return bar;
    };
    fitControl.addTo(map);
    markers = L.layerGroup().addTo(map);
    tiles = L.tileLayer(TILE_URL, {maxZoom: 19, attribution: TILE_ATTRIBUTION});
    let receivedTile = false, failedTile = false;
    tiles.on("loading", () => { receivedTile = false; failedTile = false; });
    tiles.on("tileload", () => { receivedTile = true; message(""); });
    tiles.on("tileerror", () => { failedTile = true; });
    tiles.on("load", () => {
      if (failedTile && !receivedTile) message("Street map tiles couldn’t load for this area.");
    });
    tiles.addTo(map);
    render();
    new ResizeObserver(() => map.invalidateSize()).observe(street);
  }

  retry.addEventListener("click", () => {
    if (tiles) {
      message("");
      tiles.redraw();
    } else {
      load();
    }
  });
  load();

  return {
    show(newOrigin, newResults, options = {}) {
      origin = newOrigin;
      routedOrigin = options.routedOrigin;
      results = newResults;
      travelMode = options.travelMode || "driving";
      active = null;
      render();
    },
    highlight,
  };
}
