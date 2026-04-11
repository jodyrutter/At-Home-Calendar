const state = {
  libraries: [],
  activeLibraryId: "",
  currentPath: "",
  breadcrumbs: [],
  directories: [],
  files: [],
  searchQuery: "",
  searchResults: [],
  activeType: "all",
  truncated: false
};

const elements = {
  libraryLabel: document.querySelector("#gallery-library-label"),
  pathLabel: document.querySelector("#gallery-path-label"),
  summary: document.querySelector("#gallery-summary"),
  libraryTabs: document.querySelector("#library-tabs"),
  searchInput: document.querySelector("#gallery-search"),
  searchStatus: document.querySelector("#search-status"),
  folderList: document.querySelector("#folder-list"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  typeFilters: document.querySelector("#type-filters"),
  mediaGrid: document.querySelector("#media-grid"),
  viewerModal: document.querySelector("#viewer-modal"),
  viewerTitle: document.querySelector("#viewer-title"),
  viewerMeta: document.querySelector("#viewer-meta"),
  viewerBody: document.querySelector("#viewer-body"),
  emptyStateTemplate: document.querySelector("#empty-state-template")
};

const mediaTypeLabels = {
  all: "All",
  image: "Photos",
  video: "Videos",
  panorama: "Panoramas",
  raw: "RAW"
};

function debounce(fn, delay) {
  let timeoutId = null;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Request failed.");
  }
  return response.json();
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function activeLibrary() {
  return state.libraries.find((library) => library.id === state.activeLibraryId) || null;
}

function activeFiles() {
  const source = state.searchQuery.trim() ? state.searchResults : state.files;
  if (state.activeType === "all") {
    return source;
  }
  return source.filter((file) => file.mediaType === state.activeType);
}

async function loadLibraries() {
  const payload = await api("/api/media/libraries");
  state.libraries = payload.libraries || [];

  if (state.libraries.length === 0) {
    render();
    return;
  }

  if (!state.activeLibraryId) {
    state.activeLibraryId = state.libraries[0].id;
  }

  await browseLibrary("");
}

async function browseLibrary(relativePath) {
  const payload = await api(`/api/media/browse?library=${encodeURIComponent(state.activeLibraryId)}&path=${encodeURIComponent(relativePath)}&type=${encodeURIComponent(state.activeType)}`);
  state.currentPath = payload.currentPath;
  state.breadcrumbs = payload.breadcrumbs;
  state.directories = payload.directories;
  state.files = payload.files;
  state.truncated = Boolean(payload.truncated);
  state.searchResults = [];
  state.searchQuery = "";
  elements.searchInput.value = "";
  render();
}

async function searchLibrary(query) {
  state.searchQuery = query.trim();
  if (!state.searchQuery) {
    state.searchResults = [];
    render();
    return;
  }

  const payload = await api(`/api/media/search?library=${encodeURIComponent(state.activeLibraryId)}&path=${encodeURIComponent(state.currentPath)}&q=${encodeURIComponent(state.searchQuery)}&type=${encodeURIComponent(state.activeType)}`);
  state.searchResults = payload.results || [];
  state.truncated = Boolean(payload.truncated);
  render();
}

function render() {
  renderHeader();
  renderLibraryTabs();
  renderFolders();
  renderBreadcrumbs();
  renderTypeFilters();
  renderMediaGrid();
}

function renderHeader() {
  const library = activeLibrary();
  const visibleFiles = activeFiles();
  elements.libraryLabel.textContent = library ? library.label : "No libraries configured";
  elements.pathLabel.textContent = state.searchQuery
    ? `Search results for "${state.searchQuery}"`
    : state.currentPath
      ? state.currentPath
      : "Showing the whole library";

  elements.summary.innerHTML = `
    <div class="summary-card">
      <strong>${state.libraries.length}</strong>
      <span>Configured libraries</span>
    </div>
    <div class="summary-card">
      <strong>${state.directories.length}</strong>
      <span>Folders in this view</span>
    </div>
    <div class="summary-card">
      <strong>${visibleFiles.length}</strong>
      <span>Visible media items</span>
    </div>
  `;

  const statusBase = state.searchQuery
    ? `${state.searchResults.length} match${state.searchResults.length === 1 ? "" : "es"} in the current scope`
    : state.currentPath
      ? `Showing media from this folder and its subfolders`
      : "Showing media from the whole library";
  elements.searchStatus.textContent = state.truncated
    ? `${statusBase}. Results are capped to keep the page fast.`
    : statusBase;
}

function renderLibraryTabs() {
  elements.libraryTabs.innerHTML = "";

  if (state.libraries.length === 0) {
    const empty = emptyStateNode("No media libraries are configured yet.");
    elements.libraryTabs.append(empty);
    return;
  }

  state.libraries.forEach((library) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "library-tab";
    button.dataset.active = String(library.id === state.activeLibraryId);
    button.innerHTML = `<span>${library.label}</span><span>&rsaquo;</span>`;
    button.addEventListener("click", async () => {
      state.activeLibraryId = library.id;
      state.activeType = "all";
      await browseLibrary("");
    });
    elements.libraryTabs.append(button);
  });
}

