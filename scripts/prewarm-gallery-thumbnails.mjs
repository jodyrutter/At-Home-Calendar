const baseUrl = process.env.HEARTHBOARD_URL || "http://127.0.0.1:42069";
const pageSize = Number.parseInt(process.env.PAGE_SIZE || "48", 10);
const concurrency = Number.parseInt(process.env.CONCURRENCY || "6", 10);

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }

  return response.json();
}

async function warmUrl(url) {
  const response = await fetch(new URL(url, baseUrl));
  if (!response.ok) {
    throw new Error(`Thumbnail request failed for ${url}: ${response.status}`);
  }

  await response.arrayBuffer();
}

async function warmLibrary(libraryId) {
  const firstPage = await fetchJson(`${baseUrl}/api/media/browse?library=${encodeURIComponent(libraryId)}&path=&page=1&pageSize=${pageSize}`);
  const totalPages = firstPage.pagination?.totalPages || 1;
  let warmed = 0;

  for (let page = 1; page <= totalPages; page += 1) {
    const payload = page === 1
      ? firstPage
      : await fetchJson(`${baseUrl}/api/media/browse?library=${encodeURIComponent(libraryId)}&path=&page=${page}&pageSize=${pageSize}`);

    const thumbnailUrls = payload.files
      .filter((file) => file.thumbnailUrl)
      .map((file) => file.thumbnailUrl);

    for (let index = 0; index < thumbnailUrls.length; index += concurrency) {
      const batch = thumbnailUrls.slice(index, index + concurrency);
      await Promise.all(batch.map((url) => warmUrl(url)));
      warmed += batch.length;
    }

    console.log(`${libraryId}: warmed page ${page}/${totalPages} (${warmed} thumbnails so far)`);
  }

  return warmed;
}

const librariesPayload = await fetchJson(`${baseUrl}/api/media/libraries`);
let totalWarmed = 0;

for (const library of librariesPayload.libraries || []) {
  totalWarmed += await warmLibrary(library.id);
}

console.log(`Completed thumbnail prewarm. Total thumbnails warmed: ${totalWarmed}`);
