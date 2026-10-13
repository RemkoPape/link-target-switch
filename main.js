/*
 * Link Target Switch
 * Choose per click whether a web link opens in Obsidian's Web viewer or in your system browser.
 * MIT License, (c) 2026 Remko Pape
 */
const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView } = require("obsidian");
const { EditorView } = require("@codemirror/view");

const DEFAULT_SETTINGS = { defaultTarget: "webviewer", modifier: "alt", showStatusBar: true };
const TARGET_LABEL = { webviewer: "Web viewer", browser: "Browser" };
const MODIFIER_LABEL = { alt: "Alt / Option", shift: "Shift" };

const isWebUrl = (u) => /^https?:\/\//i.test(u || "");
const other = (t) => (t === "webviewer" ? "browser" : "webviewer");

/** Return the URL in a line of markdown that covers character offset `off`. */
function findUrlAt(text, off) {
  const patterns = [
    /\[[^\]]*\]\((https?:\/\/[^\s)]+)[^)]*\)/g, // [text](url)
    /<(https?:\/\/[^>\s]+)>/g,                  // <url>
    /(https?:\/\/[^\s<>()\[\]"']+)/g,          // bare url
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      if (off >= m.index && off <= m.index + m[0].length) {
        return m[1].replace(/[.,;:!?]+$/, "");
      }
    }
  }
  return null;
}

module.exports = class LinkTargetSwitchPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.setAttr("aria-label", "Default link target (click to switch)");
    this.statusEl.addEventListener("click", () => this.toggleDefault());
    this.updateStatusBar();

    this.addCommand({
      id: "toggle-default-target",
      name: "Toggle default link target (Web viewer / browser)",
      callback: () => this.toggleDefault(),
    });

    this.addCommand({
      id: "open-link-under-cursor-in-browser",
      name: "Open link under cursor in browser",
      editorCheckCallback: (checking, editor) => {
        const url = this.urlAtCursor(editor);
        if (checking) return !!url;
        if (url) this.open(url, "browser");
      },
    });

    this.addCommand({
      id: "open-link-under-cursor-in-web-viewer",
      name: "Open link under cursor in Web viewer",
      editorCheckCallback: (checking, editor) => {
        const url = this.urlAtCursor(editor);
        if (checking) return !!url;
        if (url) this.open(url, "webviewer");
      },
    });

    this.addCommand({
      id: "open-current-web-viewer-page-in-browser",
      name: "Open current Web viewer page in browser",
      checkCallback: (checking) => {
        const url = this.currentWebViewerUrl();
        if (checking) return !!url;
        if (url) this.open(url, "browser");
      },
    });

    this.addSettingTab(new LinkTargetSwitchSettingTab(this.app, this));

    // Capture phase, so this runs before Obsidian's own link handling.
    this.registerDomEvent(document, "click", (evt) => this.onClick(evt), { capture: true });
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.updateStatusBar();
  }

  async toggleDefault() {
    this.settings.defaultTarget = other(this.settings.defaultTarget);
    await this.saveSettings();
    new Notice(`Web links now open in: ${TARGET_LABEL[this.settings.defaultTarget]}`);
  }

  updateStatusBar() {
    if (!this.statusEl) return;
    this.statusEl.toggle(this.settings.showStatusBar);
    this.statusEl.setText(`🔗 ${TARGET_LABEL[this.settings.defaultTarget]}`);
  }

  onClick(evt) {
    // Leave right/middle clicks and Ctrl/Cmd+click to Obsidian.
    if (evt.button !== 0 || evt.ctrlKey || evt.metaKey) return;
    const url = this.urlFromClick(evt);
    if (!url) return;

    const modifierDown = this.settings.modifier === "shift" ? evt.shiftKey : evt.altKey;
    const target = modifierDown ? other(this.settings.defaultTarget) : this.settings.defaultTarget;

    evt.preventDefault();
    evt.stopImmediatePropagation();
    this.open(url, target);
  }

  urlFromClick(evt) {
    const el = evt.target;
    if (!(el instanceof HTMLElement)) return null;
    // Only links inside notes, canvases and hover previews; never the settings window.
    if (!el.closest(".workspace-leaf-content, .hover-popover")) return null;

    // Reading view, rendered links in Live Preview, canvas cards, hover previews.
    const a = el.closest("a");
    if (a) {
      const href = a.getAttribute("href") || a.getAttribute("data-href");
      return isWebUrl(href) ? href : null;
    }

    // Live Preview / Source mode: links are spans, so read the URL from the line text.
    if (!el.closest(".cm-link, .cm-url, .cm-hmd-barelink, .cm-underline")) return null;
    const contentEl = el.closest(".cm-content");
    const view = contentEl && EditorView.findFromDOM(contentEl);
    if (!view) return null;

    const pos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
    if (pos == null) return null;
    const line = view.state.doc.lineAt(pos);
    return findUrlAt(line.text, pos - line.from);
  }

  urlAtCursor(editor) {
    const cur = editor.getCursor();
    return findUrlAt(editor.getLine(cur.line), cur.ch);
  }

  currentWebViewerUrl() {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf || leaf.view.getViewType() !== "webviewer") return null;
    const url = leaf.view.getState().url;
    return isWebUrl(url) ? url : null;
  }

  async open(url, target) {
    if (target === "browser") {
      require("electron").shell.openExternal(url);
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "webviewer", active: true, state: { url, navigate: true } });

    // Web viewer core plugin disabled: the view type does not exist, so fall back to the browser.
    if (leaf.view.getViewType() !== "webviewer") {
      leaf.detach();
      new Notice("The Web viewer core plugin is off, so the link opened in your browser.");
      require("electron").shell.openExternal(url);
      return;
    }
    await this.app.workspace.revealLeaf(leaf);
  }
};

class LinkTargetSwitchSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default target")
      .setDesc("Where a plain click on a web link opens.")
      .addDropdown((d) =>
        d.addOptions(TARGET_LABEL)
          .setValue(this.plugin.settings.defaultTarget)
          .onChange(async (v) => {
            this.plugin.settings.defaultTarget = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Switch key")
      .setDesc("Hold this key while clicking to open the link in the other target.")
      .addDropdown((d) =>
        d.addOptions(MODIFIER_LABEL)
          .setValue(this.plugin.settings.modifier)
          .onChange(async (v) => {
            this.plugin.settings.modifier = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show in status bar")
      .setDesc("Show the current default in the status bar. Click it to switch.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showStatusBar).onChange(async (v) => {
          this.plugin.settings.showStatusBar = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
