"use strict";
(() => {
  // src/pick-page.ts
  var FACES = [
    { slug: "babylon", name: "Babylon", thumb: "thumb-babylon.png", abbrev: "bb" },
    { slug: "mauna-kea", name: "Mauna Kea", thumb: "thumb-mauna-kea.png", abbrev: "mk" },
    { slug: "haleakala", name: "Haleakal\u0101", thumb: "thumb-haleakala.png", abbrev: "hk" },
    { slug: "hana", name: "Hana", thumb: "thumb-hana.png", abbrev: "hn" },
    { slug: "chandra", name: "Chandra", thumb: "thumb-chandra.png", abbrev: "ch" },
    { slug: "selene", name: "Selene", thumb: "thumb-selene.png", abbrev: "sl" },
    { slug: "geneva", name: "Geneva", thumb: "thumb-geneva.png", abbrev: "gn" },
    { slug: "basel", name: "Basel", thumb: "thumb-basel.png", abbrev: "bs" },
    { slug: "firenze", name: "Firenze", thumb: "thumb-firenze.png", abbrev: "fi" },
    { slug: "venezia", name: "Venezia", thumb: "thumb-venezia.png", abbrev: "vz" },
    { slug: "terra", name: "Terra", thumb: "thumb-terra.png", abbrev: "tr" },
    { slug: "miami", name: "Miami", thumb: "thumb-miami.png", abbrev: "mi" },
    { slug: "gaia", name: "Gaia", thumb: "thumb-gaia.png", abbrev: "ga" },
    { slug: "vienna", name: "Vienna", thumb: "thumb-vienna.png", abbrev: "vi" }
  ];
  var faceByAbbrev = new Map(FACES.map((f) => [f.abbrev, f]));
  var selectedOrder = [];
  var pickGrid = document.getElementById("pick-grid");
  var btnAll = document.getElementById("btn-all");
  var btnNone = document.getElementById("btn-none");
  var btnReorder = document.getElementById("btn-reorder");
  var btnDone = document.getElementById("btn-done");
  var sheetBackdrop = document.getElementById("sheet-backdrop");
  var sheetPanel = document.getElementById("sheet-panel");
  var sheetList = document.getElementById("sheet-list");
  var sheetDone = document.getElementById("sheet-done");
  var homeLink = document.getElementById("pick-home-link");
  function readPicksFromUrl() {
    const param = new URLSearchParams(window.location.search).get("picks");
    if (!param || param.length < 2) return [];
    const result = [];
    for (let i = 0; i + 1 < param.length; i += 2) {
      const abbrev = param.substring(i, i + 2);
      if (faceByAbbrev.has(abbrev)) {
        result.push(abbrev);
      }
    }
    return result;
  }
  function buildDoneUrl() {
    const params = new URLSearchParams(window.location.search);
    if (selectedOrder.length > 0) {
      params.set("picks", selectedOrder.join(""));
    } else {
      params.delete("picks");
    }
    const qs = params.toString();
    return "selected.html" + (qs ? "?" + qs : "");
  }
  function updateHomeLink() {
    const url = new URL("index.html", window.location.href);
    url.search = window.location.search;
    homeLink.href = url.toString();
  }
  var cardElements = /* @__PURE__ */ new Map();
  function buildGrid() {
    pickGrid.innerHTML = "";
    for (const face of FACES) {
      const card = document.createElement("div");
      card.className = "pick-card";
      card.dataset.abbrev = face.abbrev;
      const img = document.createElement("img");
      img.className = "pick-thumb";
      img.src = face.thumb;
      img.alt = face.name;
      img.loading = "lazy";
      const badge = document.createElement("span");
      badge.className = "pick-badge";
      const name = document.createElement("p");
      name.className = "pick-name";
      name.textContent = face.name;
      card.appendChild(img);
      card.appendChild(badge);
      card.appendChild(name);
      card.addEventListener("click", () => toggleFace(face.abbrev));
      pickGrid.appendChild(card);
      cardElements.set(face.abbrev, card);
    }
  }
  function toggleFace(abbrev) {
    const idx = selectedOrder.indexOf(abbrev);
    if (idx >= 0) {
      selectedOrder.splice(idx, 1);
    } else {
      selectedOrder.push(abbrev);
    }
    updateUI();
  }
  function selectAll() {
    selectedOrder = FACES.map((f) => f.abbrev);
    updateUI();
  }
  function selectNone() {
    selectedOrder = [];
    updateUI();
  }
  function updateUI() {
    for (const [abbrev, card] of cardElements) {
      const idx = selectedOrder.indexOf(abbrev);
      if (idx >= 0) {
        card.classList.add("selected");
        const badge = card.querySelector(".pick-badge");
        badge.textContent = String(idx + 1);
      } else {
        card.classList.remove("selected");
      }
    }
    const count = selectedOrder.length;
    btnReorder.disabled = count < 2;
    btnDone.disabled = count === 0;
  }
  function reorderGrid() {
    for (const abbrev of selectedOrder) {
      const card = cardElements.get(abbrev);
      if (card) pickGrid.appendChild(card);
    }
    for (const face of FACES) {
      if (!selectedOrder.includes(face.abbrev)) {
        const card = cardElements.get(face.abbrev);
        if (card) pickGrid.appendChild(card);
      }
    }
  }
  var sheetOpenTime = 0;
  function openSheet() {
    if (selectedOrder.length < 2) return;
    renderSheet();
    sheetBackdrop.classList.add("visible");
    sheetOpenTime = Date.now();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sheetPanel.classList.add("visible");
      });
    });
  }
  function closeSheet() {
    sheetPanel.classList.remove("visible");
    setTimeout(() => {
      sheetBackdrop.classList.remove("visible");
    }, 300);
  }
  function renderSheet() {
    sheetList.innerHTML = "";
    for (const abbrev of selectedOrder) {
      const face = faceByAbbrev.get(abbrev);
      if (!face) continue;
      const item = document.createElement("div");
      item.className = "sheet-item";
      item.dataset.abbrev = abbrev;
      const img = document.createElement("img");
      img.src = face.thumb;
      img.alt = face.name;
      const name = document.createElement("span");
      name.className = "sheet-name";
      name.textContent = face.name;
      const handle = document.createElement("span");
      handle.className = "sheet-handle";
      handle.textContent = "\u2261";
      handle.title = "Drag to reorder";
      item.appendChild(img);
      item.appendChild(name);
      item.appendChild(handle);
      sheetList.appendChild(item);
    }
    setupDragReorder();
  }
  function setupDragReorder() {
    const handles = sheetList.querySelectorAll(".sheet-handle");
    handles.forEach((handle) => {
      handle.addEventListener("touchstart", onDragStart, { passive: false });
      handle.addEventListener("mousedown", onDragStart);
    });
  }
  var dragItem = null;
  var dragStartY = 0;
  var dragOffsetY = 0;
  var dragInitialIndex = -1;
  function getItemIndex(item) {
    const items = Array.from(sheetList.querySelectorAll(".sheet-item"));
    return items.indexOf(item);
  }
  function onDragStart(e) {
    e.preventDefault();
    const handle = e.target.closest(".sheet-handle");
    if (!handle) return;
    dragItem = handle.closest(".sheet-item");
    if (!dragItem) return;
    dragItem.classList.add("dragging");
    dragInitialIndex = getItemIndex(dragItem);
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    const rect = dragItem.getBoundingClientRect();
    dragStartY = clientY;
    dragOffsetY = clientY - rect.top;
    document.addEventListener("touchmove", onDragMove, { passive: false });
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("touchend", onDragEnd);
    document.addEventListener("mouseup", onDragEnd);
  }
  function onDragMove(e) {
    if (!dragItem) return;
    e.preventDefault();
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    const items = Array.from(sheetList.querySelectorAll(".sheet-item"));
    const currentIndex = items.indexOf(dragItem);
    for (let i = 0; i < items.length; i++) {
      if (i === currentIndex) continue;
      const rect = items[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (i < currentIndex && clientY < midY) {
        sheetList.insertBefore(dragItem, items[i]);
        syncOrderFromSheet();
        break;
      } else if (i > currentIndex && clientY > midY) {
        if (items[i].nextSibling) {
          sheetList.insertBefore(dragItem, items[i].nextSibling);
        } else {
          sheetList.appendChild(dragItem);
        }
        syncOrderFromSheet();
        break;
      }
    }
  }
  function onDragEnd() {
    if (dragItem) {
      dragItem.classList.remove("dragging");
      dragItem = null;
    }
    document.removeEventListener("touchmove", onDragMove);
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("touchend", onDragEnd);
    document.removeEventListener("mouseup", onDragEnd);
    syncOrderFromSheet();
    updateUI();
  }
  function syncOrderFromSheet() {
    const items = sheetList.querySelectorAll(".sheet-item");
    selectedOrder = Array.from(items).map((item) => item.dataset.abbrev).filter((abbrev) => abbrev != null);
  }
  btnAll.addEventListener("click", selectAll);
  btnNone.addEventListener("click", selectNone);
  btnReorder.addEventListener("click", openSheet);
  btnDone.addEventListener("click", navigateDone);
  sheetBackdrop.addEventListener("click", () => {
    if (Date.now() - sheetOpenTime < 300) return;
    closeSheet();
  });
  sheetDone.addEventListener("click", () => {
    closeSheet();
    reorderGrid();
    updateUI();
  });
  function navigateDone() {
    if (selectedOrder.length === 0) return;
    window.location.href = buildDoneUrl();
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (sheetPanel.classList.contains("visible")) {
        closeSheet();
      } else {
        navigateDone();
      }
    }
  });
  (function init() {
    selectedOrder = readPicksFromUrl();
    buildGrid();
    if (selectedOrder.length > 0) {
      reorderGrid();
    }
    updateUI();
    updateHomeLink();
  })();
})();
