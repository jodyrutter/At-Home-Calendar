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
  currentPage: 1,
  pageSize: 48,
  totalPages: 1,
  totalMatches: 0,
  hasPreviousPage: false,
  hasNextPage: false,
  rangeStart: 0,
  rangeEnd: 0
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
  pagination: document.querySelector("#gallery-pagination"),
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

const videoQualityLabels = {
  auto: "Auto",
  original: "Original",
  p720: "720p"
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

function autoVideoQualityPreference() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const saveData = Boolean(connection?.saveData);
  const effectiveType = String(connection?.effectiveType || "").toLowerCase();
  const weakConnection = ["slow-2g", "2g", "3g"].includes(effectiveType);
  const lowMemory = Number.isFinite(navigator.deviceMemory) && navigator.deviceMemory <= 4;
  const lowCpu = Number.isFinite(navigator.hardwareConcurrency) && navigator.hardwareConcurrency <= 4;

  return saveData || weakConnection || lowMemory || lowCpu ? "p720" : "original";
}

function videoSourceForQuality(file, quality) {
  if (quality === "p720" && file.videoVariants?.p720) {
    return file.videoVariants.p720;
  }

  return file.videoVariants?.original || file.url;
}

async function getVideoProxyStatus(file, quality) {
  const payload = await api(
    `/api/media/video-proxy-status?library=${encodeURIComponent(state.activeLibraryId)}&path=${encodeURIComponent(file.path)}&quality=${encodeURIComponent(quality)}`
  );
  return Boolean(payload.ready);
}

async function prepareVideoProxy(file, quality) {
  const response = await fetch("/api/media/video-proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      library: state.activeLibraryId,
      path: file.path,
      quality
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Could not prepare video proxy.");
  }

  return response.json();
}

function activeLibrary() {
  return state.libraries.find((library) => library.id === state.activeLibraryId) || null;
}

function activeFiles() {
  return state.searchQuery.trim() ? state.searchResults : state.files;
}

