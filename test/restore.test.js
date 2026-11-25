"use strict";

// Run with: node --experimental-vm-modules test/restore.test.js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

function monitorManager(connectors) {
    return {
        get_monitor_for_connector: (connector) => connectors.indexOf(connector),
        get_logical_monitors: () =>
            connectors.map((connector, index) => ({
                get_number: () => index,
                get_monitors: () => [{ get_connector: () => connector }],
            })),
    };
}

const context = createContext({
    global: {
        backend: { get_monitor_manager: () => monitorManager(["eDP-1", "DP-1"]) },
        display: { get_n_monitors: () => 2 },
        workspace_manager: {
            n_workspaces: 3,
            get_workspace_by_index: () => ({ active: true }),
        },
    },
});
const shellModules = {
    "gi://Meta": { default: { WindowType: { NORMAL: 0, UTILITY: 1 } } },
    "gi://GLib": { default: { PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false } },
    "gi://Gio": { default: {} },
    "gi://GObject": { default: { registerClass: (klass) => klass } },
    "gi://Shell": { default: {} },
    "gi://St": { default: {} },
    "resource:///org/gnome/shell/extensions/extension.js": {
        Extension: class {},
        InjectionManager: class {},
        gettext: (value) => value,
    },
    "resource:///org/gnome/shell/ui/quickSettings.js": {
        QuickMenuToggle: class {},
        SystemIndicator: class {},
    },
    "resource:///org/gnome/shell/ui/main.js": { panel: { statusArea: { quickSettings: {} } } },
    "resource:///org/gnome/shell/ui/popupMenu.js": {},
};
const extensionModule = new SourceTextModule(
    await readFile(new URL("../SmartAutoMoveNG@lauinger-clan.de/extension.js", import.meta.url), "utf8"),
    { context }
);
await extensionModule.link(async (specifier) => {
    const exports = specifier === "./lib/common.js"
        ? await import("../SmartAutoMoveNG@lauinger-clan.de/lib/common.js")
        : shellModules[specifier];
    assert.ok(exports, `Unexpected runtime import: ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
});
await extensionModule.evaluate();

const savedWindow = {
    monitor: 1,
    workspace: 0,
    on_all_workspaces: true,
    x: 2100,
    y: 150,
    width: 800,
    height: 600,
    maximized: false,
    fullscreen: false,
    above: false,
};

class WaylandWindow {
    constructor({ maximized = false, fullscreen = false } = {}) {
        this.frame = { x: 100, y: 100, width: 1000, height: 700 };
        this.maximized_horizontally = maximized;
        this.maximized_vertically = maximized;
        this.fullscreen = fullscreen;
        this.monitor = 0;
        this.calls = [];
    }

    is_fullscreen() {
        return this.fullscreen;
    }

    unmake_fullscreen() {
        this.calls.push("unfullscreen");
        this.fullscreen = false;
        // Mutter 51 processes a config even when already non-fullscreen. On
        // Wayland, the current frame may still precede an uncommitted resize.
        this.pendingFrame = { ...this.frame };
    }

    unmaximize() {
        this.calls.push("unmaximize");
        this.maximized_horizontally = false;
        this.maximized_vertically = false;
        this.pendingFrame = { ...this.frame };
    }

    move_to_monitor(monitor) {
        this.calls.push("monitor");
        this.frame.x += (monitor - this.monitor) * 1920;
        this.monitor = monitor;
    }

    stick() {
        this.onAllWorkspaces = true;
    }

    unstick() {
        this.onAllWorkspaces = false;
    }

    change_workspace_by_index(workspace) {
        this.workspace = workspace;
    }

    move_resize_frame(_userOperation, x, y, width, height) {
        this.calls.push("geometry");
        if (this.fullscreen || this.maximized_horizontally || this.maximized_vertically) return;
        this.pendingFrame = { x, y, width, height };
    }

    maximize() {
        this.maximized_horizontally = true;
        this.maximized_vertically = true;
    }

    make_fullscreen() {
        this.calls.push("fullscreen");
        this.fullscreen = true;
    }

    make_above() {}

    unmake_above() {}

    commit() {
        if (this.pendingFrame) this.frame = this.pendingFrame;
    }
}

async function restoreGeometry(win, saved = savedWindow, options = {}, moveOptions = {}) {
    const extension = new extensionModule.namespace.default();
    let completeMove;
    Object.assign(extension, {
        _ignoreMonitor: false,
        _ignoreWorkspace: false,
        _ignorePosition: false,
        _moveWindowDelays: new Map(),
        _debug() {},
        _windowData: (window) => ({ ...window.frame }),
        _addTimeout(_priority, _duration, callback) {
            completeMove = callback;
            return 1;
        },
        ...options,
    });
    const move = extension._moveWindow(win, saved, moveOptions);
    win.commit();
    completeMove();
    return move;
}

function assertSavedGeometry(win) {
    assert.deepEqual(win.frame, {
        x: savedWindow.x,
        y: savedWindow.y,
        width: savedWindow.width,
        height: savedWindow.height,
    });
    assert.equal(win.monitor, 1);
    assert.equal(win.onAllWorkspaces, true);
}

test("restores a queued Wayland resize on a secondary monitor without resending the old geometry", async () => {
    const win = new WaylandWindow();
    await restoreGeometry(win);
    assertSavedGeometry(win);
    assert.ok(!win.calls.includes("unfullscreen"));
    assert.ok(!win.calls.includes("unmaximize"));
});

test("leaves fullscreen before restoring normal geometry", async () => {
    const win = new WaylandWindow({ fullscreen: true });
    await restoreGeometry(win);
    assertSavedGeometry(win);
    assert.equal(win.fullscreen, false);
    assert.equal(win.calls[0], "unfullscreen");
});

test("unmaximizes before restoring normal geometry", async () => {
    const win = new WaylandWindow({ maximized: true });
    await restoreGeometry(win);
    assertSavedGeometry(win);
    assert.equal(win.maximized_horizontally, false);
    assert.equal(win.maximized_vertically, false);
    assert.equal(win.calls[0], "unmaximize");
});

test("clears partial maximization before restoring normal geometry", async () => {
    const win = new WaylandWindow();
    win.maximized_vertically = true;
    await restoreGeometry(win);
    assertSavedGeometry(win);
    assert.equal(win.maximized_vertically, false);
});

test("restores saved maximized and fullscreen states", async () => {
    const maximized = new WaylandWindow();
    await restoreGeometry(maximized, { ...savedWindow, maximized: true });
    assert.equal(maximized.maximized_horizontally, true);
    assert.equal(maximized.maximized_vertically, true);

    const fullscreen = new WaylandWindow();
    await restoreGeometry(fullscreen, { ...savedWindow, fullscreen: true });
    assert.equal(fullscreen.fullscreen, true);
    assert.equal(fullscreen.calls.at(-1), "fullscreen");
});

test("does not reapply fullscreen when it is already set", async () => {
    const win = new WaylandWindow({ fullscreen: true });
    await restoreGeometry(win, { ...savedWindow, fullscreen: true });
    assert.ok(!win.calls.includes("fullscreen"));
    assert.ok(!win.calls.includes("unfullscreen"));
});

test("honors ignored position, monitor and workspace settings", async () => {
    const win = new WaylandWindow();
    const originalPosition = { x: win.frame.x, y: win.frame.y };
    await restoreGeometry(win, savedWindow, {
        _ignorePosition: true,
        _ignoreMonitor: true,
        _ignoreWorkspace: true,
    });
    assert.deepEqual(win.frame, { ...originalPosition, width: savedWindow.width, height: savedWindow.height });
    assert.equal(win.monitor, 0);
    assert.equal(win.onAllWorkspaces, undefined);
});


function ciderWindow(id, title, { skipTaskbar = false, type = 0 } = {}) {
    const handlers = new Map();
    return {
        title,
        data: { hash: id, title, occupied: true, x: 100, y: 100, width: 352, height: 152 },
        get_id: () => id,
        get_wm_class: () => "cider",
        get_title() { return this.title; },
        get_role: () => null,
        get_window_type: () => type,
        is_skip_taskbar: () => skipTaskbar,
        can_maximize: () => false,
        can_minimize: () => false,
        get_transient_for: () => null,
        is_above: () => false,
        is_on_all_workspaces: () => false,
        get_workspace: () => ({}),
        connect(signal, callback) { handlers.set(signal, callback); return signal; },
        disconnect(signal) { handlers.delete(signal); },
        emit(signal) { handlers.get(signal)?.(); },
        handlers,
    };
}

function ciderExtension(savedWindows = {}) {
    const extension = new extensionModule.namespace.default();
    Object.assign(extension, {
        _savedWindows: savedWindows,
        _monitorLayout: "DP-1,eDP-1",
        _savePausedUntil: 0,
        _windowRoles: new Map(),
        _nonPersistentWindows: new Map(),
        _activeRestores: new Map(),
        _restoreSaveGuards: new Map(),
        _reservedSavedWindows: new Map(),
        _provisionalPictureInPictureWindows: new Map(),
        _trackedWindows: new Map(),
        _overrides: {},
        _matchThreshold: 0.5,
        _syncMode: 1,
        _startupDelayMs: 0,
        _windowNewerThan: () => false,
        _debug() {},
        _queueSaveSettings() {},
        _trackWindow() {},
        _setRestoreSaveGuard() {},
        _windowData(win) {
            const data = { ...win.data, title: win.title };
            const role = this._windowRole(win);
            if (role !== null) data.window_role = role;
            return data;
        },
        async _moveWindow(win, saved) {
            win.restored = saved;
            return saved;
        },
    });
    return extension;
}

for (const miniFirst of [false, true]) {
    test(`saves Cider windows separately with miniplayer opening ${miniFirst ? "first" : "second"}`, async () => {
        const extension = ciderExtension();
        const main = ciderWindow(1, "Cider");
        const mini = ciderWindow(2, "Cider - Mini Player");
        await extension._syncWindow(miniFirst ? mini : main);
        await extension._syncWindow(miniFirst ? main : mini);
        assert.equal(extension._savedWindows.cider.length, 2);
        assert.equal(extension._matchingSavedWindow(main)[1].title, "Cider");
        assert.equal(extension._matchingSavedWindow(mini)[1].window_role, "picture-in-picture");
        assert.equal(extension._nonPersistentWindows.size, 0);
        // Further normal Cider windows still share the single normal slot.
        await extension._syncWindow(ciderWindow(3, "Cider"));
        assert.equal(extension._savedWindows.cider.length, 2);
    });
}

test("restores Cider miniplayer geometry without using or occupying the main window slot", async () => {
    const mainSaved = { ...savedWindow, title: "Cider", occupied: true, hash: 1 };
    const miniSaved = {
        ...savedWindow, title: "Cider - Mini Player", occupied: false,
        x: 500, y: 200, width: 352, height: 152, window_role: "picture-in-picture",
    };
    const extension = ciderExtension({ cider: [mainSaved, miniSaved] });
    const mini = ciderWindow(2, "Cider - Mini Player");
    await extension._syncWindow(mini);
    assert.equal(mini.restored, miniSaved);
    assert.equal(mainSaved.hash, 1);
    assert.equal(miniSaved.hash, 2);
    assert.equal(miniSaved.occupied, true);
    assert.equal(extension._nonPersistentWindows.size, 0);
    assert.equal(extension._activeRestores.size, 0);
    assert.equal(extension._reservedSavedWindows.size, 0);
});

test("retries a skipped Cider popup when its miniplayer title arrives and removes provisional signals", () => {
    const extension = ciderExtension();
    const mini = ciderWindow(2, "", { skipTaskbar: true, type: 1 });
    assert.equal(extension._shouldSkipWindow(mini), true);
    extension._trackProvisionalPictureInPictureWindow(mini);
    assert.equal(extension._provisionalPictureInPictureWindows.size, 1);
    let retried;
    extension._syncWindowWithErrorLogging = (win) => { retried = win; };
    mini.title = "Cider - Mini Player";
    mini.emit("notify::title");
    assert.equal(retried, mini);
    assert.equal(extension._shouldSkipWindow(mini), false);
    assert.equal(extension._provisionalPictureInPictureWindows.size, 0);
    assert.equal(mini.handlers.size, 0);
});

function appWindow(id, wmClass, title) {
    const win = ciderWindow(id, title);
    win.get_wm_class = () => wmClass;
    return win;
}

test("keeps windows that are already open when the extension is enabled again", async () => {
    const firstSaved = { ...savedWindow, title: "Project Board - Alpha", occupied: true, hash: 1, workspace: 0 };
    const extension = ciderExtension({ chrome: [firstSaved] });
    Object.assign(extension, {
        _adoptedWindows: new WeakSet(),
        _checkForPendingWindows: () => false,
    });
    const first = appWindow(1, "chrome", "Project Board - Alpha");
    const second = appWindow(2, "chrome", "Project Board - Beta");
    context.global.get_window_actors = () => [first, second].map((win) => ({ get_meta_window: () => win }));
    try {
        await extension._syncWindows();
        assert.equal(first.restored, undefined);
        assert.equal(second.restored, undefined);

        // A later title change re-syncs the window; it must still stay put.
        await extension._syncWindow(second);
        assert.equal(second.restored, undefined);
        assert.equal(extension._nonPersistentWindows.size, 0);
    } finally {
        delete context.global.get_window_actors;
    }
});

test("still restores additional windows opened after the extension is enabled", async () => {
    const firstSaved = { ...savedWindow, title: "Inbox", occupied: true, hash: 1 };
    const extension = ciderExtension({ chrome: [firstSaved] });
    extension._adoptedWindows = new WeakSet();
    const second = appWindow(2, "chrome", "Inbox");
    await extension._syncWindow(second);
    assert.equal(second.restored, firstSaved);
});

test("does not save window geometry while monitors are being reconfigured", () => {
    const saved = { ...savedWindow, title: "Project Board - Alpha", occupied: true, hash: 1, x: 2100 };
    const extension = ciderExtension({ chrome: [saved] });
    const win = appWindow(1, "chrome", "Project Board - Alpha");
    win.data = { ...saved, x: 100 };

    extension._savePausedUntil = Date.now() + 60000;
    extension._ensureSavedWindow(win);
    assert.equal(extension._savedWindows.chrome[0].x, 2100);

    extension._savePausedUntil = 0;
    extension._ensureSavedWindow(win);
    assert.equal(extension._savedWindows.chrome[0].x, 100);
});

test("pauses saving when a window sees the monitors change before monitors-changed", () => {
    const saved = { ...savedWindow, title: "Project Board - Alpha", occupied: true, hash: 1, x: 2100 };
    const extension = ciderExtension({ chrome: [saved] });
    const win = appWindow(1, "chrome", "Project Board - Alpha");
    // Mutter has already moved the window off the unplugged monitor
    win.data = { ...saved, x: 100 };
    let relayoutScheduled = false;
    extension._scheduleRelayout = () => {
        relayoutScheduled = true;
    };
    withMonitors(["eDP-1"], 0, () => extension._ensureSavedWindow(win));
    assert.equal(extension._savedWindows.chrome[0].x, 2100);
    assert.ok(extension._savePausedUntil > Date.now());
    assert.ok(relayoutScheduled);
});

function withMonitors(connectors, primary, body) {
    const backend = context.global.backend;
    context.global.backend = { get_monitor_manager: () => monitorManager(connectors) };
    const display = context.global.display;
    context.global.display = {
        get_n_monitors: () => connectors.length,
        get_primary_monitor: () => primary,
    };
    context.global.workspace_manager.get_active_workspace = () => ({
        get_work_area_for_monitor: () => ({ x: 0, y: 32, width: 1280, height: 768 }),
    });
    try {
        return body();
    } finally {
        context.global.backend = backend;
        context.global.display = display;
        delete context.global.workspace_manager.get_active_workspace;
    }
}

function restoreTarget(saved, options = {}) {
    const extension = new extensionModule.namespace.default();
    Object.assign(extension, { _ignoreMonitor: false, ...options });
    return extension._restoreTarget(saved);
}

test("restores onto the saved monitor's connector even when monitor indices changed", () => {
    withMonitors(["DP-1", "eDP-1"], 1, () => {
        const target = restoreTarget({ ...savedWindow, monitor: 1, monitor_connector: "DP-1" });
        assert.equal(target.monitor, 0);
        assert.equal(target.x, savedWindow.x);
    });
});

test("keeps the relative place on the primary monitor when the saved monitor is gone", () => {
    withMonitors(["eDP-1"], 0, () => {
        const saved = {
            ...savedWindow,
            monitor: 1,
            monitor_connector: "DP-1",
            x: 1920 + 960,
            y: 540,
            width: 2400,
            height: 600,
            monitor_work_area: { x: 1920, y: 0, width: 1920, height: 1080 },
        };
        const target = restoreTarget(saved);
        assert.equal(target.monitor, 0);
        // shrunk to the work area, then kept inside it
        assert.deepEqual([target.x, target.y, target.width, target.height], [0, 200, 1280, 600]);
    });
});

test("falls back to the saved index for records without a connector", () => {
    withMonitors(["eDP-1", "DP-1"], 0, () => {
        assert.equal(restoreTarget({ ...savedWindow, monitor: 1 }).monitor, 1);
        assert.equal(restoreTarget({ ...savedWindow, monitor: 2, x: 5000 }).x, 1280 - savedWindow.width);
    });
});

test("leaves the saved monitor untouched when the monitor is ignored", () => {
    withMonitors(["eDP-1"], 0, () => {
        const saved = { ...savedWindow, monitor: 1, monitor_connector: "DP-1" };
        assert.equal(restoreTarget(saved, { _ignoreMonitor: true }), saved);
    });
});

test("does not stick windows that were only on all workspaces because of their monitor", async () => {
    const win = new WaylandWindow();
    await restoreGeometry(win, { ...savedWindow, workspace: 2, on_all_workspaces_by_monitor: true });
    assert.equal(win.onAllWorkspaces, false);
    assert.equal(win.workspace, 2);
});

test("restores the geometry saved for the current monitor layout", () => {
    const saved = {
        ...savedWindow,
        monitor: 0,
        x: 100,
        layouts: {
            "DP-1,eDP-1": { x: 2500, y: 100, width: 800, height: 600, monitor: 1, monitor_connector: "DP-1" },
            "eDP-1": { x: 40, y: 60, width: 700, height: 500, monitor: 0, monitor_connector: "eDP-1" },
        },
    };
    withMonitors(["eDP-1", "DP-1"], 0, () => {
        const target = restoreTarget(saved);
        assert.deepEqual([target.monitor, target.x, target.width], [1, 2500, 800]);
    });
    withMonitors(["eDP-1"], 0, () => {
        const target = restoreTarget(saved);
        assert.deepEqual([target.monitor, target.x, target.width], [0, 40, 700]);
    });
});

test("keeps the geometry of other monitor layouts when saving", () => {
    const docked = { x: 2500, y: 100, width: 800, height: 600, monitor: 1 };
    const saved = { ...savedWindow, title: "Project Board - Alpha", occupied: true, hash: 1, layouts: { "DP-1,eDP-1": docked } };
    const extension = ciderExtension({ chrome: [saved] });
    const win = appWindow(1, "chrome", "Project Board - Alpha");
    win.data = { ...saved, x: 40, monitor: 0, layouts: { "eDP-1": { x: 40, y: 150, width: 800, height: 600, monitor: 0 } } };
    extension._ensureSavedWindow(win);
    const layouts = extension._savedWindows.chrome[0].layouts;
    assert.deepEqual(Object.keys(layouts).sort(), ["DP-1,eDP-1", "eDP-1"]);
    assert.equal(layouts["DP-1,eDP-1"], docked);
});

function relayoutExtension(savedWindows, windows) {
    const extension = ciderExtension(savedWindows);
    extension._trackedWindows = new Map(windows.map((win) => [win, {}]));
    extension._moveWindow = async (win, target, options) => {
        win.relaidOut = { target, options };
        return target;
    };
    return extension;
}

const dockedLayouts = {
    "DP-1,eDP-1": { x: 2500, y: 100, width: 800, height: 600, maximized: false, fullscreen: false, monitor: 1, monitor_connector: "DP-1" },
    "eDP-1": { x: 40, y: 60, width: 700, height: 500, maximized: false, fullscreen: false, monitor: 0, monitor_connector: "eDP-1" },
};

test("re-places windows only when other monitors are connected", () => {
    const extension = ciderExtension();
    let scheduled = 0;
    Object.assign(extension, {
        _relayoutTimeoutId: null,
        _scheduleRelayout() {
            scheduled++;
        },
    });
    extension._checkMonitorLayout(true);
    assert.equal(scheduled, 0);
    assert.ok(extension._savePausedUntil > Date.now());
    withMonitors(["eDP-1"], 0, () => extension._checkMonitorLayout(true));
    assert.equal(scheduled, 1);
});

test("puts open windows back where they were saved when monitors come back", async () => {
    const saved = { ...savedWindow, title: "Project Board - Alpha", occupied: true, hash: 1, layouts: dockedLayouts };
    const win = appWindow(1, "chrome", "Project Board - Alpha");
    // where Mutter left it while the external monitor was gone
    win.data = { ...saved, ...dockedLayouts["eDP-1"] };
    const extension = relayoutExtension({ chrome: [saved] }, [win]);
    await withMonitors(["eDP-1", "DP-1"], 0, () => extension._relayoutWindows());
    assert.deepEqual([win.relaidOut.target.monitor, win.relaidOut.target.x], [1, 2500]);
    assert.equal(win.relaidOut.options.keepWorkspace, true);
    assert.equal(extension._activeRestores.size, 0);
});

test("leaves open windows alone when nothing was saved for the new monitors", async () => {
    const onlyDocked = { "DP-1,eDP-1": dockedLayouts["DP-1,eDP-1"] };
    const saved = { ...savedWindow, title: "Project Board - Alpha", occupied: true, hash: 1, layouts: onlyDocked };
    const win = appWindow(1, "chrome", "Project Board - Alpha");
    win.data = { ...saved, ...dockedLayouts["eDP-1"] };
    const extension = relayoutExtension({ chrome: [saved] }, [win]);
    await withMonitors(["eDP-1"], 0, () => extension._relayoutWindows());
    assert.equal(win.relaidOut, undefined);
});

test("does not re-place windows already in place, saved for another window, or set to ignore", async () => {
    const inPlace = appWindow(1, "chrome", "In place");
    const unbound = appWindow(2, "chrome", "Unbound");
    const ignored = appWindow(3, "chrome", "Ignored");
    const saved = [
        { ...savedWindow, title: "In place", occupied: true, hash: 1, layouts: dockedLayouts },
        { ...savedWindow, title: "Unbound", occupied: false, hash: 2, layouts: dockedLayouts },
        { ...savedWindow, title: "Ignored", occupied: true, hash: 3, layouts: dockedLayouts },
    ];
    inPlace.data = { ...saved[0], ...dockedLayouts["DP-1,eDP-1"], monitor: 1 };
    unbound.data = { ...saved[1], ...dockedLayouts["eDP-1"] };
    ignored.data = { ...saved[2], ...dockedLayouts["eDP-1"] };
    const extension = relayoutExtension({ chrome: saved }, [inPlace, unbound, ignored]);
    extension._overrides = { chrome: [{ query: { title: "Ignored" }, action: 0 }] };
    await withMonitors(["eDP-1", "DP-1"], 0, () => extension._relayoutWindows());
    assert.deepEqual([inPlace.relaidOut, unbound.relaidOut, ignored.relaidOut], [undefined, undefined, undefined]);
});

test("keeps the current workspace when only the geometry is restored", async () => {
    const win = new WaylandWindow();
    win.workspace = 2;
    await restoreGeometry(win, { ...savedWindow, workspace: 0, on_all_workspaces: false }, {}, { keepWorkspace: true });
    assert.equal(win.workspace, 2);
    assert.equal(win.monitor, 1);
});

function multiWindowExtension(savedWindows = {}, options = {}) {
    const extension = ciderExtension(savedWindows);
    Object.assign(extension, {
        _multiWindow: true,
        _openWindows: [],
        _appWindows(wsh) {
            return this._openWindows.filter((win) => win.get_wm_class() === wsh);
        },
        async _settleAppWindows() {},
        ...options,
    });
    return extension;
}

test("gives every window of an app its own slot in multi-window mode", async () => {
    const extension = multiWindowExtension();
    const alpha = appWindow(1, "chrome", "Project Board - Alpha");
    const beta = appWindow(2, "chrome", "Project Board - Beta");
    beta.data = { ...beta.data, workspace: 1 };
    extension._openWindows = [alpha, beta];
    await extension._syncWindow(alpha);
    await extension._syncWindow(beta);
    assert.equal(beta.restored, undefined);
    assert.deepEqual(
        [...extension._savedWindows.chrome].map((sw) => [sw.hash, sw.title]),
        [[1, "Project Board - Alpha"], [2, "Project Board - Beta"]]
    );
    assert.equal(extension._nonPersistentWindows.size, 0);
});

test("restores each window of an app from its own slot in multi-window mode", async () => {
    const alphaSaved = { ...savedWindow, title: "Project Board - Alpha", occupied: false, hash: 11, workspace: 0 };
    const betaSaved = { ...savedWindow, title: "Project Board - Beta", occupied: false, hash: 12, workspace: 1 };
    const extension = multiWindowExtension({ chrome: [alphaSaved, betaSaved] });
    const beta = appWindow(2, "chrome", "Project Board - Beta");
    extension._openWindows = [beta];
    await extension._syncWindow(beta);
    assert.equal(beta.restored, betaSaved);
    assert.equal(betaSaved.occupied, true);
    assert.equal(alphaSaved.occupied, false);
});

test("drops the least recently seen unoccupied slot beyond the per-app limit", async () => {
    const slots = Array.from({ length: 10 }, (_, i) => ({
        ...savedWindow, title: `Old ${i}`, occupied: i === 0, hash: 100 + i, last_seen: 1000 + i,
    }));
    // a strict threshold so the new window does not take over one of the old slots
    const extension = multiWindowExtension({ chrome: slots }, { _matchThreshold: 0.95 });
    const win = appWindow(1, "chrome", "Something else entirely");
    extension._openWindows = [win];
    await extension._syncWindow(win);
    const titles = extension._savedWindows.chrome.map((sw) => sw.title);
    assert.equal(titles.length, 10);
    assert.ok(titles.includes("Old 0"), "occupied slot is kept although it is the oldest");
    assert.ok(!titles.includes("Old 1"));
    assert.ok(titles.includes("Something else entirely"));
});

test("an override can turn multi-window mode off for one app", async () => {
    const extension = multiWindowExtension({}, { _overrides: { chrome: [{ multi_window: false }] } });
    await extension._syncWindow(appWindow(1, "chrome", "Project Board - Alpha"));
    await extension._syncWindow(appWindow(2, "chrome", "Project Board - Beta"));
    assert.equal(extension._savedWindows.chrome.length, 1);
});

test("assigns reopened windows to slots by size when their titles are alike", async () => {
    const wide = { ...savedWindow, title: "New Tab", occupied: false, hash: 11, width: 1600, height: 900, workspace: 0 };
    const narrow = { ...savedWindow, title: "New Tab", occupied: false, hash: 12, width: 700, height: 900, workspace: 1 };
    const extension = multiWindowExtension({ chrome: [wide, narrow] });
    const first = appWindow(1, "chrome", "New Tab");
    first.data = { ...first.data, width: 700, height: 900 };
    const second = appWindow(2, "chrome", "New Tab");
    second.data = { ...second.data, width: 1600, height: 900 };
    extension._openWindows = [first, second];
    await extension._syncWindow(first);
    await extension._syncWindow(second);
    assert.equal(first.restored, narrow);
    assert.equal(second.restored, wide);
});

test("leaves a reopened window in place when no slot is similar enough", async () => {
    const saved = { ...savedWindow, title: "Mail", occupied: false, hash: 11, width: 1600, height: 900 };
    const extension = multiWindowExtension({ chrome: [saved] }, { _matchThreshold: 0.7 });
    const win = appWindow(1, "chrome", "Spreadsheet");
    win.data = { ...win.data, width: 500, height: 400 };
    extension._openWindows = [win];
    await extension._syncWindow(win);
    assert.equal(win.restored, undefined);
    assert.equal(extension._savedWindows.chrome.length, 2);
});
