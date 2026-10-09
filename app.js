(() => {
  const STORAGE_KEY = "tibetan-sentence-annotation-v2";
  const LEGACY_STORAGE_KEY = "tibetan-sentence-annotation-v1";
  const ANNOTATION_STATUSES = new Set(["pending", "accepted"]);
  const PAGE_SIZES = [10, 20, 50];
  const FILTERS = ["all", "pending", "accepted"];

  const $ = (id) => document.getElementById(id);

  const els = {
    fileInput: $("file-input"),
    backBtn: $("back-btn"),
    resumeBtn: $("resume-btn"),
    downloadBtn: $("download-btn"),
    downloadNote: $("download-note"),
    resetBtn: $("reset-btn"),
    fileLabel: $("file-label"),
    saveLabel: $("save-label"),
    saveWarning: $("save-warning"),
    rowPosition: $("row-position"),
    meter: $("meter"),
    meterFill: $("meter-fill"),
    counts: {
      accepted: $("count-accepted"),
      pending: $("count-pending"),
    },
    banner: $("banner"),
    dropZone: $("drop-zone"),
    workspace: $("workspace"),
    tableWrap: $("table-wrap"),
    tbody: $("tbody"),
    emptyFilter: $("empty-filter"),
    emptyFilterText: $("empty-filter-text"),
    emptyPending: $("empty-pending"),
    emptyDownload: $("empty-download"),
    toast: $("toast"),
    toastText: $("toast-text"),
    toastUndo: $("toast-undo"),
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
    filter: "pending",
    activeIndex: 0,
    saveError: false,
    dirtySinceDownload: false,
  };

  let saveTimer = 0;
  let flashTimer = 0;
  let toastTimer = 0;
  let downloadUrl = "";
  let lastUndo = null;

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

  function priorStatus(value) {
    const status = cellString(value).trim().toLowerCase();
    if (status === "accepted") return "accepted";
    return "pending";
  }

  function statusColumnIsAnnotation(records) {
    return records.every((record) => {
      const value = cellString(record.status).trim().toLowerCase();
      return value === "" || value === "pending" || value === "accepted" || value === "edited" || value === "rejected";
    });
  }

  // Annotation columns are restored into the editor and appended again on
  // download. Every other input column, including source and target, is kept.
  function splitColumns(fields, records) {
    const hasCorrectedSource = fields.includes("corrected_source");
    const hasCorrectedTarget = fields.includes("corrected_target");
    const hasStatus = fields.includes("status")
      && statusColumnIsAnnotation(records)
      && (hasCorrectedSource || hasCorrectedTarget);
    const headers = fields.filter((field) => {
      if (field === "corrected_source" || field === "corrected_target") return false;
      if (field === "status" && hasStatus) return false;
      return true;
    });
    return { headers, hasCorrectedSource, hasCorrectedTarget, hasStatus };
  }

  function buildRow(record, split) {
    const original = Object.create(null);
    for (const header of split.headers) assignCell(original, header, cellString(record[header]));
    const source = original.source ?? "";
    const target = original.target ?? "";
    const correctedSource = split.hasCorrectedSource ? cellString(record.corrected_source) : source;
    const correctedTarget = split.hasCorrectedTarget ? cellString(record.corrected_target) : target;
    let status = "pending";
    if (split.hasStatus) status = priorStatus(record.status);
    return { original, correctedSource, correctedTarget, status };
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
    return "Pending";
  }

  function rowChanged(row) {
    return row.correctedSource !== (row.original.source ?? "")
      || row.correctedTarget !== (row.original.target ?? "");
  }

  function fillRowLoc(original) {
    const parts = [];
    for (const key of ["page_id", "segment_idx", "split"]) {
      const value = cellString(original[key]).trim();
      if (value) parts.push(`${key} ${value}`);
    }
    if (!parts.length) return null;
    const loc = document.createElement("p");
    loc.className = "row-loc";
    loc.textContent = parts.join(" · ");
    return loc;
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

    const texts = document.createElement("td");
    texts.className = "texts";
    texts.colSpan = 2;
    const pair = document.createElement("div");
    pair.className = "text-pair";
    const source = document.createElement("div");
    source.className = "source";
    source.dataset.label = "Source";
    source.append(makeTextarea(index, "source", row.correctedSource));
    const target = document.createElement("div");
    target.className = "target";
    target.dataset.label = "Target";
    target.append(makeTextarea(index, "target", row.correctedTarget));
    pair.append(source, target);
    texts.append(pair);
    const loc = fillRowLoc(row.original);
    if (loc) texts.append(loc);

    const category = document.createElement("td");
    category.className = "category";
    category.dataset.label = "Category";
    category.textContent = row.original.diff_category ?? "";

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
    if (row.status === "accepted") {
      const back = document.createElement("button");
      back.type = "button";
      back.dataset.movePending = "true";
      back.textContent = "Move back to pending";
      group.append(back);
    } else {
      const accept = document.createElement("button");
      accept.type = "button";
      accept.dataset.setStatus = "accepted";
      accept.textContent = "Accept";
      group.append(accept);
    }
    status.append(label, group);

    tr.append(number, texts, category, status);
    return tr;
  }

  function makeTextarea(index, field, value) {
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
    textarea.dataset.field = field;
    textarea.value = value;
    const label = field === "source" ? "Source" : "Target";
    textarea.setAttribute("aria-label", `${label} for row ${index + 1}`);
    return textarea;
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
    const pendingDone = filteredOut && state.filter === "pending" && state.rows.length > 0;
    els.emptyFilter.classList.toggle("hidden", !filteredOut);
    els.emptyFilterText.classList.toggle("hidden", pendingDone);
    els.emptyPending.classList.toggle("hidden", !pendingDone);
    if (!pendingDone) els.emptyFilterText.textContent = "No rows in this filter.";
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
    const counts = { accepted: 0, pending: 0 };
    for (const row of state.rows) {
      if (row.status === "accepted") counts.accepted += 1;
      else counts.pending += 1;
    }
    const total = state.rows.length;
    const current = total ? state.activeIndex + 1 : 0;
    const reviewed = counts.accepted;
    const pct = total ? Math.round((reviewed / total) * 100) : 0;

    els.rowPosition.textContent = `Row ${current} of ${total}`;
    els.counts.accepted.textContent = String(counts.accepted);
    els.counts.pending.textContent = String(counts.pending);
    els.meterFill.style.width = `${pct}%`;
    els.meter.setAttribute("aria-valuenow", String(pct));
    els.meter.setAttribute("aria-valuetext", `${reviewed} of ${total} reviewed`);
    els.resetBtn.disabled = total === 0;
    updateDownloadNote();
    updateResumeButton();
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
  }

  function setActive(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.rows.length) return;
    state.activeIndex = index;
    for (const tr of els.tbody.querySelectorAll("tr")) {
      tr.classList.toggle("is-active", Number(tr.dataset.index) === index);
    }
    updateStats();
  }

  function updateDownloadNote() {
    if (!els.downloadNote) return;
    const accepted = [];
    const pending = [];
    for (const row of state.rows) {
      if (row.status === "accepted") accepted.push(row);
      else pending.push(row);
    }
    els.downloadBtn.disabled = accepted.length === 0;
    if (!accepted.length) {
      els.downloadNote.textContent = "Accept at least one row to download";
      return;
    }
    const pendingEdits = pending.filter(rowChanged).length;
    const acceptLabel = accepted.length === 1 ? "1 accepted row" : `${accepted.length} accepted rows`;
    const pendingLabel = pending.length === 1 ? "1 pending row is not included" : `${pending.length} pending rows are not included`;
    let text = `Downloads ${acceptLabel}. ${pendingLabel}.`;
    if (pendingEdits) {
      text += pendingEdits === 1
        ? " 1 of them has edits that aren't accepted yet."
        : ` ${pendingEdits} of them have edits that aren't accepted yet.`;
    }
    els.downloadNote.textContent = text;
  }

  function reviewedCount(rows) {
    let done = 0;
    for (const row of rows) {
      if (row.status === "accepted") done += 1;
    }
    return done;
  }

  function updateResumeButton() {
    const total = state.rows.length;
    if (!els.resumeBtn) return;
    if (!total) {
      els.resumeBtn.classList.add("hidden");
      els.resumeBtn.textContent = "Resume last batch";
      return;
    }
    const done = reviewedCount(state.rows);
    els.resumeBtn.textContent = `Resume last batch (${total} rows, ${done} done)`;
    const onUpload = !document.body.classList.contains("has-data");
    els.resumeBtn.classList.toggle("hidden", !onUpload);
  }

  function markDirty() {
    state.dirtySinceDownload = true;
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function hideToast() {
    clearTimeout(toastTimer);
    els.toast.classList.add("hidden");
    lastUndo = null;
  }

  function showAcceptToast(index, previousStatus) {
    lastUndo = { index, previousStatus };
    els.toastText.textContent = `Row ${index + 1} accepted.`;
    els.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }

  function undoAccept() {
    if (!lastUndo) return;
    const { index, previousStatus } = lastUndo;
    const row = state.rows[index];
    hideToast();
    if (!row) return;
    row.status = "pending";
    markDirty();
    state.filter = "pending";
    const list = visibleIndices();
    const position = list.indexOf(index);
    if (position >= 0) state.page = Math.floor(position / state.pageSize);
    const scrollY = window.scrollY;
    renderRows();
    window.scrollTo(0, scrollY);
    flushSave();
  }

  function leaveRow(tr, done) {
    tr.classList.add("is-leaving");
    window.setTimeout(done, prefersReducedMotion() ? 0 : 200);
  }

  function acceptRow(index) {
    const row = state.rows[index];
    if (!row) return;
    if (row.status === "accepted") return;
    const previousStatus = row.status;
    row.status = "accepted";
    markDirty();
    state.activeIndex = index;
    showAcceptToast(index, previousStatus);
    const scrollY = window.scrollY;
    const tr = els.tbody.querySelector(`tr[data-index="${index}"]`);
    const finish = () => {
      renderRows();
      window.scrollTo(0, scrollY);
      flushSave();
    };
    if (state.filter === "pending" && tr) leaveRow(tr, finish);
    else finish();
  }

  function moveBackToPending(index) {
    const row = state.rows[index];
    if (!row) return;
    row.status = "pending";
    markDirty();
    state.activeIndex = index;
    const scrollY = window.scrollY;
    renderRows();
    window.scrollTo(0, scrollY);
    flushSave();
  }

  function showWorkspace() {
    document.body.classList.add("has-data");
    els.dropZone.classList.add("hidden");
    els.workspace.classList.remove("hidden");
    els.sessionBar.classList.remove("hidden");
    els.stats.classList.remove("hidden");
    els.toolbar.classList.remove("hidden");
    els.backBtn.classList.remove("hidden");
    els.fileLabel.textContent = `${state.filename} · ${state.rows.length} rows`;
    renderRows();
    updateResumeButton();
  }

  function showEmpty() {
    document.body.classList.remove("has-data");
    els.dropZone.classList.remove("hidden");
    els.workspace.classList.add("hidden");
    els.sessionBar.classList.add("hidden");
    els.stats.classList.add("hidden");
    els.toolbar.classList.add("hidden");
    els.backBtn.classList.add("hidden");
    els.downloadBtn.disabled = true;
    els.resetBtn.disabled = state.rows.length === 0;
    if (els.downloadNote && !state.rows.length) {
      els.downloadNote.textContent = "Accept at least one row to download";
    }
    els.rowPosition.textContent = "Row 0 of 0";
    document.title = "Tibetan sentence annotation";
    updateResumeButton();
  }

  function goBack() {
    if (!state.rows.length) {
      showEmpty();
      return;
    }
    flushSave();
    if (state.dirtySinceDownload && reviewedCount(state.rows) > 0) {
      const ok = confirm("You have changes that haven't been downloaded. Go back anyway? Your work stays saved in this browser.");
      if (!ok) return;
    }
    showEmpty();
  }

  function serialize() {
    return {
      version: 2,
      filename: state.filename,
      headers: state.headers,
      rows: state.rows.map((row) => ({
        original: { ...row.original },
        correctedSource: row.correctedSource,
        correctedTarget: row.correctedTarget,
        status: row.status,
      })),
      page: state.page,
      pageSize: state.pageSize,
      filter: state.filter,
      activeIndex: state.activeIndex,
      dirtySinceDownload: state.dirtySinceDownload,
      savedAt: new Date().toISOString(),
    };
  }

  function showSaveWarning() {
    state.saveError = true;
    const message = "Your progress can't be saved in this browser. Download the CSV now.";
    els.saveLabel.textContent = message;
    if (els.saveWarning) {
      els.saveWarning.textContent = message;
      els.saveWarning.classList.remove("hidden");
    }
  }

  function hideSaveWarning() {
    if (els.saveWarning) els.saveWarning.classList.add("hidden");
  }

  function flushSave() {
    clearTimeout(saveTimer);
    if (!state.rows.length) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize()));
      state.saveError = false;
      hideSaveWarning();
      const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      els.saveLabel.textContent = `Saved in this browser at ${time}`;
    } catch (error) {
      showSaveWarning();
    }
  }

  function scheduleSave() {
    if (!state.rows.length) return;
    if (!state.saveError) els.saveLabel.textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 300);
  }

  function rowFromSaved(row) {
    const original = row.original;
    const correctedSource = typeof row.correctedSource === "string"
      ? row.correctedSource
      : cellString(original.source);
    const correctedTarget = typeof row.correctedTarget === "string"
      ? row.correctedTarget
      : (typeof row.corrected === "string" ? row.corrected : cellString(original.target));
    return {
      original,
      correctedSource,
      correctedTarget,
      status: priorStatus(row.status),
    };
  }

  function savedSessionIsValid(data) {
    return Boolean(data
      && (data.version === 1 || data.version === 2)
      && Array.isArray(data.headers)
      && data.headers.includes("source")
      && data.headers.includes("target")
      && Array.isArray(data.rows)
      && data.rows.length > 0
      && data.rows.every((row) => row && row.original && typeof row.original === "object"));
  }

  function applySaved(data) {
    state.filename = typeof data.filename === "string" && data.filename ? data.filename : "annotation.csv";
    state.headers = data.headers;
    state.rows = data.rows.map(rowFromSaved);
    state.page = Number.isInteger(data.page) && data.page >= 0 ? data.page : 0;
    state.pageSize = PAGE_SIZES.includes(data.pageSize) ? data.pageSize : 20;
    state.filter = "pending";
    state.activeIndex = Number.isInteger(data.activeIndex)
      ? Math.min(Math.max(data.activeIndex, 0), data.rows.length - 1)
      : 0;
    const pending = [];
    for (let i = 0; i < state.rows.length; i += 1) {
      if (state.rows[i].status === "pending") pending.push(i);
    }
    if (pending.includes(state.activeIndex)) {
      state.page = Math.floor(pending.indexOf(state.activeIndex) / state.pageSize);
    } else {
      state.page = 0;
      if (pending.length) state.activeIndex = pending[0];
    }
    if (typeof data.dirtySinceDownload === "boolean") {
      state.dirtySinceDownload = data.dirtySinceDownload;
    } else {
      state.dirtySinceDownload = reviewedCount(state.rows) > 0;
    }
  }

  function readStorage(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      localStorage.removeItem(key);
      return null;
    }
  }

  function restore() {
    const current = readStorage(STORAGE_KEY);
    if (savedSessionIsValid(current)) {
      applySaved(current);
      return true;
    }
    const legacy = readStorage(LEGACY_STORAGE_KEY);
    if (!savedSessionIsValid(legacy)) return false;
    applySaved(legacy);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    flushSave();
    return true;
  }

  function commitParsed(filename, parsed) {
    state.filename = filename || "annotation.csv";
    state.headers = parsed.headers;
    state.rows = parsed.rows;
    state.page = 0;
    state.filter = "pending";
    state.activeIndex = 0;
    state.saveError = false;
    state.dirtySinceDownload = false;
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
          const replace = confirm("Replace your saved batch? Download it first if you need it.");
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
    const reviewed = state.rows.filter((row) => row.status === "accepted");
    if (!reviewed.length) return;
    const fields = state.headers.concat(["corrected_source", "corrected_target", "status"]);
    const data = reviewed.map((row) => {
      const out = Object.create(null);
      for (const field of state.headers) assignCell(out, field, row.original[field] ?? "");
      assignCell(out, "corrected_source", row.correctedSource);
      assignCell(out, "corrected_target", row.correctedTarget);
      assignCell(out, "status", "accepted");
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
    state.dirtySinceDownload = false;
    flushSave();
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
    state.filter = "pending";
    state.activeIndex = 0;
    state.saveError = false;
    state.dirtySinceDownload = false;
    hideToast();
    els.tbody.replaceChildren();
    els.saveLabel.textContent = "";
    els.fileLabel.textContent = "";
    hideSaveWarning();
    if (els.downloadNote) els.downloadNote.textContent = "Accept at least one row to download";
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
    const textarea = els.tbody.querySelector(`textarea[data-index="${index}"][data-field="target"]`);
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
    if (status === "accepted") acceptRow(index);
  }

  function onFieldInput(textarea) {
    const index = Number(textarea.dataset.index);
    const row = state.rows[index];
    if (!row) return;
    if (textarea.dataset.field === "source") row.correctedSource = textarea.value;
    else row.correctedTarget = textarea.value;
    markDirty();
    autosize(textarea);
    if (row.status === "accepted") {
      row.status = "pending";
      const scrollY = window.scrollY;
      renderRows();
      window.scrollTo(0, scrollY);
      flushSave();
      return;
    }
    updateDownloadNote();
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

    els.backBtn.addEventListener("click", goBack);
    els.resumeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!state.rows.length) return;
      state.filter = "pending";
      const pending = [];
      for (let i = 0; i < state.rows.length; i += 1) {
        if (state.rows[i].status === "pending") pending.push(i);
      }
      if (pending.includes(state.activeIndex)) {
        state.page = Math.floor(pending.indexOf(state.activeIndex) / state.pageSize);
      } else {
        state.page = 0;
        if (pending.length) state.activeIndex = pending[0];
      }
      showWorkspace();
    });
    els.downloadBtn.addEventListener("click", downloadCsv);
    els.emptyDownload.addEventListener("click", downloadCsv);
    els.toastUndo.addEventListener("click", undoAccept);
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
      if (event.target instanceof HTMLTextAreaElement) onFieldInput(event.target);
    });
    els.tbody.addEventListener("focusin", (event) => {
      if (event.target instanceof HTMLTextAreaElement) setActive(Number(event.target.dataset.index));
    });
    els.tbody.addEventListener("click", (event) => {
      const back = event.target.closest("[data-move-pending]");
      if (back) {
        const tr = back.closest("tr");
        if (tr) moveBackToPending(Number(tr.dataset.index));
        return;
      }
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
