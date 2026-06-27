const state = {
  raw: null,
  items: [],
  videos: [],
  categories: [],
  errors: [],
  activeCategory: "all",
  query: "",
};

const els = {
  cards: document.querySelector("#cards"),
  status: document.querySelector("#status"),
  search: document.querySelector("#searchInput"),
  filters: document.querySelector("#categoryFilters"),
  clearFilters: document.querySelector("#clearFilters"),
  cardTemplate: document.querySelector("#cardTemplate"),
  ideaCount: document.querySelector("#ideaCount"),
  videoCount: document.querySelector("#videoCount"),
  categoryCount: document.querySelector("#categoryCount"),
  errorCount: document.querySelector("#errorCount"),
  playlistForm: document.querySelector("#playlistForm"),
  playlistInput: document.querySelector("#playlistInput"),
  commandOutput: document.querySelector("#commandOutput"),
  commandHint: document.querySelector("#commandHint"),
};

const DEFAULT_CATEGORIES = [
  "Business",
  "Marketing",
  "Vente",
  "Productivite",
  "Mindset",
  "Sport / sante",
  "Developpement personnel",
  "Finance",
  "Creation de contenu",
  "IA / automatisation",
  "Autre",
];

init();

async function init() {
  hydratePlaylistInput();
  bindEvents();

  try {
    const response = await fetch("data.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`data.json introuvable (${response.status})`);
    }
    const data = await response.json();
    applyData(normalizeData(data));
  } catch (error) {
    showStatus(
      "Impossible de charger data.json. Lancez npm run analyze apres avoir renseigne une playlist, puis rechargez la page.",
    );
    applyData(normalizeData({ categories: DEFAULT_CATEGORIES, items: [], videos: [], metadata: {} }));
  }
}

function bindEvents() {
  els.search.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    render();
  });

  els.clearFilters.addEventListener("click", () => {
    state.activeCategory = "all";
    render();
  });

  els.playlistForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = els.playlistInput.value.trim();
    if (!value) {
      showStatus("Ajoutez une URL de playlist YouTube avant de preparer la commande.");
      return;
    }
    localStorage.setItem("knowledgeHubPlaylist", value);
    renderCommand(value);
  });
}

function hydratePlaylistInput() {
  const stored = localStorage.getItem("knowledgeHubPlaylist");
  if (stored) {
    els.playlistInput.value = stored;
    renderCommand(stored);
  }
}

function renderCommand(url) {
  els.commandOutput.hidden = false;
  els.commandOutput.textContent = `npm run analyze -- --playlist "${url}"`;
  els.commandHint.textContent =
    "Commande locale prete. Sur GitHub, mettez cette URL dans config.json: le workflow mettra data.json a jour automatiquement.";
}

function normalizeData(data) {
  if (Array.isArray(data)) {
    const groupedItems = data.flatMap((group) =>
      (group.items || []).map((item) => ({ ...item, category: item.category || group.category || "Autre" })),
    );
    return {
      categories: data.map((group) => group.category).filter(Boolean),
      items: groupedItems,
      videos: [],
      errors: [],
      raw: data,
    };
  }

  const groupedItems = Array.isArray(data.grouped)
    ? data.grouped.flatMap((group) =>
        (group.items || []).map((item) => ({ ...item, category: item.category || group.category || "Autre" })),
      )
    : [];

  const items = Array.isArray(data.items) && data.items.length ? data.items : groupedItems;
  const categories = Array.isArray(data.categories) && data.categories.length ? data.categories : DEFAULT_CATEGORIES;
  const errors = data.metadata?.errors || data.errors || [];

  return {
    categories,
    items: items.map(cleanItem),
    videos: data.videos || [],
    errors,
    raw: data,
  };
}

function cleanItem(item) {
  return {
    id: item.id || crypto.randomUUID(),
    category: item.category || "Autre",
    title: item.title || "Idee sans titre",
    summary: item.summary || "Resume indisponible.",
    source_video: item.source_video || "Video source",
    video_url: item.video_url || "#",
    channel: item.channel || "",
    duration: item.duration || "",
  };
}

function applyData(data) {
  state.raw = data.raw;
  state.items = data.items;
  state.videos = data.videos;
  state.categories = mergeCategories(data.categories, data.items);
  state.errors = data.errors;

  if (!state.items.length) {
    showStatus(
      "Aucune idee n'a encore ete generee. Renseignez une playlist puis lancez npm run analyze pour produire la base de connaissances.",
    );
  } else {
    hideStatus();
  }

  render();
}

function mergeCategories(categories, items) {
  const seen = new Set();
  return [...categories, ...items.map((item) => item.category)]
    .filter(Boolean)
    .filter((category) => {
      if (seen.has(category)) return false;
      seen.add(category);
      return true;
    });
}

function render() {
  renderStats();
  renderFilters();
  renderCards();
}

function renderStats() {
  const activeCategories = new Set(state.items.map((item) => item.category));
  els.ideaCount.textContent = String(state.items.length);
  els.videoCount.textContent = String(state.videos.filter((video) => video.transcript_status === "available").length);
  els.categoryCount.textContent = String(activeCategories.size);
  els.errorCount.textContent = String(state.errors.length);
}

function renderFilters() {
  const counts = state.items.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {});

  els.filters.replaceChildren(
    ...state.categories.map((category) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `filter-button${state.activeCategory === category ? " active" : ""}`;
      button.innerHTML = `<span>${escapeHtml(category)}</span><span>${counts[category] || 0}</span>`;
      button.addEventListener("click", () => {
        state.activeCategory = category;
        render();
      });
      return button;
    }),
  );
}

function renderCards() {
  const filtered = state.items.filter(matchesFilters);

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.items.length
      ? "Aucune idee ne correspond a cette recherche."
      : "Les cartes apparaitront ici apres generation de data.json.";
    els.cards.replaceChildren(empty);
    return;
  }

  const cards = filtered.map((item) => {
    const node = els.cardTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".badge").textContent = item.category;
    node.querySelector(".duration").textContent = item.duration || "";
    node.querySelector("h3").textContent = item.title;
    node.querySelector(".summary").textContent = item.summary;
    node.querySelector(".source-title").textContent = item.source_video;
    node.querySelector(".source-channel").textContent = item.channel || "Chaine non renseignee";
    node.querySelector(".video-link").href = item.video_url;
    return node;
  });

  els.cards.replaceChildren(...cards);
}

function matchesFilters(item) {
  const matchesCategory = state.activeCategory === "all" || item.category === state.activeCategory;
  if (!matchesCategory) return false;
  if (!state.query) return true;

  const haystack = [
    item.category,
    item.title,
    item.summary,
    item.source_video,
    item.channel,
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(state.query);
}

function showStatus(message) {
  els.status.textContent = message;
  els.status.classList.add("visible");
}

function hideStatus() {
  els.status.classList.remove("visible");
  els.status.textContent = "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