function renderFolders() {
  elements.folderList.innerHTML = "";

  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.className = "folder-link";
  rootButton.innerHTML = "<span>Whole library</span><span>&uarr;</span>";
  rootButton.addEventListener("click", () => browseLibrary(""));
  elements.folderList.append(rootButton);

  if (state.directories.length === 0) {
    elements.folderList.append(emptyStateNode("No subfolders in this location."));
    return;
  }

  state.directories.forEach((directory) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-link";
    button.innerHTML = `<span>${directory.name}</span><span>&rsaquo;</span>`;
    button.addEventListener("click", () => browseLibrary(directory.path));
    elements.folderList.append(button);
  });
}

function renderBreadcrumbs() {
  elements.breadcrumbs.innerHTML = "";
  state.breadcrumbs.forEach((crumb) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "breadcrumb-button";
    button.textContent = crumb.name;
    button.addEventListener("click", () => browseLibrary(crumb.path));
    elements.breadcrumbs.append(button);
  });
}

function renderTypeFilters() {
  elements.typeFilters.innerHTML = "";
  Object.entries(mediaTypeLabels).forEach(([type, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "member-chip";
    button.dataset.active = String(state.activeType === type);
    button.textContent = label;
    button.addEventListener("click", async () => {
      state.activeType = type;
      if (state.searchQuery.trim()) {
        await searchLibrary(state.searchQuery);
      } else {
        await browseLibrary(state.currentPath);
      }
    });
    elements.typeFilters.append(button);
  });
}

function renderMediaGrid() {
  elements.mediaGrid.innerHTML = "";
  const files = activeFiles();

  if (files.length === 0) {
    elements.mediaGrid.append(emptyStateNode("No media found for this filter."));
    return;
  }

  files.forEach((file) => {
    elements.mediaGrid.append(mediaCard(file));
  });
}

function mediaCard(file) {
  const article = document.createElement("article");
  article.className = "media-card";
  article.innerHTML = `
    <button type="button" class="media-card-thumb"></button>
    <div>
      <h3 class="media-card-title">${file.name}</h3>
      <p class="media-card-meta">${file.path}</p>
      <p class="media-card-meta">${mediaTypeLabels[file.mediaType] || file.mediaType} | ${formatBytes(file.size)} | ${formatTimestamp(file.modifiedAt)}</p>
    </div>
  `;

  const thumbButton = article.querySelector(".media-card-thumb");
  if (file.mediaType === "image") {
    const image = document.createElement("img");
    image.src = file.url;
    image.alt = file.name;
    image.loading = "lazy";
    image.decoding = "async";
    thumbButton.append(image);
  } else if (file.mediaType === "video") {
    const video = document.createElement("video");
    video.src = file.url;
    video.preload = "metadata";
    video.muted = true;
    thumbButton.append(video);
  } else if (file.mediaType === "panorama") {
    thumbButton.innerHTML = '<div class="media-placeholder">Panorama<br />HTML view</div>';
  } else {
    thumbButton.innerHTML = '<div class="media-placeholder">RAW file<br />download only</div>';
  }

  thumbButton.addEventListener("click", () => openViewer(file));
  return article;
}

function emptyStateNode(message) {
  const node = elements.emptyStateTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector("p").textContent = message;
  return node;
}

function openViewer(file) {
  elements.viewerTitle.textContent = file.name;
  elements.viewerMeta.textContent = `${file.path} | ${mediaTypeLabels[file.mediaType] || file.mediaType} | ${formatBytes(file.size)} | ${formatTimestamp(file.modifiedAt)}`;
  elements.viewerBody.innerHTML = "";

  if (file.mediaType === "image") {
    const image = document.createElement("img");
    image.src = file.url;
    image.alt = file.name;
    elements.viewerBody.append(image);
  } else if (file.mediaType === "video") {
    const video = document.createElement("video");
    video.src = file.url;
    video.controls = true;
    video.preload = "metadata";
    elements.viewerBody.append(video);
  } else if (file.mediaType === "panorama") {
    const iframe = document.createElement("iframe");
    iframe.src = file.url;
    iframe.title = file.name;
    iframe.sandbox = "allow-scripts allow-same-origin";
    elements.viewerBody.append(iframe);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "media-placeholder";
    placeholder.textContent = "This RAW file does not have an in-browser preview.";
    elements.viewerBody.append(placeholder);
  }

  const download = document.createElement("a");
  download.className = "button button-secondary viewer-download";
  download.href = file.url;
  download.target = "_blank";
  download.rel = "noopener";
  download.textContent = file.mediaType === "raw" ? "Open file" : "Open in new tab";
  elements.viewerBody.append(download);
  elements.viewerModal.showModal();
}

function bindEvents() {
  const debouncedSearch = debounce((value) => {
    searchLibrary(value).catch((error) => {
      elements.searchStatus.textContent = error.message;
    });
  }, 250);

  elements.searchInput.addEventListener("input", (event) => {
    debouncedSearch(event.target.value);
  });

  document.querySelector("#close-viewer-modal").addEventListener("click", () => {
    elements.viewerModal.close();
  });
}

bindEvents();
loadLibraries().catch((error) => {
  elements.mediaGrid.innerHTML = "";
  elements.mediaGrid.append(emptyStateNode(error.message));
});
