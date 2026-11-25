# gnome-shell-extension-SmartAutoMoveNG

Forked from https://github.com/khimaros/smart-auto-move

<div align="center">

![Gnome Extensions Downloads](https://img.shields.io/gnome-extensions/dt/SmartAutoMoveNG@lauinger-clan.de) ![GNOME Shell](https://img.shields.io/badge/GNOME-45%20--%2051-blue?logo=gnome&logoColor=white) ![GitHub License](https://img.shields.io/github/license/ChrisLauinger77/gnome-shell-extension-SmartAutoMoveNg)

</div>

SmartAutoMoveNG
is a Gnome Shell extension which keeps track of all application windows and restores them to the previous position, size, and workspace on restart. Supports Wayland.
Dynamic workspaces are supported for GNOME 48 and later.

<p align="left">
  <a href="https://extensions.gnome.org/extension/8149/smart-auto-move-ng/">
    <img alt="Get it on GNOME Extensions" width="228" src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extensions-badge/master/get-it-on-ego.svg?sanitize=true"/>
  </a>
</p>

# Contributing

Pull requests are welcome.

To update the translation files run
`./smartautomoveng.sh translate` in the extensions directory after your code changes are finished. This will update the files in po folder.
Then [Poedit](https://poedit.net/download) can be used to translate the strings. poedit can also be used to create new localization files.

## Screenshots

#### Quick Settings

![screenshot: quick settings](docs/screenshot-quicksettings.png)

The toggle in Quick Settings is connected to the "Freeze saves" switch of settings. (Configurable in GNOME 48 and later)

#### General

![screenshot: general preferences](docs/screenshot-general.png)

#### Saved Windows

![screenshot: saved windows preferences](docs/screenshot-saved-windows.png)

#### Overrides

![screenshot: overrides preferences](docs/screenshot-overrides.png)

## Getting started

Most settings can be modified via the extension preferences dialog.

## Overtake settings from [smart-auto-move](https://github.com/khimaros/smart-auto-move) (the one this was forked from - only supported until GNOME 48)

- dump the settings from "smart-auto-move" to a file:

`$ dconf dump /org/gnome/shell/extensions/smart-auto-move/ > smart-auto-move.dconf`

- load the dumped settings into "SmartAutoMoveNG":

`$ dconf load /org/gnome/shell/extensions/SmartAutoMoveNG/ < smart-auto-move.dconf`

### Defaults

The first step is to choose your **Default Synchronization Mode**: `IGNORE` or `RESTORE`. `IGNORE` will keep track of windows but will not restore any unless an **Override** with `RESTORE` behavior is created. `RESTORE` will keep track and restore all windows unless an **Override** with `IGNORE` behavior is created.

Next is to choose your global **Match Threshold**, the default works well for most use cases. a number closer to `0.0` will match windows with less similar attributes, whereas `1.0` requires an exact match.

Advanced users can also adjust the **Startup Delay** (how long a new window is observed before it is saved) and the **Stale Window Threshold** (days without seeing a saved window before **Cleanup Stale Windows** removes it).

Enable **Multiple Windows per App** to save every window of an application separately, e.g. several browser or PWA windows kept on different workspaces. Without it, one window per application is saved.

After you've dialed in your overrides, the learning apparatus can be paused. enable **Freeze Saves** to prevent changes to Saved Windows. N.B. this lose track of windows if their titles change.

### Overrides

To create an override, visit the **Saved Windows** tab.

To create an override for a specific window, click **OVERRIDE**.

To create an override for an entire application, click **OVERRIDE (ANY)**.

After you've created an override, visit the **Overrides** tab.

You can change the IGNORE/RESTORE behavior here for apps and windows.

For applications, a custom **Match Threshold** can be set.

**Multiple Windows per App** can be turned on or off for a single application by adding `"multi_window": true` or `false` to its override (see [Settings](#settings)).

## Limitations

LIMITATION: Terminals which include the current directory in the title may not reach the match threshold if they do not preserve the working directory across restarts. WORKAROUND: create a per-app override (see above) and set the threshold to a lower value, eg. `0.2`

LIMITATION: With **Multiple Windows per App**, windows of one application that reopen with the same title, size and maximized state cannot be told apart, so they may swap places. Windows that do not match any saved window well enough are left where they open.

## Troubleshooting

If everything is horribly broken, clear your Saved Windows:

```
$ gnome-extensions disable SmartAutoMoveNG@lauinger-clan.de

$ dconf write /org/gnome/shell/extensions/SmartAutoMoveNG/saved-windows '{}'

$ gnome-extensions enable SmartAutoMoveNG@lauinger-clan.de
```

## Behavior

SmartAutoMoveNG saves one normal window slot per application identity (`WM_CLASS`). Additional matching windows restore from that slot without overwriting it. Browser picture-in-picture windows and the Cider miniplayer each have a separate slot from their application’s normal window.

With **Multiple Windows per App**, every window gets a slot of its own (at most ten per application; the unused slot seen least recently is dropped first). When an application opens several windows in a burst, e.g. a browser restoring its session, SmartAutoMoveNG waits until the burst is over and then pairs the windows with the saved slots as a group, by title similarity, the size the window reopened with and its maximized state. A tag that an application sets on its window (Wayland `xdg-toplevel-tag`) identifies it on its own.

Windows that are already open when the extension is enabled are left where they are. GNOME disables extensions while the screen is locked, so this keeps windows in place across lock and unlock.

Monitors are identified by their connector (e.g. `DP-1`), so a window returns to the same monitor after it was unplugged and plugged back. Geometry is remembered separately for each set of connected monitors, e.g. docked and undocked. A few seconds after the monitors change, windows that are already open go back to the geometry saved for the new set of monitors, if they were saved with it before; their workspace is left as it is. If the saved monitor is missing, the window goes to the same relative place on the primary monitor, shrunk to fit. Windows shown on all workspaces only because they were on a secondary monitor (with workspaces on the primary monitor only) return to the workspace that was active when they were saved. Moves made by GNOME in the first seconds after monitors change are not saved.

Renaming an autostart `.desktop` file does not give its windows a separate identity if the application still reports the same `WM_CLASS`.

Titles are matched using Levenstein distance. The match bonus for title is calculated based on `(title length - distance) / title length`.

## Settings

Most settings can be modified from the preferences GUI. This section documents all of the dconf values and is only recommended for advanced users.

Enable debug logging:

```
$ dconf write /org/gnome/shell/extensions/SmartAutoMoveNG/debug-logging true
```

Set the minimum window/title match threshold to 50%:

```
$ dconf write /org/gnome/shell/extensions/SmartAutoMoveNG/match-threshold 0.5
```

Save every window of an application separately, except for Nautilus:

```
$ dconf write /org/gnome/shell/extensions/SmartAutoMoveNG/multi-window true
$ dconf write /org/gnome/shell/extensions/SmartAutoMoveNG/overrides '{"org.gnome.Nautilus": [{"multi_window": false}]}'
```

Default to ignoring windows unless explicitly defined. Restore all windows of the gnome-calculator app, all firefox windows except for the profile chooser, and Nautilus only if the window title is "Downloads":
/

```
$ dconf write /org/gnome/shell/extensions/SmartAutoMoveNG/sync-mode "'IGNORE'"
$ dconf write /org/gnome/shell/extensions/SmartAutoMoveNG/overrides '{"gnome-calculator": [{"action":1}], "firefox": [{"query": {"title": "Firefox - Choose User Profile"}, "action": 0}, {"action": 1}],"org.gnome.Nautilus":[{"query":{"title":"Downloads"},"action":1}]}'
```

Default to restoring all windows, but ignore the firefox profile chooser and any nautilus windows:

```
$ dconf write /org/gnome/shell/extensions/SmartAutoMoveNG/sync-mode "'RESTORE'"
$ dconf write /org/gnome/shell/extensions/SmartAutoMoveNG/overrides '{"firefox": [{"query": {"title": "Firefox - Choose User Profile"}, "action": 0}], "org.gnome.Nautilus": [{"action":0}]}'
```

Show all saved firefox windows (N.B. `jq` will fail if window title contains `\`):

```
$ dconf read /org/gnome/shell/extensions/SmartAutoMoveNG/saved-windows | sed "s/^'//; s/'$//" | jq -C .firefox | less -SR
```

There are example configs in the `examples/` dir which can be loaded (N.B. while extension is disabled) with:

```
$ dconf load /org/gnome/shell/extensions/SmartAutoMoveNG/ < ./examples/default-restore.dconf
```

## Backup & Restore

### Backup

You can backup your config:

```
$ dconf dump /org/gnome/shell/extensions/SmartAutoMoveNG/ > SmartAutoMoveNG.dconf
```

### Restore

To restore the config from backup:

```
$ dconf load /org/gnome/shell/extensions/SmartAutoMoveNG/ < SmartAutoMoveNG.dconf
```
