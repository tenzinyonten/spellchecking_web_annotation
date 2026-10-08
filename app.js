(() => {
  const STORAGE_KEY = "tibetan-sentence-annotation-v1";
  const ANNOTATION_STATUSES = new Set(["pending", "accepted", "edited", "rejected"]);
  const PAGE_SIZES = [10, 20, 50];
  const FILTERS = ["all", "pending", "accepted", "edited", "rejected"];

  const $ = (id) => document.getElementById(id);

  const els = {
    fileInput: $("file-input"),
    downloadBtn: $("download-btn"),
    resetBtn: $("reset-btn"),
    fileLabel: $("file-label"),
    saveLabel: $("save-label"),
    rowPosition: $("row-position"),
    meter: $("meter"),
    meterFill: $("meter-fill"),
    counts: {
      accepted: $("count-accepted"),
      edited: $("count-edited"),
      rejected: $("count-rejected"),
      pending: $("count-pending"),
    },
    banner: $("banner"),
    dropZone: $("drop-zone"),
    workspace: $("workspace"),
    tableWrap: $("table-wrap"),
    tbody: $("tbody"),
    emptyFilter: $("empty-filter"),
    toolbar: $("toolbar"),
    sessionBar: $("session-bar"),
    stats: $("stats"),
    nextPending: $("next-pending"),
    gotoInput: $("goto-input"),
    gotoBtn: $("goto-btn"),
    pageSize: $("page-size"),
  };

  const state = {
    filename: "",
    headers: [],
    rows: [],
    page: 0,
    pageSize: 20,
    filter: "all",
    activeIndex: 0,
    saveError: false,
  };

  let saveTimer = 0;
  let flashTimer = 0;
  let downloadUrl = "";

  function assignCell(obj, key, value) {
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  function cellString(value) {
    return value == null ? "" : String(value);
  }

  function statusIsAnnotation(records) {
    return records.every((record) => {
      const value = cellString(record.status).trim().toLowerCase();
      return value === "" || ANNOTATION_STATUSES.has(value);
    });
  }

  function unusedName(fields, candidates) {
    const used = new Set(fields);
    for (const name of candidates) {
      if (!used.has(name)) return name;
    }
    let i = 2;
    while (used.has(`status_original_${i}`)) i += 1;
    return `status_original_${i}`;
  }

  // corrected_target and status belong to this review. A status column with
  // any other values is renamed so those values are still downloaded.
  function splitColumns(fields, records) {
    const hasCorrected = fields.includes("corrected_target");
    const hasStatus = fields.includes("status");
    const ours = hasStatus && statusIsAnnotation(records);
    const statusRename = hasStatus && !ours
      ? unusedName(fields.filter((field) => field !== "status"), ["source_status", "status_original"])
      : null;

    const headers = [];
    for (const field of fields) {
      if (field === "corrected_target") continue;
      if (field === "status" && ours) continue;
      if (field === "status" && statusRename) {
        headers.push(statusRename);
        continue;
      }
      headers.push(field);
    }

    return { headers, hasCorrected, ours, statusRename };
  }

  function buildRow(record, split) {
    const original = Object.create(null);
    for (const header of split.headers) {
      const raw = header === split.statusRename ? record.status : record[header];
      assignCell(original, header, cellString(raw));
    }
    const target = original.target ?? "";
    const corrected = split.hasCorrected ? cellString(record.corrected_target) : target;
    let status = "pending";
    if (split.ours) {
      const raw = cellString(record.status).trim().toLowerCase();
      if (ANNOTATION_STATUSES.has(raw)) status = raw;
    } else if (corrected !== target) {
      status = "edited";
    }
    return { original, corrected, status };
  }

  function tryBuild(results) {
    const fields = (results.meta && results.meta.fields ? results.meta.fields : [])
      .filter((field) => field != null);
    const missing = ["source", "target"].filter((name) => !fields.includes(name));
    if (missing.length) {
      const found = fields.length ? fields.join(", ") : "none";
      return {
        ok: false,
        message: `The CSV needs a header row with ${missing.join(" and ")}. Found: ${found}.`,
      };
    }

    const records = (Array.isArray(results.data) ? results.data : [])
      .filter((record) => record && typeof record === "object" && !Array.isArray(record));
    if (!records.length) {
      return { ok: false, message: "That CSV has no data rows." };
    }

    const split = splitColumns(fields, records);
    const notices = [];
    if (split.statusRename) {
      notices.push(`Kept the existing status column as ${split.statusRename}. Review decisions use status.`);
    }
    if (results.errors && results.errors.length) {
      notices.push(`CSV warning: ${results.errors[0].message}.`);
    }
    if (records.length > 2000) {
      notices.push(`Opened ${records.length} rows in pages. Download a copy if this browser cannot store the whole file.`);
    }

    return {
      ok: true,
      headers: split.headers,
      rows: records.map((record) => buildRow(record, split)),
      notice: notices.join(" "),
    };
  }

  function flash(message) {
    els.banner.textContent = message;
    els.banner.classList.remove("hidden");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      els.banner.classList.add("hidden");
    }, 8000);
  }

  function clearFlash() {
    clearTimeout(flashTimer);
    els.banner.textContent = "";
    els.banner.classList.add("hidden");
  }

  function visibleIndices() {
    const indices = [];
    const { filter, rows } = state;
    for (let i = 0; i < rows.length; i += 1) {
      if (filter === "all" || rows[i].status === filter) indices.push(i);
    }
    return indices;
  }

  function statusLabel(status) {
    if (status === "accepted") return "Accepted";
    if (status === "edited") return "Edited";
    if (status === "rejected") return "Rejected";
    return "Pending";
  }

  function appendWrapped(parent, text) {
    let buffer = "";
    for (const ch of String(text)) {
      buffer += ch;
      if (ch === "་" || ch === "།") {
        parent.append(buffer);
        parent.append(document.createElement("wbr"));
        buffer = "";
      } else if (ch === "\n") {
        parent.append(buffer);
        buffer = "";
      }
    }
    if (buffer) parent.append(buffer);
  }

  function fillMeta(container, original) {
    for (const header of state.headers) {
      if (header === "source" || header === "target" || !header) continue;
      const value = original[header] ?? "";
      if (value === "") continue;
      const chip = document.createElement("span");
      chip.className = "chip";
      const key = document.createElement("span");
      key.className = "chip-key";
      key.textContent = header;
      const shown = value.length > 80 ? `${value.slice(0, 77)}…` : value;
      chip.append(key, document.createTextNode(shown));
      if (value.length > 80) chip.title = value;
      container.append(chip);
    }
  }

  function autosize(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  function renderRow(index) {
    const row = state.rows[index];
    const tr = document.createElement("tr");
    tr.dataset.index = String(index);
    tr.dataset.status = row.status;
    if (index === state.activeIndex) tr.classList.add("is-active");

    const number = document.createElement("th");
    number.scope = "row";
    number.textContent = String(index + 1);

    const source = document.createElement("td");
    source.className = "source";
    source.dataset.label = "Source";
    const meta = document.createElement("div");
    meta.className = "meta";
    fillMeta(meta, row.original);
    const sourceText = document.createElement("div");
    sourceText.className = "bo source-text";
    sourceText.lang = "bo";
    sourceText.dir = "ltr";
    sourceText.translate = false;
    sourceText.setAttribute("translate", "no");
    appendWrapped(sourceText, row.original.source ?? "");
    if (meta.childNodes.length) source.append(meta);
    source.append(sourceText);

    const target = document.createElement("td");
    target.className = "target";
    target.dataset.label = "Target";
    const textarea = document.createElement("textarea");
    textarea.className = "bo";
    textarea.lang = "bo";
    textarea.dir = "ltr";
    textarea.rows = 2;
    textarea.spellcheck = false;
    textarea.autocomplete = "off";
    textarea.autocapitalize = "off";
    textarea.setAttribute("translate", "no");
    textarea.setAttribute("autocorrect", "off");
    textarea.setAttribute("data-gramm", "false");
    textarea.dataset.index = String(index);
    textarea.value = row.corrected;
    textarea.setAttribute("aria-label", `Target for row ${index + 1}`);
    target.append(textarea);

    const status = document.createElement("td");
    status.className = "status";
    status.dataset.label = "Status";
    const label = document.createElement("p");
    label.className = "status-label";
    label.textContent = statusLabel(row.status);
    const group = document.createElement("div");
    group.className = "status-actions";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", `Status for row ${index + 1}`);
    for (const [value, text] of [["accepted", "Accept"], ["edited", "Edit"], ["rejected", "Reject"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.setStatus = value;
      button.textContent = text;
      button.setAttribute("aria-pressed", row.status === value ? "true" : "false");
      group.append(button);
    }
    status.append(label, group);

    tr.append(number, source, target, status);
    return tr;
  }

  function renderRows() {
    const list = visibleIndices();
    const pages = Math.max(1, Math.ceil(list.length / state.pageSize) || 1);
    if (state.page > pages - 1) state.page = Math.max(0, pages - 1);
    if (state.page < 0) state.page = 0;

    const start = state.page * state.pageSize;
    const slice = list.slice(start, start + state.pageSize);
    if (slice.length && !slice.includes(state.activeIndex)) state.activeIndex = slice[0];
    const fragment = document.createDocumentFragment();
    for (const index of slice) fragment.append(renderRow(index));
    els.tbody.replaceChildren(fragment);

    const filteredOut = list.length === 0;
    els.emptyFilter.classList.toggle("hidden", !filteredOut);
    els.tableWrap.classList.toggle("hidden", filteredOut);

    const from = list.length ? start + 1 : 0;
    const to = start + slice.length;
    const filterNote = state.filter === "all" || !list.length ? "" : ` ${state.filter}`;
    const pageText = list.length
      ? `Page ${state.page + 1} of ${pages} · ${from}–${to} of ${list.length}${filterNote}`
      : "Page 0 of 0";
    for (const node of document.querySelectorAll("[data-page-label]")) node.textContent = pageText;

    for (const button of document.querySelectorAll("[data-pager='prev']")) {
      button.disabled = state.page <= 0 || !list.length;
    }
    for (const button of document.querySelectorAll("[data-pager='next']")) {
      button.disabled = state.page >= pages - 1 || !list.length;
    }
    for (const button of document.querySelectorAll("[data-filter]")) {
      button.setAttribute("aria-pressed", button.dataset.filter === state.filter ? "true" : "false");
    }
    els.pageSize.value = String(state.pageSize);
    els.gotoInput.max = String(Math.max(state.rows.length, 1));

    requestAnimationFrame(() => {
      els.tbody.querySelectorAll("textarea").forEach(autosize);
    });
    updateStats();
  }

  function updateStats() {
    const counts = { accepted: 0, edited: 0, rejected: 0, pending: 0 };
    for (const row of state.rows) {
      if (counts[row.status] != null) counts[row.status] += 1;
      else counts.pending += 1;
    }
    const total = state.rows.length;
    const current = total ? state.activeIndex + 1 : 0;
    const reviewed = total - counts.pending;
    const pct = total ? Math.round((reviewed / total) * 100) : 0;

    els.rowPosition.textContent = `Row ${current} of ${total}`;
    els.counts.accepted.textContent = String(counts.accepted);
    els.counts.edited.textContent = String(counts.edited);
    els.counts.rejected.textContent = String(counts.rejected);
    els.counts.pending.textContent = String(counts.pending);
    els.meterFill.style.width = `${pct}%`;
    els.meter.setAttribute("aria-valuenow", String(pct));
    els.meter.setAttribute("aria-valuetext", `${reviewed} of ${total} reviewed`);
    els.downloadBtn.disabled = total === 0;
    els.resetBtn.disabled = total === 0;
    document.title = total
      ? `Row ${current} of ${total} · Tibetan annotation`
      : "Tibetan sentence annotation";
  }

  function paintRow(index) {
    const row = state.rows[index];
    const tr = els.tbody.querySelector(`tr[data-index="${index}"]`);
    if (!tr || !row) return;
    tr.dataset.status = row.status;
    tr.classList.toggle("is-active", index === state.activeIndex);
    const label = tr.querySelector(".status-label");
    if (label) label.textContent = statusLabel(row.status);
    for (const button of tr.querySelectorAll("[data-set-status]")) {
      button.setAttribute("aria-pressed", button.dataset.setStatus === row.status ? "true" : "false");
    }
  }

  function setActive(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.rows.length) return;
    state.activeIndex = index;
    for (const tr of els.tbody.querySelectorAll("tr")) {
      tr.classList.toggle("is-active", Number(tr.dataset.index) === index);
    }
    updateStats();
  }

  function showWorkspace() {
    document.body.classList.add("has-data");
    els.dropZone.classList.add("hidden");
    els.workspace.classList.remove("hidden");
    els.sessionBar.classList.remove("hidden");
    els.stats.classList.remove("hidden");
    els.toolbar.classList.remove("hidden");
    els.fileLabel.textContent = `${state.filename} · ${state.rows.length} rows`;
    renderRows();
  }

  function showEmpty() {
    document.body.classList.remove("has-data");
    els.dropZone.classList.remove("hidden");
    els.workspace.classList.add("hidden");
    els.sessionBar.classList.add("hidden");
    els.stats.classList.add("hidden");
    els.toolbar.classList.add("hidden");
    els.downloadBtn.disabled = true;
    els.resetBtn.disabled = true;
    els.rowPosition.textContent = "Row 0 of 0";
    document.title = "Tibetan sentence annotation";
  }

  function serialize() {
    return {
      version: 1,
      filename: state.filename,
      headers: state.headers,
      rows: state.rows.map((row) => ({
        original: { ...row.original },
        corrected: row.corrected,
        status: row.status,
      })),
      page: state.page,
      pageSize: state.pageSize,
      filter: state.filter,
      activeIndex: state.activeIndex,
      savedAt: new Date().toISOString(),
    };
  }

  function flushSave() {
    clearTimeout(saveTimer);
    if (!state.rows.length) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize()));
      state.saveError = false;
      const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      els.saveLabel.textContent = `Saved in this browser at ${time}`;
    } catch (error) {
      state.saveError = true;
      els.saveLabel.textContent = "Could not save in this browser. Download a CSV so this work is not lost.";
    }
  }

  function scheduleSave() {
    if (!state.rows.length) return;
    els.saveLabel.textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 300);
  }

  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    if (!data || data.version !== 1) return false;
    const valid = data
      && Array.isArray(data.headers)
      && data.headers.includes("source")
      && data.headers.includes("target")
      && Array.isArray(data.rows)
      && data.rows.length > 0
      && data.rows.every((row) => row
        && row.original
        && typeof row.original === "object"
        && typeof row.corrected === "string"
        && ANNOTATION_STATUSES.has(row.status));
    if (!valid) {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    state.filename = typeof data.filename === "string" && data.filename ? data.filename : "annotation.csv";
    state.headers = data.headers;
    state.rows = data.rows;
    state.page = Number.isInteger(data.page) && data.page >= 0 ? data.page : 0;
    state.pageSize = PAGE_SIZES.includes(data.pageSize) ? data.pageSize : 20;
    state.filter = FILTERS.includes(data.filter) ? data.filter : "all";
    state.activeIndex = Number.isInteger(data.activeIndex)
      ? Math.min(Math.max(data.activeIndex, 0), data.rows.length - 1)
      : 0;
    return true;
  }

  function commitParsed(filename, parsed) {
    state.filename = filename || "annotation.csv";
    state.headers = parsed.headers;
    state.rows = parsed.rows;
    state.page = 0;
    state.filter = "all";
    state.activeIndex = 0;
    state.saveError = false;
    showWorkspace();
    flushSave();
    if (parsed.notice) flash(parsed.notice);
    else clearFlash();
  }

  function takeFile(file) {
    if (!file) return;
    const looksCsv = /\.csv$/i.test(file.name) || file.type === "text/csv" || file.type === "application/vnd.ms-excel";
    if (!looksCsv) {
      flash("Upload a .csv file.");
      return;
    }
    if (typeof Papa === "undefined") {
      flash("The CSV library did not load. Check your connection and reload the page.");
      return;
    }
    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (header) => header.replace(/^\uFEFF/, "").trim(),
      complete: (results) => {
        const parsed = tryBuild(results);
        if (!parsed.ok) {
          flash(parsed.message);
          return;
        }
        if (state.rows.length) {
          const replace = confirm("Replace the current session? Annotation progress saved only in this browser will be replaced.");
          if (!replace) return;
        }
        commitParsed(file.name, parsed);
      },
      error: (error) => {
        flash(error && error.message ? error.message : "Could not read that CSV.");
      },
    });
  }

  function downloadFilename() {
    const raw = (state.filename || "annotation").split(/[/\\]/).pop().replace(/\.csv$/i, "");
    const cleaned = raw.replace(/[^\w.\- ()+]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 80);
    return `${cleaned || "annotation"}_annotated.csv`;
  }

  function downloadCsv() {
    if (!state.rows.length || typeof Papa === "undefined") return;
    const fields = state.headers.concat(["corrected_target", "status"]);
    const data = state.rows.map((row) => {
      const out = Object.create(null);
      for (const field of state.headers) assignCell(out, field, row.original[field] ?? "");
      assignCell(out, "corrected_target", row.corrected);
      assignCell(out, "status", row.status);
      return out;
    });
    const csv = Papa.unparse({ fields, data }, { newline: "\r\n" });
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = downloadFilename();
    document.body.append(link);
    link.click();
    link.remove();
    const url = downloadUrl;
    setTimeout(() => {
      if (downloadUrl === url) {
        URL.revokeObjectURL(url);
        downloadUrl = "";
      }
    }, 60000);
  }

  function resetSession() {
    if (!state.rows.length) return;
    const ok = confirm("Clear all annotation progress saved in this browser? This does not delete a CSV you already downloaded.");
    if (!ok) return;
    clearTimeout(saveTimer);
    localStorage.removeItem(STORAGE_KEY);
    state.filename = "";
    state.headers = [];
    state.rows = [];
    state.page = 0;
    state.filter = "all";
    state.activeIndex = 0;
    state.saveError = false;
    els.tbody.replaceChildren();
    els.saveLabel.textContent = "";
    els.fileLabel.textContent = "";
    showEmpty();
    clearFlash();
  }

  function openRow(index, options = {}) {
    if (index < 0 || index >= state.rows.length) return;
    if (options.filter) state.filter = options.filter;
    let list = visibleIndices();
    if (!list.includes(index)) {
      state.filter = "all";
      list = visibleIndices();
    }
    const position = list.indexOf(index);
    state.activeIndex = index;
    state.page = Math.floor(Math.max(position, 0) / state.pageSize);
    renderRows();
    flushSave();
    const textarea = els.tbody.querySelector(`textarea[data-index="${index}"]`);
    if (textarea) {
      textarea.focus({ preventScroll: true });
      textarea.scrollIntoView({ block: "center" });
    }
  }

  function shiftPage(delta) {
    const list = visibleIndices();
    const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
    const next = state.page + delta;
    if (next < 0 || next >= pages) return;
    state.page = next;
    renderRows();
    flushSave();
    els.tableWrap.scrollIntoView({ block: "nearest" });
  }

  function goToRow() {
    const value = Number(els.gotoInput.value);
    if (!Number.isInteger(value) || value < 1 || value > state.rows.length) {
      flash(state.rows.length
        ? `Enter a row number from 1 to ${state.rows.length}.`
        : "Upload a CSV before jumping to a row.");
      return;
    }
    state.filter = "all";
    openRow(value - 1);
  }

  function nextPending() {
    const total = state.rows.length;
    if (!total) return;
    for (let step = 1; step <= total; step += 1) {
      const index = (state.activeIndex + step) % total;
      if (state.rows[index].status === "pending") {
        const filter = state.filter === "all" || state.filter === "pending" ? state.filter : "pending";
        openRow(index, { filter });
        return;
      }
    }
    flash("No pending rows.");
  }

  function setStatus(index, status) {
    const row = state.rows[index];
    if (!row || !ANNOTATION_STATUSES.has(status) || status === "pending") return;
    if ((status === "accepted" || status === "rejected") && row.status === status) {
      row.status = row.corrected !== (row.original.target ?? "") ? "edited" : "pending";
    } else {
      row.status = status;
    }
    state.activeIndex = index;
    const visible = state.filter === "all" || state.filter === row.status;
    if (!visible) renderRows();
    else {
      paintRow(index);
      for (const tr of els.tbody.querySelectorAll("tr")) {
        tr.classList.toggle("is-active", Number(tr.dataset.index) === index);
      }
      updateStats();
    }
    flushSave();
    if (status === "edited") {
      const textarea = els.tbody.querySelector(`textarea[data-index="${index}"]`);
      if (textarea) textarea.focus();
    }
  }

  function onTargetInput(textarea) {
    const index = Number(textarea.dataset.index);
    const row = state.rows[index];
    if (!row) return;
    row.corrected = textarea.value;
    if (textarea.value !== (row.original.target ?? "")) row.status = "edited";
    else if (row.status === "edited") row.status = "pending";
    paintRow(index);
    updateStats();
    autosize(textarea);
    scheduleSave();
  }

  function isFileDrag(event) {
    return Boolean(event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files"));
  }

  let dragDepth = 0;

  function bind() {
    els.fileInput.addEventListener("change", () => {
      const file = els.fileInput.files && els.fileInput.files[0];
      els.fileInput.value = "";
      if (file) takeFile(file);
    });

    els.downloadBtn.addEventListener("click", downloadCsv);
    els.resetBtn.addEventListener("click", resetSession);
    els.nextPending.addEventListener("click", nextPending);
    els.gotoBtn.addEventListener("click", goToRow);
    els.gotoInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        goToRow();
      }
    });

    els.pageSize.addEventListener("change", () => {
      const size = Number(els.pageSize.value);
      if (!PAGE_SIZES.includes(size)) return;
      state.pageSize = size;
      const list = visibleIndices();
      const position = Math.max(0, list.indexOf(state.activeIndex));
      state.page = Math.floor(position / state.pageSize);
      renderRows();
      flushSave();
    });

    for (const button of document.querySelectorAll("[data-filter]")) {
      button.addEventListener("click", () => {
        state.filter = button.dataset.filter;
        state.page = 0;
        renderRows();
        flushSave();
      });
    }

    for (const button of document.querySelectorAll("[data-pager]")) {
      button.addEventListener("click", () => {
        shiftPage(button.dataset.pager === "next" ? 1 : -1);
      });
    }

    els.tbody.addEventListener("input", (event) => {
      if (event.target instanceof HTMLTextAreaElement) onTargetInput(event.target);
    });
    els.tbody.addEventListener("focusin", (event) => {
      if (event.target instanceof HTMLTextAreaElement) setActive(Number(event.target.dataset.index));
    });
    els.tbody.addEventListener("click", (event) => {
      const button = event.target.closest("[data-set-status]");
      if (!button) return;
      const tr = button.closest("tr");
      if (!tr) return;
      setStatus(Number(tr.dataset.index), button.dataset.setStatus);
    });

    els.dropZone.addEventListener("click", (event) => {
      if (event.target.closest("a, button, input, summary, label")) return;
      els.fileInput.click();
    });
    els.dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        els.fileInput.click();
      }
    });

    document.addEventListener("dragenter", (event) => {
      if (!isFileDrag(event)) return;
      dragDepth += 1;
      document.body.classList.add("is-drag");
    });
    document.addEventListener("dragover", (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
    });
    document.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove("is-drag");
    });
    document.addEventListener("drop", (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth = 0;
      document.body.classList.remove("is-drag");
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) takeFile(file);
    });

    window.addEventListener("resize", () => {
      els.tbody.querySelectorAll("textarea").forEach(autosize);
    });
    window.addEventListener("beforeunload", (event) => {
      flushSave();
      if (state.saveError && state.rows.length) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    window.addEventListener("pagehide", flushSave);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushSave();
    });
  }

  bind();
  if (typeof Papa === "undefined") {
    flash("The CSV library did not load. Check your connection and reload the page.");
  }
  if (restore()) {
    showWorkspace();
    els.saveLabel.textContent = "Restored the session saved in this browser.";
  } else {
    showEmpty();
  }
})();