function updatePagination(pagination) {
  state.currentPage = pagination?.currentPage || 1;
  state.pageSize = pagination?.pageSize || state.pageSize;
  state.totalPages = pagination?.totalPages || 1;
  state.totalMatches = pagination?.totalMatches || 0;
  state.hasPreviousPage = Boolean(pagination?.hasPreviousPage);
  state.hasNextPage = Boolean(pagination?.hasNextPage);
  state.rangeStart = pagination?.totalMatches ? (pagination.startIndex || 0) + 1 : 0;
  state.rangeEnd = pagination?.endIndex || 0;
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

async function browseLibrary(relativePath, page = 1) {
  const payload = await api(`/api/media/browse?library=${encodeURIComponent(state.activeLibraryId)}&path=${encodeURIComponent(relativePath)}&type=${encodeURIComponent(state.activeType)}&page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(state.pageSize)}`);
  state.currentPath = payload.currentPath;
  state.breadcrumbs = payload.breadcrumbs;
  state.directories = payload.directories;
  state.files = payload.files;
  updatePagination(payload.pagination);
  state.searchResults = [];
  state.searchQuery = "";
  elements.searchInput.value = "";
  render();
}

async function searchLibrary(query, page = 1) {
  state.searchQuery = query.trim();
  if (!state.searchQuery) {
    state.searchResults = [];
    state.currentPage = 1;
    state.totalPages = 1;
    state.totalMatches = state.files.length;
    state.hasPreviousPage = false;
    state.hasNextPage = false;
    state.rangeStart = state.files.length ? 1 : 0;
    state.rangeEnd = state.files.length;
    render();
    return;
  }

  const payload = await api(`/api/media/search?library=${encodeURIComponent(state.activeLibraryId)}&path=${encodeURIComponent(state.currentPath)}&q=${encodeURIComponent(state.searchQuery)}&type=${encodeURIComponent(state.activeType)}&page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(state.pageSize)}`);
  state.searchResults = payload.results || [];
  updatePagination(payload.pagination);
  render();
}

async function loadPage(page) {
  if (state.searchQuery.trim()) {
    await searchLibrary(state.searchQuery, page);
    return;
  }

  await browseLibrary(state.currentPath, page);
}

function render() {
  renderHeader();
  renderLibraryTabs();
  renderFolders();
  renderBreadcrumbs();
  renderTypeFilters();
  renderMediaGrid();
  renderPagination();
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
      <strong>${state.totalMatches}</strong>
      <span>Matching media items</span>
    </div>
  `;

  const rangeText = state.totalMatches === 0
    ? "No matching media yet"
    : `Showing ${state.rangeStart}-${state.rangeEnd} of ${state.totalMatches}`;
  const statusBase = state.searchQuery
    ? `${rangeText} search match${state.totalMatches === 1 ? "" : "es"} in the current scope`
    : state.currentPath
      ? `${rangeText} from this folder and its subfolders`
      : `${rangeText} from the whole library`;
  elements.searchStatus.textContent = statusBase;
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
      await browseLibrary("", 1);
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
  rootButton.addEventListener("click", () => browseLibrary("", 1));
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
    button.addEventListener("click", () => browseLibrary(directory.path, 1));
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
    button.addEventListener("click", () => browseLibrary(crumb.path, 1));
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
        await searchLibrary(state.searchQuery, 1);
      } else {
        await browseLibrary(state.currentPath, 1);
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

function renderPagination() {
  elements.pagination.innerHTML = "";

  if (state.totalMatches === 0) {
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "gallery-pagination-bar";

  const status = document.createElement("p");
  status.className = "gallery-pagination-status";
  status.textContent = `Page ${state.currentPage} of ${state.totalPages}`;

  const controls = document.createElement("div");
  controls.className = "gallery-pagination-controls";

  const previousButton = document.createElement("button");
  previousButton.type = "button";
  previousButton.className = "button button-secondary pagination-button";
  previousButton.textContent = "Previous";
  previousButton.disabled = !state.hasPreviousPage;
  previousButton.addEventListener("click", () => {
    loadPage(state.currentPage - 1).catch((error) => {
      elements.searchStatus.textContent = error.message;
    });
  });

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "button button-secondary pagination-button";
  nextButton.textContent = "Next";
  nextButton.disabled = !state.hasNextPage;
  nextButton.addEventListener("click", () => {
    loadPage(state.currentPage + 1).catch((error) => {
      elements.searchStatus.textContent = error.message;
    });
  });

  controls.append(previousButton, nextButton);
  wrapper.append(status, controls);
  elements.pagination.append(wrapper);
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
    image.src = file.thumbnailUrl || file.url;
    image.alt = file.name;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      if (image.src !== file.url) {
        image.src = file.url;
      }
    });
    thumbButton.append(image);
  } else if (file.mediaType === "video") {
    const frame = document.createElement("div");
    frame.className = "media-video-thumb";

    const image = document.createElement("img");
    image.src = file.thumbnailUrl || "";
    image.alt = `${file.name} thumbnail`;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      image.remove();
      frame.dataset.ready = "false";
    });

    const badge = document.createElement("span");
    badge.className = "media-video-badge";
    badge.textContent = "Video";

    const hint = document.createElement("span");
    hint.className = "media-video-hint";
    hint.textContent = "Click to open";

    frame.append(image, badge, hint);
    thumbButton.append(frame);
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
    const preferredQuality = autoVideoQualityPreference();
    const qualityWrap = document.createElement("div");
    qualityWrap.className = "video-quality-bar";

    const qualityLabel = document.createElement("label");
    qualityLabel.className = "video-quality-label";
    qualityLabel.textContent = "Playback quality";

    const qualitySelect = document.createElement("select");
    qualitySelect.className = "video-quality-select";
    ["auto", "original", "p720"].forEach((quality) => {
      const option = document.createElement("option");
      option.value = quality;
      option.textContent = videoQualityLabels[quality];
      qualitySelect.append(option);
    });
    qualitySelect.value = preferredQuality === "p720" ? "auto" : "original";

    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";

    const qualityHint = document.createElement("span");
    qualityHint.className = "video-quality-hint";
    qualityHint.textContent = "Preparing playback...";

    const download = document.createElement("a");
    download.className = "button button-secondary viewer-download";
    download.target = "_blank";
    download.rel = "noopener";
    download.textContent = "Open in new tab";

    const applyVideoSource = (requestedQuality, sourceUrl, hintText) => {
      const currentTime = video.currentTime;
      const wasPaused = video.paused;
      const normalizedSource = new URL(sourceUrl, window.location.origin).href;

      if (video.currentSrc === normalizedSource || video.src === normalizedSource) {
        qualityHint.textContent = hintText;
        download.href = sourceUrl;
        return;
      }

      video.src = sourceUrl;
      download.href = sourceUrl;
      qualityHint.textContent = hintText;
      video.load();
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (Number.isFinite(currentTime)) {
            try {
              video.currentTime = currentTime;
            } catch {}
          }
          if (!wasPaused) {
            video.play().catch(() => {});
          }
        },
        { once: true }
      );
    };

    const chooseVideoQuality = async (selection) => {
      if (selection === "original") {
        applyVideoSource("original", videoSourceForQuality(file, "original"), "Playing the original video.");
        return;
      }

      if (selection === "p720") {
        const ready = await getVideoProxyStatus(file, "720p").catch(() => false);
        if (ready) {
          applyVideoSource("p720", videoSourceForQuality(file, "p720"), "Playing the cached 720p version.");
          return;
        }

        applyVideoSource("original", videoSourceForQuality(file, "original"), "Preparing the 720p version in the background. Still playing the original for now.");
        prepareVideoProxy(file, "720p").catch(() => {});
        return;
      }

      const autoQuality = autoVideoQualityPreference();
      if (autoQuality === "p720") {
        const ready = await getVideoProxyStatus(file, "720p").catch(() => false);
        if (ready) {
          applyVideoSource("p720", videoSourceForQuality(file, "p720"), "Auto selected 720p for this device or connection.");
          return;
        }

        applyVideoSource("original", videoSourceForQuality(file, "original"), "Auto prefers 720p here, but it is still preparing. Playing original for now.");
        prepareVideoProxy(file, "720p").catch(() => {});
        return;
      }

      applyVideoSource("original", videoSourceForQuality(file, "original"), "Auto selected original quality for this device.");
    };

    qualitySelect.addEventListener("change", () => {
      chooseVideoQuality(qualitySelect.value).catch((error) => {
        qualityHint.textContent = error.message;
      });
    });

    qualityLabel.append(qualitySelect);
    qualityWrap.append(qualityLabel, qualityHint);
    elements.viewerBody.append(qualityWrap);
    elements.viewerBody.append(video);
    elements.viewerBody.append(download);
    chooseVideoQuality(qualitySelect.value).catch((error) => {
      qualityHint.textContent = error.message;
    });
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

  if (file.mediaType !== "video") {
    const download = document.createElement("a");
    download.className = "button button-secondary viewer-download";
    download.href = file.url;
    download.target = "_blank";
    download.rel = "noopener";
    download.textContent = file.mediaType === "raw" ? "Open file" : "Open in new tab";
    elements.viewerBody.append(download);
  }
  elements.viewerModal.showModal();
}

function bindEvents() {
  const debouncedSearch = debounce((value) => {
    searchLibrary(value, 1).catch((error) => {
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
