(() => {
  const APP_ID = "cs128-sidebyside-app";
  const ACTIVE_CLASS = "cs128-sidebyside-active";
  const DIRECTION_ICON = `
    <svg class="cs128-sbs-direction-icon" aria-hidden="true" viewBox="0 0 16 16" focusable="false">
      <rect x="1.5" y="2.5" width="8.5" height="11" rx="1.5"></rect>
      <path d="M7 8h7m-3-3 3 3-3 3"></path>
    </svg>
  `;

  let records = [];
  let activeRecord = null;
  let app = null;
  let pageContentMarker = null;
  let instructionScroller = null;
  let workspaceScroller = null;
  let workspaceMount = null;
  let navbarControls = null;
  let toolLabelEdits = [];
  let sideButtons = [];
  let collapseObservers = [];
  let layoutCleanup = null;
  let codeSide = "right";
  let activationQueued = false;

  const pageLayout = () => document.querySelector("#content .container-xl.page-layout");
  const pageContent = () => pageLayout()?.querySelector(":scope > .page-content");

  function activityTitle(section, frame) {
    if (frame.querySelector(".block-title")) {
      return frame.querySelector(".block-title").innerText.trim();
    }

    let sibling = section.previousElementSibling;
    while (sibling) {
      const headings = [...sibling.querySelectorAll("h1, h2, h3, h4")];
      if (headings.length) return headings[headings.length - 1].innerText.trim();
      sibling = sibling.previousElementSibling;
    }
    return "Workspace";
  }

  function refreshEditors() {
    window.dispatchEvent(new Event("resize"));
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function configurePaneLayout(shell) {
    const divider = shell.querySelector(".cs128-sbs-divider");
    const navbar = navbarControls.closest(".topbar-128");
    let ratio = 0.5;
    let pointerId = null;
    let layoutFrame = null;
    const stacked = () => window.matchMedia("(max-width: 620px)").matches;

    function setRatio(value) {
      const bounds = shell.getBoundingClientRect();
      const handle = divider.getBoundingClientRect();
      const available = Math.max(1, stacked() ? bounds.height - handle.height : bounds.width - handle.width);
      const minimum = Math.min(0.45, Math.max(0.2, (stacked() ? 160 : 300) / available));
      ratio = Math.min(1 - minimum, Math.max(minimum, value));
      shell.style.setProperty("--sbs-start-size", `${ratio}fr`);
      shell.style.setProperty("--sbs-end-size", `${1 - ratio}fr`);
      divider.setAttribute("aria-valuemin", String(Math.round(minimum * 100)));
      divider.setAttribute("aria-valuemax", String(Math.round((1 - minimum) * 100)));
      divider.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      divider.setAttribute("aria-valuetext", `${stacked() ? "Top" : "Left"} pane ${Math.round(ratio * 100)} percent`);
    }

    function syncLayout() {
      layoutFrame = null;
      if (app !== shell) return;
      shell.style.setProperty("--sbs-top-offset", `${navbar.getBoundingClientRect().bottom}px`);
      divider.setAttribute("aria-orientation", stacked() ? "horizontal" : "vertical");
      setRatio(ratio);
      refreshEditors();
    }

    function scheduleLayout() {
      if (layoutFrame === null) layoutFrame = requestAnimationFrame(syncLayout);
    }

    function resizeFromPointer(event) {
      const bounds = shell.getBoundingClientRect();
      const handle = divider.getBoundingClientRect();
      const horizontal = stacked();
      const handleSize = horizontal ? handle.height : handle.width;
      const position = horizontal ? event.clientY - bounds.top : event.clientX - bounds.left;
      const available = Math.max(1, (horizontal ? bounds.height : bounds.width) - handleSize);
      setRatio((position - handleSize / 2) / available);
      scheduleLayout();
    }

    function finishDrag(event) {
      if (event.pointerId !== pointerId) return;
      const capturedPointer = pointerId;
      pointerId = null;
      shell.classList.remove("cs128-sbs-resizing");
      if (divider.hasPointerCapture(capturedPointer)) divider.releasePointerCapture(capturedPointer);
      scheduleLayout();
    }

    divider.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      pointerId = event.pointerId;
      divider.setPointerCapture(pointerId);
      divider.focus({ preventScroll: true });
      shell.classList.add("cs128-sbs-resizing");
      resizeFromPointer(event);
    });
    divider.addEventListener("pointermove", (event) => {
      if (event.pointerId === pointerId) resizeFromPointer(event);
    });
    divider.addEventListener("pointerup", finishDrag);
    divider.addEventListener("pointercancel", finishDrag);
    divider.addEventListener("lostpointercapture", finishDrag);
    navbarControls.querySelector(".cs128-sbs-center").addEventListener("click", () => {
      setRatio(0.5);
      scheduleLayout();
    });
    divider.addEventListener("keydown", (event) => {
      const backward = stacked() ? "ArrowUp" : "ArrowLeft";
      const forward = stacked() ? "ArrowDown" : "ArrowRight";
      const values = { [backward]: ratio - 0.02, [forward]: ratio + 0.02, Home: 0, End: 1 };
      if (!Object.hasOwn(values, event.key)) return;
      event.preventDefault();
      setRatio(values[event.key]);
      scheduleLayout();
    });

    const observer = new ResizeObserver(scheduleLayout);
    observer.observe(shell);
    observer.observe(navbar);
    syncLayout();

    return () => {
      observer.disconnect();
      if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
      shell.classList.remove("cs128-sbs-resizing");
      const capturedPointer = pointerId;
      pointerId = null;
      if (capturedPointer !== null && divider.hasPointerCapture(capturedPointer)) divider.releasePointerCapture(capturedPointer);
    };
  }

  function updateButton(record) {
    const active = activeRecord === record;
    const action = active ? "Return to lesson" : "Open in side panel";
    record.button.querySelector(".cs128-sbs-button-label").textContent = action;
    record.button.setAttribute("aria-pressed", String(active));
    record.button.setAttribute("aria-label", `${action}: ${record.title}`);
    record.button.dataset.direction = active ? lessonSide() : codeSide;
  }

  function lessonSide() {
    return codeSide === "right" ? "left" : "right";
  }

  function updateButtons() {
    records.forEach(updateButton);
  }

  function setCodeSide(side) {
    if (side !== "left" && side !== "right") return;
    codeSide = side;
    if (!app) return;
    app.classList.toggle("cs128-sbs-code-left", side === "left");
    app.classList.toggle("cs128-sbs-code-right", side === "right");
    sideButtons.forEach((button) => {
      const selected = button.dataset.side === side;
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("history-active", selected);
    });
    navbarControls.querySelector(".cs128-sbs-return-top").dataset.direction = lessonSide();
    updateButtons();
    chrome.storage.local.set({ codeSide: side });
    refreshEditors();
  }

  function restoreRecord(record) {
    if (record.promptCard) {
      record.promptCard.remove();
      record.promptCard = null;
    }

    if (record.prompt && record.promptMarker?.parentNode) {
      record.promptMarker.parentNode.insertBefore(record.prompt, record.promptMarker.nextSibling);
    }

    if (record.frameMarker?.parentNode && record.frame.parentNode !== record.frameMarker.parentNode) {
      record.frameMarker.parentNode.insertBefore(record.frame, record.frameMarker.nextSibling);
    }

    activeRecord = null;
    updateButton(record);
  }

  function makePromptCard(record) {
    if (!record.prompt || record.promptCard) return;

    const card = document.createElement("section");
    card.className = "block__frame cs128-sbs-prompt-card";

    const heading = document.createElement("h3");
    heading.className = "block-title";
    heading.textContent = record.title;
    card.append(heading, record.prompt);
    record.section.insertBefore(card, record.frameMarker);
    record.promptCard = card;

    if (record.collapsed) {
      card.hidden = !record.collapsed.classList.contains("show");
    }
  }

  function selectRecord(record) {
    if (activeRecord === record) {
      exitSplitView();
      return;
    }

    if (activeRecord) restoreRecord(activeRecord);

    makePromptCard(record);
    workspaceMount.replaceChildren(record.frame);
    activeRecord = record;
    updateButton(record);

    if (record.collapsed && record.promptCard) {
      record.promptCard.hidden = !record.collapsed.classList.contains("show");
    }

    workspaceScroller.scrollTop = 0;
    refreshEditors();
  }

  async function makeSplitView(record) {
    await sidePreferenceLoaded;
    const content = pageContent();
    const navbar = document.querySelector(".topbar-128");
    if (!content || !navbar || app) return;

    const initialScrollY = window.scrollY;
    const headerHeight = navbar.getBoundingClientRect().bottom;
    app = document.createElement("div");
    app.id = APP_ID;
    app.style.setProperty("--sbs-top-offset", `${headerHeight}px`);
    app.className = "cs128-sbs-code-right";
    app.innerHTML = `
      <section class="cs128-sbs-pane cs128-sbs-instructions" aria-label="Instructions">
        <div class="cs128-sbs-scroll cs128-sbs-instruction-scroll"></div>
      </section>
      <div class="cs128-sbs-divider" role="separator" tabindex="0" aria-label="Resize panes" aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="50"></div>
      <section class="cs128-sbs-pane cs128-sbs-workspace" aria-label="Code workspace">
        <div class="cs128-sbs-scroll cs128-sbs-workspace-scroll">
          <div class="cs128-sbs-workspace-mount"></div>
        </div>
      </section>
    `;

    navbarControls = document.createElement("div");
    navbarControls.id = "cs128-sbs-navbar-controls";
    navbarControls.setAttribute("role", "group");
    navbarControls.setAttribute("aria-label", "Workspace controls");
    navbarControls.innerHTML = `
            <div class="cs128-sbs-side-control" role="group" aria-label="Code pane position">
              <button type="button" class="btn btn-core-history activity-light-btn" data-side="left" aria-pressed="false">Left</button>
              <button type="button" class="btn btn-core-history activity-light-btn" data-side="right" aria-pressed="true">Right</button>
            </div>
            <button type="button" class="btn btn-core-save activity-light-btn cs128-sbs-center" aria-label="Reset pane sizes to 50/50">Reset pane sizes</button>
            <button type="button" class="btn btn-core-save activity-light-btn cs128-sbs-return-top">
              ${DIRECTION_ICON}
              <span>Return to lesson</span>
            </button>
    `;
    navbar.classList.add("cs128-sbs-navbar");
    navbar.insertBefore(navbarControls, navbar.lastElementChild);
    navbar.querySelectorAll('[aria-labelledby="dropdownTools"] a').forEach((link) => {
      [...link.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).forEach((node) => {
        const shortened = node.textContent.replace(/\s+[—–-]\s+[\s\S]*$/u, "");
        if (shortened !== node.textContent) {
          toolLabelEdits.push({ node, text: node.textContent });
          node.textContent = shortened;
        }
      });
    });

    instructionScroller = app.querySelector(".cs128-sbs-instruction-scroll");
    workspaceScroller = app.querySelector(".cs128-sbs-workspace-scroll");
    workspaceMount = app.querySelector(".cs128-sbs-workspace-mount");
    sideButtons = [...navbarControls.querySelectorAll(".cs128-sbs-side-control button")];
    sideButtons.forEach((button) => button.addEventListener("click", () => setCodeSide(button.dataset.side)));
    navbarControls.querySelector(".cs128-sbs-return-top").addEventListener("click", () => exitSplitView());

    pageContentMarker = document.createComment("CS128 SideBySide page content");
    content.parentNode.insertBefore(pageContentMarker, content);
    instructionScroller.append(content);
    document.querySelector("#content").append(app);
    document.body.classList.add(ACTIVE_CLASS);

    for (const item of records) {
      item.frameMarker = document.createComment("CS128 SideBySide workspace position");
      item.frame.parentNode.insertBefore(item.frameMarker, item.frame);
      item.prompt = item.frame.querySelector(".activity-question-body");
      if (item.prompt) {
        item.promptMarker = document.createComment("CS128 SideBySide prompt position");
        item.prompt.parentNode.insertBefore(item.promptMarker, item.prompt);
      }
      item.collapsed = item.frame.querySelector(".block-collapse");

      if (item.collapsed) {
        const observer = new MutationObserver(() => {
          if (item.promptCard) {
            item.promptCard.hidden = !item.collapsed.classList.contains("show");
          }
        });
        observer.observe(item.collapsed, { attributes: true, attributeFilter: ["class"] });
        collapseObservers.push(observer);
      }
    }

    setCodeSide(codeSide);
    selectRecord(record);
    layoutCleanup = configurePaneLayout(app);
    const currentApp = app;

    requestAnimationFrame(() => {
      if (app !== currentApp || !instructionScroller) return;
      instructionScroller.scrollTop = initialScrollY;
      refreshEditors();
    });
  }

  function exitSplitView(removeButtons = false) {
    if (!app) {
      if (removeButtons) {
        records.forEach((record) => record.button.remove());
        records = [];
      }
      return;
    }
    const restoreScrollY = instructionScroller.scrollTop;
    layoutCleanup?.();
    layoutCleanup = null;

    if (activeRecord) restoreRecord(activeRecord);

    for (const record of records) {
      record.promptCard?.remove();
      record.promptCard = null;
      record.frameMarker?.remove();
      record.frameMarker = null;
      record.promptMarker?.remove();
      record.promptMarker = null;
      record.prompt = null;
      record.collapsed = null;
    }
    collapseObservers.forEach((observer) => observer.disconnect());
    collapseObservers = [];

    if (pageContentMarker?.parentNode) {
      pageContentMarker.parentNode.insertBefore(instructionScroller.firstElementChild, pageContentMarker.nextSibling);
      pageContentMarker.remove();
    }
    pageContentMarker = null;

    navbarControls.closest(".topbar-128").classList.remove("cs128-sbs-navbar");
    toolLabelEdits.forEach(({ node, text }) => { node.textContent = text; });
    toolLabelEdits = [];
    navbarControls.remove();
    app.remove();
    app = null;
    document.body.classList.remove(ACTIVE_CLASS);
    instructionScroller = null;
    workspaceScroller = null;
    workspaceMount = null;
    navbarControls = null;
    sideButtons = [];
    activeRecord = null;

    if (removeButtons) {
      records.forEach((record) => record.button.remove());
      records = [];
    } else {
      updateButtons();
    }

    // Restore before the next paint and bypass the site's smooth scrolling.
    window.scrollTo({ top: restoreScrollY, left: 0, behavior: "instant" });
    refreshEditors();
  }

  function installWorkspaceButtons() {
    if (app) return;
    const content = pageContent();
    if (!content) return;

    const frames = [...content.querySelectorAll(".block__frame._cs128_core_module_frame")]
      .filter((frame) => frame.querySelector(".activity-workspace"));
    const current = new Set(frames);

    records = records.filter((record) => {
      if (current.has(record.frame)) return true;
      record.button.remove();
      return false;
    });

    for (const frame of frames) {
      if (records.some((record) => record.frame === frame)) continue;
      const section = frame.closest("section.block");
      const workspace = frame.querySelector(".activity-workspace");
      if (!section || !workspace) continue;

      const record = {
        frame,
        section,
        workspace,
        title: activityTitle(section, frame),
        prompt: null,
        promptCard: null,
        promptMarker: null,
        frameMarker: null,
        collapsed: null,
        button: document.createElement("button")
      };

      record.button.type = "button";
      record.button.className = "btn btn-core-save activity-light-btn cs128-sbs-popout-button";
      record.button.innerHTML = `
        ${DIRECTION_ICON}
        <span class="cs128-sbs-button-label"></span>
      `;
      record.button.addEventListener("click", () => {
        if (app) selectRecord(record);
        else makeSplitView(record);
      });
      const historyButton = frame.querySelector(".activity-light-buttons .btn-core-history");
      if (historyButton?.parentNode) {
        record.button.classList.add("cs128-sbs-button-in-row");
        historyButton.insertAdjacentElement("afterend", record.button);
      } else {
        workspace.parentNode.insertBefore(record.button, workspace.nextSibling);
      }
      records.push(record);
      updateButton(record);
    }
  }

  function scheduleInstall() {
    if (activationQueued) return;
    activationQueued = true;
    requestAnimationFrame(() => {
      activationQueued = false;
      installWorkspaceButtons();
    });
  }

  document.addEventListener("turbolinks:before-cache", () => exitSplitView(true));
  document.addEventListener("turbolinks:load", scheduleInstall);
  const sidePreferenceLoaded = new Promise((resolve) => {
    chrome.storage.local.get({ codeSide: "right" }, (settings) => {
      codeSide = settings.codeSide === "left" ? "left" : "right";
      updateButtons();
      resolve();
    });
  });
  scheduleInstall();
})();
